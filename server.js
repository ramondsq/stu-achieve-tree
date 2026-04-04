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
const SPECIAL_TREE_KEYS = {
  knowledge: 'cpp_algorithm_tree',
  reward: 'weekly_bounty_tree',
};
const MAX_UNLOCK_PREREQUISITES = 8;
const SPECIAL_TREE_SPECS = [
  {
    systemKey: SPECIAL_TREE_KEYS.knowledge,
    treeType: 'knowledge',
    title: 'C++知识点树',
    chapterDesc: '系统知识资格树',
    root: {
      systemKey: 'cpp_algorithm_root',
      name: 'C++知识点树',
    },
    children: [],
  },
  {
    systemKey: SPECIAL_TREE_KEYS.reward,
    treeType: 'reward',
    title: '每周悬赏树',
    chapterDesc: '系统悬赏作业树',
    root: {
      systemKey: 'weekly_bounty_root',
      name: '每周悬赏树',
    },
    children: [],
  },
];
const KNOWLEDGE_LEVEL_THRESHOLD = 0.8;
const REWARD_TREE_POINT_THRESHOLD = 0.8;
const REWARD_TREE_POINT_REWARD = 1;
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

function normalizeNonNegativeInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new AppError(400, `${fieldName} 必须是大于等于 0 的整数`);
  }
  return num;
}

function normalizeUnlockThresholdPercent(value, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 100) {
    throw new AppError(400, `${fieldName} 必须是 0 到 100 之间的数字`);
  }
  return Number.isInteger(num) ? num : Number(num.toFixed(1));
}

function normalizeUnlockPrerequisites(value, fieldName = '前置条件') {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_err) {
      throw new AppError(400, `${fieldName} 格式不正确`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(400, `${fieldName} 必须是数组`);
  }
  if (parsed.length > MAX_UNLOCK_PREREQUISITES) {
    throw new AppError(400, `${fieldName} 最多只能设置 ${MAX_UNLOCK_PREREQUISITES} 条`);
  }

  const normalized = [];
  const indexBySource = new Map();
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new AppError(400, `${fieldName} #${index + 1} 格式不正确`);
    }

    const sourceNodeId = Number(item.sourceNodeId ?? item.source_node_id);
    if (!Number.isInteger(sourceNodeId) || sourceNodeId <= 0) {
      throw new AppError(400, `${fieldName} #${index + 1} 的前置节点 ID 不合法`);
    }

    const thresholdPercent = normalizeUnlockThresholdPercent(
      item.thresholdPercent ?? item.threshold_percent ?? item.threshold,
      `${fieldName} #${index + 1} 的完成度`,
    );
    const nextItem = {
      source_node_id: sourceNodeId,
      threshold_percent: thresholdPercent,
    };

    if (indexBySource.has(sourceNodeId)) {
      normalized[indexBySource.get(sourceNodeId)] = nextItem;
    } else {
      indexBySource.set(sourceNodeId, normalized.length);
      normalized.push(nextItem);
    }
  });

  return normalized;
}

function normalizeUnlockPrerequisiteMode(value, fieldName = '前置条件模式') {
  const normalized = String(value || 'all').trim().toLowerCase();
  if (normalized !== 'all' && normalized !== 'any') {
    throw new AppError(400, `${fieldName} 只支持 all 或 any`);
  }
  return normalized;
}

function getNodeUnlockPrerequisites(node) {
  const raw = node && (node.unlock_prerequisites ?? node.unlockPrerequisites);
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_err) {
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const normalized = [];
  const indexBySource = new Map();
  parsed.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    const sourceNodeId = Number(item.sourceNodeId ?? item.source_node_id);
    const thresholdPercent = Number(item.thresholdPercent ?? item.threshold_percent ?? item.threshold);
    if (!Number.isInteger(sourceNodeId) || sourceNodeId <= 0) {
      return;
    }
    if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
      return;
    }

    const nextItem = {
      source_node_id: sourceNodeId,
      threshold_percent: Number.isInteger(thresholdPercent)
        ? thresholdPercent
        : Number(thresholdPercent.toFixed(1)),
    };

    if (indexBySource.has(sourceNodeId)) {
      normalized[indexBySource.get(sourceNodeId)] = nextItem;
    } else {
      indexBySource.set(sourceNodeId, normalized.length);
      normalized.push(nextItem);
    }
  });

  return normalized;
}

function getNodeUnlockPrerequisiteMode(node) {
  const value = String(node && (node.unlock_prerequisite_mode ?? node.unlockPrerequisiteMode) || '')
    .trim()
    .toLowerCase();
  return value === 'any' ? 'any' : 'all';
}

function serializeUnlockPrerequisites(rules = []) {
  return JSON.stringify(getNodeUnlockPrerequisites({ unlock_prerequisites: rules }));
}

function formatUnlockThresholdPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0%';
  }
  return Number.isInteger(num)
    ? `${num}%`
    : `${num.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatPrerequisiteLockedText(unmetRules = [], mode = 'all') {
  if (!unmetRules.length) {
    return '';
  }

  const parts = unmetRules.map((item) => `${item.sourceNode ? item.sourceNode.name : '前置节点'} ${formatUnlockThresholdPercent(item.thresholdPercent)}`);
  if (mode === 'any') {
    return `需满足以下任一条件：${parts.join(' 或 ')}`;
  }
  return `需同时完成 ${parts.join('、')}`;
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

function getTeacherToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies.teacher_token;
}

function requireTeacher(req, res, next) {
  const token = getTeacherToken(req);
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

function toPositiveInt(value) {
  const num = Math.floor(Number(value) || 0);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return num;
}

function getStudentLevel(item) {
  return toPositiveInt(item && item.level);
}

function getStudentTotalPoints(item) {
  return Math.max(0, Number(item && item.total_points) || 0);
}

function chineseLevelToNumber(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    return toPositiveInt(value);
  }

  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[value] || 0;
}

function inferLevelFromNodeName(name) {
  const match = String(name || '').match(/([一二三四五六七八九十\d]+)级/);
  if (!match) {
    return 0;
  }
  return chineseLevelToNumber(match[1]);
}

function sortNodes(nodes = []) {
  return [...nodes].sort((left, right) => {
    const leftRoot = left.parent_id === null ? 0 : 1;
    const rightRoot = right.parent_id === null ? 0 : 1;
    return leftRoot - rightRoot
      || Number(left.sort_order || 0) - Number(right.sort_order || 0)
      || Number(left.id || 0) - Number(right.id || 0);
  });
}

function sortSubmissionsDesc(items = []) {
  return [...items].sort((left, right) => {
    return String(right.submitted_at || '').localeCompare(String(left.submitted_at || ''))
      || Number(right.id || 0) - Number(left.id || 0);
  });
}

function getNumericScore(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const score = Number(value);
  return Number.isNaN(score) ? null : score;
}

function hasSubmissionReview(item) {
  if (!item) {
    return false;
  }

  return !!(
    item.scored_at
    || (item.teacher_comment && String(item.teacher_comment).trim())
    || getNumericScore(item.teacher_score) !== null
  );
}

function summarizeSubmissionHistory(items = []) {
  const history = sortSubmissionsDesc(items);
  const reviewed = history.filter(hasSubmissionReview);
  const scoredValues = reviewed
    .map((item) => getNumericScore(item.teacher_score))
    .filter((score) => score !== null);

  let bestReviewedSubmission = null;
  history.forEach((item) => {
    const score = getNumericScore(item.teacher_score);
    if (score === null) {
      return;
    }

    if (!bestReviewedSubmission || score > getNumericScore(bestReviewedSubmission.teacher_score)) {
      bestReviewedSubmission = item;
    }
  });

  return {
    history,
    reviewed,
    latestSubmission: history[0] || null,
    latestReviewedSubmission: reviewed[0] || null,
    bestReviewedSubmission,
    highestTeacherScore: scoredValues.length ? Math.max(...scoredValues) : null,
    averageTeacherScore: scoredValues.length
      ? scoredValues.reduce((sum, score) => sum + score, 0) / scoredValues.length
      : null,
    submissionCount: history.length,
  };
}

function isSystemManagedNode(item) {
  return !!(item && item.system_key && String(item.system_key).trim());
}

function groupNodesByTree(nodes = []) {
  const result = new Map();
  nodes.forEach((node) => {
    if (!result.has(node.tree_id)) {
      result.set(node.tree_id, []);
    }
    result.get(node.tree_id).push(node);
  });
  return result;
}

function buildNodePathById(nodes = []) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const cache = new Map();

  function resolvePath(nodeId) {
    if (!nodeId) {
      return '';
    }
    if (cache.has(nodeId)) {
      return cache.get(nodeId);
    }

    const node = nodeById.get(nodeId);
    if (!node) {
      return '';
    }

    const parentPath = node.parent_id ? resolvePath(node.parent_id) : '';
    const path = parentPath ? `${parentPath} / ${node.name}` : node.name;
    cache.set(nodeId, path);
    return path;
  }

  const result = new Map();
  nodes.forEach((node) => {
    result.set(node.id, resolvePath(node.id));
  });
  return result;
}

function buildSystemTreeRules(treeType) {
  if (treeType === 'knowledge') {
    return [
      {
        label: '升级阈值',
        value: `系统知识节点完成度达到 ${Math.round(KNOWLEDGE_LEVEL_THRESHOLD * 100)}% 后，学生升级到该节点配置的等级`,
      },
      {
        label: '升级依据',
        value: '仅统计带 milestoneLevel 的系统节点；节点当前分来自该节点下已解锁叶子任务的最高分汇总',
      },
      {
        label: '维护方式',
        value: '老师可在后台直接编辑系统树标题、系统节点名称、父子关系、排序和升级等级；删除仍受后端保护',
      },
    ];
  }

  if (treeType === 'reward') {
    return [
      {
        label: '解锁规则',
        value: '叶子任务点按 requiredLevel 与学生等级逐级解锁，未达到等级前不可提交',
      },
      {
        label: '积分阈值',
        value: `整棵每周悬赏树完成度达到 ${Math.round(REWARD_TREE_POINT_THRESHOLD * 100)}% 后触发积分奖励`,
      },
      {
        label: '积分发放',
        value: `每名学生对这棵树只领取一次奖励，每次 +${REWARD_TREE_POINT_REWARD} 积分`,
      },
      {
        label: '维护方式',
        value: '老师可在后台直接编辑系统树标题、系统节点名称、父子关系、排序和解锁等级；删除仍受后端保护',
      },
    ];
  }

  return [];
}

function buildSubmissionDetailByNodeId(nodes = [], submissions = []) {
  const historyByNodeId = new Map();
  sortSubmissionsDesc(submissions).forEach((item) => {
    if (!historyByNodeId.has(item.node_id)) {
      historyByNodeId.set(item.node_id, []);
    }
    historyByNodeId.get(item.node_id).push(item);
  });

  const detailByNodeId = new Map();
  nodes.forEach((node) => {
    const summary = summarizeSubmissionHistory(historyByNodeId.get(node.id) || []);
    const latestSubmission = summary.latestSubmission;
    const latestReviewedSubmission = summary.latestReviewedSubmission;

    detailByNodeId.set(node.id, {
      score: summary.highestTeacherScore,
      comment: summary.bestReviewedSubmission ? (summary.bestReviewedSubmission.teacher_comment || '') : '',
      codeText: latestSubmission ? latestSubmission.code_text || '' : '',
      codeImageUrl: latestSubmission ? latestSubmission.code_image_url || '' : '',
      latestTeacherScore: latestReviewedSubmission ? getNumericScore(latestReviewedSubmission.teacher_score) : null,
      latestTeacherComment: latestReviewedSubmission ? (latestReviewedSubmission.teacher_comment || '') : '',
      latestSubmittedAt: latestSubmission ? latestSubmission.submitted_at : '',
      latestReviewedAt: latestReviewedSubmission ? (latestReviewedSubmission.scored_at || '') : '',
      submissionCount: summary.submissionCount,
      submissionHistory: summary.history,
      highestTeacherScore: summary.highestTeacherScore,
      averageTeacherScore: summary.averageTeacherScore,
    });
  });

  return detailByNodeId;
}

function getProgressRatio(node) {
  if (!node || Number(node.totalScore || 0) <= 0) {
    return 0;
  }
  return Number(node.currentScore || 0) / Number(node.totalScore || 0);
}

function getRequiredLevelForNode(node) {
  if (!node || typeof node !== 'object') {
    return 0;
  }

  const explicitRequiredLevel = node.required_level ?? node.requiredLevel;
  if (explicitRequiredLevel !== undefined && explicitRequiredLevel !== null && explicitRequiredLevel !== '') {
    const value = Number(explicitRequiredLevel);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  return inferLevelFromNodeName(node.name);
}

function getNodeAncestorIdSet(nodeId, nodeById = new Map()) {
  const result = new Set();
  let current = nodeById.get(String(nodeId)) || null;

  while (current && current.parent_id !== null && current.parent_id !== undefined) {
    const parentKey = String(current.parent_id);
    if (result.has(parentKey)) {
      break;
    }
    result.add(parentKey);
    current = nodeById.get(parentKey) || null;
  }

  return result;
}

function getNodeDescendantIdSet(nodeId, nodes = []) {
  const result = new Set();
  const childrenByParent = new Map();

  nodes.forEach((node) => {
    const key = node.parent_id === null || node.parent_id === undefined
      ? '__root__'
      : String(node.parent_id);
    if (!childrenByParent.has(key)) {
      childrenByParent.set(key, []);
    }
    childrenByParent.get(key).push(node);
  });

  const queue = [String(nodeId)];
  while (queue.length) {
    const current = queue.shift();
    const children = childrenByParent.get(current) || [];
    children.forEach((child) => {
      const childKey = String(child.id);
      if (result.has(childKey)) {
        return;
      }
      result.add(childKey);
      queue.push(childKey);
    });
  }

  return result;
}

function buildPrerequisiteSourcesByTarget(nodes = []) {
  const sourcesByTarget = new Map();
  nodes.forEach((node) => {
    sourcesByTarget.set(
      String(node.id),
      getNodeUnlockPrerequisites(node).map((rule) => String(rule.source_node_id)),
    );
  });
  return sourcesByTarget;
}

function hasPrerequisitePath(startNodeId, targetNodeId, sourcesByTarget = new Map(), visited = new Set()) {
  const startKey = String(startNodeId);
  const targetKey = String(targetNodeId);
  if (startKey === targetKey) {
    return true;
  }
  if (visited.has(startKey)) {
    return false;
  }
  visited.add(startKey);

  const sourceIds = sourcesByTarget.get(startKey) || [];
  return sourceIds.some((sourceId) => hasPrerequisitePath(sourceId, targetKey, sourcesByTarget, visited));
}

function validateNodeUnlockPrerequisites({ nodeId = null, treeId, parentId = null, rules = [], allNodes = [] }) {
  const targetKey = nodeId === null || nodeId === undefined ? '__pending__' : String(nodeId);
  const preparedNodes = allNodes
    .filter((item) => String(item.id) !== targetKey)
    .map((item) => ({
      ...item,
      unlock_prerequisites: getNodeUnlockPrerequisites(item),
    }));

  preparedNodes.push({
    id: targetKey,
    tree_id: treeId,
    parent_id: parentId,
    unlock_prerequisites: rules,
  });

  const nodeById = new Map(preparedNodes.map((item) => [String(item.id), item]));
  const ancestorIds = getNodeAncestorIdSet(targetKey, nodeById);
  const descendantIds = getNodeDescendantIdSet(targetKey, preparedNodes);

  rules.forEach((rule) => {
    const sourceKey = String(rule.source_node_id);
    const sourceNode = nodeById.get(sourceKey) || null;
    if (!sourceNode || Number(sourceNode.tree_id) !== Number(treeId)) {
      throw new AppError(400, `前置节点 ${rule.source_node_id} 不存在或不属于当前学习树`);
    }
    if (sourceKey === targetKey) {
      throw new AppError(400, '前置节点不能是当前节点自己');
    }
    if (ancestorIds.has(sourceKey) || descendantIds.has(sourceKey)) {
      throw new AppError(400, '前置节点不能是当前节点的祖先或后代');
    }
  });

  const sourcesByTarget = buildPrerequisiteSourcesByTarget(preparedNodes);
  rules.forEach((rule) => {
    if (hasPrerequisitePath(rule.source_node_id, targetKey, sourcesByTarget)) {
      throw new AppError(400, '前置条件形成循环依赖，请调整后重试');
    }
  });
}

function buildRewardNodeStateByNodeId(nodes = [], studentLevel = 0) {
  const state = new Map();
  const childrenByParent = new Map();

  nodes.forEach((node) => {
    const key = node.parent_id === null ? '__root__' : String(node.parent_id);
    if (!childrenByParent.has(key)) {
      childrenByParent.set(key, []);
    }
    childrenByParent.get(key).push(node);
  });

  function walk(node, inheritedRequiredLevel = 0) {
    const requiredLevel = getRequiredLevelForNode(node) || inheritedRequiredLevel;
    if (requiredLevel > 0) {
      state.set(node.id, {
        requiredLevel,
        unlocked: studentLevel >= requiredLevel,
        lockedText: `达到 ${requiredLevel} 级后解锁`,
      });
    }
    (childrenByParent.get(String(node.id)) || []).forEach((child) => walk(child, requiredLevel));
  }

  (childrenByParent.get('__root__') || []).forEach((root) => walk(root, 0));
  return state;
}

function buildTree(nodes = [], detailByNodeId = new Map(), nodeStateByNodeId = new Map()) {
  const nodeMap = new Map();
  nodes.forEach((item) => {
    const detail = detailByNodeId.get(item.id) || {};
    const state = nodeStateByNodeId.get(item.id) || {};
    const fallbackRequiredLevel = Number(item.required_level || 0);
    const requiredLevel = Number(state.requiredLevel ?? fallbackRequiredLevel);
    const baseUnlocked = state.unlocked !== undefined ? !!state.unlocked : requiredLevel <= 0;
    const baseLockedText = state.lockedText || (requiredLevel > 0 ? `达到 ${requiredLevel} 级后解锁` : '');
    const unlockPrerequisiteMode = getNodeUnlockPrerequisiteMode(item);
    nodeMap.set(item.id, {
      id: item.id,
      tree_id: item.tree_id,
      parent_id: item.parent_id,
      system_key: item.system_key || '',
      milestoneLevel: Number(item.milestone_level || 0),
      requiredLevel,
      name: item.name,
      parentId: item.parent_id,
      sortOrder: Number(item.sort_order || 0),
      sort_order: Number(item.sort_order || 0),
      unlockPrerequisiteMode,
      unlockPrerequisites: getNodeUnlockPrerequisites(item),
      score: detail.score ?? getNumericScore(item.score),
      comment: detail.comment || item.comment || '',
      codeText: detail.codeText || item.code_text || '',
      codeImageUrl: detail.codeImageUrl || item.code_image_url || '',
      submissionCount: Number(detail.submissionCount ?? item.submission_count ?? 0),
      latestTeacherScore: detail.latestTeacherScore ?? getNumericScore(item.latest_teacher_score),
      latestTeacherComment: detail.latestTeacherComment || item.latest_teacher_comment || '',
      latestSubmittedAt: detail.latestSubmittedAt || item.latest_submitted_at || '',
      latestReviewedAt: detail.latestReviewedAt || '',
      highestTeacherScore: detail.highestTeacherScore ?? getNumericScore(item.highest_teacher_score),
      averageTeacherScore: detail.averageTeacherScore ?? getNumericScore(item.avg_teacher_score),
      submissionHistory: detail.submissionHistory || item.submission_history || [],
      currentScore: 0,
      totalScore: 0,
      taskCount: 0,
      scoredTaskCount: 0,
      isLeafTask: false,
      baseUnlocked,
      baseLockedText,
      prerequisitesUnlocked: true,
      prerequisiteLockedText: '',
      unlocked: true,
      lockedText: '',
      canSubmit: false,
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
    node.children.sort((left, right) => {
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0)
        || Number(left.id || 0) - Number(right.id || 0);
    });
    node.children.forEach(sortChildren);
  }

  function applyUnlockState(node, ancestorUnlocked = true, inheritedLockedText = '') {
    const unlocked = ancestorUnlocked && node.baseUnlocked && node.prerequisitesUnlocked;
    let lockedText = '';
    if (!unlocked) {
      lockedText = !ancestorUnlocked
        ? inheritedLockedText
        : (node.baseUnlocked ? node.prerequisiteLockedText : node.baseLockedText);
    }

    node.unlocked = unlocked;
    node.lockedText = lockedText || '';

    node.children.forEach((child) => applyUnlockState(child, unlocked, node.lockedText));
  }

  function finalizeProgress(node) {
    node.children.forEach(finalizeProgress);

    const isLeafTask = !!node.parent_id && node.children.length === 0;
    const highestTeacherScore = getNumericScore(node.highestTeacherScore);
    const unlocked = !isLeafTask || node.unlocked !== false;

    node.isLeafTask = isLeafTask;
    node.unlocked = unlocked;
    node.canSubmit = isLeafTask && unlocked;
    node.currentScore = isLeafTask
      ? (unlocked ? (highestTeacherScore === null ? 0 : highestTeacherScore) : 0)
      : node.children.reduce((sum, child) => sum + Number(child.currentScore || 0), 0);
    node.totalScore = isLeafTask
      ? (unlocked ? 10 : 0)
      : node.children.reduce((sum, child) => sum + Number(child.totalScore || 0), 0);
    node.taskCount = isLeafTask
      ? (unlocked ? 1 : 0)
      : node.children.reduce((sum, child) => sum + Number(child.taskCount || 0), 0);
    node.scoredTaskCount = isLeafTask
      ? (unlocked && highestTeacherScore !== null ? 1 : 0)
      : node.children.reduce((sum, child) => sum + Number(child.scoredTaskCount || 0), 0);
  }

  function recomputePrerequisiteState() {
    let changed = false;
    nodeMap.forEach((node) => {
      const evaluatedRules = node.unlockPrerequisites
        .map((rule) => {
          const sourceNode = nodeMap.get(rule.source_node_id) || null;
          const sourceRatio = getProgressRatio(sourceNode);
          const met = sourceRatio >= (Number(rule.threshold_percent || 0) / 100);
          return {
            met,
            sourceNode,
            thresholdPercent: Number(rule.threshold_percent || 0),
          };
        });
      const unmetRules = evaluatedRules.filter((item) => !item.met);
      const mode = node.unlockPrerequisiteMode === 'any' ? 'any' : 'all';
      const prerequisitesUnlocked = node.unlockPrerequisites.length === 0
        ? true
        : (mode === 'any'
          ? evaluatedRules.some((item) => item.met)
          : unmetRules.length === 0);
      const prerequisiteLockedText = prerequisitesUnlocked
        ? ''
        : formatPrerequisiteLockedText(unmetRules, mode);

      if (
        node.prerequisitesUnlocked !== prerequisitesUnlocked
        || node.prerequisiteLockedText !== prerequisiteLockedText
      ) {
        node.prerequisitesUnlocked = prerequisitesUnlocked;
        node.prerequisiteLockedText = prerequisiteLockedText;
        changed = true;
      }
    });
    return changed;
  }

  if (root) {
    sortChildren(root);
    const maxIterations = Math.max(nodeMap.size, 1) + 1;
    for (let index = 0; index < maxIterations; index += 1) {
      applyUnlockState(root);
      finalizeProgress(root);
      if (!recomputePrerequisiteState()) {
        break;
      }
    }
    applyUnlockState(root);
    finalizeProgress(root);
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

async function getTableColumns(tableName) {
  if (USE_POSTGRES) {
    const rows = await dbAll(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ?
    `, [tableName]);
    return rows.map((row) => row.column_name);
  }

  const rows = await dbAll(`PRAGMA table_info(${tableName})`);
  return rows.map((row) => row.name);
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await getTableColumns(tableName);
  if (columns.includes(columnName)) {
    return;
  }
  await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensureSpecialTrees() {
  const trees = await dbAll(`
    SELECT id, title, chapter_desc, system_key, tree_type
    FROM learning_trees
    ORDER BY id ASC
  `);
  const nodes = await dbAll(`
    SELECT id, tree_id, parent_id, name, sort_order, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
    FROM knowledge_nodes
    ORDER BY id ASC
  `);
  const activeSystemTreeKeys = new Set(SPECIAL_TREE_SPECS.map((item) => item.systemKey));
  const legacySystemTrees = trees.filter((item) => item.system_key && !activeSystemTreeKeys.has(item.system_key));

  for (const tree of legacySystemTrees) {
    await dbRun(
      `
        UPDATE learning_trees
        SET system_key = NULL, tree_type = NULL
        WHERE id = ?
      `,
      [tree.id],
    );
    tree.system_key = null;
    tree.tree_type = null;

    const treeNodes = nodes.filter((item) => Number(item.tree_id) === Number(tree.id));
    for (const node of treeNodes) {
      if (!node.system_key || !String(node.system_key).trim()) {
        continue;
      }
      await dbRun(
        `
          UPDATE knowledge_nodes
          SET system_key = NULL
          WHERE id = ?
        `,
        [node.id],
      );
      node.system_key = null;
    }
  }

  for (const spec of SPECIAL_TREE_SPECS) {
    let tree = trees.find((item) => item.system_key === spec.systemKey)
      || trees.find((item) => item.title === spec.title);

    if (!tree) {
      const treeResult = await dbRun(
        `
          INSERT INTO learning_trees (title, chapter_desc, system_key, tree_type)
          VALUES (?, ?, ?, ?)
        `,
        [spec.title, spec.chapterDesc || '', spec.systemKey, spec.treeType],
      );
      tree = await dbGet(
        `
          SELECT id, title, chapter_desc, system_key, tree_type
          FROM learning_trees
          WHERE id = ?
        `,
        [treeResult.lastID],
      );
      trees.push(tree);
    } else {
      const treePatch = {};
      if (tree.system_key !== spec.systemKey) {
        treePatch.system_key = spec.systemKey;
      }
      if (tree.tree_type !== spec.treeType) {
        treePatch.tree_type = spec.treeType;
      }
      if (Object.keys(treePatch).length) {
        await dbRun(
          `
            UPDATE learning_trees
            SET system_key = ?, tree_type = ?
            WHERE id = ?
          `,
          [
            treePatch.system_key !== undefined ? treePatch.system_key : tree.system_key,
            treePatch.tree_type !== undefined ? treePatch.tree_type : tree.tree_type,
            tree.id,
          ],
        );
        Object.assign(tree, treePatch);
      }
    }

    const treeNodes = nodes.filter((item) => Number(item.tree_id) === Number(tree.id));
    let root = treeNodes.find((item) => item.system_key === spec.root.systemKey)
      || treeNodes.find((item) => item.parent_id === null);

    if (!root) {
      const rootResult = await dbRun(
        `
          INSERT INTO knowledge_nodes (
            tree_id,
            parent_id,
            name,
            sort_order,
            system_key,
            milestone_level,
            required_level,
            unlock_prerequisites,
            unlock_prerequisite_mode
          )
          VALUES (?, NULL, ?, 0, ?, 0, 0, '[]', 'all')
        `,
        [tree.id, spec.root.name, spec.root.systemKey],
      );
      root = await dbGet(
        `
          SELECT id, tree_id, parent_id, name, sort_order, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
          FROM knowledge_nodes
          WHERE id = ?
        `,
        [rootResult.lastID],
      );
      nodes.push(root);
      treeNodes.push(root);
    } else {
      const rootPatch = {};
      if (root.tree_id !== tree.id) {
        rootPatch.tree_id = tree.id;
      }
      if (root.parent_id !== null) {
        rootPatch.parent_id = null;
      }
      if (root.system_key !== spec.root.systemKey) {
        rootPatch.system_key = spec.root.systemKey;
      }
      if (Object.keys(rootPatch).length) {
        await dbRun(
          `
            UPDATE knowledge_nodes
            SET tree_id = ?, parent_id = ?, system_key = ?
            WHERE id = ?
          `,
          [
            rootPatch.tree_id !== undefined ? rootPatch.tree_id : root.tree_id,
            rootPatch.parent_id !== undefined ? rootPatch.parent_id : root.parent_id,
            rootPatch.system_key !== undefined ? rootPatch.system_key : root.system_key,
            root.id,
          ],
        );
        Object.assign(root, rootPatch);
      }
    }

    const legacySystemChildren = treeNodes.filter((item) => (
      Number(item.id) !== Number(root.id)
      && item.system_key
      && String(item.system_key).trim()
    ));
    for (const child of legacySystemChildren) {
      await dbRun(
        `
          UPDATE knowledge_nodes
          SET system_key = ''
          WHERE id = ?
        `,
        [child.id],
      );
      child.system_key = '';
    }
  }
}

async function getEffectiveRequiredLevelForNode(node) {
  let current = node;
  while (current) {
    const requiredLevel = getRequiredLevelForNode(current);
    if (requiredLevel > 0) {
      return requiredLevel;
    }
    if (current.parent_id === null) {
      return 0;
    }
    current = await dbGet(
      `
        SELECT id, tree_id, parent_id, name, sort_order, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
        FROM knowledge_nodes
        WHERE id = ?
      `,
      [current.parent_id],
    );
  }
  return 0;
}

function findTreeNodeById(root, nodeId) {
  if (!root) {
    return null;
  }
  if (String(root.id) === String(nodeId)) {
    return root;
  }

  for (const child of root.children || []) {
    const matched = findTreeNodeById(child, nodeId);
    if (matched) {
      return matched;
    }
  }

  return null;
}

async function getEffectiveUnlockStateForStudentNode(student, node, submissions = null) {
  const [tree, treeNodes, resolvedSubmissions] = await Promise.all([
    dbGet('SELECT id, system_key FROM learning_trees WHERE id = ?', [node.tree_id]),
    dbAll(
      `
        SELECT
          id,
          tree_id,
          parent_id,
          name,
          sort_order,
          system_key,
          milestone_level,
          required_level,
          unlock_prerequisites,
          unlock_prerequisite_mode
        FROM knowledge_nodes
        WHERE tree_id = ?
        ORDER BY parent_id IS NOT NULL, sort_order, id
      `,
      [node.tree_id],
    ),
    submissions ? Promise.resolve(submissions) : getSubmissionsForStudent(student.id),
  ]);

  const sortedNodes = sortNodes(treeNodes);
  const detailByNodeId = buildSubmissionDetailByNodeId(sortedNodes, resolvedSubmissions);
  const nodeStateByNodeId = tree && tree.system_key === SPECIAL_TREE_KEYS.reward
    ? buildRewardNodeStateByNodeId(sortedNodes, getStudentLevel(student))
    : new Map();
  const root = buildTree(sortedNodes, detailByNodeId, nodeStateByNodeId);
  const matchedNode = findTreeNodeById(root, node.id);

  if (!matchedNode) {
    const requiredLevel = await getEffectiveRequiredLevelForNode(node);
    return {
      unlocked: requiredLevel <= getStudentLevel(student),
      lockedText: requiredLevel > 0 ? `达到 ${requiredLevel} 级后解锁` : '',
      requiredLevel,
    };
  }

  return {
    unlocked: matchedNode.unlocked !== false,
    lockedText: matchedNode.lockedText || '',
    requiredLevel: Number(matchedNode.requiredLevel || 0),
  };
}

async function getSubmissionsForStudent(studentId) {
  return dbAll(
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
      WHERE student_id = ?
      ORDER BY submitted_at DESC, id DESC
    `,
    [studentId],
  );
}

async function syncScoreAggregateForStudentNode(studentId, nodeId) {
  const submissions = await dbAll(
    `
      SELECT
        id,
        student_id,
        node_id,
        teacher_score,
        teacher_comment,
        scored_at,
        submitted_at
      FROM student_node_submissions
      WHERE student_id = ?
        AND node_id = ?
      ORDER BY submitted_at DESC, id DESC
    `,
    [studentId, nodeId],
  );
  const summary = summarizeSubmissionHistory(submissions);
  const bestReviewedSubmission = summary.bestReviewedSubmission;

  if (!bestReviewedSubmission || summary.highestTeacherScore === null) {
    await dbRun(
      'DELETE FROM student_scores WHERE student_id = ? AND node_id = ?',
      [studentId, nodeId],
    );
    return null;
  }

  await dbRun(
    `
      INSERT INTO student_scores (student_id, node_id, score, comment, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(student_id, node_id)
      DO UPDATE SET
        score = excluded.score,
        comment = excluded.comment,
        updated_at = excluded.updated_at
    `,
    [
      studentId,
      nodeId,
      summary.highestTeacherScore,
      bestReviewedSubmission.teacher_comment || '',
      bestReviewedSubmission.scored_at || bestReviewedSubmission.submitted_at || new Date().toISOString(),
    ],
  );

  return dbGet(
    `
      SELECT id, student_id, node_id, score, comment, updated_at
      FROM student_scores
      WHERE student_id = ? AND node_id = ?
    `,
    [studentId, nodeId],
  );
}

async function syncStudentMilestones(studentId) {
  const student = await dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
    [studentId],
  );
  if (!student) {
    return null;
  }

  const [trees, nodes, submissions] = await Promise.all([
    dbAll(`
      SELECT id, title, chapter_desc, created_at, system_key, tree_type
      FROM learning_trees
      ORDER BY id ASC
    `),
    dbAll(`
      SELECT
        id,
        tree_id,
        parent_id,
        name,
        sort_order,
        created_at,
        system_key,
        milestone_level,
        required_level,
        unlock_prerequisites,
        unlock_prerequisite_mode
      FROM knowledge_nodes
      ORDER BY tree_id, parent_id IS NOT NULL, sort_order, id
    `),
    getSubmissionsForStudent(studentId),
  ]);

  const treeBySystemKey = new Map(trees.map((item) => [item.system_key || '', item]));
  const nodesByTree = groupNodesByTree(nodes);
  const detailByNodeId = buildSubmissionDetailByNodeId(nodes, submissions);

  let nextLevel = getStudentLevel(student);
  const knowledgeTree = treeBySystemKey.get(SPECIAL_TREE_KEYS.knowledge) || null;
  if (knowledgeTree) {
    const knowledgeRoot = buildTree(
      sortNodes(nodesByTree.get(knowledgeTree.id) || []),
      detailByNodeId,
    );
    const milestoneNodes = [];
    (function collectMilestones(node) {
      if (!node) {
        return;
      }
      if (toPositiveInt(node.milestoneLevel) > 0) {
        milestoneNodes.push(node);
      }
      (node.children || []).forEach(collectMilestones);
    })(knowledgeRoot);

    milestoneNodes.forEach((node) => {
      if (getProgressRatio(node) >= KNOWLEDGE_LEVEL_THRESHOLD) {
        nextLevel = Math.max(nextLevel, toPositiveInt(node.milestoneLevel));
      }
    });
  }

  let nextTotalPoints = getStudentTotalPoints(student);
  let rewardTreePointClaimed = !!student.reward_tree_point_claimed;
  const rewardTree = treeBySystemKey.get(SPECIAL_TREE_KEYS.reward) || null;
  if (rewardTree) {
    const rewardNodes = sortNodes(nodesByTree.get(rewardTree.id) || []);
    const rewardRoot = buildTree(
      rewardNodes,
      detailByNodeId,
      buildRewardNodeStateByNodeId(rewardNodes, nextLevel),
    );
    if (!rewardTreePointClaimed && getProgressRatio(rewardRoot) >= REWARD_TREE_POINT_THRESHOLD) {
      nextTotalPoints += REWARD_TREE_POINT_REWARD;
      rewardTreePointClaimed = true;
    }
  }

  if (
    nextLevel === getStudentLevel(student)
    && nextTotalPoints === getStudentTotalPoints(student)
    && rewardTreePointClaimed === !!student.reward_tree_point_claimed
  ) {
    return student;
  }

  await dbRun(
    `
      UPDATE students
      SET level = ?, total_points = ?, reward_tree_point_claimed = ?
      WHERE id = ?
    `,
    [nextLevel, nextTotalPoints, rewardTreePointClaimed ? 1 : 0, studentId],
  );

  return dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
    [studentId],
  );
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
        unlock_prerequisites TEXT NOT NULL DEFAULT '[]',
        unlock_prerequisite_mode TEXT NOT NULL DEFAULT 'all',
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
        unlock_prerequisites TEXT NOT NULL DEFAULT '[]',
        unlock_prerequisite_mode TEXT NOT NULL DEFAULT 'all',
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

  await ensureColumn('students', 'level', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('students', 'total_points', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('students', 'reward_tree_point_claimed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('learning_trees', 'system_key', 'TEXT');
  await ensureColumn('learning_trees', 'tree_type', 'TEXT');
  await ensureColumn('knowledge_nodes', 'system_key', 'TEXT');
  await ensureColumn('knowledge_nodes', 'milestone_level', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('knowledge_nodes', 'required_level', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('knowledge_nodes', 'unlock_prerequisites', `TEXT NOT NULL DEFAULT '[]'`);
  await ensureColumn('knowledge_nodes', 'unlock_prerequisite_mode', `TEXT NOT NULL DEFAULT 'all'`);

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

  await ensureSpecialTrees();
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

  res.json({
    token,
    teacher: {
      id: teacher.id,
      username: teacher.username,
    },
  });
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
    SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
    FROM students
    ORDER BY id DESC
  `);
  const syncedStudents = await Promise.all(
    students.map(async (student) => (await syncStudentMilestones(student.id)) || student),
  );
  res.json(syncedStudents);
}));

app.post('/api/students', requireTeacher, asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const name = normalizeString(req.body.name, '姓名', { maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });

  const passwordHash = createPasswordHash(password);

  const result = await dbRun(
    `
      INSERT INTO students (username, password_hash, name, level, total_points, reward_tree_point_claimed)
      VALUES (?, ?, ?, 0, 0, 0)
    `,
    [username, passwordHash, name],
  );

  const student = await dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
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
    `
      UPDATE students
      SET
        username = ?,
        name = ?,
        password_hash = ?,
        level = ?,
        total_points = ?,
        reward_tree_point_claimed = ?
      WHERE id = ?
    `,
    [
      username,
      name,
      passwordHash,
      getStudentLevel(existing),
      getStudentTotalPoints(existing),
      existing.reward_tree_point_claimed ? 1 : 0,
      id,
    ],
  );

  const student = await dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
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
      t.system_key,
      t.tree_type,
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

app.get('/api/system-tree-settings', requireTeacher, asyncHandler(async (_req, res) => {
  const [trees, nodes] = await Promise.all([
    dbAll(`
      SELECT id, title, chapter_desc, created_at, system_key, tree_type
      FROM learning_trees
      ORDER BY id ASC
    `),
    dbAll(`
      SELECT
        id,
        tree_id,
        parent_id,
        name,
        sort_order,
        created_at,
        system_key,
        milestone_level,
        required_level
      FROM knowledge_nodes
      ORDER BY tree_id, parent_id IS NOT NULL, sort_order, id
    `),
  ]);

  const treeBySystemKey = new Map(trees.map((item) => [item.system_key || '', item]));
  const nodesByTree = groupNodesByTree(nodes);

  res.json({
    knowledge_level_threshold: KNOWLEDGE_LEVEL_THRESHOLD,
    reward_tree_point_threshold: REWARD_TREE_POINT_THRESHOLD,
    reward_tree_point_reward: REWARD_TREE_POINT_REWARD,
    trees: SPECIAL_TREE_SPECS.map((spec) => {
      const tree = treeBySystemKey.get(spec.systemKey) || null;
      const treeNodes = tree ? sortNodes(nodesByTree.get(tree.id) || []) : [];
      const pathById = buildNodePathById(treeNodes);
      const systemNodes = treeNodes.filter(isSystemManagedNode);

      return {
        tree_id: tree ? tree.id : '',
        system_key: spec.systemKey,
        tree_type: spec.treeType,
        title: tree ? tree.title : spec.title,
        chapter_desc: tree ? tree.chapter_desc || '' : spec.chapterDesc || '',
        completion_threshold: spec.treeType === 'knowledge'
          ? KNOWLEDGE_LEVEL_THRESHOLD
          : REWARD_TREE_POINT_THRESHOLD,
        reward_points: spec.treeType === 'reward' ? REWARD_TREE_POINT_REWARD : 0,
        rules: buildSystemTreeRules(spec.treeType),
        nodes: systemNodes.map((node) => ({
          id: node.id,
          tree_id: node.tree_id,
          parent_id: node.parent_id,
          system_key: node.system_key || '',
          milestone_level: Number(node.milestone_level || 0),
          required_level: Number(node.required_level || 0),
          name: node.name,
          sort_order: Number(node.sort_order || 0),
          created_at: node.created_at,
          path: pathById.get(node.id) || node.name,
          is_root: !node.parent_id,
        })),
      };
    }),
  });
}));

app.post('/api/trees', requireTeacher, asyncHandler(async (req, res) => {
  const title = normalizeString(req.body.title, '章节标题', { required: true, maxLength: 120 });
  const chapterDesc = normalizeString(req.body.chapterDesc, '章节描述', { maxLength: 500 });
  const rootName = normalizeString(req.body.rootName, '根节点名称', { required: true, maxLength: 120 });

  const treeResult = await dbRun(
    'INSERT INTO learning_trees (title, chapter_desc, system_key, tree_type) VALUES (?, ?, NULL, NULL)',
    [title, chapterDesc],
  );

  await dbRun(
    `
      INSERT INTO knowledge_nodes (
        tree_id,
        parent_id,
        name,
        sort_order,
        system_key,
        milestone_level,
        required_level
      )
      VALUES (?, NULL, ?, 0, NULL, 0, 0)
    `,
    [treeResult.lastID, rootName],
  );

  const tree = await dbGet(
    'SELECT id, title, chapter_desc, created_at, system_key, tree_type FROM learning_trees WHERE id = ?',
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

  const tree = await dbGet(
    'SELECT id, title, chapter_desc, created_at, system_key, tree_type FROM learning_trees WHERE id = ?',
    [id],
  );
  res.json(tree);
}));

app.delete('/api/trees/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '树 ID 不合法');
  }

  const existing = await dbGet('SELECT id, system_key FROM learning_trees WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError(404, '学习树不存在');
  }
  if (existing.system_key) {
    throw new AppError(400, '系统树不支持删除');
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
    SELECT id, tree_id, parent_id, name, sort_order, created_at, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
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
  const milestoneLevel = req.body.milestoneLevel !== undefined
    ? normalizeNonNegativeInteger(req.body.milestoneLevel, '升级等级')
    : 0;
  const requiredLevel = req.body.requiredLevel !== undefined
    ? normalizeNonNegativeInteger(req.body.requiredLevel, '解锁等级')
    : 0;
  const unlockPrerequisites = normalizeUnlockPrerequisites(req.body.unlockPrerequisites);
  const unlockPrerequisiteMode = normalizeUnlockPrerequisiteMode(req.body.unlockPrerequisiteMode);

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

  const treeNodes = await dbAll(
    `
      SELECT id, tree_id, parent_id, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE tree_id = ?
    `,
    [treeId],
  );
  validateNodeUnlockPrerequisites({
    treeId,
    parentId,
    rules: unlockPrerequisites,
    allNodes: treeNodes,
  });

  const result = await dbRun(
    `
      INSERT INTO knowledge_nodes (
        tree_id,
        parent_id,
        name,
        sort_order,
        system_key,
        milestone_level,
        required_level,
        unlock_prerequisites,
        unlock_prerequisite_mode
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `,
    [
      treeId,
      parentId,
      name,
      sortOrder,
      milestoneLevel,
      requiredLevel,
      serializeUnlockPrerequisites(unlockPrerequisites),
      unlockPrerequisiteMode,
    ],
  );

  const node = await dbGet(
    `
      SELECT id, tree_id, parent_id, name, sort_order, created_at, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE id = ?
    `,
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
  const milestoneLevel = req.body.milestoneLevel !== undefined
    ? normalizeNonNegativeInteger(req.body.milestoneLevel, '升级等级')
    : Number(existing.milestone_level || 0);
  const requiredLevel = req.body.requiredLevel !== undefined
    ? normalizeNonNegativeInteger(req.body.requiredLevel, '解锁等级')
    : Number(existing.required_level || 0);
  const unlockPrerequisites = req.body.unlockPrerequisites !== undefined
    ? normalizeUnlockPrerequisites(req.body.unlockPrerequisites)
    : getNodeUnlockPrerequisites(existing);
  const unlockPrerequisiteMode = req.body.unlockPrerequisiteMode !== undefined
    ? normalizeUnlockPrerequisiteMode(req.body.unlockPrerequisiteMode)
    : getNodeUnlockPrerequisiteMode(existing);

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

  const treeNodes = await dbAll(
    `
      SELECT id, tree_id, parent_id, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE tree_id = ?
    `,
    [existing.tree_id],
  );
  validateNodeUnlockPrerequisites({
    nodeId: existing.id,
    treeId: existing.tree_id,
    parentId,
    rules: unlockPrerequisites,
    allNodes: treeNodes,
  });

  await dbRun(
    `
      UPDATE knowledge_nodes
      SET
        name = ?,
        parent_id = ?,
        sort_order = ?,
        milestone_level = ?,
        required_level = ?,
        unlock_prerequisites = ?,
        unlock_prerequisite_mode = ?
      WHERE id = ?
    `,
    [
      name,
      parentId,
      sortOrder,
      milestoneLevel,
      requiredLevel,
      serializeUnlockPrerequisites(unlockPrerequisites),
      unlockPrerequisiteMode,
      id,
    ],
  );

  const node = await dbGet(
    `
      SELECT id, tree_id, parent_id, name, sort_order, created_at, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE id = ?
    `,
    [id],
  );

  res.json(node);
}));

app.delete('/api/nodes/:id', requireTeacher, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, '节点 ID 不合法');
  }

  const node = await dbGet(
    'SELECT id, tree_id, parent_id, name, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode FROM knowledge_nodes WHERE id = ?',
    [id],
  );
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.system_key && String(node.system_key).trim()) {
    throw new AppError(400, '系统节点不支持删除');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不能单独删除，请删除整棵学习树');
  }

  const treeNodes = await dbAll(
    `
      SELECT id, tree_id, parent_id, name, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE tree_id = ?
    `,
    [node.tree_id],
  );
  const removingIds = new Set([String(node.id), ...getNodeDescendantIdSet(node.id, treeNodes)]);
  const blockedBy = treeNodes.find((item) => {
    if (removingIds.has(String(item.id))) {
      return false;
    }
    return getNodeUnlockPrerequisites(item).some((rule) => removingIds.has(String(rule.source_node_id)));
  });
  if (blockedBy) {
    throw new AppError(400, `节点「${blockedBy.name}」仍把当前节点设为前置条件，不能删除`);
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
      SELECT id, student_id, node_id
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

  await syncScoreAggregateForStudentNode(existing.student_id, existing.node_id);
  await syncStudentMilestones(existing.student_id);
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

  const latestSubmission = await dbGet(
    `
      SELECT id
      FROM student_node_submissions
      WHERE student_id = ?
        AND node_id = ?
      ORDER BY submitted_at DESC, id DESC
      LIMIT 1
    `,
    [studentId, nodeId],
  );

  if (latestSubmission) {
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
      [score, comment, score, comment, latestSubmission.id],
    );
  } else {
    throw new AppError(400, '该节点暂无学生提交，请先提交答案后再批改');
  }

  const row = await syncScoreAggregateForStudentNode(studentId, nodeId);
  await syncStudentMilestones(studentId);

  res.json(row || {
    student_id: studentId,
    node_id: nodeId,
    score: null,
    comment: '',
    updated_at: null,
  });
}));

app.delete('/api/scores', requireTeacher, asyncHandler(async (req, res) => {
  void req;
  res.status(400).json({ message: '节点评分已改为按单次提交批改，请改用 /api/submissions/:id/score' });
}));

app.post('/api/student/login', asyncHandler(async (req, res) => {
  const username = normalizeString(req.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(req.body.password, '密码', { required: true, maxLength: 200 });

  const student = await dbGet(
    `
      SELECT id, username, name, password_hash, wechat_openid, level, total_points, reward_tree_point_claimed
      FROM students
      WHERE username = ?
    `,
    [username],
  );
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  const syncedStudent = await syncStudentMilestones(student.id) || student;
  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({
    token,
    student: {
      id: syncedStudent.id,
      username: syncedStudent.username,
      name: syncedStudent.name,
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
      wechat_openid: syncedStudent.wechat_openid,
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
  const student = await syncStudentMilestones(req.studentId) || await dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
    [req.studentId],
  );
  if (!student) {
    throw new AppError(401, '学生会话已失效');
  }
  res.json({
    id: student.id,
    username: student.username,
    name: student.name,
    wechat_openid: student.wechat_openid,
    level: getStudentLevel(student),
    total_points: getStudentTotalPoints(student),
    created_at: student.created_at,
  });
}));

app.post('/api/student/node-submissions', requireStudent, asyncHandler(async (req, res) => {
  const nodeId = Number(req.body.nodeId);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new AppError(400, 'nodeId 必填且必须是正整数');
  }

  const node = await dbGet(
    `
      SELECT id, tree_id, parent_id, name, sort_order, system_key, milestone_level, required_level, unlock_prerequisites, unlock_prerequisite_mode
      FROM knowledge_nodes
      WHERE id = ?
    `,
    [nodeId],
  );
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (node.parent_id === null) {
    throw new AppError(400, '根节点不支持提交代码');
  }
  const childNode = await dbGet('SELECT id FROM knowledge_nodes WHERE parent_id = ? LIMIT 1', [nodeId]);
  if (childNode) {
    throw new AppError(400, '只有叶子节点支持提交代码');
  }

  const syncedStudent = await syncStudentMilestones(req.studentId) || await dbGet(
    `
      SELECT id, level, total_points, reward_tree_point_claimed
      FROM students
      WHERE id = ?
    `,
    [req.studentId],
  );
  const requiredLevel = await getEffectiveRequiredLevelForNode(node);
  const unlockState = await getEffectiveUnlockStateForStudentNode(syncedStudent, node);
  if (!unlockState.unlocked) {
    throw new AppError(403, `该任务点尚未解锁，${unlockState.lockedText || `达到 ${requiredLevel} 级后才能提交`}`);
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

  const syncedStudent = await syncStudentMilestones(student.id) || {
    ...student,
    wechat_openid: openid,
  };
  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({
    token,
    student: {
      id: syncedStudent.id,
      username: syncedStudent.username,
      name: syncedStudent.name,
      wechat_openid: openid,
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
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

  const syncedStudent = await syncStudentMilestones(student.id) || student;
  const token = createAuthToken('student', student.id);
  res.cookie('student_token', token, getCookieOptions());

  res.json({
    token,
    student: {
      ...syncedStudent,
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
    },
  });
}));

app.get('/api/student/trees', requireStudent, asyncHandler(async (req, res) => {
  const syncedStudent = await syncStudentMilestones(req.studentId) || await dbGet(
    `
      SELECT id, username, name, wechat_openid, level, total_points, reward_tree_point_claimed, created_at
      FROM students
      WHERE id = ?
    `,
    [req.studentId],
  );

  const [trees, nodes, submissions] = await Promise.all([
    dbAll(`
      SELECT id, title, chapter_desc, created_at, system_key, tree_type
      FROM learning_trees
      ORDER BY id ASC
    `),
    dbAll(`
      SELECT
        id,
        tree_id,
        parent_id,
        name,
        sort_order,
        created_at,
        system_key,
        milestone_level,
        required_level,
        unlock_prerequisites,
        unlock_prerequisite_mode
      FROM knowledge_nodes
      ORDER BY tree_id, parent_id IS NOT NULL, sort_order, id
    `),
    getSubmissionsForStudent(req.studentId),
  ]);

  const detailByNodeId = buildSubmissionDetailByNodeId(nodes, submissions);
  const nodesByTree = groupNodesByTree(nodes);
  const treeBySystemKey = new Map(trees.map((item) => [item.system_key || '', item]));
  const rewardTree = treeBySystemKey.get(SPECIAL_TREE_KEYS.reward) || null;

  const result = trees.map((tree) => {
    const treeNodes = sortNodes(nodesByTree.get(tree.id) || []);
    const nodeStateByNodeId = rewardTree && rewardTree.id === tree.id
      ? buildRewardNodeStateByNodeId(treeNodes, getStudentLevel(syncedStudent))
      : new Map();
    return {
      id: tree.id,
      title: tree.title,
      chapterDesc: tree.chapter_desc,
      createdAt: tree.created_at,
      systemKey: tree.system_key || '',
      treeType: tree.tree_type || '',
      root: buildTree(treeNodes, detailByNodeId, nodeStateByNodeId),
    };
  });

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
