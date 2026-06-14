-- Valor Tax automation schema for self-hosted Supabase (Postgres)
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT where applicable.

-- ---------------------------------------------------------------------------
-- task_logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  case_id INTEGER,
  lookup_method TEXT,
  task_id INTEGER,
  task_subject TEXT,
  officer_name TEXT,
  officer_user_id INTEGER,
  assignment_method TEXT,
  appointment_title TEXT,
  appointment_start TIMESTAMPTZ,
  appointment_end TIMESTAMPTZ,
  calendar_name TEXT,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  ai_summary TEXT,
  ai_transcript TEXT
);

ALTER TABLE task_logs DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- pending_tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_tasks (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  appointment_title TEXT,
  calendar_name TEXT,
  ai_summary TEXT,
  ai_transcript TEXT,
  case_id INTEGER,
  lookup_method TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  reason TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pending_tasks DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pending_tasks_status
  ON pending_tasks (status)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_pending_tasks_next_retry
  ON pending_tasks (next_retry_at)
  WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- officers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS officers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  phone TEXT DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE officers DISABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_officers_user_id_active
  ON officers (user_id)
  WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- round_robin
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS round_robin (
  id INTEGER PRIMARY KEY,
  current_index INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE round_robin DISABLE ROW LEVEL SECURITY;

INSERT INTO round_robin (id, current_index)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PostgREST / Supabase API access (service uses secret key server-side)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Seed officers (only when table is empty)
-- ---------------------------------------------------------------------------
INSERT INTO officers (name, user_id, phone, sort_order)
SELECT v.name, v.user_id, v.phone, v.sort_order
FROM (VALUES
  ('Anthony Edwards', 73, '(657) 204-1237', 0),
  ('David Wolfson', 71, '(657) 335-4205', 1),
  ('Dustin Boswell', 64, '(657) 300-0047', 2),
  ('Ellie London', 68, '(657) 204-1023', 3),
  ('John Gibson', 58, '(657) 900-4821', 4),
  ('Michael Rothberg', 35, '(657) 660-4448', 5),
  ('Nikki Dee', 42, '(657) 701-4979', 6),
  ('Oscar Morales', 75, '(657) 300-7148', 7),
  ('Ron Spencer', 78, '(657) 204-1011', 8),
  ('Val Vallery', 77, '(657) 600-0876', 9),
  ('Vanessa Thomas', 24, '(657) 348-2787', 10),
  ('Vincent Parks', 82, '(657) 312-3380', 11),
  ('Stanley Johnson', 83, '(657) 300-0018', 12)
) AS v(name, user_id, phone, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM officers LIMIT 1);
