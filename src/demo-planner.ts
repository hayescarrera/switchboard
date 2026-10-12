// The planner on the real Claude API. A stand-in "Cursor" asks it two questions:
// one the plan answers, and one only you can. You answer the second here in
// the terminal; then Cursor asks it again on a new task, and the planner answers
// from what you said. Run with `npm run demo:planner` (needs ANTHROPIC_API_KEY).

import { createInterface } from "node:readline/promises";
import { PlannerAdapter } from "./adapters/planner.js";
import { ScriptedAdapter } from "./adapters/scripted.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { ClaudePlannerModel } from "./planner/claude.js";
import { Router } from "./router.js";
import { createAgent, createLine, createThread, createUser, messagesForThread, openEscalations } from "./store.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in .env first (see .env.example).");
  process.exit(1);
}

const db = createPool();
await migrate(db);

// The stand-in Cursor asks the question named in its task, then reports back.
const cursor = new ScriptedAdapter((d) => {
  if (d.type === "task") return [{ kind: "question", body: d.body.replace(/^Ask: /, "") }];
  if (d.type === "answer") return [{ kind: "result", body: "Got it, building that." }];
  return [];
});
const router = new Router({ db, adapters: { planner: new PlannerAdapter({ db, model: new ClaudePlannerModel() }), cursor } });

const ben = await createUser(db, { name: "Ben" });
const planner = await createAgent(db, { name: "Planner", vendor: "anthropic", kind: "hub_run", adapter: "planner", ownerUserId: ben.id });
const builder = await createAgent(db, { name: "Cursor", vendor: "test", kind: "adapter", adapter: "cursor", ownerUserId: ben.id });
const names = new Map([[planner.id, "Planner"], [builder.id, "Cursor"]]);
await createLine(db, { fromNode: planner.id, toNode: builder.id, owners: [ben.id], acceptedBy: [ben.id], contextScope: ["plan"] });
const thread = await createThread(db, {
  title: "CSV export",
  goal: "Let users export the reports table as a file.",
  context: {
    plan: "Add an Export button to the reports page that downloads the current table.",
    decisions: ["Export format is CSV, not Excel.", "Dates are written as ISO 8601 (2026-10-12)."],
    constraints: ["No new dependencies."],
  },
});

let shown = 0;
async function show() {
  const messages = await messagesForThread(db, thread.id);
  for (const m of messages.slice(shown)) console.log(`  ${names.get(m.from_agent)} -> ${names.get(m.to_agent)} [${m.type}] ${m.body}`);
  shown = messages.length;
}
const terminal = createInterface({ input: process.stdin, output: process.stdout });

/** Cursor asks the planner something. If the planner escalates, you answer here. */
async function ask(question: string): Promise<number> {
  await router.send({ threadId: thread.id, from: planner.id, to: builder.id, type: "task", body: `Ask: ${question}` });
  await router.idle();
  await show();
  const waiting = await openEscalations(db, thread.id);
  for (const esc of waiting) {
    console.log(`\n  Waiting on you: ${esc.question}\n  (${esc.summary})`);
    const answer = await terminal.question("  Your answer: ");
    await router.answerEscalation({ escalationId: esc.id, userId: ben.id, answer });
    await router.idle();
    await show();
  }
  return waiting.length;
}

console.log("\n1. A question the plan answers:");
await ask("What date format should the export use?");

console.log("\n2. A question only you can answer:");
await ask("Should the Export button be visible to read-only users, or only to editors?");

console.log("\n3. Later, Cursor runs into the same question:");
const askedAgain = await ask("Can read-only users see the Export button?");
console.log(askedAgain ? "\n  The planner asked you again." : "\n  The planner answered from what you said, without asking you again.");

terminal.close();
await db.end();
