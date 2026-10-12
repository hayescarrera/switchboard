-- Switchboard hub schema.
-- Mirrors CLAUDE.md section 6.1 for: users, agents, lines, threads, messages, runs, events,
-- plus escalations (milestone 2). Approvals arrive in milestone 7.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  contact     text,                          -- where to notify them (email for now)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  vendor          text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('a2a_native', 'adapter', 'hub_run', 'human')),
  adapter         text NOT NULL,             -- which adapter implementation delivers to it, e.g. 'echo'
  card            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- A2A Agent Card shape (skills etc.)
  connection_ref  text,                      -- pointer to encrypted credentials, never the credentials
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A line lets from_node start an exchange with to_node. The receiver's replies
-- (question, answer, status, result) travel back along the same line.
CREATE TABLE IF NOT EXISTS lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node          uuid NOT NULL REFERENCES agents(id),
  to_node            uuid NOT NULL REFERENCES agents(id),
  allowed_types      text[] NOT NULL DEFAULT ARRAY['task', 'question', 'answer', 'status', 'result'],
  context_scope      text[] NOT NULL DEFAULT ARRAY[]::text[],  -- thread context fields that may cross
  requires_approval  jsonb NOT NULL DEFAULT '[]'::jsonb,       -- rules, used from milestone 7
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (from_node <> to_node),
  CHECK (allowed_types <@ ARRAY['task', 'question', 'answer', 'status', 'result'])
);

-- One row per owner. A line is live only when every owner has accepted.
CREATE TABLE IF NOT EXISTS line_owners (
  line_id      uuid NOT NULL REFERENCES lines(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  accepted_at  timestamptz,
  PRIMARY KEY (line_id, user_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  goal               text NOT NULL DEFAULT '',
  participants       uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- summary, plan, decisions, constraints, open_questions, links, user_answers
  context            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'waiting_on_user', 'done', 'blocked')),
  status_reason      text,
  origin             text,
  message_count      integer NOT NULL DEFAULT 0,
  max_messages       integer NOT NULL DEFAULT 40,   -- loop guard
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigserial,                           -- delivery order
  thread_id    uuid NOT NULL REFERENCES threads(id),
  line_id      uuid NOT NULL REFERENCES lines(id),
  from_agent   uuid NOT NULL REFERENCES agents(id),
  to_agent     uuid NOT NULL REFERENCES agents(id),
  type         text NOT NULL CHECK (type IN ('task', 'question', 'answer', 'status', 'result')),
  body         text NOT NULL,
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the scoped thread context that crossed the line
  attachments  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, seq);

CREATE TABLE IF NOT EXISTS runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id),
  thread_id         uuid NOT NULL REFERENCES threads(id),
  line_id           uuid NOT NULL REFERENCES lines(id),
  requester_id      uuid NOT NULL REFERENCES agents(id),  -- who replies go back to
  external_ref      text,                       -- e.g. a Cursor agent id
  state             text NOT NULL DEFAULT 'running'
                      CHECK (state IN ('running', 'done', 'error', 'timed_out', 'cancelled')),
  last_event_at     timestamptz NOT NULL,
  timeout_seconds   integer NOT NULL DEFAULT 900,
  nudged_at         timestamptz,
  cost_cap_cents    integer,
  cost_cents        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_running_idx ON runs (state) WHERE state = 'running';

-- Things the hub needs the user for: the escalation half of the "waiting on you" list.
-- Raised by the planner when it is unsure, by the loop guard, and by stalled runs.
CREATE TABLE IF NOT EXISTS escalations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES threads(id),
  run_id       uuid REFERENCES runs(id),          -- the run waiting on the answer, if any
  agent_id     uuid REFERENCES agents(id),        -- who raised it, if an agent did
  reason       text NOT NULL,                     -- planner_unsure, loop_guard, run_timed_out, ...
  summary      text NOT NULL,                     -- one line for the user: what happened
  question     text,                              -- what the user is asked to answer
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  answer       text,
  answered_by  uuid REFERENCES users(id),
  answered_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escalations_open_idx ON escalations (thread_id) WHERE status = 'open';

-- Append-only log of every message, action and permission check.
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  thread_id   uuid,
  agent_id    uuid,
  line_id     uuid,
  run_id      uuid,
  message_id  uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_thread_idx ON events (thread_id, id);

CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
