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
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  shift_type TEXT NOT NULL DEFAULT 'day',
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(worker_id, shift_date)
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  batch_number TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Готова к проверке',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspections (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL UNIQUE REFERENCES batches(id) ON DELETE CASCADE,
  inspector_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  inspector_name TEXT NOT NULL,
  inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
  visual_conclusion TEXT DEFAULT '',
  geometry_conclusion TEXT DEFAULT '',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  comment TEXT DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_defects (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  defect_class TEXT NOT NULL,
  confidence NUMERIC(10,6) NOT NULL DEFAULT 0,
  affected_count INTEGER NOT NULL DEFAULT 0,
  comment TEXT DEFAULT '',
  image_uri TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
