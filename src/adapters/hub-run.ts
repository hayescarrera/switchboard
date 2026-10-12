// A hub-run worker agent (CLAUDE.md 4.1, "Hub-run agent"): Grok, ChatGPT or any
// vendor with a model API but no agent API. The hub runs the agent itself.
//
// Like the planner it keeps no state of its own. On a task it works from what
// the line let cross; on an answer it re-reads its own exchange on the thread
// (the task, its questions, the answers) and carries on. Each delivery is one
// short run: it either asks the planner a question or delivers a result.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/pool.js";
import type { WorkerInput, WorkerModel } from "../workers/model.js";
import type { AgentCard, Message, Thread } from "../types.js";
import type { Adapter, AdapterEvent, Delivery, RunRef } from "./adapter.js";

export interface HubRunOptions {
  db: Db;
  model: WorkerModel;
  name: string;
  /** What kind of work it does, e.g. "Research". */
  role: string;
  /** Questions it may ask per task before it has to deliver. */
  maxQuestions?: number;
}

export class HubRunAdapter implements Adapter {
  private readonly runs = new Map<string, Promise<AdapterEvent[]>>();
  private readonly maxQuestions: number;

  constructor(private readonly opts: HubRunOptions) {
    this.maxQuestions = opts.maxQuestions ?? 2;
  }

  describe(): AgentCard {
    return {
      name: this.opts.name,
      description: `${this.opts.role}, run by the hub on ${this.opts.model.label}.`,
      skills: [{ id: this.opts.role.toLowerCase(), name: this.opts.role }],
    };
  }

  async send(thread: Thread, delivery: Delivery): Promise<RunRef> {
    const externalRef = `${this.opts.name.toLowerCase()}-${randomUUID()}`;
    const work = delivery.type === "task" || delivery.type === "answer" ? this.work(thread, delivery) : Promise.resolve([]);
    this.runs.set(externalRef, work);
    return { externalRef };
  }

  async followUp(): Promise<void> {
    // Each run is one model call; a nudge has nothing to steer.
  }

  async *events(ref: RunRef): AsyncIterable<AdapterEvent> {
    const work = this.runs.get(ref.externalRef);
    if (!work) return;
    const events = await work;
    if (!this.runs.delete(ref.externalRef)) return; // cancelled meanwhile
    yield* events;
  }

  async cancel(ref: RunRef): Promise<void> {
    this.runs.delete(ref.externalRef);
  }

  private async work(thread: Thread, delivery: Delivery): Promise<AdapterEvent[]> {
    const exchange = await this.exchange(thread.id, delivery);
    if (!exchange) return [{ kind: "error", body: "Got an answer, but there's no task on this thread to apply it to." }];
    const questionsAsked = exchange.messages.filter((m) => m.type === "question").length;
    const input: WorkerInput = {
      agent: { name: this.opts.name, role: this.opts.role },
      goal: thread.goal,
      context: exchange.context,
      // Its own questions show as "you"; everything else came from the planner.
      conversation: exchange.messages.map((m) => ({
        from: m.from_agent === delivery.toAgentId ? "you" : "planner",
        type: m.type,
        body: m.body,
      })),
      questionsLeft: Math.max(0, this.maxQuestions - questionsAsked),
    };

    let reply;
    try {
      reply = await this.opts.model.respond(input);
    } catch (err) {
      return [{ kind: "error", body: (err as Error).message }];
    }
    if (reply.action === "question" && input.questionsLeft === 0) {
      return [{ kind: "error", body: `Kept asking questions past its limit of ${this.maxQuestions}.` }];
    }
    return [{ kind: reply.action, body: reply.body }];
  }

  /**
   * This agent's exchange with whoever gave it the work: the latest task sent to
   * it on this thread and everything between the two since. The task message
   * carries the context its line let cross.
   */
  private async exchange(threadId: string, delivery: Delivery): Promise<{ context: Delivery["context"]; messages: Message[] } | null> {
    if (delivery.type === "task") {
      return {
        context: delivery.context,
        messages: [{ type: "task", body: delivery.body, from_agent: delivery.fromAgentId, attachments: [] } as unknown as Message],
      };
    }
    const me = delivery.toAgentId;
    const other = delivery.fromAgentId;
    const { rows } = await this.opts.db.query<Message>(
      `SELECT * FROM messages
       WHERE thread_id = $1
         AND ((from_agent = $2 AND to_agent = $3) OR (from_agent = $3 AND to_agent = $2))
         AND seq >= (SELECT max(seq) FROM messages WHERE thread_id = $1 AND to_agent = $2 AND from_agent = $3 AND type = 'task')
       ORDER BY seq`,
      [threadId, me, other],
    );
    if (rows.length === 0) return null;
    return { context: rows[0].context, messages: rows };
  }
}
