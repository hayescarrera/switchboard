// A two-minute look at the hub: one message that a line allows, one it doesn't,
// and the event log that recorded both. Run with `npm run demo`.

import { EchoAdapter } from "./adapters/echo.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { eventsForThread } from "./events.js";
import { Router } from "./router.js";
import { createAgent, createLine, createThread, createUser, messagesForThread } from "./store.js";

const db = createPool();
await migrate(db);
const router = new Router({ db, adapters: { echo: new EchoAdapter() } });

const ben = await createUser(db, { name: "Ben" });
const agent = (name: string) => createAgent(db, { name, vendor: "test", kind: "adapter", adapter: "echo", ownerUserId: ben.id });
const planner = await agent("Planner");
const builder = await agent("Builder");
const stranger = await agent("Stranger");
const names = new Map([planner, builder, stranger].map((a) => [a.id, a.name]));

await createLine(db, {
  fromNode: planner.id, toNode: builder.id, owners: [ben.id], acceptedBy: [ben.id], contextScope: ["plan"],
});
const thread = await createThread(db, {
  title: "CSV export", context: { plan: "Add a CSV export button", summary: "notes that stay private" },
});

const ok = await router.send({ threadId: thread.id, from: planner.id, to: builder.id, type: "task", body: "Build the CSV export" });
await router.idle();
const no = await router.send({ threadId: thread.id, from: stranger.id, to: builder.id, type: "task", body: "Delete everything" });
await router.idle();

console.log(`Planner -> Builder: ${ok.delivered ? "delivered" : "rejected"}`);
console.log(`Stranger -> Builder: ${no.delivered ? "delivered" : `rejected (${no.reason})`}\n`);

console.log("Messages on the thread:");
for (const m of await messagesForThread(db, thread.id)) {
  console.log(`  ${names.get(m.from_agent)} -> ${names.get(m.to_agent)} [${m.type}] ${m.body}  context: ${JSON.stringify(m.context)}`);
}
console.log("\nEvent log:");
for (const e of await eventsForThread(db, thread.id)) {
  console.log(`  ${e.kind.padEnd(18)} ${JSON.stringify(e.data)}`);
}
await db.end();
