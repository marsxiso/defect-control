require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const upload = multer({ dest: 'uploads/' });
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Database connection will fail until it is configured.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Server + DB OK' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ ok: false, message: 'Укажите логин и пароль' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, message: 'Пользователь не найден' });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ ok: false, message: 'Неверный пароль' });
    }

    res.json({
      ok: true,
      token: 'ok',
      user: {
        id: user.id,
        login: user.login,
        role: user.role,
        full_name: user.full_name,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, login, full_name, role FROM users ORDER BY full_name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Не удалось получить пользователей' });
  }
});

app.post('/users', async (req, res) => {
  const { login, password, full_name, role } = req.body;

  if (!login || !password || !full_name || !role) {
    return res.status(400).json({ ok: false, message: 'Заполните login, password, full_name и role' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (login, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, login, full_name, role`,
      [login, hash, full_name, role]
    );

    res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Не удалось создать пользователя' });
  }
});

app.patch('/users/:id/password', async (req, res) => {
  const { password } = req.body;
  const { id } = req.params;

  if (!password) {
    return res.status(400).json({ ok: false, message: 'Введите пароль' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Не удалось обновить пароль' });
  }
});

app.post('/analyze-defect', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Файл не загружен' });
  }

  try {
    const image = fs.readFileSync(req.file.path, { encoding: 'base64' });

    const response = await axios({
      method: 'POST',
      url: process.env.ROBOFLOW_MODEL_URL,
      params: {
        api_key: process.env.ROBOFLOW_API_KEY,
      },
      data: image,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    fs.unlinkSync(req.file.path);
    res.json(response.data);
  } catch (err) {
    console.error(err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ ok: false, error: 'Ошибка анализа изображения' });
  }
});

const PORT = process.env.PORT || 8000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
