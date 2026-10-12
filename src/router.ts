// The router: the heart of the hub (CLAUDE.md section 6.2).
//
// Every message goes through `send` (or, for a receiver's replies, through the
// run that carried the original message). For each one the router:
//   1. checks the Line between sender and receiver (deny by default),
//   2. applies the loop guard,
//   3. strips the thread context down to what the line lets cross,
//   4. records the Message and delivers it through the receiver's adapter as a Run,
//   5. turns the adapter's events back into Messages on the thread.
// Every step is written to the append-only event log.
//
// Replies travel back along the line the original message came in on, so a
// line from A to B also lets B answer, ask a question back, report status and
// send a result to A. Only A can start new work (`task`) over it.
//
// When an agent can't go on without the user (the planner is unsure, the loop
// guard trips, a run stalls), the thread is escalated: paused, with an open
// escalation on the user's waiting-on-you list. `answerEscalation` writes the
// user's answer into the thread's shared context, resumes the thread, and sends
// the answer to whoever was waiting on it.

import type pg from "pg";
import type { Adapter, AdapterEvent, RunRef } from "./adapters/adapter.js";
import type { Db } from "./db/pool.js";
import { logEvent } from "./events.js";
import {
  REPLY_TYPES,
  type Agent,
  type Escalation,
  type Line,
  type Message,
  type MessageType,
  type Run,
  type Thread,
  type ThreadContext,
} from "./types.js";

export type DenyReason =
  | "unknown_agent"
  | "agent_disabled"
  | "no_adapter"
  | "thread_not_active"
  | "no_line"
  | "line_disabled"
  | "line_not_accepted"
  | "type_not_allowed"
  | "loop_guard";

export type SendResult =
  | { delivered: true; message: Message; runId: string }
  | { delivered: false; reason: DenyReason; detail: string };

export interface SendInput {
  threadId: string;
  from: string;
  to: string;
  type: MessageType;
  body: string;
  /** Extra context from the sender. Merged over the thread's context, then scoped. */
  context?: ThreadContext;
  /** How long the receiver may go quiet before it is nudged. */
  timeoutSeconds?: number;
}

export interface RouterOptions {
  db: Db;
  /** Adapter implementations, keyed by the `adapter` name stored on each agent. */
  adapters: Record<string, Adapter>;
  /** Injectable clock, so tests can move time forward. */
  clock?: () => Date;
  defaultTimeoutSeconds?: number;
  nudgeText?: string;
}

const EVENT_TO_MESSAGE: Record<Exclude<AdapterEvent["kind"], "error" | "escalate">, MessageType> = {
  progress: "status",
  question: "question",
  answer: "answer",
  result: "result",
};

class Denied extends Error {
  constructor(readonly reason: DenyReason, readonly detail: string) {
    super(detail);
  }
}

export interface AnswerEscalationInput {
  escalationId: string;
  userId: string;
  answer: string;
}

export class Router {
  private readonly db: Db;
  private readonly adapters: Record<string, Adapter>;
  private readonly clock: () => Date;
  private readonly defaultTimeoutSeconds: number;
  private readonly nudgeText: string;
  private readonly pumps = new Set<Promise<void>>();

  constructor(opts: RouterOptions) {
    this.db = opts.db;
    this.adapters = opts.adapters;
    this.clock = opts.clock ?? (() => new Date());
    this.defaultTimeoutSeconds = opts.defaultTimeoutSeconds ?? 900;
    this.nudgeText = opts.nudgeText ?? "Checking in: this thread is waiting on you. Where are you on it?";
  }

  /** An agent sends a message to another agent. Needs a line from sender to receiver. */
  send(input: SendInput): Promise<SendResult> {
    return this.deliver(input, null);
  }

  /** Resolves once every adapter event stream the router is reading has finished. */
  async idle(): Promise<void> {
    while (this.pumps.size > 0) await Promise.all([...this.pumps]);
  }

  /**
   * Chase runs that have gone quiet past their timeout. The first time, the
   * agent is nudged. If it is still quiet after another timeout, the run is
   * stopped and the thread is escalated to the user.
   * Call this on a timer; in production every few seconds.
   */
  async checkTimeouts(): Promise<void> {
    const now = this.clock();
    const { rows } = await this.db.query<Run & { adapter: string }>(
      `SELECT r.*, a.adapter FROM runs r
         JOIN agents a ON a.id = r.agent_id
         JOIN threads t ON t.id = r.thread_id
       WHERE r.state = 'running'
         AND t.status = 'active'   -- a paused thread is waiting on the user, not on its agents
         AND r.last_event_at + make_interval(secs => r.timeout_seconds) <= $1`,
      [now],
    );
    for (const run of rows) {
      const adapter = this.adapters[run.adapter];
      const ref: RunRef = { externalRef: run.external_ref ?? "" };
      const ids = { threadId: run.thread_id, agentId: run.agent_id, runId: run.id };

      if (!run.nudged_at) {
        await adapter?.followUp(ref, this.nudgeText);
        await this.db.query(`UPDATE runs SET nudged_at = $2, last_event_at = $2 WHERE id = $1`, [run.id, now]);
        await logEvent(this.db, { kind: "run.nudged", at: now, ...ids, data: { body: this.nudgeText } });
        continue;
      }

      const stopped = await this.db.query(
        `UPDATE runs SET state = 'timed_out' WHERE id = $1 AND state = 'running'`,
        [run.id],
      );
      if (stopped.rowCount === 0) continue;
      await logEvent(this.db, {
        kind: "run.timed_out", at: now, ...ids,
        data: { timeout_seconds: run.timeout_seconds, nudged_at: run.nudged_at },
      });
      await adapter?.cancel(ref);
      await this.escalate(this.db, {
        threadId: run.thread_id, reason: "run_timed_out",
        summary: "An agent stopped responding, even after a nudge.", runId: run.id, agentId: run.agent_id,
      });
    }
  }

  /**
   * The user answers an escalation. The answer is written into the thread's
   * shared context (so the planner never asks it again), the thread resumes, and
   * if a run was waiting on it, the answer goes to whoever asked, from the agent
   * that escalated, along the same line.
   */
  async answerEscalation(input: AnswerEscalationInput): Promise<SendResult | null> {
    const at = this.clock();
    const client = await this.db.connect();
    let esc: Escalation;
    try {
      await client.query("BEGIN");
      const found = await client.query<Escalation>(
        `SELECT * FROM escalations WHERE id = $1 FOR UPDATE`, [input.escalationId]);
      esc = found.rows[0];
      if (!esc) throw new Error(`No escalation ${input.escalationId}`);
      if (esc.status !== "open") throw new Error("That escalation has already been answered");
      const thread = await lockThread(client, esc.thread_id);

      await client.query(
        `UPDATE escalations SET status = 'answered', answer = $2, answered_by = $3, answered_at = $4 WHERE id = $1`,
        [esc.id, input.answer, input.userId, at],
      );
      const userAnswers = [...(thread.context.user_answers ?? []),
        { question: esc.question ?? esc.summary, answer: input.answer }];
      await client.query(
        `UPDATE threads SET context = context || jsonb_build_object('user_answers', $2::jsonb) WHERE id = $1`,
        [thread.id, JSON.stringify(userAnswers)],
      );
      const ids = { threadId: thread.id, runId: esc.run_id };
      await logEvent(client, {
        kind: "escalation.answered", at, ...ids,
        data: { escalation_id: esc.id, user_id: input.userId, question: esc.question, answer: input.answer },
      });
      await logEvent(client, { kind: "context.updated", at, ...ids, data: { field: "user_answers", added: 1 } });

      // Resume once nothing else on the thread is waiting on the user.
      const stillOpen = await client.query(
        `SELECT 1 FROM escalations WHERE thread_id = $1 AND status = 'open'`, [thread.id]);
      if (stillOpen.rowCount === 0) {
        await client.query(`UPDATE threads SET status = 'active', status_reason = NULL WHERE id = $1`, [thread.id]);
        // Time spent waiting on the user doesn't count against the agents' timeouts.
        await client.query(
          `UPDATE runs SET last_event_at = $2 WHERE thread_id = $1 AND state = 'running'`, [thread.id, at]);
        await logEvent(client, { kind: "thread.resumed", at, threadId: thread.id });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (!esc.run_id) return null;
    const { rows } = await this.db.query<Run>(`SELECT * FROM runs WHERE id = $1`, [esc.run_id]);
    const run = rows[0];
    return this.deliver(
      { threadId: run.thread_id, from: run.agent_id, to: run.requester_id, type: "answer", body: input.answer },
      run,
    );
  }

  // ---------------------------------------------------------------------------

  /** `replyOn` is the run whose receiver is answering; null for a fresh send. */
  private async deliver(input: SendInput, replyOn: Run | null): Promise<SendResult> {
    const at = this.clock();
    const client = await this.db.connect();
    let delivered: { message: Message; thread: Thread; line: Line; receiver: Agent };
    try {
      await client.query("BEGIN");
      const thread = await lockThread(client, input.threadId);
      const base = { threadId: input.threadId, agentId: input.from };
      await logEvent(client, {
        kind: "message.received", at, ...base,
        data: { from: input.from, to: input.to, type: input.type, reply_to_run: replyOn?.id ?? null },
      });

      try {
        delivered = await this.checkAndRecord(client, at, thread, input, replyOn);
      } catch (err) {
        if (!(err instanceof Denied)) throw err;
        await logEvent(client, {
          kind: "message.rejected", at, ...base,
          data: { reason: err.reason, detail: err.detail, to: input.to, type: input.type },
        });
        await client.query("COMMIT");
        return { delivered: false, reason: err.reason, detail: err.detail };
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const runId = await this.startRun(delivered, input);
    return { delivered: true, message: delivered.message, runId };
  }

  private async checkAndRecord(
    client: pg.PoolClient,
    at: Date,
    thread: Thread,
    input: SendInput,
    replyOn: Run | null,
  ) {
    const ids = { threadId: thread.id, agentId: input.from };
    const sender = await getAgent(client, input.from);
    const receiver = await getAgent(client, input.to);
    if (!sender || !receiver) throw new Denied("unknown_agent", "Sender or receiver is not a known agent.");
    if (sender.status !== "active" || receiver.status !== "active") {
      throw new Denied("agent_disabled", "Sender or receiver is disabled.");
    }
    if (!this.adapters[receiver.adapter]) {
      throw new Denied("no_adapter", `No adapter named "${receiver.adapter}" is running.`);
    }
    if (thread.status !== "active") {
      throw new Denied("thread_not_active", `Thread is ${thread.status} (${thread.status_reason ?? "no reason"}).`);
    }

    // The line check. Deny by default.
    const check = await this.checkLine(client, input, replyOn);
    await logEvent(client, {
      kind: "line.checked", at, ...ids, lineId: check.line?.id ?? null,
      data: { allowed: check.ok, reason: check.ok ? null : check.reason, from: input.from, to: input.to, type: input.type },
    });
    if (!check.ok) throw new Denied(check.reason, check.detail);
    const line = check.line;

    // Loop guard: past the thread's message limit, pause and pull the user in.
    if (thread.message_count >= thread.max_messages) {
      await logEvent(client, {
        kind: "loop_guard.tripped", at, ...ids,
        data: { message_count: thread.message_count, max_messages: thread.max_messages },
      });
      await this.escalate(client, {
        threadId: thread.id, reason: "loop_guard",
        summary: `This thread reached its limit of ${thread.max_messages} messages, so it was paused.`,
      });
      throw new Denied("loop_guard", `Thread hit its ${thread.max_messages}-message limit and is paused.`);
    }

    // Only the fields this line allows cross it.
    const full: ThreadContext = { ...thread.context, ...(input.context ?? {}) };
    const scoped: ThreadContext = {};
    for (const field of line.context_scope) if (field in full) scoped[field] = full[field];
    const withheld = Object.keys(full).filter((f) => !(f in scoped));
    await logEvent(client, {
      kind: "context.scoped", at, ...ids, lineId: line.id,
      data: { sent: Object.keys(scoped), withheld },
    });

    const { rows } = await client.query<Message>(
      `INSERT INTO messages (thread_id, line_id, from_agent, to_agent, type, body, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [thread.id, line.id, input.from, input.to, input.type, input.body, scoped],
    );
    const message = rows[0];
    await client.query(
      `UPDATE threads SET message_count = message_count + 1,
         participants = ARRAY(SELECT DISTINCT unnest(participants || $2::uuid[]))
       WHERE id = $1`,
      [thread.id, [input.from, input.to]],
    );
    await logEvent(client, {
      kind: "message.delivered", at, ...ids, lineId: line.id, messageId: message.id,
      data: { from: input.from, to: input.to, type: input.type },
    });
    return { message, thread, line, receiver };
  }

  private async checkLine(
    client: pg.PoolClient,
    input: SendInput,
    replyOn: Run | null,
  ): Promise<{ ok: true; line: Line } | { ok: false; line: Line | null; reason: DenyReason; detail: string }> {
    const lines: (Line & { owners: number; accepted: number })[] = (
      await client.query(
        `SELECT l.*, count(o.user_id)::int AS owners, count(o.accepted_at)::int AS accepted
         FROM lines l LEFT JOIN line_owners o ON o.line_id = l.id
         WHERE ${replyOn ? "l.id = $1" : "l.from_node = $1 AND l.to_node = $2"}
         GROUP BY l.id ORDER BY l.created_at`,
        replyOn ? [replyOn.line_id] : [input.from, input.to],
      )
    ).rows;

    if (lines.length === 0) {
      return { ok: false, line: null, reason: "no_line", detail: "No line connects these agents." };
    }
    let firstFailure: { ok: false; line: Line; reason: DenyReason; detail: string } | null = null;
    for (const line of lines) {
      const isReverse = line.to_node === input.from;
      let failure: { reason: DenyReason; detail: string } | null = null;
      if (!line.enabled) {
        failure = { reason: "line_disabled", detail: "The line is switched off." };
      } else if (line.owners === 0 || line.accepted < line.owners) {
        failure = { reason: "line_not_accepted", detail: "Not every owner has accepted this line." };
      } else if (!line.allowed_types.includes(input.type)) {
        failure = { reason: "type_not_allowed", detail: `The line does not allow "${input.type}" messages.` };
      } else if (isReverse && !REPLY_TYPES.includes(input.type)) {
        failure = { reason: "type_not_allowed", detail: `Replies cannot be "${input.type}" messages.` };
      }
      if (!failure) return { ok: true, line };
      firstFailure ??= { ok: false, line, ...failure };
    }
    return firstFailure!;
  }

  private async startRun(
    d: { message: Message; thread: Thread; line: Line; receiver: Agent },
    input: SendInput,
  ): Promise<string> {
    const adapter = this.adapters[d.receiver.adapter];
    const now = this.clock();
    const { rows } = await this.db.query<Run>(
      `INSERT INTO runs (agent_id, thread_id, line_id, requester_id, last_event_at, timeout_seconds)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [d.receiver.id, d.thread.id, d.line.id, input.from, now, input.timeoutSeconds ?? this.defaultTimeoutSeconds],
    );
    const run = rows[0];
    const ids = { threadId: run.thread_id, agentId: run.agent_id, runId: run.id, messageId: d.message.id };

    let ref: RunRef;
    try {
      ref = await adapter.send(d.thread, {
        messageId: d.message.id,
        type: d.message.type,
        body: d.message.body,
        context: d.message.context,
        fromAgentId: d.message.from_agent,
        toAgentId: d.message.to_agent,
      });
    } catch (err) {
      await this.db.query(`UPDATE runs SET state = 'error' WHERE id = $1`, [run.id]);
      await logEvent(this.db, { kind: "run.error", at: this.clock(), ...ids, data: { error: String(err) } });
      return run.id;
    }
    await this.db.query(`UPDATE runs SET external_ref = $2 WHERE id = $1`, [run.id, ref.externalRef]);
    run.external_ref = ref.externalRef;
    await logEvent(this.db, { kind: "run.started", at: now, ...ids, data: { external_ref: ref.externalRef } });

    const pump = this.pump(run, adapter, ref)
      .catch((err) => logEvent(this.db, { kind: "run.error", at: this.clock(), ...ids, data: { error: String(err) } }))
      .finally(() => this.pumps.delete(pump));
    this.pumps.add(pump);
    return run.id;
  }

  /** Turn what an adapter reports into messages back on the thread. */
  private async pump(run: Run, adapter: Adapter, ref: RunRef): Promise<void> {
    const ids = { threadId: run.thread_id, agentId: run.agent_id, runId: run.id };
    for await (const event of adapter.events(ref)) {
      const now = this.clock();
      const live = await this.db.query(
        `UPDATE runs SET last_event_at = $2 WHERE id = $1 AND state = 'running'`,
        [run.id, now],
      );
      if (live.rowCount === 0) return; // stopped (timed out or cancelled) while we waited
      await logEvent(this.db, { kind: "run.event", at: now, ...ids, data: { kind: event.kind, body: event.body } });

      if (event.kind === "escalate") {
        await this.escalate(this.db, {
          threadId: run.thread_id, reason: "agent_unsure", summary: event.summary,
          question: event.body, runId: run.id, agentId: run.agent_id,
        });
        continue;
      }
      if (event.kind === "error") {
        await this.db.query(`UPDATE runs SET state = 'error' WHERE id = $1`, [run.id]);
        await logEvent(this.db, { kind: "run.error", at: now, ...ids, data: { error: event.body } });
        return;
      }
      await this.deliver(
        { threadId: run.thread_id, from: run.agent_id, to: run.requester_id,
          type: EVENT_TO_MESSAGE[event.kind], body: event.body },
        run,
      );
    }
    const done = await this.db.query(
      `UPDATE runs SET state = 'done' WHERE id = $1 AND state = 'running'`,
      [run.id],
    );
    if (done.rowCount) await logEvent(this.db, { kind: "run.finished", at: this.clock(), ...ids });
  }

  /** Pause the thread and put it on the user's waiting-on-you list. */
  private async escalate(
    db: Pick<pg.Pool, "query"> | pg.PoolClient,
    e: { threadId: string; reason: string; summary: string; question?: string; runId?: string; agentId?: string },
  ): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO escalations (thread_id, run_id, agent_id, reason, summary, question)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [e.threadId, e.runId ?? null, e.agentId ?? null, e.reason, e.summary, e.question ?? null],
    );
    await db.query(
      `UPDATE threads SET status = 'waiting_on_user', status_reason = $2 WHERE id = $1`,
      [e.threadId, e.reason],
    );
    await logEvent(db, {
      kind: "escalation.raised", at: this.clock(), threadId: e.threadId, agentId: e.agentId, runId: e.runId,
      data: { escalation_id: rows[0].id, reason: e.reason, summary: e.summary, question: e.question ?? null,
        run_id: e.runId ?? null },
    });
  }
}

async function lockThread(client: pg.PoolClient, id: string): Promise<Thread> {
  const { rows } = await client.query<Thread>(`SELECT * FROM threads WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new Error(`No thread ${id}`);
  return rows[0];
}

async function getAgent(client: pg.PoolClient, id: string): Promise<Agent | undefined> {
  const { rows } = await client.query<Agent>(`SELECT * FROM agents WHERE id = $1`, [id]);
  return rows[0];
}
