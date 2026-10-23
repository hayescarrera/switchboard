/**
 * The v1 success test over real HTTP: two agents connect through OAuth (as Claude
 * and ChatGPT would), meet in one room through the MCP tools, trade turns, propose,
 * and the human approves in the web app. No copy-paste anywhere.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeUser, resetDb, testPool } from "./helpers.js";

const db = testPool();
let server: Server;
let base: string;
let users: ReturnType<typeof createApp>["users"];

beforeAll(async () => {
  // Bind first to learn the port, then build the app with the right base URL.
  const { createServer } = await import("node:http");
  server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const built = createApp({ db, baseUrl: base, disableRateLimits: true });
  users = built.users;
  server.on("request", built.app);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});
beforeEach(() => resetDb(db));

async function signedIn(name: string) {
  const userId = await makeUser(db, name);
  const s = await users.createSession(userId);
  return { userId, cookie: `sb_session=${s.token}` };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Connect an AI app the way an MCP client does: discovery, registration, PKCE, consent, token. */
async function connectAgent(human: { cookie: string }, clientName: string, label: string, reuse = "") {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(prm.resource).toBe(`${base}/mcp`);
  const meta = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json();
  const reg = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const auth = new URL(meta.authorization_endpoint);
  Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://client.test/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    scope: "rooms",
    resource: `${base}/mcp`,
  }).forEach(([k, v]) => auth.searchParams.set(k, v));
  const a = await fetch(auth, { redirect: "manual" });
  expect(a.status).toBe(302);
  const consentUrl = a.headers.get("location")!;
  expect(consentUrl).toMatch(/\/connect\//);

  const page = await (await fetch(consentUrl, { headers: { cookie: human.cookie } })).text();
  expect(page).toContain(`Connect ${clientName}?`);

  const c = await fetch(consentUrl, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: human.cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "allow", label, reuse }),
  });
  expect(c.status).toBe(303);
  const back = new URL(c.headers.get("location")!);
  expect(back.origin).toBe("https://client.test");
  expect(back.searchParams.get("state")).toBe("st8");

  const tok = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: "https://client.test/callback",
      resource: `${base}/mcp`,
    }),
  });
  expect(tok.status).toBe(200);
  const tokens = await tok.json();
  return { clientId: reg.client_id as string, tokens, tokenEndpoint: meta.token_endpoint as string };
}

async function mcp(accessToken: string) {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
    },
  };
}

describe("MCP endpoint auth", () => {
  it("asks unauthenticated clients to sign in via OAuth metadata", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("refuses the consent form from another site", async () => {
    const ben = await signedIn("Ben");
    const r = await fetch(`${base}/connect/00000000-0000-0000-0000-000000000000`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: ben.cookie, origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
      body: "decision=allow",
    });
    expect(r.status).toBe(403);
  });
});

describe("first test: Claude + ChatGPT draft the onboarding checklist", () => {
  it("runs from room to approval with zero copy-paste", async () => {
    const ben = await signedIn("Ben Linder");
    const claudeConn = await connectAgent(ben, "Claude", "Ben's Claude");
    const gptConn = await connectAgent(ben, "ChatGPT", "Ben's ChatGPT");
    const claude = await mcp(claudeConn.tokens.access_token);
    const gpt = await mcp(gptConn.tokens.access_token);

    const tools = await claude.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["approve", "create_room", "invite", "list_rooms", "post", "propose", "read_room"].sort(),
    );

    // 1. Claude opens the room.
    const created = await claude.call("create_room", {
      goal: "Draft a one-page onboarding checklist for a new Tekhnea customer.",
      my_role: "product",
      invite_roles: ["docs"],
    });
    const roomId = created.text.match(/Room created: ([0-9a-f-]{36})/)![1]!;

    // 2. Claude makes a join link; Ben opens it and seats his ChatGPT.
    const inv = await claude.call("invite", { room_id: roomId, role: "docs", note: "Ben's ChatGPT" });
    const joinUrl = inv.text.match(/(http:\/\/\S+\/join\/\S+)/)![1]!;
    expect(await gpt.call("read_room", { room_id: roomId })).toMatchObject({ isError: true }); // not seated yet

    const joinPage = await (await fetch(joinUrl, { headers: { cookie: ben.cookie } })).text();
    expect(joinPage).toContain("Which of your agents takes the docs seat?");
    const gptConnectionId = joinPage.match(/name="connection" value="([0-9a-f-]{36})"[^>]*>\s*<strong>Ben&#39;s ChatGPT/)![1]!;
    const joined = await fetch(joinUrl, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: ben.cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ connection: gptConnectionId }),
    });
    expect(joined.status).toBe(303);
    expect(joined.headers.get("location")).toBe(`/rooms/${roomId}`);

    // 3. Agents trade turns. ChatGPT can't jump the queue.
    const list = await gpt.call("list_rooms");
    expect(list.text).toContain(roomId);
    expect(list.text).toContain("Not your turn");
    expect((await gpt.call("post", { room_id: roomId, body: "me first" })).text).toMatch(/Refused: It's the product seat's turn/);

    const r1 = await claude.call("read_room", { room_id: roomId });
    expect(r1.text).toContain("IT'S YOUR TURN");
    await claude.call("post", {
      room_id: roomId,
      body: "Product view: the checklist must cover sign-in, company voice, first three team skills, connecting Claude and ChatGPT.",
      next_role: "docs",
    });

    const r2 = await gpt.call("read_room", { room_id: roomId });
    expect(r2.text).toContain("IT'S YOUR TURN");
    expect(r2.text).toContain('<room_content trust="untrusted"');
    expect(r2.text).toContain("company voice");
    await gpt.call("post", {
      room_id: roomId,
      body: "Docs draft attached. Question for product: who is the default approver?",
      files: [{ name: "onboarding-checklist.md", content: "# Onboarding\n- [ ] Sign in\n- [ ] Set company voice\n" }],
    });

    const r3 = await claude.call("read_room", { room_id: roomId, since_turn: 1 });
    expect(r3.text).toContain("MESSAGES AFTER TURN 1 (1)");
    expect(r3.text).toContain("onboarding-checklist.md");

    // 4. Claude proposes; agents can't approve.
    const prop = await claude.call("propose", {
      room_id: roomId,
      summary: "One-page onboarding checklist for new Tekhnea customers.",
      changes: ["Sign in with Google or Microsoft", "Write company voice", "Create three team skills", "Connect Claude and ChatGPT"],
      open_questions: ["Default approver: team owner?"],
    });
    expect(prop.text).toContain("Proposal submitted");
    expect((await gpt.call("approve", { room_id: roomId })).text).toMatch(/Only a human can approve/);
    expect((await gpt.call("post", { room_id: roomId, body: "late" })).isError).toBe(true);

    // 5. Ben approves in one tap.
    const roomPage = await (await fetch(`${base}/rooms/${roomId}`, { headers: { cookie: ben.cookie } })).text();
    const proposalId = roomPage.match(/proposals\/([0-9a-f-]{36})\/decide/)![1]!;
    const decided = await fetch(`${base}/rooms/${roomId}/proposals/${proposalId}/decide`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: ben.cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision: "approve" }),
    });
    expect(decided.status).toBe(303);

    const done = await claude.call("read_room", { room_id: roomId });
    expect(done.text).toContain("Status: approved");

    // 6. Every call is in the audit log, exportable by a participant.
    const audit = await (await fetch(`${base}/rooms/${roomId}/audit.json`, { headers: { cookie: ben.cookie } })).json();
    const actions = audit.entries.map((e: { action: string; result: string }) => `${e.action}:${e.result}`);
    expect(actions).toEqual(
      expect.arrayContaining(["create_room:ok", "invite:ok", "invite.accepted:ok", "post:ok", "post:refused", "propose:ok", "proposal.approve:ok", "room.approved:ok"]),
    );
    // The stranger-proof refusals (agent not seated yet; approve) don't leak into this room's log.
    expect(audit.entries.every((e: { room_id?: string }) => e.room_id === undefined || e.room_id === roomId)).toBe(true);
  });

  it("another person's agent can't read the room, and a disconnected agent loses access", async () => {
    const ben = await signedIn("Ben");
    const eve = await signedIn("Eve");
    const claude = await mcp((await connectAgent(ben, "Claude", "Ben's Claude")).tokens.access_token);
    const eveConn = await connectAgent(eve, "Grok", "Eve's Grok");
    const evil = await mcp(eveConn.tokens.access_token);
    const roomId = (await claude.call("create_room", { goal: "Secret plan", my_role: "product" })).text.match(
      /Room created: ([0-9a-f-]{36})/,
    )![1]!;
    expect((await evil.call("read_room", { room_id: roomId })).text).toMatch(/Refused: No room with that id/);
    expect((await evil.call("list_rooms")).text).not.toContain(roomId);

    // Eve disconnects her agent from the web app → its token stops working.
    const home = await (await fetch(`${base}/`, { headers: { cookie: eve.cookie } })).text();
    const connId = home.match(/\/agents\/([0-9a-f-]{36})\/disconnect/)![1]!;
    await fetch(`${base}/agents/${connId}/disconnect`, { method: "POST", redirect: "manual", headers: { cookie: eve.cookie, origin: base } });
    const after = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eveConn.tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  it("refresh tokens rotate and work only once", async () => {
    const ben = await signedIn("Ben");
    const conn = await connectAgent(ben, "Claude", "Ben's Claude");
    const refresh = (token: string) =>
      fetch(conn.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: conn.clientId }),
      });
    const first = await refresh(conn.tokens.refresh_token);
    expect(first.status).toBe(200);
    const again = await refresh(conn.tokens.refresh_token);
    expect(again.status).toBe(400);
    const next = await first.json();
    const agent = await mcp(next.access_token);
    expect((await agent.call("list_rooms")).text).toContain("no rooms yet");
  });

  it("reconnecting the same app keeps its room seats", async () => {
    const ben = await signedIn("Ben");
    const first = await connectAgent(ben, "Claude", "Ben's Claude");
    const claude = await mcp(first.tokens.access_token);
    const roomId = (await claude.call("create_room", { goal: "Goal", my_role: "product" })).text.match(
      /Room created: ([0-9a-f-]{36})/,
    )![1]!;
    const home = await (await fetch(`${base}/`, { headers: { cookie: ben.cookie } })).text();
    const existingId = home.match(/\/agents\/([0-9a-f-]{36})\/disconnect/)![1]!;
    // Claude registers a fresh OAuth client on reconnect; Ben picks "Reconnect Ben's Claude".
    const second = await connectAgent(ben, "Claude", "", existingId);
    const again = await mcp(second.tokens.access_token);
    expect((await again.call("list_rooms")).text).toContain(roomId);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM agent_connections WHERE user_id = $1`, [ben.userId]);
    expect(rows[0].n).toBe(1);
  });
});
