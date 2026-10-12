// What the read-only board shows (CLAUDE.md 6.6): the agents and lines, each
// agent's status, the waiting-on-you list, one thread's conversation, and the
// self-answered numbers. All of it read live from the hub's tables.

import type { Hub } from "../hub.js";
import { openEscalations } from "../store.js";
import type { Line, Message, Thread } from "../types.js";

export interface BoardState {
  owner: string;
  agents: { id: string; name: string; sub: string; column: number; model: string | null; status: "idle" | "working" | "waiting" | "done"; statusText: string }[];
  lines: { id: string; from: string; to: string; label: string; enabled: boolean }[];
  threads: { id: string; title: string; status: Thread["status"] }[];
  thread: { id: string; title: string; status: Thread["status"]; feed: { from: string; to: string; type: string; body: string; tag: "self" | "you" | null }[] } | null;
  waiting: { id: string; thread: string; question: string; summary: string }[];
  stats: { answeredWithoutYou: number; youWereNeeded: number };
}

export async function boardState(hub: Hub, threadId?: string): Promise<BoardState> {
  const { db } = hub;
  const agents = (await db.query(`SELECT * FROM agents WHERE owner_user_id = $1 ORDER BY created_at`, [hub.user.id])).rows;
  const lines = (await db.query<Line & { owners: number; accepted: number }>(
    `SELECT l.*, count(o.user_id)::int AS owners, count(o.accepted_at)::int AS accepted
     FROM lines l LEFT JOIN line_owners o ON o.line_id = l.id GROUP BY l.id ORDER BY l.created_at`)).rows;
  const threads = (await db.query<Thread>(`SELECT * FROM threads ORDER BY created_at DESC LIMIT 30`)).rows;
  const waiting = await openEscalations(db);
  const working = new Set((await db.query<{ agent_id: string }>(
    `SELECT DISTINCT r.agent_id FROM runs r JOIN threads t ON t.id = r.thread_id
     WHERE r.state = 'running' AND t.status = 'active'`)).rows.map((r) => r.agent_id));
  const lastRun = new Map((await db.query<{ agent_id: string; state: string }>(
    `SELECT DISTINCT ON (agent_id) agent_id, state FROM runs ORDER BY agent_id, created_at DESC`)).rows.map((r) => [r.agent_id, r.state]));
  const name = new Map(agents.map((a) => [a.id, a.name as string]));

  const column = (a: { id: string; adapter: string }) => (a.adapter === "chat" ? 0 : a.id === hub.planner.id ? 1 : 2);
  const anyActive = threads.some((t) => t.status !== "done");
  const status = (id: string): [BoardState["agents"][number]["status"], string] => {
    if (waiting.some((e) => e.agent_id === id)) return ["waiting", "waiting on you"];
    if (id === hub.planner.id) return anyActive ? ["working", "holding the plan"] : ["idle", "idle"];
    if (id === hub.chat.id) return anyActive ? ["done", "handed off"] : ["idle", "idle"];
    if (working.has(id)) return ["working", "working"];
    if (lastRun.get(id) === "done") return ["done", "done"];
    if (lastRun.get(id) === "error") return ["idle", "hit a problem"];
    return ["idle", "idle"];
  };

  const selected = threads.find((t) => t.id === threadId) ?? threads[0] ?? null;
  let feed: NonNullable<BoardState["thread"]>["feed"] = [];
  if (selected) {
    const messages = (await db.query<Message>(`SELECT * FROM messages WHERE thread_id = $1 ORDER BY seq`, [selected.id])).rows;
    feed = messages.map((m) => {
      const byUser = m.attachments?.some((a) => a.kind === "user_answer");
      return {
        from: name.get(m.from_agent) ?? "?", to: name.get(m.to_agent) ?? "?", type: m.type, body: m.body,
        tag: m.type === "answer" && m.from_agent === hub.planner.id ? (byUser ? "you" : "self") : null,
      };
    });
  }

  const counts = (await db.query<{ self: number; you: number }>(
    `SELECT
       (SELECT count(*) FROM messages WHERE from_agent = $1 AND type = 'answer'
          AND NOT attachments @> '[{"kind":"user_answer"}]')::int AS self,
       (SELECT count(*) FROM escalations)::int AS you`, [hub.planner.id])).rows[0];

  return {
    owner: hub.user.name,
    agents: agents.map((a) => {
      const [st, text] = status(a.id);
      return { id: a.id, name: a.name, sub: a.card?.description ?? a.vendor, column: column(a),
        model: hub.modelLabels[a.id] ?? null, status: st, statusText: text };
    }),
    lines: lines.map((l) => ({
      id: l.id, from: l.from_node, to: l.to_node, enabled: l.enabled && l.accepted === l.owners,
      // What starts and comes back along it; answers and status updates always ride along.
      label: l.from_node === hub.chat.id ? "whole handoff"
        : l.allowed_types.filter((t) => t === "task" || t === "question" || t === "result").join(" · "),
    })),
    threads: threads.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    thread: selected ? { id: selected.id, title: selected.title, status: selected.status, feed } : null,
    waiting: waiting.map((e) => ({
      id: e.id, thread: threads.find((t) => t.id === e.thread_id)?.title ?? "", question: e.question ?? e.summary, summary: e.summary,
    })),
    stats: { answeredWithoutYou: counts.self, youWereNeeded: counts.you },
  };
}
