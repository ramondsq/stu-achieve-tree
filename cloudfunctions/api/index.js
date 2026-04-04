const crypto = require('crypto');
const COS = require('cos-nodejs-sdk-v5');
const cloud = require('wx-server-sdk');
const petSystem = require('./pet-system');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const command = db.command;

const COLLECTIONS = {
  teachers: 'achv_teachers',
  students: 'achv_students',
  trees: 'achv_learning_trees',
  nodes: 'achv_knowledge_nodes',
  scores: 'achv_student_scores',
  submissions: 'achv_student_node_submissions',
  shareCards: 'achv_share_cards',
};

const MAX_QUERY_BATCH = 100;
const MAX_CODE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SUBMISSION_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PROBLEM_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_SHARE_CARD_CODE_CHARS = 420;
const MAX_SHARE_CARD_CODE_LINES = 12;
const MAX_SHARE_CARD_COMMENT_CHARS = 140;
const MAX_SHARE_CARD_COMMENT_LINES = 4;
const MAX_SHARE_CARD_IMAGES = 3;
const SHARE_CARD_VERSION = 1;
const SHARE_CARD_ENCOURAGEMENTS = [
  '把今天写过的每一行代码，都当成在给未来的自己铺路。',
  '慢一点没关系，只要你还在向前，成长就没有暂停。',
  '真正拉开差距的，不是天赋，是一次次愿意继续做下去。',
  '把难题拆小，把情绪放稳，你会比想象中更强。',
  '今天的认真积累，会在某一天变成你稳稳的底气。',
  '不用着急证明自己，持续进步本身就是答案。',
  '能坚持把基础打牢的人，最后往往走得更远。',
  '你现在啃下来的每个知识点，都会在未来回过头来帮你。',
];
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_SECRET = process.env.APP_SECRET || 'cloudbase-dev-secret-change-me';
const CODE_IMAGE_PREFIX = 'student-code';
const SUBMISSION_FILE_PREFIX = 'student-submissions';
const PROBLEM_ATTACHMENT_PREFIX = 'node-problems';
const PET_FRAME_PREFIX = 'pet-frames';
const UNBOUND_WECHAT_OPENID_PREFIX = '__UNBOUND__::';
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
const LEVEL_REWARD_POINT_MULTIPLIER = 100;
const WEEKLY_BOUNTY_TARGET_COUNT = 2;
const WEEKLY_BOUNTY_SCORE_THRESHOLD = 8;
const WEEKLY_BOUNTY_REWARD_POINTS = 1;
const WEEKLY_STREAK_TARGET_DAYS = 7;
const WEEKLY_STREAK_SCORE_THRESHOLD = 4;
const WEEKLY_STREAK_REWARD_POINTS = 2;
const MONTHLY_STREAK_TARGET_DAYS = 30;
const MONTHLY_STREAK_SCORE_THRESHOLD = 4;
const MONTHLY_STREAK_REWARD_POINTS = 10;
const REWARD_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_PROVIDERS = {
  cloudbase: 'cloudbase',
  cos: 'cos',
};
const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const COS_SESSION_TOKEN = process.env.COS_SESSION_TOKEN || '';
const COS_BUCKET = process.env.COS_BUCKET || '';
const COS_REGION = process.env.COS_REGION || '';
const COS_URL_EXPIRES_SECONDS = Math.max(60, Number(process.env.COS_URL_EXPIRES_SECONDS || 3600) || 3600);
let cosClient = null;

function normalizeStorageProvider(raw = '') {
  return String(raw || '').trim().toLowerCase() === STORAGE_PROVIDERS.cos
    ? STORAGE_PROVIDERS.cos
    : STORAGE_PROVIDERS.cloudbase;
}

function hasCosStorageConfig() {
  return Boolean(COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET && COS_REGION);
}

function ensureCosStorageConfigured() {
  if (hasCosStorageConfig()) {
    return;
  }
  throw new AppError(500, '未配置独立 COS 存储，请设置 COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION');
}

function getCosClient() {
  ensureCosStorageConfigured();
  if (cosClient) {
    return cosClient;
  }

  const config = {
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY,
  };
  if (COS_SESSION_TOKEN) {
    config.SecurityToken = COS_SESSION_TOKEN;
  }
  cosClient = new COS(config);
  return cosClient;
}

function callCos(method, options) {
  return new Promise((resolve, reject) => {
    getCosClient()[method](options, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data || {});
    });
  });
}

function normalizeCosObjectKey(raw = '') {
  return String(raw || '').replace(/^\/+/, '').trim();
}

function buildCosStorageFileId(bucket, region, key) {
  return `cos://${region}/${bucket}/${normalizeCosObjectKey(key)}`;
}

function parseCosStorageFileId(fileId = '') {
  const value = String(fileId || '').trim();
  if (!value.startsWith('cos://')) {
    return null;
  }

  const rest = value.slice('cos://'.length);
  const firstSlash = rest.indexOf('/');
  const secondSlash = firstSlash === -1 ? -1 : rest.indexOf('/', firstSlash + 1);
  if (firstSlash === -1 || secondSlash === -1) {
    return null;
  }

  const region = rest.slice(0, firstSlash).trim();
  const bucket = rest.slice(firstSlash + 1, secondSlash).trim();
  const key = normalizeCosObjectKey(rest.slice(secondSlash + 1));
  if (!region || !bucket || !key) {
    return null;
  }

  return {
    region,
    bucket,
    key,
  };
}

function buildCosStoredFileRecord(fileName, mimeType, key, extra = {}) {
  const normalizedKey = normalizeCosObjectKey(key);
  const bucket = String(extra.cos_bucket || extra.bucket || COS_BUCKET).trim();
  const region = String(extra.cos_region || extra.region || COS_REGION).trim();
  return {
    storage_provider: STORAGE_PROVIDERS.cos,
    file_id: String(extra.file_id || buildCosStorageFileId(bucket, region, normalizedKey)).trim(),
    file_name: String(fileName || extra.file_name || extra.fileName || 'attachment').trim() || 'attachment',
    mime_type: String(mimeType || extra.mime_type || extra.mimeType || '').trim().toLowerCase(),
    cos_bucket: bucket,
    cos_region: region,
    cos_key: normalizedKey,
    ...extra,
  };
}

function isCosStoredFile(item = {}) {
  if (!item) {
    return false;
  }
  const provider = normalizeStorageProvider(item.storage_provider || item.storageProvider || '');
  if (provider === STORAGE_PROVIDERS.cos) {
    return true;
  }
  if (item.cos_key || item.key || item.cos_bucket || item.bucket || item.cos_region || item.region) {
    return true;
  }
  return String(item.file_id || item.fileId || '').trim().startsWith('cos://');
}

function normalizeStoredFileReference(raw = {}) {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string') {
    const fileId = String(raw).trim();
    if (!fileId) {
      return null;
    }
    const parsedCos = parseCosStorageFileId(fileId);
    if (parsedCos) {
      return {
        storage_provider: STORAGE_PROVIDERS.cos,
        file_id: fileId,
        file_name: '',
        mime_type: '',
        cos_bucket: parsedCos.bucket,
        cos_region: parsedCos.region,
        cos_key: parsedCos.key,
      };
    }
    return {
      storage_provider: STORAGE_PROVIDERS.cloudbase,
      file_id: fileId,
      file_name: '',
      mime_type: '',
    };
  }

  if (isCosStoredFile(raw)) {
    const parsedCos = parseCosStorageFileId(raw.file_id || raw.fileId || '') || {};
    const key = normalizeCosObjectKey(raw.cos_key || raw.key || parsedCos.key || '');
    const bucket = String(raw.cos_bucket || raw.bucket || parsedCos.bucket || COS_BUCKET).trim();
    const region = String(raw.cos_region || raw.region || parsedCos.region || COS_REGION).trim();
    if (!bucket || !region || !key) {
      return null;
    }
    return {
      storage_provider: STORAGE_PROVIDERS.cos,
      file_id: String(raw.file_id || raw.fileId || buildCosStorageFileId(bucket, region, key)).trim(),
      file_name: String(raw.file_name || raw.fileName || 'attachment').trim() || 'attachment',
      mime_type: String(raw.mime_type || raw.mimeType || '').trim().toLowerCase(),
      cos_bucket: bucket,
      cos_region: region,
      cos_key: key,
    };
  }

  const fileId = String(raw.file_id || raw.fileId || '').trim();
  if (!fileId) {
    return null;
  }
  return {
    storage_provider: STORAGE_PROVIDERS.cloudbase,
    file_id: fileId,
    file_name: String(raw.file_name || raw.fileName || 'attachment').trim() || 'attachment',
    mime_type: String(raw.mime_type || raw.mimeType || '').trim().toLowerCase(),
  };
}

async function uploadBufferToCos(key, buffer, mimeType = '') {
  const normalizedKey = normalizeCosObjectKey(key);
  ensureCosStorageConfigured();
  await callCos('putObject', {
    Bucket: COS_BUCKET,
    Region: COS_REGION,
    Key: normalizedKey,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: mimeType || undefined,
  });
  return buildCosStoredFileRecord('', mimeType, normalizedKey);
}

async function getCosFileUrl(file) {
  const normalized = normalizeStoredFileReference(file);
  if (!normalized || normalized.storage_provider !== STORAGE_PROVIDERS.cos) {
    return '';
  }
  const data = await callCos('getObjectUrl', {
    Bucket: normalized.cos_bucket,
    Region: normalized.cos_region,
    Key: normalized.cos_key,
    Sign: true,
    Expires: COS_URL_EXPIRES_SECONDS,
  });
  return String(data.Url || '').trim();
}

async function deleteCosFiles(files = []) {
  for (const file of files) {
    try {
      await callCos('deleteObject', {
        Bucket: file.cos_bucket,
        Region: file.cos_region,
        Key: file.cos_key,
      });
    } catch (_error) {
    }
  }
}

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createSuccessResult(payload) {
  return {
    ok: true,
    data: payload,
  };
}

function createErrorResult(error) {
  return {
    ok: false,
    status: error.status || 500,
    message: error.message || '服务器异常',
  };
}

function toIsoString(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizePath(rawPath) {
  let path = String(rawPath || '/').trim();
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    path = path.slice(0, queryIndex);
  }
  if (path.startsWith('/api/')) {
    path = path.slice(4);
  } else if (path === '/api') {
    path = '/';
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path || '/';
}

function extractQueryFromPath(rawPath) {
  const path = String(rawPath || '').trim();
  const queryIndex = path.indexOf('?');
  if (queryIndex === -1) {
    return {};
  }

  const search = path.slice(queryIndex + 1);
  const params = new URLSearchParams(search);
  const result = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function lowerCaseKeys(input) {
  return Object.entries(input || {}).reduce((acc, [key, value]) => {
    acc[String(key).toLowerCase()] = value;
    return acc;
  }, {});
}

function normalizeString(value, label, options = {}) {
  const {
    required = false,
    maxLength = null,
    allowEmpty = false,
  } = options;

  if (value === undefined || value === null) {
    if (required) {
      throw new AppError(400, `${label}不能为空`);
    }
    return null;
  }

  const normalized = String(value).trim();
  if (!allowEmpty && normalized === '') {
    if (required) {
      throw new AppError(400, `${label}不能为空`);
    }
    return null;
  }

  if (maxLength && normalized.length > maxLength) {
    throw new AppError(400, `${label}长度不能超过 ${maxLength} 个字符`);
  }

  return normalized;
}

function normalizeOptionalId(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > 120) {
    throw new AppError(400, `${label}不合法`);
  }

  return normalized;
}

function normalizeRequiredId(value, label) {
  const normalized = normalizeOptionalId(value, label);
  if (!normalized) {
    throw new AppError(400, `${label}不能为空`);
  }
  return normalized;
}

function normalizeScore(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const score = Number(value);
  if (Number.isNaN(score) || score < 0 || score > 10) {
    throw new AppError(400, '评分必须是 0-10 的数字');
  }
  return score;
}

function normalizeTeacherScore(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const score = Number(value);
  if (Number.isNaN(score) || score < 0 || score > 10) {
    throw new AppError(400, '老师评分必须是 0-10 的数字');
  }
  return score;
}

function normalizeNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new AppError(400, `${label}必须是大于等于 0 的整数`);
  }
  return num;
}

function normalizeUnlockThresholdPercent(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 100) {
    throw new AppError(400, `${label}必须是 0 到 100 之间的数字`);
  }
  return Number.isInteger(num) ? num : Number(num.toFixed(1));
}

function normalizeUnlockPrerequisites(value, label = '前置条件') {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_err) {
      throw new AppError(400, `${label}格式不正确`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(400, `${label}必须是数组`);
  }
  if (parsed.length > MAX_UNLOCK_PREREQUISITES) {
    throw new AppError(400, `${label}最多只能设置 ${MAX_UNLOCK_PREREQUISITES} 条`);
  }

  const normalized = [];
  const indexBySource = new Map();
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new AppError(400, `${label} #${index + 1} 格式不正确`);
    }

    const sourceNodeId = normalizeRequiredId(
      item.sourceNodeId ?? item.source_node_id,
      `${label} #${index + 1} 的前置节点 ID`,
    );
    const thresholdPercent = normalizeUnlockThresholdPercent(
      item.thresholdPercent ?? item.threshold_percent ?? item.threshold,
      `${label} #${index + 1} 的完成度`,
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

function normalizeUnlockPrerequisiteMode(value, label = '前置条件模式') {
  const normalized = String(value || 'all').trim().toLowerCase();
  if (normalized !== 'all' && normalized !== 'any') {
    throw new AppError(400, `${label}只支持 all 或 any`);
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

    const sourceNodeId = normalizeOptionalId(item.sourceNodeId ?? item.source_node_id, '前置节点 ID');
    const thresholdPercent = Number(item.thresholdPercent ?? item.threshold_percent ?? item.threshold);
    if (!sourceNodeId) {
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
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (text.length > 20000) {
    throw new AppError(400, '代码文本长度不能超过 20000 个字符');
  }
  return text;
}

function truncateMultilineText(value, options = {}) {
  const maxChars = Number(options.maxChars || 0) || 0;
  const maxLines = Number(options.maxLines || 0) || 0;
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text) {
    return '';
  }

  let lines = text
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line, index, arr) => line || index < arr.length - 1);

  if (maxLines > 0 && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
  }

  let nextText = lines.join('\n').trim();
  if (maxChars > 0 && nextText.length > maxChars) {
    nextText = `${nextText.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  } else if ((maxLines > 0 && text.split('\n').length > maxLines) || nextText.length < text.length) {
    nextText = `${nextText.replace(/[\s…]+$/g, '')}…`;
  }
  return nextText;
}

function countCodeLines(value) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text) {
    return 0;
  }
  return text.split('\n').length;
}

function getStudentShareDisplayName(student) {
  if (!student) {
    return '同学';
  }
  return String(student.name || student.username || '同学').trim() || '同学';
}

function createShareThemeSeed(studentId, nodeId) {
  return crypto
    .createHash('md5')
    .update(`${String(studentId || '')}:${String(nodeId || '')}`)
    .digest('hex')
    .slice(0, 12);
}

function buildStoredShareImageItems(imageItems = []) {
  return imageItems
    .slice(0, MAX_SHARE_CARD_IMAGES)
    .map((item) => normalizeStoredSubmissionImageRecord(item))
    .filter(Boolean);
}

function buildShareCalendarOutput(summaryCalendar) {
  if (!summaryCalendar || !Array.isArray(summaryCalendar.cells)) {
    return null;
  }

  return {
    month_label: summaryCalendar.month_label || '',
    summary_text: summaryCalendar.summary_text || '',
    active_days: Number(summaryCalendar.active_days || 0),
    reviewed_days: Number(summaryCalendar.reviewed_days || 0),
    submitted_count: Number(summaryCalendar.submitted_count || 0),
    cells: summaryCalendar.cells.map((cell, index) => ({
      key: cell.key || `cell-${index}`,
      day_label: cell.day_label || '',
      placeholder: !!cell.placeholder,
      has_submission: !!cell.has_submission,
      highest_score: cell.highest_score === undefined ? null : cell.highest_score,
      band: cell.band || 'none',
      is_today: !!cell.is_today,
    })),
  };
}

function pickShareCodeText(detail = {}) {
  if (detail.codeText) {
    return String(detail.codeText).trim();
  }
  const history = Array.isArray(detail.submissionHistory) ? detail.submissionHistory : [];
  const matched = history.find((item) => String(item.code_text || '').trim());
  return matched ? String(matched.code_text || '').trim() : '';
}

function pickShareTeacherComment(detail = {}) {
  if (detail.latestTeacherComment) {
    return String(detail.latestTeacherComment).trim();
  }
  if (detail.comment) {
    return String(detail.comment).trim();
  }
  const history = Array.isArray(detail.submissionHistory) ? detail.submissionHistory : [];
  const matched = history.find((item) => String(item.teacher_comment || '').trim());
  return matched ? String(matched.teacher_comment || '').trim() : '';
}

function pickShareImageItems(detail = {}) {
  if (Array.isArray(detail.codeImageItems) && detail.codeImageItems.length) {
    return buildStoredShareImageItems(detail.codeImageItems);
  }
  const history = Array.isArray(detail.submissionHistory) ? detail.submissionHistory : [];
  const matched = history.find((item) => Array.isArray(item.code_image_items) && item.code_image_items.length);
  return matched ? buildStoredShareImageItems(matched.code_image_items) : [];
}

function pickShareEncouragement(seed = '') {
  const source = String(seed || 'share-card');
  let total = 0;
  Array.from(source).forEach((char, index) => {
    total = (total + char.charCodeAt(0) * (index + 1)) % SHARE_CARD_ENCOURAGEMENTS.length;
  });
  return SHARE_CARD_ENCOURAGEMENTS[total] || SHARE_CARD_ENCOURAGEMENTS[0];
}

function buildShareCardOutput(item, imageItems = []) {
  return {
    id: item._id,
    version: Number(item.version || SHARE_CARD_VERSION),
    share_kind: item.share_kind || 'node',
    summary_scope: item.summary_scope || '',
    summary_scope_label: item.summary_scope_label || '',
    share_title: item.share_title || '',
    share_subtitle: item.share_subtitle || '',
    student_display_name: item.student_display_name || '同学',
    student_level: Number(item.student_level || 0),
    student_total_points: Number(item.student_total_points || 0),
    tree_id: item.tree_id || '',
    tree_title: item.tree_title || '',
    tree_type: item.tree_type || '',
    node_id: item.node_id || '',
    node_name: item.node_name || '',
    node_path: item.node_path || '',
    submission_count: Number(item.submission_count || 0),
    reviewed_submission_count: Number(item.reviewed_submission_count || 0),
    active_tree_count: Number(item.active_tree_count || 0),
    active_node_count: Number(item.active_node_count || 0),
    summary_calendar: buildShareCalendarOutput(item.summary_calendar),
    summary_highlights: Array.isArray(item.summary_highlights)
      ? item.summary_highlights.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 4)
      : [],
    highest_teacher_score: item.highest_teacher_score === undefined ? null : item.highest_teacher_score,
    latest_teacher_score: item.latest_teacher_score === undefined ? null : item.latest_teacher_score,
    average_teacher_score: item.average_teacher_score === undefined ? null : item.average_teacher_score,
    latest_teacher_comment: item.latest_teacher_comment || '',
    latest_submitted_at: item.latest_submitted_at || '',
    latest_reviewed_at: item.latest_reviewed_at || '',
    code_snippet: item.code_snippet || '',
    code_line_count: Number(item.code_line_count || 0),
    tree_current_score: Number(item.tree_current_score || 0),
    tree_total_score: Number(item.tree_total_score || 0),
    node_current_score: Number(item.node_current_score || 0),
    node_total_score: Number(item.node_total_score || 0),
    theme_seed: item.theme_seed || '',
    cover_image_url: imageItems[0] ? imageItems[0].url : '',
    cover_image_count: imageItems.length,
    code_image_items: imageItems,
    encouragement_text: item.encouragement_text || pickShareEncouragement(item.theme_seed || item._id || item.node_id || item.student_id),
    created_at: item.created_at || '',
  };
}

function normalizeShareCardMode(body = {}) {
  const explicit = String(body.mode || body.shareMode || body.share_mode || '').trim().toLowerCase();
  if (explicit === 'summary') {
    return 'summary';
  }
  if (explicit === 'node') {
    return 'node';
  }
  if ((body.summaryScope || body.summary_scope || body.scope) && !(body.nodeId || body.node_id)) {
    return 'summary';
  }
  return 'node';
}

function normalizeShareSummaryScope(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) {
    return 'week';
  }
  if (['week', 'weekly', 'current_week'].includes(value)) {
    return 'week';
  }
  if (['month', 'monthly', 'current_month'].includes(value)) {
    return 'month';
  }
  if (['recent10', 'recent-10', 'recent_ten', 'last10', 'last_ten'].includes(value)) {
    return 'recent10';
  }
  throw new AppError(400, '分享范围不正确');
}

function toSortableDateMs(value) {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getCurrentWeekStartMs(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  return start.getTime();
}

function getCurrentMonthStartMs(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function formatHeatmapDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatHeatmapMonthLabel(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function getHeatmapBand(score, hasSubmission) {
  const numericScore = getNumericScore(score);
  if (numericScore === null) {
    return hasSubmission ? 'pending' : 'none';
  }
  if (numericScore <= 3) {
    return 'low';
  }
  if (numericScore <= 7) {
    return 'mid';
  }
  return 'high';
}

function buildMonthlyHeatmapSummary(submissions = [], now = new Date()) {
  const current = new Date(now);
  const year = current.getFullYear();
  const month = current.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingEmptyCells = (firstDay.getDay() + 6) % 7;
  const totalCells = Math.ceil((leadingEmptyCells + daysInMonth) / 7) * 7;
  const todayKey = formatHeatmapDateKey(current);
  const daySummary = new Map();

  submissions.forEach((item) => {
    const submittedAt = item && item.submitted_at ? new Date(item.submitted_at) : null;
    if (!submittedAt || Number.isNaN(submittedAt.getTime())) {
      return;
    }
    if (submittedAt.getFullYear() != year || submittedAt.getMonth() != month) {
      return;
    }

    const key = formatHeatmapDateKey(submittedAt);
    const bucket = daySummary.get(key) || {
      hasSubmission: false,
      highestScore: null,
      submittedCount: 0,
    };

    bucket.hasSubmission = true;
    bucket.submittedCount += 1;
    const numericScore = getNumericScore(item.teacher_score);
    if (numericScore !== null && (bucket.highestScore === null || numericScore > bucket.highestScore)) {
      bucket.highestScore = numericScore;
    }

    daySummary.set(key, bucket);
  });

  const cells = [];
  for (let index = 0; index < totalCells; index += 1) {
    const dayNumber = index - leadingEmptyCells + 1;
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cells.push({
        key: `empty-${index}`,
        day_label: '',
        placeholder: true,
        has_submission: false,
        highest_score: null,
        band: 'none',
        is_today: false,
      });
      continue;
    }

    const cellDate = new Date(year, month, dayNumber);
    const key = formatHeatmapDateKey(cellDate);
    const summary = daySummary.get(key) || null;
    const hasSubmission = !!(summary && summary.hasSubmission);
    const highestScore = summary ? summary.highestScore : null;

    cells.push({
      key,
      day_label: String(dayNumber),
      placeholder: false,
      has_submission: hasSubmission,
      highest_score: highestScore,
      band: getHeatmapBand(highestScore, hasSubmission),
      is_today: key === todayKey,
    });
  }

  const activeDays = cells.filter((cell) => cell.has_submission).length;
  const reviewedDays = cells.filter((cell) => cell.highest_score !== null).length;
  const submittedCount = [...daySummary.values()].reduce((sum, item) => sum + Number(item.submittedCount || 0), 0);

  return {
    month_label: formatHeatmapMonthLabel(firstDay),
    summary_text: activeDays
      ? `本月活跃 ${activeDays} 天，累计提交 ${submittedCount} 次${reviewedDays ? `，已评分 ${reviewedDays} 天` : ''}`
      : '本月还没有提交记录，开始第一次提交吧。',
    active_days: activeDays,
    reviewed_days: reviewedDays,
    submitted_count: submittedCount,
    cells,
  };
}

function getShareSummaryScopeConfig(raw) {
  const scope = normalizeShareSummaryScope(raw);
  if (scope === 'month') {
    return {
      scope,
      label: '本月',
      title: '本月学习总览',
      emptyMessage: '本月暂无可分享的提交记录',
    };
  }
  if (scope === 'recent10') {
    return {
      scope,
      label: '最近10次',
      title: '最近10次提交总览',
      emptyMessage: '最近 10 次提交记录不足，暂无法生成成果卡',
    };
  }
  return {
    scope: 'week',
    label: '本周',
    title: '本周学习总览',
    emptyMessage: '本周暂无可分享的提交记录',
  };
}

function filterSubmissionsByShareScope(submissions = [], scope) {
  const sorted = sortSubmissionsDesc(submissions);
  if (scope === 'recent10') {
    return sorted.slice(0, 10);
  }

  const now = new Date();
  const minMs = scope === 'month' ? getCurrentMonthStartMs(now) : getCurrentWeekStartMs(now);
  return sorted.filter((item) => {
    const submittedAtMs = toSortableDateMs(item.submitted_at);
    return submittedAtMs > 0 && submittedAtMs >= minMs;
  });
}

function buildShareSummaryHighlights(options = {}) {
  const topNodeLabels = Array.isArray(options.topNodeLabels)
    ? options.topNodeLabels.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const latestNodeName = String(options.latestNodeName || '').trim();
  const uniqueNames = [];
  topNodeLabels.forEach((name) => {
    if (!uniqueNames.includes(name)) {
      uniqueNames.push(name);
    }
  });
  if (!uniqueNames.length && latestNodeName) {
    uniqueNames.push(latestNodeName);
  }
  return uniqueNames.slice(0, 4);
}

function buildStudentTreeProgressSummary(student, trees = [], nodes = [], decoratedSubmissions = [], treeFilter = null) {
  const detailByNodeId = buildSubmissionDetailByNodeId(nodes, decoratedSubmissions);
  const nodesByTree = groupNodesByTree(nodes);
  const scopedTrees = typeof treeFilter === 'function' ? trees.filter((tree) => treeFilter(tree)) : trees;
  const roots = scopedTrees
    .map((tree) => {
      const treeNodes = sortNodes(nodesByTree.get(tree._id) || []);
      const nodeStateByNodeId = buildLevelUnlockStateByNodeId(treeNodes, getStudentLevel(student));
      return buildTree(treeNodes, detailByNodeId, nodeStateByNodeId, new Map());
    })
    .filter(Boolean);

  return {
    totalCurrentScore: roots.reduce((sum, root) => sum + Number(root.currentScore || 0), 0),
    totalTotalScore: roots.reduce((sum, root) => sum + Number(root.totalScore || 0), 0),
  };
}

function buildLearningTreeProgressSummary(student, trees = [], nodes = [], decoratedSubmissions = []) {
  return buildStudentTreeProgressSummary(
    student,
    trees,
    nodes,
    decoratedSubmissions,
    (tree) => String(tree.tree_type || '') !== 'reward',
  );
}

function toRewardLocalDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + REWARD_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

function formatRewardDateKey(value) {
  const date = toRewardLocalDate(value);
  if (!date) {
    return '';
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function parseRewardDateKey(key) {
  if (!key) {
    return null;
  }
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatRewardDateLabel(key) {
  const date = parseRewardDateKey(key);
  if (!date) {
    return '';
  }
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function getRewardWeekStartKey(value = new Date()) {
  const date = toRewardLocalDate(value);
  if (!date) {
    return '';
  }
  date.setUTCHours(0, 0, 0, 0);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatRewardWeekLabel(weekKey) {
  const start = parseRewardDateKey(weekKey);
  if (!start) {
    return '';
  }
  const end = new Date(start.getTime() + (6 * DAY_MS));
  return `${start.getUTCMonth() + 1}月${start.getUTCDate()}日 - ${end.getUTCMonth() + 1}月${end.getUTCDate()}日`;
}

function getRewardMonthKey(value = new Date()) {
  const date = toRewardLocalDate(value);
  if (!date) {
    return '';
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatRewardMonthLabel(monthKey) {
  const matched = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!matched) {
    return '';
  }
  return `${Number(matched[1])}年${Number(matched[2])}月`;
}

function getDaysInRewardMonth(value = new Date()) {
  const date = toRewardLocalDate(value);
  if (!date) {
    return MONTHLY_STREAK_TARGET_DAYS;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function sortRewardDateKeys(keys = []) {
  return [...new Set(
    (Array.isArray(keys) ? keys : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function getRewardDayOrdinal(key) {
  const date = parseRewardDateKey(key);
  if (!date) {
    return null;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function getClaimedLevelRewardLevels(student) {
  return [...new Set(
    (Array.isArray(student && student.claimed_level_reward_levels) ? student.claimed_level_reward_levels : [])
      .map((item) => toPositiveInt(item))
      .filter((item) => item > 0),
  )].sort((left, right) => left - right);
}

function getClaimedWeeklyBountyKeys(student) {
  return sortRewardDateKeys(Array.isArray(student && student.claimed_weekly_bounty_keys)
    ? student.claimed_weekly_bounty_keys
    : []);
}

function getClaimedWeeklyStreakKeys(student) {
  return sortRewardDateKeys(Array.isArray(student && student.claimed_weekly_streak_keys)
    ? student.claimed_weekly_streak_keys
    : []);
}

function getClaimedMonthlyStreakKeys(student) {
  return [...new Set(
    (Array.isArray(student && student.claimed_monthly_streak_keys) ? student.claimed_monthly_streak_keys : [])
      .map((item) => String(item || '').trim())
      .filter((item) => /^\d{4}-\d{2}$/.test(item)),
  )].sort((left, right) => left.localeCompare(right));
}

function buildQualifyingRewardDateKeys(submissions = [], minScore = 0, options = {}) {
  const nodeIdSet = options.nodeIdSet instanceof Set ? options.nodeIdSet : null;
  const scope = String(options.scope || '').trim().toLowerCase();
  const now = options.now || new Date();
  const weekKey = scope === 'week' ? getRewardWeekStartKey(now) : '';
  const monthKey = scope === 'month' ? getRewardMonthKey(now) : '';
  return sortRewardDateKeys(submissions.map((item) => {
    if (!item) {
      return '';
    }
    if (nodeIdSet && !nodeIdSet.has(String(item.node_id || ''))) {
      return '';
    }
    const score = getNumericScore(item.teacher_score);
    if (score === null || score < minScore) {
      return '';
    }
    if (scope === 'week' && getRewardWeekStartKey(item.submitted_at) !== weekKey) {
      return '';
    }
    if (scope === 'month' && getRewardMonthKey(item.submitted_at) !== monthKey) {
      return '';
    }
    return formatRewardDateKey(item.submitted_at);
  }));
}

function buildRewardDateRuns(dateKeys = []) {
  const runs = [];
  sortRewardDateKeys(dateKeys).forEach((key) => {
    const dayOrdinal = getRewardDayOrdinal(key);
    if (dayOrdinal === null) {
      return;
    }
    const current = runs[runs.length - 1] || null;
    if (!current || dayOrdinal !== current.endDay + 1) {
      runs.push({
        startKey: key,
        endKey: key,
        startDay: dayOrdinal,
        endDay: dayOrdinal,
        length: 1,
      });
      return;
    }
    current.endKey = key;
    current.endDay = dayOrdinal;
    current.length += 1;
  });
  return runs;
}

function summarizeRewardStreak(dateKeys = [], targetDays = 7, now = new Date()) {
  const runs = buildRewardDateRuns(dateKeys);
  const todayKey = formatRewardDateKey(now);
  const yesterdayKey = formatRewardDateKey(new Date(new Date(now).getTime() - DAY_MS));
  const latestRun = runs[runs.length - 1] || null;
  const currentDays = latestRun && (latestRun.endKey === todayKey || latestRun.endKey === yesterdayKey)
    ? latestRun.length
    : 0;
  return {
    runs,
    currentDays,
    latestQualifiedDateKey: latestRun ? latestRun.endKey : '',
    achievedCount: runs.reduce((sum, run) => sum + Math.floor(run.length / targetDays), 0),
    progressPercent: Math.max(0, Math.min(100, Math.round((Math.min(currentDays, targetDays) / targetDays) * 100))),
  };
}

function buildLevelRewardState(student) {
  const currentLevel = getStudentLevel(student);
  const claimedSet = new Set(getClaimedLevelRewardLevels(student));
  const items = [];
  let totalClaimablePoints = 0;
  let claimableCount = 0;

  for (let level = 1; level <= currentLevel; level += 1) {
    const rewardPoints = level * LEVEL_REWARD_POINT_MULTIPLIER;
    const claimed = claimedSet.has(level);
    const claimable = !claimed;
    if (claimable) {
      totalClaimablePoints += rewardPoints;
      claimableCount += 1;
    }
    items.push({
      key: `level:${level}`,
      level,
      reward_points: rewardPoints,
      reached: true,
      claimed,
      claimable,
      title: `Lv.${level} 达成积分`,
      subtitle: claimed ? `已领取 ${rewardPoints} 积分` : `达到 Lv.${level} 后可领取 ${rewardPoints} 积分`,
      status_text: claimed ? '已领取' : '待领取',
      button_text: claimed ? '已领取' : `领取 +${rewardPoints}`,
    });
  }

  const nextLevel = Math.max(1, currentLevel + 1);
  items.push({
    key: `level:preview:${nextLevel}`,
    level: nextLevel,
    reward_points: nextLevel * LEVEL_REWARD_POINT_MULTIPLIER,
    reached: false,
    claimed: false,
    claimable: false,
    title: `Lv.${nextLevel} 积分预告`,
    subtitle: `达到 Lv.${nextLevel} 后可领取 ${nextLevel * LEVEL_REWARD_POINT_MULTIPLIER} 积分`,
    status_text: '未达成',
    button_text: '继续升级',
  });

  return {
    current_level: currentLevel,
    next_level: nextLevel,
    items,
    claimable_count: claimableCount,
    total_claimable_points: totalClaimablePoints,
  };
}

function buildWeeklyBountyState(student, rewardNodeIdSet, submissions = [], now = new Date()) {
  const weekKey = getRewardWeekStartKey(now);
  const qualifiedNodeIds = new Set();
  submissions.forEach((item) => {
    if (!item || !rewardNodeIdSet.has(String(item.node_id || ''))) {
      return;
    }
    const score = getNumericScore(item.teacher_score);
    if (score === null || score < WEEKLY_BOUNTY_SCORE_THRESHOLD) {
      return;
    }
    if (getRewardWeekStartKey(item.submitted_at) !== weekKey) {
      return;
    }
    qualifiedNodeIds.add(String(item.node_id || ''));
  });
  const qualifiedCount = qualifiedNodeIds.size;
  const claimed = getClaimedWeeklyBountyKeys(student).includes(weekKey);
  const progressPercent = Math.max(0, Math.min(100, Math.round((Math.min(qualifiedCount, WEEKLY_BOUNTY_TARGET_COUNT) / WEEKLY_BOUNTY_TARGET_COUNT) * 100)));
  return {
    week_key: weekKey,
    week_label: formatRewardWeekLabel(weekKey),
    qualified_count: qualifiedCount,
    target_count: WEEKLY_BOUNTY_TARGET_COUNT,
    progress_percent: progressPercent,
    reward_points: WEEKLY_BOUNTY_REWARD_POINTS,
    claimed,
    claimable: qualifiedCount >= WEEKLY_BOUNTY_TARGET_COUNT && !claimed,
    summary_text: rewardNodeIdSet.size
      ? `本周已完成 ${Math.min(qualifiedCount, WEEKLY_BOUNTY_TARGET_COUNT)} / ${WEEKLY_BOUNTY_TARGET_COUNT} 道 ${WEEKLY_BOUNTY_SCORE_THRESHOLD} 分以上题目`
      : '当前还没有配置每周悬赏树任务',
    status_text: !rewardNodeIdSet.size
      ? '未配置'
      : (claimed ? '本周已领取' : (qualifiedCount >= WEEKLY_BOUNTY_TARGET_COUNT ? '已达成，待领取' : '继续挑战')),
  };
}

function buildStreakRewardState(student, options = {}) {
  const now = options.now || new Date();
  const scope = String(options.scope || '').trim().toLowerCase();
  const rewardPoints = Number(options.rewardPoints || 0);
  const scoreThreshold = Number(options.scoreThreshold || 0);
  const label = String(options.label || '').trim() || '连续提交挑战';
  const rawTargetDays = Number(options.targetDays || 0);
  const targetDays = scope === 'month'
    ? Math.min(rawTargetDays || MONTHLY_STREAK_TARGET_DAYS, getDaysInRewardMonth(now))
    : rawTargetDays;
  const periodKey = scope === 'week'
    ? getRewardWeekStartKey(now)
    : (scope === 'month' ? getRewardMonthKey(now) : '');
  const periodLabel = scope === 'week'
    ? formatRewardWeekLabel(periodKey)
    : (scope === 'month' ? formatRewardMonthLabel(periodKey) : label);
  const claimedKeys = scope === 'week'
    ? getClaimedWeeklyStreakKeys(student)
    : (scope === 'month' ? getClaimedMonthlyStreakKeys(student) : []);
  const dateKeys = buildQualifyingRewardDateKeys(options.submissions || [], scoreThreshold, {
    ...(options.filterOptions || {}),
    scope,
    now,
  });
  const streak = summarizeRewardStreak(dateKeys, targetDays, now);
  const claimed = periodKey ? claimedKeys.includes(periodKey) : false;
  const claimable = streak.achievedCount > 0 && !claimed;
  return {
    label,
    period_key: periodKey,
    period_label: periodLabel,
    current_days: streak.currentDays,
    target_days: targetDays,
    progress_percent: streak.progressPercent,
    reward_points: rewardPoints,
    score_threshold: scoreThreshold,
    achieved_count: streak.achievedCount,
    claimed_count: claimed ? 1 : 0,
    claimable_count: claimable ? 1 : 0,
    claimable,
    claimed,
    latest_qualified_date: formatRewardDateLabel(streak.latestQualifiedDateKey),
    summary_text: streak.currentDays
      ? `${periodLabel}内已连续 ${streak.currentDays} 天提交 ${scoreThreshold} 分及以上题目`
      : `${periodLabel}内连续 ${targetDays} 天每天提交 ${scoreThreshold} 分及以上题目即可领取积分`,
    status_text: claimable
      ? '已达成，待领取'
      : (claimed ? `${periodLabel}已领取` : '未达成'),
  };
}

function buildRewardCenterState(student, trees = [], nodes = [], submissions = []) {
  const rewardTree = trees.find((item) => String(item.system_key || '') === SPECIAL_TREE_KEYS.reward) || null;
  const nodesByTree = groupNodesByTree(nodes);
  const rewardNodeIdSet = new Set(
    rewardTree
      ? sortNodes(nodesByTree.get(rewardTree._id) || []).map((item) => String(item._id))
      : [],
  );
  const levelRewards = buildLevelRewardState(student);
  const weeklyBounty = buildWeeklyBountyState(student, rewardNodeIdSet, submissions);
  const weeklyStreak = buildStreakRewardState(student, {
    label: '连续 7 天挑战',
    scope: 'week',
    submissions,
    targetDays: WEEKLY_STREAK_TARGET_DAYS,
    rewardPoints: WEEKLY_STREAK_REWARD_POINTS,
    scoreThreshold: WEEKLY_STREAK_SCORE_THRESHOLD,
  });
  const monthlyStreak = buildStreakRewardState(student, {
    label: '连续 30 天挑战',
    scope: 'month',
    submissions,
    targetDays: MONTHLY_STREAK_TARGET_DAYS,
    rewardPoints: MONTHLY_STREAK_REWARD_POINTS,
    scoreThreshold: MONTHLY_STREAK_SCORE_THRESHOLD,
  });
  const progressSummary = buildLearningTreeProgressSummary(student, trees, nodes, submissions);
  const learningCurrentScore = Number(progressSummary.totalCurrentScore || 0);
  const learningTotalScore = Number(progressSummary.totalTotalScore || 0);
  const learningProgressPercent = learningTotalScore > 0
    ? Math.max(0, Math.min(100, Math.round((learningCurrentScore / learningTotalScore) * 100)))
    : 0;
  const claimableRewardCount = levelRewards.claimable_count
    + (weeklyBounty.claimable ? 1 : 0)
    + weeklyStreak.claimable_count
    + monthlyStreak.claimable_count;
  const claimableTotalPoints = levelRewards.total_claimable_points
    + (weeklyBounty.claimable ? WEEKLY_BOUNTY_REWARD_POINTS : 0)
    + (weeklyStreak.claimable_count * WEEKLY_STREAK_REWARD_POINTS)
    + (monthlyStreak.claimable_count * MONTHLY_STREAK_REWARD_POINTS);

  return {
    student: toStudentOutput(student),
    pet_summary: petSystem.buildPetSummaryState(student),
    learning_progress: {
      current_score: learningCurrentScore,
      total_score: learningTotalScore,
      progress_percent: learningProgressPercent,
    },
    weekly_bounty: weeklyBounty,
    weekly_streak: weeklyStreak,
    monthly_streak: monthlyStreak,
    level_rewards: levelRewards,
    claimable_reward_count: claimableRewardCount,
    claimable_total_points: claimableTotalPoints,
  };
}

async function buildShareCardResponse(snapshot) {
  const imageMap = await resolveSubmissionImageOutputMap([snapshot]);
  const imageItems = imageMap.get(String(snapshot._id)) || [];
  return {
    id: snapshot._id,
    path: `/pages/trees/trees?shareId=${snapshot._id}`,
    card: buildShareCardOutput(snapshot, imageItems),
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

  const [salt, digestHex] = passwordHash.split(':');
  const expected = Buffer.from(digestHex, 'hex');
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
  } catch (_error) {
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

function getBearerToken(headers = {}) {
  const authHeader = headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return '';
  }
  return authHeader.slice(7);
}

function cleanUndefined(payload = {}) {
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function toPositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return 0;
  }
  return num;
}

function getStudentManualLevelOverride(item) {
  const raw = item && item.manual_level_override;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function hasStudentManualLevelOverride(item) {
  return getStudentManualLevelOverride(item) !== null;
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

function createUnboundWechatOpenId() {
  return `${UNBOUND_WECHAT_OPENID_PREFIX}${Date.now().toString(36)}:${crypto.randomBytes(8).toString('hex')}`;
}

function isUnboundWechatOpenId(value) {
  return typeof value === 'string' && value.startsWith(UNBOUND_WECHAT_OPENID_PREFIX);
}

function presentWechatOpenId(value) {
  if (!value || isUnboundWechatOpenId(value)) {
    return null;
  }
  return value;
}

function sortByCreatedDesc(a, b) {
  return String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || String(b._id || '').localeCompare(String(a._id || ''));
}

function sortNodes(nodes = []) {
  return [...nodes].sort((left, right) => {
    const leftRoot = left.parent_id ? 1 : 0;
    const rightRoot = right.parent_id ? 1 : 0;
    return leftRoot - rightRoot
      || Number(left.sort_order || 0) - Number(right.sort_order || 0)
      || String(left._id || '').localeCompare(String(right._id || ''));
  });
}

function sortSubmissionsDesc(items = []) {
  return [...items].sort((left, right) => {
    return String(right.submitted_at || '').localeCompare(String(left.submitted_at || ''))
      || String(right._id || '').localeCompare(String(left._id || ''));
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

async function findLatestSubmissionForStudentNode(studentId, nodeId) {
  const submissions = await findDocs(COLLECTIONS.submissions, {
    student_id: studentId,
    node_id: nodeId,
  });
  return sortSubmissionsDesc(submissions)[0] || null;
}

async function fetchAll(queryFactory) {
  const results = [];
  let skip = 0;

  while (true) {
    const query = queryFactory().skip(skip).limit(MAX_QUERY_BATCH);
    const { data = [] } = await query.get();
    results.push(...data);
    if (data.length < MAX_QUERY_BATCH) {
      break;
    }
    skip += data.length;
  }

  return results;
}

async function getCollectionCount(collectionName) {
  const { total = 0 } = await db.collection(collectionName).count();
  return total;
}

async function getDocById(collectionName, id) {
  if (!id) {
    return null;
  }

  try {
    const result = await db.collection(collectionName).doc(String(id)).get();
    return result.data || null;
  } catch (_error) {
    return null;
  }
}

async function getAllDocs(collectionName) {
  return fetchAll(() => db.collection(collectionName));
}

async function findDocs(collectionName, where = {}) {
  const conditions = cleanUndefined(where);
  return fetchAll(() => db.collection(collectionName).where(conditions));
}

async function findFirstDoc(collectionName, where = {}) {
  const result = await db.collection(collectionName).where(cleanUndefined(where)).limit(1).get();
  return (result.data || [])[0] || null;
}

async function findDocsByIn(collectionName, fieldName, ids = []) {
  const filtered = [...new Set(ids.filter(Boolean).map((item) => String(item)))];
  if (!filtered.length) {
    return [];
  }

  const results = [];
  for (let index = 0; index < filtered.length; index += MAX_QUERY_BATCH) {
    const chunk = filtered.slice(index, index + MAX_QUERY_BATCH);
    const docs = await findDocs(collectionName, {
      [fieldName]: command.in(chunk),
    });
    results.push(...docs);
  }

  return results;
}

async function addDoc(collectionName, payload) {
  const data = cleanUndefined(payload);
  const result = await db.collection(collectionName).add({ data });
  return getDocById(collectionName, result._id);
}

async function updateDoc(collectionName, id, payload) {
  const data = cleanUndefined(payload);
  await db.collection(collectionName).doc(String(id)).update({ data });
  return getDocById(collectionName, id);
}

async function ensureCollectionExists(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
    return true;
  } catch (_error) {
    if (typeof db.createCollection === 'function') {
      try {
        await db.createCollection(collectionName);
        return true;
      } catch (_createError) {
      }
    }
    return false;
  }
}

async function deleteDoc(collectionName, id) {
  await db.collection(collectionName).doc(String(id)).remove();
}

async function deleteDocsByIds(collectionName, ids = []) {
  const filtered = [...new Set(ids.filter(Boolean).map((item) => String(item)))];
  for (const id of filtered) {
    await deleteDoc(collectionName, id);
  }
}

function replaceDocInList(list, nextDoc) {
  const index = list.findIndex((item) => item._id === nextDoc._id);
  if (index >= 0) {
    list[index] = nextDoc;
  } else {
    list.push(nextDoc);
  }
}

async function ensureSpecialTrees() {
  const now = toIsoString();
  const [trees, nodes] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
  ]);
  const activeSystemTreeKeys = new Set(SPECIAL_TREE_SPECS.map((item) => item.systemKey));
  const legacySystemTrees = trees.filter((item) => item.system_key && !activeSystemTreeKeys.has(item.system_key));

  for (const tree of legacySystemTrees) {
    const nextTree = await updateDoc(COLLECTIONS.trees, tree._id, {
      system_key: '',
      tree_type: '',
      updated_at: now,
    });
    replaceDocInList(trees, nextTree);

    const treeNodes = nodes.filter((item) => item.tree_id === tree._id);
    for (const node of treeNodes) {
      if (!node.system_key || !String(node.system_key).trim()) {
        continue;
      }
      const nextNode = await updateDoc(COLLECTIONS.nodes, node._id, {
        system_key: '',
        updated_at: now,
      });
      replaceDocInList(nodes, nextNode);
    }
  }

  for (const spec of SPECIAL_TREE_SPECS) {
    let tree = trees.find((item) => item.system_key === spec.systemKey)
      || trees.find((item) => item.title === spec.title);

    if (!tree) {
      tree = await addDoc(COLLECTIONS.trees, {
        system_key: spec.systemKey,
        tree_type: spec.treeType,
        title: spec.title,
        chapter_desc: spec.chapterDesc || '',
        created_at: now,
        updated_at: now,
      });
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
        tree = await updateDoc(COLLECTIONS.trees, tree._id, {
          ...treePatch,
          updated_at: now,
        });
        replaceDocInList(trees, tree);
      }
    }

    const treeNodes = nodes.filter((item) => item.tree_id === tree._id);
    let root = treeNodes.find((item) => item.system_key === spec.root.systemKey)
      || treeNodes.find((item) => item.parent_id === null);

    if (!root) {
      root = await addDoc(COLLECTIONS.nodes, {
        tree_id: tree._id,
        parent_id: null,
        system_key: spec.root.systemKey,
        name: spec.root.name,
        sort_order: 0,
        created_at: now,
        updated_at: now,
      });
      nodes.push(root);
      treeNodes.push(root);
    } else {
      const rootPatch = {};
      if (root.system_key !== spec.root.systemKey) {
        rootPatch.system_key = spec.root.systemKey;
      }
      if (root.tree_id !== tree._id) {
        rootPatch.tree_id = tree._id;
      }
      if (root.parent_id !== null) {
        rootPatch.parent_id = null;
      }
      if (Object.keys(rootPatch).length) {
        root = await updateDoc(COLLECTIONS.nodes, root._id, {
          ...rootPatch,
          updated_at: now,
        });
        replaceDocInList(nodes, root);
        replaceDocInList(treeNodes, root);
      }
    }

    const legacySystemChildren = treeNodes.filter((item) => (
      item._id !== root._id
      && item.system_key
      && String(item.system_key).trim()
    ));
    for (const child of legacySystemChildren) {
      const nextChild = await updateDoc(COLLECTIONS.nodes, child._id, {
        system_key: '',
        updated_at: now,
      });
      replaceDocInList(nodes, nextChild);
      replaceDocInList(treeNodes, nextChild);
    }
  }
}

function toTeacherOutput(item) {
  return {
    id: item._id,
    username: item.username,
    created_at: item.created_at,
  };
}

function toStudentOutput(item) {
  return {
    id: item._id,
    username: item.username,
    name: item.name || '',
    level: getStudentLevel(item),
    total_points: getStudentTotalPoints(item),
    manual_level_override_active: hasStudentManualLevelOverride(item),
    wechat_openid: presentWechatOpenId(item.wechat_openid),
    created_at: item.created_at,
  };
}

function toTreeOutput(item) {
  return {
    id: item._id,
    title: item.title,
    chapter_desc: item.chapter_desc || '',
    system_key: item.system_key || '',
    tree_type: item.tree_type || '',
    created_at: item.created_at,
  };
}

function getProblemAttachmentKindFromMimeType(mimeType = '') {
  const value = String(mimeType || '').toLowerCase();
  if (value === 'application/pdf') {
    return 'pdf';
  }
  if (value.startsWith('image/')) {
    return 'image';
  }
  return '';
}

function normalizeStoredProblemAttachmentRecord(raw = {}) {
  const normalized = normalizeStoredFileReference(raw);
  if (!normalized) {
    return null;
  }
  const fileName = String(normalized.file_name || raw.file_name || raw.fileName || 'attachment').trim() || 'attachment';
  const displayName = String(raw.display_name || raw.displayName || fileName).trim() || fileName;
  return {
    ...normalized,
    file_name: fileName,
    display_name: displayName,
  };
}

function getStoredProblemAttachments(item = {}) {
  const normalized = (Array.isArray(item.problem_attachments) ? item.problem_attachments : [])
    .map((attachment) => normalizeStoredProblemAttachmentRecord(attachment))
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }

  const legacyFileId = String(item.problem_attachment_file_id || '').trim();
  if (!legacyFileId) {
    return [];
  }

  return [normalizeStoredProblemAttachmentRecord({
    file_id: legacyFileId,
    file_name: item.problem_attachment_file_name || 'attachment',
    mime_type: item.problem_attachment_mime_type || '',
    display_name: item.problem_attachment_display_name || item.problem_attachment_file_name || '题目资料',
  })].filter(Boolean);
}

function toProblemAttachmentOutput(attachment, url = '') {
  return {
    file_id: attachment.file_id,
    file_name: attachment.file_name,
    display_name: attachment.display_name || attachment.file_name,
    mime_type: attachment.mime_type || '',
    kind: getProblemAttachmentKindFromMimeType(attachment.mime_type || ''),
    url,
  };
}

function buildLegacyProblemAttachmentFields(attachments = []) {
  const first = attachments[0] || null;
  return {
    problem_attachment_file_id: first ? first.file_id : '',
    problem_attachment_file_name: first ? first.file_name : '',
    problem_attachment_mime_type: first ? first.mime_type : '',
    problem_attachment_display_name: first ? first.display_name : '',
  };
}

function toNodeOutput(item, problemAttachments = []) {
  const firstAttachment = problemAttachments[0] || null;
  return {
    id: item._id,
    tree_id: item.tree_id,
    parent_id: item.parent_id || null,
    system_key: item.system_key || '',
    milestone_level: Number(item.milestone_level || 0),
    required_level: Number(item.required_level || 0),
    unlock_prerequisites: getNodeUnlockPrerequisites(item),
    unlock_prerequisite_mode: getNodeUnlockPrerequisiteMode(item),
    problem_attachments: problemAttachments,
    problem_attachment_file_name: firstAttachment ? firstAttachment.file_name : '',
    problem_attachment_display_name: firstAttachment ? firstAttachment.display_name : '',
    problem_attachment_mime_type: firstAttachment ? firstAttachment.mime_type : '',
    problem_attachment_kind: firstAttachment ? firstAttachment.kind : '',
    problem_attachment_url: firstAttachment ? firstAttachment.url : '',
    name: item.name,
    sort_order: Number(item.sort_order || 0),
    created_at: item.created_at,
  };
}

function toScoreOutput(item) {
  return {
    id: item._id,
    student_id: item.student_id,
    node_id: item.node_id,
    score: item.score === undefined ? null : item.score,
    comment: item.comment || '',
    updated_at: item.updated_at,
  };
}

function getFileExtensionFromName(fileName = '') {
  const raw = String(fileName || '').split(/[\/]/).pop() || '';
  const matched = raw.toLowerCase().match(/\.([a-z0-9]+)$/);
  return matched ? matched[1] : '';
}

function inferSubmissionMimeType(fileName = '') {
  const ext = getFileExtensionFromName(fileName);
  const mimeByExt = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/plain',
    c: 'text/x-c',
    cc: 'text/x-c++src',
    cpp: 'text/x-c++src',
    cxx: 'text/x-c++src',
    h: 'text/x-c',
    hh: 'text/x-c++hdr',
    hpp: 'text/x-c++hdr',
    hxx: 'text/x-c++hdr',
    py: 'text/x-python',
    java: 'text/x-java-source',
    go: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
  };
  return mimeByExt[ext] || '';
}

function getSubmissionFileKind(fileName = '', mimeType = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime === 'application/pdf') {
    return 'pdf';
  }

  const ext = getFileExtensionFromName(fileName);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  return 'file';
}

function isSubmissionImageFile(fileName = '', mimeType = '') {
  return getSubmissionFileKind(fileName, mimeType) === 'image';
}

function normalizeStoredSubmissionFileRecord(raw = {}) {
  const normalized = normalizeStoredFileReference(raw);
  if (!normalized) {
    return null;
  }
  return {
    ...normalized,
    file_name: String(normalized.file_name || raw.file_name || raw.fileName || 'submission-file').trim() || 'submission-file',
    mime_type: String(normalized.mime_type || raw.mime_type || raw.mimeType || '').trim().toLowerCase(),
  };
}

function getLegacyStoredSubmissionImageFiles(item = {}) {
  const normalized = (Array.isArray(item.code_image_files) ? item.code_image_files : [])
    .map((image) => normalizeStoredSubmissionFileRecord(image))
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }

  const legacyFileId = String(item.code_image_file_id || '').trim();
  if (!legacyFileId) {
    return [];
  }

  return [normalizeStoredSubmissionFileRecord({
    file_id: legacyFileId,
    file_name: item.code_image_file_name || 'submission-image',
    mime_type: item.code_image_mime_type || '',
  })].filter(Boolean);
}

function getStoredSubmissionFiles(item = {}) {
  const normalized = (Array.isArray(item.submission_file_files) ? item.submission_file_files : [])
    .map((file) => normalizeStoredSubmissionFileRecord(file))
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }
  return getLegacyStoredSubmissionImageFiles(item);
}

function getStoredSubmissionImageFiles(item = {}) {
  return getStoredSubmissionFiles(item)
    .filter((file) => isSubmissionImageFile(file.file_name, file.mime_type));
}

function toSubmissionFileOutput(file, url = '') {
  return {
    file_id: file.file_id,
    file_name: file.file_name,
    mime_type: file.mime_type || '',
    url,
    kind: getSubmissionFileKind(file.file_name, file.mime_type),
  };
}

function toSubmissionImageOutput(image, url = '') {
  return toSubmissionFileOutput(image, url);
}

function buildLegacySubmissionImageFields(images = []) {
  const first = images[0] || null;
  return {
    code_image_file_id: first ? first.file_id : '',
    code_image_file_name: first ? first.file_name : '',
    code_image_mime_type: first ? first.mime_type : '',
  };
}

function toSubmissionOutput(item, fileItems = []) {
  const normalizedFiles = Array.isArray(fileItems) ? fileItems : [];
  const imageItems = normalizedFiles.filter((file) => file.kind === 'image');
  return {
    id: item._id,
    student_id: item.student_id,
    node_id: item.node_id,
    code_text: item.code_text || '',
    submission_file_urls: normalizedFiles.map((file) => file.url).filter(Boolean),
    submission_file_items: normalizedFiles,
    code_image_url: imageItems[0] ? imageItems[0].url : '',
    code_image_urls: imageItems.map((image) => image.url).filter(Boolean),
    code_image_items: imageItems,
    submitted_at: item.submitted_at,
    teacher_score: item.teacher_score === undefined ? null : item.teacher_score,
    teacher_comment: item.teacher_comment || '',
    scored_at: item.scored_at || null,
  };
}

async function resolveCloudbaseTempFileUrlMap(fileIds = []) {
  const filtered = [...new Set(fileIds.filter(Boolean))];
  if (!filtered.length) {
    return new Map();
  }

  const { fileList = [] } = await cloud.getTempFileURL({
    fileList: filtered,
  });

  return new Map(fileList.map((item) => [item.fileID, item.tempFileURL || '']));
}

async function resolveStoredFileUrlMap(files = []) {
  const normalizedFiles = files
    .map((file) => normalizeStoredFileReference(file))
    .filter(Boolean);
  if (!normalizedFiles.length) {
    return new Map();
  }

  const cloudbaseFiles = normalizedFiles.filter((file) => file.storage_provider !== STORAGE_PROVIDERS.cos);
  const cosFiles = normalizedFiles.filter((file) => file.storage_provider === STORAGE_PROVIDERS.cos);

  const cloudbaseUrlMap = await resolveCloudbaseTempFileUrlMap(cloudbaseFiles.map((file) => file.file_id));
  const cosEntries = await Promise.all(cosFiles.map(async (file) => {
    try {
      return [file.file_id, await getCosFileUrl(file)];
    } catch (_error) {
      return [file.file_id, ''];
    }
  }));

  return new Map([
    ...cloudbaseUrlMap.entries(),
    ...cosEntries,
  ]);
}

async function resolveProblemAttachmentOutputMap(nodes = []) {
  const attachments = nodes.flatMap((item) => getStoredProblemAttachments(item));
  const urlMap = await resolveStoredFileUrlMap(attachments);

  return new Map(nodes.map((item) => {
    const currentAttachments = getStoredProblemAttachments(item)
      .map((attachment) => toProblemAttachmentOutput(attachment, urlMap.get(attachment.file_id) || ''));
    return [String(item._id || item.id), currentAttachments];
  }));
}

async function decorateNodes(nodes = []) {
  const attachmentByNodeId = await resolveProblemAttachmentOutputMap(nodes);
  return nodes.map((item) => toNodeOutput(item, attachmentByNodeId.get(String(item._id || item.id)) || []));
}

async function resolveSubmissionFileOutputMap(submissions = []) {
  const files = submissions.flatMap((item) => getStoredSubmissionFiles(item));
  const urlMap = await resolveStoredFileUrlMap(files);

  return new Map(submissions.map((item) => {
    const currentFiles = getStoredSubmissionFiles(item)
      .map((file) => toSubmissionFileOutput(file, urlMap.get(file.file_id) || ''));
    return [String(item._id || item.id), currentFiles];
  }));
}

async function resolveSubmissionImageOutputMap(submissions = []) {
  const fileBySubmissionId = await resolveSubmissionFileOutputMap(submissions);
  return new Map(submissions.map((item) => {
    const key = String(item._id || item.id);
    const files = fileBySubmissionId.get(key) || [];
    return [key, files.filter((file) => file.kind === 'image')];
  }));
}

async function decorateSubmissions(submissions = []) {
  const fileBySubmissionId = await resolveSubmissionFileOutputMap(submissions);
  return submissions.map((item) => {
    return toSubmissionOutput(item, fileBySubmissionId.get(String(item._id || item.id)) || []);
  });
}

function normalizeProblemAttachmentPayload(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    throw new AppError(400, '题目附件格式不正确');
  }
  return {
    fileId: raw.fileId ?? raw.file_id,
    base64: raw.base64 ?? raw.dataUrl ?? raw.content ?? raw.fileContent,
    mimeType: raw.mimeType ?? raw.mime_type,
    fileName: raw.fileName ?? raw.file_name,
    displayName: raw.displayName ?? raw.display_name,
  };
}

function normalizeProblemAttachmentsPayload(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => normalizeProblemAttachmentPayload(item)).filter(Boolean);
  }
  const payload = normalizeProblemAttachmentPayload(raw);
  return payload ? [payload] : [];
}

function sanitizeStoredFileName(fileName, fallbackBaseName, fallbackExt) {
  const raw = String(fileName || '').split(/[\/]/).pop() || '';
  const cleaned = raw
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '');
  const withoutExt = cleaned.replace(/\.[^.]+$/, '') || fallbackBaseName;
  return `${withoutExt}.${fallbackExt}`;
}

function parseProblemAttachment(attachment) {
  const payload = normalizeProblemAttachmentPayload(attachment);
  if (!payload || !payload.base64) {
    return null;
  }

  const originalFileName = normalizeString(payload.fileName, '题目附件文件名', { required: true, maxLength: 200 });
  const displayName = normalizeString(payload.displayName, '题目附件名称', { maxLength: 120 }) || originalFileName;
  let raw = normalizeString(payload.base64, '题目附件内容', { required: true, maxLength: 20 * 1024 * 1024 });
  let mime = normalizeString(payload.mimeType, '题目附件类型', { required: true, maxLength: 120 }).toLowerCase();
  const dataUrlMatch = raw.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);

  if (dataUrlMatch) {
    if (!mime) {
      mime = dataUrlMatch[1].toLowerCase();
    }
    raw = dataUrlMatch[2];
  }

  const extMap = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
  };
  const ext = extMap[mime];
  if (!ext) {
    throw new AppError(400, '题目附件仅支持 PDF、PNG、JPEG、WEBP');
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new AppError(400, '题目附件 base64 格式不正确');
  }

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new AppError(400, '题目附件内容为空');
  }
  if (buffer.length > MAX_PROBLEM_ATTACHMENT_BYTES) {
    throw new AppError(400, '题目附件大小不能超过 10MB');
  }

  const safeFileName = sanitizeStoredFileName(originalFileName, 'attachment', ext);
  return {
    buffer,
    fileName: safeFileName,
    mimeType: mime,
    displayName,
  };
}

async function saveProblemAttachment(attachment, treeId, nodeId = '') {
  const parsed = parseProblemAttachment(attachment);
  if (!parsed) {
    return null;
  }

  const objectKey = [
    PROBLEM_ATTACHMENT_PREFIX,
    String(treeId || 'common'),
    String(nodeId || 'unassigned'),
    `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${parsed.fileName}`,
  ].join('/');

  await uploadBufferToCos(objectKey, parsed.buffer, parsed.mimeType);

  return buildCosStoredFileRecord(parsed.fileName, parsed.mimeType, objectKey, {
    display_name: parsed.displayName,
  });
}

async function persistProblemAttachments(attachments = [], treeId, nodeId = '', existingAttachments = []) {
  const normalized = normalizeProblemAttachmentsPayload(attachments);
  const existingByFileId = new Map(existingAttachments.map((attachment) => [attachment.file_id, attachment]));
  const nextAttachments = [];
  const uploadedFileIds = [];

  try {
    for (const attachment of normalized) {
      if (attachment.base64) {
        const saved = await saveProblemAttachment(attachment, treeId, nodeId);
        if (saved) {
          nextAttachments.push(saved);
          uploadedFileIds.push(saved.file_id);
        }
        continue;
      }

      const fileId = normalizeString(attachment.fileId, '题目附件 ID', { required: true, maxLength: 500 });
      const existing = existingByFileId.get(fileId);
      if (!existing) {
        throw new AppError(400, '题目附件引用不合法');
      }
      nextAttachments.push({
        ...existing,
        display_name: normalizeString(attachment.displayName, '题目附件名称', { maxLength: 120 }) || existing.display_name || existing.file_name,
      });
    }
  } catch (error) {
    if (uploadedFileIds.length) {
      await deleteCloudFiles(uploadedFileIds);
    }
    throw error;
  }

  return nextAttachments;
}

async function deleteCloudFiles(fileIds = []) {
  const normalizedFiles = fileIds
    .map((file) => normalizeStoredFileReference(file))
    .filter(Boolean);
  if (!normalizedFiles.length) {
    return;
  }

  const cloudbaseFileIds = [...new Set(
    normalizedFiles
      .filter((file) => file.storage_provider !== STORAGE_PROVIDERS.cos)
      .map((file) => file.file_id)
      .filter(Boolean)
  )];
  const cosFiles = normalizedFiles.filter((file) => file.storage_provider === STORAGE_PROVIDERS.cos);

  if (cloudbaseFileIds.length) {
    try {
      await cloud.deleteFile({
        fileList: cloudbaseFileIds,
      });
    } catch (_error) {
    }
  }

  if (cosFiles.length) {
    await deleteCosFiles(cosFiles);
  }
}

async function deleteProblemAttachmentFiles(nodes = []) {
  await deleteCloudFiles(nodes.flatMap((item) => getStoredProblemAttachments(item)));
}

function normalizeSubmissionFilePayload(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    throw new AppError(400, '提交附件格式不正确');
  }
  return {
    base64: raw.base64 ?? raw.dataUrl ?? raw.content ?? raw.fileContent,
    mimeType: raw.mimeType ?? raw.mime_type,
    fileName: raw.fileName ?? raw.file_name,
  };
}

function normalizeSubmissionFilePayloads(body = {}) {
  const items = [];
  const appendRaw = (raw) => {
    const normalized = normalizeSubmissionFilePayload(raw);
    if (normalized) {
      items.push(normalized);
    }
  };

  if (Array.isArray(body.fileItems)) {
    body.fileItems.forEach((item) => appendRaw(item));
  } else if (body.fileItems && typeof body.fileItems === 'object') {
    appendRaw(body.fileItems);
  }

  if (Array.isArray(body.imageItems)) {
    body.imageItems.forEach((item) => appendRaw(item));
  } else if (body.imageItems && typeof body.imageItems === 'object') {
    appendRaw(body.imageItems);
  }

  if (body.imageBase64) {
    appendRaw({
      base64: body.imageBase64,
      mimeType: body.imageMimeType,
      fileName: body.imageFileName,
    });
  }

  return items;
}

function buildSubmissionStoredFileName(originalFileName, fallbackBaseName, mimeType, defaultExt = 'bin') {
  const extFromName = getFileExtensionFromName(originalFileName);
  const inferredMime = String(mimeType || '').trim().toLowerCase() || inferSubmissionMimeType(originalFileName);
  const extMap = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'text/javascript': 'js',
    'text/x-c': 'c',
    'text/x-c++src': 'cpp',
    'text/x-c++hdr': 'hpp',
    'text/x-python': 'py',
    'text/x-java-source': 'java',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip',
    'application/vnd.rar': 'rar',
    'application/x-7z-compressed': '7z',
  };
  const ext = extFromName || extMap[inferredMime] || defaultExt;
  return sanitizeStoredFileName(originalFileName, fallbackBaseName, ext);
}

function parseSubmissionFile(file, index = 0) {
  const payload = normalizeSubmissionFilePayload(file);
  if (!payload) {
    return null;
  }

  const fallbackName = `submission-file-${index + 1}.bin`;
  const originalFileName = normalizeString(payload.fileName, '附件文件名', { maxLength: 200 }) || fallbackName;
  let raw = normalizeString(payload.base64, '附件内容', { required: true, maxLength: 24 * 1024 * 1024 });
  let mime = normalizeString(payload.mimeType, '附件类型', { maxLength: 160 }).toLowerCase();
  const dataUrlMatch = raw.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);

  if (dataUrlMatch) {
    if (!mime) {
      mime = dataUrlMatch[1].toLowerCase();
    }
    raw = dataUrlMatch[2];
  }

  mime = mime || inferSubmissionMimeType(originalFileName) || 'application/octet-stream';

  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new AppError(400, '附件 base64 格式不正确');
  }

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new AppError(400, '附件内容为空');
  }

  const isImage = isSubmissionImageFile(originalFileName, mime);
  if (isImage && buffer.length > MAX_CODE_IMAGE_BYTES) {
    throw new AppError(400, '图片大小不能超过 5MB');
  }
  if (buffer.length > MAX_SUBMISSION_FILE_BYTES) {
    throw new AppError(400, '附件大小不能超过 10MB');
  }

  return {
    buffer,
    fileName: buildSubmissionStoredFileName(originalFileName, isImage ? `submission-image-${index + 1}` : `submission-file-${index + 1}`, mime),
    mimeType: mime,
  };
}

async function saveSubmissionFile(file, studentId, nodeId, index = 0) {
  const parsed = parseSubmissionFile(file, index);
  if (!parsed) {
    return null;
  }

  const objectKey = [
    SUBMISSION_FILE_PREFIX,
    String(studentId),
    String(nodeId),
    `${Date.now()}-${index + 1}-${crypto.randomBytes(6).toString('hex')}-${parsed.fileName}`,
  ].join('/');

  await uploadBufferToCos(objectKey, parsed.buffer, parsed.mimeType);

  return buildCosStoredFileRecord(parsed.fileName, parsed.mimeType, objectKey);
}

async function saveSubmissionFiles(files = [], studentId, nodeId) {
  const normalized = normalizeSubmissionFilePayloads({ fileItems: files });
  const savedFiles = [];
  const uploadedFileIds = [];

  try {
    for (let index = 0; index < normalized.length; index += 1) {
      const saved = await saveSubmissionFile(normalized[index], studentId, nodeId, index);
      if (saved) {
        savedFiles.push(saved);
        uploadedFileIds.push(saved.file_id);
      }
    }
  } catch (error) {
    if (uploadedFileIds.length) {
      await deleteCloudFiles(uploadedFileIds);
    }
    throw error;
  }

  return savedFiles;
}

const PET_FRAME_STATE_CONFIG = Array.isArray(petSystem.PET_VISUAL_STATES) && petSystem.PET_VISUAL_STATES.length
  ? petSystem.PET_VISUAL_STATES
  : [
    { key: 'hungry', title: '饥寒交迫' },
    { key: 'gloomy', title: '郁闷' },
    { key: 'happy', title: '开心' },
    { key: 'super_happy', title: '超级开心' },
  ];
const PET_FRAME_STATE_KEYS = PET_FRAME_STATE_CONFIG.map((item) => item.key);
const PET_FRAME_STATE_LABEL_BY_KEY = new Map(PET_FRAME_STATE_CONFIG.map((item) => [item.key, item.title]));

function buildEmptyPetFrameSequenceMap() {
  return PET_FRAME_STATE_KEYS.reduce((result, key) => {
    result[key] = [];
    return result;
  }, {});
}

function normalizePetFrameStateKey(raw) {
  const value = String(raw || '').trim();
  if (!PET_FRAME_STATE_KEYS.includes(value)) {
    throw new AppError(400, '宠物状态不正确');
  }
  return value;
}

function normalizePetFramePayload(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    throw new AppError(400, '宠物帧格式不正确');
  }
  return {
    base64: raw.base64 ?? raw.dataUrl ?? raw.content ?? raw.fileContent,
    mimeType: raw.mimeType ?? raw.mime_type,
    fileName: raw.fileName ?? raw.file_name,
  };
}

function normalizePetFramePayloads(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => normalizePetFramePayload(item)).filter(Boolean);
  }
  const payload = normalizePetFramePayload(raw);
  return payload ? [payload] : [];
}

function parsePetFrame(frame, index = 0) {
  const payload = normalizePetFramePayload(frame);
  if (!payload || !payload.base64) {
    return null;
  }

  const fallbackName = `pet-frame-${index + 1}.png`;
  const originalFileName = normalizeString(payload.fileName, '宠物帧文件名', { maxLength: 200 }) || fallbackName;
  let raw = normalizeString(payload.base64, '宠物帧内容', { required: true, maxLength: 24 * 1024 * 1024 });
  let mime = normalizeString(payload.mimeType, '宠物帧类型', { maxLength: 160 }).toLowerCase();
  const dataUrlMatch = raw.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);

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
    throw new AppError(400, '宠物帧仅支持 PNG、JPEG、WEBP');
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new AppError(400, '宠物帧 base64 格式不正确');
  }

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new AppError(400, '宠物帧内容为空');
  }
  if (buffer.length > MAX_CODE_IMAGE_BYTES) {
    throw new AppError(400, '宠物帧大小不能超过 5MB');
  }

  return {
    buffer,
    fileName: sanitizeStoredFileName(originalFileName, `pet-frame-${index + 1}`, ext),
    mimeType: mime,
  };
}

async function savePetFrame(frame, studentId, stateKey, index = 0) {
  const parsed = parsePetFrame(frame, index);
  if (!parsed) {
    return null;
  }

  const objectKey = [
    PET_FRAME_PREFIX,
    String(studentId),
    String(stateKey),
    `${Date.now()}-${index + 1}-${crypto.randomBytes(6).toString('hex')}-${parsed.fileName}`,
  ].join('/');

  await uploadBufferToCos(objectKey, parsed.buffer, parsed.mimeType);
  return buildCosStoredFileRecord(parsed.fileName, parsed.mimeType, objectKey);
}

async function savePetFrames(frames = [], studentId, stateKey) {
  const normalized = normalizePetFramePayloads(frames);
  const savedFiles = [];
  const uploadedFileIds = [];

  try {
    for (let index = 0; index < normalized.length; index += 1) {
      const saved = await savePetFrame(normalized[index], studentId, stateKey, index);
      if (saved) {
        savedFiles.push(saved);
        uploadedFileIds.push(saved.file_id);
      }
    }
  } catch (error) {
    if (uploadedFileIds.length) {
      await deleteCloudFiles(uploadedFileIds);
    }
    throw error;
  }

  return savedFiles.map((item) => item.file_id);
}

function normalizePetFrameSequence(raw = []) {
  const source = Array.isArray(raw) ? raw : [];
  const result = [];
  const seen = new Set();

  source.forEach((item) => {
    const normalized = normalizeStoredFileReference(item);
    const fileId = normalized
      ? String(normalized.file_id || '').trim()
      : String(item || '').trim();
    if (!fileId || seen.has(fileId)) {
      return;
    }
    seen.add(fileId);
    result.push(fileId);
  });

  return result;
}

function getStudentPetFrameSequences(student = {}) {
  const petProfile = student && typeof student.pet_profile === 'object' && student.pet_profile
    ? student.pet_profile
    : {};
  const rawSequences = petProfile && typeof petProfile.frame_sequences === 'object' && petProfile.frame_sequences
    ? petProfile.frame_sequences
    : {};
  const result = buildEmptyPetFrameSequenceMap();

  PET_FRAME_STATE_KEYS.forEach((key) => {
    result[key] = normalizePetFrameSequence(rawSequences[key]);
  });

  return result;
}

function getStoredFileDisplayName(file, fallback = 'frame.png') {
  const normalized = normalizeStoredFileReference(file);
  if (!normalized) {
    return fallback;
  }
  const directName = String(normalized.file_name || '').trim();
  if (directName) {
    return directName;
  }
  if (normalized.cos_key) {
    const tail = String(normalized.cos_key).split('/').pop();
    if (tail) {
      return tail;
    }
  }
  const tail = String(normalized.file_id || '').split('/').pop();
  return tail || fallback;
}

function toPetFrameOutput(file, url = '', index = 0, stateKey = '') {
  const normalized = normalizeStoredFileReference(file);
  if (!normalized) {
    return null;
  }
  const fileName = getStoredFileDisplayName(normalized, `${stateKey || 'frame'}-${index + 1}.png`);
  return {
    file_id: normalized.file_id,
    file_name: fileName,
    mime_type: normalized.mime_type || inferSubmissionMimeType(fileName) || 'image/png',
    order: index + 1,
    url,
  };
}

async function resolvePetFrameSequenceOutput(sequence = [], stateKey = '') {
  const normalizedFiles = sequence
    .map((item) => normalizeStoredFileReference(item))
    .filter(Boolean);
  const urlMap = await resolveStoredFileUrlMap(normalizedFiles);

  return normalizedFiles
    .map((file, index) => toPetFrameOutput(file, urlMap.get(file.file_id) || '', index, stateKey))
    .filter(Boolean);
}

async function buildStudentPetFrameOutput(student) {
  const sequences = getStudentPetFrameSequences(student);
  const result = buildEmptyPetFrameSequenceMap();

  for (const stateKey of PET_FRAME_STATE_KEYS) {
    result[stateKey] = await resolvePetFrameSequenceOutput(sequences[stateKey], stateKey);
  }

  return result;
}

async function buildStudentPetCenterOutput(student) {
  const petCenter = petSystem.buildPetCenterState(student);
  const frameOutputByState = await buildStudentPetFrameOutput(student);
  const frameUrlsByState = buildEmptyPetFrameSequenceMap();

  PET_FRAME_STATE_KEYS.forEach((stateKey) => {
    frameUrlsByState[stateKey] = (frameOutputByState[stateKey] || [])
      .map((item) => String(item.url || '').trim())
      .filter(Boolean);
  });

  const activeStateKey = PET_FRAME_STATE_KEYS.includes(String(petCenter.pet.visual_state || '').trim())
    ? String(petCenter.pet.visual_state || '').trim()
    : 'happy';

  petCenter.pet.frame_sequences = frameUrlsByState;
  petCenter.pet.frame_sequence_items = frameOutputByState;
  petCenter.pet.active_frames = frameUrlsByState[activeStateKey] || [];
  petCenter.pet.active_frame_items = frameOutputByState[activeStateKey] || [];
  petCenter.pet.active_frame_count = petCenter.pet.active_frames.length;
  petCenter.pet.visual_options = (petCenter.pet.visual_options || []).map((item) => ({
    ...item,
    frame_count: Number((frameOutputByState[item.key] || []).length || 0),
    has_frames: Number((frameOutputByState[item.key] || []).length || 0) > 0,
  }));

  return petCenter;
}

async function deleteSubmissionRecords(submissions = []) {
  if (!submissions.length) {
    return;
  }

  await deleteCloudFiles(submissions.flatMap((item) => getStoredSubmissionFiles(item)));
  await deleteDocsByIds(COLLECTIONS.submissions, submissions.map((item) => item._id));
}

async function ensureTeacherAuth(request) {
  const token = getBearerToken(request.headers);
  const payload = verifyAuthToken(token, 'teacher');
  if (!payload) {
    throw new AppError(401, '老师未登录');
  }

  const teacher = await getDocById(COLLECTIONS.teachers, payload.u);
  if (!teacher) {
    throw new AppError(401, '老师会话已失效');
  }

  return teacher;
}

async function resolveStudentByTokenOrOpenId(request) {
  const token = getBearerToken(request.headers);
  if (token) {
    const payload = verifyAuthToken(token, 'student');
    if (!payload) {
      throw new AppError(401, '学生未登录');
    }

    const student = await getDocById(COLLECTIONS.students, payload.u);
    if (!student) {
      throw new AppError(401, '学生会话已失效');
    }
    return student;
  }

  if (request.openid) {
    const student = await findFirstDoc(COLLECTIONS.students, {
      wechat_openid: request.openid,
    });
    if (student) {
      return student;
    }
  }

  throw new AppError(401, '学生未登录');
}

async function ensureTeacherUsernameAvailable(username, excludeId = null) {
  const duplicated = await findFirstDoc(COLLECTIONS.teachers, { username });
  if (duplicated && duplicated._id !== excludeId) {
    throw new AppError(409, '老师用户名已存在');
  }
}

async function ensureStudentUsernameAvailable(username, excludeId = null) {
  const duplicated = await findFirstDoc(COLLECTIONS.students, { username });
  if (duplicated && duplicated._id !== excludeId) {
    throw new AppError(409, '学生用户名已存在');
  }
}

async function ensureStudentWechatOpenIdAvailable(openid, excludeId = null) {
  if (!openid) {
    return;
  }

  const duplicated = await findFirstDoc(COLLECTIONS.students, { wechat_openid: openid });
  if (duplicated && duplicated._id !== excludeId) {
    throw new AppError(409, '该微信账号已绑定其他学生');
  }
}

function buildTree(
  nodes = [],
  detailByNodeId = new Map(),
  nodeStateByNodeId = new Map(),
  problemAttachmentByNodeId = new Map(),
) {
  const map = new Map();
  let root = null;

  nodes.forEach((item) => {
    const detail = detailByNodeId.get(item._id) || {};
    const state = nodeStateByNodeId.get(item._id) || {};
    const problemAttachments = problemAttachmentByNodeId.get(String(item._id)) || [];
    const fallbackRequiredLevel = Number(item.required_level || 0);
    const requiredLevel = Number(state.requiredLevel ?? fallbackRequiredLevel);
    const baseUnlocked = state.unlocked !== undefined ? !!state.unlocked : requiredLevel <= 0;
    const baseLockedText = state.lockedText || (requiredLevel > 0 ? `达到 ${requiredLevel} 级后解锁` : '');
    const unlockPrerequisiteMode = getNodeUnlockPrerequisiteMode(item);
    map.set(item._id, {
      id: item._id,
      tree_id: item.tree_id,
      parent_id: item.parent_id || null,
      system_key: item.system_key || '',
      milestoneLevel: Number(item.milestone_level || 0),
      requiredLevel,
      name: item.name,
      sort_order: Number(item.sort_order || 0),
      unlockPrerequisiteMode,
      unlockPrerequisites: getNodeUnlockPrerequisites(item),
      score: detail.score ?? null,
      comment: detail.comment || '',
      codeText: detail.codeText || '',
      submissionFileUrls: detail.submissionFileUrls || [],
      submissionFileItems: detail.submissionFileItems || [],
      codeImageUrl: detail.codeImageUrl || '',
      codeImageUrls: detail.codeImageUrls || [],
      codeImageItems: detail.codeImageItems || [],
      latestTeacherScore: detail.latestTeacherScore ?? null,
      latestTeacherComment: detail.latestTeacherComment || '',
      latestSubmittedAt: detail.latestSubmittedAt || '',
      latestReviewedAt: detail.latestReviewedAt || '',
      submissionCount: detail.submissionCount || 0,
      submissionHistory: detail.submissionHistory || [],
      highestTeacherScore: detail.highestTeacherScore ?? null,
      averageTeacherScore: detail.averageTeacherScore ?? null,
      problemAttachments,
      problemAttachmentFileName: problemAttachments[0] ? problemAttachments[0].file_name : '',
      problemAttachmentDisplayName: problemAttachments[0] ? problemAttachments[0].display_name : '',
      problemAttachmentMimeType: problemAttachments[0] ? problemAttachments[0].mime_type : '',
      problemAttachmentKind: problemAttachments[0] ? problemAttachments[0].kind : '',
      problemAttachmentUrl: problemAttachments[0] ? problemAttachments[0].url : '',
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

  map.forEach((item) => {
    if (!item.parent_id) {
      root = item;
      return;
    }

    const parent = map.get(item.parent_id);
    if (parent) {
      parent.children.push(item);
    }
  });

  function sortChildren(node) {
    node.children.sort((left, right) => {
      return Number(left.sort_order || 0) - Number(right.sort_order || 0)
        || String(left.id).localeCompare(String(right.id));
    });
    node.children.forEach(sortChildren);
  }

  if (root) {
    sortChildren(root);
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
    const unlocked = node.unlocked !== false;

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
    map.forEach((node) => {
      const evaluatedRules = node.unlockPrerequisites
        .map((rule) => {
          const sourceNode = map.get(rule.source_node_id) || null;
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
    const maxIterations = Math.max(map.size, 1) + 1;
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

function getNodeAncestorIdSet(nodeId, nodeById = new Map()) {
  const result = new Set();
  let current = nodeById.get(String(nodeId)) || null;

  while (current && current.parent_id) {
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
  const byParent = new Map();
  const result = new Set();

  nodes.forEach((item) => {
    const parentKey = item.parent_id || '__root__';
    if (!byParent.has(parentKey)) {
      byParent.set(parentKey, []);
    }
    byParent.get(parentKey).push(item);
  });

  const queue = [String(nodeId)];
  while (queue.length) {
    const current = queue.shift();
    const children = byParent.get(current) || [];
    children.forEach((child) => {
      const childKey = String(child._id || child.id);
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
      String(node._id || node.id),
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
  const targetKey = nodeId ? String(nodeId) : '__pending__';
  const preparedNodes = allNodes
    .filter((item) => String(item._id || item.id) !== targetKey)
    .map((item) => ({
      ...item,
      unlock_prerequisites: getNodeUnlockPrerequisites(item),
    }));

  preparedNodes.push({
    _id: targetKey,
    tree_id: treeId,
    parent_id: parentId,
    unlock_prerequisites: rules,
  });

  const nodeById = new Map(preparedNodes.map((item) => [String(item._id || item.id), item]));
  const ancestorIds = getNodeAncestorIdSet(targetKey, nodeById);
  const descendantIds = getNodeDescendantIdSet(targetKey, preparedNodes);

  rules.forEach((rule) => {
    const sourceKey = String(rule.source_node_id);
    const sourceNode = nodeById.get(sourceKey) || null;
    if (!sourceNode || String(sourceNode.tree_id) !== String(treeId)) {
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

async function getNodeDescendantIds(nodeId, allNodes = null) {
  const nodes = allNodes || await getAllDocs(COLLECTIONS.nodes);
  const byParent = new Map();

  nodes.forEach((item) => {
    const parentKey = item.parent_id || '__root__';
    if (!byParent.has(parentKey)) {
      byParent.set(parentKey, []);
    }
    byParent.get(parentKey).push(item);
  });

  const result = [];
  const queue = [String(nodeId)];
  while (queue.length) {
    const current = queue.shift();
    result.push(current);
    const children = byParent.get(current) || [];
    children.forEach((child) => {
      queue.push(String(child._id));
    });
  }

  return result;
}

async function getScoresForStudent(studentId) {
  return findDocs(COLLECTIONS.scores, { student_id: studentId });
}

async function getSubmissionsForStudent(studentId) {
  return findDocs(COLLECTIONS.submissions, { student_id: studentId });
}

function groupNodesByTree(nodes = []) {
  const nodesByTree = new Map();
  nodes.forEach((node) => {
    if (!nodesByTree.has(node.tree_id)) {
      nodesByTree.set(node.tree_id, []);
    }
    nodesByTree.get(node.tree_id).push(node);
  });
  return nodesByTree;
}

function buildNodePathById(nodes = []) {
  const nodeById = new Map(nodes.map((node) => [node._id, node]));
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
    result.set(node._id, resolvePath(node._id));
  });
  return result;
}

function buildSystemTreeRules(treeType) {
  if (treeType === 'knowledge') {
    return [
      {
        label: '升级阈值',
        value: `系统知识节点完成度达到 ${Math.round(KNOWLEDGE_LEVEL_THRESHOLD * 100)}% 后，学生升级到该节点配置的等级；新学生默认从 Lv.0 开始`,
      },
      {
        label: '升级依据',
        value: '仅统计带 milestoneLevel 的系统节点；节点当前分来自该节点下已解锁叶子任务的最高分汇总',
      },
      {
        label: '维护方式',
        value: '老师可在后台直接编辑系统树标题、系统节点名称、父子关系、排序和升级等级；第一级内容通常保持解锁等级 0、升级等级 1',
      },
    ];
  }

  if (treeType === 'reward') {
    return [
      {
        label: '解锁规则',
        value: '叶子任务点按 requiredLevel 与学生等级逐级解锁；新学生默认是 Lv.0，因此第一级内容通常应配置为解锁等级 0',
      },
      {
        label: '周挑战积分',
        value: `每周在悬赏树内完成 ${WEEKLY_BOUNTY_TARGET_COUNT} 道老师批改且得分不低于 ${WEEKLY_BOUNTY_SCORE_THRESHOLD} 分的题目，可在积分中心领取 +${WEEKLY_BOUNTY_REWARD_POINTS} 积分`,
      },
      {
        label: '连续提交积分',
        value: `连续 ${WEEKLY_STREAK_TARGET_DAYS} 天每天完成 ${WEEKLY_STREAK_SCORE_THRESHOLD} 分及以上题目可领取 +${WEEKLY_STREAK_REWARD_POINTS} 积分；连续 ${MONTHLY_STREAK_TARGET_DAYS} 天可领取 +${MONTHLY_STREAK_REWARD_POINTS} 积分`,
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
    const summary = summarizeSubmissionHistory(historyByNodeId.get(node._id) || []);
    const latestSubmission = summary.latestSubmission;
    const latestReviewedSubmission = summary.latestReviewedSubmission;
    const latestSubmissionFileItems = latestSubmission
      ? (Array.isArray(latestSubmission.submission_file_items) ? latestSubmission.submission_file_items : [])
      : [];
    const latestCodeImageItems = latestSubmission
      ? (Array.isArray(latestSubmission.code_image_items) ? latestSubmission.code_image_items : [])
      : [];
    const latestCodeImageUrls = latestCodeImageItems
      .map((item) => String(item.url || '').trim())
      .filter(Boolean);

    detailByNodeId.set(node._id, {
      score: summary.highestTeacherScore,
      comment: summary.bestReviewedSubmission ? (summary.bestReviewedSubmission.teacher_comment || '') : '',
      codeText: latestSubmission ? latestSubmission.code_text || '' : '',
      submissionFileUrls: latestSubmissionFileItems.map((item) => String(item.url || '').trim()).filter(Boolean),
      submissionFileItems: latestSubmissionFileItems,
      codeImageUrl: latestCodeImageUrls[0] || '',
      codeImageUrls: latestCodeImageUrls,
      codeImageItems: latestCodeImageItems,
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

function findNodeInTree(root, predicate) {
  if (!root) {
    return null;
  }
  if (predicate(root)) {
    return root;
  }
  for (const child of root.children || []) {
    const matched = findNodeInTree(child, predicate);
    if (matched) {
      return matched;
    }
  }
  return null;
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

async function getEffectiveRequiredLevelForNode(node) {
  let current = node;
  while (current) {
    const requiredLevel = getRequiredLevelForNode(current);
    if (requiredLevel > 0) {
      return requiredLevel;
    }
    if (!current.parent_id) {
      return 0;
    }
    current = await getDocById(COLLECTIONS.nodes, current.parent_id);
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
    getDocById(COLLECTIONS.trees, node.tree_id),
    findDocs(COLLECTIONS.nodes, { tree_id: node.tree_id }),
    submissions ? Promise.resolve(submissions) : getSubmissionsForStudent(student._id),
  ]);
  const sortedNodes = sortNodes(treeNodes);
  const detailByNodeId = buildSubmissionDetailByNodeId(sortedNodes, sortSubmissionsDesc(resolvedSubmissions));
  const nodeStateByNodeId = buildLevelUnlockStateByNodeId(sortedNodes, getStudentLevel(student));
  const root = buildTree(sortedNodes, detailByNodeId, nodeStateByNodeId);
  const matchedNode = findTreeNodeById(root, node._id);

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

function buildLevelUnlockStateByNodeId(nodes = [], studentLevel = 0) {
  const state = new Map();
  const childrenByParent = new Map();
  nodes.forEach((node) => {
    const key = node.parent_id || '__root__';
    if (!childrenByParent.has(key)) {
      childrenByParent.set(key, []);
    }
    childrenByParent.get(key).push(node);
  });

  function walk(node, inheritedRequiredLevel = 0) {
    const requiredLevel = getRequiredLevelForNode(node) || inheritedRequiredLevel;
    if (requiredLevel > 0) {
      state.set(node._id, {
        requiredLevel,
        unlocked: studentLevel >= requiredLevel,
        lockedText: `达到 ${requiredLevel} 级后解锁`,
      });
    }
    (childrenByParent.get(node._id) || []).forEach((child) => walk(child, requiredLevel));
  }

  (childrenByParent.get('__root__') || []).forEach((root) => walk(root, 0));
  return state;
}

async function syncStudentMilestones(studentId) {
  const student = await getDocById(COLLECTIONS.students, studentId);
  if (!student) {
    return null;
  }

  const manualLevelOverride = getStudentManualLevelOverride(student);
  if (manualLevelOverride !== null) {
    if (getStudentLevel(student) === manualLevelOverride) {
      return student;
    }
    return updateDoc(COLLECTIONS.students, student._id, {
      level: manualLevelOverride,
      updated_at: toIsoString(),
    });
  }

  const [trees, nodes, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getSubmissionsForStudent(studentId),
  ]);

  const treeBySystemKey = new Map(trees.map((item) => [item.system_key || '', item]));
  const nodesByTree = groupNodesByTree(nodes);
  const detailByNodeId = buildSubmissionDetailByNodeId(nodes, submissions);

  let nextLevel = getStudentLevel(student);
  const knowledgeTree = treeBySystemKey.get(SPECIAL_TREE_KEYS.knowledge) || null;
  if (knowledgeTree) {
    const knowledgeNodes = sortNodes(nodesByTree.get(knowledgeTree._id) || []);
    const knowledgeRoot = buildTree(
      knowledgeNodes,
      detailByNodeId,
      buildLevelUnlockStateByNodeId(knowledgeNodes, getStudentLevel(student)),
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

  if (nextLevel === getStudentLevel(student)) {
    return student;
  }

  return updateDoc(COLLECTIONS.students, student._id, {
    level: nextLevel,
    updated_at: toIsoString(),
  });
}

async function syncScoreAggregateForStudentNode(studentId, nodeId) {
  const [existingScore, submissions] = await Promise.all([
    findFirstDoc(COLLECTIONS.scores, {
      student_id: studentId,
      node_id: nodeId,
    }),
    findDocs(COLLECTIONS.submissions, {
      student_id: studentId,
      node_id: nodeId,
    }),
  ]);

  const summary = summarizeSubmissionHistory(submissions);
  const bestReviewedSubmission = summary.bestReviewedSubmission;
  if (!bestReviewedSubmission || summary.highestTeacherScore === null) {
    if (existingScore) {
      await deleteDoc(COLLECTIONS.scores, existingScore._id);
    }
    return null;
  }

  const payload = {
    student_id: studentId,
    node_id: nodeId,
    score: summary.highestTeacherScore,
    comment: bestReviewedSubmission.teacher_comment || '',
    updated_at: bestReviewedSubmission.scored_at || toIsoString(),
  };

  if (existingScore) {
    const updated = await updateDoc(COLLECTIONS.scores, existingScore._id, payload);
    return toScoreOutput(updated);
  }

  const created = await addDoc(COLLECTIONS.scores, {
    ...payload,
    created_at: toIsoString(),
  });
  return toScoreOutput(created);
}

async function handleHealth() {
  return {
    ok: true,
    timestamp: toIsoString(),
  };
}

async function handleTeacherLogin(request) {
  const username = normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(request.body.password, '密码', { required: true, maxLength: 200 });

  const teacher = await findFirstDoc(COLLECTIONS.teachers, { username });
  if (!teacher || !verifyPassword(password, teacher.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  return {
    token: createAuthToken('teacher', teacher._id),
    teacher: toTeacherOutput(teacher),
  };
}

async function handleTeacherMe(request) {
  const teacher = await ensureTeacherAuth(request);
  return toTeacherOutput(teacher);
}

async function handleTeacherLogout() {
  return { ok: true };
}

async function handleStudentsList(request) {
  await ensureTeacherAuth(request);
  const students = await getAllDocs(COLLECTIONS.students);
  const syncedStudents = await Promise.all(
    students.map(async (student) => syncStudentMilestones(student._id) || student),
  );
  return syncedStudents
    .sort(sortByCreatedDesc)
    .map(toStudentOutput);
}

async function handleStudentCreate(request) {
  await ensureTeacherAuth(request);

  const username = normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 });
  const name = normalizeString(request.body.name, '姓名', { maxLength: 80 });
  const password = normalizeString(request.body.password, '密码', { required: true, maxLength: 200 });

  await ensureStudentUsernameAvailable(username);

  const now = toIsoString();
  const student = await addDoc(COLLECTIONS.students, {
    username,
    name: name || '',
    level: 0,
    total_points: 0,
    pet_profile: petSystem.buildInitialPetProfile(now),
    reward_tree_point_claimed: false,
    claimed_level_reward_levels: [],
    claimed_weekly_bounty_keys: [],
    claimed_weekly_streak_keys: [],
    claimed_monthly_streak_keys: [],
    claimed_weekly_streak_reward_count: 0,
    claimed_monthly_streak_reward_count: 0,
    wechat_openid: createUnboundWechatOpenId(),
    password_hash: createPasswordHash(password),
    created_at: now,
    updated_at: now,
  });

  return toStudentOutput(student);
}

async function handleStudentUpdate(request, studentId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.students, studentId);
  if (!existing) {
    throw new AppError(404, '学生不存在');
  }

  const username = request.body.username !== undefined
    ? normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 })
    : existing.username;
  const name = request.body.name !== undefined
    ? normalizeString(request.body.name, '姓名', { maxLength: 80 })
    : existing.name;
  const clearManualLevel = request.body.clearManualLevel === true || String(request.body.levelMode || '').trim().toLowerCase() === 'auto';
  let manualLevelOverride = getStudentManualLevelOverride(existing);
  let level = getStudentLevel(existing);
  const totalPoints = request.body.totalPoints !== undefined
    ? normalizeNonNegativeInteger(request.body.totalPoints, '累计积分')
    : getStudentTotalPoints(existing);
  let passwordHash = existing.password_hash;

  if (request.body.level !== undefined) {
    level = normalizeNonNegativeInteger(request.body.level, '等级');
    manualLevelOverride = level;
  } else if (clearManualLevel) {
    manualLevelOverride = null;
  }

  if (request.body.password !== undefined && String(request.body.password).trim() !== '') {
    passwordHash = createPasswordHash(String(request.body.password).trim());
  }

  await ensureStudentUsernameAvailable(username, existing._id);

  const updated = await updateDoc(COLLECTIONS.students, existing._id, {
    username,
    name: name || '',
    level,
    manual_level_override: manualLevelOverride,
    total_points: totalPoints,
    reward_tree_point_claimed: !!existing.reward_tree_point_claimed,
    password_hash: passwordHash,
    updated_at: toIsoString(),
  });

  if (clearManualLevel && manualLevelOverride === null) {
    const syncedStudent = await syncStudentMilestones(updated._id);
    return toStudentOutput(syncedStudent || updated);
  }

  return toStudentOutput(updated);
}

async function deleteStudentRelatedData(studentId) {
  const existingStudent = await getDocById(COLLECTIONS.students, studentId);
  const [scores, submissions] = await Promise.all([
    findDocs(COLLECTIONS.scores, { student_id: studentId }),
    findDocs(COLLECTIONS.submissions, { student_id: studentId }),
  ]);

  if (existingStudent) {
    const petFrameIds = PET_FRAME_STATE_KEYS
      .flatMap((stateKey) => getStudentPetFrameSequences(existingStudent)[stateKey] || []);
    await deleteCloudFiles(petFrameIds);
  }

  await deleteDocsByIds(COLLECTIONS.scores, scores.map((item) => item._id));
  await deleteSubmissionRecords(submissions);
}

async function handleStudentDelete(request, studentId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.students, studentId);
  if (!existing) {
    throw new AppError(404, '学生不存在');
  }

  await deleteStudentRelatedData(existing._id);
  await deleteDoc(COLLECTIONS.students, existing._id);
  return { ok: true };
}

async function handleStudentPetFramesGet(request, studentId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.students, studentId);
  if (!existing) {
    throw new AppError(404, '学生不存在');
  }

  return {
    student: toStudentOutput(existing),
    pet_frames: await buildStudentPetFrameOutput(existing),
    pet_visual_states: PET_FRAME_STATE_CONFIG.map((item) => ({
      key: item.key,
      title: item.title,
    })),
  };
}

async function handleStudentPetFramesUpdate(request, studentId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.students, studentId);
  if (!existing) {
    throw new AppError(404, '学生不存在');
  }

  const body = request.body || {};
  const stateKey = normalizePetFrameStateKey(body.stateKey || body.state_key);
  const currentSequences = getStudentPetFrameSequences(existing);
  const currentStateFrames = currentSequences[stateKey] || [];
  const currentStateFrameSet = new Set(currentStateFrames);
  const keepFrames = normalizePetFrameSequence(body.keepFrames || body.keep_frames || []);
  keepFrames.forEach((fileId) => {
    if (!currentStateFrameSet.has(fileId)) {
      throw new AppError(400, '宠物帧引用不合法');
    }
  });

  const newFrames = normalizePetFramePayloads(body.newFrames || body.new_frames || []);
  const rawPetProfile = existing && typeof existing.pet_profile === 'object' && existing.pet_profile
    ? existing.pet_profile
    : petSystem.buildInitialPetProfile();
  const nextFrameSequences = buildEmptyPetFrameSequenceMap();
  PET_FRAME_STATE_KEYS.forEach((key) => {
    nextFrameSequences[key] = key === stateKey
      ? keepFrames.slice()
      : (currentSequences[key] || []).slice();
  });

  let uploadedFrameIds = [];
  try {
    uploadedFrameIds = newFrames.length
      ? await savePetFrames(newFrames, existing._id, stateKey)
      : [];
    nextFrameSequences[stateKey] = keepFrames.concat(uploadedFrameIds);

    const updated = await updateDoc(COLLECTIONS.students, existing._id, {
      pet_profile: {
        ...rawPetProfile,
        frame_sequences: nextFrameSequences,
      },
      updated_at: toIsoString(),
    });

    const removedFrameIds = currentStateFrames.filter((fileId) => !keepFrames.includes(fileId));
    if (removedFrameIds.length) {
      await deleteCloudFiles(removedFrameIds);
    }

    return {
      student: toStudentOutput(updated),
      pet_frames: await buildStudentPetFrameOutput(updated),
      updated_state_key: stateKey,
      updated_state_title: PET_FRAME_STATE_LABEL_BY_KEY.get(stateKey) || stateKey,
    };
  } catch (error) {
    if (uploadedFrameIds.length) {
      await deleteCloudFiles(uploadedFrameIds);
    }
    throw error;
  }
}

async function handleTreesList(request) {
  await ensureTeacherAuth(request);

  const [trees, nodes] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
  ]);

  const nodesByTree = new Map();
  nodes.forEach((item) => {
    if (!nodesByTree.has(item.tree_id)) {
      nodesByTree.set(item.tree_id, []);
    }
    nodesByTree.get(item.tree_id).push(item);
  });

  return trees
    .sort(sortByCreatedDesc)
    .map((tree) => {
      const treeNodes = nodesByTree.get(tree._id) || [];
      const root = treeNodes.find((item) => !item.parent_id);
      const knowledgeCount = treeNodes.filter((item) => item.parent_id).length;

      return {
        ...toTreeOutput(tree),
        root_id: root ? root._id : null,
        root_name: root ? root.name : null,
        knowledge_count: knowledgeCount,
      };
    });
}

async function handleSystemTreeSettings(request) {
  await ensureTeacherAuth(request);

  const [trees, nodes] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
  ]);

  const treeBySystemKey = new Map(trees.map((item) => [item.system_key || '', item]));
  const nodesByTree = groupNodesByTree(nodes);

  return {
    knowledge_level_threshold: KNOWLEDGE_LEVEL_THRESHOLD,
    reward_center_config: {
      level_reward_point_multiplier: LEVEL_REWARD_POINT_MULTIPLIER,
      weekly_bounty_target_count: WEEKLY_BOUNTY_TARGET_COUNT,
      weekly_bounty_score_threshold: WEEKLY_BOUNTY_SCORE_THRESHOLD,
      weekly_bounty_reward_points: WEEKLY_BOUNTY_REWARD_POINTS,
      weekly_streak_target_days: WEEKLY_STREAK_TARGET_DAYS,
      weekly_streak_score_threshold: WEEKLY_STREAK_SCORE_THRESHOLD,
      weekly_streak_reward_points: WEEKLY_STREAK_REWARD_POINTS,
      monthly_streak_target_days: MONTHLY_STREAK_TARGET_DAYS,
      monthly_streak_score_threshold: MONTHLY_STREAK_SCORE_THRESHOLD,
      monthly_streak_reward_points: MONTHLY_STREAK_REWARD_POINTS,
    },
    trees: SPECIAL_TREE_SPECS.map((spec) => {
      const tree = treeBySystemKey.get(spec.systemKey) || null;
      const treeNodes = tree ? sortNodes(nodesByTree.get(tree._id) || []) : [];
      const pathById = buildNodePathById(treeNodes);
      const systemNodes = treeNodes.filter(isSystemManagedNode);

      return {
        tree_id: tree ? tree._id : '',
        system_key: spec.systemKey,
        tree_type: spec.treeType,
        title: tree ? tree.title : spec.title,
        chapter_desc: tree ? tree.chapter_desc || '' : spec.chapterDesc || '',
        completion_threshold: spec.treeType === 'knowledge' ? KNOWLEDGE_LEVEL_THRESHOLD : null,
        reward_points: spec.treeType === 'reward' ? WEEKLY_BOUNTY_REWARD_POINTS : 0,
        rule_summary_text: spec.treeType === 'knowledge'
          ? `节点完成度达到 ${Math.round(KNOWLEDGE_LEVEL_THRESHOLD * 100)}% 后触发升级判断`
          : `本周完成 ${WEEKLY_BOUNTY_TARGET_COUNT} 道 ${WEEKLY_BOUNTY_SCORE_THRESHOLD} 分以上题目即可领取周积分`,
        reward_summary_text: spec.treeType === 'reward'
          ? `周达标 +${WEEKLY_BOUNTY_REWARD_POINTS}，连续 ${WEEKLY_STREAK_TARGET_DAYS} 天 +${WEEKLY_STREAK_REWARD_POINTS}，连续 ${MONTHLY_STREAK_TARGET_DAYS} 天 +${MONTHLY_STREAK_REWARD_POINTS}`
          : '按系统升级规则自动结算',
        rules: buildSystemTreeRules(spec.treeType),
        nodes: systemNodes.map((node) => ({
          ...toNodeOutput(node),
          path: pathById.get(node._id) || node.name,
          is_root: !node.parent_id,
        })),
      };
    }),
  };
}

async function handleTreeCreate(request) {
  await ensureTeacherAuth(request);

  const title = normalizeString(request.body.title, '章节标题', { required: true, maxLength: 120 });
  const chapterDesc = normalizeString(request.body.chapterDesc, '章节描述', { maxLength: 500 });
  const rootName = normalizeString(request.body.rootName, '根节点名称', { required: true, maxLength: 120 });
  const now = toIsoString();

  const tree = await addDoc(COLLECTIONS.trees, {
    title,
    chapter_desc: chapterDesc || '',
    created_at: now,
    updated_at: now,
  });

  await addDoc(COLLECTIONS.nodes, {
    tree_id: tree._id,
    parent_id: null,
    name: rootName,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  });

  return toTreeOutput(tree);
}

async function handleTreeUpdate(request, treeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.trees, treeId);
  if (!existing) {
    throw new AppError(404, '学习树不存在');
  }

  const title = request.body.title !== undefined
    ? normalizeString(request.body.title, '章节标题', { required: true, maxLength: 120 })
    : existing.title;
  const chapterDesc = request.body.chapterDesc !== undefined
    ? normalizeString(request.body.chapterDesc, '章节描述', { maxLength: 500 })
    : existing.chapter_desc;

  const updated = await updateDoc(COLLECTIONS.trees, treeId, {
    title,
    chapter_desc: chapterDesc || '',
    updated_at: toIsoString(),
  });

  return toTreeOutput(updated);
}

async function deleteTreeRelatedData(treeId) {
  const nodes = await findDocs(COLLECTIONS.nodes, { tree_id: treeId });
  const nodeIds = nodes.map((item) => item._id);
  const [scores, submissions] = await Promise.all([
    findDocsByIn(COLLECTIONS.scores, 'node_id', nodeIds),
    findDocsByIn(COLLECTIONS.submissions, 'node_id', nodeIds),
  ]);

  await deleteDocsByIds(COLLECTIONS.scores, scores.map((item) => item._id));
  await deleteSubmissionRecords(submissions);
  await deleteProblemAttachmentFiles(nodes);
  await deleteDocsByIds(COLLECTIONS.nodes, nodeIds);
}

async function handleTreeDelete(request, treeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.trees, treeId);
  if (!existing) {
    throw new AppError(404, '学习树不存在');
  }
  if (existing.system_key) {
    throw new AppError(400, '系统树不支持删除');
  }

  await deleteTreeRelatedData(existing._id);
  await deleteDoc(COLLECTIONS.trees, existing._id);
  return { ok: true };
}

async function handleTreeNodesList(request, treeId) {
  await ensureTeacherAuth(request);

  const tree = await getDocById(COLLECTIONS.trees, treeId);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const nodes = await findDocs(COLLECTIONS.nodes, { tree_id: treeId });
  return decorateNodes(sortNodes(nodes));
}

async function handleNodeCreate(request, treeId) {
  await ensureTeacherAuth(request);

  const tree = await getDocById(COLLECTIONS.trees, treeId);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const name = normalizeString(request.body.name, '节点名称', { required: true, maxLength: 120 });
  const parentId = normalizeRequiredId(request.body.parentId, '父节点 ID');
  const sortOrder = request.body.sortOrder !== undefined ? Number(request.body.sortOrder) : 0;
  const milestoneLevel = request.body.milestoneLevel !== undefined
    ? normalizeNonNegativeInteger(request.body.milestoneLevel, '升级等级')
    : 0;
  const requiredLevel = request.body.requiredLevel !== undefined
    ? normalizeNonNegativeInteger(request.body.requiredLevel, '解锁等级')
    : 0;
  const unlockPrerequisites = normalizeUnlockPrerequisites(request.body.unlockPrerequisites);
  const unlockPrerequisiteMode = normalizeUnlockPrerequisiteMode(request.body.unlockPrerequisiteMode);
  const requestedProblemAttachments = request.body.problemAttachments !== undefined
    ? request.body.problemAttachments
    : request.body.problemAttachment;
  const problemAttachments = normalizeProblemAttachmentsPayload(requestedProblemAttachments);
  if (!Number.isInteger(sortOrder)) {
    throw new AppError(400, '排序必须是整数');
  }

  const [parent, allNodes] = await Promise.all([
    getDocById(COLLECTIONS.nodes, parentId),
    findDocs(COLLECTIONS.nodes, { tree_id: tree._id }),
  ]);
  if (!parent || parent.tree_id !== tree._id) {
    throw new AppError(400, '父节点不存在或不属于当前学习树');
  }
  validateNodeUnlockPrerequisites({
    treeId: tree._id,
    parentId: parent._id,
    rules: unlockPrerequisites,
    allNodes,
  });

  let node = null;
  try {
    node = await addDoc(COLLECTIONS.nodes, {
      tree_id: tree._id,
      parent_id: parent._id,
      name,
      sort_order: sortOrder,
      milestone_level: milestoneLevel,
      required_level: requiredLevel,
      unlock_prerequisites: unlockPrerequisites,
      unlock_prerequisite_mode: unlockPrerequisiteMode,
      problem_attachments: [],
      ...buildLegacyProblemAttachmentFields([]),
      created_at: toIsoString(),
      updated_at: toIsoString(),
    });

    if (problemAttachments.length) {
      const savedProblemAttachments = await persistProblemAttachments(problemAttachments, tree._id, node._id, []);
      node = await updateDoc(COLLECTIONS.nodes, node._id, {
        problem_attachments: savedProblemAttachments,
        ...buildLegacyProblemAttachmentFields(savedProblemAttachments),
        updated_at: toIsoString(),
      });
    }

    const [decoratedNode] = await decorateNodes([node]);
    return decoratedNode;
  } catch (error) {
    if (node && node._id) {
      try {
        await deleteDoc(COLLECTIONS.nodes, node._id);
      } catch (_err) {
      }
    }
    throw error;
  }
}

async function handleNodeUpdate(request, nodeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.nodes, nodeId);
  if (!existing) {
    throw new AppError(404, '节点不存在');
  }

  const name = request.body.name !== undefined
    ? normalizeString(request.body.name, '节点名称', { required: true, maxLength: 120 })
    : existing.name;
  const sortOrder = request.body.sortOrder !== undefined
    ? Number(request.body.sortOrder)
    : Number(existing.sort_order || 0);
  const milestoneLevel = request.body.milestoneLevel !== undefined
    ? normalizeNonNegativeInteger(request.body.milestoneLevel, '升级等级')
    : Number(existing.milestone_level || 0);
  const requiredLevel = request.body.requiredLevel !== undefined
    ? normalizeNonNegativeInteger(request.body.requiredLevel, '解锁等级')
    : Number(existing.required_level || 0);
  const unlockPrerequisites = request.body.unlockPrerequisites !== undefined
    ? normalizeUnlockPrerequisites(request.body.unlockPrerequisites)
    : getNodeUnlockPrerequisites(existing);
  const unlockPrerequisiteMode = request.body.unlockPrerequisiteMode !== undefined
    ? normalizeUnlockPrerequisiteMode(request.body.unlockPrerequisiteMode)
    : getNodeUnlockPrerequisiteMode(existing);
  const requestedProblemAttachments = request.body.problemAttachments !== undefined
    ? request.body.problemAttachments
    : (request.body.problemAttachment !== undefined ? request.body.problemAttachment : undefined);

  if (!Number.isInteger(sortOrder)) {
    throw new AppError(400, '排序必须是整数');
  }

  let parentId = existing.parent_id || null;
  if (request.body.parentId !== undefined) {
    parentId = normalizeOptionalId(request.body.parentId, '父节点 ID');
  }

  if (!existing.parent_id && parentId !== null) {
    throw new AppError(400, '根节点不能设置父节点');
  }
  if (existing.parent_id && parentId === null) {
    throw new AppError(400, '普通节点不能升级为根节点');
  }

  if (parentId !== null) {
    if (parentId === existing._id) {
      throw new AppError(400, '父节点不能是自己');
    }

    const [parent, allNodes] = await Promise.all([
      getDocById(COLLECTIONS.nodes, parentId),
      findDocs(COLLECTIONS.nodes, { tree_id: existing.tree_id }),
    ]);
    if (!parent || parent.tree_id !== existing.tree_id) {
      throw new AppError(400, '父节点不存在或不在同一棵树中');
    }

    const descendants = await getNodeDescendantIds(existing._id, allNodes);
    if (descendants.includes(parentId)) {
      throw new AppError(400, '不能把父节点设置为自己的后代节点');
    }
  }

  const allNodes = await findDocs(COLLECTIONS.nodes, { tree_id: existing.tree_id });
  validateNodeUnlockPrerequisites({
    nodeId: existing._id,
    treeId: existing.tree_id,
    parentId,
    rules: unlockPrerequisites,
    allNodes,
  });

  const existingProblemAttachments = getStoredProblemAttachments(existing);
  const nextProblemAttachments = requestedProblemAttachments !== undefined
    ? await persistProblemAttachments(requestedProblemAttachments, existing.tree_id, existing._id, existingProblemAttachments)
    : existingProblemAttachments;

  const nextFields = {
    name,
    parent_id: parentId,
    sort_order: sortOrder,
    milestone_level: milestoneLevel,
    required_level: requiredLevel,
    unlock_prerequisites: unlockPrerequisites,
    unlock_prerequisite_mode: unlockPrerequisiteMode,
    problem_attachments: nextProblemAttachments,
    ...buildLegacyProblemAttachmentFields(nextProblemAttachments),
    updated_at: toIsoString(),
  };

  const updated = await updateDoc(COLLECTIONS.nodes, existing._id, nextFields);

  const nextAttachmentIds = new Set(nextProblemAttachments.map((attachment) => attachment.file_id));
  const removedAttachmentIds = existingProblemAttachments
    .map((attachment) => attachment.file_id)
    .filter((fileId) => !nextAttachmentIds.has(fileId));
  if (removedAttachmentIds.length) {
    await deleteCloudFiles(removedAttachmentIds);
  }

  const [decoratedNode] = await decorateNodes([updated]);
  return decoratedNode;
}

async function handleNodeDelete(request, nodeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.nodes, nodeId);
  if (!existing) {
    throw new AppError(404, '节点不存在');
  }
  if (existing.system_key && String(existing.system_key).trim()) {
    throw new AppError(400, '系统节点不支持删除');
  }
  if (!existing.parent_id) {
    throw new AppError(400, '根节点不能单独删除，请删除整棵学习树');
  }

  const allNodes = await findDocs(COLLECTIONS.nodes, { tree_id: existing.tree_id });
  const descendantIds = await getNodeDescendantIds(existing._id, allNodes);
  const removingIds = new Set(descendantIds.map((item) => String(item)));
  const blockedBy = allNodes.find((item) => {
    if (removingIds.has(String(item._id))) {
      return false;
    }
    return getNodeUnlockPrerequisites(item).some((rule) => removingIds.has(String(rule.source_node_id)));
  });
  if (blockedBy) {
    throw new AppError(400, `节点「${blockedBy.name}」仍把当前节点设为前置条件，不能删除`);
  }
  const [scores, submissions] = await Promise.all([
    findDocsByIn(COLLECTIONS.scores, 'node_id', descendantIds),
    findDocsByIn(COLLECTIONS.submissions, 'node_id', descendantIds),
  ]);

  await deleteDocsByIds(COLLECTIONS.scores, scores.map((item) => item._id));
  await deleteSubmissionRecords(submissions);
  await deleteProblemAttachmentFiles(allNodes.filter((item) => removingIds.has(String(item._id))));
  await deleteDocsByIds(COLLECTIONS.nodes, descendantIds);
  return { ok: true };
}

async function handleScoresList(request) {
  await ensureTeacherAuth(request);

  const studentId = normalizeRequiredId(request.query.studentId, 'studentId');
  const treeId = normalizeRequiredId(request.query.treeId, 'treeId');

  const [student, tree, nodes, submissions] = await Promise.all([
    getDocById(COLLECTIONS.students, studentId),
    getDocById(COLLECTIONS.trees, treeId),
    findDocs(COLLECTIONS.nodes, { tree_id: treeId }),
    findDocs(COLLECTIONS.submissions, { student_id: studentId }),
  ]);

  if (!student) {
    throw new AppError(404, '学生不存在');
  }
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const nodeIds = new Set(nodes.map((item) => item._id));
  const filteredSubmissions = submissions.filter((item) => nodeIds.has(item.node_id));
  const decoratedSubmissions = await decorateSubmissions(filteredSubmissions);
  const submissionsByNodeId = new Map();
  decoratedSubmissions.forEach((item) => {
    if (!submissionsByNodeId.has(item.node_id)) {
      submissionsByNodeId.set(item.node_id, []);
    }
    submissionsByNodeId.get(item.node_id).push(item);
  });

  return sortNodes(nodes).map((node) => {
    const summary = summarizeSubmissionHistory(submissionsByNodeId.get(node._id) || []);
    const latestSubmission = summary.latestSubmission;
    const latestReviewedSubmission = summary.latestReviewedSubmission;
    const bestReviewedSubmission = summary.bestReviewedSubmission;
    return {
      node_id: node._id,
      parent_id: node.parent_id || null,
      name: node.name,
      sort_order: Number(node.sort_order || 0),
      score: summary.highestTeacherScore,
      comment: bestReviewedSubmission ? (bestReviewedSubmission.teacher_comment || '') : '',
      score_updated_at: bestReviewedSubmission ? (bestReviewedSubmission.scored_at || null) : null,
      code_text: latestSubmission ? latestSubmission.code_text || '' : '',
      code_image_url: latestSubmission ? latestSubmission.code_image_url || '' : '',
      code_image_urls: latestSubmission
        ? (Array.isArray(latestSubmission.code_image_urls)
          ? latestSubmission.code_image_urls
          : (latestSubmission.code_image_url ? [latestSubmission.code_image_url] : []))
        : [],
      code_image_items: latestSubmission && Array.isArray(latestSubmission.code_image_items)
        ? latestSubmission.code_image_items
        : [],
      latest_submitted_at: latestSubmission ? latestSubmission.submitted_at : null,
      latest_submission_id: latestSubmission ? latestSubmission.id : null,
      latest_teacher_score: latestReviewedSubmission ? getNumericScore(latestReviewedSubmission.teacher_score) : null,
      latest_teacher_comment: latestReviewedSubmission ? (latestReviewedSubmission.teacher_comment || '') : '',
      latest_reviewed_at: latestReviewedSubmission ? (latestReviewedSubmission.scored_at || null) : null,
      submission_count: summary.submissionCount,
    };
  });
}

async function handleSubmissionsList(request) {
  await ensureTeacherAuth(request);

  const studentId = normalizeRequiredId(request.query.studentId, 'studentId');
  const treeId = normalizeRequiredId(request.query.treeId, 'treeId');

  const [student, tree, nodes, submissions] = await Promise.all([
    getDocById(COLLECTIONS.students, studentId),
    getDocById(COLLECTIONS.trees, treeId),
    findDocs(COLLECTIONS.nodes, { tree_id: treeId }),
    findDocs(COLLECTIONS.submissions, { student_id: studentId }),
  ]);

  if (!student) {
    throw new AppError(404, '学生不存在');
  }
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const nodeById = new Map(nodes.map((item) => [item._id, item]));
  const filteredSubmissions = submissions.filter((item) => nodeById.has(item.node_id));
  const decorated = await decorateSubmissions(sortSubmissionsDesc(filteredSubmissions));

  return decorated.map((item) => {
    const node = nodeById.get(item.node_id);
    return {
      ...item,
      node_name: node ? node.name : '',
      parent_id: node ? node.parent_id || null : null,
      sort_order: node ? Number(node.sort_order || 0) : 0,
    };
  });
}

async function handleSubmissionScoreUpdate(request, submissionId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.submissions, submissionId);
  if (!existing) {
    throw new AppError(404, '提交记录不存在');
  }

  const score = normalizeTeacherScore(request.body.score);
  const comment = normalizeString(request.body.comment, '评语', { maxLength: 300 });
  const updated = await updateDoc(COLLECTIONS.submissions, existing._id, {
    teacher_score: score,
    teacher_comment: comment || '',
    scored_at: score === null && !comment ? null : toIsoString(),
  });

  await syncScoreAggregateForStudentNode(updated.student_id, updated.node_id);
  await syncStudentMilestones(updated.student_id);

  const [decorated] = await decorateSubmissions([updated]);
  return decorated;
}

async function handleSubmissionDelete(request, submissionId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.submissions, submissionId);
  if (!existing) {
    throw new AppError(404, '提交记录不存在');
  }

  await deleteSubmissionRecords([existing]);
  const aggregateScore = await syncScoreAggregateForStudentNode(existing.student_id, existing.node_id);
  await syncStudentMilestones(existing.student_id);

  return {
    id: existing._id,
    student_id: existing.student_id,
    node_id: existing.node_id,
    score_record: aggregateScore ? toScoreOutput(aggregateScore) : null,
    deleted: true,
  };
}

async function handleScoreUpsert(request) {
  await ensureTeacherAuth(request);

  const studentId = normalizeRequiredId(request.body.studentId, 'studentId');
  const nodeId = normalizeRequiredId(request.body.nodeId, 'nodeId');
  const score = normalizeScore(request.body.score);
  const comment = normalizeString(request.body.comment, '评语', { maxLength: 300 });

  const [student, node] = await Promise.all([
    getDocById(COLLECTIONS.students, studentId),
    getDocById(COLLECTIONS.nodes, nodeId),
  ]);

  if (!student) {
    throw new AppError(404, '学生不存在');
  }
  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (!node.parent_id) {
    throw new AppError(400, '根节点不参与评分');
  }

  const latestSubmission = await findLatestSubmissionForStudentNode(studentId, nodeId);
  if (!latestSubmission) {
    throw new AppError(400, '该节点暂无学生提交，请先提交答案后再批改');
  }

  await updateDoc(COLLECTIONS.submissions, latestSubmission._id, {
    teacher_score: score,
    teacher_comment: comment || '',
    scored_at: score === null && !comment ? null : toIsoString(),
  });

  const aggregateScore = await syncScoreAggregateForStudentNode(studentId, nodeId);
  await syncStudentMilestones(studentId);
  return aggregateScore || {
    student_id: studentId,
    node_id: nodeId,
    score: null,
    comment: '',
    updated_at: null,
  };
}

async function handleScoreDelete(request) {
  await ensureTeacherAuth(request);

  normalizeRequiredId(request.query.studentId, 'studentId');
  normalizeRequiredId(request.query.nodeId, 'nodeId');
  throw new AppError(400, '节点评分已改为按单次提交批改，请改用 /api/submissions/:id/score');
}

async function handleStudentLogin(request) {
  const username = normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(request.body.password, '密码', { required: true, maxLength: 200 });

  const student = await findFirstDoc(COLLECTIONS.students, { username });
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }
  const syncedStudent = await syncStudentMilestones(student._id) || student;

  return {
    token: createAuthToken('student', syncedStudent._id),
    student: {
      id: syncedStudent._id,
      username: syncedStudent.username,
      name: syncedStudent.name || '',
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
    },
  };
}

async function handleStudentLogout() {
  return { ok: true };
}

async function handleStudentMe(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  return toStudentOutput(syncedStudent);
}

async function handleStudentSubmissionCreate(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const nodeId = normalizeRequiredId(request.body.nodeId, 'nodeId');
  const node = await getDocById(COLLECTIONS.nodes, nodeId);

  if (!node) {
    throw new AppError(404, '节点不存在');
  }
  if (!node.parent_id) {
    throw new AppError(400, '根节点不支持提交代码');
  }
  const childNode = await findFirstDoc(COLLECTIONS.nodes, { parent_id: node._id });
  if (childNode) {
    throw new AppError(400, '只有叶子节点支持提交代码');
  }
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const requiredLevel = await getEffectiveRequiredLevelForNode(node);
  const unlockState = await getEffectiveUnlockStateForStudentNode(syncedStudent, node);
  if (!unlockState.unlocked) {
    throw new AppError(403, `该任务点尚未解锁，${unlockState.lockedText || `达到 ${requiredLevel} 级后才能提交`}`);
  }

  const codeText = normalizeCodeText(request.body.codeText);
  const fileItems = normalizeSubmissionFilePayloads(request.body);
  const savedFiles = fileItems.length
    ? await saveSubmissionFiles(fileItems, student._id, node._id)
    : [];
  const savedImages = savedFiles.filter((file) => isSubmissionImageFile(file.file_name, file.mime_type));

  if (!codeText && !savedFiles.length) {
    throw new AppError(400, '请至少提交代码文本或附件');
  }

  let created;
  try {
    created = await addDoc(COLLECTIONS.submissions, {
      student_id: student._id,
      node_id: node._id,
      code_text: codeText || '',
      submission_file_files: savedFiles,
      code_image_files: savedImages,
      ...buildLegacySubmissionImageFields(savedImages),
      submitted_at: toIsoString(),
      teacher_score: null,
      teacher_comment: '',
      scored_at: null,
      created_at: toIsoString(),
    });
  } catch (error) {
    if (savedFiles.length) {
      await deleteCloudFiles(savedFiles.map((file) => file.file_id));
    }
    throw error;
  }

  const [decorated] = await decorateSubmissions([created]);
  return decorated;
}

async function handleStudentWechatBind(request) {
  if (!request.openid) {
    throw new AppError(400, '当前请求未携带微信身份，请在小程序环境中使用');
  }

  const username = normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(request.body.password, '密码', { required: true, maxLength: 200 });
  const student = await findFirstDoc(COLLECTIONS.students, { username });
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  await ensureStudentWechatOpenIdAvailable(request.openid, student._id);
  const updated = await updateDoc(COLLECTIONS.students, student._id, {
    wechat_openid: request.openid,
    updated_at: toIsoString(),
  });
  const syncedStudent = await syncStudentMilestones(updated._id) || updated;

  return {
    token: createAuthToken('student', syncedStudent._id),
    student: {
      id: syncedStudent._id,
      username: syncedStudent.username,
      name: syncedStudent.name || '',
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
      wechat_openid: syncedStudent.wechat_openid,
    },
  };
}

async function handleStudentWechatLogin(request) {
  if (!request.openid) {
    throw new AppError(400, '当前请求未携带微信身份，请在小程序环境中使用');
  }

  const student = await findFirstDoc(COLLECTIONS.students, { wechat_openid: request.openid });
  if (!student) {
    throw new AppError(404, '该微信号尚未绑定学生账号，请先绑定');
  }
  const syncedStudent = await syncStudentMilestones(student._id) || student;

  return {
    token: createAuthToken('student', syncedStudent._id),
    student: {
      id: syncedStudent._id,
      username: syncedStudent.username,
      name: syncedStudent.name || '',
      level: getStudentLevel(syncedStudent),
      total_points: getStudentTotalPoints(syncedStudent),
    },
  };
}

async function handleStudentTrees(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;

  const [trees, nodes, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getSubmissionsForStudent(syncedStudent._id),
  ]);

  const [decoratedSubmissions, problemAttachmentByNodeId] = await Promise.all([
    decorateSubmissions(sortSubmissionsDesc(submissions)),
    resolveProblemAttachmentOutputMap(nodes),
  ]);
  const detailByNodeId = buildSubmissionDetailByNodeId(nodes, decoratedSubmissions);
  const nodesByTree = groupNodesByTree(nodes);
  return trees
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')))
    .map((tree) => {
      const treeNodes = sortNodes(nodesByTree.get(tree._id) || []);
      const nodeStateByNodeId = buildLevelUnlockStateByNodeId(treeNodes, getStudentLevel(syncedStudent));
      return {
        id: tree._id,
        title: tree.title,
        chapterDesc: tree.chapter_desc || '',
        createdAt: tree.created_at,
        systemKey: tree.system_key || '',
        treeType: tree.tree_type || '',
        root: buildTree(treeNodes, detailByNodeId, nodeStateByNodeId, problemAttachmentByNodeId),
      };
    });
}

async function handleStudentRewardCenter(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const [trees, nodes, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getSubmissionsForStudent(syncedStudent._id),
  ]);
  return buildRewardCenterState(syncedStudent, trees, nodes, submissions);
}

async function handleStudentPet(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  return {
    student: toStudentOutput(syncedStudent),
    pet_center: await buildStudentPetCenterOutput(syncedStudent),
  };
}

async function handleStudentPetPurchase(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const body = request.body || {};
  const itemKey = String(body.itemKey || body.item_key || '').trim();
  const quantity = body.quantity;
  const purchase = petSystem.purchasePetItem(syncedStudent, itemKey, quantity);
  const updatedStudent = await updateDoc(COLLECTIONS.students, syncedStudent._id, {
    ...purchase.studentPatch,
    updated_at: toIsoString(),
  });
  return {
    student: toStudentOutput(updatedStudent),
    pet_center: await buildStudentPetCenterOutput(updatedStudent),
    purchase_result: purchase.result,
  };
}

async function handleStudentPetUse(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const body = request.body || {};
  const itemKey = String(body.itemKey || body.item_key || '').trim();
  const usage = petSystem.usePetItem(syncedStudent, itemKey);
  const updatedStudent = await updateDoc(COLLECTIONS.students, syncedStudent._id, {
    ...usage.studentPatch,
    updated_at: toIsoString(),
  });
  return {
    student: toStudentOutput(updatedStudent),
    pet_center: await buildStudentPetCenterOutput(updatedStudent),
    use_result: usage.result,
  };
}

async function handleStudentPetSelectSpecies(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const body = request.body || {};
  const speciesKey = String(body.speciesKey || body.species_key || '').trim();
  const selection = petSystem.selectPetSpecies(syncedStudent, speciesKey);
  const updatedStudent = await updateDoc(COLLECTIONS.students, syncedStudent._id, {
    ...selection.studentPatch,
    updated_at: toIsoString(),
  });
  return {
    student: toStudentOutput(updatedStudent),
    pet_center: await buildStudentPetCenterOutput(updatedStudent),
    select_result: selection.result,
  };
}

function normalizeRewardClaimType(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['level', 'level_reward', 'levelreward'].includes(value)) {
    return 'level';
  }
  if (['weekly_bounty', 'weekly-bounty', 'bounty', 'reward_tree'].includes(value)) {
    return 'weekly_bounty';
  }
  if (['weekly_streak', 'weekly-streak', 'streak7', 'week_streak'].includes(value)) {
    return 'weekly_streak';
  }
  if (['monthly_streak', 'monthly-streak', 'streak30', 'month_streak'].includes(value)) {
    return 'monthly_streak';
  }
  throw new AppError(400, '积分类型不正确');
}

async function handleStudentRewardClaim(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const [trees, nodes, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getSubmissionsForStudent(syncedStudent._id),
  ]);
  const rewardCenter = buildRewardCenterState(syncedStudent, trees, nodes, submissions);
  const claimType = normalizeRewardClaimType(request.body.claimType || request.body.claim_type || request.body.type);
  const patch = {
    updated_at: toIsoString(),
  };
  let rewardPoints = 0;
  let claimTitle = '积分已领取';
  let claimCopy = '';

  if (claimType === 'level') {
    const level = toPositiveInt(request.body.level || request.body.rewardLevel);
    if (!level) {
      throw new AppError(400, '等级积分缺少 level');
    }
    const matched = (rewardCenter.level_rewards.items || []).find((item) => item.level === level && item.reached);
    if (!matched) {
      throw new AppError(400, '当前等级积分不可领取');
    }
    if (matched.claimed) {
      throw new AppError(400, '该等级积分已经领取过了');
    }
    rewardPoints = level * LEVEL_REWARD_POINT_MULTIPLIER;
    patch.claimed_level_reward_levels = [...new Set(getClaimedLevelRewardLevels(syncedStudent).concat(level))].sort((left, right) => left - right);
    claimTitle = `Lv.${level} 达成积分`;
    claimCopy = `成功领取 ${rewardPoints} 积分`;
  } else if (claimType === 'weekly_bounty') {
    if (!rewardCenter.weekly_bounty.claimable) {
      throw new AppError(400, rewardCenter.weekly_bounty.claimed ? '本周作业树积分已经领取过了' : '本周作业树积分尚未达成');
    }
    rewardPoints = WEEKLY_BOUNTY_REWARD_POINTS;
    patch.claimed_weekly_bounty_keys = getClaimedWeeklyBountyKeys(syncedStudent).concat(rewardCenter.weekly_bounty.week_key);
    claimTitle = '本周作业树积分';
    claimCopy = `本周完成 ${WEEKLY_BOUNTY_TARGET_COUNT} 道 ${WEEKLY_BOUNTY_SCORE_THRESHOLD} 分以上题目，领取 ${rewardPoints} 积分`;
  } else if (claimType === 'weekly_streak') {
    if (!rewardCenter.weekly_streak.claimable_count) {
      throw new AppError(400, '连续 7 天积分尚未达成');
    }
    rewardPoints = WEEKLY_STREAK_REWARD_POINTS;
    patch.claimed_weekly_streak_keys = getClaimedWeeklyStreakKeys(syncedStudent).concat(rewardCenter.weekly_streak.period_key);
    patch.claimed_weekly_streak_reward_count = toPositiveInt(syncedStudent && syncedStudent.claimed_weekly_streak_reward_count) + 1;
    claimTitle = '连续 7 天积分';
    claimCopy = `${rewardCenter.weekly_streak.period_label}内连续 ${rewardCenter.weekly_streak.target_days} 天达成提交目标，领取 ${rewardPoints} 积分`;
  } else if (claimType === 'monthly_streak') {
    if (!rewardCenter.monthly_streak.claimable_count) {
      throw new AppError(400, '连续 30 天积分尚未达成');
    }
    rewardPoints = MONTHLY_STREAK_REWARD_POINTS;
    patch.claimed_monthly_streak_keys = getClaimedMonthlyStreakKeys(syncedStudent).concat(rewardCenter.monthly_streak.period_key);
    patch.claimed_monthly_streak_reward_count = toPositiveInt(syncedStudent && syncedStudent.claimed_monthly_streak_reward_count) + 1;
    claimTitle = '连续 30 天积分';
    claimCopy = `${rewardCenter.monthly_streak.period_label}内连续 ${rewardCenter.monthly_streak.target_days} 天达成提交目标，领取 ${rewardPoints} 积分`;
  }

  patch.total_points = getStudentTotalPoints(syncedStudent) + rewardPoints;
  const updatedStudent = await updateDoc(COLLECTIONS.students, syncedStudent._id, patch);
  const nextRewardCenter = buildRewardCenterState(updatedStudent, trees, nodes, submissions);

  return {
    student: toStudentOutput(updatedStudent),
    reward_center: nextRewardCenter,
    claim_result: {
      claim_type: claimType,
      reward_points: rewardPoints,
      title: claimTitle,
      copy: claimCopy,
      points_text: `+${rewardPoints}`,
    },
  };
}

async function handleStudentNodeShareCardCreate(syncedStudent, request) {
  const nodeId = normalizeRequiredId(request.body.nodeId, '节点ID');
  const node = await getDocById(COLLECTIONS.nodes, nodeId);
  if (!node) {
    throw new AppError(404, '节点不存在');
  }

  const tree = await getDocById(COLLECTIONS.trees, node.tree_id);
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const [treeNodes, submissions] = await Promise.all([
    findDocs(COLLECTIONS.nodes, { tree_id: tree._id }),
    getSubmissionsForStudent(syncedStudent._id),
  ]);
  const sortedTreeNodes = sortNodes(treeNodes);
  const treeNodeIds = new Set(sortedTreeNodes.map((item) => item._id));
  const filteredSubmissions = submissions.filter((item) => treeNodeIds.has(item.node_id));
  const [decoratedSubmissions, problemAttachmentByNodeId] = await Promise.all([
    decorateSubmissions(sortSubmissionsDesc(filteredSubmissions)),
    resolveProblemAttachmentOutputMap(sortedTreeNodes),
  ]);
  const detailByNodeId = buildSubmissionDetailByNodeId(sortedTreeNodes, decoratedSubmissions);
  const nodeStateByNodeId = buildLevelUnlockStateByNodeId(sortedTreeNodes, getStudentLevel(syncedStudent));
  const root = buildTree(sortedTreeNodes, detailByNodeId, nodeStateByNodeId, problemAttachmentByNodeId);
  const shareNode = findNodeInTree(root, (item) => String(item.id) === String(nodeId));
  if (!shareNode) {
    throw new AppError(404, '节点不存在');
  }

  const detail = detailByNodeId.get(nodeId) || {};
  const codeSource = pickShareCodeText(detail);
  const shareImages = pickShareImageItems(detail);
  if (!codeSource && !shareImages.length && Number(detail.submissionCount || 0) <= 0) {
    throw new AppError(400, '请先完成一次提交后再生成成果卡');
  }

  const studentDisplayName = getStudentShareDisplayName(syncedStudent);
  const nodePathById = buildNodePathById(sortedTreeNodes);
  const shareTitle = `${studentDisplayName} 的学习成果卡`;
  const shareSubtitle = tree.title || '学习树';
  const snapshot = await addDoc(COLLECTIONS.shareCards, {
    version: SHARE_CARD_VERSION,
    share_kind: 'node',
    summary_scope: '',
    summary_scope_label: '',
    student_id: syncedStudent._id,
    student_display_name: studentDisplayName,
    student_level: getStudentLevel(syncedStudent),
    student_total_points: getStudentTotalPoints(syncedStudent),
    tree_id: tree._id,
    tree_title: tree.title || '',
    tree_type: tree.tree_type || '',
    node_id: shareNode.id,
    node_name: shareNode.name || '',
    node_path: nodePathById.get(shareNode.id) || shareNode.name || '',
    submission_count: Number(detail.submissionCount || 0),
    reviewed_submission_count: Number((Array.isArray(detail.submissionHistory) ? detail.submissionHistory.filter(hasSubmissionReview).length : 0)),
    active_tree_count: 1,
    active_node_count: 1,
    summary_calendar: null,
    summary_highlights: [],
    highest_teacher_score: detail.highestTeacherScore ?? null,
    latest_teacher_score: detail.latestTeacherScore ?? null,
    average_teacher_score: detail.averageTeacherScore ?? null,
    latest_teacher_comment: truncateMultilineText(pickShareTeacherComment(detail), {
      maxChars: MAX_SHARE_CARD_COMMENT_CHARS,
      maxLines: MAX_SHARE_CARD_COMMENT_LINES,
    }),
    latest_submitted_at: detail.latestSubmittedAt || '',
    latest_reviewed_at: detail.latestReviewedAt || '',
    code_snippet: truncateMultilineText(codeSource, {
      maxChars: MAX_SHARE_CARD_CODE_CHARS,
      maxLines: MAX_SHARE_CARD_CODE_LINES,
    }),
    code_line_count: countCodeLines(codeSource),
    tree_current_score: Number(root && root.currentScore || 0),
    tree_total_score: Number(root && root.totalScore || 0),
    node_current_score: Number(shareNode.currentScore || 0),
    node_total_score: Number(shareNode.totalScore || 0),
    code_image_files: shareImages,
    theme_seed: createShareThemeSeed(syncedStudent._id, shareNode.id),
    share_title: shareTitle,
    share_subtitle: shareSubtitle,
    encouragement_text: pickShareEncouragement(`${syncedStudent._id}:${shareNode.id}:${Date.now()}`),
    created_at: toIsoString(),
    updated_at: toIsoString(),
  });

  return buildShareCardResponse(snapshot);
}

async function handleStudentSummaryShareCardCreate(syncedStudent, request) {
  const scopeConfig = getShareSummaryScopeConfig(request.body.summaryScope || request.body.summary_scope || request.body.scope);
  const [trees, nodes, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getSubmissionsForStudent(syncedStudent._id),
  ]);
  const sortedNodes = sortNodes(nodes);
  const sortedSubmissions = sortSubmissionsDesc(submissions);
  const decoratedSubmissions = await decorateSubmissions(sortedSubmissions);
  const scopedSubmissions = filterSubmissionsByShareScope(decoratedSubmissions, scopeConfig.scope);
  if (!scopedSubmissions.length) {
    throw new AppError(400, scopeConfig.emptyMessage);
  }

  const nodesById = new Map(sortedNodes.map((item) => [String(item._id), item]));
  const treesById = new Map(trees.map((item) => [String(item._id), item]));
  const nodePathById = buildNodePathById(sortedNodes);
  const studentDisplayName = getStudentShareDisplayName(syncedStudent);
  const latestSubmission = scopedSubmissions[0] || null;
  const reviewedSubmissions = scopedSubmissions.filter(hasSubmissionReview);
  const latestReviewedSubmission = reviewedSubmissions[0] || null;
  const reviewedScores = reviewedSubmissions
    .map((item) => getNumericScore(item.teacher_score))
    .filter((score) => score !== null);
  const highestTeacherScore = reviewedScores.length ? Math.max(...reviewedScores) : null;
  const averageTeacherScore = reviewedScores.length
    ? reviewedScores.reduce((sum, score) => sum + score, 0) / reviewedScores.length
    : null;
  const activeNodeIds = [...new Set(scopedSubmissions.map((item) => String(item.node_id || '')).filter(Boolean))];
  const activeTreeIds = [...new Set(activeNodeIds.map((nodeId) => {
    const matchedNode = nodesById.get(nodeId);
    return matchedNode ? String(matchedNode.tree_id || '') : '';
  }).filter(Boolean))];
  const topNodeCounts = new Map();
  activeNodeIds.forEach((nodeId) => topNodeCounts.set(nodeId, 0));
  scopedSubmissions.forEach((item) => {
    const nodeId = String(item.node_id || '');
    if (!nodeId) {
      return;
    }
    topNodeCounts.set(nodeId, Number(topNodeCounts.get(nodeId) || 0) + 1);
  });
  const topNodeLabels = [...topNodeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([nodeId]) => {
      const matchedNode = nodesById.get(nodeId);
      return matchedNode ? String(matchedNode.name || '').trim() : '';
    })
    .filter(Boolean);

  const latestNode = latestSubmission ? nodesById.get(String(latestSubmission.node_id || '')) : null;
  const latestTree = latestNode ? treesById.get(String(latestNode.tree_id || '')) : null;
  const latestNodePath = latestNode
    ? (nodePathById.get(String(latestNode._id)) || latestNode.name || '')
    : '';
  const latestNodeName = latestNode ? String(latestNode.name || '').trim() : '';
  const codeSource = String((scopedSubmissions.find((item) => String(item.code_text || '').trim()) || {}).code_text || '').trim();
  const latestTeacherComment = latestReviewedSubmission ? String(latestReviewedSubmission.teacher_comment || '').trim() : '';
  const imageCarrier = scopedSubmissions.find((item) => Array.isArray(item.code_image_items) && item.code_image_items.length) || null;
  const shareImages = imageCarrier ? buildStoredShareImageItems(imageCarrier.code_image_items) : [];
  const progressSummary = buildStudentTreeProgressSummary(syncedStudent, trees, sortedNodes, decoratedSubmissions);
  const summaryHighlights = buildShareSummaryHighlights({
    topNodeLabels,
    latestNodeName,
  });
  const activeTreeTitles = activeTreeIds
    .map((treeId) => {
      const matchedTree = treesById.get(treeId);
      return matchedTree ? String(matchedTree.title || '').trim() : '';
    })
    .filter(Boolean)
    .slice(0, 3);
  const shareSubtitle = `${scopeConfig.label}学习卡`;

  const snapshot = await addDoc(COLLECTIONS.shareCards, {
    version: SHARE_CARD_VERSION,
    share_kind: 'summary',
    summary_scope: scopeConfig.scope,
    summary_scope_label: scopeConfig.label,
    student_id: syncedStudent._id,
    student_display_name: studentDisplayName,
    student_level: getStudentLevel(syncedStudent),
    student_total_points: getStudentTotalPoints(syncedStudent),
    tree_id: '',
    tree_title: '整体学习情况',
    tree_type: 'summary',
    node_id: '',
    node_name: scopeConfig.title,
    node_path: activeTreeTitles.length ? activeTreeTitles.join(' · ') : '整体学习情况',
    submission_count: scopedSubmissions.length,
    reviewed_submission_count: reviewedSubmissions.length,
    active_tree_count: activeTreeIds.length,
    active_node_count: activeNodeIds.length,
    summary_calendar: scopeConfig.scope === 'month' ? buildMonthlyHeatmapSummary(scopedSubmissions) : null,
    summary_highlights: summaryHighlights,
    highest_teacher_score: highestTeacherScore,
    latest_teacher_score: latestReviewedSubmission ? getNumericScore(latestReviewedSubmission.teacher_score) : null,
    average_teacher_score: averageTeacherScore,
    latest_teacher_comment: truncateMultilineText(latestTeacherComment, {
      maxChars: MAX_SHARE_CARD_COMMENT_CHARS,
      maxLines: MAX_SHARE_CARD_COMMENT_LINES,
    }),
    latest_submitted_at: latestSubmission ? latestSubmission.submitted_at || '' : '',
    latest_reviewed_at: latestReviewedSubmission ? (latestReviewedSubmission.scored_at || '') : '',
    code_snippet: truncateMultilineText(codeSource, {
      maxChars: MAX_SHARE_CARD_CODE_CHARS,
      maxLines: MAX_SHARE_CARD_CODE_LINES,
    }),
    code_line_count: countCodeLines(codeSource),
    tree_current_score: Number(progressSummary.totalCurrentScore || 0),
    tree_total_score: Number(progressSummary.totalTotalScore || 0),
    node_current_score: reviewedSubmissions.length,
    node_total_score: scopedSubmissions.length,
    code_image_files: shareImages,
    theme_seed: createShareThemeSeed(syncedStudent._id, `summary:${scopeConfig.scope}`),
    share_title: `${studentDisplayName} 的${scopeConfig.label}学习报告`,
    share_subtitle: shareSubtitle,
    encouragement_text: pickShareEncouragement(`${syncedStudent._id}:summary:${scopeConfig.scope}:${Date.now()}`),
    created_at: toIsoString(),
    updated_at: toIsoString(),
  });

  return buildShareCardResponse(snapshot);
}

async function handleStudentShareCardCreate(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  const syncedStudent = await syncStudentMilestones(student._id) || student;
  const mode = normalizeShareCardMode(request.body || {});
  if (mode === 'summary') {
    return handleStudentSummaryShareCardCreate(syncedStudent, request);
  }
  return handleStudentNodeShareCardCreate(syncedStudent, request);
}

async function handleShareCardDetail(_request, shareCardId) {
  const snapshot = await getDocById(COLLECTIONS.shareCards, shareCardId);
  if (!snapshot) {
    throw new AppError(404, '分享卡不存在或已失效');
  }
  const payload = await buildShareCardResponse(snapshot);
  return payload.card;
}

async function executeRequest(request) {
  const path = normalizePath(request.path);
  const method = String(request.method || 'GET').toUpperCase();

  if (method === 'GET' && path === '/health') {
    return handleHealth();
  }

  if (method === 'POST' && path === '/teacher/login') {
    return handleTeacherLogin(request);
  }
  if (method === 'POST' && path === '/teacher/logout') {
    return handleTeacherLogout(request);
  }
  if (method === 'GET' && path === '/teacher/me') {
    return handleTeacherMe(request);
  }

  if (method === 'GET' && path === '/students') {
    return handleStudentsList(request);
  }
  if (method === 'POST' && path === '/students') {
    return handleStudentCreate(request);
  }
  if (method === 'PUT' && /^\/students\/[^/]+$/.test(path)) {
    return handleStudentUpdate(request, path.split('/')[2]);
  }
  if (method === 'DELETE' && /^\/students\/[^/]+$/.test(path)) {
    return handleStudentDelete(request, path.split('/')[2]);
  }
  if (method === 'GET' && /^\/students\/[^/]+\/pet-frames$/.test(path)) {
    return handleStudentPetFramesGet(request, path.split('/')[2]);
  }
  if (method === 'PUT' && /^\/students\/[^/]+\/pet-frames$/.test(path)) {
    return handleStudentPetFramesUpdate(request, path.split('/')[2]);
  }

  if (method === 'GET' && path === '/trees') {
    return handleTreesList(request);
  }
  if (method === 'GET' && path === '/system-tree-settings') {
    return handleSystemTreeSettings(request);
  }
  if (method === 'POST' && path === '/trees') {
    return handleTreeCreate(request);
  }
  if (method === 'PUT' && /^\/trees\/[^/]+$/.test(path)) {
    return handleTreeUpdate(request, path.split('/')[2]);
  }
  if (method === 'DELETE' && /^\/trees\/[^/]+$/.test(path)) {
    return handleTreeDelete(request, path.split('/')[2]);
  }
  if (method === 'GET' && /^\/trees\/[^/]+\/nodes$/.test(path)) {
    return handleTreeNodesList(request, path.split('/')[2]);
  }
  if (method === 'POST' && /^\/trees\/[^/]+\/nodes$/.test(path)) {
    return handleNodeCreate(request, path.split('/')[2]);
  }

  if (method === 'PUT' && /^\/nodes\/[^/]+$/.test(path)) {
    return handleNodeUpdate(request, path.split('/')[2]);
  }
  if (method === 'DELETE' && /^\/nodes\/[^/]+$/.test(path)) {
    return handleNodeDelete(request, path.split('/')[2]);
  }

  if (method === 'GET' && path === '/scores') {
    return handleScoresList(request);
  }
  if (method === 'PUT' && path === '/scores') {
    return handleScoreUpsert(request);
  }
  if (method === 'DELETE' && path === '/scores') {
    return handleScoreDelete(request);
  }
  if (method === 'GET' && path === '/submissions') {
    return handleSubmissionsList(request);
  }
  if (method === 'PUT' && /^\/submissions\/[^/]+\/score$/.test(path)) {
    return handleSubmissionScoreUpdate(request, path.split('/')[2]);
  }
  if (method === 'DELETE' && /^\/submissions\/[^/]+$/.test(path)) {
    return handleSubmissionDelete(request, path.split('/')[2]);
  }

  if (method === 'POST' && path === '/student/login') {
    return handleStudentLogin(request);
  }
  if (method === 'POST' && path === '/student/logout') {
    return handleStudentLogout(request);
  }
  if (method === 'GET' && path === '/student/me') {
    return handleStudentMe(request);
  }
  if (method === 'GET' && path === '/student/trees') {
    return handleStudentTrees(request);
  }
  if (method === 'GET' && path === '/student/reward-center') {
    return handleStudentRewardCenter(request);
  }
  if (method === 'POST' && path === '/student/reward-center/claim') {
    return handleStudentRewardClaim(request);
  }
  if (method === 'GET' && path === '/student/pet') {
    return handleStudentPet(request);
  }
  if (method === 'POST' && path === '/student/pet/purchase') {
    return handleStudentPetPurchase(request);
  }
  if (method === 'POST' && path === '/student/pet/use') {
    return handleStudentPetUse(request);
  }
  if (method === 'POST' && path === '/student/pet/select-species') {
    return handleStudentPetSelectSpecies(request);
  }
  if (method === 'POST' && path === '/student/node-submissions') {
    return handleStudentSubmissionCreate(request);
  }
  if (method === 'POST' && path === '/student/share-cards') {
    return handleStudentShareCardCreate(request);
  }
  if (method === 'GET' && /^\/share-cards\/[^/]+$/.test(path)) {
    return handleShareCardDetail(request, path.split('/')[2]);
  }
  if (method === 'POST' && path === '/student/wechat-bind') {
    return handleStudentWechatBind(request);
  }
  if (method === 'POST' && path === '/student/wechat-login') {
    return handleStudentWechatLogin(request);
  }

  throw new AppError(404, `未找到接口: ${method} ${path}`);
}

function createCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function parseHttpBody(body) {
  if (!body) {
    return {};
  }
  if (typeof body === 'object') {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch (_error) {
    return {};
  }
}

function getOpenIdFromContext() {
  try {
    const { OPENID = '' } = cloud.getWXContext();
    return OPENID || '';
  } catch (_error) {
    return '';
  }
}

function createHttpRequest(event) {
  return {
    path: normalizePath(event.path || '/'),
    method: event.httpMethod || 'GET',
    headers: lowerCaseKeys(event.headers),
    query: event.queryStringParameters || {},
    body: parseHttpBody(event.body),
    openid: getOpenIdFromContext(),
  };
}

function createRpcRequest(event) {
  const pathQuery = extractQueryFromPath(event.path || '/');
  return {
    path: normalizePath(event.path || '/'),
    method: event.method || 'GET',
    headers: lowerCaseKeys(event.headers),
    query: {
      ...pathQuery,
      ...(event.query || {}),
    },
    body: event.data || event.body || {},
    openid: getOpenIdFromContext(),
  };
}

function isHttpEvent(event) {
  return !!(event && event.httpMethod);
}

async function ensureCollectionsExist() {
  await ensureCollectionExists(COLLECTIONS.shareCards);
  await ensureSpecialTrees();
  return true;
}

async function handleHttpEvent(event) {
  const headers = createCorsHeaders();
  const method = String(event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: '',
    };
  }

  try {
    await ensureCollectionsExist();
    const payload = await executeRequest(createHttpRequest(event));
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload),
    };
  } catch (error) {
    const normalized = error instanceof AppError ? error : new AppError(500, error.message || '服务器异常');
    if (normalized.status >= 500) {
      console.error(normalized);
    }
    return {
      statusCode: normalized.status,
      headers,
      body: JSON.stringify({ message: normalized.message }),
    };
  }
}

async function handleRpcEvent(event) {
  try {
    await ensureCollectionsExist();
    const payload = await executeRequest(createRpcRequest(event));
    return createSuccessResult(payload);
  } catch (error) {
    const normalized = error instanceof AppError ? error : new AppError(500, error.message || '服务器异常');
    if (normalized.status >= 500) {
      console.error(normalized);
    }
    return createErrorResult(normalized);
  }
}

exports.main = async (event = {}, context = {}) => {
  if (event.invokeMode === 'rpc') {
    return handleRpcEvent(event, context);
  }

  if (isHttpEvent(event)) {
    return handleHttpEvent(event, context);
  }

  return createErrorResult(new AppError(400, '不支持的调用方式'));
};
