/**
 * Room rules (CLAUDE.md 4.4). The server stores and routes; it never calls a model.
 *
 * Every agent operation runs in one transaction that locks the room row, applies
 * any due deadline or turn timeout, then checks the caller's seat and grant.
 */
import type { Clock } from "../clock.js";
import { newSecret, sha256 } from "../crypto.js";
import { inTx, type Db, type Queryable, type Tx } from "../db/pool.js";

export const SCOPES = ["read", "post", "propose"] as const;
export type Scope = (typeof SCOPES)[number];

export const LIMITS = {
  goal: 2_000,
  role: 40,
  body: 20_000,
  attachments: 5,
  attachmentName: 120,
  attachmentContent: 50_000,
  summary: 4_000,
  listItems: 30,
  listItem: 1_000,
  note: 500,
  maxDeadlineDays: 7,
  grantDays: 7,
  inviteDays: 7,
};

export type RoomStatus = "open" | "proposed" | "approved" | "closed";

/** Who is calling through MCP: one agent connection, owned by one user. */
export interface AgentCaller {
  userId: string;
  connectionId: string;
}

export type RoomErrorCode = "not_found" | "forbidden" | "not_your_turn" | "closed" | "invalid" | "limit";

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Room {
  id: string;
  goal: string;
  owner_user_id: string;
  planned_roles: string[];
  status: RoomStatus;
  close_reason: string | null;
  turn_limit: number;
  turns_used: number;
  current_participant_id: string | null;
  turn_started_at: Date;
  turn_timeout_seconds: number;
  deadline: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Seat {
  id: string;
  room_id: string;
  user_id: string;
  connection_id: string;
  role: string;
  position: number;
  joined_at: Date;
  left_at: Date | null;
  last_read_turn: number;
  // from the grant
  scopes: Scope[];
  grant_expires_at: Date;
  grant_revoked_at: Date | null;
  // for display
  user_name: string;
  agent_label: string;
  agent_vendor: string;
}

export interface Message {
  id: string;
  participant_id: string;
  turn_no: number;
  body: string;
  attachments: { name: string; content: string }[];
  next_role: string | null;
  created_at: Date;
}

export interface Proposal {
  id: string;
  participant_id: string;
  turn_no: number;
  summary: string;
  changes: string[];
  open_questions: string[];
  status: "pending" | "approved" | "rejected";
  created_at: Date;
  decisions: { user_id: string; user_name: string; decision: "approve" | "reject"; note: string | null; decided_at: Date }[];
}

export interface LedgerLine {
  participant_id: string;
  role: string;
  posts: number;
  proposals: number;
  est_tokens: number;
}

export interface RoomView {
  room: Room;
  me: Seat | null;
  seats: Seat[];
  messages: Message[];
  proposals: Proposal[];
  ledger: LedgerLine[];
  /** Distinct humans who must approve a proposal. */
  approvers: { user_id: string; name: string }[];
}

export interface AuditEntry {
  roomId?: string | null;
  userId?: string | null;
  connectionId?: string | null;
  participantId?: string | null;
  action: string;
  result: "ok" | "refused" | "error";
  detail?: Record<string, unknown>;
}

/** Rough token estimate for the ledger: about four characters per token. */
export function estimateTokens(...parts: string[]): number {
  return Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 4);
}

function cleanRole(role: string): string {
  const r = role.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(r) || r.length > LIMITS.role) {
    throw new RoomError("invalid", `Role "${role}" must be a short name of letters, numbers, - or _ (e.g. "docs").`);
  }
  return r;
}

function cleanList(items: string[] | undefined, what: string): string[] {
  const list = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length > LIMITS.listItems) throw new RoomError("invalid", `At most ${LIMITS.listItems} ${what}.`);
  if (list.some((s) => s.length > LIMITS.listItem)) {
    throw new RoomError("invalid", `Each of the ${what} must be under ${LIMITS.listItem} characters.`);
  }
  return list;
}

function isActive(seat: Seat, now: Date): boolean {
  return !seat.left_at && !seat.grant_revoked_at && seat.grant_expires_at > now;
}

const SEAT_SQL = `
  SELECT p.*, g.scopes, g.expires_at AS grant_expires_at, g.revoked_at AS grant_revoked_at,
         u.name AS user_name, c.label AS agent_label, c.vendor AS agent_vendor
    FROM participants p
    JOIN grants g ON g.participant_id = p.id
    JOIN users u ON u.id = p.user_id
    JOIN agent_connections c ON c.id = p.connection_id`;

export class RoomService {
  constructor(
    private readonly opts: { db: Db; clock: Clock; baseUrl: string },
  ) {}

  private get db() {
    return this.opts.db;
  }
  get pool(): Db {
    return this.opts.db;
  }
  private now() {
    return this.opts.clock();
  }

  roomUrl(roomId: string): string {
    return `${this.opts.baseUrl}/rooms/${roomId}`;
  }
  inviteUrl(token: string): string {
    return `${this.opts.baseUrl}/join/${token}`;
  }

  async audit(q: Queryable, e: AuditEntry): Promise<void> {
    await q.query(
      `INSERT INTO audit (at, room_id, user_id, connection_id, participant_id, action, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        this.now(),
        e.roomId ?? null,
        e.userId ?? null,
        e.connectionId ?? null,
        e.participantId ?? null,
        e.action,
        e.result,
        JSON.stringify(e.detail ?? {}),
      ],
    );
  }

  // ---------- loading ----------

  private async lockRoom(tx: Tx, roomId: string): Promise<Room> {
    if (!/^[0-9a-f-]{36}$/i.test(roomId)) throw new RoomError("not_found", "No room with that id.");
    const { rows } = await tx.query<Room>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId]);
    if (!rows[0]) throw new RoomError("not_found", "No room with that id.");
    return rows[0];
  }

  private async seats(q: Queryable, roomId: string): Promise<Seat[]> {
    const { rows } = await q.query<Seat>(`${SEAT_SQL} WHERE p.room_id = $1 ORDER BY p.position`, [roomId]);
    return rows;
  }

  /** The caller's seat in this room. Not seated, or seat no longer valid → not found / forbidden. */
  private mySeat(seats: Seat[], caller: AgentCaller, need: Scope): Seat {
    const seat = seats.find((s) => s.connection_id === caller.connectionId && !s.left_at);
    // Same answer whether the room exists or not, so ids can't be probed.
    if (!seat) throw new RoomError("not_found", "No room with that id.");
    if (seat.grant_revoked_at) throw new RoomError("forbidden", "Your seat in this room was revoked.");
    if (seat.grant_expires_at <= this.now()) throw new RoomError("forbidden", "Your access to this room has expired.");
    if (!seat.scopes.includes(need)) {
      throw new RoomError("forbidden", `Your seat doesn't allow "${need}". It allows: ${seat.scopes.join(", ")}.`);
    }
    return seat;
  }

  private nextSeat(seats: Seat[], fromId: string | null): Seat | null {
    const now = this.now();
    const active = seats.filter((s) => isActive(s, now));
    if (active.length === 0) return null;
    const all = [...seats].sort((a, b) => a.position - b.position);
    const from = all.findIndex((s) => s.id === fromId);
    for (let i = 1; i <= all.length; i++) {
      const s = all[(Math.max(from, 0) + i) % all.length]!;
      if (isActive(s, now)) return s;
    }
    return active[0]!;
  }

  /**
   * Apply anything that became due since the room was last touched: the deadline,
   * then turn timeouts. Mutates and saves `room`.
   */
  private async refresh(tx: Tx, room: Room, seats: Seat[]): Promise<void> {
    const now = this.now();
    if (room.status === "approved" || room.status === "closed") return;

    if (now >= room.deadline) {
      await this.close(tx, room, "The deadline passed.");
      return;
    }
    if (room.status !== "open") return;

    const active = seats.filter((s) => isActive(s, now));
    const current = seats.find((s) => s.id === room.current_participant_id);
    if (!current || !isActive(current, now)) {
      const next = this.nextSeat(seats, room.current_participant_id);
      room.current_participant_id = next?.id ?? null;
      room.turn_started_at = now;
    }
    if (active.length < 2) {
      await this.save(tx, room); // the clock runs only once there is someone to talk to
      return;
    }

    const timeoutMs = room.turn_timeout_seconds * 1000;
    let passes = 0;
    while (now.getTime() - room.turn_started_at.getTime() >= timeoutMs && passes < 1000) {
      if (room.turns_used >= room.turn_limit) {
        await this.close(tx, room, "The turn limit was reached and no proposal came in time.");
        return;
      }
      const skipped = room.current_participant_id;
      room.current_participant_id = this.nextSeat(seats, skipped)?.id ?? null;
      room.turn_started_at = new Date(room.turn_started_at.getTime() + timeoutMs);
      passes++;
      await this.audit(tx, {
        roomId: room.id,
        participantId: skipped,
        action: "turn.timeout",
        result: "ok",
        detail: { next: room.current_participant_id },
      });
    }
    await this.save(tx, room);
  }

  private async close(tx: Tx, room: Room, reason: string): Promise<void> {
    room.status = "closed";
    room.close_reason = reason;
    await this.save(tx, room);
    await tx.query(`UPDATE proposals SET status = 'rejected' WHERE room_id = $1 AND status = 'pending'`, [room.id]);
    await this.audit(tx, { roomId: room.id, action: "room.closed", result: "ok", detail: { reason } });
  }

  private async save(tx: Tx, room: Room): Promise<void> {
    room.updated_at = this.now();
    await tx.query(
      `UPDATE rooms SET status=$2, close_reason=$3, turns_used=$4, current_participant_id=$5,
              turn_started_at=$6, updated_at=$7, planned_roles=$8 WHERE id=$1`,
      [
        room.id,
        room.status,
        room.close_reason,
        room.turns_used,
        room.current_participant_id,
        room.turn_started_at,
        room.updated_at,
        room.planned_roles,
      ],
    );
  }

  private async ledger(tx: Tx, room: Room, seat: Seat, action: string, turnNo: number, est: number) {
    await tx.query(
      `INSERT INTO ledger (room_id, participant_id, action, turn_no, est_tokens, at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [room.id, seat.id, action, turnNo, est, this.now()],
    );
  }

  private async seatParticipant(
    tx: Tx,
    room: Room,
    args: { userId: string; connectionId: string; role: string; scopes: Scope[]; grantedBy: string },
  ): Promise<string> {
    const now = this.now();
    const { rows: pos } = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM participants WHERE room_id = $1`,
      [room.id],
    );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO participants (room_id, user_id, connection_id, role, position, joined_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [room.id, args.userId, args.connectionId, args.role, pos[0]!.n, now],
    );
    const participantId = rows[0]!.id;
    const grantDays = new Date(now.getTime() + LIMITS.grantDays * 86_400_000);
    const expires = room.deadline < grantDays ? room.deadline : grantDays;
    await tx.query(
      `INSERT INTO grants (participant_id, room_id, scopes, granted_by, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [participantId, room.id, args.scopes, args.grantedBy, expires, now],
    );
    return participantId;
  }

  // ---------- agent operations ----------

  async createRoom(
    caller: AgentCaller,
    input: {
      goal: string;
      myRole: string;
      inviteRoles?: string[];
      turnLimit?: number;
      deadlineDays?: number;
      turnTimeoutMinutes?: number;
    },
  ): Promise<{ room: Room; seatId: string }> {
    const goal = input.goal.trim();
    if (!goal) throw new RoomError("invalid", "A room needs a goal.");
    if (goal.length > LIMITS.goal) throw new RoomError("invalid", `Keep the goal under ${LIMITS.goal} characters.`);
    const myRole = cleanRole(input.myRole);
    const others = [...new Set((input.inviteRoles ?? []).map(cleanRole))].filter((r) => r !== myRole);
    const turnLimit = input.turnLimit ?? 12;
    if (!Number.isInteger(turnLimit) || turnLimit < 2 || turnLimit > 100) {
      throw new RoomError("invalid", "turn_limit must be a whole number from 2 to 100.");
    }
    const days = input.deadlineDays ?? LIMITS.maxDeadlineDays;
    if (!(days > 0 && days <= LIMITS.maxDeadlineDays)) {
      throw new RoomError("invalid", `deadline_days must be more than 0 and at most ${LIMITS.maxDeadlineDays}.`);
    }
    const timeoutMin = input.turnTimeoutMinutes ?? 30;
    if (!(timeoutMin >= 1 && timeoutMin <= 24 * 60)) {
      throw new RoomError("invalid", "turn_timeout_minutes must be from 1 to 1440.");
    }

    return inTx(this.db, async (tx) => {
      const now = this.now();
      const { rows } = await tx.query<Room>(
        `INSERT INTO rooms (goal, owner_user_id, planned_roles, turn_limit, turn_started_at, turn_timeout_seconds,
                            deadline, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$5,$5) RETURNING *`,
        [
          goal,
          caller.userId,
          [myRole, ...others],
          turnLimit,
          now,
          Math.round(timeoutMin * 60),
          new Date(now.getTime() + days * 86_400_000),
        ],
      );
      const room = rows[0]!;
      const seatId = await this.seatParticipant(tx, room, {
        userId: caller.userId,
        connectionId: caller.connectionId,
        role: myRole,
        scopes: [...SCOPES],
        grantedBy: caller.userId,
      });
      room.current_participant_id = seatId;
      await this.save(tx, room);
      return { room, seatId };
    });
  }

  async createInvite(
    caller: AgentCaller,
    roomId: string,
    input: { role: string; scopes?: Scope[]; note?: string },
  ): Promise<{ url: string; role: string; scopes: Scope[]; expiresAt: Date }> {
    const role = cleanRole(input.role);
    const scopes = [...new Set(input.scopes?.length ? input.scopes : [...SCOPES])];
    if (!scopes.includes("read")) throw new RoomError("invalid", `Every seat needs "read".`);
    const note = input.note?.trim().slice(0, LIMITS.note) || null;
    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "read");
      if (room.owner_user_id !== caller.userId) {
        throw new RoomError("forbidden", "Only the room owner can invite.");
      }
      await this.refresh(tx, room, seats);
      if (room.status !== "open") throw new RoomError("closed", `This room is ${room.status}; it takes no new seats.`);
      if (seats.some((s) => s.role === role)) throw new RoomError("invalid", `The ${role} seat is already taken.`);
      const token = newSecret();
      const now = this.now();
      const expiresAt = new Date(Math.min(room.deadline.getTime(), now.getTime() + LIMITS.inviteDays * 86_400_000));
      // A fresh invite for the same role replaces any earlier unused one.
      await tx.query(
        `UPDATE invites SET revoked_at = $3 WHERE room_id = $1 AND role = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [room.id, role, now],
      );
      await tx.query(
        `INSERT INTO invites (room_id, role, scopes, note, token_hash, created_by, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [room.id, role, scopes, note, sha256(token), me.id, expiresAt, now],
      );
      if (!room.planned_roles.includes(role)) {
        room.planned_roles = [...room.planned_roles, role];
        await this.save(tx, room);
      }
      return { url: this.inviteUrl(token), role, scopes, expiresAt };
    });
  }

  async listRooms(caller: AgentCaller) {
    const { rows } = await this.db.query<{ room_id: string }>(
      `SELECT room_id FROM participants WHERE connection_id = $1 AND left_at IS NULL ORDER BY joined_at DESC LIMIT 50`,
      [caller.connectionId],
    );
    const out = [];
    for (const { room_id } of rows) {
      try {
        const v = await this.readRoom(caller, room_id, { markRead: false });
        out.push(v);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err; // revoked/expired seats are simply left out
      }
    }
    return out;
  }

  async readRoom(caller: AgentCaller, roomId: string, opts: { markRead?: boolean } = {}): Promise<RoomView> {
    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "read");
      await this.refresh(tx, room, seats);
      const view = await this.view(tx, room, seats, me);
      if (opts.markRead !== false) {
        await tx.query(`UPDATE participants SET last_read_turn = $2 WHERE id = $1`, [me.id, room.turns_used]);
      }
      return view;
    });
  }

  async post(
    caller: AgentCaller,
    roomId: string,
    input: { body: string; attachments?: { name: string; content: string }[]; nextRole?: string },
  ): Promise<{ view: RoomView; turnNo: number }> {
    const body = input.body.trim();
    if (!body) throw new RoomError("invalid", "The message is empty.");
    if (body.length > LIMITS.body) throw new RoomError("invalid", `Keep a message under ${LIMITS.body} characters; attach longer text.`);
    const attachments = (input.attachments ?? []).map((a) => ({ name: a.name.trim(), content: a.content }));
    if (attachments.length > LIMITS.attachments) throw new RoomError("invalid", `At most ${LIMITS.attachments} files per message.`);
    for (const a of attachments) {
      if (!a.name || a.name.length > LIMITS.attachmentName) throw new RoomError("invalid", "Each file needs a short name.");
      if (a.content.length > LIMITS.attachmentContent) {
        throw new RoomError("invalid", `Each file must be under ${LIMITS.attachmentContent} characters.`);
      }
    }

    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "post");
      await this.refresh(tx, room, seats);
      this.assertMyTurn(room, seats, me);
      if (room.turns_used >= room.turn_limit) {
        throw new RoomError("limit", `The room used all ${room.turn_limit} turns. Call propose with the decision brief now.`);
      }

      let next: Seat | null = null;
      if (input.nextRole?.trim()) {
        const want = cleanRole(input.nextRole);
        next = seats.find((s) => s.role === want && isActive(s, this.now())) ?? null;
        if (!next || next.id === me.id) {
          const roles = seats.filter((s) => s.id !== me.id && isActive(s, this.now())).map((s) => s.role);
          throw new RoomError("invalid", `next_role must be another seated role: ${roles.join(", ") || "none yet"}.`);
        }
      }

      const turnNo = room.turns_used + 1;
      await tx.query(
        `INSERT INTO messages (room_id, participant_id, turn_no, body, attachments, next_role, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [room.id, me.id, turnNo, body, JSON.stringify(attachments), next?.role ?? null, this.now()],
      );
      await this.ledger(tx, room, me, "post", turnNo, estimateTokens(body, ...attachments.map((a) => a.content)));
      room.turns_used = turnNo;
      room.current_participant_id = (next ?? this.nextSeat(seats, me.id))?.id ?? null;
      room.turn_started_at = this.now();
      await this.save(tx, room);
      await tx.query(`UPDATE participants SET last_read_turn = $2 WHERE id = $1`, [me.id, turnNo]);
      return { view: await this.view(tx, room, seats, me), turnNo };
    });
  }

  async propose(
    caller: AgentCaller,
    roomId: string,
    input: { summary: string; changes?: string[]; openQuestions?: string[] },
  ): Promise<{ view: RoomView; proposalId: string; approveUrl: string }> {
    const summary = input.summary.trim();
    if (!summary) throw new RoomError("invalid", "A proposal needs a summary.");
    if (summary.length > LIMITS.summary) throw new RoomError("invalid", `Keep the summary under ${LIMITS.summary} characters.`);
    const changes = cleanList(input.changes, "changes");
    const openQuestions = cleanList(input.openQuestions, "open questions");

    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "propose");
      await this.refresh(tx, room, seats);
      this.assertMyTurn(room, seats, me);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO proposals (room_id, participant_id, turn_no, summary, changes, open_questions, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [room.id, me.id, room.turns_used, summary, JSON.stringify(changes), JSON.stringify(openQuestions), this.now()],
      );
      await this.ledger(tx, room, me, "propose", room.turns_used, estimateTokens(summary, ...changes, ...openQuestions));
      room.status = "proposed";
      room.current_participant_id = null;
      await this.save(tx, room);
      return { view: await this.view(tx, room, seats, me), proposalId: rows[0]!.id, approveUrl: this.roomUrl(room.id) };
    });
  }

  private assertMyTurn(room: Room, seats: Seat[], me: Seat) {
    if (room.status === "proposed") {
      throw new RoomError("closed", "A proposal is waiting for the humans to approve. Nothing more can be posted.");
    }
    if (room.status !== "open") throw new RoomError("closed", `This room is ${room.status}: ${room.close_reason ?? ""}`.trim());
    const now = this.now();
    if (seats.filter((s) => isActive(s, now)).length < 2) {
      throw new RoomError("not_your_turn", "Nobody else has joined yet. Wait for the invited side to join, then read_room again.");
    }
    if (room.current_participant_id !== me.id) {
      const cur = seats.find((s) => s.id === room.current_participant_id);
      throw new RoomError("not_your_turn", `It's the ${cur?.role ?? "other"} seat's turn. Check back with read_room later.`);
    }
  }

  // ---------- human operations (web app) ----------

  async inviteByToken(token: string) {
    const { rows } = await this.db.query<{
      id: string;
      room_id: string;
      role: string;
      scopes: Scope[];
      note: string | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      goal: string;
      status: RoomStatus;
      owner_name: string;
    }>(
      `SELECT i.*, r.goal, r.status, u.name AS owner_name
         FROM invites i JOIN rooms r ON r.id = i.room_id JOIN users u ON u.id = r.owner_user_id
        WHERE i.token_hash = $1`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) return { ok: false as const, reason: "This join link isn't valid." };
    if (inv.revoked_at) return { ok: false as const, reason: "This join link was replaced by a newer one. Ask for a new link." };
    if (inv.accepted_at) return { ok: false as const, reason: "This join link was already used." };
    if (inv.expires_at <= this.now()) return { ok: false as const, reason: "This join link has expired." };
    if (inv.status !== "open") return { ok: false as const, reason: `That room is ${inv.status} and takes no new seats.` };
    return { ok: true as const, invite: inv };
  }

  /** A human accepts an invite and picks which of their agents takes the seat. This creates the grant. */
  async acceptInvite(userId: string, token: string, connectionId: string): Promise<{ roomId: string; seatId: string }> {
    return inTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; room_id: string; role: string; scopes: Scope[] }>(
        `SELECT * FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
           FOR UPDATE`,
        [sha256(token), this.now()],
      );
      const inv = rows[0];
      if (!inv) throw new RoomError("invalid", "This join link isn't valid any more.");
      const { rows: conn } = await tx.query(
        `SELECT 1 FROM agent_connections WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [connectionId, userId],
      );
      if (!conn[0]) throw new RoomError("forbidden", "Pick one of your own connected agents.");
      const room = await this.lockRoom(tx, inv.room_id);
      const seats = await this.seats(tx, room.id);
      await this.refresh(tx, room, seats);
      if (room.status !== "open") throw new RoomError("closed", `That room is ${room.status}.`);
      if (seats.some((s) => s.connection_id === connectionId && !s.left_at)) {
        throw new RoomError("invalid", "That agent already has a seat in this room. Connect a different agent for this role.");
      }
      if (seats.some((s) => s.role === inv.role)) throw new RoomError("invalid", `The ${inv.role} seat is already taken.`);
      const seatId = await this.seatParticipant(tx, room, {
        userId,
        connectionId,
        role: inv.role,
        scopes: inv.scopes,
        grantedBy: userId,
      });
      await tx.query(`UPDATE invites SET accepted_at = $2, participant_id = $3 WHERE id = $1`, [inv.id, this.now(), seatId]);
      // The turn clock starts when the second seat fills.
      const after = await this.seats(tx, room.id);
      if (after.filter((s) => isActive(s, this.now())).length === 2) {
        room.turn_started_at = this.now();
        await this.save(tx, room);
      }
      await this.audit(tx, {
        roomId: room.id,
        userId,
        connectionId,
        participantId: seatId,
        action: "invite.accepted",
        result: "ok",
        detail: { role: inv.role, scopes: inv.scopes },
      });
      return { roomId: room.id, seatId };
    });
  }

  /** The room as a signed-in human sees it. Must hold a seat (or own the room). */
  async roomForHuman(userId: string, roomId: string): Promise<RoomView> {
    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      if (room.owner_user_id !== userId && !seats.some((s) => s.user_id === userId)) {
        throw new RoomError("not_found", "No room with that id.");
      }
      await this.refresh(tx, room, seats);
      return this.view(tx, room, seats, null);
    });
  }

  async roomsForHuman(userId: string) {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT DISTINCT r.id, r.updated_at FROM rooms r LEFT JOIN participants p ON p.room_id = r.id
        WHERE r.owner_user_id = $1 OR p.user_id = $1 ORDER BY r.updated_at DESC LIMIT 50`,
      [userId],
    );
    return Promise.all(rows.map((r) => this.roomForHuman(userId, r.id)));
  }

  async decide(userId: string, roomId: string, proposalId: string, decision: "approve" | "reject", note?: string) {
    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      await this.refresh(tx, room, seats);
      const approvers = this.approvers(seats);
      if (room.owner_user_id !== userId && !seats.some((s) => s.user_id === userId)) {
        throw new RoomError("not_found", "No room with that id.");
      }
      if (!approvers.some((a) => a.user_id === userId)) throw new RoomError("forbidden", "Only people with a seat in this room decide.");
      const { rows } = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM proposals WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [proposalId, room.id],
      );
      const p = rows[0];
      if (!p) throw new RoomError("not_found", "No such proposal.");
      if (room.status !== "proposed" || p.status !== "pending") {
        throw new RoomError("closed", "This proposal has already been decided or the room is closed.");
      }
      const ins = await tx.query(
        `INSERT INTO proposal_decisions (proposal_id, user_id, decision, note, decided_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [p.id, userId, decision, note?.trim().slice(0, LIMITS.note) || null, this.now()],
      );
      if (ins.rowCount === 0) throw new RoomError("invalid", "You already decided on this proposal.");
      await this.audit(tx, {
        roomId: room.id,
        userId,
        action: `proposal.${decision}`,
        result: "ok",
        detail: { proposal_id: p.id },
      });

      if (decision === "reject") {
        await tx.query(`UPDATE proposals SET status = 'rejected' WHERE id = $1`, [p.id]);
        await this.close(tx, room, "The proposal was rejected.");
      } else {
        const { rows: yes } = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM proposal_decisions WHERE proposal_id = $1 AND decision = 'approve'`,
          [p.id],
        );
        const ok = new Set(yes.map((r) => r.user_id));
        if (approvers.every((a) => ok.has(a.user_id))) {
          await tx.query(`UPDATE proposals SET status = 'approved' WHERE id = $1`, [p.id]);
          room.status = "approved";
          room.close_reason = null;
          await this.save(tx, room);
          await this.audit(tx, { roomId: room.id, action: "room.approved", result: "ok", detail: { proposal_id: p.id } });
        }
      }
      return this.view(tx, room, seats, null);
    });
  }

  /** Owner removes a seat, or a person removes their own. */
  async revokeSeat(userId: string, roomId: string, participantId: string) {
    return inTx(this.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const seat = seats.find((s) => s.id === participantId);
      if (!seat) throw new RoomError("not_found", "No such seat.");
      if (room.owner_user_id !== userId && seat.user_id !== userId) throw new RoomError("forbidden", "Not your seat.");
      await tx.query(`UPDATE grants SET revoked_at = $2 WHERE participant_id = $1 AND revoked_at IS NULL`, [seat.id, this.now()]);
      seat.grant_revoked_at = this.now();
      await this.audit(tx, { roomId: room.id, userId, participantId: seat.id, action: "seat.revoked", result: "ok" });
      await this.refresh(tx, room, seats);
    });
  }

  async exportAudit(userId: string, roomId: string) {
    await this.roomForHuman(userId, roomId); // access check
    const { rows } = await this.db.query(
      `SELECT a.id, a.at, a.action, a.result, a.detail, a.participant_id, p.role,
              c.label AS agent, u.name AS person
         FROM audit a
         LEFT JOIN participants p ON p.id = a.participant_id
         LEFT JOIN agent_connections c ON c.id = a.connection_id
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.room_id = $1 ORDER BY a.id`,
      [roomId],
    );
    return rows;
  }

  // ---------- views ----------

  private approvers(seats: Seat[]) {
    const seen = new Map<string, string>();
    for (const s of seats) if (!s.left_at && !s.grant_revoked_at) seen.set(s.user_id, s.user_name);
    return [...seen].map(([user_id, name]) => ({ user_id, name }));
  }

  private async view(q: Queryable, room: Room, seats: Seat[], me: Seat | null): Promise<RoomView> {
    const { rows: messages } = await q.query<Message>(
      `SELECT id, participant_id, turn_no, body, attachments, next_role, created_at
         FROM messages WHERE room_id = $1 ORDER BY turn_no`,
      [room.id],
    );
    const { rows: proposals } = await q.query<Omit<Proposal, "decisions">>(
      `SELECT id, participant_id, turn_no, summary, changes, open_questions, status, created_at
         FROM proposals WHERE room_id = $1 ORDER BY created_at`,
      [room.id],
    );
    const { rows: decisions } = await q.query<Proposal["decisions"][number] & { proposal_id: string }>(
      `SELECT d.proposal_id, d.user_id, u.name AS user_name, d.decision, d.note, d.decided_at
         FROM proposal_decisions d JOIN users u ON u.id = d.user_id
        WHERE d.proposal_id = ANY($1::uuid[]) ORDER BY d.decided_at`,
      [proposals.map((p) => p.id)],
    );
    const { rows: ledger } = await q.query<{ participant_id: string; action: string; n: string; t: string }>(
      `SELECT participant_id, action, COUNT(*) AS n, SUM(est_tokens) AS t FROM ledger WHERE room_id = $1
        GROUP BY participant_id, action`,
      [room.id],
    );
    const lines: LedgerLine[] = seats.map((s) => {
      const mine = ledger.filter((l) => l.participant_id === s.id);
      return {
        participant_id: s.id,
        role: s.role,
        posts: Number(mine.find((l) => l.action === "post")?.n ?? 0),
        proposals: Number(mine.find((l) => l.action === "propose")?.n ?? 0),
        est_tokens: mine.reduce((n, l) => n + Number(l.t), 0),
      };
    });
    return {
      room,
      me,
      seats,
      messages,
      proposals: proposals.map((p) => ({ ...p, decisions: decisions.filter((d) => d.proposal_id === p.id) })),
      ledger: lines,
      approvers: this.approvers(seats),
    };
  }
}
