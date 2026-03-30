CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  full_name TEXT UNIQUE NOT NULL,
  login TEXT UNIQUE,
  password_hash TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  batch_number TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Создана',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  assigned_shift_type TEXT DEFAULT 'day',
  started_by_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  shift_date DATE NOT NULL,
  shift_type TEXT NOT NULL DEFAULT 'day',
  employee_type TEXT NOT NULL,
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
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS employee_type TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE shifts SET employee_type = COALESCE(employee_type, CASE WHEN user_id IS NOT NULL THEN 'controller' ELSE 'worker' END);

ALTER TABLE batches ADD COLUMN IF NOT EXISTS accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS employee_name TEXT;
UPDATE shifts SET employee_name = COALESCE(employee_name, 'Не указан');

ALTER TABLE workers ADD COLUMN IF NOT EXISTS login TEXT UNIQUE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS started_by_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS assigned_shift_type TEXT DEFAULT 'day';
ALTER TABLE inspection_defects ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'На рассмотрении';