// Wires up one person's hub: their agents, the lines between them, and the
// router with every adapter. Real models are used when their API key is in the
// environment; otherwise a clearly labelled stand-in takes their place.
//
// Ben's starting web (CLAUDE.md 5, chat to chat):
//
//   Your Claude chat ──whole handoff──► Planner ──► Grok (research)
//                                               └─► ChatGPT (writing)

import { ChatAdapter } from "./adapters/chat.js";
import { HubRunAdapter } from "./adapters/hub-run.js";
import { PlannerAdapter } from "./adapters/planner.js";
import type { Adapter } from "./adapters/adapter.js";
import type { Db } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { ClaudePlannerModel } from "./planner/claude.js";
import type { PlannerModel } from "./planner/model.js";
import { StandInPlannerModel } from "./planner/stand-in.js";
import { Router } from "./router.js";
import { createAgent, createLine, createUser } from "./store.js";
import type { Agent, MessageType, User } from "./types.js";
import type { WorkerModel } from "./workers/model.js";
import { openaiWorker, xaiWorker } from "./workers/openai-compatible.js";
import { StandInWorker } from "./workers/stand-in.js";

/** Context fields a chat's handoff fills in. */
export const HANDOFF_FIELDS = ["summary", "plan", "decisions", "constraints", "open_questions", "links", "user_answers"];

export interface HubModels {
  planner: PlannerModel;
  grok: WorkerModel;
  chatgpt: WorkerModel;
}

/** Real models where a key is set, stand-ins otherwise. `standInDelayMs` slows stand-ins so the board is watchable. */
export function modelsFromEnv(env = process.env, standInDelayMs = 0): HubModels & { missingKeys: string[] } {
  const missingKeys: string[] = [];
  const pick = <T>(key: string, real: (k: string) => T, standIn: () => T): T => {
    const value = env[key];
    if (value) return real(value);
    missingKeys.push(key);
    return standIn();
  };
  return {
    planner: pick<PlannerModel>("ANTHROPIC_API_KEY", () => new ClaudePlannerModel(), () => new StandInPlannerModel()),
    grok: pick<WorkerModel>("XAI_API_KEY", (k) => xaiWorker(k), () => new StandInWorker({ delayMs: standInDelayMs })),
    chatgpt: pick<WorkerModel>("OPENAI_API_KEY", (k) => openaiWorker(k), () => new StandInWorker({ delayMs: standInDelayMs })),
    missingKeys,
  };
}

export interface Hub {
  db: Db;
  router: Router;
  user: User;
  chat: Agent;
  planner: Agent;
  workers: Agent[];
  modelLabels: Record<string, string>;
  /** Stop the follow-up timer. */
  stop(): void;
}

export async function startHub(opts: {
  db: Db;
  models: HubModels;
  ownerName?: string;
  clock?: () => Date;
  /** How often to chase quiet agents. 0 turns the timer off (tests call checkTimeouts themselves). */
  followUpEveryMs?: number;
}): Promise<Hub> {
  const { db, models } = opts;
  await migrate(db);

  const user = await ensureUser(db, opts.ownerName ?? "Ben");
  const chat = await ensureAgent(db, user, { name: "Your Claude chat", vendor: "anthropic", kind: "adapter", adapter: "chat",
    card: { name: "Your Claude chat", description: "Where you talk" } });
  const planner = await ensureAgent(db, user, { name: "Planner", vendor: "anthropic", kind: "hub_run", adapter: "planner",
    card: { name: "Planner", description: "Keeps the plan" } });
  const grok = await ensureAgent(db, user, { name: "Grok", vendor: "xai", kind: "hub_run", adapter: "grok",
    card: { name: "Grok", description: "Research", skills: [{ id: "research", name: "Research" }] } });
  const chatgpt = await ensureAgent(db, user, { name: "ChatGPT", vendor: "openai", kind: "hub_run", adapter: "chatgpt",
    card: { name: "ChatGPT", description: "Writing", skills: [{ id: "writing", name: "Writing" }] } });

  const workerTypes: MessageType[] = ["task", "question", "answer", "status", "result"];
  await ensureLine(db, user, chat, planner, HANDOFF_FIELDS, ["task", "status", "question", "answer", "result"]);
  await ensureLine(db, user, planner, grok, HANDOFF_FIELDS, workerTypes);
  await ensureLine(db, user, planner, chatgpt, HANDOFF_FIELDS, workerTypes);

  const adapters: Record<string, Adapter> = {
    chat: new ChatAdapter(),
    planner: new PlannerAdapter({ db, model: models.planner }),
    grok: new HubRunAdapter({ db, model: models.grok, name: "Grok", role: "Research" }),
    chatgpt: new HubRunAdapter({ db, model: models.chatgpt, name: "ChatGPT", role: "Writing" }),
  };
  const router = new Router({ db, adapters, clock: opts.clock });

  const every = opts.followUpEveryMs ?? 5000;
  const timer = every > 0 ? setInterval(() => router.checkTimeouts().catch(() => {}), every) : null;

  return {
    db, router, user, chat, planner, workers: [grok, chatgpt],
    modelLabels: {
      [planner.id]: models.planner instanceof StandInPlannerModel ? "stand-in" : "claude",
      [grok.id]: models.grok.label,
      [chatgpt.id]: models.chatgpt.label,
    },
    stop: () => timer && clearInterval(timer),
  };
}

async function ensureUser(db: Db, name: string): Promise<User> {
  const { rows } = await db.query<User>(`SELECT id, name, contact FROM users WHERE name = $1 ORDER BY created_at LIMIT 1`, [name]);
  return rows[0] ?? createUser(db, { name });
}

async function ensureAgent(db: Db, user: User, a: Omit<Parameters<typeof createAgent>[1], "ownerUserId">): Promise<Agent> {
  const { rows } = await db.query<Agent>(
    `SELECT * FROM agents WHERE owner_user_id = $1 AND adapter = $2 ORDER BY created_at LIMIT 1`, [user.id, a.adapter]);
  return rows[0] ?? createAgent(db, { ...a, ownerUserId: user.id });
}

async function ensureLine(db: Db, user: User, from: Agent, to: Agent, scope: string[], types: MessageType[]): Promise<void> {
  const { rowCount } = await db.query(`SELECT 1 FROM lines WHERE from_node = $1 AND to_node = $2`, [from.id, to.id]);
  if (rowCount) return;
  await createLine(db, { fromNode: from.id, toNode: to.id, owners: [user.id], acceptedBy: [user.id], contextScope: scope, allowedTypes: types });
}
