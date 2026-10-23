-- Switchboard relay rooms (CLAUDE.md section 4.2).
-- Every secret (session, token, code, invite link) is stored only as a SHA-256 hash.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- People and sign-in ----------

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id  text PRIMARY KEY,               -- base64url
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('register', 'sign_in')),
  challenge   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. the new user's name and id
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- ---------- OAuth for agent connectors ----------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id   text PRIMARY KEY,
  info        jsonb NOT NULL,                       -- full registered client metadata
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- An authorization request waiting for the human to sign in and allow it.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  params      jsonb NOT NULL,                       -- state, scopes, code challenge, redirect uri, resource
  expires_at  timestamptz NOT NULL,
  decided_at  timestamptz
);

-- One AI client a user authorized, e.g. "Ben's Claude".
CREATE TABLE IF NOT EXISTS agent_connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   text NOT NULL REFERENCES oauth_clients(client_id),
  label       text NOT NULL,
  vendor      text NOT NULL,                        -- client_name as the client registered it
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS agent_connections_user_idx ON agent_connections (user_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  code_challenge  text NOT NULL,
  redirect_uri    text NOT NULL,
  resource        text,
  scopes          text[] NOT NULL DEFAULT ARRAY[]::text[],
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  scopes         text[] NOT NULL DEFAULT ARRAY[]::text[],
  resource       text,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_connection_idx ON oauth_tokens (connection_id);

-- ---------- Rooms ----------

CREATE TABLE IF NOT EXISTS rooms (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal                    text NOT NULL,
  owner_user_id           uuid NOT NULL REFERENCES users(id),
  planned_roles           text[] NOT NULL DEFAULT ARRAY[]::text[],
  status                  text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'proposed', 'approved', 'closed')),
  close_reason            text,
  turn_limit              integer NOT NULL DEFAULT 12 CHECK (turn_limit BETWEEN 2 AND 100),
  turns_used              integer NOT NULL DEFAULT 0,
  current_participant_id  uuid,                    -- whose turn it is
  turn_started_at         timestamptz NOT NULL,
  turn_timeout_seconds    integer NOT NULL DEFAULT 1800 CHECK (turn_timeout_seconds >= 60),
  deadline                timestamptz NOT NULL,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  connection_id   uuid NOT NULL REFERENCES agent_connections(id),
  role            text NOT NULL,
  position        integer NOT NULL,                -- join order, drives turn rotation
  joined_at       timestamptz NOT NULL,
  left_at         timestamptz,
  last_read_turn  integer NOT NULL DEFAULT 0,
  UNIQUE (room_id, role),
  UNIQUE (room_id, position)
);

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_current_participant_fk;
ALTER TABLE rooms ADD CONSTRAINT rooms_current_participant_fk
  FOREIGN KEY (current_participant_id) REFERENCES participants(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role            text NOT NULL,
  scopes          text[] NOT NULL,
  note            text,                            -- who it's for, as the owner put it
  token_hash      text NOT NULL UNIQUE,
  created_by      uuid NOT NULL REFERENCES participants(id),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  participant_id  uuid REFERENCES participants(id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  uuid NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  scopes          text[] NOT NULL,
  granted_by      uuid NOT NULL REFERENCES users(id),   -- the human whose click created it
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL,
  CHECK (scopes <@ ARRAY['read', 'post', 'propose'])
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id),
  turn_no         integer NOT NULL,
  body            text NOT NULL,
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, content}] text files
  next_role       text,
  created_at      timestamptz NOT NULL,
  UNIQUE (room_id, turn_no)
);

CREATE TABLE IF NOT EXISTS proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id),
  turn_no         integer NOT NULL,
  summary         text NOT NULL,
  changes         jsonb NOT NULL,                  -- list of strings
  open_questions  jsonb NOT NULL,                  -- list of strings
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_decisions (
  proposal_id  uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  decision     text NOT NULL CHECK (decision IN ('approve', 'reject')),
  note         text,
  decided_at   timestamptz NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id              bigserial PRIMARY KEY,
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id),
  action          text NOT NULL,
  turn_no         integer NOT NULL,
  est_tokens      integer NOT NULL,
  at              timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_room_idx ON ledger (room_id);

-- Every tool call and human decision. Append-only.
CREATE TABLE IF NOT EXISTS audit (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  room_id         uuid,
  user_id         uuid,
  connection_id   uuid,
  participant_id  uuid,
  action          text NOT NULL,                   -- tool name or web action
  result          text NOT NULL CHECK (result IN ('ok', 'refused', 'error')),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_room_idx ON audit (room_id, id);

CREATE OR REPLACE FUNCTION switchboard_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_append_only ON audit;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION switchboard_append_only();

DROP TRIGGER IF EXISTS messages_append_only ON messages;
CREATE TRIGGER messages_append_only BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION switchboard_append_only();

-- ---------- Email + password sign-in (added 2026-10-23) ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;
