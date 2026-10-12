import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PlannerAdapter } from "../src/adapters/planner.js";
import type { Db } from "../src/db/pool.js";
import { eventsForThread } from "../src/events.js";
import { ClaudePlannerModel, renderInput } from "../src/planner/claude.js";
import type { PlannerDecision, PlannerInput, PlannerModel } from "../src/planner/model.js";
import { Router } from "../src/router.js";
import {
  createAgent, createLine, createThread, createUser, getThread, messagesForThread, openEscalations,
} from "../src/store.js";
import type { ThreadContext } from "../src/types.js";
import { fakeClock, resetDb, ScriptedAdapter, testPool } from "./helpers.js";

let db: Db;

beforeEach(async () => {
  db ??= testPool();
  await resetDb(db);
});

afterAll(async () => {
  await db?.end();
});

const STOP = new Set(["should", "would", "could", "which", "there", "their", "about", "these", "those"]);
const keywords = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/**
 * Stands in for Claude. It knows only what the planner hands it: it answers
 * when a decision or an earlier user answer shares a keyword with the question,
 * and escalates otherwise. Every input is kept so tests can see what it was given.
 */
class ScriptedModel implements PlannerModel {
  readonly inputs: PlannerInput[] = [];
  override?: (input: PlannerInput) => PlannerDecision | Promise<PlannerDecision>;

  async decide(input: PlannerInput): Promise<PlannerDecision> {
    this.inputs.push(input);
    if (this.override) return this.override(input);
    const asked = keywords(input.question);
    const overlaps = (text: string) => [...keywords(text)].some((w) => asked.has(w));
    const ctx = input.thread.context;
    const fromUser = ctx.user_answers?.find((a) => overlaps(a.question));
    if (fromUser) return { action: "answer", answer: fromUser.answer, confidence: 0.95 };
    const decision = ctx.decisions?.find(overlaps);
    if (decision) return { action: "answer", answer: decision, confidence: 0.9 };
    return { action: "escalate", questionForUser: input.question, reason: "The plan doesn't say." };
  }
}

const PLAN: ThreadContext = {
  plan: "Add a CSV export button to the reports page.",
  decisions: ["Export format: CSV, not Excel."],
  constraints: ["No new dependencies."],
  summary: "Ben's private notes from the planning chat.",
};

/**
 * Ben, the planner, and a builder agent (a stand-in for Cursor) that asks the
 * planner `question` when it gets a task, then reports a result once answered.
 */
async function setup(question: string, opts: { context?: ThreadContext } = {}) {
  const clock = fakeClock();
  const model = new ScriptedModel();
  const builderAdapter = new ScriptedAdapter((d) => {
    if (d.type === "task") return [{ kind: "question", body: question }];
    if (d.type === "answer") return [{ kind: "result", body: `Built it. Went with: ${d.body}` }];
    return [];
  });
  const router = new Router({
    db, clock: clock.now, defaultTimeoutSeconds: 60,
    adapters: { planner: new PlannerAdapter({ db, model }), builder: builderAdapter },
  });
  const ben = await createUser(db, { name: "Ben" });
  const planner = await createAgent(db, { name: "Planner", vendor: "anthropic", kind: "hub_run", adapter: "planner", ownerUserId: ben.id });
  const builder = await createAgent(db, { name: "Builder", vendor: "test", kind: "adapter", adapter: "builder", ownerUserId: ben.id });
  // Only the plan crosses to the builder. The planner itself reads the whole thread.
  await createLine(db, { fromNode: planner.id, toNode: builder.id, owners: [ben.id], acceptedBy: [ben.id], contextScope: ["plan"] });
  const thread = await createThread(db, { title: "CSV export", goal: "Ship CSV export", context: opts.context ?? PLAN });

  const startWork = async () => {
    await router.send({ threadId: thread.id, from: planner.id, to: builder.id, type: "task", body: "Build the CSV export." });
    await router.idle();
  };
  const conversation = async () =>
    (await messagesForThread(db, thread.id)).map((m) => [m.from_agent === planner.id ? "planner" : "builder", m.type, m.body]);
  const kinds = async () => (await eventsForThread(db, thread.id)).map((e) => e.kind);
  return { clock, model, router, ben, planner, builder, builderAdapter, thread, startWork, conversation, kinds };
}

describe("answering from the thread", () => {
  it("answers another agent's question from the plan, without the user", async () => {
    const w = await setup("Should the export be CSV or Excel?");
    await w.startWork();

    expect(await w.conversation()).toEqual([
      ["planner", "task", "Build the CSV export."],
      ["builder", "question", "Should the export be CSV or Excel?"],
      ["planner", "answer", "Export format: CSV, not Excel."],
      ["builder", "result", "Built it. Went with: Export format: CSV, not Excel."],
    ]);
    // The builder reported back on the only task, so the planner closed the thread.
    expect((await getThread(db, w.thread.id)).status).toBe("done");
    expect(await openEscalations(db)).toEqual([]);
  });

  it("reads the live thread, not just what the line lets cross", async () => {
    const w = await setup("Should the export be CSV or Excel?");
    await w.startWork();

    const [input] = w.model.inputs;
    expect(input.thread.context).toEqual(PLAN);
    expect(input.askedBy).toBe("Builder");
    expect(input.history.map((m) => m.type)).toEqual(["task", "question"]);
    // The builder still only got the plan.
    expect(w.builderAdapter.received[0].context).toEqual({ plan: PLAN.plan });
  });
});

describe("escalating", () => {
  it("asks the user instead of guessing when the plan doesn't say", async () => {
    const w = await setup("Should we stream the file or build it in one go?");
    await w.startWork();

    // The builder's question is on the thread, but no answer went back.
    expect((await w.conversation()).map(([, type]) => type)).toEqual(["task", "question"]);
    const thread = await getThread(db, w.thread.id);
    expect([thread.status, thread.status_reason]).toEqual(["waiting_on_user", "agent_unsure"]);

    const [esc] = await openEscalations(db);
    expect(esc).toMatchObject({
      thread_id: w.thread.id, agent_id: w.planner.id, reason: "agent_unsure",
      question: "Should we stream the file or build it in one go?", summary: "The plan doesn't say.",
    });
    expect(await w.kinds()).toContain("escalation.raised");
  });

  it("escalates an answer it isn't confident in", async () => {
    const w = await setup("Should the export be CSV or Excel?");
    w.model.override = () => ({ action: "answer", answer: "Probably CSV?", confidence: 0.4 });
    await w.startWork();

    expect((await w.conversation()).map(([, type]) => type)).toEqual(["task", "question"]);
    const [esc] = await openEscalations(db);
    expect(esc.question).toBe("Should the export be CSV or Excel?");
    expect(esc.summary).toMatch(/wasn't sure enough/);
  });

  it("escalates when its model can't be reached, so the question isn't lost", async () => {
    const w = await setup("Should the export be CSV or Excel?");
    w.model.override = () => {
      throw new Error("connection refused");
    };
    await w.startWork();

    const [esc] = await openEscalations(db);
    expect(esc.question).toBe("Should the export be CSV or Excel?");
    expect(esc.summary).toMatch(/couldn't reach its model \(connection refused\)/);
  });

  it("doesn't nudge agents while the thread waits on the user", async () => {
    const w = await setup("Should we stream the file or build it in one go?");
    await w.startWork();
    w.clock.advance(3600);
    await w.router.checkTimeouts();
    expect(await w.kinds()).not.toContain("run.nudged");
  });
});

describe("after the user answers", () => {
  it("sends the answer to the agent that asked and resumes the thread", async () => {
    const w = await setup("Should we stream the file or build it in one go?");
    await w.startWork();
    const [esc] = await openEscalations(db);

    const res = await w.router.answerEscalation({ escalationId: esc.id, userId: w.ben.id, answer: "Stream it." });
    expect(res?.delivered).toBe(true);
    await w.router.idle();

    expect((await w.conversation()).slice(2)).toEqual([
      ["planner", "answer", "Stream it."],
      ["builder", "result", "Built it. Went with: Stream it."],
    ]);
    const thread = await getThread(db, w.thread.id);
    expect(thread.status).toBe("done");
    expect(thread.context.user_answers).toEqual([
      { question: "Should we stream the file or build it in one go?", answer: "Stream it." },
    ]);
    expect(await openEscalations(db)).toEqual([]);
    expect(await w.kinds()).toEqual(expect.arrayContaining(["escalation.answered", "context.updated", "thread.resumed"]));
  });

  it("uses that answer next time instead of asking again", async () => {
    const w = await setup("Should we stream the file or build it in one go?");
    await w.startWork();
    const [esc] = await openEscalations(db);
    await w.router.answerEscalation({ escalationId: esc.id, userId: w.ben.id, answer: "Stream it." });
    await w.router.idle();

    // Later on the same thread, the builder runs into the same question.
    await w.startWork();

    expect((await w.conversation()).slice(4)).toEqual([
      ["planner", "task", "Build the CSV export."],
      ["builder", "question", "Should we stream the file or build it in one go?"],
      ["planner", "answer", "Stream it."],
      ["builder", "result", "Built it. Went with: Stream it."],
    ]);
    expect(await openEscalations(db)).toEqual([]);
    expect((await w.kinds()).filter((k) => k === "escalation.raised")).toHaveLength(1);
    expect(w.model.inputs.at(-1)?.thread.context.user_answers).toHaveLength(1);
  });

  it("won't take a second answer to the same escalation", async () => {
    const w = await setup("Should we stream the file or build it in one go?");
    await w.startWork();
    const [esc] = await openEscalations(db);
    await w.router.answerEscalation({ escalationId: esc.id, userId: w.ben.id, answer: "Stream it." });
    await expect(
      w.router.answerEscalation({ escalationId: esc.id, userId: w.ben.id, answer: "One go." }),
    ).rejects.toThrow(/already been answered/);
    // Let the first answer's work finish, so it can't race the next test's reset.
    await w.router.idle();
  });

  it("resumes a thread paused for a reason with no one waiting on the answer", async () => {
    const ben = await createUser(db, { name: "Ben" });
    const router = new Router({ db, adapters: {} });
    const thread = await createThread(db, { title: "Paused thread" });
    await db.query(`UPDATE threads SET status = 'waiting_on_user', status_reason = 'loop_guard' WHERE id = $1`, [thread.id]);
    const { rows } = await db.query(
      `INSERT INTO escalations (thread_id, reason, summary) VALUES ($1, 'loop_guard', 'Paused at its limit') RETURNING id`,
      [thread.id],
    );

    expect(await router.answerEscalation({ escalationId: rows[0].id, userId: ben.id, answer: "Keep going" })).toBeNull();
    expect((await getThread(db, thread.id)).status).toBe("active");
  });
});

describe("the Claude model", () => {
  const input: PlannerInput = {
    thread: { title: "CSV export", goal: "Ship CSV export", context: { ...PLAN, user_answers: [{ question: "Stream?", answer: "Yes" }] } },
    history: [{ from: "Planner", to: "Builder", type: "task", body: "Build the CSV export." }],
    askedBy: "Builder",
    question: "Should we stream the file?",
  };

  it("gives the model the whole thread, the user's earlier answers and the question", () => {
    const text = renderInput(input);
    expect(text).toContain("Export format: CSV, not Excel.");
    expect(text).toContain('"answer": "Yes"');
    expect(text).toContain("Planner -> Builder [task]: Build the CSV export.");
    expect(text).toContain('<question from="Builder">\nShould we stream the file?\n</question>');
  });

  function fakeClient(reply: Record<string, unknown> | null, stop_reason = "end_turn") {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: { messages: { parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { stop_reason, parsed_output: reply };
      } } },
    } as unknown as Anthropic;
    return { client, calls };
  }

  it("turns the model's reply into an answer or an escalation", async () => {
    const answer = fakeClient({ action: "answer", answer: "Yes, stream it.", confidence: 0.9, question_for_user: "", reason: "user said so" });
    expect(await new ClaudePlannerModel({ client: answer.client }).decide(input))
      .toEqual({ action: "answer", answer: "Yes, stream it.", confidence: 0.9 });
    expect(answer.calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });

    const escalate = fakeClient({ action: "escalate", answer: "", confidence: 0, question_for_user: "Stream or not?", reason: "No decision on it" });
    expect(await new ClaudePlannerModel({ client: escalate.client }).decide(input))
      .toEqual({ action: "escalate", questionForUser: "Stream or not?", reason: "No decision on it" });
  });

  it("throws on a refusal or an unreadable reply, which the planner turns into an escalation", async () => {
    await expect(new ClaudePlannerModel({ client: fakeClient(null, "refusal").client }).decide(input)).rejects.toThrow(/declined/);
    await expect(new ClaudePlannerModel({ client: fakeClient(null, "max_tokens").client }).decide(input)).rejects.toThrow(/could not be read/);
  });
});
