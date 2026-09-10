CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('manager', 'attendant')),
  active boolean NOT NULL DEFAULT true,
  queue_enabled boolean NOT NULL DEFAULT false,
  queue_position integer UNIQUE,
  color text NOT NULL DEFAULT '#EDB25A'
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE distribution_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  last_position integer NOT NULL DEFAULT 0,
  timeout_minutes integer NOT NULL DEFAULT 10 CHECK (timeout_minutes BETWEEN 1 AND 60),
  version integer NOT NULL DEFAULT 1
);
INSERT INTO distribution_settings (id) VALUES (1);
CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  email text NOT NULL DEFAULT '',
  instagram text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false
);
CREATE TABLE opportunities (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES contacts(id),
  interest text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'A definir',
  source text NOT NULL DEFAULT 'Não identificada',
  source_evidence text NOT NULL DEFAULT 'Não disponível',
  stage text NOT NULL DEFAULT 'TO_QUALIFY' CHECK (stage IN ('TO_QUALIFY','EVALUATION_SCHEDULED','NEGOTIATION','CONTRACT_PENDING','WON','LOST')),
  state text NOT NULL CHECK (state IN ('PENDING','RESERVED','POOL','CLAIMED','CANCELLED')),
  reserved_to uuid REFERENCES users(id),
  owner_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  claimed_at timestamptz,
  last_message_at timestamptz NOT NULL,
  next_action text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX one_active_opportunity ON opportunities(contact_id) WHERE stage NOT IN ('WON','LOST');
CREATE INDEX reservation_expiry ON opportunities(expires_at) WHERE state = 'RESERVED';
CREATE TABLE inbound_events (
  external_id text PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  received_at timestamptz NOT NULL
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  opportunity_id uuid REFERENCES opportunities(id),
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE claims (
  user_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  starts_at timestamptz NOT NULL,
  unit text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_by uuid NOT NULL REFERENCES users(id)
);
