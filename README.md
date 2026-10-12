# Switchboard

A personal agent-to-agent layer: your agents message each other through a hub,
over lines you draw, so you don't have to be the go-between.
`CLAUDE.md` is the full spec and build plan.

## Where it is

**Milestone 1, the hub skeleton**: Postgres tables for users, agents, lines, threads,
messages, runs and an append-only event log; a router that delivers a message only when
a line allows it and strips the context to what that line lets cross; a loop guard; run
timeouts that nudge, then escalate.

**Milestone 2, the planner**: the hub's own Claude agent answers other agents' questions
from the thread, asks you when it isn't sure, and remembers your answer next time.

**Milestone 3, chat to chat**:

- **A connector for your Claude chat.** Add the hub to the Claude app or Claude Code as a
  custom connector. Then, in the chat where you planned something, say "have Grok research
  this" or "get ChatGPT to draft it". Claude hands the whole conversation over (goal,
  summary, plan, decisions, constraints, open questions, links). Thin handoffs are sent back
  with what's missing.
- **Grok and ChatGPT as hub-run agents.** The hub runs them on your xAI and OpenAI keys.
  They work from the handoff, ask the Planner when something's missing, and deliver a result.
  The Planner answers from your decisions, or puts the question on your waiting-on-you list.
- **Your chat stays current.** Every connector response ends with what changed since that
  chat last checked, and `catch_up` gives the full picture, so Claude doesn't talk about
  work as if nothing happened since the handoff.
- **The live board.** A web for laptop or phone: the Planner sits in the middle, your agents
  sit around it, and the lines between them are curved strands. A dot travels a strand for
  each message, and a ring glows orange around an agent that's waiting on you. Drag agents
  to arrange them; click a line to see what crosses it. It also shows what's waiting on you,
  what just happened, and how many questions were answered without you. Changing lines comes
  with the full canvas.

Connector tools: `list_agents`, `start_thread`, `send_message`, `get_thread`, `catch_up`,
`waiting_on_me`, `answer_question`.

## Run it

You need Node 20+ and Docker (for a local Postgres; nothing hosted).

```sh
cp .env.example .env        # then fill in SWITCHBOARD_TOKEN and any API keys you have
docker compose up -d        # local Postgres with switchboard and switchboard_test databases
npm install
export $(grep -v '^#' .env | xargs)
npm test                    # all tests (live model tests run only when their key is set)
npm run demo:chat           # the whole chat-to-chat exchange, played by a script; open the board link it prints
npm run hub                 # the real thing: prints your board link and connector URL
```

No keys yet? Everything still runs: a labelled stand-in takes the place of each missing
model (the board shows "stand-in" on that agent). The planner stand-in only matches words
against your decisions, so it is much dumber than Claude.

### Add the connector to Claude

- **Claude Code** (on the same computer as the hub):
  `claude mcp add --transport http switchboard http://localhost:3030/mcp/<your token>`
- **Claude app** (claude.ai, desktop, phone): Claude reaches connectors from the internet,
  so the hub needs a public https address. The free, no-account way while testing:
  `npx cloudflared tunnel --url http://localhost:3030` (or install `cloudflared`), set
  `PUBLIC_URL` to the address it prints, restart `npm run hub`, then in Claude go to
  Settings > Connectors > Add custom connector and paste the connector URL it prints.

The token in the URL is the only lock for now (no sign-in yet), so keep the URLs private.

## Layout

| Path | What it is |
| --- | --- |
| `src/db/schema.sql` | The data model (CLAUDE.md 6.1) |
| `src/router.ts` | Line checks, context scoping, loop guard, timeouts, hand-ons (6.2) |
| `src/adapters/adapter.ts` | The interface every agent type implements (6.3) |
| `src/adapters/planner.ts` | The planner: hands work on, answers or escalates, closes the thread |
| `src/adapters/hub-run.ts` | Grok, ChatGPT and other hub-run agents |
| `src/adapters/chat.ts` | Your chat as a node (the hub can't type into it) |
| `src/workers/` | Hub-run agents' models: xAI/OpenAI client and the stand-in |
| `src/planner/` | The planner's Claude model and its stand-in |
| `src/mcp/connector.ts` | The connector's tools and the handoff check (6.4) |
| `src/digest.ts` | "Since you last checked" and the board's captions |
| `src/board/` | The live board page and its data (6.6) |
| `src/hub.ts` | Your agents and lines, wired to their adapters |
| `src/server.ts`, `src/main.ts` | The web server and `npm run hub` |
| `src/demo-chat.ts` | The scripted chat-to-chat demo |
| `test/` | Router, planner, chat-to-chat (over real HTTP) and hub-run tests |
