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

async function runSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await pool.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS sent_to_assembly_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE inspection_defects ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'На рассмотрении'");
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapInspectionRow(row) {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id),
    inspector_id: String(row.inspector_id),
    inspector_name: row.inspector_name,
    inspection_date: new Date(row.inspection_date).toISOString().slice(0, 10),
    visual_conclusion: row.visual_conclusion || '',
    geometry_conclusion: row.geometry_conclusion || '',
    accepted_count: Number(row.accepted_count || 0),
    rejected_count: Number(row.rejected_count || 0),
    comment: row.comment || '',
    defects: Array.isArray(row.defects) ? row.defects : [],
  };
}

async function getInspectionByBatch(batchId) {
  const result = await pool.query(
    `SELECT
      i.*,
      u.full_name AS inspector_name,
      COALESCE(
        json_agg(
          json_build_object(
            'id', d.id,
            'defect_class', d.defect_class,
            'confidence', d.confidence,
            'affected_count', d.affected_count,
            'comment', d.comment,
            'review_status', d.review_status,
            'image_uri', d.image_uri
          )
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ) AS defects
    FROM inspections i
    JOIN users u ON u.id = i.inspector_id
    LEFT JOIN inspection_defects d ON d.inspection_id = i.id
    WHERE i.batch_id = $1
    GROUP BY i.id, u.full_name`,
    [batchId]
  );
  return result.rows[0] ? mapInspectionRow(result.rows[0]) : null;
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
      [login, password]
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


app.put('/api/users/:id', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    const { full_name, login, password, role, editor_role } = req.body;
    if (editor_role !== 'Администратор') {
      return res.status(403).json({ ok: false, message: 'Только администратор может редактировать пользователей' });
    }
    if (!full_name || !login || !role) {
      return res.status(400).json({ ok: false, message: 'Заполните имя, логин и роль' });
    }
    const fields = [full_name.trim(), login.trim(), role, userId];
    let query = `UPDATE users SET full_name = $1, login = $2, role = $3`;
    if (password && String(password).trim()) {
      query += `, password_hash = $5`;
      fields.push(String(password).trim());
      query += ` WHERE id = $4 RETURNING *`;
      const reordered = [fields[0], fields[1], fields[2], fields[3], fields[4]];
      const result = await pool.query(query, reordered);
      return res.json(result.rows[0]);
    }
    query += ` WHERE id = $4 RETURNING *`;
    const result = await pool.query(query, fields);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE USER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить пользователя' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    const { editor_role } = req.body;
    if (editor_role !== 'Администратор') {
      return res.status(403).json({ ok: false, message: 'Только администратор может удалять пользователей' });
    }
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
    if (user.role === 'admin' || user.role === 'Администратор') {
      return res.status(400).json({ ok: false, message: 'Нельзя удалить учетную запись администратора' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE USER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить пользователя' });
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
    if (!full_name) {
      return res.status(400).json({ ok: false, message: 'full_name обязателен' });
    }
    const result = await pool.query(
      'INSERT INTO workers (full_name) VALUES ($1) ON CONFLICT (full_name) DO NOTHING RETURNING *',
      [full_name.trim()]
    );
    if (!result.rows[0]) {
      return res.status(400).json({ ok: false, message: 'Такой рабочий уже существует' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось добавить рабочего' });
  }
});


app.put('/api/workers/:id', async (req, res) => {
  try {
    const workerId = toInt(req.params.id);
    const { full_name, editor_role } = req.body;
    if (editor_role !== 'Администратор') {
      return res.status(403).json({ ok: false, message: 'Только администратор может редактировать рабочих' });
    }
    if (!full_name) {
      return res.status(400).json({ ok: false, message: 'full_name обязателен' });
    }
    const result = await pool.query('UPDATE workers SET full_name = $1 WHERE id = $2 RETURNING *', [full_name.trim(), workerId]);
    if (!result.rows[0]) return res.status(404).json({ ok: false, message: 'Рабочий не найден' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить рабочего' });
  }
});

app.delete('/api/workers/:id', async (req, res) => {
  try {
    const workerId = toInt(req.params.id);
    const { editor_role } = req.body;
    if (editor_role !== 'Администратор') {
      return res.status(403).json({ ok: false, message: 'Только администратор может удалять рабочих' });
    }
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить рабочего' });
  }
});

app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.*,
        w.full_name,
        creator.full_name AS creator_name,
        i.id AS inspection_id,
        i.inspector_id,
        inspector.full_name AS inspector_name,
        i.inspection_date,
        i.accepted_count,
        i.rejected_count,
        i.comment AS inspection_comment,
        b.accepted_by_user_id,
        b.sent_to_assembly_at
      FROM batches b
      LEFT JOIN workers w ON b.assigned_worker_id = w.id
      LEFT JOIN users creator ON b.created_by = creator.id
      LEFT JOIN inspections i ON i.batch_id = b.id
      LEFT JOIN users inspector ON i.inspector_id = inspector.id
      ORDER BY b.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET BATCHES ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить партии' });
  }
});

app.post('/api/batches', async (req, res) => {
  try {
    const { batch_number, product_name, quantity, created_by, assigned_worker_id } = req.body;
    if (!batch_number || !product_name || !assigned_worker_id) {
      return res.status(400).json({ ok: false, message: 'Не все обязательные поля заполнены' });
    }
    const result = await pool.query(
      `INSERT INTO batches (batch_number, product_name, quantity, created_by, assigned_worker_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [batch_number, product_name.trim(), quantity || 0, created_by || null, assigned_worker_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать партию' });
  }
});

app.put('/api/batches/:id', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id);
    const { product_name, quantity, assigned_worker_id, manufacture_date } = req.body;
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно редактировать только свои партии' });
    }
    if (batch.status !== 'Готова к проверке') {
      return res.status(400).json({ ok: false, message: 'Проверенную партию редактировать нельзя' });
    }
    const updated = await pool.query(
      `UPDATE batches
       SET product_name = $1,
           quantity = $2,
           assigned_worker_id = $3,
           created_at = COALESCE($4::timestamptz, created_at)
       WHERE id = $5
       RETURNING *`,
      [product_name.trim(), quantity || 0, assigned_worker_id, manufacture_date || null, batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('UPDATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить партию' });
  }
});

app.delete('/api/batches/:id', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id || req.query.editor_id);
    const editorRole = req.body.editor_role || req.query.editor_role;
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    const isAdmin = editorRole === 'Администратор' || editorRole === 'admin';
    if (!isAdmin && String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно удалять только свои партии' });
    }
    await pool.query('DELETE FROM batches WHERE id = $1', [batchId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить партию' });
  }
});

app.post('/api/batches/:id/accept', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const userId = toInt(req.body.user_id);
    if (!batchId || !userId) {
      return res.status(400).json({ ok: false, message: 'batch_id и user_id обязательны' });
    }

    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status !== 'Готова к проверке') {
      return res.status(400).json({ ok: false, message: 'Принять можно только партию, готовую к проверке' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(userId)) {
      return res.status(400).json({ ok: false, message: 'Партия уже принята другим сотрудником' });
    }

    const updated = await pool.query(
      'UPDATE batches SET accepted_by_user_id = $1 WHERE id = $2 RETURNING *',
      [userId, batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('ACCEPT BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось принять партию' });
  }
});


app.post('/api/batches/:id/cancel-accept', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const userId = toInt(req.body.user_id);
    if (!batchId || !userId) {
      return res.status(400).json({ ok: false, message: 'batch_id и user_id обязательны' });
    }

    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.accepted_by_user_id || '') !== String(userId)) {
      return res.status(403).json({ ok: false, message: 'Отменить контроль может только принявший сотрудник' });
    }

    const inspectionResult = await pool.query('SELECT id FROM inspections WHERE batch_id = $1 LIMIT 1', [batchId]);
    if (inspectionResult.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Нельзя отменить контроль после сохранения проверки' });
    }

    const updated = await pool.query(
      'UPDATE batches SET accepted_by_user_id = NULL WHERE id = $1 RETURNING *',
      [batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('CANCEL ACCEPT BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось отменить контроль' });
  }
});

app.post('/api/batches/:id/mark-ready-to-send', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id);
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Подготовить к отправке может только создатель партии' });
    }
    if (batch.status !== 'Проверена') {
      return res.status(400).json({ ok: false, message: 'Подготовить к отправке можно только проверенную партию' });
    }
    const result = await pool.query(
      `UPDATE batches SET status = 'Готова к отправке' WHERE id = $1 RETURNING *`,
      [batchId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('MARK READY TO SEND ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось подготовить партию к отправке' });
  }
});

app.post('/api/batches/:id/send-to-assembly', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id);
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Отправить на сборку может только создатель партии' });
    }
    if (batch.status !== 'Готова к отправке') {
      return res.status(400).json({ ok: false, message: 'На сборку можно отправить только партию со статусом «Готова к отправке»' });
    }
    const result = await pool.query(
      `UPDATE batches SET status = 'Отправлено на сборку', sent_to_assembly_at = NOW() WHERE id = $1 RETURNING *`,
      [batchId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('SEND TO ASSEMBLY ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось отправить партию на сборку' });
  }
});

app.get('/api/shifts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.*,
        COALESCE(w.full_name, u.full_name, s.employee_name) AS full_name,
        COALESCE(s.employee_type, CASE WHEN s.user_id IS NOT NULL THEN 'controller' ELSE 'worker' END) AS employee_type,
        CASE
          WHEN s.user_id IS NOT NULL AND u.role IN ('Контрольный мастер', 'quality_master', 'control_master') THEN 'Контрольный мастер'
          WHEN s.user_id IS NOT NULL THEN 'Контролер'
          ELSE 'Рабочий'
        END AS role_label
      FROM shifts s
      LEFT JOIN workers w ON s.worker_id = w.id
      LEFT JOIN users u ON s.user_id = u.id
      ORDER BY s.shift_date DESC, s.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET SHIFTS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить смены' });
  }
});

app.post('/api/shifts', async (req, res) => {
  try {
    const { worker_id, user_id, shift_date, shift_type, assigned_by, employee_type } = req.body;
    if (!shift_date || !shift_type || !employee_type) {
      return res.status(400).json({ ok: false, message: 'Не все обязательные поля заполнены' });
    }
    if (employee_type === 'worker' && !worker_id) {
      return res.status(400).json({ ok: false, message: 'Не выбран рабочий' });
    }
    if (employee_type === 'controller' && !user_id) {
      return res.status(400).json({ ok: false, message: 'Не выбран контролер' });
    }

    const duplicate = employee_type === 'worker'
      ? await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND worker_id = $2 AND shift_date = $3', [employee_type, worker_id, shift_date])
      : await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND user_id = $2 AND shift_date = $3', [employee_type, user_id, shift_date]);

    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Сотрудник уже назначен на эту дату' });
    }

    const employeeLookup = employee_type === 'worker'
      ? await pool.query('SELECT full_name FROM workers WHERE id = $1', [worker_id])
      : await pool.query('SELECT full_name FROM users WHERE id = $1', [user_id]);
    const employeeName = employeeLookup.rows[0]?.full_name || null;

    const result = await pool.query(
      `INSERT INTO shifts (worker_id, user_id, shift_date, shift_type, assigned_by, employee_type, employee_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [worker_id || null, user_id || null, shift_date, shift_type, assigned_by || null, employee_type, employeeName]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать смену' });
  }
});

app.put('/api/shifts/:id', async (req, res) => {
  try {
    const shiftId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id);
    const { shift_date } = req.body;
    const shiftResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const shift = shiftResult.rows[0];
    if (!shift) return res.status(404).json({ ok: false, message: 'Смена не найдена' });
    const editorRole = req.body.editor_role;
    const isAdmin = editorRole === 'Администратор' || editorRole === 'admin';
    if (!isAdmin && String(shift.assigned_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно редактировать только свои смены' });
    }
    const duplicate = shift.employee_type === 'worker'
      ? await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND worker_id = $2 AND shift_date = $3 AND id <> $4', [shift.employee_type, shift.worker_id, shift_date, shiftId])
      : await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND user_id = $2 AND shift_date = $3 AND id <> $4', [shift.employee_type, shift.user_id, shift_date, shiftId]);
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'На эту дату уже есть такая смена' });
    }
    const result = await pool.query('UPDATE shifts SET shift_date = $1 WHERE id = $2 RETURNING *', [shift_date, shiftId]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить смену' });
  }
});

app.delete('/api/shifts/:id', async (req, res) => {
  try {
    const shiftId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id || req.query.editor_id);
    const editorRole = req.body.editor_role || req.query.editor_role;
    const shiftResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const shift = shiftResult.rows[0];
    if (!shift) return res.status(404).json({ ok: false, message: 'Смена не найдена' });
    const isAdmin = editorRole === 'Администратор' || editorRole === 'admin';
    if (!isAdmin && String(shift.assigned_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно удалять только свои смены' });
    }
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить смену' });
  }
});

app.get('/api/inspections', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        i.*,
        u.full_name AS inspector_name,
        COALESCE(
          json_agg(
            json_build_object(
              'id', d.id,
              'defect_class', d.defect_class,
              'confidence', d.confidence,
              'affected_count', d.affected_count,
              'comment', d.comment,
              'image_uri', d.image_uri
            )
          ) FILTER (WHERE d.id IS NOT NULL),
          '[]'::json
        ) AS defects
      FROM inspections i
      JOIN users u ON u.id = i.inspector_id
      LEFT JOIN inspection_defects d ON d.inspection_id = i.id
      GROUP BY i.id, u.full_name
      ORDER BY i.id DESC
    `);
    res.json(result.rows.map(mapInspectionRow));
  } catch (error) {
    console.error('GET INSPECTIONS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить результаты контроля' });
  }
});

app.post('/api/inspections', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      batch_id,
      inspector_id,
      inspector_name,
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    let resolvedInspectorId = toInt(inspector_id);
    if (!resolvedInspectorId && inspector_name) {
      const inspectorResult = await client.query('SELECT id FROM users WHERE full_name = $1 LIMIT 1', [inspector_name]);
      resolvedInspectorId = toInt(inspectorResult.rows[0]?.id);
    }

    if (!batch_id || !resolvedInspectorId) {
      return res.status(400).json({ ok: false, message: 'batch_id и inspector_id обязательны' });
    }

    const batchResult = await client.query('SELECT * FROM batches WHERE id = $1', [batch_id]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status === 'Готова к отправке' || batch.status === 'Отправлено на сборку') {
      return res.status(400).json({ ok: false, message: 'Партия уже недоступна для редактирования контроля' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(resolvedInspectorId)) {
      return res.status(403).json({ ok: false, message: 'Сохранять контроль может только сотрудник, принявший партию' });
    }

    const existing = await client.query('SELECT * FROM inspections WHERE batch_id = $1', [batch_id]);
    if (existing.rows[0]) {
      return res.status(400).json({ ok: false, message: 'Для партии уже есть контроль. Используйте обновление.' });
    }

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO inspections (
        batch_id, inspector_id, inspection_date, visual_conclusion, geometry_conclusion,
        accepted_count, rejected_count, comment
      ) VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7)
      RETURNING *`,
      [batch_id, resolvedInspectorId, visual_conclusion || '', geometry_conclusion || '', accepted_count || 0, rejected_count || 0, comment || '']
    );
    const inspection = inserted.rows[0];

    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [inspection.id, defect.defect_class, defect.confidence || 0, defect.affected_count || 0, defect.comment || '', defect.image_uri || null, defect.review_status || 'На рассмотрении']
      );
    }

    await client.query(`UPDATE batches SET status = 'Проверена', accepted_by_user_id = $2 WHERE id = $1`, [batch_id, resolvedInspectorId]);
    await client.query('COMMIT');

    res.json(await getInspectionByBatch(batch_id));
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
    const inspectionId = toInt(req.params.id);
    const editorId = toInt(req.body.editor_id);
    const {
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    const existingResult = await client.query('SELECT * FROM inspections WHERE id = $1', [inspectionId]);
    const inspection = existingResult.rows[0];
    if (!inspection) return res.status(404).json({ ok: false, message: 'Контроль не найден' });

    const batchResult = await client.query('SELECT * FROM batches WHERE id = $1', [inspection.batch_id]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status === 'Готова к отправке' || batch.status === 'Отправлено на сборку') {
      return res.status(400).json({ ok: false, message: 'После подготовки к отправке контроль менять нельзя' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(editorId)) {
      return res.status(403).json({ ok: false, message: 'Изменять контроль может только сотрудник, принявший партию' });
    }
    if (String(inspection.inspector_id) !== String(editorId)) {
      return res.status(403).json({ ok: false, message: 'Изменять проверенную партию может только тот, кто ее проверял' });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE inspections SET
        visual_conclusion = $1,
        geometry_conclusion = $2,
        accepted_count = $3,
        rejected_count = $4,
        comment = $5,
        updated_at = NOW()
      WHERE id = $6`,
      [visual_conclusion || '', geometry_conclusion || '', accepted_count || 0, rejected_count || 0, comment || '', inspectionId]
    );
    await client.query('DELETE FROM inspection_defects WHERE inspection_id = $1', [inspectionId]);
    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [inspectionId, defect.defect_class, defect.confidence || 0, defect.affected_count || 0, defect.comment || '', defect.image_uri || null, defect.review_status || 'На рассмотрении']
      );
    }
    await client.query('COMMIT');
    res.json(await getInspectionByBatch(inspection.batch_id));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('UPDATE INSPECTION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить контроль' });
  } finally {
    client.release();
  }
});


app.put('/api/inspection-defects/:id/status', async (req, res) => {
  try {
    const defectId = toInt(req.params.id);
    const { review_status } = req.body;
    if (!['Забраковано', 'На рассмотрении', 'Допущено до сборки'].includes(review_status)) {
      return res.status(400).json({ ok: false, message: 'Некорректный статус брака' });
    }
    const result = await pool.query(
      'UPDATE inspection_defects SET review_status = $1 WHERE id = $2 RETURNING *',
      [review_status, defectId],
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, message: 'Дефект не найден' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE DEFECT STATUS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить статус брака' });
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

runSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('SCHEMA INIT ERROR:', error);
    process.exit(1);
  });
