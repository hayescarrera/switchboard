# CLAUDE.md — Switchboard (working name)

Read this whole file before writing any code. It is the single source of truth for what we are building, why, and in what order. If something here conflicts with a later instruction from Ben, Ben wins. Then update this file so the next session knows.

---

## 1. The one-paragraph version

People now work across many AI agents: Claude, Grok, ChatGPT, Rovo, Cursor, and whatever comes next. The agents do the work, but the human is still the **meat proxy**. The human copies context out of one agent and pastes it into another, re-explains, and babysits a new chat in every app. Worse, the human has to **remember**: remember to go take the output from one agent to the next, remember what's waiting, remember who needs what. The agents sit idle waiting on the human. Switchboard is the **personal agent-to-agent layer** that takes the human out of the middle. Your agents message each other directly, act on those messages on their own, ask each other follow-up questions, chase each other when something is waiting, and only pull you in to approve or to resolve something they can't. On top sits a **canvas** where you design the web of how you work: agents and chats are boxes, and the lines between them say who can talk to whom and what context crosses.

**Mission:** your agents talk to each other, so you don't have to be the go-between, or even remember to be.

**Why now, and why us:** Companies won't open their agents to each other. Google, Microsoft, Anthropic, xAI, Atlassian and others are slow to make agent-to-agent (A2A) work across vendors, and inside a company there's a long authorization fight before anyone's agents can talk. But when *you* install Switchboard, you are the one authorizing it. These are your agents, acting for you, with your accounts. Personal consent is the unlock the companies can't give themselves. We build the adapters so agents behave as if they already speak A2A, today.

**Analogy:** Plaid. Banks dragged their feet on open APIs; Plaid built the connections itself, on the user's authorization, and became the layer everyone used.

---

## 2. Who it's for

**The non-developer heavy AI user.** Most new AI tooling is built for developers. Switchboard is for the first wave of people who use AI all day for their job but don't write code and don't want to build their own setup: they want their assistants to work together and to see what's going on. Usually they are **employees** using several assistants for their own role (running their role like their own small business); sometimes founders, consultants or PMs. They pay for 2+ assistants (Claude, ChatGPT, Grok, Rovo, Gemini...), lose track of which chat holds what, and spend their day being the meat proxy between them.

- **First user: Ben.** He is that user: a heavy AI user for years, not a software engineer. Thinks visually, Figma-style. Uses Claude, Grok, Rovo and others day to day. Has agents and chats everywhere, loses track of them, and spends his day remembering to move things between them and copy-pasting. Approves everything before it goes out; doesn't trust blind sends yet. **He is building it for himself first**; his own hand-done handoffs decide what gets built next.
- **Second user: someone Ben works with.** Receives work from Ben's agents into their own. Proves the cross-person loop, which is the part companies can't do for themselves.
- **Then:** lots of individuals like Ben (it must stay lightweight and self-serve to reach many of them), then small teams (2–30 people). Individuals spread it (free tier); teams pay (per seat).

Not for: developers looking for an orchestration framework (plenty exist), or enterprises buying an agent governance platform (Salesforce Agent Fabric, Kong, cloud registries own that).

**Why it can win:** every AI vendor is trying to keep users on its own platform, which is reasonable. But people already use more than one. Whoever communicates best *between* them provides the value.

---

## 3. Product principles (do not violate these)

1. **One conversation, many workers.** The user talks in one place. The next agent builds off the whole conversation the user just had. No new chat per app, no re-typing.
2. **Nobody has to remember.** If work is waiting on an agent, the agents chase it, not the user. The hub follows up, routes results to the next agent, and keeps a single "waiting on you" list for the few things that truly need the user.
3. **Personal authorization.** The user owns their agents. Connecting an agent and drawing a line *is* the consent for those agents to talk. We act on the user's behalf, within the lines they drew, and nothing more.
4. **The user designs the web.** The canvas is where they connect agents, chats and channels and draw lines between them. Each line = permission + what context crosses.
5. **Adding a tool = connect + draw a line.** No workflow building, no flow editor with branches.
6. **Granular by line, not by app.** "This chat can reach Grok and the support channel; that one only Jira."
7. **One tab, any device.** Laptop and phone. Watch agents talk, approve, redirect.
8. **User signs off; agents carry.** Approval-required actions never run without a yes. Everything else moves without the user.
9. **Live where the user already talks. Do NOT build a chat app.** We don't compete with Claude's or Grok's chat. The layer sits behind the chats people already use. The canvas is for designing and watching, not for chatting.
10. **We connect agents to agents, not agents to tools.** Plenty of products connect an agent to Gmail or Notion. That's not us. If a feature is "give agent X access to tool Y," it belongs to the agent's own app, not to Switchboard.
11. **Not an automation tool.** n8n/Zapier/Make build fixed pipes in advance. We route in the moment, with context traveling with the work. If a feature starts to look like "build a flow first," stop and rethink.
12. **Not a task queue.** If a receiving agent only picks up work when the human tells it to, the human is still the proxy. Every connected agent must be able to receive, act, and reply on its own.

---

## 4. What "connected" means

Every agent on the hub gets five things:

1. **An address.** An agent card: who it is, what it can do (A2A Agent Card shape).
2. **An inbox.** It can receive a task or a question from another agent.
3. **The ability to act.** It runs on that message without anyone opening its app.
4. **A way back.** It can answer, ask a question back, report progress, or say it's done.
5. **A shared thread.** Every agent in the exchange reads the same context; nothing is re-explained, and no agent works from stale state. If Jira closed the ticket, the user's Claude chat must not come back thinking it's still open.

### 4.1 Ways an agent can join

Agents differ a lot in what they allow. The hub supports four connection paths and picks the best one each vendor offers:

| Path | What it means | Examples (verify current support before building) |
| --- | --- | --- |
| **Native A2A** | The vendor exposes a real A2A endpoint. We call it directly. | Atlassian Rovo |
| **Agent API adapter** | The vendor has an API to launch and steer its agent. We wrap it in the adapter interface. | Cursor cloud agents |
| **Hub-run agent** | The vendor has a model API but no agent API. The hub runs an agent on that model, with the user's own key, holding the thread context. | Claude API, xAI (Grok) API, OpenAI API |
| **Chat entry point (MCP)** | The vendor's chat app can add our remote MCP connector. The user starts and checks threads from inside the chat they already use. | Claude app, Claude Code, Cursor; check others (Grok, ChatGPT) |

A single vendor can use more than one path. Claude is both a chat entry point (the user starts a thread from the Claude app) and a hub-run agent (the hub's Claude agent keeps the thread going afterwards).

---

## 5. The hero exchange (build until this works end to end)

**Chat to chat.** Ben plans something in his Claude chat, then says: "Have Grok research competitor pricing" (or "get ChatGPT to draft the brief"). No other app gets opened.

1. **Claude chat → Planner:** through the MCP connector, Claude hands over the whole conversation (goal, summary, plan, decisions, constraints, open questions, links) with `start_thread`. Too thin → rejected with what's missing.
2. **Planner → Grok:** the hub's Planner (Claude) hands the task on, with the context the line allows. Grok runs as a hub-run agent on Ben's xAI key.
3. **Grok → Planner:** asks a question ("which competitors?"). The Planner answers from Ben's decisions. Ben is not involved.
4. **Grok → Planner:** delivers the result. Every task has a result back, so the thread is done.
5. **When the Planner can't answer** ("one page or two?"), the question goes to Ben's waiting-on-you list. He answers from his chat (`answer_question`); the answer goes to the agent that asked and is remembered.
6. **Ben asks his Claude chat "where are we?"** It calls `catch_up` and sees the current state (Grok's result is in, the thread is done), not the state at handoff.
7. **The board** shows all of it live, on laptop or phone: nodes, lines, messages moving along the lines, waiting-on-you, and the self-answered count.

Ben did: one instruction (and, at most, one answer).

**Who "Claude" is after the handoff:** the hub cannot type into Ben's Claude app chat. Once `start_thread` is called, the hub's Planner carries the thread. Ben sees what happened on the board, or by asking his Claude chat, which checks in through the connector.

**Why not the old hero (Claude → Cursor → Jira → GitHub merge)?** Atlassian already ships that loop natively (Cursor in Jira, the Claude agent for Jira), and it's a developer loop. Chat to chat is the pain non-developer heavy AI users have every day.

### 5.1 Exchanges after the hero (to guide design, not v1 scope)

- **Research → writing:** Grok's research lands in the thread with sources, then ChatGPT drafts from it. No copy-paste. (Works today as two hand-offs on one thread; automatic chaining comes later.)
- **Rovo ↔ Claude:** Rovo answers questions from company knowledge (Confluence, Jira history) when the Planner needs them.
- **Ben's agent ↔ someone else's agent:** Ben's planner hands work to a colleague's agent, which asks its questions back and reports results, with both people's approval of the line.
- **Developer loop (the old hero):** Cursor adapter, GitHub merges, Jira. Only if Ben's own handoffs call for it.

Design the data model, adapters and canvas so these are "connect + draw a line," not new features.

---

## 6. Architecture

```
 Claude app / Claude Code / Cursor / other chats ──(remote MCP connector)──┐
                                                                           ▼
                                   ┌───────────────────── HUB ─────────────────────┐
  Board (web, phone + laptop) ◄───►│ API · Router · Lines (permissions) · Threads  │
                                   │ Approvals · Escalation · Follow-ups · Events  │
                                   │ A2A server (exposes agents) + A2A client      │
                                   └───┬───────────┬───────────┬───────────┬───────┘
                                       ▼           ▼           ▼           ▼
                                 Jira (REST,   Cursor      GitHub      Hub-run agents
                                 Rovo A2A      adapter     (PRs,       (Claude API; later
                                 later)       (agent API)  merges)     Grok, OpenAI)
```

### 6.1 Core data model

| Entity | Key fields |
| --- | --- |
| **User** | id, name, contact for notifications |
| **Agent** | id, name, vendor, kind (`a2a_native` / `adapter` / `hub_run` / `human`), agent card (skills), connection ref (credentials stored separately, encrypted), owner user, status |
| **Line** | id, from_node, to_node, allowed message types (`task`, `question`, `answer`, `status`, `result`), context scope (what fields cross), requires_approval rules, enabled, **owners** (one user, or both users for a cross-person line), **accepted_by** (each owner's acceptance) |
| **Thread** | id, title, goal, participants, shared context (summary, plan, decisions, constraints, open questions, links/files, **answers given by the user during escalations**), status (`active`, `waiting_on_user`, `done`, `blocked`), origin (which chat/agent started it), message count |
| **Message** | id, thread_id, from_agent, to_agent, type, body, attachments/links, created_at |
| **Run** | id, agent_id, thread_id, external ref (e.g. Cursor agent id), state, last_event_at, **timeout**, **cost cap**, cost so far |
| **Approval** | id, thread_id, requested_by agent, action (`merge`, `send_external`, `spend`, …), payload, status, decided_by, decided_at |
| **Event** | append-only log of every message, action, approval, permission check |

### 6.2 Router (the heart)

- Every message passes through the router.
- Router checks the **Line** between sender and receiver: does a line exist, is it accepted by every owner, is the message type allowed. It strips context to the line's scope. No valid line → reject and log.
- Delivers to the receiver via its adapter; records a Run.
- Collects adapter events (progress, question, result) and turns them into Messages back on the thread.
- If an action needs approval → pause, create Approval, notify the user, resume on yes.
- **Follow-ups:** if a thread is waiting on an agent past its timeout, the router nudges that agent, then escalates. The user never has to remember to chase.
- **Loop guard:** each thread has a maximum message count (default 40). Past it, pause and escalate. Two agents asking each other questions forever is a real failure mode.

### 6.3 Adapter interface

Every agent type implements the same interface so the router doesn't care who it's talking to:

```
describe()                          -> AgentCard
send(thread, message)               -> RunRef        // start work or deliver a message
followUp(runRef, message)           -> void          // answer a question mid-run
events(runRef)                      -> stream of {progress | question | result | error}
cancel(runRef)                      -> void
```

Version 1 adapters:

1. **Hub Claude agent (the planner).** A Claude agent the hub runs itself via the Claude API (or Claude Agent SDK). It holds the thread's shared context and answers other agents' questions on the planner's behalf. If it is not confident, it **escalates** to the user instead of guessing. When the user answers an escalation, the answer is written into the thread's shared context, so the planner doesn't ask again.
2. **Cursor — adapter.** Cursor does not speak A2A. Wrap Cursor's cloud agents API: launch an agent on a repo with instructions, send follow-ups, poll status, read results (branch/PR). Map its states and messages onto the interface. Enforce the Run timeout and cost cap.
3. **GitHub.** A GitHub App (or token for v1) that watches PR events by webhook and performs merges. The hub, not any agent, holds merge permission, so approval is enforced in one place.
4. **Jira — REST first, Rovo A2A later.** v1 uses the Jira REST API for ticket create, transition and comment: it is reliable and needs no org admin switch. Rovo's A2A gateway (Agent Card at `https://a2a.atlassian.com/.well-known/agent.json`, JSON-RPC, OAuth 2.0 with PKCE and Dynamic Client Registration, admin must enable A2A for the org) is the follow-on upgrade, useful as proof we speak native A2A.
5. **Human.** Modeled as an agent whose inbox is the approval/escalation inbox on the board.

Next adapters after v1 (design for them, don't build yet): xAI (Grok) and OpenAI as hub-run agents; Rovo native A2A; another person's agents (section 6.8).

**Verify before building each adapter:** vendor APIs change fast. Before writing an adapter, read that vendor's current docs (A2A spec version, Atlassian Rovo A2A docs, Cursor agents API docs, GitHub Apps docs, Claude API/Agent SDK docs, xAI API docs) and adjust this spec if reality differs. Note any difference in the Decisions log (section 12).

### 6.4 The MCP connector (how chats start and see threads)

A **remote MCP server** (Streamable HTTP + OAuth) that users add to their chat apps (Claude app as a custom connector, Claude Code, Cursor; check which other chat apps accept remote MCP connectors). Tools:

| Tool | What it does |
| --- | --- |
| `list_agents` | Agents this chat is allowed to reach (via its Lines) |
| `start_thread` | Start an exchange: target agent(s), instruction, and a **full structured handoff of the current conversation** (goal, plan, decisions, constraints, open questions, files/links) |
| `send_message` | Add a message to an existing thread |
| `get_thread` | Read a thread's history and current state |
| `catch_up` | What changed in this user's threads since this chat last checked: tickets closed, PRs merged, questions answered, approvals decided. Short, plain-language digest. |
| `waiting_on_me` | Approvals and escalations for the user |
| `answer_question` | Answer something on the waiting-on-you list (built in milestone 3) |
| `approve` / `deny` | Decide an approval (milestone 5) |

**Handoff quality is the whole product.** The planner can only answer from what `start_thread` captured. An MCP server only receives what the chat model passes in a tool call; it cannot read the chat on its own. So:

- The tool description must instruct the model to pass a complete, structured summary of the conversation, not a one-liner.
- The schema has required fields for goal, plan, decisions, constraints, open questions and artifacts.
- The server **rejects** handoffs that are too thin (e.g. an empty plan, or a goal with no decisions or constraints when the conversation clearly had them) and tells the model what's missing.

**Second honest constraint:** the hub cannot type into an existing chat in the Claude app (or any other vendor's app). Follow-up questions go to the hub's Claude agent with the same context; the user sees the full thread on the board or via `get_thread` next time they ask.

**Keeping the user's chat current (the stale-state problem).** Because we can't push into the chat, the chat's model will assume nothing happened since the handoff unless we make it check. So:

- Every tool description tells the model: before answering anything about work handed off through Switchboard, call `catch_up` (or `get_thread`). Never assume the state you last saw is still true.
- Every tool response ends with a short "since you last checked" digest, so any call keeps the model current, not just `catch_up`.
- The hub tracks a per-chat (per MCP session/client) "last seen" marker so digests only show what's new.
- Check whether each chat app surfaces MCP resource-update notifications. If one does, use them as well; don't depend on them.
- Hub-run agents (like the hub's Claude planner) don't have this problem: they always read the live thread.

### 6.5 Approvals & escalation

- Default rules (user can edit per Line): merging to main, sending anything outside (email, message to a person), spending money → require approval.
- Escalation triggers: hub Claude agent not confident; two agents disagree; a run errors twice; a run stalls past its timeout after a nudge; a run hits its cost cap; a thread hits the loop guard.
- Notify via web push (and email fallback). Approve from phone in one tap.

### 6.6 The board (canvas)

- **Canvas:** nodes = agents/chats/channels; lines = permissions + context scope. Drag from a node's edge to draw a line. Click a line to edit what crosses it and what needs approval.
- **Live view:** handoffs animate along lines; each node shows status (idle, running, waiting on you).
- **Waiting on you:** approvals + escalations, newest first.
- **Thread view:** the full conversation between agents with links to jump into each app.
- Works on phone and laptop. Phone priority: waiting-on-you and approve/deny.
- Visual direction: clean, product-style, Figma-like canvas. Not a developer console. Not a chat UI.
- The board is built in two stages: a read-only live view early (milestone 3, built), then the full editable canvas (milestone 6).

### 6.7 Security

- Credentials encrypted at rest, never passed to agents or into prompts.
- Every message checked against Lines; deny by default.
- Append-only event log for every action and permission decision.
- Content coming back from agents is untrusted data: never let it change Lines, approvals or rules.
- Content from **another person's** agents is doubly untrusted: it can ask and answer within the line's scope, nothing more.
- Any user can revoke any line they own at any time, effective immediately.

### 6.8 Cross-person lines (the handshake)

This is what companies can't do for themselves: two people, each authorizing their own agents, letting them talk.

- Ben draws a line from one of his agents to someone else's (by invite link or email).
- The other person accepts, and sets what their side allows (message types, context scope, approval rules).
- The line is live only while **both** owners have accepted it. Either can pause or revoke it.
- Each owner's approval rules apply to their own side. Nothing leaves either person's agents without their own rules being met.
- Each person sees the shared thread; neither sees the other's credentials, other lines, or other threads.

---

## 7. Suggested stack (defaults — change if there's a reason, log it)

- TypeScript end to end.
- Hub: Node service (Fastify or Hono). Postgres (Neon or Supabase). Realtime to the board via SSE or WebSockets.
- MCP server: official MCP TypeScript SDK, Streamable HTTP transport, OAuth.
- A2A: official A2A SDK if a TypeScript one is current; otherwise implement the JSON-RPC spec directly.
- Board: Next.js + React Flow (or similar) for the canvas.
- Claude: Anthropic TypeScript SDK / Claude Agent SDK.
- GitHub: Octokit + a GitHub App (or a fine-grained token for local v1).
- Deploy: start local; then a single host (Fly.io, Render, or Railway) + managed Postgres. Ask Ben before signing up for any paid service.

---

## 8. Build order (milestones with "done when")

Work one milestone at a time. Don't start the next until "done when" passes. Keep each one a lightweight MVP.

1. **Hub skeleton.** (Built.) Users, Agents, Lines, Threads, Messages, Runs, Events in Postgres; router with Line checks, loop guard and Run timeouts; a fake "echo" adapter. *Done when:* a message from agent A to agent B is delivered only if a Line allows it, every step is in the event log, and a thread past the loop guard pauses. Tests cover allowed, denied, scoped-context, loop-guard and timeout cases.
2. **Hub Claude agent.** (Built.) *Done when:* given a thread context, it answers a question from another agent; escalates to the human when it's unsure; and after the human answers, it uses that answer next time without asking again.
3. **Chat to chat.** (Built; needs a run with Ben's real keys and Claude app.) MCP connector + Grok and ChatGPT as hub-run agents + the read-only live board. *Done when:* from his Claude chat, Ben hands a conversation to Grok (or ChatGPT) with `start_thread`; a too-thin handoff is rejected with a clear reason; Grok's question is answered by the Planner without him; a question the Planner can't answer reaches him and his answer gets the work moving; asking the same chat "where are we?" gets the current state; and he watches it happen on the board on laptop and phone.
4. **Use it daily.** Ben runs his own handoffs through it for a week. Fix what gets in the way; log which handoffs he still does by hand. Those decide milestone 5 onwards.
5. **Approvals + notifications.** *Done when:* anything that leaves Ben's agents (a send to a person, spending) waits for his yes, given in one tap from his phone, and nothing goes without it. Answering waiting-on-you from the board.
6. **Full canvas.** *Done when:* Ben sees his agents and lines, draws a new line, edits a line's scope and approval rules, revokes a line, and approves from the waiting-on-you list.
7. **Second person (the handshake).** *Done when:* Ben invites someone he works with, they accept and connect their own agent, and a thread from Ben's planner reaches their agent, which asks a question back and reports a result. Revoking the line from either side stops it immediately.
8. **More agents, as Ben's handoffs call for them:** Rovo (native A2A), Gemini, Cursor + GitHub + Jira (the old developer hero).

---

## 9. Pass test (is the product working?)

- [ ] A real feature goes from plan to merged with **one instruction and one approval** from Ben.
- [ ] Most agent questions are answered by the planner agent, not by Ben.
- [ ] For two weeks, Ben stops copy-pasting between his agents.
- [ ] Ben stops having to remember what's waiting: the waiting-on-you list is the only place he looks.
- [ ] Ben opens the board daily without being reminded.

Metrics to track from day one:

- **Handoffs per user per week**, and whether it keeps growing after week three.
- **Self-answered rate:** the share of agent-to-agent questions answered without the user. This is the number that tells us the user is really out of the middle.

---

## 10. Not in version 1

Telegram/email/Slack channels, Rovo native A2A, Cursor/GitHub/Jira (unless Ben's handoffs call for them), team billing, a browser extension, a flow/automation editor, our own chat interface. Cross-person lines are in v1 only as milestone 7, between two people who know each other.

---

## 11. Market context (why the edge exists)

| Segment | Players | Why we're different |
| --- | --- | --- |
| Enterprise agent control | Salesforce Agent Fabric, Kong Agent Gateway, Google/AWS/Microsoft agent registries | Enterprise sales, inside-one-company governance. We're self-serve, personal → small team, and work across companies on personal authorization. |
| Vendor-as-hub | Atlassian Rovo (outside agents become Jira assignees) | Not neutral; won't treat rivals equally. |
| Agent-to-tool access | Executor (YC S26), One (withone.ai), MCP tool connectors generally | They connect agents to tools. We connect agents to each other. Watch them: adding A2A handoffs is a short step for them. |
| Dev-first A2A coordination | Synapse Channel, Whispers, CrewForm (open source) | CLI/self-hosted. Prove demand; not a product a non-engineer signs up for. |
| Shared memory | Mem0 OpenMemory (shared memory across Claude/Cursor via MCP) | Memory, not agents acting and replying. |
| Automation | Zapier, n8n, Make | Fixed pipes built in advance. We route in the moment. |
| Visual agent builders | OpenAI Agent Builder, Copilot Studio, Agentforce, LangGraph Studio | Locked to one vendor's platform. |

Biggest risks: Anthropic, xAI, OpenAI or Cursor ship a good-enough built-in handoff; Executor/One add A2A; vendor APIs change and break adapters; trust (we hold people's tool connections). Defense: neutrality across vendors, personal authorization, cross-person lines, speed, the canvas, and adapters for agents that don't speak A2A yet.

---

## 12. Decisions log

Append here when a decision is made or the spec changes. Newest at the bottom.

- 2026-10-12 — Product is the agent-to-agent layer + design canvas, not a task queue, automation tool, or chat app.
- 2026-10-12 — Version 1 agents: Claude (planner, via MCP connector + hub Claude agent), Cursor (adapter), Jira.
- 2026-10-12 — Telegram-first version dropped from v1; becomes a later connection.
- 2026-10-12 — Human approves merges, external sends, spending. Nothing sends blind.
- 2026-10-12 — Positioning: a **personal** A2A layer across any vendor (Claude, Grok, Rovo, Cursor, …). The user's own authorization is the unlock companies can't give. We connect agents to agents, not agents to tools. Cursor is the first proving case because Ben's team uses it, not because this is a dev tool.
- 2026-10-12 — Added principle "Nobody has to remember": the hub follows up on waiting work; the user only sees the waiting-on-you list.
- 2026-10-12 — Added GitHub to v1. Cursor opens PRs; the hub merges them through GitHub after approval and uses PR events to move Jira.
- 2026-10-12 — Jira via REST first; Rovo A2A becomes a follow-on upgrade (needs an org admin switch and is newer).
- 2026-10-12 — Read-only live view moved up to milestone 4; full editable canvas stays later (milestone 8).
- 2026-10-12 — Added Run timeouts, cost caps, and a per-thread loop guard. Escalation answers are written back into thread context.
- 2026-10-12 — `start_thread` rejects thin handoffs. New metric: self-answered rate.
- 2026-10-12 — Cross-person lines need acceptance by both owners and are revocable by either (the handshake, milestone 9).
- 2026-10-12 — No stale state: added `catch_up` tool, a "since you last checked" digest on every tool response, and a per-chat last-seen marker, so the user's own chat knows what other agents did (e.g. the ticket is closed).
- 2026-10-12 — Milestone 1 built. Lines are one-way for starting work: a line from A to B lets A send anything the line allows, and lets B reply along it (question, answer, status, result) but not send B's own `task`. Two-way work needs a line each way.
- 2026-10-12 — Milestone 1 uses plain SQL with the `pg` driver (no ORM) and local Postgres via Docker; tests run against a real Postgres. No HTTP API yet: nothing calls the hub from outside until the MCP connector (milestone 5) and the board (milestone 4).
- 2026-10-12 — Escalations in milestone 1 set the thread to `waiting_on_user` and write an `escalation.raised` event. The Approval entity and notifications arrive in milestone 7.
- 2026-10-12 — Milestone 2 built. Added an **Escalation** entity (thread, the run waiting on it, reason, question, answer, answered_by): the escalation half of the waiting-on-you list. Every escalation (planner unsure, loop guard, stalled run) creates one. Answering it writes `{question, answer}` into the thread's `user_answers`, resumes the thread, and sends the answer to the agent that asked, along the same line, from the agent that escalated.
- 2026-10-12 — The planner reads the whole live thread context, not the line-scoped copy: it is the hub's own agent holding the user's thread. Line scopes still govern what crosses to other agents.
- 2026-10-12 — The planner escalates when its model says to, when its confidence is below 0.7, or when the model call fails, so the asking agent never gets a guess or silence. Claude API via the Anthropic TypeScript SDK (not the Agent SDK: one structured call per question is enough), model `claude-opus-5-5` with server-side refusal fallback, overridable with `PLANNER_MODEL`.
- 2026-10-12 — Run timeouts skip threads that are waiting on the user, and resuming a thread resets the timeout clock on its open runs.
- 2026-10-12 — Target user is the non-developer heavy AI user (usually an employee using several assistants for their job), not developers. Ben builds it for himself first; it must stay lightweight to reach many such users.
- 2026-10-12 — Hero exchange is now **chat to chat** (Claude chat → Planner → Grok/ChatGPT, with the live board). The Cursor/Jira/GitHub hero moves to later: Atlassian already ships it natively, and it's a developer loop. Build order renumbered (section 8); milestone numbers in older entries above refer to the old order.
- 2026-10-12 — Grok and ChatGPT join v1 as hub-run agents. Both vendors' chat completions APIs are OpenAI-compatible with JSON-schema structured outputs (checked docs.x.ai), so one small fetch client serves both. Defaults `grok-4.7` and `gpt-5`, set by `XAI_MODEL` / `OPENAI_MODEL`.
- 2026-10-12 — Planner tokens: hosted by default (the hub's own Claude key), bring-your-own-key optional later. In the MVP every key comes from `.env`; a missing key means a labelled stand-in, so the whole thing runs with no keys.
- 2026-10-12 — The Planner now takes over a thread from the chat: it hands the task on to the agents the chat named (a new `delegate` adapter event, which needs the Planner's own line to each), and closes the thread when every task it handed out has a result back (a `complete` event). A new task on a done thread reopens it.
- 2026-10-12 — Connector security for the MVP is a long secret token in the URL (`/mcp/<token>`, `/board/<token>`), not OAuth. Claude's custom connectors accept authless servers; OAuth (with Dynamic Client Registration, which Claude requires) comes before anyone but Ben uses it. The Claude app needs a public https address, so a free Cloudflare quick tunnel is the testing route.
- 2026-10-12 — The board is one static page served by the hub (no Next.js / React Flow yet) with a server-sent event stream from the event log. It keeps the approved mockup's look. It's read-only: questions are answered from the chat (`answer_question`) until milestone 5. Plain `node:http` server, no web framework.
- 2026-10-12 — Board look: Ben picked "The Exchange" over a transit map and a lane timeline (mockups: https://claude.ai/artifact/MYr3kfxih3C5kARnM2gRoE). Agents are jacks with name plates, lines are patch cords, a lamp turns amber when an agent waits on you. Deliberately unlike Figma/n8n node canvases. Drawing a line in milestone 6 = plugging a cord between jacks. The lane timeline may become the view inside a thread.
- 2026-10-12 — Connector tool `approve`/`deny` waits for the Approval entity (milestone 5); `answer_question` answers escalations now. Per-chat "last seen" markers are keyed by the chat app's name (e.g. `claude-ai`, `claude-code`), so reconnecting doesn't replay old news.

---

## 13. Launch plan (after milestone 6)

1. Use it daily with someone Ben works with for 2+ weeks (milestone 7 in practice).
2. Record a 60-second demo: plan in Claude → Cursor builds it → zero copy-paste → board shows the exchange. Landing page + waitlist.
3. List in the official MCP registry, other MCP directories, Cursor's directory.
4. Post the demo: r/ClaudeAI, r/cursor, Cursor forum, X, LinkedIn; Show HN once solid.
5. Hand-recruit 20 users who've posted about this pain, and users of the open-source handoff projects.
6. Growth loop: a handoff to another person's agent invites them.
7. Pricing to start: free solo tier with a handoff limit, paid personal tier, per-seat team tier. Set prices after the first 20 users.

---

## 14. How to work with Ben

- Ben is technical but not a software engineer. Explain decisions in plain language, show results, skip jargon.
- He thinks visually. When a UI decision matters, show a screenshot or a quick mockup before building it out.
- Ask before: adding paid services, changing a product principle, or expanding scope beyond the current milestone.
- Keep secrets in `.env` (never committed). Provide `.env.example`.
- At the end of each milestone: a short summary of what works, what doesn't yet, and the next step.
- Keep this file current. If you learn something about a vendor API that changes the plan, update section 6 and log it in section 12.
