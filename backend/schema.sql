CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  full_name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  batch_number TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Готова к проверке',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  shift_date DATE NOT NULL,
  shift_type TEXT NOT NULL DEFAULT 'day',
  employee_type TEXT NOT NULL DEFAULT 'worker',
  worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shifts_employee_type_check CHECK (employee_type IN ('worker', 'controller'))
);

CREATE TABLE IF NOT EXISTS inspections (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL UNIQUE REFERENCES batches(id) ON DELETE CASCADE,
  inspector_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inspector_name TEXT NOT NULL DEFAULT '',
  inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
  visual_conclusion TEXT DEFAULT '',
  geometry_conclusion TEXT DEFAULT '',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_defects (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  defect_class TEXT NOT NULL,
  confidence NUMERIC(8,6) NOT NULL DEFAULT 0,
  affected_count INTEGER NOT NULL DEFAULT 0,
  comment TEXT DEFAULT '',
  image_uri TEXT
);

ALTER TABLE batches ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS employee_type TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS employee_name TEXT;

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS inspector_name TEXT;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE shifts ALTER COLUMN worker_id DROP NOT NULL;
ALTER TABLE shifts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE shifts ALTER COLUMN employee_type SET DEFAULT 'worker';

UPDATE shifts
SET employee_type = COALESCE(
  NULLIF(employee_type, ''),
  CASE WHEN user_id IS NOT NULL THEN 'controller' ELSE 'worker' END
);

UPDATE shifts
SET employee_name = COALESCE(
  NULLIF(employee_name, ''),
  CASE
    WHEN worker_id IS NOT NULL THEN (SELECT w.full_name FROM workers w WHERE w.id = shifts.worker_id)
    WHEN user_id IS NOT NULL THEN (SELECT u.full_name FROM users u WHERE u.id = shifts.user_id)
    ELSE 'Не указан'
  END
);

UPDATE inspections i
SET inspector_name = COALESCE(
  NULLIF(i.inspector_name, ''),
  u.full_name
)
FROM users u
WHERE u.id = i.inspector_id
  AND (i.inspector_name IS NULL OR i.inspector_name = '');

ALTER TABLE inspections ALTER COLUMN inspector_name SET DEFAULT '';
ALTER TABLE inspections ALTER COLUMN inspector_name SET NOT NULL;
