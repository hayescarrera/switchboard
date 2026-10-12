import { EchoAdapter } from "../src/adapters/echo.js";
import { createPool, type Db } from "../src/db/pool.js";
import { Router } from "../src/router.js";
import { createAgent, createThread, createUser } from "../src/store.js";
import type { ThreadContext } from "../src/types.js";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  return url;
}

export function testPool(): Db {
  return createPool(testDatabaseUrl());
}

/** Wipe every table. TRUNCATE skips the events table's no-delete trigger on purpose. */
export async function resetDb(db: Db): Promise<void> {
  await db.query(
    `TRUNCATE chat_cursors, events, escalations, runs, messages, threads, line_owners, lines, agents, users RESTART IDENTITY CASCADE`,
  );
}

/** A clock tests can move forward. */
export function fakeClock(start = new Date("2026-10-12T12:00:00Z")) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

/** Ben, two echo agents (A and B), a thread, and a router that knows the echo adapters. */
export async function world(db: Db, opts: { context?: ThreadContext; maxMessages?: number } = {}) {
  const clock = fakeClock();
  const adapters = {
    echo: new EchoAdapter("echo"),
    echo_ask_back: new EchoAdapter("ask_back"),
    echo_silent: new EchoAdapter("silent"),
  };
  const router = new Router({ db, adapters, clock: clock.now, defaultTimeoutSeconds: 60 });
  const ben = await createUser(db, { name: "Ben", contact: "ben@example.com" });
  const agent = (name: string, adapter = "echo") =>
    createAgent(db, { name, vendor: "test", kind: "adapter", adapter, ownerUserId: ben.id });
  const a = await agent("Agent A");
  const b = await agent("Agent B");
  const thread = await createThread(db, {
    title: "Test thread",
    goal: "Prove the router",
    context: opts.context,
    maxMessages: opts.maxMessages,
  });
  return { clock, adapters, router, ben, a, b, thread, agent };
}

export { ScriptedAdapter } from "../src/adapters/scripted.js";
