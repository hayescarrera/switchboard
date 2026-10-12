// Creating and reading hub records. The router is the only thing that sends messages.

import type { Db } from "./db/pool.js";
import { logEvent } from "./events.js";
import {
  MESSAGE_TYPES,
  type Agent,
  type AgentCard,
  type AgentKind,
  type Escalation,
  type Line,
  type Message,
  type MessageType,
  type Run,
  type Thread,
  type ThreadContext,
  type User,
} from "./types.js";

export async function createUser(db: Db, input: { name: string; contact?: string }): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (name, contact) VALUES ($1, $2) RETURNING id, name, contact`,
    [input.name, input.contact ?? null],
  );
  return rows[0];
}

export async function createAgent(
  db: Db,
  input: {
    name: string;
    vendor: string;
    kind: AgentKind;
    adapter: string;
    ownerUserId: string;
    card?: AgentCard;
  },
): Promise<Agent> {
  const { rows } = await db.query(
    `INSERT INTO agents (name, vendor, kind, adapter, owner_user_id, card)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, vendor, kind, adapter, card, owner_user_id, status`,
    [input.name, input.vendor, input.kind, input.adapter, input.ownerUserId,
      input.card ?? { name: input.name }],
  );
  const agent = rows[0];
  await logEvent(db, { kind: "agent.created", at: new Date(), agentId: agent.id, data: { name: agent.name } });
  return agent;
}

/**
 * Draw a line. Each owner must accept it before it carries anything.
 * The user drawing it usually accepts in the same step (`acceptedBy`).
 */
export async function createLine(
  db: Db,
  input: {
    fromNode: string;
    toNode: string;
    owners: string[];
    acceptedBy?: string[];
    allowedTypes?: MessageType[];
    contextScope?: string[];
    enabled?: boolean;
  },
): Promise<Line> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO lines (from_node, to_node, allowed_types, context_scope, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, from_node, to_node, allowed_types, context_scope, enabled`,
      [input.fromNode, input.toNode, input.allowedTypes ?? [...MESSAGE_TYPES],
        input.contextScope ?? [], input.enabled ?? true],
    );
    const line: Line = rows[0];
    const accepted = new Set(input.acceptedBy ?? []);
    for (const owner of input.owners) {
      await client.query(
        `INSERT INTO line_owners (line_id, user_id, accepted_at) VALUES ($1, $2, $3)`,
        [line.id, owner, accepted.has(owner) ? new Date() : null],
      );
    }
    await logEvent(client, {
      kind: "line.created", at: new Date(), lineId: line.id,
      data: { from: line.from_node, to: line.to_node, owners: input.owners,
        allowed_types: line.allowed_types, context_scope: line.context_scope },
    });
    await client.query("COMMIT");
    return line;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function acceptLine(db: Db, lineId: string, userId: string): Promise<void> {
  const res = await db.query(
    `UPDATE line_owners SET accepted_at = now() WHERE line_id = $1 AND user_id = $2`,
    [lineId, userId],
  );
  if (res.rowCount === 0) throw new Error("That user does not own this line");
  await logEvent(db, { kind: "line.accepted", at: new Date(), lineId, data: { user_id: userId } });
}

export async function setLineEnabled(db: Db, lineId: string, enabled: boolean): Promise<void> {
  await db.query(`UPDATE lines SET enabled = $2 WHERE id = $1`, [lineId, enabled]);
  await logEvent(db, { kind: enabled ? "line.enabled" : "line.disabled", at: new Date(), lineId });
}

export async function createThread(
  db: Db,
  input: { title: string; goal?: string; context?: ThreadContext; origin?: string; maxMessages?: number },
): Promise<Thread> {
  const { rows } = await db.query(
    `INSERT INTO threads (title, goal, context, origin, max_messages)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.title, input.goal ?? "", input.context ?? {}, input.origin ?? null, input.maxMessages ?? 40],
  );
  const thread = rows[0];
  await logEvent(db, { kind: "thread.created", at: new Date(), threadId: thread.id, data: { title: thread.title } });
  return thread;
}

export async function getThread(db: Db, id: string): Promise<Thread> {
  const { rows } = await db.query(`SELECT * FROM threads WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error(`No thread ${id}`);
  return rows[0];
}

export async function messagesForThread(db: Db, threadId: string): Promise<Message[]> {
  const { rows } = await db.query(
    `SELECT * FROM messages WHERE thread_id = $1 ORDER BY seq`,
    [threadId],
  );
  return rows;
}

export async function runsForThread(db: Db, threadId: string): Promise<Run[]> {
  const { rows } = await db.query(`SELECT * FROM runs WHERE thread_id = $1 ORDER BY created_at`, [threadId]);
  return rows;
}

/** The escalation half of the user's waiting-on-you list, newest first. */
export async function openEscalations(db: Db, threadId?: string): Promise<Escalation[]> {
  const { rows } = await db.query(
    `SELECT * FROM escalations WHERE status = 'open' AND ($1::uuid IS NULL OR thread_id = $1)
     ORDER BY created_at DESC`,
    [threadId ?? null],
  );
  return rows;
}
