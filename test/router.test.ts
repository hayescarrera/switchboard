import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/pool.js";
import { eventsForThread } from "../src/events.js";
import { acceptLine, createLine, createUser, getThread, messagesForThread, runsForThread, setLineEnabled } from "../src/store.js";
import { resetDb, testPool, world } from "./helpers.js";

let db: Db;

beforeEach(async () => {
  db ??= testPool();
  await resetDb(db);
});

afterAll(async () => {
  await db?.end();
});

const kinds = async (threadId: string) => (await eventsForThread(db, threadId)).map((e) => e.kind);

describe("allowed", () => {
  it("delivers a task over a line and brings the reply back on the thread", async () => {
    const { router, ben, a, b, thread } = await world(db);
    await createLine(db, { fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id] });

    const res = await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it" });
    expect(res.delivered).toBe(true);
    await router.idle();

    const messages = await messagesForThread(db, thread.id);
    expect(messages.map((m) => [m.from_agent, m.to_agent, m.type, m.body])).toEqual([
      [a.id, b.id, "task", "build it"],
      [b.id, a.id, "status", "working on it"],
      [b.id, a.id, "result", "echo: build it"],
    ]);

    const runs = await runsForThread(db, thread.id);
    expect(runs.every((r) => r.state === "done")).toBe(true);
    expect((await getThread(db, thread.id)).message_count).toBe(3);
  });

  it("writes every step to the event log", async () => {
    const { router, ben, a, b, thread } = await world(db);
    await createLine(db, { fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id] });
    await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "question", body: "which way?" });
    await router.idle();

    const log = await kinds(thread.id);
    // The question, from arrival to delivery to the run that carried it...
    expect(log.slice(0, 7)).toEqual([
      "thread.created",
      "message.received",
      "line.checked",
      "context.scoped",
      "message.delivered",
      "run.started",
      "run.event",
    ]);
    // ...and the answer coming back the same way.
    expect(log).toContain("run.finished");
    expect(log.filter((k) => k === "message.delivered")).toHaveLength(2);
  });

  it("lets the receiver ask a question back along the same line", async () => {
    const { router, ben, a, agent, thread } = await world(db);
    const asker = await agent("Asker", "echo_ask_back");
    await createLine(db, { fromNode: a.id, toNode: asker.id, owners: [ben.id], acceptedBy: [ben.id] });

    await router.send({ threadId: thread.id, from: a.id, to: asker.id, type: "task", body: "build it" });
    await router.idle();

    const [, back, answer] = await messagesForThread(db, thread.id);
    expect([back.from_agent, back.type]).toEqual([asker.id, "question"]);
    expect([answer.from_agent, answer.type]).toEqual([a.id, "answer"]);
  });
});

describe("denied", () => {
  it("rejects a message when no line exists, and logs why", async () => {
    const { router, a, b, thread } = await world(db);

    const res = await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it" });
    expect(res).toMatchObject({ delivered: false, reason: "no_line" });
    expect(await messagesForThread(db, thread.id)).toHaveLength(0);
    expect(await runsForThread(db, thread.id)).toHaveLength(0);

    const events = await eventsForThread(db, thread.id);
    expect(events.map((e) => e.kind)).toEqual(["thread.created", "message.received", "line.checked", "message.rejected"]);
    expect(events[2].data).toMatchObject({ allowed: false, reason: "no_line" });
  });

  it("only lets the receiver reply, not start new work in the other direction", async () => {
    const { router, ben, a, b, thread } = await world(db);
    await createLine(db, { fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id] });

    const res = await router.send({ threadId: thread.id, from: b.id, to: a.id, type: "task", body: "you do it" });
    expect(res).toMatchObject({ delivered: false, reason: "no_line" });
  });

  it("rejects message types the line does not allow", async () => {
    const { router, ben, a, b, thread } = await world(db);
    await createLine(db, {
      fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id], allowedTypes: ["question", "answer"],
    });

    const res = await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it" });
    expect(res).toMatchObject({ delivered: false, reason: "type_not_allowed" });
  });

  it("rejects messages on a line that has been switched off", async () => {
    const { router, ben, a, b, thread } = await world(db);
    const line = await createLine(db, { fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id] });
    await setLineEnabled(db, line.id, false);

    const res = await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it" });
    expect(res).toMatchObject({ delivered: false, reason: "line_disabled" });
  });

  it("needs every owner of a two-person line to accept it", async () => {
    const { router, ben, a, thread, } = await world(db);
    const dev = await createUser(db, { name: "Developer" });
    const { createAgent } = await import("../src/store.js");
    const devAgent = await createAgent(db, { name: "Dev's agent", vendor: "test", kind: "adapter", adapter: "echo", ownerUserId: dev.id });
    const line = await createLine(db, { fromNode: a.id, toNode: devAgent.id, owners: [ben.id, dev.id], acceptedBy: [ben.id] });

    const before = await router.send({ threadId: thread.id, from: a.id, to: devAgent.id, type: "task", body: "hi" });
    expect(before).toMatchObject({ delivered: false, reason: "line_not_accepted" });

    await acceptLine(db, line.id, dev.id);
    const after = await router.send({ threadId: thread.id, from: a.id, to: devAgent.id, type: "task", body: "hi" });
    expect(after.delivered).toBe(true);
    await router.idle();
  });
});

describe("scoped context", () => {
  it("sends only the context fields the line allows", async () => {
    const { router, adapters, ben, a, b, thread } = await world(db, {
      context: {
        plan: "Add a CSV export button",
        constraints: ["no new dependencies"],
        summary: "private notes about the customer",
      },
    });
    await createLine(db, {
      fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id], contextScope: ["plan", "decisions"],
    });
    const sent = vi.spyOn(adapters.echo, "send");

    await router.send({
      threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it",
      context: { decisions: ["stream the file"], links: ["https://example.com/secret"] },
    });
    await router.idle();

    const delivered = sent.mock.calls[0][1];
    expect(delivered.context).toEqual({ plan: "Add a CSV export button", decisions: ["stream the file"] });

    const [task] = await messagesForThread(db, thread.id);
    expect(task.context).toEqual(delivered.context);

    const scoped = (await eventsForThread(db, thread.id)).find((e) => e.kind === "context.scoped")!;
    expect((scoped.data.withheld as string[]).sort()).toEqual(["constraints", "links", "summary"]);
  });
});

describe("loop guard", () => {
  it("pauses a thread where two agents keep asking each other questions", async () => {
    const { router, ben, agent, thread } = await world(db);
    const x = await agent("Curious X", "echo_ask_back");
    const y = await agent("Curious Y", "echo_ask_back");
    await createLine(db, { fromNode: x.id, toNode: y.id, owners: [ben.id], acceptedBy: [ben.id] });

    await router.send({ threadId: thread.id, from: x.id, to: y.id, type: "question", body: "why?" });
    await router.idle(); // ends only because the loop guard stops it

    const paused = await getThread(db, thread.id);
    expect(paused.message_count).toBe(40);
    expect(paused.status).toBe("waiting_on_user");
    expect(paused.status_reason).toBe("loop_guard");
    expect(await messagesForThread(db, thread.id)).toHaveLength(40);

    const log = await kinds(thread.id);
    expect(log).toContain("loop_guard.tripped");
    expect(log).toContain("escalation.raised");

    // Nothing else gets through until the user steps in.
    const res = await router.send({ threadId: thread.id, from: x.id, to: y.id, type: "question", body: "still?" });
    expect(res).toMatchObject({ delivered: false, reason: "thread_not_active" });
  });

  it("uses the thread's own limit when one is set", async () => {
    const { router, ben, agent, thread } = await world(db, { maxMessages: 5 });
    const x = await agent("Curious X", "echo_ask_back");
    const y = await agent("Curious Y", "echo_ask_back");
    await createLine(db, { fromNode: x.id, toNode: y.id, owners: [ben.id], acceptedBy: [ben.id] });

    await router.send({ threadId: thread.id, from: x.id, to: y.id, type: "question", body: "why?" });
    await router.idle();

    expect((await getThread(db, thread.id)).message_count).toBe(5);
  });
});

describe("run timeouts", () => {
  it("nudges a quiet agent, then escalates if it stays quiet", async () => {
    const { router, adapters, clock, ben, a, agent, thread } = await world(db);
    const sleepy = await agent("Sleepy", "echo_silent");
    await createLine(db, { fromNode: a.id, toNode: sleepy.id, owners: [ben.id], acceptedBy: [ben.id] });

    const res = await router.send({ threadId: thread.id, from: a.id, to: sleepy.id, type: "task", body: "build it" });
    if (!res.delivered) throw new Error("expected delivery");
    const [run] = await runsForThread(db, thread.id);

    // Not yet past the 60 second timeout: nothing happens.
    clock.advance(59);
    await router.checkTimeouts();
    expect(await kinds(thread.id)).not.toContain("run.nudged");

    // Past it: the agent is nudged, and the clock restarts.
    clock.advance(1);
    await router.checkTimeouts();
    expect(await kinds(thread.id)).toContain("run.nudged");
    expect(adapters.echo_silent.followUpsFor(run.external_ref!)).toHaveLength(1);
    expect((await getThread(db, thread.id)).status).toBe("active");

    // Still quiet after another timeout: the run stops and the user is pulled in.
    clock.advance(60);
    await router.checkTimeouts();
    const [stopped] = await runsForThread(db, thread.id);
    expect(stopped.state).toBe("timed_out");
    const t = await getThread(db, thread.id);
    expect([t.status, t.status_reason]).toEqual(["waiting_on_user", "run_timed_out"]);
    expect(await kinds(thread.id)).toEqual(expect.arrayContaining(["run.timed_out", "escalation.raised"]));

    await router.idle(); // the cancelled run's event stream has closed
  });

  it("leaves runs that finish in time alone", async () => {
    const { router, clock, ben, a, b, thread } = await world(db);
    await createLine(db, { fromNode: a.id, toNode: b.id, owners: [ben.id], acceptedBy: [ben.id] });
    await router.send({ threadId: thread.id, from: a.id, to: b.id, type: "task", body: "build it" });
    await router.idle();

    clock.advance(3600);
    await router.checkTimeouts();
    expect(await kinds(thread.id)).not.toContain("run.nudged");
    expect((await getThread(db, thread.id)).status).toBe("active");
  });
});

describe("event log", () => {
  it("cannot be edited or deleted", async () => {
    const { thread } = await world(db);
    await expect(db.query(`UPDATE events SET kind = 'tampered' WHERE thread_id = $1`, [thread.id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM events WHERE thread_id = $1`, [thread.id]))
      .rejects.toThrow(/append-only/);
  });
});
