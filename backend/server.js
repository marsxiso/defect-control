require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

async function ensureSchema() {
  await pool.query(schemaSql);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Готова к проверке'`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
}

function isControlLocked(batch) {
  return batch.status === 'Отправлено на сборку';
}

async function getBatchById(client, batchId) {
  const result = await client.query(
    `SELECT b.*, w.full_name AS worker_name
     FROM batches b
     LEFT JOIN workers w ON w.id = b.assigned_worker_id
     WHERE b.id = $1`,
    [batchId],
  );
  return result.rows[0] || null;
}

async function getInspectionWithDefects(client, batchId) {
  const result = await client.query(
    `SELECT
       i.id AS inspection_id,
       i.batch_id,
       i.inspector_id,
       i.inspector_name,
       i.inspection_date,
       i.visual_conclusion,
       i.geometry_conclusion,
       i.accepted_count,
       i.rejected_count,
       i.comment,
       i.created_at,
       i.updated_at,
       d.id AS defect_id,
       d.defect_class,
       d.confidence,
       d.affected_count,
       d.comment AS defect_comment,
       d.image_uri
     FROM inspections i
     LEFT JOIN inspection_defects d ON d.inspection_id = i.id
     WHERE i.batch_id = $1
     ORDER BY d.id ASC`,
    [batchId],
  );

  if (result.rows.length === 0) return null;
  const head = result.rows[0];
  return {
    id: String(head.inspection_id),
    batchId: String(head.batch_id),
    inspectorId: head.inspector_id != null ? String(head.inspector_id) : null,
    inspector: head.inspector_name,
    date: String(head.inspection_date).slice(0, 10),
    visualConclusion: head.visual_conclusion || '',
    geometryConclusion: head.geometry_conclusion || '',
    acceptedCount: Number(head.accepted_count || 0),
    rejectedCount: Number(head.rejected_count || 0),
    comment: head.comment || '',
    defects: result.rows
      .filter((row) => row.defect_id != null)
      .map((row) => ({
        id: String(row.defect_id),
        defectClass: row.defect_class,
        confidence: Number(row.confidence || 0),
        affectedCount: Number(row.affected_count || 0),
        comment: row.defect_comment || '',
        imageUri: row.image_uri || undefined,
      })),
  };
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Server + DB OK' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'DB connection error', error: error.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      return res.status(400).json({ ok: false, message: 'Введите логин и пароль' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE login = $1 AND password_hash = $2',
      [login, password],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
    }

    const user = result.rows[0];
    res.json({
      ok: true,
      token: 'ok',
      user: {
        id: user.id,
        login: user.login,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('GET USERS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить пользователей' });
  }
});

app.get('/api/workers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workers ORDER BY full_name');
    res.json(result.rows);
  } catch (error) {
    console.error('GET WORKERS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить рабочих' });
  }
});

app.post('/api/workers', async (req, res) => {
  try {
    const { full_name } = req.body;
    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ ok: false, message: 'full_name обязателен' });
    }

    const result = await pool.query(
      'INSERT INTO workers (full_name) VALUES ($1) RETURNING *',
      [String(full_name).trim()],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось добавить рабочего' });
  }
});

app.get('/api/shifts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, w.full_name
       FROM shifts s
       JOIN workers w ON s.worker_id = w.id
       ORDER BY s.shift_date DESC, s.id DESC`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error('GET SHIFTS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить смены' });
  }
});

app.post('/api/shifts', async (req, res) => {
  try {
    const { worker_id, shift_date, shift_type, assigned_by } = req.body;
    if (!worker_id || !shift_date || !shift_type) {
      return res.status(400).json({ ok: false, message: 'worker_id, shift_date и shift_type обязательны' });
    }

    const existing = await pool.query(
      'SELECT id FROM shifts WHERE worker_id = $1 AND shift_date = $2',
      [worker_id, shift_date],
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Рабочий уже отмечен в смене на эту дату' });
    }

    const result = await pool.query(
      `INSERT INTO shifts (worker_id, shift_date, shift_type, assigned_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [worker_id, shift_date, shift_type, assigned_by || null],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать смену' });
  }
});

app.put('/api/shifts/:id', async (req, res) => {
  try {
    const { worker_id, shift_date, shift_type, assigned_by } = req.body;
    if (!worker_id || !shift_date || !shift_type) {
      return res.status(400).json({ ok: false, message: 'worker_id, shift_date и shift_type обязательны' });
    }

    const duplicate = await pool.query(
      'SELECT id FROM shifts WHERE worker_id = $1 AND shift_date = $2 AND id <> $3',
      [worker_id, shift_date, req.params.id],
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'На эту дату у рабочего уже есть смена' });
    }

    const result = await pool.query(
      `UPDATE shifts
       SET worker_id = $1, shift_date = $2, shift_type = $3, assigned_by = COALESCE($4, assigned_by), updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [worker_id, shift_date, shift_type, assigned_by || null, req.params.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Смена не найдена' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось изменить смену' });
  }
});

app.delete('/api/shifts/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM shifts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Смена не найдена' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить смену' });
  }
});

app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         b.*,
         w.full_name,
         u.full_name AS created_by_name
       FROM batches b
       LEFT JOIN workers w ON b.assigned_worker_id = w.id
       LEFT JOIN users u ON b.created_by = u.id
       ORDER BY b.id DESC`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error('GET BATCHES ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить партии' });
  }
});

app.post('/api/batches', async (req, res) => {
  try {
    const { batch_number, product_name, quantity, created_by, assigned_worker_id, status } = req.body;
    if (!batch_number || !product_name) {
      return res.status(400).json({ ok: false, message: 'batch_number и product_name обязательны' });
    }
    if (!assigned_worker_id) {
      return res.status(400).json({ ok: false, message: 'assigned_worker_id обязателен' });
    }

    const result = await pool.query(
      `INSERT INTO batches (batch_number, product_name, quantity, created_by, assigned_worker_id, status)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'Готова к проверке'))
       RETURNING *`,
      [batch_number, product_name, quantity || 0, created_by || null, assigned_worker_id, status || null],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать партию' });
  }
});

app.put('/api/batches/:id', async (req, res) => {
  try {
    const { product_name, quantity, assigned_worker_id, manufacture_date } = req.body;
    const current = await getBatchById(pool, req.params.id);
    if (!current) {
      return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    }
    if (isControlLocked(current)) {
      return res.status(409).json({ ok: false, message: 'Партия уже отправлена на сборку и не может быть изменена' });
    }

    const result = await pool.query(
      `UPDATE batches
       SET product_name = $1,
           quantity = $2,
           assigned_worker_id = $3,
           created_at = COALESCE($4::timestamp, created_at),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [product_name || current.product_name, quantity ?? current.quantity, assigned_worker_id || current.assigned_worker_id, manufacture_date || null, req.params.id],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось изменить партию' });
  }
});

app.delete('/api/batches/:id', async (req, res) => {
  try {
    const current = await getBatchById(pool, req.params.id);
    if (!current) {
      return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    }
    const inspection = await getInspectionWithDefects(pool, req.params.id);
    if (inspection || current.status === 'Проверена' || current.status === 'Отправлено на сборку') {
      return res.status(409).json({ ok: false, message: 'Партию нельзя удалить после начала контроля' });
    }

    await pool.query('DELETE FROM batches WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить партию' });
  }
});

app.post('/api/batches/:id/send-to-assembly', async (req, res) => {
  try {
    const inspection = await getInspectionWithDefects(pool, req.params.id);
    if (!inspection) {
      return res.status(409).json({ ok: false, message: 'Сначала сохраните контроль партии' });
    }

    const result = await pool.query(
      `UPDATE batches
       SET status = 'Отправлено на сборку', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('SEND TO ASSEMBLY ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось отправить партию на сборку' });
  }
});

app.get('/api/inspections', async (req, res) => {
  try {
    const batchFilter = req.query.batch_id ? 'WHERE i.batch_id = $1' : '';
    const params = req.query.batch_id ? [req.query.batch_id] : [];
    const result = await pool.query(
      `SELECT
         i.id AS inspection_id,
         i.batch_id,
         i.inspector_id,
         i.inspector_name,
         i.inspection_date,
         i.visual_conclusion,
         i.geometry_conclusion,
         i.accepted_count,
         i.rejected_count,
         i.comment,
         d.id AS defect_id,
         d.defect_class,
         d.confidence,
         d.affected_count,
         d.comment AS defect_comment,
         d.image_uri
       FROM inspections i
       LEFT JOIN inspection_defects d ON d.inspection_id = i.id
       ${batchFilter}
       ORDER BY i.inspection_date DESC, i.id DESC, d.id ASC`,
      params,
    );

    const grouped = new Map();
    for (const row of result.rows) {
      const key = String(row.inspection_id);
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: key,
          batchId: String(row.batch_id),
          inspectorId: row.inspector_id != null ? String(row.inspector_id) : null,
          inspector: row.inspector_name,
          date: String(row.inspection_date).slice(0, 10),
          visualConclusion: row.visual_conclusion || '',
          geometryConclusion: row.geometry_conclusion || '',
          acceptedCount: Number(row.accepted_count || 0),
          rejectedCount: Number(row.rejected_count || 0),
          comment: row.comment || '',
          defects: [],
        });
      }
      if (row.defect_id != null) {
        grouped.get(key).defects.push({
          id: String(row.defect_id),
          defectClass: row.defect_class,
          confidence: Number(row.confidence || 0),
          affectedCount: Number(row.affected_count || 0),
          comment: row.defect_comment || '',
          imageUri: row.image_uri || undefined,
        });
      }
    }

    res.json(Array.from(grouped.values()));
  } catch (error) {
    console.error('GET INSPECTIONS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить проверки' });
  }
});

app.post('/api/inspections', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      batch_id,
      inspector_id,
      inspector_name,
      inspection_date,
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    if (!batch_id || !inspector_name) {
      return res.status(400).json({ ok: false, message: 'batch_id и inspector_name обязательны' });
    }

    await client.query('BEGIN');
    const batch = await getBatchById(client, batch_id);
    if (!batch) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    }
    if (isControlLocked(batch)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: 'Партия уже отправлена на сборку' });
    }

    const existing = await getInspectionWithDefects(client, batch_id);
    if (existing) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: 'Проверка уже существует. Используйте обновление.' });
    }

    const inspectionResult = await client.query(
      `INSERT INTO inspections (
         batch_id, inspector_id, inspector_name, inspection_date,
         visual_conclusion, geometry_conclusion, accepted_count, rejected_count, comment
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        batch_id,
        inspector_id || null,
        inspector_name,
        inspection_date || new Date().toISOString().slice(0, 10),
        visual_conclusion || '',
        geometry_conclusion || '',
        accepted_count || 0,
        rejected_count || 0,
        comment || '',
      ],
    );

    const inspectionId = inspectionResult.rows[0].id;
    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          inspectionId,
          defect.defectClass || 'Неопределено',
          Number(defect.confidence || 0),
          Number(defect.affectedCount || 0),
          defect.comment || '',
          defect.imageUri || null,
        ],
      );
    }

    await client.query(
      `UPDATE batches SET status = 'Проверена', updated_at = NOW() WHERE id = $1`,
      [batch_id],
    );
    await client.query('COMMIT');

    const fullInspection = await getInspectionWithDefects(pool, batch_id);
    res.json(fullInspection);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('CREATE INSPECTION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось сохранить контроль' });
  } finally {
    client.release();
  }
});

app.put('/api/inspections/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      batch_id,
      inspector_id,
      inspector_name,
      inspection_date,
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    await client.query('BEGIN');
    const inspectionExists = await client.query('SELECT * FROM inspections WHERE id = $1', [req.params.id]);
    if (inspectionExists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: 'Проверка не найдена' });
    }

    const targetBatchId = batch_id || inspectionExists.rows[0].batch_id;
    const batch = await getBatchById(client, targetBatchId);
    if (!batch) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    }
    if (isControlLocked(batch)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: 'Данные контроля нельзя изменить: партия уже отправлена на сборку' });
    }

    await client.query(
      `UPDATE inspections
       SET inspector_id = $1,
           inspector_name = $2,
           inspection_date = $3,
           visual_conclusion = $4,
           geometry_conclusion = $5,
           accepted_count = $6,
           rejected_count = $7,
           comment = $8,
           updated_at = NOW()
       WHERE id = $9`,
      [
        inspector_id || null,
        inspector_name || inspectionExists.rows[0].inspector_name,
        inspection_date || inspectionExists.rows[0].inspection_date,
        visual_conclusion || '',
        geometry_conclusion || '',
        accepted_count || 0,
        rejected_count || 0,
        comment || '',
        req.params.id,
      ],
    );

    await client.query('DELETE FROM inspection_defects WHERE inspection_id = $1', [req.params.id]);
    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          req.params.id,
          defect.defectClass || 'Неопределено',
          Number(defect.confidence || 0),
          Number(defect.affectedCount || 0),
          defect.comment || '',
          defect.imageUri || null,
        ],
      );
    }

    await client.query('COMMIT');
    const fullInspection = await getInspectionWithDefects(pool, targetBatchId);
    res.json(fullInspection);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('UPDATE INSPECTION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить контроль' });
  } finally {
    client.release();
  }
});

app.post('/analyze-defect', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Файл не загружен' });
    }

    const image = fs.readFileSync(req.file.path, { encoding: 'base64' });
    const response = await axios({
      method: 'POST',
      url: process.env.ROBOFLOW_MODEL_URL,
      params: { api_key: process.env.ROBOFLOW_API_KEY },
      data: image,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.json(response.data);
  } catch (error) {
    console.error('AI ERROR:', error?.response?.data || error.message);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ ok: false, message: 'Ошибка анализа изображения' });
  }
});

const PORT = process.env.PORT || 8000;

ensureSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('SCHEMA INIT ERROR:', error);
    process.exit(1);
  });
