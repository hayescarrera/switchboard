/**
 * OAuth 2.1 authorization server for MCP connectors (Claude, ChatGPT, Cursor…).
 * The MCP SDK's router handles the HTTP endpoints, PKCE checks and dynamic client
 * registration; this provider stores everything in Postgres (hashed secrets) and
 * sends the human to our own consent page to sign in with a passkey.
 */
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Clock } from "../clock.js";
import { newSecret, sha256 } from "../crypto.js";
import type { Db } from "../db/pool.js";

export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_DAYS = 30;
const CODE_SECONDS = 300;
const REQUEST_MINUTES = 15;
export const SUPPORTED_SCOPES = ["rooms"];

export interface PendingRequest {
  id: string;
  client: OAuthClientInformationFull;
  params: { state?: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource?: string };
}

export class OAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly opts: { db: Db; clock: Clock; baseUrl: string; mcpUrl: string },
  ) {}

  private now() {
    return this.opts.clock();
  }
  private get db() {
    return this.opts.db;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const { rows } = await this.db.query<{ info: OAuthClientInformationFull }>(
          `SELECT info FROM oauth_clients WHERE client_id = $1`,
          [clientId],
        );
        return rows[0]?.info;
      },
      registerClient: async (client) => {
        const info = client as OAuthClientInformationFull;
        await this.db.query(`INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)`, [info.client_id, JSON.stringify(info)]);
        return info;
      },
    };
  }

  /** Park the request and send the human to our consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO oauth_requests (client_id, params, expires_at) VALUES ($1, $2, $3) RETURNING id`,
      [
        client.client_id,
        JSON.stringify({
          state: params.state,
          scopes: params.scopes ?? [],
          codeChallenge: params.codeChallenge,
          redirectUri: params.redirectUri,
          resource: params.resource?.href,
        }),
        new Date(this.now().getTime() + REQUEST_MINUTES * 60_000),
      ],
    );
    res.redirect(302, `${this.opts.baseUrl}/connect/${rows[0]!.id}`);
  }

  async pendingRequest(id: string): Promise<PendingRequest | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.db.query<{ id: string; params: PendingRequest["params"]; info: OAuthClientInformationFull }>(
      `SELECT r.id, r.params, c.info FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
        WHERE r.id = $1 AND r.decided_at IS NULL AND r.expires_at > $2`,
      [id, this.now()],
    );
    const r = rows[0];
    return r ? { id: r.id, client: r.info, params: r.params } : null;
  }

  /**
   * The signed-in human allowed (or denied) the connection. Returns where to send
   * the browser: back to the client with a code, or with access_denied.
   */
  async decide(
    requestId: string,
    decision:
      | { allow: true; userId: string; label: string; reuseConnectionId?: string }
      | { allow: false },
  ): Promise<string | null> {
    const req = await this.pendingRequest(requestId);
    if (!req) return null;
    const claimed = await this.db.query(`UPDATE oauth_requests SET decided_at = $2 WHERE id = $1 AND decided_at IS NULL`, [
      req.id,
      this.now(),
    ]);
    if (!claimed.rowCount) return null;
    const target = new URL(req.params.redirectUri);
    if (req.params.state !== undefined) target.searchParams.set("state", req.params.state);
    if (!decision.allow) {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "The person declined to connect this agent.");
      return target.href;
    }

    let connectionId: string | undefined;
    if (decision.reuseConnectionId) {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE agent_connections SET client_id = $3, label = COALESCE(NULLIF($4, ''), label)
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [decision.reuseConnectionId, decision.userId, req.client.client_id, decision.label.trim().slice(0, 60)],
      );
      connectionId = rows[0]?.id;
    }
    if (!connectionId) {
      const label = decision.label.trim().slice(0, 60) || req.client.client_name || "AI agent";
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO agent_connections (user_id, client_id, label, vendor) VALUES ($1,$2,$3,$4) RETURNING id`,
        [decision.userId, req.client.client_id, label, (req.client.client_name ?? "unknown").slice(0, 80)],
      );
      connectionId = rows[0]!.id;
    }

    const code = newSecret();
    await this.db.query(
      `INSERT INTO oauth_codes (code_hash, client_id, connection_id, code_challenge, redirect_uri, resource, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        sha256(code),
        req.client.client_id,
        connectionId,
        req.params.codeChallenge,
        req.params.redirectUri,
        req.params.resource ?? this.opts.mcpUrl,
        req.params.scopes.length ? req.params.scopes : SUPPORTED_SCOPES,
        new Date(this.now().getTime() + CODE_SECONDS * 1000),
      ],
    );
    target.searchParams.set("code", code);
    return target.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await this.db.query<{ code_challenge: string }>(
      `SELECT code_challenge FROM oauth_codes WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > $3`,
      [sha256(code), client.client_id, this.now()],
    );
    if (!rows[0]) throw new InvalidGrantError("Invalid or expired authorization code");
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const { rows } = await this.db.query<{
      connection_id: string;
      redirect_uri: string;
      resource: string | null;
      scopes: string[];
    }>(
      `UPDATE oauth_codes SET used_at = $3
        WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > $3
        RETURNING connection_id, redirect_uri, resource, scopes`,
      [sha256(code), client.client_id, this.now()],
    );
    const c = rows[0];
    if (!c) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && c.resource && !sameResource(resource.href, c.resource)) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }
    return this.issue(client.client_id, c.connection_id, c.scopes, c.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Rotate: the old refresh token stops working once used.
    const { rows } = await this.db.query<{ connection_id: string; scopes: string[]; resource: string | null }>(
      `UPDATE oauth_tokens t SET revoked_at = $3
         FROM agent_connections c
        WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.client_id = $2 AND t.revoked_at IS NULL
          AND t.expires_at > $3 AND c.id = t.connection_id AND c.revoked_at IS NULL
        RETURNING t.connection_id, t.scopes, t.resource`,
      [sha256(refreshToken), client.client_id, this.now()],
    );
    const t = rows[0];
    if (!t) throw new InvalidGrantError("Invalid or expired refresh token");
    if (scopes?.some((s) => !t.scopes.includes(s))) throw new InvalidGrantError("Cannot widen scopes on refresh");
    if (resource && t.resource && !sameResource(resource.href, t.resource)) throw new InvalidGrantError("resource does not match");
    return this.issue(client.client_id, t.connection_id, scopes?.length ? scopes : t.scopes, t.resource);
  }

  private async issue(clientId: string, connectionId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
    const access = newSecret();
    const refresh = newSecret();
    const now = this.now().getTime();
    await this.db.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, connection_id, scopes, resource, expires_at)
       VALUES ($1,'access',$3,$4,$5,$6,$7), ($2,'refresh',$3,$4,$5,$6,$8)`,
      [
        sha256(access),
        sha256(refresh),
        clientId,
        connectionId,
        scopes,
        resource,
        new Date(now + ACCESS_TOKEN_SECONDS * 1000),
        new Date(now + REFRESH_TOKEN_DAYS * 86_400_000),
      ],
    );
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { rows } = await this.db.query<{
      client_id: string;
      scopes: string[];
      resource: string | null;
      expires_at: Date;
      connection_id: string;
      user_id: string;
      label: string;
    }>(
      `SELECT t.client_id, t.scopes, t.resource, t.expires_at, t.connection_id, c.user_id, c.label
         FROM oauth_tokens t JOIN agent_connections c ON c.id = t.connection_id
        WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > $2
          AND c.revoked_at IS NULL`,
      [sha256(token), this.now()],
    );
    const t = rows[0];
    if (!t) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: t.client_id,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expires_at.getTime() / 1000),
      resource: new URL(t.resource ?? this.opts.mcpUrl),
      extra: { userId: t.user_id, connectionId: t.connection_id, agentLabel: t.label },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.query(`UPDATE oauth_tokens SET revoked_at = $3 WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`, [
      sha256(request.token),
      client.client_id,
      this.now(),
    ]);
  }
}

function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/#.*$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
