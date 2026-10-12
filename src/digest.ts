// Plain-language accounts of what happened on the hub, read from the event log.
// Used for the "since you last checked" digest on every connector response
// (CLAUDE.md 6.4) and for the board's live captions.

import type { Db } from "./db/pool.js";

export interface Happening {
  id: string;
  at: Date;
  kind: string;
  threadId: string | null;
  threadTitle: string | null;
  lineId: string | null;
  from: string | null;
  to: string | null;
  /** One line a person can read. */
  text: string;
}

const KINDS = ["message.delivered", "message.rejected", "escalation.raised", "escalation.answered", "thread.done",
  "thread.reopened", "run.error", "run.timed_out", "run.nudged"];

const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Everything readable after event `afterId`, oldest first. */
export async function happeningsSince(db: Db, afterId: string | number, upTo?: string | number, limit = 200): Promise<Happening[]> {
  const { rows } = await db.query(
    `SELECT e.id::text, e.at, e.kind, e.thread_id, e.data, e.line_id, t.title AS thread_title,
            m.type AS m_type, m.body AS m_body, m.attachments AS m_attachments,
            mf.name AS m_from, mt.name AS m_to, mf.adapter AS m_from_adapter, a.name AS agent_name
     FROM events e
       LEFT JOIN threads t ON t.id = e.thread_id
       LEFT JOIN messages m ON m.id = e.message_id
       LEFT JOIN agents mf ON mf.id = m.from_agent
       LEFT JOIN agents mt ON mt.id = m.to_agent
       LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.id > $1 AND ($4::bigint IS NULL OR e.id <= $4) AND e.kind = ANY($2)
     ORDER BY e.id LIMIT $3`,
    [afterId, KINDS, limit, upTo ?? null],
  );
  const out: Happening[] = [];
  for (const r of rows) {
    const text = describe(r);
    if (!text) continue;
    out.push({
      id: r.id, at: r.at, kind: r.kind, threadId: r.thread_id, threadTitle: r.thread_title, lineId: r.line_id,
      from: r.m_from ?? null, to: r.m_to ?? null, text,
    });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(r: any): string | null {
  const d = r.data ?? {};
  switch (r.kind) {
    case "message.delivered": {
      const body = clip(r.m_body ?? "");
      const userAnswer = (r.m_attachments ?? []).some((a: { kind?: string }) => a.kind === "user_answer");
      switch (r.m_type) {
        case "task": return r.m_from_adapter === "chat"
          ? `You handed the Planner: ${body}` : `${r.m_from} handed ${r.m_to} a task: ${body}`;
        case "question": return `${r.m_from} asked ${r.m_to}: ${body}`;
        case "answer": return userAnswer
          ? `${r.m_from} passed your answer to ${r.m_to}: ${body}`
          : `${r.m_from} answered ${r.m_to} without you: ${body}`;
        case "result": return `${r.m_from} delivered to ${r.m_to}: ${body}`;
        default: return r.m_from_adapter === "chat" ? `You added a note: ${body}` : `${r.m_from} to ${r.m_to}: ${body}`;
      }
    }
    case "message.rejected": return `A message was blocked: ${d.detail}`;
    case "escalation.raised":
      return `Waiting on you: ${d.question ?? d.summary} (${d.summary}) [question id ${d.escalation_id}]`;
    case "escalation.answered": return `You answered: ${clip(String(d.answer ?? ""))}`;
    case "thread.done": return `Done. ${d.body ?? ""}`.trim();
    case "thread.reopened": return "Picked back up with new work.";
    case "run.error": return `${r.agent_name ?? "An agent"} hit a problem: ${clip(String(d.error ?? ""))}`;
    case "run.timed_out": return `${r.agent_name ?? "An agent"} stopped responding, even after a nudge.`;
    case "run.nudged": return `${r.agent_name ?? "An agent"} went quiet, so the hub nudged it.`;
    default: return null;
  }
}

/** The digest text: one line per happening, grouped under each thread's title. */
export function renderDigest(items: Happening[]): string {
  if (items.length === 0) return "Nothing new.";
  const lines: string[] = [];
  let thread: string | null | undefined;
  for (const h of items) {
    if (h.threadId !== thread) {
      thread = h.threadId;
      lines.push(`Thread "${h.threadTitle ?? "?"}" (id ${h.threadId}):`);
    }
    lines.push(`- ${h.text}`);
  }
  return lines.join("\n");
}

export async function getCursor(db: Db, client: string): Promise<string> {
  const { rows } = await db.query(`SELECT last_event_id::text FROM chat_cursors WHERE client = $1`, [client]);
  return rows[0]?.last_event_id ?? "0";
}

export async function setCursor(db: Db, client: string, lastEventId: string): Promise<void> {
  await db.query(
    `INSERT INTO chat_cursors (client, last_event_id, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (client) DO UPDATE SET last_event_id = GREATEST(chat_cursors.last_event_id, $2), updated_at = now()`,
    [client, lastEventId],
  );
}

/** The newest event id, for moving a cursor past everything (including events the digest skips). */
export async function latestEventId(db: Db): Promise<string> {
  const { rows } = await db.query(`SELECT coalesce(max(id), 0)::text AS id FROM events`);
  return rows[0].id;
}
