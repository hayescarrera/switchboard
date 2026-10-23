/** Screenshots of a handoff room: the waiting-on-you card (laptop + phone). Local Postgres only. */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const PORT = 4101, base = `http://localhost:${PORT}`;
const out = new URL("../docs/screens/", import.meta.url).pathname;
const db = createPool(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/switchboard");
await migrate(db);
await db.query(`TRUNCATE audit, ledger, proposal_decisions, proposals, messages, questions, handoffs, charters, grants, invites, participants, rooms,
  oauth_tokens, oauth_codes, agent_connections, oauth_requests, oauth_clients, webauthn_challenges, web_sessions, passkeys, users RESTART IDENTITY CASCADE`);
const { app, rooms, users } = createApp({ db, baseUrl: base });
const server = app.listen(PORT);
const user = async (name: string) => (await db.query(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
const agent = async (userId: string, label: string, vendor: string) => {
  const cid = randomUUID();
  await db.query(`INSERT INTO oauth_clients (client_id, info) VALUES ($1,$2)`, [cid, JSON.stringify({ client_id: cid, client_name: vendor, redirect_uris: ["https://x.test/cb"] })]);
  const id = (await db.query(`INSERT INTO agent_connections (user_id, client_id, label, vendor) VALUES ($1,$2,$3,$4) RETURNING id`, [userId, cid, label, vendor])).rows[0].id;
  return { userId, connectionId: id as string };
};
const ben = await user("Ben Linder"), dana = await user("Dana");
const claude = await agent(ben, "Ben's Claude", "Claude"), cursor = await agent(dana, "Dana's Cursor", "Cursor");
const h = await rooms.startHandoff(claude, {
  toRole: "developer", myRole: "product", goal: "Ship CSV import for customer lists in the onboarding flow.",
  summary: "Customers keep asking to bring their contact lists in during onboarding. We agreed on a CSV upload on the second onboarding screen, mapped to our contact fields, with a preview before saving.",
  decisions: ["CSV only for v1, no Excel", "Preview the first 20 rows before saving"], constraints: ["Max file 10 MB", "Must ship before the Nov 15 release"],
  openQuestions: ["What happens to duplicate emails?"], mayDecide: ["Column-mapping UI details", "Error message wording"], alwaysAsk: ["Anything that changes scope or the release date"],
});
await rooms.acceptInvite(dana, h.invite.url.split("/join/")[1]!, cursor.connectionId);
const q1 = await rooms.ask(cursor, h.roomId, { question: "Should the preview show all 20 rows or paginate by 10?" });
const q2 = await rooms.ask(cursor, h.roomId, { question: "Can we push the release to Nov 22 to add XLSX support too? Two customers asked for it last week." });
await rooms.answer(claude, h.roomId, { questionId: q1.questionId, answer: "Show all 20 on one screen; it's a preview, not a table." });
await rooms.escalate(claude, h.roomId, { questionId: q2.questionId, reason: "Changes the release date and scope; the charter says ask Ben." });
const s = await users.createSession(ben);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
for (const [name, viewport] of [["08-handoff-waiting", { width: 1180, height: 1500 }], ["09-handoff-waiting-phone", { width: 390, height: 844 }]] as const) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "sb_session", value: s.token, url: base }]);
  const p = await ctx.newPage();
  await p.goto(`${base}/rooms/${h.roomId}`);
  await p.screenshot({ path: `${out}${name}.png`, fullPage: name.endsWith("waiting") });
  console.log(`screenshot ${name}.png`);
  await ctx.close();
}
await browser.close();
server.close();
await db.end();
