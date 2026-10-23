import { randomUUID } from "node:crypto";
import { createPool, type Db } from "../src/db/pool.js";
import { RoomService, type AgentCaller } from "../src/rooms/service.js";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  return url;
}

export function testPool(): Db {
  return createPool(testDatabaseUrl());
}

export async function resetDb(db: Db): Promise<void> {
  await db.query(`TRUNCATE audit, ledger, proposal_decisions, proposals, messages, grants, invites, participants, rooms,
    oauth_tokens, oauth_codes, agent_connections, oauth_requests, oauth_clients, webauthn_challenges, web_sessions,
    passkeys, users RESTART IDENTITY CASCADE`);
}

/** A clock tests can move forward. */
export function fakeClock(start = new Date("2026-10-23T15:00:00Z")) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

export async function makeUser(db: Db, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0]!.id;
}

/** An agent connection as if the user had connected an AI app through OAuth. */
export async function makeAgent(db: Db, userId: string, label: string, vendor = "Claude"): Promise<AgentCaller> {
  const clientId = randomUUID();
  await db.query(`INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)`, [
    clientId,
    JSON.stringify({ client_id: clientId, client_name: vendor, redirect_uris: ["https://example.test/cb"] }),
  ]);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_connections (user_id, client_id, label, vendor) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, clientId, label, vendor],
  );
  return { userId, connectionId: rows[0]!.id };
}

/** Ben with two agents, a room owned by the first, and the second seated through an invite. */
export async function twoSeatRoom(db: Db, opts: { turnLimit?: number; timeoutMin?: number; deadlineDays?: number } = {}) {
  const clock = fakeClock();
  const rooms = new RoomService({ db, clock: clock.now, baseUrl: "https://sb.test" });
  const ben = await makeUser(db, "Ben");
  const claude = await makeAgent(db, ben, "Ben's Claude", "Claude");
  const gpt = await makeAgent(db, ben, "Ben's ChatGPT", "ChatGPT");
  const { room } = await rooms.createRoom(claude, {
    goal: "Draft a one-page onboarding checklist for a new Tekhnea customer.",
    myRole: "product",
    inviteRoles: ["docs"],
    turnLimit: opts.turnLimit,
    turnTimeoutMinutes: opts.timeoutMin,
    deadlineDays: opts.deadlineDays,
  });
  const inv = await rooms.createInvite(claude, room.id, { role: "docs" });
  const token = inv.url.split("/join/")[1]!;
  await rooms.acceptInvite(ben, token, gpt.connectionId);
  return { clock, rooms, ben, claude, gpt, roomId: room.id };
}
