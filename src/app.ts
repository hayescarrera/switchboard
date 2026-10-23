import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OAuthProvider, SUPPORTED_SCOPES } from "./auth/oauth.js";
import { Users } from "./auth/users.js";
import { systemClock, type Clock } from "./clock.js";
import type { Db } from "./db/pool.js";
import { buildMcpServer } from "./mcp/tools.js";
import { RoomService } from "./rooms/service.js";
import { webRouter } from "./web/routes.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
// The package doesn't export its browser bundle path, so point at it directly.
const webauthnBrowser = fileURLToPath(
  new URL("../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", import.meta.url),
);

export interface AppOptions {
  db: Db;
  baseUrl: string;
  clock?: Clock;
  trustProxyHops?: number;
  /** Turn off the SDK's per-IP rate limits (tests run many calls from one IP). */
  disableRateLimits?: boolean;
}

export function createApp(opts: AppOptions) {
  const clock = opts.clock ?? systemClock;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const mcpUrl = `${baseUrl}/mcp`;
  const host = new URL(baseUrl);

  const rooms = new RoomService({ db: opts.db, clock, baseUrl });
  const users = new Users({ db: opts.db, clock, rpId: host.hostname, rpName: "Tekhnea", origin: host.origin });
  const oauth = new OAuthProvider({ db: opts.db, clock, baseUrl, mcpUrl });

  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxyHops) app.set("trust proxy", opts.trustProxyHops);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // same-origin: our own forms keep their Origin header; join links never leak to other sites.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    );
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // OAuth endpoints + metadata for connectors (dynamic client registration, PKCE).
  const limits = opts.disableRateLimits ? { rateLimit: false as const } : {};
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(baseUrl),
      baseUrl: new URL(baseUrl),
      resourceServerUrl: new URL(mcpUrl),
      scopesSupported: SUPPORTED_SCOPES,
      resourceName: "Tekhnea rooms",
      authorizationOptions: limits,
      clientRegistrationOptions: limits,
      tokenOptions: limits,
      revocationOptions: limits,
    }),
  );

  // The MCP endpoint (stateless Streamable HTTP).
  const bearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)),
    expectedResource: new URL(mcpUrl),
  });
  app.post("/mcp", bearer, express.json({ limit: "2mb" }), async (req, res) => {
    const extra = req.auth!.extra as { userId: string; connectionId: string; agentLabel: string };
    const server = buildMcpServer({
      rooms,
      clock,
      caller: { userId: extra.userId, connectionId: extra.connectionId },
      agentLabel: extra.agentLabel,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Static assets.
  app.get("/assets/webauthn.js", (_req, res) => res.type("js").sendFile(webauthnBrowser));
  app.use("/assets", express.static(publicDir, { maxAge: "1h" }));

  app.use(webRouter({ users, rooms, oauth, baseUrl, mcpUrl }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[web] request failed", err);
    if (!res.headersSent) res.status(500).send("Something went wrong. Try again.");
  });

  return { app, rooms, users, oauth };
}
