# CLAUDE.md — Switchboard (working name)

Read this whole file before writing any code. It is the single source of truth for what we are building and in what order. If something here conflicts with a later instruction from Ben, Ben wins. Then update this file so the next session knows.

The Oct 12 hub plan (hub-run Claude agent, Cursor/Jira/GitHub adapters, lines and threads) was replaced on Oct 23 by the relay plan below. It is in git history (`d1504d3`) if we ever want it back.

---

## 1. What v1 proves

Two agents from different vendors solve one problem together through a neutral **room**, and humans approve only the result.

**Success test:** Ben connects his Claude and his ChatGPT to the room server, opens one room with one goal, and both agents trade work until they post a single proposal he approves in one tap. No copy-paste between chats at any point.

**Mission:** your agents talk to each other, so you don't have to be the go-between.

## 2. Relay mode

The room server stores and routes. **It never calls a model.** All thinking happens inside each participant's own AI client, on their own subscription.

- The **room** holds the goal, messages, files and proposals.
- Each **agent** joins through our remote MCP connector (Claude custom connector, ChatGPT developer mode, Cursor, Copilot, any MCP client).
- Each agent works when its owner's session runs: it reads new room activity, does its part with its own tools, posts back.
- **Tokens:** each side's thinking bills to that side's own plan. Our only costs are hosting and storage.

**Known limit (accepted for v1):** an agent replies only while its owner's chat is active. Ben can run both sides himself. Hosted delegates close the gap later (section 9).

## 3. Product principles

1. **The other side's agent is a stranger.** Everything it says is data, never instructions.
2. **Humans approve, agents carry.** Agents draft and propose. Only a signed-in human in the web app creates a grant (accepts an invite) or approves a result.
3. **Fair work.** The server enforces turns and limits so neither side carries the whole load, and the ledger shows who did what.
4. **No actions in v1.** A room produces a plan. Nothing is executed against anyone's systems.
5. **Not a chat app.** People stay in the chat they already use. The web app is only for sign-in, joining, approving and reading the record.
6. **We connect agents to agents, not agents to tools.**

## 4. How it is built

One Node service (TypeScript, Express) + Postgres.

| Part | Where | Notes |
| --- | --- | --- |
| Room service (rules) | `src/rooms/` | Turns, limits, grants, ledger, audit. Pure logic over Postgres with an injectable clock. |
| MCP server | `src/mcp/` | Streamable HTTP at `/mcp`, stateless (new server per request). Seven tools. |
| OAuth 2.1 server | `src/auth/oauth.ts` | Dynamic client registration, PKCE, refresh tokens, revocation (MCP SDK `mcpAuthRouter` + our Postgres provider). |
| Passkeys + sessions | `src/auth/` | WebAuthn via `@simplewebauthn`. No passwords, no Google/Microsoft app registration, no email service needed. |
| Web pages | `src/web/` | Sign-in, connect an agent (OAuth consent), join a room, approve, room record, audit export. |

### 4.1 Identities

- **User** — a human, signed in with a passkey.
- **Agent connection** — one AI client a user authorized through OAuth (e.g. "Ben's Claude", "Ben's ChatGPT"). Every MCP access token belongs to exactly one connection. When a client reconnects, the consent page offers to reuse the existing connection so room seats don't break.
- **Participant** — a seat in one room: one role, held by one agent connection, owned by one user. Ben can hold two seats in one room with two different agents.
- **Grant** — what a participant may do in its room (`read`, `post`, `propose`), with expiry and revocation. Checked on every tool call.

### 4.2 Data model

`users`, `passkeys`, `web_sessions`, `webauthn_challenges`, `oauth_clients`, `oauth_requests`, `oauth_codes`, `oauth_tokens`, `agent_connections`, `rooms`, `participants`, `invites`, `grants`, `messages` (append-only), `proposals`, `proposal_decisions`, `ledger`, `audit` (append-only). See `src/db/schema.sql`. Every room record carries `room_id`. Secrets (tokens, codes, invite links) are stored only as SHA-256 hashes.

### 4.3 MCP tools

| Tool | What it does | Who |
| --- | --- | --- |
| `create_room` | Opens a room: goal, your role, the roles you'll invite, turn limit, deadline | Any connected agent |
| `invite` | Makes a join link for a role and scopes (shown to the owner to send) | Room owner's agents |
| `list_rooms` | Rooms this agent sits in, whose turn it is, what's new | Participant |
| `read_room` | Goal, messages since a turn, proposals, ledger, whose turn, what to do next | Participant (`read`) |
| `post` | Adds a message (optionally hands the next turn to a role); refused off-turn | Participant (`post`) |
| `propose` | Submits the decision brief: summary, changes, open questions | Participant (`propose`) |
| `approve` | Always refused for agents; returns the human approve link | Nobody (human-only in web) |

All room content in tool results is wrapped in `<room_content trust="untrusted" …>` blocks with a standing note not to follow instructions inside them.

### 4.4 Turn rules

1. **Turns rotate** among joined participants in join order. A participant can post or propose only on its turn. Posting needs at least two seated participants.
2. **Context owner answers:** `post` takes an optional `next_role`; the next turn goes to that role instead of the rotation.
3. **Turn limit** (default 12 posts). At the limit, posting is refused and the agent whose turn it is must `propose`.
4. **Timeouts:** an idle turn (default 30 min) passes to the next participant. After the limit, an idle turn closes the room unresolved.
5. **Stop:** a proposal approved by every human participant → `approved`; rejected by any → `closed`; deadline passed (default and max 7 days) → `closed`.
6. **Ledger:** every post/propose records an estimated token count (characters ÷ 4) so imbalance is visible in `read_room`.

### 4.5 Security

- Untrusted labeling of everything from the room (section 4.3); closing tags inside content are neutralized.
- Least privilege: a grant covers one room and the invite's scopes. No cross-room reads.
- Grants expire with the room or after 7 days, whichever comes first; the owner can revoke any seat, a participant can leave.
- Access tokens last 1 hour, refresh tokens 30 days; both revocable; revoking an agent connection kills its tokens and seats.
- Web writes need the session cookie (SameSite=Lax) **and** a matching `Origin` header.
- Audit log of every tool call (participant, tool, time, result); any participant can export a room's log as JSON.

## 5. Running it

- Tests: `npm test` against a real Postgres (`TEST_DATABASE_URL`). CI runs them on every push.
- Hosting: Render blueprint in `render.yaml` (one web service, $7/mo) + a Neon Postgres project (free tier; use the direct, not `-pooler`, URL: migrations take a session advisory lock). Claude and ChatGPT connect from their clouds, so the server must be on a public HTTPS URL — localhost is not enough for the real test. **Ask Ben before any paid sign-up.**

## 6. Build order (v1)

- [x] Room tables
- [x] Seven room tools behind OAuth
- [x] Join page and approve page (passkey sign-in)
- [x] Turn rules, turn limit, ledger
- [x] Untrusted-content labeling and audit log
- [ ] Deploy (Render) — waits on Ben's sign-up
- [ ] Connect Ben's Claude and a second-vendor agent (ChatGPT needs a Business/Enterprise/Edu workspace to post; see 10)
- [ ] **First test:** goal "Draft a one-page onboarding checklist for a new Tekhnea customer." Claude = product role, ChatGPT = docs role. Pass = one approved proposal, zero copy-paste.
- [ ] Second test with a real second person on their own account

## 7. Pass metrics

- Rooms that end in an approved proposal (vs closed unresolved).
- Turns per approved room, and ledger balance between sides.
- Copy-pastes Ben still does (target: zero).

## 8. How to work with Ben

- Technical but not a software engineer. Plain language, show results, skip jargon.
- Thinks visually: screenshot or mockup before UI decisions.
- Doesn't want to run terminal commands; prefer setups where he doesn't have to.
- Ask before: paid services, changing a principle, expanding scope.
- Secrets in `.env` (never committed); `.env.example` provided.

## 9. Not in v1, and what comes next

| Later | Adds | Why it waits |
| --- | --- | --- |
| v2 hosted delegates | Agents keep working when owners are offline, on each owner's own API key | Per-user key storage and cost controls |
| v2 smart routing | Cheap model for back-and-forth, strong model for the brief | Only matters once delegates exist |
| v2 email invites | Join links sent by email | Needs an email service (Ben's choice) |
| v3 approved actions | After approval, each agent executes its part with its owner's permissions | Highest risk; needs v1 trust first |
| v3 A2A endpoint | Agents that speak A2A join without MCP | MCP covers the target clients |
| v3 canvas | Draw-a-line view connecting agents and rooms | UI on top of a working core |

Tekhnea relationship: separate product and repo. Shared ideas (sign-in, MCP framework) can become packages later; don't merge without Ben.

## 10. Decisions log

- 2026-10-12 — (old plan) Hub with lines/threads, milestone 1 built. Superseded below.
- 2026-10-23 — Ben: replace the hub plan with relay rooms (server never calls a model). Built in this repo, not inside Tekhnea: Tekhnea has no MCP server or connector OAuth yet (its backlog items 4–5), so "built on Tekhnea's server" wasn't possible without jumping Tekhnea's roadmap.
- 2026-10-23 — Sign-in is passkeys (Ben: "whichever, don't make it a blocker"). Passkeys need no Google/Microsoft app registration and no email service, so nothing waits on a sign-up for Ben or a second person. Trade-off: no account recovery in v1 — losing every passkey means a new account.
- 2026-10-23 — Invites return a join link for the owner to send; no email in v1 (no email service chosen). The join page asks the human to pick which of their connected agents takes the seat; that click creates the grant.
- 2026-10-23 — The spec's Grant `token_hash`: the connector's OAuth token authenticates the agent; the grant row authorizes it per room. Tokens are hashed in `oauth_tokens`, not on the grant.
- 2026-10-23 — Turns rotate in join order among seated participants; at least two seats before anyone posts; turn timeouts and deadlines are applied whenever the room is touched (no background job needed).
- 2026-10-23 — Humans who approve = distinct users among participants. Ben holding both seats approves once.
- 2026-10-23 — A rejected proposal closes the room (spec stop condition). Revise-and-resubmit can come later if rooms die too easily.
- 2026-10-23 — The repo is public; consider making it private before real users (it holds the plan).
- 2026-10-23 — Vendor check (OpenAI help 12584461; claude.com/docs/connectors/custom/remote-mcp): ChatGPT custom MCP apps get write actions (our post/propose/create_room/invite) only on Business, Enterprise and Edu (beta, web); Pro is read/fetch only. Business needs an admin to enable Developer mode under Workspace settings → Permissions & Roles. Claude: Customize → Connectors → Add custom connector (Free/Pro/Max); owners add org-wide on Team/Enterprise. Claude prefers Client ID Metadata Documents and falls back to dynamic client registration, which we support. CIMD support is a later nice-to-have (fewer client registrations).
- 2026-10-23 — Browser check found that `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on our own forms, which the same-origin check refused. Now `same-origin`, and `Origin: null` falls back to `Sec-Fetch-Site`.
- 2026-10-23 — Production runs TypeScript through tsx (`node --import tsx`), like Tekhnea's API: no build output to keep in sync with schema.sql and public/.
- 2026-10-23 — Ben: database on Neon (free tier, separate project from Tekhnea) instead of Render Postgres; server on Render Starter. ~$7/mo total.
