/**
 * Real-browser check: passkey sign-up and sign-in with a virtual authenticator,
 * then the consent, join and approve pages, with screenshots in docs/screens/.
 * Needs a local Postgres (DATABASE_URL) and a Chromium (CHROMIUM_PATH or Playwright's).
 *
 *   npx tsx scripts/browser-check.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const PORT = 4100;
const base = `http://localhost:${PORT}`;
const out = new URL("../docs/screens/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const db = createPool(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/switchboard");
await migrate(db);
await db.query(`TRUNCATE audit, ledger, proposal_decisions, proposals, messages, grants, invites, participants, rooms,
  oauth_tokens, oauth_codes, agent_connections, oauth_requests, oauth_clients, webauthn_challenges, web_sessions,
  passkeys, users RESTART IDENTITY CASCADE`);
const { app } = createApp({ db, baseUrl: base, disableRateLimits: true });
const server = app.listen(PORT);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
// The OAuth client's redirect target is fake; answer it so the browser lands somewhere.
await context.route("https://client.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>Back in the AI app</h1>" }));

const shot = async (p: Page, name: string, fullPage = true) => {
  await p.screenshot({ path: `${out}${name}.png`, fullPage });
  console.log(`  screenshot ${name}.png`);
};
const step = (s: string) => console.log(`✓ ${s}`);

// 1. Create an account with a passkey.
await page.goto(base);
await shot(page, "01-sign-in");
await page.getByText("New here? Create an account").click();
await page.getByLabel("Your name").fill("Ben Linder");
await page.getByRole("button", { name: "Create account with a passkey" }).click();
await page.getByRole("heading", { name: "Hi Ben Linder" }).waitFor();
step("passkey account created and signed in");

// 2. Sign out and back in with the same passkey.
await page.getByRole("button", { name: "Sign out" }).click();
await page.getByRole("button", { name: "Sign in with a passkey" }).click();
await page.getByRole("heading", { name: "Hi Ben Linder" }).waitFor();
step("signed back in with the passkey");

// 3. Two AI apps connect through OAuth; Ben allows each on the consent page.
async function connect(clientName: string) {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const reg = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: ["https://client.test/cb"], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const verifier = randomBytes(32).toString("base64url");
  const auth = new URL(meta.authorization_endpoint);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://client.test/cb",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "x",
  }).toString();
  await page.goto(auth.href);
  await page.getByRole("heading", { name: `Connect ${clientName}?` }).waitFor();
  if (clientName === "ChatGPT") await shot(page, "02-connect-agent");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForURL(/client\.test/);
  const code = new URL(page.url()).searchParams.get("code")!;
  const tok = await (
    await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://client.test/cb" }),
    })
  ).json();
  const client = new Client({ name: clientName, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join("\n");
  };
}
const claude = await connect("Claude");
const gpt = await connect("ChatGPT");
step("Claude and ChatGPT connected through the consent page");

// 4. Claude opens the room and invites docs; Ben seats ChatGPT on the join page.
const roomId = (
  await claude("create_room", { goal: "Draft a one-page onboarding checklist for a new Tekhnea customer.", my_role: "product", invite_roles: ["docs"] })
).match(/Room created: (\S+)/)![1]!;
const joinUrl = (await claude("invite", { room_id: roomId, role: "docs", note: "For my ChatGPT" })).match(/(http\S+\/join\/\S+)/)![1]!;
await page.goto(joinUrl);
await page.getByText("Ben's ChatGPT").click();
await shot(page, "03-join-room");
await page.getByRole("button", { name: "Join as docs" }).click();
await page.waitForURL(/\/rooms\//);
step("ChatGPT seated in the docs role");

// 5. The agents trade work and propose.
await claude("post", {
  room_id: roomId,
  body: "Product view. The checklist should take a new customer from sign-up to a skill firing in both Claude and ChatGPT in their first session:\n1. Sign in with Google or Microsoft\n2. Write the company voice\n3. Add three team skills from starter packs\n4. Connect Claude and ChatGPT\n5. Check pickup\nDocs: can you turn this into a one-page checklist with time estimates?",
  next_role: "docs",
});
await gpt("post", {
  room_id: roomId,
  body: "Draft attached, about 35 minutes end to end. One question for product: who approves the first skills, the admin or the team owner?",
  files: [{ name: "onboarding-checklist.md", content: "# Tekhnea onboarding (≈35 min)\n- [ ] Sign in (2 min)\n- [ ] Company voice (10 min)\n- [ ] Three starter skills (10 min)\n- [ ] Connect Claude + ChatGPT (10 min)\n- [ ] Check pickup (3 min)\n" }],
});
await claude("propose", {
  room_id: roomId,
  summary: "A one-page onboarding checklist that takes a new Tekhnea customer from sign-up to a working skill in Claude and ChatGPT in about 35 minutes.",
  changes: ["Sign in with Google or Microsoft (2 min)", "Write the company voice (10 min)", "Add three starter team skills (10 min)", "Connect Claude and ChatGPT with the wizard (10 min)", "Run the pickup check (3 min)"],
  open_questions: ["Should the team owner, not the admin, approve the first skills?"],
});
step("agents posted two turns and proposed");

await page.goto(`${base}/rooms/${roomId}`);
await shot(page, "04-approve");
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
const phonePage = await phone.newPage();
await phonePage.goto(`${base}/rooms/${roomId}`);
await shot(phonePage, "05-approve-phone", false);
await phone.close();

await page.getByRole("button", { name: "Approve" }).click();
await page.getByText("Approved", { exact: true }).first().waitFor();
await shot(page, "06-approved");
const final = await claude("read_room", { room_id: roomId });
if (!final.includes("Status: approved")) throw new Error("room not approved");
step("Ben approved in one tap; the agent sees the room approved");

await page.goto(base);
await shot(page, "07-home");

await browser.close();
server.close();
await db.end();
console.log("Browser check passed.");
