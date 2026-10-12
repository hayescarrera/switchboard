// The hub's own Claude agent: the planner (CLAUDE.md section 6.3, item 1).
//
// It holds no state of its own. Every time another agent asks it something, it
// reads the live thread (goal, plan, decisions, constraints, the user's earlier
// answers, recent messages) and either answers or escalates to the user. It
// escalates when its model says so, when its model's confidence is below the
// bar, or when the model can't be reached, so the asking agent is never left
// with a guess or with silence.
//
// The user's answer to an escalation is handled by the router
// (`answerEscalation`): it lands in the thread's `user_answers`, which the
// planner reads on every later question, so it doesn't ask again.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/pool.js";
import type { PlannerInput, PlannerModel } from "../planner/model.js";
import { getThread } from "../store.js";
import type { AgentCard, MessageType, Thread } from "../types.js";
import type { Adapter, AdapterEvent, Delivery, RunRef } from "./adapter.js";

export interface PlannerOptions {
  db: Db;
  model: PlannerModel;
  /** Answers below this confidence go to the user instead. */
  minConfidence?: number;
  /** How many recent thread messages the model sees. */
  historyLimit?: number;
}

export class PlannerAdapter implements Adapter {
  private readonly db: Db;
  private readonly model: PlannerModel;
  private readonly minConfidence: number;
  private readonly historyLimit: number;
  private readonly runs = new Map<string, { work: Promise<AdapterEvent[]>; cancelled: boolean }>();

  constructor(opts: PlannerOptions) {
    this.db = opts.db;
    this.model = opts.model;
    this.minConfidence = opts.minConfidence ?? 0.7;
    this.historyLimit = opts.historyLimit ?? 30;
  }

  describe(): AgentCard {
    return {
      name: "Planner",
      description: "Answers other agents' questions from the plan, and asks you when it isn't sure.",
      skills: [{ id: "answer_questions", name: "Answer questions about the plan" }],
    };
  }

  async send(thread: Thread, delivery: Delivery): Promise<RunRef> {
    const externalRef = `planner-${randomUUID()}`;
    // Only questions need the planner to act. Status, results and answers sent
    // to it are already on the thread, which is all the planner reads.
    const work = delivery.type === "question" ? this.handleQuestion(thread.id, delivery) : Promise.resolve([]);
    this.runs.set(externalRef, { work, cancelled: false });
    return { externalRef };
  }

  async followUp(): Promise<void> {
    // Each run is one question and one decision; there is nothing to steer mid-run.
  }

  async *events(ref: RunRef): AsyncIterable<AdapterEvent> {
    const run = this.runs.get(ref.externalRef);
    if (!run) return;
    const events = await run.work;
    this.runs.delete(ref.externalRef);
    if (run.cancelled) return;
    yield* events;
  }

  async cancel(ref: RunRef): Promise<void> {
    const run = this.runs.get(ref.externalRef);
    if (run) run.cancelled = true;
  }

  private async handleQuestion(threadId: string, delivery: Delivery): Promise<AdapterEvent[]> {
    const input = await this.readThread(threadId, delivery);
    let decision;
    try {
      decision = await this.model.decide(input);
    } catch (err) {
      return [{
        kind: "escalate",
        body: delivery.body,
        summary: `The planner couldn't reach its model (${(err as Error).message}), so this question needs you.`,
      }];
    }

    if (decision.action === "answer" && decision.confidence >= this.minConfidence && decision.answer.trim()) {
      return [{ kind: "answer", body: decision.answer }];
    }
    if (decision.action === "answer") {
      return [{
        kind: "escalate",
        body: delivery.body,
        summary: `The planner wasn't sure enough to answer (confidence ${decision.confidence}).`,
      }];
    }
    return [{
      kind: "escalate",
      body: decision.questionForUser.trim() || delivery.body,
      summary: decision.reason,
    }];
  }

  /** The live thread: hub-run agents never work from a stale copy. */
  private async readThread(threadId: string, delivery: Delivery): Promise<PlannerInput> {
    const thread = await getThread(this.db, threadId);
    const { rows } = await this.db.query<{ from: string; to: string; type: MessageType; body: string }>(
      `SELECT * FROM (
         SELECT f.name AS "from", t.name AS "to", m.type, m.body, m.seq
         FROM messages m JOIN agents f ON f.id = m.from_agent JOIN agents t ON t.id = m.to_agent
         WHERE m.thread_id = $1 ORDER BY m.seq DESC LIMIT $2
       ) recent ORDER BY seq`,
      [threadId, this.historyLimit],
    );
    const asker = await this.db.query<{ name: string }>(`SELECT name FROM agents WHERE id = $1`, [delivery.fromAgentId]);
    return {
      thread: { title: thread.title, goal: thread.goal, context: thread.context },
      history: rows.map(({ from, to, type, body }) => ({ from, to, type, body })),
      askedBy: asker.rows[0]?.name ?? "another agent",
      question: delivery.body,
    };
  }
}
