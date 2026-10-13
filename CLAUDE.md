# CLAUDE.md — Switchboard (working name)

Read this whole file before writing any code. It is the single source of truth for what we are building, why, for whom, and in what order. If something here conflicts with a later instruction from Ben, Ben wins — then update this file so the next session knows.

---

## 1. The one-paragraph version

Teams now work across several AI tools at once — one person thinks in Claude, another in ChatGPT, the developer builds in Cursor or VS Code. The humans have become the **meat proxy**: copying AI output out of one tool, pasting it to a coworker, who pastes it into *their* AI, re-explains, and passes it on again. Switchboard is the **shared working layer between people and their agents**. One thread holds a piece of work; several people and several agents (whatever tool each person prefers) work in it together; when it's ready, it hands off to the coding agent with everything already in it. Agents can message each other and act on their own, but a human approves anything that matters. On top sits a **canvas** where the team designs how its agents connect: agents and chats are boxes, and the lines between them say who can talk to whom and what context crosses.

**Mission:** your agents talk to each other, so you don't have to be the go-between.

**Analogy:** Plaid. Banks dragged their feet on open APIs; Plaid built the connections itself and became the layer everyone used. AI vendors each make their *own* tools collaborative but won't bridge to each other. We build the bridges so people and agents across tools work as one team, today.

---

## 2. Who it's for

- **Primary customer: lean teams (3–30 people) that run on AI instead of headcount.** Small companies and startups where people use different AI tools, the developer works in Cursor/VS Code, and a founder or CTO can say yes on the spot.
- **Validation signal:** Ben's CTO, unprompted: "I'm copying stuff and asking my agent about it, you're asking yours — what an interesting time." That is the exact pain, described by a technical decision-maker at a lean team.
- **Builder/first user: Ben.** Technical but not a software engineer. Thinks visually, Figma-style. Uses Claude for ideas and planning, Cursor/VS Code-side work goes through a developer. Approves everything before it goes out.
- **Ben cannot pilot this at his day job** (not senior enough to roll it out). Plan: Ben uses it on his own work; the CTO is a sounding board; recruit 3–5 outside lean teams as design partners.
- Not for: enterprises buying an agent governance platform (Salesforce Agent Fabric, Kong, cloud registries own that); individuals at $20/month as the core business (see section 13).

---

## 3. Product principles (do not violate these)

1. **One thread, many people, many agents.** A piece of work lives in one shared thread. Each person can bring their own AI (Claude, ChatGPT, Cursor, VS Code agent). Nobody copy-pastes or re-explains.
2. **Share by thread, never everything.** Like sharing one Google Doc, not your whole Drive. "This thread, these people, these agents." Privacy hesitancy is real; granular sharing is the product, not a blocker.
3. **Cross-vendor is the point.** Each AI vendor makes its own chats shareable (ChatGPT group chats, Claude Team projects, Claude Tag in Slack). None will put your teammate's Claude in your ChatGPT thread or feed a Claude conversation into Cursor. That bridge is ours.
4. **Humans approve; agents carry.** Today people want a human to check before anything goes out. Version 1 must fit that: agents draft and propose, humans approve, the layer routes context and keeps the record. Teams turn off approvals line by line as trust grows. Never require full autonomy to be useful.
5. **The team designs the web.** The canvas is where they connect agents, chats and people and draw lines between them. Each line = permission + what context crosses. Adding a tool = connect + draw a line.
6. **Live where people already work. Do NOT build a chat app that competes with Claude or ChatGPT.** The layer sits behind the tools people already use. Our UI is for the shared thread view, the canvas, and approvals — not for replacing anyone's AI chat.
7. **Not an automation tool.** n8n/Zapier/Make build fixed pipes in advance. We route in the moment, with context traveling with the work. If a feature starts to look like "build a flow first," stop and rethink.
8. **Not a task queue.** If a receiving agent only picks up work when a human tells it to, the human is still the proxy. Connected agents must be able to receive, act and reply on their own (within approval rules).
9. **One tab, any device.** Laptop and phone. See what's happening, approve, redirect.

---

## 4. What "connected" means

Every agent on the hub gets five things:

1. **An address** — an agent card: who it is, who it belongs to, what it can do (A2A Agent Card shape).
2. **An inbox** — it can receive a task or question from another agent or person.
3. **The ability to act** — it runs on that message without anyone opening its app.
4. **A way back** — it can answer, ask a question back, report progress, or say it's done.
5. **A shared thread** — every participant (people and agents) reads the same context; nothing is re-explained.

---

## 5. Hero exchanges (build until these work end to end)

### 5.1 Team thread → build (the primary demo)

1. Ben starts a thread from his Claude chat: "Add CSV export to the reports page." His Claude passes the full plan into the thread.
2. Ben shares the thread with the CTO. The CTO's agent (ChatGPT or Claude) adds a constraint: "Must stream for files over 50MB." No copy-paste.
3. The thread is handed to the developer's Cursor agent with the plan *and* the CTO's constraint already in it.
4. Cursor asks a question ("Which columns by default?"). The hub's planner agent answers from the thread; if unsure, it asks Ben or the CTO in the thread.
5. Cursor opens a PR, linked in the thread. Jira ticket moves to In review.
6. Hub → developer/CTO: "Ready to merge. Approve?" One tap from a phone.

People did: one instruction, one added idea, one approval. Today the same feature means rounds of copy-paste between three people and four tools.

### 5.2 Personal (Ben alone)

Ben plans in Claude, says "Have Cursor build this and file it in Jira." Claude → Jira (ticket), Claude → Cursor (plan), Cursor's questions answered by the planner agent, PR opened, Ben approves the merge. One instruction, one approval.

---

## 6. Architecture

```
 Claude app / Claude Code / ChatGPT / Cursor / VS Code ──(remote MCP connector)──┐
                                                                                 ▼
                              ┌──────────────────────────── HUB ────────────────────────────┐
 Web app (thread view,  ◄────►│ API · Router · Lines (permissions) · Threads · Workspaces   │
 canvas, approvals;           │ Members & sharing · Approvals · Escalation · Event log      │
 phone + laptop)              │ A2A server (exposes agents) + A2A client                    │
                              └───────┬──────────────┬──────────────┬──────────────┬────────┘
                                      ▼              ▼              ▼              ▼
                              Jira Rovo (A2A)  Cursor adapter  Hub Claude agent  Human inboxes
                                               (agent API)     (Claude API)      (approvals)
```

### 6.1 Core data model

| Entity | Key fields |
| --- | --- |
| **Workspace** | id, name, members, billing plan |
| **User** | id, workspace memberships, role (owner, member), notification settings |
| **Agent** | id, name, vendor, kind (`a2a_native` / `adapter` / `hub_claude` / `mcp_client` / `human`), owner user, agent card (skills), connection ref (credentials stored separately, encrypted), status |
| **Line** | id, from_node, to_node, allowed message types (`task`, `question`, `answer`, `status`, `result`), context scope (which fields cross), requires_approval rules, enabled |
| **Thread** | id, workspace, title, goal, shared context (plan, decisions, constraints, open questions, links/files), status (`active`, `waiting_on_human`, `done`, `blocked`), origin |
| **ThreadShare** | thread_id, member or agent, permission (`view`, `contribute`, `can_hand_off`) |
| **Message** | id, thread_id, author (person or agent), to (optional), type, body, attachments/links, created_at |
| **Run** | id, agent_id, thread_id, external ref (e.g. Cursor agent id), state, last_event_at |
| **Approval** | id, thread_id, requested_by, approver(s), action (`merge`, `send_external`, `spend`, …), payload, status, decided_by, decided_at |
| **Event** | append-only log of every message, share, action, approval, permission check |

### 6.2 Router (the heart)

- Every message passes through the router.
- Checks thread shares and the **Line** between sender and receiver: allowed? which message types? strip context to the line's scope. No permission → reject and log.
- Delivers to the receiver via its adapter; records a Run.
- Turns adapter events (progress, question, result) into Messages on the thread.
- Actions needing approval → pause, create Approval, notify approver(s), resume on yes.

### 6.3 Adapter interface

Every agent type implements the same interface:

```
describe()                          -> AgentCard
send(thread, message)               -> RunRef        // start work or deliver a message
followUp(runRef, message)           -> void          // answer a question mid-run
events(runRef)                      -> stream of {progress | question | result | error}
cancel(runRef)                      -> void
```

Version 1 adapters:

1. **Cursor — adapter.** Cursor does not speak A2A. Wrap Cursor's Cloud/Background Agents API: launch an agent on a repo with instructions, send follow-ups, poll status, read results (branch/PR).
2. **Hub Claude agent (planner stand-in).** A Claude agent the hub runs via the Claude API / Agent SDK. Holds the thread's shared context and answers other agents' questions. If not confident, it asks the humans in the thread instead of guessing.
3. **Jira (Rovo) — native A2A.** Atlassian runs an A2A gateway for Rovo (Agent Card at `https://a2a.atlassian.com/.well-known/agent.json`, JSON-RPC endpoint, OAuth 2.0 with PKCE, Dynamic Client Registration; an org admin must enable A2A). Jira REST API as fallback for create/transition/comment.
4. **MCP clients (Claude, ChatGPT, Cursor, VS Code).** People's own AI tools connect through our MCP server (6.4) to start, read and contribute to threads.
5. **Humans.** Modeled as participants whose inbox is the approvals/questions list.

**Verify before building each adapter:** vendor APIs change fast. Read the current docs (A2A spec version, Atlassian Rovo A2A, Cursor agents API, Claude API/Agent SDK, ChatGPT and VS Code MCP support) and adjust this spec if reality differs. Log differences in section 15.

### 6.4 The MCP connector (how people's own AI tools join threads)

A **remote MCP server** (Streamable HTTP + OAuth) that each person adds to their tool: Claude (app custom connector + Claude Code), ChatGPT (if it supports remote MCP connectors on the user's plan — verify), Cursor, VS Code. Tools:

| Tool | What it does |
| --- | --- |
| `list_threads` | Threads shared with this person |
| `start_thread` | Start a thread with a **full structured handoff of the current conversation** (goal, plan, decisions, constraints, open questions, files/links) and optional people/agents to share with |
| `get_thread` | Read a thread's history and current state |
| `contribute` | Add this person's (or their AI's) idea, constraint or answer to a thread |
| `hand_off` | Send the thread to an agent (e.g. Cursor) to act on |
| `share_thread` | Share with a person or agent at a permission level |
| `waiting_on_me` | Approvals and questions for this person |
| `approve` / `deny` | Decide an approval |

**Honest constraint 1:** an MCP server only receives what the chat model passes in a tool call; it cannot read the chat on its own. `start_thread` and `contribute` schemas must force complete, structured content (required fields), not one-liners.

**Honest constraint 2:** the hub cannot type into someone's existing chat. Updates reach people through the web app (thread view), notifications, and `get_thread` / `waiting_on_me` when they ask their AI.

### 6.5 Approvals & escalation

- Defaults (editable per Line and per thread): merging to main, sending anything outside the workspace, spending money → require approval.
- Escalation: hub Claude agent not confident; agents disagree; a run errors twice; a run stalls past a timeout → question to the thread's humans.
- Notify via web push (email fallback). Approve from phone in one tap.

### 6.6 The web app

- **Thread view (most-used screen):** the shared conversation — people and agents, labeled by who and which tool — with the current plan/context pinned at top, and jump-in links to each app.
- **Canvas:** nodes = people, agents, chats; lines = permissions + context scope. Drag to draw a line; click a line to edit what crosses and what needs approval. Handoffs animate along lines; nodes show status.
- **Waiting on you:** approvals and questions, newest first.
- Phone priority: waiting on you, approve/deny, read a thread.
- Visual direction: clean, product-style, Figma-like. Not a developer console. Not a chat app competing with Claude/ChatGPT.

### 6.7 Security & trust

- Credentials encrypted at rest; never passed to agents or into prompts.
- Deny by default; every message checked against shares and Lines.
- Append-only event log for every action, share and permission decision.
- Content coming back from agents is untrusted data: it can never change shares, Lines, approvals or rules.
- Trust is a selling point for teams: make "who can see what" obvious on every thread.

---

## 7. Suggested stack (defaults — change if there's a reason, log it)

- TypeScript end to end.
- Hub: Node (Fastify or Hono). Postgres (Neon or Supabase). Realtime via SSE or WebSockets.
- MCP server: official MCP TypeScript SDK, Streamable HTTP, OAuth.
- A2A: official A2A SDK if a current TypeScript one exists; otherwise implement the JSON-RPC spec.
- Web app: Next.js; React Flow (or similar) for the canvas.
- Claude: Anthropic TypeScript SDK / Claude Agent SDK.
- Auth: workspace + user accounts with Google/GitHub sign-in.
- Deploy: start local; then one host (Fly.io, Render or Railway) + managed Postgres. Ask Ben before any paid service.

---

## 8. Build order (milestones with "done when")

One milestone at a time. Don't start the next until "done when" passes.

1. **Hub skeleton.** Workspaces, users, agents, threads, shares, lines, messages, events; router with permission checks; fake "echo" adapter. *Done when:* a message is delivered only when shares and lines allow it, context is scoped, and every step is logged. Tests cover allowed, denied and scoped cases.
2. **MCP connector, shared threads.** *Done when:* Ben starts a thread from Claude Code (then the Claude app) with a full structured handoff, shares it with a second account, and that account reads and contributes to it from a different AI tool (ChatGPT or Cursor if supported; otherwise a second Claude).
3. **Thread view in the web app.** *Done when:* both people see the same thread live, labeled by person and tool, with the plan pinned.
4. **Hub Claude agent.** *Done when:* it answers an agent's question from the thread context, and asks the humans when unsure.
5. **Cursor adapter + hand_off.** *Done when:* a thread is handed to a Cursor agent on a test repo, one follow-up question is answered from the thread, and the PR link lands on the thread.
6. **Approvals + notifications.** *Done when:* merge waits for an approver's yes from a phone; nothing merges without it.
7. **Jira via Rovo A2A (or REST fallback).** *Done when:* a thread creates a ticket, updates it on PR open, closes it on merge.
8. **Canvas.** *Done when:* a workspace sees people, agents and lines; draws a new line; edits a line's scope; watches a live handoff.
9. **Design partners.** *Done when:* 3 outside lean teams are using it weekly.

---

## 9. Pass test (is the product working?)

- [ ] A real feature goes from idea to merged with contributions from two people using different AI tools, and **zero copy-paste** between them.
- [ ] Cursor's questions are answered from the thread, not by a person re-explaining.
- [ ] A design-partner team keeps using it for 4+ weeks without being reminded.
- [ ] At least one team asks to add more people.

Metrics from day one: **shared threads per team per week**, **handoffs per week**, and **people per thread**. Watch whether they keep growing after week three.

---

## 10. Not in version 1

Cross-company threads (other organizations' agents), Telegram/email/Slack channels, a browser extension, a flow/automation editor, our own general-purpose AI chat, enterprise SSO/admin.

---

## 11. Competitive landscape (researched 2026-10-12)

| Segment | Players | How we differ |
| --- | --- | --- |
| Vendor-native shared chats | ChatGPT group chats (global) and shared projects; Claude Team projects; Claude Tag (multi-person Claude in Slack) | Each only shares within its own tool. **Do not build plain "shared AI chat" — the labs own it.** We bridge across tools and into coding agents. |
| Enterprise agent control | Salesforce Agent Fabric (cross-vendor agent broker, GA May 2026), Kong Agent Gateway, Google/AWS/Microsoft agent registries | Enterprise sales, governance focus. We're self-serve for lean teams. |
| Vendor-as-hub | Atlassian Rovo (outside agents like Cursor become Jira assignees; A2A gateway) | Not neutral. We use it as one connection. |
| Agent-to-tool access | Executor (YC S26: one endpoint for all services, per-tool permissions), One (withone.ai: connect button + dashboard of every agent's actions, one-click revoke) | They connect agents to tools. We connect people and agents to each other around shared work. **Watch closely** — adding agent-to-agent handoffs is a short step for them. |
| Dev-first A2A coordination | Synapse Channel, Whispers, CrewForm (open source, CLI/self-hosted) | Prove developer demand; not a product a lean team signs up for. |
| Shared memory | Mem0 OpenMemory (shared memories across Claude/Cursor via MCP) | Memory, not shared threads with people, handoffs and approvals. **Check before milestone 2.** |
| Automation | Zapier, n8n, Make | Fixed pipes built in advance; we route in the moment. |
| Visual agent builders | OpenAI Agent Builder, Copilot Studio, Agentforce, LangGraph Studio, n8n | Locked to one vendor's platform; for building agents, not connecting people's existing ones. |
| MCP server generation | Stainless, Speakeasy | Plumbing for SaaS vendors; not our product. |

**Biggest risks:** Anthropic, OpenAI or Cursor ship a "good enough" cross-tool bridge; Executor/One add agent-to-agent; vendor APIs change and break adapters; trust (we hold people's tool connections); people tolerate copy-paste more than we think.
**Defense:** neutrality across vendors, speed, the shared thread + canvas experience, granular sharing, and adapters for tools that don't speak A2A yet.

---

## 12. Market context and timing (what we learned)

- **The wave:** AI is moving from people using tools to companies running agents that do work and transact. YC's 2026 batches are ~70–80% agent companies; Summer 2026's lead trend is infrastructure *for* agents (payments, identity, phones, sandboxes). That infrastructure layer is being taken by funded teams — not our fight.
- **Our position is one level up:** a product that does real work on top of the new infrastructure, for a buyer adopting now. Harder to build than a simple tool, easier to sell than infrastructure.
- **Timing:** cross-company, fully autonomous agent-to-agent is early (bot-to-bot negotiation is "still rare" in procurement). Inside one team, with humans approving, the pain exists today. That's why version 1 is internal teams + human approval.
- **Build vs buy:** big companies may build their own layer; lean teams won't, for the same reason they don't build their own auth or billing.
- **Lessons from ideas we rejected today:**
  - Agent spend/tool control plane: real gap, but crowded with weekend-build open source and weak willingness to pay.
  - Consumer agentic commerce plays (seller agents, affiliate for agents): the wave is slower than forecasts; ChatGPT pulled back in-chat checkout in March 2026; AI shopping adoption dipped Nov 2025–Mar 2026.
  - Devtool "agent visibility": crowded (GEO/AEO category).
  - Plain shared AI chat: owned by the labs.
  - $20/month individual tools: need ~20,000 payers for $5M/year; team/B2B pricing needs far fewer customers.

---

## 13. Business model and goals

- **Goal:** a durable $5–10M/year business, not a moonshot. Niches too small for venture-backed players are fine — that's partly the moat.
- **Pricing to start (set real numbers after design partners):** free for one person with limits; team plan per seat; a workspace minimum so a 5–10 person team lands at roughly $100–500/month. Justify on hours of copy-paste and context loss removed.
- **Growth loop:** sharing a thread invites a teammate; handing off across teams spreads it inside a company.

---

## 14. Go-to-market plan (after milestone 6)

1. Ben uses it on his own work daily; shows the demo to his CTO for reactions (sounding board, not pilot).
2. Record a 60-second demo of the team hero exchange (5.1): two people, two AI tools, Cursor builds it, zero copy-paste.
3. Landing page + waitlist with the mission line.
4. Recruit 3–5 lean-team design partners: founders/CTOs at small AI-forward companies who can say yes on the spot.
5. List in the official MCP registry, other MCP directories, and Cursor's directory.
6. Post the demo: r/ClaudeAI, r/cursor, r/ChatGPT, the Cursor forum, X, LinkedIn; Show HN once solid.
7. Short guides people already search for ("how to share context between Claude and Cursor", "how my team stopped copy-pasting between AI tools").

**Later direction (only after teams work):** sell the same layer to mid-size SaaS companies whose customers' agents want to work with their product — a hosted agent "front door" with per-customer permissions, metering and logs. Validate first by asking ~10 heads of product: "Are customers asking for agent access? What have you built?"

---

## 15. Decisions log

Newest at the bottom.

- 2026-10-12 — Product is the agent-to-agent layer + design canvas, not a task queue, automation tool, or chat app.
- 2026-10-12 — Telegram-first version dropped from v1; becomes a later connection.
- 2026-10-12 — Humans approve merges, external sends and spending. Nothing sends blind.
- 2026-10-12 — Switched from personal-first to **team-first**: shared threads where several people and their different AI tools work together, shared by thread. Reason: B2B pricing, lean teams feel the pain today (CTO quote), and labs already own single-vendor shared chats.
- 2026-10-12 — VS Code and ChatGPT added alongside Claude and Cursor as tools people bring into threads (verify MCP support for each).
- 2026-10-12 — Ben can't pilot at his employer; plan is self-use + CTO as sounding board + outside design partners.

---

## 16. How to work with Ben

- Ben is technical but not a software engineer. Explain decisions in plain language, show results, skip jargon.
- He thinks visually. When a UI decision matters, show a screenshot or quick mockup before building it out.
- He wants honest pushback and weaknesses surfaced, not cheerleading.
- Ask before: adding paid services, changing a product principle, or expanding scope beyond the current milestone.
- Keep secrets in `.env` (never committed). Provide `.env.example`.
- At the end of each milestone: short summary of what works, what doesn't yet, and the next step.
- Keep this file current. If a vendor API changes the plan, update section 6 and log it in section 15.
