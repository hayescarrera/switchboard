// The hub's web server. One process, three things:
//   /mcp/<token>            the MCP connector your chat apps add (Streamable HTTP)
//   /board/<token>          the live, read-only board
//   /board/<token>/state    the board's data; /board/<token>/events streams changes
// The token in the path keeps strangers out (CLAUDE.md 6.7); see the README.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { boardState } from "./board/state.js";
import { happeningsSince, latestEventId } from "./digest.js";
import type { Hub } from "./hub.js";
import { createConnector } from "./mcp/connector.js";

const boardHtml = readFileSync(fileURLToPath(new URL("./board/board.html", import.meta.url)), "utf8");

export interface HubServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startServer(hub: Hub, opts: { token: string; port?: number; host?: string }): Promise<HubServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const streams = new Set<ServerResponse>();
  const tokenOk = (given: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        // An unknown session (e.g. the hub restarted): the client starts a new one on a 404.
        return send(res, sessionId ? 404 : 400, { jsonrpc: "2.0", error: { code: -32000, message: "No session; initialize first." }, id: null });
      }
      let clientName = "chat";
      const mcp = createConnector(hub, () => clientName);
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, t); },
      });
      t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
      mcp.server.oninitialized = () => {
        // One "last seen" marker per chat app, so a reconnect doesn't replay everything.
        clientName = mcp.server.getClientVersion()?.name ?? "chat";
      };
      await mcp.connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  }

  async function handleEvents(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let last = await latestEventId(hub.db);
    let busy = false;
    const tick = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const upTo = await latestEventId(hub.db);
        if (upTo !== last) {
          for (const h of await happeningsSince(hub.db, last, upTo)) res.write(`data: ${JSON.stringify(h)}\n\n`);
          res.write(`event: tick\ndata: ${upTo}\n\n`);
          last = upTo;
        }
      } catch { /* the next tick tries again */ } finally { busy = false; }
    }, 700);
    streams.add(res);
    req.on("close", () => { clearInterval(tick); streams.delete(res); });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://hub");
      const [, area, token, extra] = url.pathname.split("/");
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if ((area !== "mcp" && area !== "board") || !token || !tokenOk(token)) return send(res, 404, { error: "Not found" });

      if (area === "mcp" && !extra) return await handleMcp(req, res);
      if (area === "board" && !extra && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(boardHtml);
      }
      if (area === "board" && extra === "state" && req.method === "GET") {
        return send(res, 200, await boardState(hub, url.searchParams.get("thread") ?? undefined));
      }
      if (area === "board" && extra === "events" && req.method === "GET") return await handleEvents(req, res);
      return send(res, 404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on the hub." });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port ?? 0;
  return {
    server, port,
    close: async () => {
      for (const s of streams) s.end();
      await Promise.all([...sessions.values()].map((t) => t.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
