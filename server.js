const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cookieParser = require('cookie-parser');
const express = require('express');
const { Pool, types: pgTypes } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const USE_POSTGRES = !!process.env.DATABASE_URL;
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'app.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_IMAGE_SUB_DIR = path.join('uploads', 'code-images');
const CODE_IMAGE_DIR = path.join(PUBLIC_DIR, CODE_IMAGE_SUB_DIR);
const MAX_CODE_IMAGE_BYTES = 5 * 1024 * 1024;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'code-images';
const USE_SUPABASE_STORAGE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let sqlite3 = null;

if (pgTypes && typeof pgTypes.setTypeParser === 'function') {
  // Keep BIGINT fields consistent with sqlite numeric behavior for IDs and counts.
  pgTypes.setTypeParser(20, (value) => Number(value));
}

if (!USE_POSTGRES) {
  try {
    sqlite3 = require('sqlite3').verbose();
  } catch (_err) {
    throw new Error('sqlite3 模块不可用。请安装 sqlite3，或设置 DATABASE_URL 走 Postgres 模式。');
  }
}

if (!USE_POSTGRES && !fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

if (!USE_SUPABASE_STORAGE && !fs.existsSync(CODE_IMAGE_DIR)) {
  fs.mkdirSync(CODE_IMAGE_DIR, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

const db = USE_POSTGRES ? null : new sqlite3.Database(DB_PATH);
const pgPool = USE_POSTGRES
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' || process.env.DB_SSL === '1'
      ? { rejectUnauthorized: false }
      : undefined,
    max: Number(process.env.DB_POOL_MAX || 10),
  })
  : null;

const supabaseStorage = USE_SUPABASE_STORAGE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
let initPromise = null;

function toPgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initDb();
  }
  return initPromise;
}

function appendReturningIdIfNeeded(sql) {
  const trimmed = String(sql || '').trim();
  if (!/^insert\s+/i.test(trimmed)) {
    return sql;
  }
  if (/returning\s+/i.test(trimmed)) {
    return sql;
  }
  return `${trimmed} RETURNING id`;
}

async function dbRun(sql, params = []) {
  if (USE_POSTGRES) {
    const text = toPgSql(appendReturningIdIfNeeded(sql));
    const result = await pgPool.query(text, params);
    const insertedId = result.rows[0] && result.rows[0].id !== undefined
      ? Number(result.rows[0].id)
      : null;
    return { lastID: insertedId, changes: result.rowCount || 0, rows: result.rows || [] };
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes, rows: [] });
      }
    });
  });
}

async function dbGet(sql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(toPgSql(sql), params);
    return result.rows[0] || null;
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
}

async function dbAll(sql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(toPgSql(sql), params);
    return result.rows || [];
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.includes(':')) {
    return false;
  }
  const [salt, expectedHex] = passwordHash.split(':');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

function base64UrlEncode(raw) {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(raw) {
  const padLen = (4 - (raw.length % 4)) % 4;
  const padded = `${raw}${'='.repeat(padLen)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signTokenPayload(payloadBase64) {
  return crypto
    .createHmac('sha256', APP_SECRET)
    .update(payloadBase64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createAuthToken(type, userId) {
  const payload = {
    t: type,
    u: userId,
    e: Date.now() + TOKEN_TTL_MS,
  };
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signTokenPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

function verifyAuthToken(token, expectedType) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadBase64, signature] = token.split('.', 2);
  if (!payloadBase64 || !signature) {
    return null;
  }

  const expectedSignature = signTokenPayload(payloadBase64);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadBase64));
  } catch (_err) {
    return null;
  }

  if (!payload || payload.t !== expectedType || !payload.u || !payload.e) {
    return null;
  }
  if (Number(payload.e) <= Date.now()) {
    return null;
  }
  return payload;
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: TOKEN_TTL_MS,
  };
}

function normalizeString(value, fieldName, options = {}) {
  const { required = false, maxLength = 120 } = options;
  if (value === undefined || value === null) {
    if (required) {
      throw new AppError(400, `${fieldName} 不能为空`);
    }
    return null;
  }

  const text = String(value).trim();
  if (!text && required) {
    throw new AppError(400, `${fieldName} 不能为空`);
  }
  if (text.length > maxLength) {
    throw new AppError(400, `${fieldName} 长度不能超过 ${maxLength}`);
  }
  return text || null;
}

function normalizeScore(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const score = Number(value);
  if (Number.isNaN(score)) {
    throw new AppError(400, '评分必须是数字');
  }
  return score;
}

function normalizeTeacherScore(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const score = Number(value);
  if (Number.isNaN(score)) {
    throw new AppError(400, '评分必须是数字');
  }
  if (score < 0 || score > 10) {
    throw new AppError(400, '评分必须在 0 到 10 之间');
  }
  return score;
}

function normalizeCodeText(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const text = String(value);
  if (text.length > 20000) {
    throw new AppError(400, '代码文本长度不能超过 20000 个字符');
  }
  return text.trim() === '' ? null : text;
}

function parseCodeImage(imageBase64, imageMimeType) {
  let raw = String(imageBase64 || '').trim();
  if (!raw) {
    throw new AppError(400, '图片内容为空');
  }

  let mime = imageMimeType ? String(imageMimeType).trim().toLowerCase() : '';
  const dataUrlMatch = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    if (!mime) {
      mime = dataUrlMatch[1].toLowerCase();
    }
    raw = dataUrlMatch[2];
  }

  const extMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
  };
  const ext = extMap[mime];
  if (!ext) {
    throw new AppError(400, '仅支持 PNG/JPEG/WEBP 图片');
  }

  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new AppError(400, '图片 base64 格式不正确');
  }

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new AppError(400, '图片内容为空');
  }
  if (buffer.length > MAX_CODE_IMAGE_BYTES) {
    throw new AppError(400, '图片大小不能超过 5MB');
  }

  return { buffer, ext, mime };
}

async function saveCodeImage(imageBase64, imageMimeType) {
  const { buffer, ext, mime } = parseCodeImage(imageBase64, imageMimeType);
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

  if (supabaseStorage) {
    const objectPath = `student-code/${filename}`;
    const { error: uploadError } = await supabaseStorage.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(objectPath, buffer, {
        contentType: mime,
        upsert: false,
      });
    if (uploadError) {
      throw new AppError(500, `上传图片失败: ${uploadError.message}`);
    }

    const publicData = supabaseStorage.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(objectPath);
    if (!publicData || !publicData.data || !publicData.data.publicUrl) {
      throw new AppError(500, '无法获取图片公开地址');
    }
    return publicData.data.publicUrl;
  }

  const absolutePath = path.join(CODE_IMAGE_DIR, filename);
  fs.writeFileSync(absolutePath, buffer);
  return `/${CODE_IMAGE_SUB_DIR.replace(/\\/g, '/')}/${filename}`;
}

function getSupabaseObjectPathFromUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return null;
  }
  const marker = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const encodedPath = imageUrl.slice(idx + marker.length);
  if (!encodedPath) {
    return null;
  }
  return decodeURIComponent(encodedPath);
}

async function removeCodeImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return;
  }

  if (supabaseStorage) {
    const objectPath = getSupabaseObjectPathFromUrl(imageUrl);
    if (objectPath) {
      await supabaseStorage.storage
        .from(SUPABASE_STORAGE_BUCKET)
        .remove([objectPath]);
      return;
    }
  }

  if (!imageUrl.startsWith('/uploads/code-images/')) {
    return;
  }

  const filename = path.basename(imageUrl);
  const absolutePath = path.join(CODE_IMAGE_DIR, filename);
  if (fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

function getStudentToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies.student_token;
}

function requireTeacher(req, res, next) {
  const token = req.cookies.teacher_token;
  const payload = verifyAuthToken(token, 'teacher');
  if (!payload) {
    return res.status(401).json({ message: '老师未登录' });
  }
  req.teacherId = Number(payload.u);
  req.teacherToken = token;
  return next();
}

function requireStudent(req, res, next) {
  const token = getStudentToken(req);
  const payload = verifyAuthToken(token, 'student');
  if (!payload) {
    return res.status(401).json({ message: '学生未登录' });
  }
  req.studentId = Number(payload.u);
  req.studentToken = token;
  return next();
}

function buildTree(nodes) {
  const nodeMap = new Map();
  nodes.forEach((item) => {
    nodeMap.set(item.id, {
      id: item.id,
      name: item.name,
      parentId: item.parent_id,
      sortOrder: item.sort_order,
      score: item.score,
      comment: item.comment,
      codeText: item.code_text,
      codeImageUrl: item.code_image_url,
      submissionCount: Number(item.submission_count || 0),
      latestTeacherScore: item.latest_teacher_score,
      latestTeacherComment: item.latest_teacher_comment,
      latestSubmittedAt: item.latest_submitted_at,
      highestTeacherScore: item.highest_teacher_score,
      averageTeacherScore: item.avg_teacher_score,
      submissionHistory: item.submission_history || [],
      children: [],
    });
  });

  let root = null;
  nodes.forEach((item) => {
    const current = nodeMap.get(item.id);
    if (item.parent_id === null) {
      root = current;
    } else {
      const parent = nodeMap.get(item.parent_id);
      if (parent) {
        parent.children.push(current);
      }
    }
  });

  function sortChildren(node) {
    node.children.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
    node.children.forEach(sortChildren);
  }

  if (root) {
    sortChildren(root);
  }

  return root;
}

async function fetchWeChatOpenId(code) {
  const appId = process.env.WECHAT_APPID;
  const secret = process.env.WECHAT_SECRET;

  if (!appId || !secret) {
    throw new AppError(500, '服务端未配置微信参数 WECHAT_APPID/WECHAT_SECRET');
  }

  if (!code) {
    throw new AppError(400, '缺少微信登录 code');
  }

  const params = new URLSearchParams({
    appid: appId,
    secret,
    js_code: code,
    grant_type: 'authorization_code',
  });

  const url = `https://api.weixin.qq.com/sns/jscode2session?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new AppError(502, `微信接口请求失败: HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.openid) {
    const details = result.errmsg ? `${result.errmsg} (${result.errcode || ''})` : '未返回 openid';
    throw new AppError(400, `微信登录失败: ${details}`);
  }

  return result.openid;
}

async function initDb() {
  if (!USE_POSTGRES) {
    await dbRun('PRAGMA foreign_keys = ON');

    await dbRun(`
      CREATE TABLE IF NOT EXISTS teachers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        wechat_openid TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS learning_trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        chapter_desc TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL,
        parent_id INTEGER,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tree_id) REFERENCES learning_trees(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        score REAL,
        comment TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, node_id),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_node_works (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        code_text TEXT,
        code_image_url TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, node_id),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_node_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        code_text TEXT,
        code_image_url TEXT,
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        teacher_score REAL,
        teacher_comment TEXT,
        scored_at TEXT,
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
      )
    `);
  } else {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS teachers (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS students (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        wechat_openid TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS learning_trees (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        chapter_desc TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id BIGSERIAL PRIMARY KEY,
        tree_id BIGINT NOT NULL REFERENCES learning_trees(id) ON DELETE CASCADE,
        parent_id BIGINT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_scores (
        id BIGSERIAL PRIMARY KEY,
        student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        node_id BIGINT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        score DOUBLE PRECISION,
        comment TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, node_id)
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_node_works (
        id BIGSERIAL PRIMARY KEY,
        student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        node_id BIGINT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        code_text TEXT,
        code_image_url TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, node_id)
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS student_node_submissions (
        id BIGSERIAL PRIMARY KEY,
        student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        node_id BIGINT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        code_text TEXT,
        code_image_url TEXT,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        teacher_score DOUBLE PRECISION,
        teacher_comment TEXT,
        scored_at TIMESTAMPTZ
      )
    `);
  }

  // 数据迁移：将旧版单条作业记录迁移为提交记录，避免历史数据丢失。
  await dbRun(`
    INSERT INTO student_node_submissions (
      student_id,
      node_id,
      code_text,
      code_image_url,
      submitted_at
    )
    SELECT
      w.student_id,
      w.node_id,
      w.code_text,
      w.code_image_url,
      COALESCE(w.updated_at, CURRENT_TIMESTAMP)
    FROM student_node_works w
    WHERE (w.code_text IS NOT NULL OR w.code_image_url IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1
        FROM student_node_submissions s
        WHERE s.student_id = w.student_id
          AND s.node_id = w.node_id
      )
  `);

  await dbRun(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_one_root_per_tree
    ON knowledge_nodes(tree_id)
    WHERE parent_id IS NULL
  `);

  const admin = await dbGet('SELECT id FROM teachers WHERE username = ?', ['admin']);
  if (!admin) {
    const passwordHash = createPasswordHash('admin123');
    await dbRun('INSERT INTO teachers (username, password_hash) VALUES (?, ?)', ['admin', passwordHash]);
    console.log('已创建默认老师账号: admin / admin123');
  }
}

app.use(asyncHandler(async (_req, _res, next) => {
  await ensureInitialized();
  next();
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/api/teacher/login', asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });

  const teacher = await dbGet('SELECT id, username, password_hash FROM teachers WHERE username = ?', [username]);
  if (!teacher || !verifyPassword(password, teacher.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  const token = createAuthToken('teacher', teacher.id);
  res.cookie('teacher_token', token, getCookieOptions());

  res.json({ id: teacher.id, username: teacher.username });
}));

app.post('/api/teacher/logout', requireTeacher, asyncHandler(async (req, res) => {
  res.clearCookie('teacher_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
  });
  res.json({ ok: true });
}));

app.get('/api/teacher/me', requireTeacher, asyncHandler(async (req, res) => {
  const teacher = await dbGet('SELECT id, username, created_at FROM teachers WHERE id = ?', [req.teacherId]);
  if (!teacher) {
    throw new AppError(401, '老师会话已失效');
  }
  res.json(teacher);
}));

app.get('/api/students', requireTeacher, asyncHandler(async (_req, res) => {
  const students = await dbAll(`
    SELECT id, username, name, wechat_openid, created_at
    FROM students
    ORDER BY id DESC
  `);
  res.json(students);
}));

app.post('/api/students', requireTeacher, asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const name = normalizeString(req.body.name, '姓名', { maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });

  const passwordHash = createPasswordHash(password);

  const result = await dbRun(
    'INSERT INTO students (username, password_hash, name) VALUES (?, ?, ?)',
    [username, passwordHash, name],
  );

  const student = await dbGet(
    'SELECT id, username, name, wechat_openid, created_at FROM students WHERE id = ?',
    [result.lastID],
  );

  res.status(201).json(student);
}));

app.put('/api/students/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '学生 ID 不合法');
  }

  const existing = await dbGet('SELECT * FROM students WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError(404, '学生不存在');
  }

  const username = req.body.username !== undefined
    ? normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 })
    : existing.username;

  const name = req.body.name !== undefined
    ? normalizeString(req.body.name, '姓名', { maxLength: 80 })
    : existing.name;

  let passwordHash = existing.password_hash;
  if (req.body.password !== undefined && String(req.body.password).trim() !== '') {
    passwordHash = createPasswordHash(String(req.body.password).trim());
  }

  await dbRun(
    'UPDATE students SET username = ?, name = ?, password_hash = ? WHERE id = ?',
    [username, name, passwordHash, id],
  );

  const student = await dbGet(
    'SELECT id, username, name, wechat_openid, created_at FROM students WHERE id = ?',
    [id],
  );

  res.json(student);
}));

app.delete('/api/students/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '学生 ID 不合法');
  }

  const result = await dbRun('DELETE FROM students WHERE id = ?', [id]);
  if (result.changes === 0) {
    throw new AppError(404, '学生不存在');
  }

  res.json({ ok: true });
}));

app.get('/api/trees', requireTeacher, asyncHandler(async (_req, res) => {
  const trees = await dbAll(`
    SELECT
      t.id,
      t.title,
      t.chapter_desc,
      t.created_at,
      root.id AS root_id,
      root.name AS root_name,
      (
        SELECT COUNT(*)
        FROM knowledge_nodes n
        WHERE n.tree_id = t.id AND n.parent_id IS NOT NULL
      ) AS knowledge_count
    FROM learning_trees t
    LEFT JOIN knowledge_nodes root
      ON root.tree_id = t.id
      AND root.parent_id IS NULL
    ORDER BY t.id DESC
  `);
  res.json(trees);
}));

app.post('/api/trees', requireTeacher, asyncHandler(async (req, res) => {
  const title = normalizeString(req.body.title, '章节标题', { required: true, maxLength: 120 });
  const chapterDesc = normalizeString(req.body.chapterDesc, '章节描述', { maxLength: 500 });
  const rootName = normalizeString(req.body.rootName, '根节点名称', { required: true, maxLength: 120 });

  const treeResult = await dbRun(
    'INSERT INTO learning_trees (title, chapter_desc) VALUES (?, ?)',
    [title, chapterDesc],
  );

  await dbRun(
    'INSERT INTO knowledge_nodes (tree_id, parent_id, name, sort_order) VALUES (?, NULL, ?, 0)',
    [treeResult.lastID, rootName],
  );

  const tree = await dbGet(
    'SELECT id, title, chapter_desc, created_at FROM learning_trees WHERE id = ?',
    [treeResult.lastID],
  );

  res.status(201).json(tree);
}));

app.put('/api/trees/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '树 ID 不合法');
  }

  const existing = await dbGet('SELECT * FROM learning_trees WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError(404, '学习树不存在');
  }

  const title = req.body.title !== undefined
    ? normalizeString(req.body.title, '章节标题', { required: true, maxLength: 120 })
    : existing.title;

  const chapterDesc = req.body.chapterDesc !== undefined
    ? normalizeString(req.body.chapterDesc, '章节描述', { maxLength: 500 })
    : existing.chapter_desc;

  await dbRun('UPDATE learning_trees SET title = ?, chapter_desc = ? WHERE id = ?', [title, chapterDesc, id]);

  const tree = await dbGet('SELECT id, title, chapter_desc, created_at FROM learning_trees WHERE id = ?', [id]);
  res.json(tree);
}));

app.delete('/api/trees/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '树 ID 不合法');
  }

  const result = await dbRun('DELETE FROM learning_trees WHERE id = ?', [id]);
  if (result.changes === 0) {
    throw new AppError(404, '学习树不存在');
  }

  res.json({ ok: true });
}));

app.get('/api/trees/:treeId/nodes', requireTeacher, asyncHandler(async (req, res) => {
  const treeId = Number(req.params.treeId);
  if (!Number.isInteger(treeId) || treeId <= 0) {
    throw new AppError(400, '树 ID 不合法');
  }

  const tree = await dbGet('SELECT id FROM learning_trees WHERE id = ?', [treeId]);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const nodes = await dbAll(`
    SELECT id, tree_id, parent_id, name, sort_order, created_at
    FROM knowledge_nodes
    WHERE tree_id = ?
    ORDER BY parent_id IS NOT NULL, sort_order, id
  `, [treeId]);

  res.json(nodes);
}));

app.post('/api/trees/:treeId/nodes', requireTeacher, asyncHandler(async (req, res) => {
  const treeId = Number(req.params.treeId);
  if (!Number.isInteger(treeId) || treeId <= 0) {
    throw new AppError(400, '树 ID 不合法');
  }

  const name = normalizeString(req.body.name, '节点名称', { required: true, maxLength: 120 });
  const parentId = Number(req.body.parentId);
  const sortOrder = req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : 0;

  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw new AppError(400, '新增子节点必须选择父节点');
  }

  if (!Number.isInteger(sortOrder)) {
    throw new AppError(400, '排序必须是整数');
  }

  const parent = await dbGet('SELECT id, tree_id FROM knowledge_nodes WHERE id = ?', [parentId]);
  if (!parent || Number(parent.tree_id) !== treeId) {
    throw new AppError(400, '父节点不存在或不属于当前学习树');
  }

  const result = await dbRun(
    'INSERT INTO knowledge_nodes (tree_id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [treeId, parentId, name, sortOrder],
  );

  const node = await dbGet(
    'SELECT id, tree_id, parent_id, name, sort_order, created_at FROM knowledge_nodes WHERE id = ?',
    [result.lastID],
  );

  res.status(201).json(node);
}));

app.put('/api/nodes/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '节点 ID 不合法');
  }

  const existing = await dbGet('SELECT * FROM knowledge_nodes WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError(404, '节点不存在');
  }

  const name = req.body.name !== undefined
    ? normalizeString(req.body.name, '节点名称', { required: true, maxLength: 120 })
    : existing.name;

  const sortOrder = req.body.sortOrder !== undefined
    ? Number(req.body.sortOrder)
    : existing.sort_order;

  if (!Number.isInteger(sortOrder)) {
    throw new AppError(400, '排序必须是整数');
  }

  let parentId = existing.parent_id;
  if (req.body.parentId !== undefined) {
    if (req.body.parentId === null || req.body.parentId === '') {
      parentId = null;
    } else {
      parentId = Number(req.body.parentId);
      if (!Number.isInteger(parentId) || parentId <= 0) {
        throw new AppError(400, '父节点 ID 不合法');
      }
    }
  }

  if (existing.parent_id === null && parentId !== null) {
    throw new AppError(400, '根节点不能设置父节点');
  }

  if (existing.parent_id !== null && parentId === null) {
    throw new AppError(400, '普通节点不能升级为根节点');
  }

  if (parentId !== null) {
    if (parentId === Number(existing.id)) {
      throw new AppError(400, '父节点不能是自己');
    }

    const parent = await dbGet('SELECT id, tree_id FROM knowledge_nodes WHERE id = ?', [parentId]);
    if (!parent || Number(parent.tree_id) !== Number(existing.tree_id)) {
      throw new AppError(400, '父节点不存在或不在同一棵树中');
    }

    const isDescendant = await dbGet(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM knowledge_nodes WHERE parent_id = ?
        UNION ALL
        SELECT n.id
        FROM knowledge_nodes n
        JOIN descendants d ON n.parent_id = d.id
      )
      SELECT id FROM descendants WHERE id = ? LIMIT 1
    `, [existing.id, parentId]);

    if (isDescendant) {
      throw new AppError(400, '不能把父节点设置为自己的后代节点');
    }
  }

  await dbRun(
    'UPDATE knowledge_nodes SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?',
    [name, parentId, sortOrder, id],
  );

  const node = await dbGet(
    'SELECT id, tree_id, parent_id, name, sort_order, created_at FROM knowledge_nodes WHERE id = ?',
    [id],
  );

  res.json(node);
}));

app.delete('/api/nodes/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '节点 ID 不合法');
  }

  const node = await dbGet('SELECT id, parent_id FROM knowledge_nodes WHERE id = ?', [id]);
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不能单独删除，请删除整棵学习树');
  }

  await dbRun('DELETE FROM knowledge_nodes WHERE id = ?', [id]);
  res.json({ ok: true });
}));

app.get('/api/scores', requireTeacher, asyncHandler(async (req, res) => {
  const studentId = Number(req.query.studentId);
  const treeId = Number(req.query.treeId);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new AppError(400, 'studentId 必填且必须是正整数');
  }
  if (!Number.isInteger(treeId) || treeId <= 0) {
    throw new AppError(400, 'treeId 必填且必须是正整数');
  }

  const student = await dbGet('SELECT id FROM students WHERE id = ?', [studentId]);
  if (!student) {
    throw new AppError(404, '学生不存在');
  }

  const tree = await dbGet('SELECT id FROM learning_trees WHERE id = ?', [treeId]);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const rows = await dbAll(`
    SELECT
      n.id AS node_id,
      n.parent_id,
      n.name,
      n.sort_order,
      s.score,
      s.comment,
      s.updated_at AS score_updated_at,
      latest.code_text,
      latest.code_image_url,
      latest.submitted_at AS latest_submitted_at,
      latest.id AS latest_submission_id,
      (
        SELECT COUNT(*)
        FROM student_node_submissions sub
        WHERE sub.student_id = ?
          AND sub.node_id = n.id
      ) AS submission_count
    FROM knowledge_nodes n
    LEFT JOIN student_scores s
      ON s.node_id = n.id
      AND s.student_id = ?
    LEFT JOIN student_node_submissions latest
      ON latest.id = (
        SELECT sub.id
        FROM student_node_submissions sub
        WHERE sub.student_id = ?
          AND sub.node_id = n.id
        ORDER BY sub.submitted_at DESC, sub.id DESC
        LIMIT 1
      )
    WHERE n.tree_id = ?
    ORDER BY n.parent_id IS NOT NULL, n.sort_order, n.id
  `, [studentId, studentId, studentId, treeId]);

  res.json(rows);
}));

app.get('/api/submissions', requireTeacher, asyncHandler(async (req, res) => {
  const studentId = Number(req.query.studentId);
  const treeId = Number(req.query.treeId);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new AppError(400, 'studentId 必填且必须是正整数');
  }
  if (!Number.isInteger(treeId) || treeId <= 0) {
    throw new AppError(400, 'treeId 必填且必须是正整数');
  }

  const student = await dbGet('SELECT id FROM students WHERE id = ?', [studentId]);
  if (!student) {
    throw new AppError(404, '学生不存在');
  }

  const tree = await dbGet('SELECT id FROM learning_trees WHERE id = ?', [treeId]);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const rows = await dbAll(`
    SELECT
      sub.id,
      sub.student_id,
      sub.node_id,
      sub.code_text,
      sub.code_image_url,
      sub.submitted_at,
      sub.teacher_score,
      sub.teacher_comment,
      sub.scored_at,
      n.name AS node_name,
      n.parent_id,
      n.sort_order
    FROM student_node_submissions sub
    JOIN knowledge_nodes n
      ON n.id = sub.node_id
    WHERE sub.student_id = ?
      AND n.tree_id = ?
    ORDER BY sub.submitted_at DESC, sub.id DESC
  `, [studentId, treeId]);

  res.json(rows);
}));

app.put('/api/submissions/:id/score', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '提交记录 ID 不合法');
  }

  const score = normalizeTeacherScore(req.body.score);
  const comment = normalizeString(req.body.comment, '评语', { maxLength: 300 });

  const existing = await dbGet(
    `
      SELECT id
      FROM student_node_submissions
      WHERE id = ?
    `,
    [id],
  );
  if (!existing) {
    throw new AppError(404, '提交记录不存在');
  }

  await dbRun(
    `
      UPDATE student_node_submissions
      SET
        teacher_score = ?,
        teacher_comment = ?,
        scored_at = CASE
          WHEN ? IS NULL AND ? IS NULL THEN NULL
          ELSE CURRENT_TIMESTAMP
        END
      WHERE id = ?
    `,
    [score, comment, score, comment, id],
  );

  const row = await dbGet(
    `
      SELECT
        id,
        student_id,
        node_id,
        code_text,
        code_image_url,
        submitted_at,
        teacher_score,
        teacher_comment,
        scored_at
      FROM student_node_submissions
      WHERE id = ?
    `,
    [id],
  );

  res.json(row);
}));

app.put('/api/scores', requireTeacher, asyncHandler(async (req, res) => {
  const studentId = Number(req.body.studentId);
  const nodeId = Number(req.body.nodeId);
  const score = normalizeScore(req.body.score);
  const comment = normalizeString(req.body.comment, '评语', { maxLength: 300 });

  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new AppError(400, 'studentId 必填且必须是正整数');
  }
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  const student = await dbGet('SELECT id FROM students WHERE id = ?', [studentId]);
  if (!student) {
    throw new AppError(404, '学生不存在');
  }

  const node = await dbGet('SELECT id, parent_id FROM knowledge_nodes WHERE id = ?', [nodeId]);
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不参与评分');
  }

  await dbRun(
    `
      INSERT INTO student_scores (student_id, node_id, score, comment, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(student_id, node_id)
      DO UPDATE SET
        score = excluded.score,
        comment = excluded.comment,
        updated_at = CURRENT_TIMESTAMP
    `,
    [studentId, nodeId, score, comment],
  );

  const row = await dbGet(
    'SELECT id, student_id, node_id, score, comment, updated_at FROM student_scores WHERE student_id = ? AND node_id = ?',
    [studentId, nodeId],
  );

  res.json(row);
}));

app.delete('/api/scores', requireTeacher, asyncHandler(async (req, res) => {
  const studentId = Number(req.query.studentId);
  const nodeId = Number(req.query.nodeId);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new AppError(400, 'studentId 必填且必须是正整数');
  }
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  await dbRun('DELETE FROM student_scores WHERE student_id = ? AND node_id = ?', [studentId, nodeId]);
  res.json({ ok: true });
}));

app.post('/api/student/login', asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });

  const student = await dbGet('SELECT id, username, name, password_hash FROM students WHERE username = ?', [username]);
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({
    token,
    student: {
      id: student.id,
      username: student.username,
      name: student.name,
    },
  });
}));

app.post('/api/student/logout', requireStudent, asyncHandler(async (req, res) => {
  res.clearCookie('student_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
  });
  res.json({ ok: true });
}));

app.get('/api/student/me', requireStudent, asyncHandler(async (req, res) => {
  const student = await dbGet(
    'SELECT id, username, name, wechat_openid, created_at FROM students WHERE id = ?',
    [req.studentId],
  );
  if (!student) {
    throw new AppError(401, '学生会话已失效');
  }
  res.json(student);
}));

app.post('/api/student/node-submissions', requireStudent, asyncHandler(async (req, res) => {
  const nodeId = Number(req.body.nodeId);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  const node = await dbGet('SELECT id, parent_id FROM knowledge_nodes WHERE id = ?', [nodeId]);
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不支持提交代码');
  }

  const codeText = normalizeCodeText(req.body.codeText);
  const hasImageBase64 = Object.prototype.hasOwnProperty.call(req.body, 'imageBase64');
  let codeImageUrl = null;

  if (hasImageBase64 && req.body.imageBase64) {
    codeImageUrl = await saveCodeImage(req.body.imageBase64, req.body.imageMimeType);
  }

  if ((!codeText || codeText.trim() === '') && !codeImageUrl) {
    throw new AppError(400, '请至少提交代码文本或代码图片');
  }

  const result = await dbRun(
    `
      INSERT INTO student_node_submissions (student_id, node_id, code_text, code_image_url, submitted_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
    [req.studentId, nodeId, codeText || null, codeImageUrl],
  );

  const row = await dbGet(
    `
      SELECT
        id,
        student_id,
        node_id,
        code_text,
        code_image_url,
        submitted_at,
        teacher_score,
        teacher_comment,
        scored_at
      FROM student_node_submissions
      WHERE id = ?
    `,
    [result.lastID],
  );

  res.status(201).json(row);
}));

app.put('/api/student/node-work', requireStudent, asyncHandler(async (req, res) => {
  const nodeId = Number(req.body.nodeId);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  const node = await dbGet('SELECT id, parent_id FROM knowledge_nodes WHERE id = ?', [nodeId]);
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不支持提交代码');
  }

  const hasCodeText = Object.prototype.hasOwnProperty.call(req.body, 'codeText');
  const hasImageBase64 = Object.prototype.hasOwnProperty.call(req.body, 'imageBase64');
  const removeImage = req.body.removeImage === true
    || req.body.removeImage === 'true'
    || req.body.removeImage === 1
    || req.body.removeImage === '1';

  if (!hasCodeText && !hasImageBase64 && !removeImage) {
    throw new AppError(400, '至少提交代码文本或图片');
  }

  const existing = await dbGet(
    'SELECT code_text, code_image_url FROM student_node_works WHERE student_id = ? AND node_id = ?',
    [req.studentId, nodeId],
  );

  let nextCodeText = existing ? existing.code_text : null;
  if (hasCodeText) {
    nextCodeText = normalizeCodeText(req.body.codeText);
  }

  let nextImageUrl = existing ? existing.code_image_url : null;
  if (hasImageBase64) {
    const uploadedImageUrl = await saveCodeImage(req.body.imageBase64, req.body.imageMimeType);
    if (nextImageUrl) {
      await removeCodeImage(nextImageUrl);
    }
    nextImageUrl = uploadedImageUrl;
  } else if (removeImage) {
    if (nextImageUrl) {
      await removeCodeImage(nextImageUrl);
    }
    nextImageUrl = null;
  }

  if (nextCodeText === null && nextImageUrl === null) {
    await dbRun(
      'DELETE FROM student_node_works WHERE student_id = ? AND node_id = ?',
      [req.studentId, nodeId],
    );
    res.json({
      student_id: req.studentId,
      node_id: nodeId,
      code_text: null,
      code_image_url: null,
      updated_at: null,
    });
    return;
  }

  await dbRun(
    `
      INSERT INTO student_node_works (student_id, node_id, code_text, code_image_url, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(student_id, node_id)
      DO UPDATE SET
        code_text = excluded.code_text,
        code_image_url = excluded.code_image_url,
        updated_at = CURRENT_TIMESTAMP
    `,
    [req.studentId, nodeId, nextCodeText, nextImageUrl],
  );

  const row = await dbGet(
    `
      SELECT student_id, node_id, code_text, code_image_url, updated_at
      FROM student_node_works
      WHERE student_id = ? AND node_id = ?
    `,
    [req.studentId, nodeId],
  );

  res.json(row);
}));

app.delete('/api/student/node-work', requireStudent, asyncHandler(async (req, res) => {
  const nodeId = Number(req.query.nodeId);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  const existing = await dbGet(
    'SELECT code_image_url FROM student_node_works WHERE student_id = ? AND node_id = ?',
    [req.studentId, nodeId],
  );
  if (existing && existing.code_image_url) {
    await removeCodeImage(existing.code_image_url);
  }

  await dbRun(
    'DELETE FROM student_node_works WHERE student_id = ? AND node_id = ?',
    [req.studentId, nodeId],
  );

  res.json({ ok: true });
}));

app.post('/api/student/wechat-bind', asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });
  const code = normalizeString(req.body.code, '微信 code', { required: true, maxLength: 200 });

  const openid = await fetchWeChatOpenId(code);

  const student = await dbGet('SELECT id, username, name, password_hash, wechat_openid FROM students WHERE username = ?', [username]);
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  const duplicated = await dbGet('SELECT id FROM students WHERE wechat_openid = ? AND id != ?', [openid, student.id]);
  if (duplicated) {
    throw new AppError(409, '该微信账号已绑定其他学生');
  }

  await dbRun('UPDATE students SET wechat_openid = ? WHERE id = ?', [openid, student.id]);

  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({
    token,
    student: {
      id: student.id,
      username: student.username,
      name: student.name,
      wechat_openid: openid,
    },
  });
}));

app.post('/api/student/wechat-login', asyncHandler(async (req, res) => {
  const code = normalizeString(req.body.code, '微信 code', { required: true, maxLength: 200 });
  const openid = await fetchWeChatOpenId(code);

  const student = await dbGet(
    'SELECT id, username, name FROM students WHERE wechat_openid = ?',
    [openid],
  );

  if (!student) {
    throw new AppError(404, '该微信号尚未绑定学生账号，请先绑定');
  }

  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({ token, student });
}));

app.get('/api/student/trees', requireStudent, asyncHandler(async (req, res) => {
  const trees = await dbAll(
    'SELECT id, title, chapter_desc, created_at FROM learning_trees ORDER BY id ASC',
  );

  const rows = await dbAll(`
    SELECT
      n.id,
      n.tree_id,
      n.parent_id,
      n.name,
      n.sort_order,
      s.score,
      s.comment,
      latest.code_text,
      latest.code_image_url,
      latest.teacher_score AS latest_teacher_score,
      latest.teacher_comment AS latest_teacher_comment,
      latest.submitted_at AS latest_submitted_at,
      (
        SELECT COUNT(*)
        FROM student_node_submissions sub
        WHERE sub.student_id = ?
          AND sub.node_id = n.id
      ) AS submission_count
    FROM knowledge_nodes n
    LEFT JOIN student_scores s
      ON s.node_id = n.id
      AND s.student_id = ?
    LEFT JOIN student_node_submissions latest
      ON latest.id = (
        SELECT sub.id
        FROM student_node_submissions sub
        WHERE sub.student_id = ?
          AND sub.node_id = n.id
        ORDER BY sub.submitted_at DESC, sub.id DESC
        LIMIT 1
      )
    ORDER BY n.tree_id, n.parent_id IS NOT NULL, n.sort_order, n.id
  `, [req.studentId, req.studentId, req.studentId]);

  const submissionRows = await dbAll(`
    SELECT
      sub.id,
      sub.node_id,
      sub.code_text,
      sub.code_image_url,
      sub.submitted_at,
      sub.teacher_score,
      sub.teacher_comment,
      sub.scored_at
    FROM student_node_submissions sub
    JOIN knowledge_nodes n
      ON n.id = sub.node_id
    WHERE sub.student_id = ?
    ORDER BY sub.submitted_at DESC, sub.id DESC
  `, [req.studentId]);

  const historyByNode = new Map();
  submissionRows.forEach((item) => {
    if (!historyByNode.has(item.node_id)) {
      historyByNode.set(item.node_id, []);
    }
    historyByNode.get(item.node_id).push(item);
  });

  rows.forEach((row) => {
    const history = historyByNode.get(row.id) || [];
    row.submission_history = history;
    row.submission_count = history.length;

    const scored = history
      .map((item) => Number(item.teacher_score))
      .filter((score) => !Number.isNaN(score));

    if (scored.length > 0) {
      row.highest_teacher_score = Math.max(...scored);
      row.avg_teacher_score = scored.reduce((sum, score) => sum + score, 0) / scored.length;
    } else {
      row.highest_teacher_score = null;
      row.avg_teacher_score = null;
    }
  });

  const grouped = new Map();
  rows.forEach((row) => {
    if (!grouped.has(row.tree_id)) {
      grouped.set(row.tree_id, []);
    }
    grouped.get(row.tree_id).push(row);
  });

  const result = trees.map((tree) => ({
    id: tree.id,
    title: tree.title,
    chapterDesc: tree.chapter_desc,
    createdAt: tree.created_at,
    root: buildTree(grouped.get(tree.id) || []),
  }));

  res.json(result);
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.redirect('/teacher.html');
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;

  if (err.code === 'SQLITE_CONSTRAINT' || err.code === '23505' || err.code === '23503') {
    return res.status(409).json({ message: '数据冲突，可能是重复用户名或重复绑定。' });
  }

  if (status >= 500) {
    console.error(err);
  }

  return res.status(status).json({ message: err.message || '服务器异常' });
});

if (require.main === module) {
  ensureInitialized()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server started at http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('数据库初始化失败:', err);
      process.exit(1);
    });
}

module.exports = app;
