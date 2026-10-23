/**
 * Handoffs (spec section 4, milestone 1). One side hands structured context to
 * another; agents ask and answer without turn-taking; an agent that can't answer
 * escalates to its own person; only escalations and the final result reach people.
 */
import { inTx, type Queryable, type Tx } from "../db/pool.js";
import {
  estimateTokens,
  LIMITS,
  RoomError,
  RoomService,
  type AgentCaller,
  type HandoffInfo,
  type HandoffVersion,
  type Question,
  type Room,
  type RoomView,
  type Seat,
} from "./service.js";

export const HANDOFF_LIMITS = {
  summaryMin: 80,
  summaryMax: 8_000,
  question: 4_000,
  answer: 8_000,
  reason: 500,
  questionsPerRoom: 60,
  actionsPerRoom: 80, // posts + asks + answers: the loop guard
};

export interface HandoffInput {
  toRole: string;
  myRole?: string;
  goal: string;
  summary: string;
  decisions?: string[];
  constraints?: string[];
  openQuestions?: string[];
  files?: { name: string; content: string }[];
  mayDecide?: string[];
  alwaysAsk?: string[];
  note?: string;
  deadlineDays?: number;
}

export interface InboxItem {
  roomId: string;
  goal: string;
  myRole: string;
  kind: "question_for_you" | "your_answer" | "waiting_on_person" | "new_handoff_version" | "room_status";
  text: string;
  questionId?: string;
}

const clean = (items: string[] | undefined, what: string) => {
  const list = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length > LIMITS.listItems) throw new RoomError("invalid", `At most ${LIMITS.listItems} ${what}.`);
  if (list.some((s) => s.length > LIMITS.listItem)) throw new RoomError("invalid", `Keep each of the ${what} under ${LIMITS.listItem} characters.`);
  return list;
};

const cleanFiles = (files: { name: string; content: string }[] | undefined) => {
  const out = (files ?? []).map((f) => ({ name: f.name.trim(), content: f.content }));
  if (out.length > LIMITS.attachments) throw new RoomError("invalid", `At most ${LIMITS.attachments} files.`);
  for (const f of out) {
    if (!f.name || f.name.length > LIMITS.attachmentName) throw new RoomError("invalid", "Each file needs a short name.");
    if (f.content.length > LIMITS.attachmentContent) throw new RoomError("invalid", `Each file must be under ${LIMITS.attachmentContent} characters.`);
  }
  return out;
};

const isActive = (s: Seat, now: Date) => !s.left_at && !s.grant_revoked_at && s.grant_expires_at > now;

export class HandoffService extends RoomService {
  /** Check a handoff carries enough for the other side to act without coming back. */
  private checkHandoff(i: { summary: string; decisions: string[]; constraints: string[]; openQuestions: string[] }) {
    const missing: string[] = [];
    if (i.summary.length < HANDOFF_LIMITS.summaryMin) {
      missing.push(`a summary of at least ${HANDOFF_LIMITS.summaryMin} characters (what this is, why, and where it stands)`);
    }
    if (i.decisions.length + i.constraints.length === 0) {
      missing.push("at least one decision already made or one constraint the other side must respect");
    }
    if (missing.length) {
      throw new RoomError(
        "invalid",
        `This handoff is too thin for the other side to work from. Add ${missing.join(", and ")}. ` +
          "Pull these from the conversation you've had with your user; ask your user if you don't know.",
      );
    }
    if (i.summary.length > HANDOFF_LIMITS.summaryMax) {
      throw new RoomError("invalid", `Keep the summary under ${HANDOFF_LIMITS.summaryMax} characters; put long material in files.`);
    }
  }

  /** Start a handoff: a handoff room, its charter, version 1, and a join link for the other side. */
  async startHandoff(caller: AgentCaller, input: HandoffInput) {
    const summary = input.summary.trim();
    const decisions = clean(input.decisions, "decisions");
    const constraints = clean(input.constraints, "constraints");
    const openQuestions = clean(input.openQuestions, "open questions");
    const files = cleanFiles(input.files);
    const mayDecide = clean(input.mayDecide, "may-decide items");
    const alwaysAsk = clean(input.alwaysAsk, "always-ask items");
    this.checkHandoff({ summary, decisions, constraints, openQuestions });

    const { room, seatId } = await this.createRoom(caller, {
      goal: input.goal,
      myRole: input.myRole?.trim() || "owner",
      inviteRoles: [input.toRole],
      turnLimit: HANDOFF_LIMITS.actionsPerRoom,
      deadlineDays: input.deadlineDays,
    });
    const now = this.now();
    await inTx(this.db, async (tx) => {
      await tx.query(`UPDATE rooms SET mode = 'handoff' WHERE id = $1`, [room.id]);
      await tx.query(
        `INSERT INTO charters (room_id, may_decide, always_ask, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
        [room.id, JSON.stringify(mayDecide), JSON.stringify(alwaysAsk), now],
      );
      await this.insertVersion(tx, room.id, seatId, 1, { summary, decisions, constraints, openQuestions, files, changeNote: null });
      await tx.query(`UPDATE participants SET last_handoff_version = 1 WHERE id = $1`, [seatId]);
    });
    const invite = await this.createInvite(caller, room.id, { role: input.toRole, note: input.note });
    return { roomId: room.id, invite, myRole: room.planned_roles[0]! };
  }

  /** A new version of the handoff (e.g. after a decision changed). Any seated side may update it. */
  async updateHandoff(
    caller: AgentCaller,
    roomId: string,
    input: { summary: string; decisions?: string[]; constraints?: string[]; openQuestions?: string[]; files?: { name: string; content: string }[]; changeNote: string },
  ) {
    const summary = input.summary.trim();
    const decisions = clean(input.decisions, "decisions");
    const constraints = clean(input.constraints, "constraints");
    const openQuestions = clean(input.openQuestions, "open questions");
    const files = cleanFiles(input.files);
    const changeNote = input.changeNote.trim().slice(0, LIMITS.note);
    if (!changeNote) throw new RoomError("invalid", "Say in a line what changed (change_note).");
    this.checkHandoff({ summary, decisions, constraints, openQuestions });
    return inTx(this.db, async (tx) => {
      const room = await this.handoffRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "post");
      await this.refresh(tx, room, seats);
      this.assertOpen(room);
      const { rows } = await tx.query<{ v: number }>(`SELECT COALESCE(MAX(version), 0) AS v FROM handoffs WHERE room_id = $1`, [room.id]);
      const version = rows[0]!.v + 1;
      await this.insertVersion(tx, room.id, me.id, version, { summary, decisions, constraints, openQuestions, files, changeNote });
      await tx.query(`UPDATE participants SET last_handoff_version = $2 WHERE id = $1`, [me.id, version]);
      await this.ledger(tx, room, me, "handoff", room.turns_used, estimateTokens(summary, ...decisions, ...constraints, ...openQuestions, ...files.map((f) => f.content)));
      return { version };
    });
  }

  async ask(caller: AgentCaller, roomId: string, input: { question: string; toRole?: string }) {
    const body = input.question.trim();
    if (!body) throw new RoomError("invalid", "The question is empty.");
    if (body.length > HANDOFF_LIMITS.question) throw new RoomError("invalid", `Keep a question under ${HANDOFF_LIMITS.question} characters.`);
    return inTx(this.db, async (tx) => {
      const room = await this.handoffRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "post");
      await this.refresh(tx, room, seats);
      this.assertOpen(room);
      this.useAction(room);
      const others = room.planned_roles.filter((r) => r !== me.role);
      let toRole = input.toRole?.trim().toLowerCase();
      if (!toRole) {
        if (others.length !== 1) throw new RoomError("invalid", `Say which role to ask: ${others.join(", ")}.`);
        toRole = others[0]!;
      }
      if (toRole === me.role || !others.includes(toRole)) {
        throw new RoomError("invalid", `to_role must be another role in this handoff: ${others.join(", ")}.`);
      }
      const { rows: n } = await tx.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM questions WHERE room_id = $1`, [room.id]);
      if (n[0]!.c >= HANDOFF_LIMITS.questionsPerRoom) {
        throw new RoomError("limit", "This handoff has hit its question limit. Propose a result, or ask your user how to proceed.");
      }
      const { rows } = await tx.query<{ id: string; seq: number }>(
        `INSERT INTO questions (room_id, seq, asked_by, to_role, body, created_at)
         VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM questions WHERE room_id = $1), $2, $3, $4, $5) RETURNING id, seq`,
        [room.id, me.id, toRole, body, this.now()],
      );
      await this.ledger(tx, room, me, "ask", room.turns_used, estimateTokens(body));
      await this.save(tx, room);
      const answerer = seats.find((s) => s.role === toRole && isActive(s, this.now()));
      return { questionId: rows[0]!.id, seq: rows[0]!.seq, toRole, seated: !!answerer };
    });
  }

  async answer(caller: AgentCaller, roomId: string, input: { questionId: string; answer: string }) {
    const text = input.answer.trim();
    if (!text) throw new RoomError("invalid", "The answer is empty.");
    if (text.length > HANDOFF_LIMITS.answer) throw new RoomError("invalid", `Keep an answer under ${HANDOFF_LIMITS.answer} characters; attach longer material with update_handoff.`);
    return inTx(this.db, async (tx) => {
      const room = await this.handoffRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "post");
      await this.refresh(tx, room, seats);
      this.assertOpen(room);
      const q = await this.lockQuestion(tx, room.id, input.questionId);
      if (q.to_role !== me.role) throw new RoomError("forbidden", `That question is for the ${q.to_role} role.`);
      if (q.status === "answered") throw new RoomError("closed", "That question is already answered.");
      if (q.status === "escalated") {
        throw new RoomError("closed", "That question was escalated to your person; their answer will come from them.");
      }
      this.useAction(room);
      await tx.query(
        `UPDATE questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = $4 WHERE id = $1`,
        [q.id, text, me.id, this.now()],
      );
      await this.ledger(tx, room, me, "answer", room.turns_used, estimateTokens(text));
      await this.save(tx, room);
      return { seq: q.seq };
    });
  }

  /** The answering agent can't or shouldn't answer: send it to its own person. */
  async escalate(caller: AgentCaller, roomId: string, input: { questionId: string; reason: string }) {
    const reason = input.reason.trim().slice(0, HANDOFF_LIMITS.reason);
    if (!reason) throw new RoomError("invalid", "Say in a line why this needs your person (reason).");
    return inTx(this.db, async (tx) => {
      const room = await this.handoffRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      const me = this.mySeat(seats, caller, "post");
      await this.refresh(tx, room, seats);
      this.assertOpen(room);
      const q = await this.lockQuestion(tx, room.id, input.questionId);
      if (q.to_role !== me.role) throw new RoomError("forbidden", `That question is for the ${q.to_role} role.`);
      if (q.status !== "open") throw new RoomError("closed", `That question is already ${q.status}.`);
      await tx.query(`UPDATE questions SET status = 'escalated', escalated_by = $2, escalation_reason = $3 WHERE id = $1`, [q.id, me.id, reason]);
      await this.audit(tx, { roomId: room.id, userId: caller.userId, connectionId: caller.connectionId, participantId: me.id, action: "question.escalated", result: "ok", detail: { seq: q.seq, reason } });
      return { seq: q.seq, person: me.user_name, url: this.roomUrl(room.id) };
    });
  }

  /** A person answers a question their agent escalated (web app; Slack later). */
  async answerAsPerson(userId: string, roomId: string, questionId: string, answerText: string, remember: boolean) {
    const text = answerText.trim();
    if (!text) throw new RoomError("invalid", "Write an answer first.");
    if (text.length > HANDOFF_LIMITS.answer) throw new RoomError("invalid", "That answer is too long.");
    return inTx(this.db, async (tx) => {
      const room = await this.handoffRoom(tx, roomId);
      const seats = await this.seats(tx, room.id);
      await this.refresh(tx, room, seats);
      this.assertOpen(room);
      const q = await this.lockQuestion(tx, room.id, questionId);
      const escalator = seats.find((s) => s.id === q.escalated_by);
      if (q.status !== "escalated" || !escalator) throw new RoomError("closed", "That question isn't waiting on a person.");
      if (escalator.user_id !== userId) throw new RoomError("forbidden", `This one is waiting on ${escalator.user_name}.`);
      await tx.query(
        `UPDATE questions SET status = 'answered', answer = $2, answered_by = $3, answered_by_user = $4, answered_at = $5 WHERE id = $1`,
        [q.id, text, escalator.id, userId, this.now()],
      );
      if (remember) {
        await tx.query(
          `UPDATE charters SET decided = decided || $2::jsonb, updated_at = $3 WHERE room_id = $1`,
          [room.id, JSON.stringify([{ question: q.body, answer: text, by: escalator.user_name }]), this.now()],
        );
      }
      await this.audit(tx, { roomId: room.id, userId, participantId: escalator.id, action: "question.answered_by_person", result: "ok", detail: { seq: q.seq, remember } });
    });
  }

  /** Everything waiting for this agent, across its rooms. Marks answers to its own questions as picked up. */
  async inbox(caller: AgentCaller): Promise<InboxItem[]> {
    const { rows: seatRows } = await this.db.query<{ room_id: string }>(
      `SELECT room_id FROM participants WHERE connection_id = $1 AND left_at IS NULL ORDER BY joined_at DESC LIMIT 50`,
      [caller.connectionId],
    );
    const items: InboxItem[] = [];
    for (const { room_id } of seatRows) {
      let v: RoomView;
      try {
        v = await this.readRoom(caller, room_id, { markRead: false });
      } catch (err) {
        if (err instanceof RoomError) continue;
        throw err;
      }
      const me = v.me!;
      const base = { roomId: v.room.id, goal: v.room.goal, myRole: me.role };
      if (v.room.status === "proposed") {
        items.push({ ...base, kind: "room_status", text: "A result is waiting for approval by the people in this room. Nothing to do." });
        continue;
      }
      if (v.room.status !== "open") continue;
      const h = v.handoff;
      if (!h) {
        const fresh = v.room.turns_used - me.last_read_turn;
        if (fresh > 0) items.push({ ...base, kind: "room_status", text: `${fresh} new message(s) in this room. Call read_room.` });
        continue;
      }
      if (h.latest && h.latest.version > me.last_handoff_version) {
        items.push({ ...base, kind: "new_handoff_version", text: `Handoff updated to version ${h.latest.version}: ${h.latest.change_note ?? "first version"}. Call read_room to read it.` });
      }
      for (const q of h.questions) {
        if (q.to_role === me.role && q.status === "open") {
          items.push({ ...base, kind: "question_for_you", questionId: q.id, text: q.body });
        }
        if (q.to_role === me.role && q.status === "escalated") {
          items.push({ ...base, kind: "waiting_on_person", questionId: q.id, text: `Q${q.seq} is waiting on your person (${me.user_name}).` });
        }
        if (q.asked_by === me.id && q.status === "answered" && !q.asker_seen) {
          items.push({ ...base, kind: "your_answer", questionId: q.id, text: `Q${q.seq}: ${q.body}\nAnswer${q.answered_by_user ? ` (from ${q.answered_by_name}, a person)` : ""}: ${q.answer}` });
        }
      }
      await this.db.query(`UPDATE questions SET asker_seen = true WHERE room_id = $1 AND asked_by = $2 AND status = 'answered'`, [v.room.id, me.id]);
      if (h.latest) await this.db.query(`UPDATE participants SET last_handoff_version = $2 WHERE id = $1`, [me.id, h.latest.version]);
    }
    return items;
  }

  /** In a handoff, propose only when no question is waiting on a person. */
  override async propose(caller: AgentCaller, roomId: string, input: { summary: string; changes?: string[]; openQuestions?: string[] }) {
    const { rows } = await this.db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM questions q JOIN rooms r ON r.id = q.room_id
        WHERE q.room_id = $1 AND q.status = 'escalated' AND r.mode = 'handoff'`,
      [/^[0-9a-f-]{36}$/i.test(roomId) ? roomId : "00000000-0000-0000-0000-000000000000"],
    );
    if (rows[0]!.c > 0) {
      throw new RoomError("not_your_turn", `${rows[0]!.c} question(s) are waiting on a person's answer. Propose once they're answered.`);
    }
    return super.propose(caller, roomId, input);
  }

  // ---------- helpers ----------

  protected override async handoffInfo(q: Queryable, roomId: string): Promise<HandoffInfo> {
    const { rows: c } = await q.query<{ may_decide: string[]; always_ask: string[]; decided: HandoffInfo["charter"]["decided"] }>(
      `SELECT may_decide, always_ask, decided FROM charters WHERE room_id = $1`,
      [roomId],
    );
    const { rows: v } = await q.query<HandoffVersion & { n: number }>(
      `SELECT *, (SELECT COUNT(*)::int FROM handoffs WHERE room_id = $1) AS n FROM handoffs WHERE room_id = $1 ORDER BY version DESC LIMIT 1`,
      [roomId],
    );
    const { rows: qs } = await q.query<Question>(
      `SELECT q.*, u.name AS answered_by_name FROM questions q LEFT JOIN users u ON u.id = q.answered_by_user
        WHERE q.room_id = $1 ORDER BY q.seq`,
      [roomId],
    );
    return {
      charter: c[0] ?? { may_decide: [], always_ask: [], decided: [] },
      latest: v[0] ?? null,
      versions: v[0]?.n ?? 0,
      questions: qs,
    };
  }

  private async insertVersion(
    tx: Tx,
    roomId: string,
    seatId: string,
    version: number,
    d: { summary: string; decisions: string[]; constraints: string[]; openQuestions: string[]; files: { name: string; content: string }[]; changeNote: string | null },
  ) {
    await tx.query(
      `INSERT INTO handoffs (room_id, participant_id, version, summary, decisions, constraints, open_questions, files, change_note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [roomId, seatId, version, d.summary, JSON.stringify(d.decisions), JSON.stringify(d.constraints), JSON.stringify(d.openQuestions), JSON.stringify(d.files), d.changeNote, this.now()],
    );
  }

  private async handoffRoom(tx: Tx, roomId: string): Promise<Room> {
    const room = await this.lockRoom(tx, roomId);
    if (room.mode !== "handoff") throw new RoomError("invalid", "That room isn't a handoff. Use post and read_room there.");
    return room;
  }

  private async lockQuestion(tx: Tx, roomId: string, questionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(questionId)) throw new RoomError("not_found", "No such question in this room.");
    const { rows } = await tx.query<Question>(`SELECT * FROM questions WHERE id = $1 AND room_id = $2 FOR UPDATE`, [questionId, roomId]);
    if (!rows[0]) throw new RoomError("not_found", "No such question in this room.");
    return rows[0];
  }

  private assertOpen(room: Room) {
    if (room.status === "proposed") throw new RoomError("closed", "A result is waiting for approval; nothing more can be added.");
    if (room.status !== "open") throw new RoomError("closed", `This handoff is ${room.status}${room.close_reason ? `: ${room.close_reason}` : ""}.`);
  }

  /** Every ask, answer and post counts against the room's action limit (the loop guard). */
  private useAction(room: Room) {
    if (room.turns_used >= room.turn_limit) {
      throw new RoomError("limit", `This handoff used all ${room.turn_limit} actions. Propose a result now, or ask your user.`);
    }
    room.turns_used += 1;
  }
}
