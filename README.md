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
- A fake "echo" agent to test with. No real vendors are connected yet.

## Run it

You need Node 20+ and Docker (for a local Postgres; nothing hosted).

```sh
cp .env.example .env
docker compose up -d        # local Postgres with switchboard and switchboard_test databases
npm install
export $(cat .env | xargs)
npm test                    # the milestone 1 tests
npm run demo                # one allowed message, one rejected, and the event log
```

## Layout

| Path | What it is |
| --- | --- |
| `src/db/schema.sql` | The data model (CLAUDE.md 6.1) |
| `src/router.ts` | Line checks, context scoping, loop guard, timeouts (6.2) |
| `src/adapters/adapter.ts` | The interface every agent type implements (6.3) |
| `src/adapters/echo.ts` | The fake test agent |
| `src/store.ts` | Creating users, agents, lines and threads |
| `src/events.ts` | The append-only event log |
| `test/router.test.ts` | Allowed, denied, scoped-context, loop-guard and timeout tests |
