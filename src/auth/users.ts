/**
 * People sign in with passkeys (WebAuthn). No passwords, no third-party sign-in,
 * no email needed. A signed-in browser holds a random session cookie; only its
 * hash is stored.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import { newSecret, sha256 } from "../crypto.js";
import type { Db } from "../db/pool.js";

export const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;

export interface User {
  id: string;
  name: string;
}

export class SignInError extends Error {}

export class Users {
  constructor(
    private readonly opts: { db: Db; clock: Clock; rpId: string; rpName: string; origin: string },
  ) {}

  private now() {
    return this.opts.clock();
  }

  async createSession(userId: string): Promise<{ token: string; expires: Date }> {
    const token = newSecret();
    const expires = new Date(this.now().getTime() + SESSION_DAYS * 86_400_000);
    await this.opts.db.query(`INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`, [
      sha256(token),
      userId,
      expires,
    ]);
    return { token, expires };
  }

  async userForSession(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    const { rows } = await this.opts.db.query<User>(
      `SELECT u.id, u.name FROM web_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [sha256(token), this.now()],
    );
    return rows[0] ?? null;
  }

  async endSession(token: string | undefined): Promise<void> {
    if (token) await this.opts.db.query(`DELETE FROM web_sessions WHERE token_hash = $1`, [sha256(token)]);
  }

  // ---------- registration ----------

  /** Start creating a passkey: for a new account (name given) or an extra passkey for a signed-in user. */
  async registrationOptions(input: { name?: string; existingUser?: User | null }) {
    let userId: string;
    let name: string;
    let exclude: { id: string }[] = [];
    if (input.existingUser) {
      userId = input.existingUser.id;
      name = input.existingUser.name;
      const { rows } = await this.opts.db.query<{ credential_id: string }>(
        `SELECT credential_id FROM passkeys WHERE user_id = $1`,
        [userId],
      );
      exclude = rows.map((r) => ({ id: r.credential_id }));
    } else {
      name = (input.name ?? "").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 60) throw new SignInError("Enter your name (up to 60 characters).");
      userId = randomUUID();
    }
    const options = await generateRegistrationOptions({
      rpName: this.opts.rpName,
      rpID: this.opts.rpId,
      userName: name,
      userDisplayName: name,
      userID: new TextEncoder().encode(userId),
      attestationType: "none",
      excludeCredentials: exclude,
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const { rows } = await this.opts.db.query<{ id: string }>(
      `INSERT INTO webauthn_challenges (kind, challenge, data, expires_at) VALUES ('register', $1, $2, $3) RETURNING id`,
      [
        options.challenge,
        JSON.stringify({ userId, name, existing: !!input.existingUser }),
        new Date(this.now().getTime() + CHALLENGE_MINUTES * 60_000),
      ],
    );
    return { challengeId: rows[0]!.id, options };
  }

  async finishRegistration(challengeId: string, response: RegistrationResponseJSON): Promise<User> {
    const ch = await this.takeChallenge(challengeId, "register");
    const data = ch.data as { userId: string; name: string; existing: boolean };
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.opts.origin,
        expectedRPID: this.opts.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new SignInError(`That passkey couldn't be verified (${(err as Error).message}).`);
    }
    if (!verified.verified || !verified.registrationInfo) throw new SignInError("That passkey couldn't be verified.");
    const cred = verified.registrationInfo.credential;
    const client = await this.opts.db.connect();
    try {
      await client.query("BEGIN");
      if (!data.existing) {
        await client.query(`INSERT INTO users (id, name) VALUES ($1, $2)`, [data.userId, data.name]);
      }
      await client.query(
        `INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports) VALUES ($1,$2,$3,$4,$5)`,
        [cred.id, data.userId, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? []],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { id: data.userId, name: data.name };
  }

  // ---------- sign-in ----------

  async signInOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.opts.rpId, userVerification: "preferred" });
    const { rows } = await this.opts.db.query<{ id: string }>(
      `INSERT INTO webauthn_challenges (kind, challenge, expires_at) VALUES ('sign_in', $1, $2) RETURNING id`,
      [options.challenge, new Date(this.now().getTime() + CHALLENGE_MINUTES * 60_000)],
    );
    return { challengeId: rows[0]!.id, options };
  }

  async finishSignIn(challengeId: string, response: AuthenticationResponseJSON): Promise<User> {
    const ch = await this.takeChallenge(challengeId, "sign_in");
    const { rows } = await this.opts.db.query<{
      credential_id: string;
      user_id: string;
      public_key: Buffer;
      counter: string;
      transports: string[];
      name: string;
    }>(
      `SELECT p.*, u.name FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = $1`,
      [response.id],
    );
    const pk = rows[0];
    if (!pk) throw new SignInError("This passkey isn't registered here. Create an account first.");
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.opts.origin,
        expectedRPID: this.opts.rpId,
        requireUserVerification: false,
        credential: {
          id: pk.credential_id,
          publicKey: new Uint8Array(pk.public_key),
          counter: Number(pk.counter),
          transports: pk.transports as never,
        },
      });
    } catch (err) {
      throw new SignInError(`That passkey couldn't be verified (${(err as Error).message}).`);
    }
    if (!verified.verified) throw new SignInError("That passkey couldn't be verified.");
    await this.opts.db.query(`UPDATE passkeys SET counter = $2, last_used_at = $3 WHERE credential_id = $1`, [
      pk.credential_id,
      verified.authenticationInfo.newCounter,
      this.now(),
    ]);
    return { id: pk.user_id, name: pk.name };
  }

  private async takeChallenge(id: string, kind: "register" | "sign_in") {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SignInError("Sign-in expired. Try again.");
    const { rows } = await this.opts.db.query<{ challenge: string; data: unknown }>(
      `UPDATE webauthn_challenges SET used_at = $3
        WHERE id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3
        RETURNING challenge, data`,
      [id, kind, this.now()],
    );
    if (!rows[0]) throw new SignInError("Sign-in expired. Try again.");
    return rows[0];
  }

  // ---------- agent connections ----------

  async connections(userId: string) {
    const { rows } = await this.opts.db.query<{ id: string; label: string; vendor: string; created_at: Date; seats: string }>(
      `SELECT c.id, c.label, c.vendor, c.created_at,
              (SELECT COUNT(*) FROM participants p WHERE p.connection_id = c.id AND p.left_at IS NULL) AS seats
         FROM agent_connections c WHERE c.user_id = $1 AND c.revoked_at IS NULL ORDER BY c.created_at`,
      [userId],
    );
    return rows;
  }

  /** Disconnect an agent: its tokens stop working and its seats are removed. */
  async revokeConnection(userId: string, connectionId: string): Promise<boolean> {
    const now = this.now();
    const { rowCount } = await this.opts.db.query(
      `UPDATE agent_connections SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [connectionId, userId, now],
    );
    if (!rowCount) return false;
    await this.opts.db.query(`UPDATE oauth_tokens SET revoked_at = $2 WHERE connection_id = $1 AND revoked_at IS NULL`, [
      connectionId,
      now,
    ]);
    await this.opts.db.query(
      `UPDATE grants SET revoked_at = $2 WHERE revoked_at IS NULL
          AND participant_id IN (SELECT id FROM participants WHERE connection_id = $1)`,
      [connectionId, now],
    );
    return true;
  }
}
