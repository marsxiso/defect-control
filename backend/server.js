require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= ROOT
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// ================= HEALTH
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Server + DB OK' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'DB connection error', error: error.message });
  }
});

// ================= LOGIN
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

// ================= USERS
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('GET USERS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить пользователей' });
  }
});

// ================= WORKERS
app.get('/api/workers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workers ORDER BY id');
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
      'INSERT INTO workers (full_name) VALUES ($1) RETURNING *',
      [full_name]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось добавить рабочего' });
  }
});

// ================= BATCHES
app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM batches ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('GET BATCHES ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить партии' });
  }
});

app.post('/api/batches', async (req, res) => {
  try {
    const { batch_number, product_name, quantity, created_by } = req.body;

    if (!batch_number || !product_name) {
      return res.status(400).json({ ok: false, message: 'batch_number и product_name обязательны' });
    }

    const result = await pool.query(
      `INSERT INTO batches (batch_number, product_name, quantity, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [batch_number, product_name, quantity || 0, created_by || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать партию' });
  }
});

// ================= SHIFTS
app.get('/api/shifts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, w.full_name, b.batch_number
      FROM shifts s
      JOIN workers w ON s.worker_id = w.id
      JOIN batches b ON s.batch_id = b.id
      ORDER BY s.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET SHIFTS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить смены' });
  }
});

app.post('/api/shifts', async (req, res) => {
  try {
    const { worker_id, batch_id, shift_date, shift_type, assigned_by } = req.body;

    if (!worker_id || !batch_id || !shift_date || !shift_type) {
      return res.status(400).json({
        ok: false,
        message: 'worker_id, batch_id, shift_date и shift_type обязательны',
      });
    }

    const result = await pool.query(
      `INSERT INTO shifts (worker_id, batch_id, shift_date, shift_type, assigned_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [worker_id, batch_id, shift_date, shift_type, assigned_by || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать смену' });
  }
});

// ================= AI
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

    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json(response.data);
  } catch (error) {
    console.error('AI ERROR:', error?.response?.data || error.message);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({ ok: false, message: 'Ошибка анализа изображения' });
  }
});

const PORT = process.env.PORT || 8000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});