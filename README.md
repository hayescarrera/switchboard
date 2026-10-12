# Switchboard

A personal agent-to-agent layer: your agents message each other through a hub,
over lines you draw, so you don't have to be the go-between.
`CLAUDE.md` is the full spec and build plan.

## Where it is

**Milestone 1, the hub skeleton**, is built:

- Postgres tables for users, agents, lines, threads, messages, runs and an append-only event log.
- A router that delivers a message only when a line allows it (line exists, switched on,
  accepted by every owner, message type allowed), and strips the thread's context down
  to the fields that line lets cross.
- Replies (questions, answers, status, results) come back along the same line.
- A loop guard: a thread pauses and goes to "waiting on you" after 40 messages (configurable per thread).
- Run timeouts: an agent that goes quiet is nudged once, then the thread is escalated to you.
- A fake "echo" agent to test with.

**Milestone 2, the hub's Claude agent (the planner)**, is built:

- When another agent asks the planner a question, it reads the live thread (goal, plan,
  decisions, constraints, your earlier answers, recent messages) and answers on your behalf.
- When the plan doesn't settle it, when it isn't confident enough, or when it can't reach
  Claude, it asks you instead of guessing. The thread pauses and the question lands on
  your waiting-on-you list.
- Your answer goes straight back to the agent that asked, is saved into the thread's
  shared context, and the planner uses it next time instead of asking again.
- Waiting on you doesn't count against the agents' timeouts.

## Run it

You need Node 20+ and Docker (for a local Postgres; nothing hosted).

```sh
cp .env.example .env
docker compose up -d        # local Postgres with switchboard and switchboard_test databases
npm install
export $(cat .env | xargs)
npm test                    # all tests (the planner's live tests run only when ANTHROPIC_API_KEY is set)
npm run demo                # one allowed message, one rejected, and the event log
npm run demo:planner        # the planner on the real Claude API: it answers one question, asks you another,
                            # then answers that one from what you said (needs ANTHROPIC_API_KEY)
```

## Layout

| Path | What it is |
| --- | --- |
| `src/db/schema.sql` | The data model (CLAUDE.md 6.1) |
| `src/router.ts` | Line checks, context scoping, loop guard, timeouts (6.2) |
| `src/adapters/adapter.ts` | The interface every agent type implements (6.3) |
| `src/adapters/echo.ts` | The fake test agent |
| `src/adapters/planner.ts` | The hub's planner agent: answer or escalate (6.3, item 1) |
| `src/planner/claude.ts` | The planner's prompt and its call to the Claude API |
| `src/adapters/scripted.ts` | A stand-in agent for tests and demos |
| `src/store.ts` | Creating users, agents, lines and threads |
| `src/events.ts` | The append-only event log |
| `test/router.test.ts` | Allowed, denied, scoped-context, loop-guard and timeout tests |
| `test/planner.test.ts` | Planner answers, escalations, and remembering your answers (mocked model) |
| `test/planner.live.test.ts` | The same judgment calls against the real Claude API |
