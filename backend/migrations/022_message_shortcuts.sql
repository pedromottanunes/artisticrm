CREATE TABLE message_shortcuts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX message_shortcuts_user_created
  ON message_shortcuts(user_id, created_at DESC, id);
