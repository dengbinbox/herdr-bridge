CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('admin','user')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
 must_change_password boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 session_token_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE api_keys (
 id uuid PRIMARY KEY, public_id text NOT NULL UNIQUE, secret_hash bytea NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 revoked_at timestamptz, last_used_at timestamptz
);
CREATE TABLE bridges (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_connected_at timestamptz NOT NULL DEFAULT now(),
 agent_version text NOT NULL, os text NOT NULL, UNIQUE(user_id,id)
);
CREATE TABLE layouts (
 user_id uuid NOT NULL REFERENCES users(id), bridge_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0), document jsonb NOT NULL,
 PRIMARY KEY(user_id,bridge_id), FOREIGN KEY(user_id,bridge_id) REFERENCES bridges(user_id,id)
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor uuid REFERENCES users(id), action text NOT NULL, target text NOT NULL,
 result text NOT NULL, timestamp timestamptz NOT NULL DEFAULT now()
);
