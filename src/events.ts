// The append-only event log. Every message, action and permission check lands here.

import type pg from "pg";
import type { HubEvent } from "./types.js";

type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

export interface EventInput {
  kind: string;
  at: Date;
  threadId?: string | null;
  agentId?: string | null;
  lineId?: string | null;
  runId?: string | null;
  messageId?: string | null;
  data?: Record<string, unknown>;
}

export async function logEvent(db: Queryable, e: EventInput): Promise<void> {
  await db.query(
    `INSERT INTO events (at, kind, thread_id, agent_id, line_id, run_id, message_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.at, e.kind, e.threadId ?? null, e.agentId ?? null, e.lineId ?? null, e.runId ?? null,
      e.messageId ?? null, e.data ?? {}],
  );
}

export async function eventsForThread(db: Queryable, threadId: string): Promise<HubEvent[]> {
  const { rows } = await db.query(
    `SELECT id::text, at, kind, thread_id, agent_id, line_id, run_id, message_id, data
     FROM events WHERE thread_id = $1 ORDER BY events.id`,
    [threadId],
  );
  return rows;
}
