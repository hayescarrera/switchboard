/**
 * The web app: sign-in, connecting an agent (OAuth consent), joining a room,
 * approving a proposal, and the room record. Agents never come here; humans do.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { SESSION_COOKIE, SignInError, type User, type Users } from "../auth/users.js";
import { FailureLimiter } from "../auth/passwords.js";
import type { OAuthProvider } from "../auth/oauth.js";
import { RoomError, type RoomService, type RoomView, type Seat } from "../rooms/service.js";
import { fmtDate, html, page, raw, signInBlock, type Html } from "./html.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: User | null;
  }
}

export interface WebDeps {
  users: Users;
  rooms: RoomService;
  oauth: OAuthProvider;
  baseUrl: string;
  mcpUrl: string;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const SIGNIN_ERRORS: Record<string, string> = {
  bad: "That email and password don't match.",
  locked: "Too many tries. Wait 15 minutes and try again.",
};

/** Where to come back to after signing in: our own path only, never another site. */
function safeNext(v: unknown): string {
  const s = typeof v === "string" ? v : "/";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
}

function signInProps(req: Request) {
  const url = new URL(req.originalUrl, "http://x");
  const code = url.searchParams.get("signin_error");
  const msg = url.searchParams.get("signin_msg");
  url.searchParams.delete("signin_error");
  url.searchParams.delete("signin_msg");
  return {
    next: url.pathname + (url.search || ""),
    error: msg ? msg.slice(0, 200) : code ? (SIGNIN_ERRORS[code] ?? null) : null,
  };
}

export function webRouter(deps: WebDeps): express.Router {
  const { users, rooms, oauth, baseUrl, mcpUrl } = deps;
  const origin = new URL(baseUrl).origin;
  const secure = baseUrl.startsWith("https:");
  const r = express.Router();

  r.use(async (req, _res, next) => {
    try {
      req.user = await users.userForSession(readCookie(req, SESSION_COOKIE));
      next();
    } catch (err) {
      next(err);
    }
  });

  /** Web writes need the session cookie (SameSite=Lax) and a same-origin request. */
  function sameOrigin(req: Request, res: Response, next: NextFunction) {
    const o = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    // Some browsers send Origin: null for privacy; then rely on Sec-Fetch-Site.
    if (o && o !== "null" ? o === origin : site === "same-origin") return next();
    res.status(403).send(page({ title: "Blocked", body: html`<h1>Blocked</h1><p>That request didn't come from this site.</p>`, narrow: true }));
  }

  function setSession(res: Response, token: string, expires: Date) {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, expires, path: "/" });
  }

  const form = express.urlencoded({ extended: false, limit: "20kb" });
  const failures = new FailureLimiter();

  function backWithError(res: Response, next: string, err: { code?: string; msg?: string }) {
    const u = new URL(next, "http://x");
    if (err.code) u.searchParams.set("signin_error", err.code);
    if (err.msg) u.searchParams.set("signin_msg", err.msg);
    res.redirect(303, u.pathname + u.search);
  }
  const json = express.json({ limit: "64kb" });

  // ---------- email + password ----------

  r.post("/auth/password/register", sameOrigin, form, async (req, res) => {
    const next = safeNext(req.body?.next);
    try {
      const user = await users.registerWithPassword({ name: req.body?.name, email: req.body?.email, password: req.body?.password });
      const s = await users.createSession(user.id);
      setSession(res, s.token, s.expires);
      res.redirect(303, next);
    } catch (err) {
      if (err instanceof SignInError) return backWithError(res, next, { msg: err.message });
      throw err;
    }
  });
  r.post("/auth/password/sign-in", sameOrigin, form, async (req, res) => {
    const next = safeNext(req.body?.next);
    const key = `${String(req.body?.email ?? "").trim().toLowerCase()}|${req.ip}`;
    if (failures.blocked(key)) return backWithError(res, next, { code: "locked" });
    try {
      const user = await users.signInWithPassword(String(req.body?.email ?? ""), String(req.body?.password ?? ""));
      failures.clear(key);
      const s = await users.createSession(user.id);
      setSession(res, s.token, s.expires);
      res.redirect(303, next);
    } catch (err) {
      if (!(err instanceof SignInError)) throw err;
      failures.fail(key);
      backWithError(res, next, { code: "bad" });
    }
  });

  // ---------- passkeys ----------

  r.post("/auth/passkey/register/options", sameOrigin, json, async (req, res) => {
    try {
      res.json(await users.registrationOptions({ name: req.body?.name, existingUser: req.user }));
    } catch (err) {
      if (err instanceof SignInError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
  r.post("/auth/passkey/register/verify", sameOrigin, json, async (req, res) => {
    try {
      const user = await users.finishRegistration(String(req.body?.challengeId), req.body?.response);
      if (!req.user) {
        const s = await users.createSession(user.id);
        setSession(res, s.token, s.expires);
      }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof SignInError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
  r.post("/auth/passkey/sign-in/options", sameOrigin, async (_req, res) => {
    res.json(await users.signInOptions());
  });
  r.post("/auth/passkey/sign-in/verify", sameOrigin, json, async (req, res) => {
    try {
      const user = await users.finishSignIn(String(req.body?.challengeId), req.body?.response);
      const s = await users.createSession(user.id);
      setSession(res, s.token, s.expires);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof SignInError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
  r.post("/auth/sign-out", sameOrigin, async (req, res) => {
    await users.endSession(readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect(303, "/");
  });

  // ---------- home ----------

  r.get("/", async (req, res) => {
    if (!req.user) {
      return res.send(
        page({
          title: "Sign in",
          narrow: true,
          body: html`
            <h1>Your agents, in one room</h1>
            <p class="sub">Tekhnea lets your Claude, your ChatGPT, or someone else's agent work on one goal together. You approve only the result.</p>
            ${signInBlock("Sign in to see your rooms and connected agents.", signInProps(req))}`,
        }),
      );
    }
    const [conns, list] = await Promise.all([users.connections(req.user.id), rooms.roomsForHuman(req.user.id)]);
    res.send(
      page({
        title: "Home",
        user: req.user,
        body: html`
          <h1>Hi ${req.user.name}</h1>
          <section class="card">
            <h2>Rooms</h2>
            ${
              list.length
                ? html`<ul class="rows">${list.map(
                    (v) => html`<li><a href="/rooms/${v.room.id}">${v.room.goal.slice(0, 140)}</a>
                      <span class="pill ${v.room.status}">${statusWord(v)}</span></li>`,
                  )}</ul>`
                : html`<p class="muted">No rooms yet. Ask one of your connected agents to “create a Tekhnea room” for a goal.</p>`
            }
          </section>
          <section class="card">
            <h2>Connected agents</h2>
            ${
              conns.length
                ? html`<ul class="rows">${conns.map(
                    (c) => html`<li><span><strong>${c.label}</strong> <span class="muted">${c.vendor} · ${c.seats} room seat${c.seats === "1" ? "" : "s"}</span></span>
                      <form method="post" action="/agents/${c.id}/disconnect" data-confirm="Disconnect ${c.label}? Its tokens stop working and it leaves its rooms.">
                        <button class="link danger">Disconnect</button></form></li>`,
                  )}</ul>`
                : html`<p class="muted">None yet. Add Tekhnea to your AI app with the address below.</p>`
            }
            ${connectHelp(mcpUrl)}
          </section>
          <section class="card">
            <h2>Passkeys</h2>
            <p class="muted">Add a passkey on another device (say, your phone) so you can approve from there too.</p>
            <form data-passkey="register" class="inline"><button>Add a passkey on this device</button></form>
            <p class="error" data-passkey-error role="alert" hidden></p>
          </section>`,
      }),
    );
  });

  r.post("/agents/:id/disconnect", sameOrigin, async (req, res) => {
    if (!req.user) return res.redirect(303, "/");
    await users.revokeConnection(req.user.id, String(req.params.id));
    res.redirect(303, "/");
  });

  // ---------- connect an agent (OAuth consent) ----------

  r.get("/connect/:id", async (req, res) => {
    const pending = await oauth.pendingRequest(String(req.params.id));
    if (!pending) {
      return res.status(400).send(
        page({
          title: "Link expired",
          narrow: true,
          user: req.user,
          body: html`<h1>This connect link has expired</h1><p>Go back to your AI app and start connecting Tekhnea again.</p>`,
        }),
      );
    }
    const app = pending.client.client_name || "An AI app";
    const back = new URL(pending.params.redirectUri).host;
    if (!req.user) {
      return res.send(
        page({
          title: "Connect",
          narrow: true,
          body: html`<h1>Connect ${app}</h1>${signInBlock(`Sign in so ${app} can act as your agent in Tekhnea rooms.`, signInProps(req))}`,
        }),
      );
    }
    const existing = (await users.connections(req.user.id)).filter((c) => c.vendor === pending.client.client_name);
    res.send(
      page({
        title: "Connect",
        narrow: true,
        user: req.user,
        body: html`
          <h1>Connect ${app}?</h1>
          <section class="card">
            <p><strong>${app}</strong> (returns to <code>${back}</code>) wants to be your agent in Tekhnea rooms.</p>
            <p>It will be able to create rooms, read the rooms you seat it in, and post and propose there on its turn.
               It can't approve anything or accept invites; only you can, here.</p>
            <form method="post" action="/connect/${pending.id}" class="stack">
              ${
                existing.length
                  ? html`<fieldset><legend>Which agent is this?</legend>
                      ${existing.map(
                        (c, i) => html`<label class="choice"><input type="radio" name="reuse" value="${c.id}" ${i === 0 ? raw("checked") : ""}>
                          Reconnect <strong>${c.label}</strong> <span class="muted">(keeps its ${c.seats} room seat${c.seats === "1" ? "" : "s"})</span></label>`,
                      )}
                      <label class="choice"><input type="radio" name="reuse" value="">A new agent</label></fieldset>`
                  : ""
              }
              <label>Name this agent <input name="label" maxlength="60" value="${`${req.user.name.split(" ")[0]}'s ${app}`}"></label>
              <div class="actions">
                <button class="primary" name="decision" value="allow">Connect</button>
                <button name="decision" value="deny">Cancel</button>
              </div>
            </form>
          </section>`,
      }),
    );
  });

  r.post("/connect/:id", sameOrigin, form, async (req, res) => {
    if (!req.user) return res.redirect(303, `/connect/${req.params.id}`);
    const allow = req.body?.decision === "allow";
    const target = await oauth.decide(
      String(req.params.id),
      allow
        ? { allow: true, userId: req.user.id, label: String(req.body?.label ?? ""), reuseConnectionId: req.body?.reuse || undefined }
        : { allow: false },
    );
    if (!target) return res.redirect(303, `/connect/${req.params.id}`);
    res.redirect(303, target);
  });

  // ---------- join a room ----------

  r.get("/join/:token", async (req, res) => {
    const found = await rooms.inviteByToken(String(req.params.token));
    if (!found.ok) {
      return res.status(400).send(page({ title: "Join", narrow: true, user: req.user, body: html`<h1>Can't join</h1><p>${found.reason}</p>` }));
    }
    const inv = found.invite;
    const summary = html`
      <section class="card">
        <p class="muted">${inv.owner_name} invited you to take the <strong>${inv.role}</strong> seat in a room.</p>
        <p class="label">Goal (written by ${inv.owner_name})</p>
        <blockquote>${inv.goal}</blockquote>
        ${inv.note ? html`<p class="muted">Note: ${inv.note}</p>` : ""}
        <p class="muted">The seat may: ${inv.scopes.join(", ")}. Link expires ${fmtDate(inv.expires_at)}.</p>
      </section>`;
    if (!req.user) {
      return res.send(page({ title: "Join", narrow: true, body: html`<h1>Join a room</h1>${summary}${signInBlock("Sign in to pick which of your AI agents takes this seat.", signInProps(req))}` }));
    }
    const conns = await users.connections(req.user.id);
    const body = conns.length
      ? html`<form method="post" action="/join/${req.params.token}" class="card stack">
          <fieldset><legend>Which of your agents takes the ${inv.role} seat?</legend>
          ${conns.map(
            (c, i) => html`<label class="choice"><input type="radio" name="connection" value="${c.id}" ${i === conns.length - 1 ? raw("checked") : ""}>
              <strong>${c.label}</strong> <span class="muted">${c.vendor}</span></label>`,
          )}</fieldset>
          <p class="hint">Don't see the agent you want? Connect it first (below), then reload this page. The link stays valid.</p>
          <button class="primary">Join as ${inv.role}</button>
        </form>
        <section class="card">${connectHelp(mcpUrl)}</section>`
      : html`<section class="card"><h2>First, connect your AI</h2>
          <p>You don't have an agent connected yet. Add Tekhnea to Claude or ChatGPT, then come back and reload this page. The link stays valid.</p>
          ${connectHelp(mcpUrl)}</section>`;
    res.send(page({ title: "Join", narrow: true, user: req.user, body: html`<h1>Join a room</h1>${summary}${body}` }));
  });

  r.post("/join/:token", sameOrigin, form, async (req, res) => {
    if (!req.user) return res.redirect(303, `/join/${req.params.token}`);
    try {
      const { roomId } = await rooms.acceptInvite(req.user.id, String(req.params.token), String(req.body?.connection ?? ""));
      res.redirect(303, `/rooms/${roomId}`);
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      res.status(400).send(page({ title: "Join", narrow: true, user: req.user, body: html`<h1>Couldn't join</h1><p>${err.message}</p><p><a href="/join/${req.params.token}">Back</a></p>` }));
    }
  });

  // ---------- rooms ----------

  r.get("/rooms/:id", async (req, res) => {
    if (!req.user) {
      return res.send(page({ title: "Room", narrow: true, body: html`<h1>Sign in to see this room</h1>${signInBlock("Only people with a seat in a room can see it.", signInProps(req))}` }));
    }
    try {
      const v = await rooms.roomForHuman(req.user.id, String(req.params.id));
      res.send(page({ title: "Room", user: req.user, body: roomPage(v, req.user) }));
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      res.status(404).send(page({ title: "Room", narrow: true, user: req.user, body: html`<h1>Room not found</h1><p>Either it doesn't exist or you don't have a seat in it.</p>` }));
    }
  });

  r.post("/rooms/:id/proposals/:pid/decide", sameOrigin, form, async (req, res) => {
    if (!req.user) return res.redirect(303, `/rooms/${req.params.id}`);
    const decision = req.body?.decision === "approve" ? "approve" : req.body?.decision === "reject" ? "reject" : null;
    if (!decision) return res.redirect(303, `/rooms/${req.params.id}`);
    try {
      await rooms.decide(req.user.id, String(req.params.id), String(req.params.pid), decision, req.body?.note);
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      return res.status(400).send(page({ title: "Room", narrow: true, user: req.user, body: html`<h1>Couldn't record that</h1><p>${err.message}</p><p><a href="/rooms/${req.params.id}">Back to the room</a></p>` }));
    }
    res.redirect(303, `/rooms/${req.params.id}`);
  });

  r.post("/rooms/:id/seats/:sid/remove", sameOrigin, async (req, res) => {
    if (!req.user) return res.redirect(303, `/rooms/${req.params.id}`);
    try {
      await rooms.revokeSeat(req.user.id, String(req.params.id), String(req.params.sid));
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
    }
    res.redirect(303, `/rooms/${req.params.id}`);
  });

  r.get("/rooms/:id/audit.json", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in first." });
    try {
      const rows = await rooms.exportAudit(req.user.id, String(req.params.id));
      res.setHeader("Content-Disposition", `attachment; filename="tekhnea-room-${req.params.id}-audit.json"`);
      res.json({ room_id: req.params.id, exported_at: new Date().toISOString(), entries: rows });
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      res.status(404).json({ error: "Room not found." });
    }
  });

  return r;
}

function statusWord(v: RoomView): string {
  if (v.room.status === "proposed") return "Waiting for approval";
  if (v.room.status === "approved") return "Approved";
  if (v.room.status === "closed") return "Closed";
  return "In progress";
}

function connectHelp(mcpUrl: string): Html {
  return html`
    <details class="help">
      <summary>How to connect an AI app</summary>
      <p class="label">Tekhnea's connector address</p>
      <p><code class="copy" data-copy>${mcpUrl}</code></p>
      <ol>
        <li><strong>Claude</strong> (Free, Pro, Max): Customize → Connectors → Add custom connector → paste the address → Add, then Connect and sign in here.
          On Team or Enterprise an owner adds it under Organization settings → Connectors first.</li>
        <li><strong>ChatGPT</strong> (Business, Enterprise or Edu): turn on Developer mode (Business: an admin, under Workspace settings → Permissions &amp; Roles),
          then Settings → Apps → Create → paste the address, choose OAuth → Scan tools → sign in here.
          On Pro, ChatGPT can only read rooms, not post.</li>
        <li><strong>Others</strong> (Cursor, Copilot, any MCP client): add a remote MCP server with this address.</li>
      </ol>
      <p class="hint">Menu names change; if a step doesn't match, look for “custom connector” or “MCP server”.</p>
    </details>`;
}

function roomPage(v: RoomView, user: User): Html {
  const { room, seats } = v;
  const byId = new Map(seats.map((s) => [s.id, s]));
  const name = (id: string) => {
    const s = byId.get(id);
    return s ? `${s.role} · ${s.agent_label}` : "unknown";
  };
  const current = seats.find((s) => s.id === room.current_participant_id);
  const isOwner = room.owner_user_id === user.id;
  const pending = v.proposals.find((p) => p.status === "pending");
  const myDecision = pending?.decisions.find((d) => d.user_id === user.id);
  const openRoles = room.planned_roles.filter((r) => !seats.some((s) => s.role === r));

  const seatRow = (s: Seat) => {
    const ledger = v.ledger.find((l) => l.participant_id === s.id);
    const gone = s.grant_revoked_at ? "removed" : s.left_at ? "left" : null;
    return html`<li>
      <span><strong>${s.role}</strong> · ${s.agent_label} <span class="muted">for ${s.user_name}</span>
        ${gone ? html`<span class="pill closed">${gone}</span>` : ""}
        ${current?.id === s.id && room.status === "open" ? html`<span class="pill turn">Their turn</span>` : ""}</span>
      <span class="muted">${ledger?.posts ?? 0} post${ledger?.posts === 1 ? "" : "s"} · ~${ledger?.est_tokens ?? 0} tokens</span>
      ${!gone && (isOwner || s.user_id === user.id) && (room.status === "open" || room.status === "proposed")
        ? html`<form method="post" action="/rooms/${room.id}/seats/${s.id}/remove" data-confirm="Remove the ${s.role} seat? That agent loses access to this room.">
            <button class="link danger">Remove</button></form>`
        : ""}
    </li>`;
  };

  return html`
    <p class="crumbs"><a href="/">Home</a> / Room</p>
    <div class="room-head">
      <h1>${room.goal}</h1>
      <span class="pill ${room.status}">${statusWord(v)}</span>
    </div>
    <p class="muted">${room.turns_used} of ${room.turn_limit} turns used · closes ${fmtDate(room.deadline)}
      ${room.close_reason ? html` · ${room.close_reason}` : ""}</p>

    ${
      pending
        ? html`<section class="card decision">
            <h2>Proposal from ${name(pending.participant_id)}</h2>
            <p class="warn">Written by an AI agent. Read it before approving.</p>
            <div class="prose">${pending.summary}</div>
            ${pending.changes.length ? html`<h3>Changes</h3><ul>${pending.changes.map((c) => html`<li>${c}</li>`)}</ul>` : ""}
            ${pending.open_questions.length ? html`<h3>Open questions</h3><ul>${pending.open_questions.map((c) => html`<li>${c}</li>`)}</ul>` : ""}
            <p class="muted">Needs approval from ${v.approvers.map((a) => a.name).join(", ")}.
              ${pending.decisions.map((d) => html` ${d.user_name}: ${d.decision === "approve" ? "approved" : "rejected"}.`)}</p>
            ${
              myDecision
                ? html`<p>You ${myDecision.decision === "approve" ? "approved" : "rejected"} this.</p>`
                : v.approvers.some((a) => a.user_id === user.id)
                  ? html`<form method="post" action="/rooms/${room.id}/proposals/${pending.id}/decide" class="stack">
                      <label>Note (optional) <input name="note" maxlength="500"></label>
                      <div class="actions">
                        <button class="primary" name="decision" value="approve">Approve</button>
                        <button class="danger" name="decision" value="reject" data-confirm="Reject this proposal? The room closes.">Reject</button>
                      </div></form>`
                  : ""
            }
          </section>`
        : ""
    }

    <section class="card">
      <h2>Seats</h2>
      <ul class="rows">${seats.map(seatRow)}</ul>
      ${openRoles.length ? html`<p class="muted">Not joined yet: ${openRoles.join(", ")}. Ask the owner's agent to “invite” that role for a join link.</p>` : ""}
    </section>

    <section class="card">
      <h2>Conversation</h2>
      ${v.messages.length ? "" : html`<p class="muted">Nothing posted yet.</p>`}
      <ol class="thread">
        ${v.messages.map(
          (m) => html`<li>
            <p class="meta">Turn ${m.turn_no} · <strong>${name(m.participant_id)}</strong> · ${fmtDate(m.created_at)}
              ${m.next_role ? html` · asked ${m.next_role} next` : ""}</p>
            <div class="prose">${m.body}</div>
            ${m.attachments.map((a) => html`<details class="file"><summary>${a.name}</summary><pre>${a.content}</pre></details>`)}
          </li>`,
        )}
      </ol>
    </section>

    ${
      v.proposals.filter((p) => p.status !== "pending").length
        ? html`<section class="card"><h2>Past proposals</h2>${v.proposals
            .filter((p) => p.status !== "pending")
            .map((p) => html`<div class="past"><p class="meta">${name(p.participant_id)} · <span class="pill ${p.status}">${p.status}</span></p>
              <div class="prose">${p.summary}</div>
              ${p.changes.length ? html`<ul>${p.changes.map((c) => html`<li>${c}</li>`)}</ul>` : ""}</div>`)}</section>`
        : ""
    }

    <p class="muted"><a href="/rooms/${room.id}/audit.json">Download the audit log</a> (every tool call and decision in this room).</p>`;
}
