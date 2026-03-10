const crypto = require('crypto');
const cloud = require('wx-server-sdk');

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
};

const MAX_QUERY_BATCH = 100;
const MAX_CODE_IMAGE_BYTES = 5 * 1024 * 1024;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_SECRET = process.env.APP_SECRET || 'cloudbase-dev-secret-change-me';
const CODE_IMAGE_PREFIX = 'student-code';
const UNBOUND_WECHAT_OPENID_PREFIX = '__UNBOUND__::';

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

async function deleteDoc(collectionName, id) {
  await db.collection(collectionName).doc(String(id)).remove();
}

async function deleteDocsByIds(collectionName, ids = []) {
  const filtered = [...new Set(ids.filter(Boolean).map((item) => String(item)))];
  for (const id of filtered) {
    await deleteDoc(collectionName, id);
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
    wechat_openid: presentWechatOpenId(item.wechat_openid),
    created_at: item.created_at,
  };
}

function toTreeOutput(item) {
  return {
    id: item._id,
    title: item.title,
    chapter_desc: item.chapter_desc || '',
    created_at: item.created_at,
  };
}

function toNodeOutput(item) {
  return {
    id: item._id,
    tree_id: item.tree_id,
    parent_id: item.parent_id || null,
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

function toSubmissionOutput(item, imageUrl = '') {
  return {
    id: item._id,
    student_id: item.student_id,
    node_id: item.node_id,
    code_text: item.code_text || '',
    code_image_url: imageUrl,
    submitted_at: item.submitted_at,
    teacher_score: item.teacher_score === undefined ? null : item.teacher_score,
    teacher_comment: item.teacher_comment || '',
    scored_at: item.scored_at || null,
  };
}

async function resolveTempFileUrlMap(fileIds = []) {
  const filtered = [...new Set(fileIds.filter(Boolean))];
  if (!filtered.length) {
    return new Map();
  }

  const { fileList = [] } = await cloud.getTempFileURL({
    fileList: filtered,
  });

  return new Map(fileList.map((item) => [item.fileID, item.tempFileURL || '']));
}

async function decorateSubmissions(submissions = []) {
  const fileIds = submissions
    .map((item) => item.code_image_file_id)
    .filter(Boolean);
  const urlMap = await resolveTempFileUrlMap(fileIds);

  return submissions.map((item) => {
    return toSubmissionOutput(item, item.code_image_file_id ? (urlMap.get(item.code_image_file_id) || '') : '');
  });
}

function parseCodeImage(imageBase64, imageMimeType) {
  let raw = normalizeString(imageBase64, '图片内容', { required: true, maxLength: 10 * 1024 * 1024 });
  let mime = normalizeString(imageMimeType, '图片类型', { maxLength: 120 });
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

  return { buffer, ext };
}

async function saveCodeImage(imageBase64, imageMimeType, studentId, nodeId) {
  const { buffer, ext } = parseCodeImage(imageBase64, imageMimeType);
  const cloudPath = [
    CODE_IMAGE_PREFIX,
    String(studentId),
    String(nodeId),
    `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`,
  ].join('/');

  const result = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer,
  });

  return result.fileID;
}

async function removeCodeImage(fileId) {
  if (!fileId) {
    return;
  }

  try {
    await cloud.deleteFile({
      fileList: [fileId],
    });
  } catch (_error) {
  }
}

async function deleteSubmissionRecords(submissions = []) {
  if (!submissions.length) {
    return;
  }

  const fileIds = submissions
    .map((item) => item.code_image_file_id)
    .filter(Boolean);

  if (fileIds.length) {
    try {
      await cloud.deleteFile({
        fileList: [...new Set(fileIds)],
      });
    } catch (_error) {
    }
  }

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

function buildTree(nodes = [], detailByNodeId = new Map()) {
  const map = new Map();
  let root = null;

  nodes.forEach((item) => {
    const detail = detailByNodeId.get(item._id) || {};
    map.set(item._id, {
      id: item._id,
      tree_id: item.tree_id,
      parent_id: item.parent_id || null,
      name: item.name,
      sort_order: Number(item.sort_order || 0),
      score: detail.score ?? null,
      comment: detail.comment || '',
      codeText: detail.codeText || '',
      codeImageUrl: detail.codeImageUrl || '',
      latestTeacherScore: detail.latestTeacherScore ?? null,
      latestTeacherComment: detail.latestTeacherComment || '',
      latestSubmittedAt: detail.latestSubmittedAt || '',
      submissionCount: detail.submissionCount || 0,
      submissionHistory: detail.submissionHistory || [],
      highestTeacherScore: detail.highestTeacherScore ?? null,
      averageTeacherScore: detail.averageTeacherScore ?? null,
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

  return root;
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
  return students
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
  let passwordHash = existing.password_hash;

  if (request.body.password !== undefined && String(request.body.password).trim() !== '') {
    passwordHash = createPasswordHash(String(request.body.password).trim());
  }

  await ensureStudentUsernameAvailable(username, existing._id);

  const updated = await updateDoc(COLLECTIONS.students, existing._id, {
    username,
    name: name || '',
    password_hash: passwordHash,
    updated_at: toIsoString(),
  });

  return toStudentOutput(updated);
}

async function deleteStudentRelatedData(studentId) {
  const [scores, submissions] = await Promise.all([
    findDocs(COLLECTIONS.scores, { student_id: studentId }),
    findDocs(COLLECTIONS.submissions, { student_id: studentId }),
  ]);

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
  await deleteDocsByIds(COLLECTIONS.nodes, nodeIds);
}

async function handleTreeDelete(request, treeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.trees, treeId);
  if (!existing) {
    throw new AppError(404, '学习树不存在');
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
  return sortNodes(nodes).map(toNodeOutput);
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
  if (!Number.isInteger(sortOrder)) {
    throw new AppError(400, '排序必须是整数');
  }

  const parent = await getDocById(COLLECTIONS.nodes, parentId);
  if (!parent || parent.tree_id !== tree._id) {
    throw new AppError(400, '父节点不存在或不属于当前学习树');
  }

  const node = await addDoc(COLLECTIONS.nodes, {
    tree_id: tree._id,
    parent_id: parent._id,
    name,
    sort_order: sortOrder,
    created_at: toIsoString(),
    updated_at: toIsoString(),
  });

  return toNodeOutput(node);
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

  const updated = await updateDoc(COLLECTIONS.nodes, existing._id, {
    name,
    parent_id: parentId,
    sort_order: sortOrder,
    updated_at: toIsoString(),
  });

  return toNodeOutput(updated);
}

async function handleNodeDelete(request, nodeId) {
  await ensureTeacherAuth(request);

  const existing = await getDocById(COLLECTIONS.nodes, nodeId);
  if (!existing) {
    throw new AppError(404, '节点不存在');
  }
  if (!existing.parent_id) {
    throw new AppError(400, '根节点不能单独删除，请删除整棵学习树');
  }

  const allNodes = await findDocs(COLLECTIONS.nodes, { tree_id: existing.tree_id });
  const descendantIds = await getNodeDescendantIds(existing._id, allNodes);
  const [scores, submissions] = await Promise.all([
    findDocsByIn(COLLECTIONS.scores, 'node_id', descendantIds),
    findDocsByIn(COLLECTIONS.submissions, 'node_id', descendantIds),
  ]);

  await deleteDocsByIds(COLLECTIONS.scores, scores.map((item) => item._id));
  await deleteSubmissionRecords(submissions);
  await deleteDocsByIds(COLLECTIONS.nodes, descendantIds);
  return { ok: true };
}

async function handleScoresList(request) {
  await ensureTeacherAuth(request);

  const studentId = normalizeRequiredId(request.query.studentId, 'studentId');
  const treeId = normalizeRequiredId(request.query.treeId, 'treeId');

  const [student, tree, nodes, scores, submissions] = await Promise.all([
    getDocById(COLLECTIONS.students, studentId),
    getDocById(COLLECTIONS.trees, treeId),
    findDocs(COLLECTIONS.nodes, { tree_id: treeId }),
    findDocs(COLLECTIONS.scores, { student_id: studentId }),
    findDocs(COLLECTIONS.submissions, { student_id: studentId }),
  ]);

  if (!student) {
    throw new AppError(404, '学生不存在');
  }
  if (!tree) {
    throw new AppError(404, '学习树不存在');
  }

  const nodeIds = new Set(nodes.map((item) => item._id));
  const filteredScores = scores.filter((item) => nodeIds.has(item.node_id));
  const filteredSubmissions = submissions.filter((item) => nodeIds.has(item.node_id));
  const decoratedSubmissions = await decorateSubmissions(filteredSubmissions);

  const scoreByNodeId = new Map(filteredScores.map((item) => [item.node_id, item]));
  const submissionByNodeId = new Map();
  const submissionCountByNodeId = new Map();
  decoratedSubmissions.forEach((item) => {
    if (!submissionByNodeId.has(item.node_id)) {
      submissionByNodeId.set(item.node_id, item);
    }
    submissionCountByNodeId.set(item.node_id, (submissionCountByNodeId.get(item.node_id) || 0) + 1);
  });

  return sortNodes(nodes).map((node) => {
    const score = scoreByNodeId.get(node._id);
    const latestSubmission = submissionByNodeId.get(node._id);
    return {
      node_id: node._id,
      parent_id: node.parent_id || null,
      name: node.name,
      sort_order: Number(node.sort_order || 0),
      score: score ? score.score : null,
      comment: score ? score.comment || '' : '',
      score_updated_at: score ? score.updated_at : null,
      code_text: latestSubmission ? latestSubmission.code_text || '' : '',
      code_image_url: latestSubmission ? latestSubmission.code_image_url || '' : '',
      latest_submitted_at: latestSubmission ? latestSubmission.submitted_at : null,
      latest_submission_id: latestSubmission ? latestSubmission.id : null,
      submission_count: submissionCountByNodeId.get(node._id) || 0,
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

  const [decorated] = await decorateSubmissions([updated]);
  return decorated;
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

  const existing = await findFirstDoc(COLLECTIONS.scores, {
    student_id: studentId,
    node_id: nodeId,
  });

  if (existing) {
    const updated = await updateDoc(COLLECTIONS.scores, existing._id, {
      score,
      comment: comment || '',
      updated_at: toIsoString(),
    });
    return toScoreOutput(updated);
  }

  const created = await addDoc(COLLECTIONS.scores, {
    student_id: studentId,
    node_id: nodeId,
    score,
    comment: comment || '',
    updated_at: toIsoString(),
    created_at: toIsoString(),
  });

  return toScoreOutput(created);
}

async function handleScoreDelete(request) {
  await ensureTeacherAuth(request);

  const studentId = normalizeRequiredId(request.query.studentId, 'studentId');
  const nodeId = normalizeRequiredId(request.query.nodeId, 'nodeId');
  const existing = await findFirstDoc(COLLECTIONS.scores, {
    student_id: studentId,
    node_id: nodeId,
  });

  if (existing) {
    await deleteDoc(COLLECTIONS.scores, existing._id);
  }

  return { ok: true };
}

async function handleStudentLogin(request) {
  const username = normalizeString(request.body.username, '用户名', { required: true, maxLength: 80 });
  const password = normalizeString(request.body.password, '密码', { required: true, maxLength: 200 });

  const student = await findFirstDoc(COLLECTIONS.students, { username });
  if (!student || !verifyPassword(password, student.password_hash)) {
    throw new AppError(401, '用户名或密码错误');
  }

  return {
    token: createAuthToken('student', student._id),
    student: {
      id: student._id,
      username: student.username,
      name: student.name || '',
    },
  };
}

async function handleStudentLogout() {
  return { ok: true };
}

async function handleStudentMe(request) {
  const student = await resolveStudentByTokenOrOpenId(request);
  return toStudentOutput(student);
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

  const codeText = normalizeCodeText(request.body.codeText);
  let codeImageFileId = null;

  if (request.body.imageBase64) {
    codeImageFileId = await saveCodeImage(
      request.body.imageBase64,
      request.body.imageMimeType,
      student._id,
      node._id,
    );
  }

  if (!codeText && !codeImageFileId) {
    throw new AppError(400, '请至少提交代码文本或代码图片');
  }

  const created = await addDoc(COLLECTIONS.submissions, {
    student_id: student._id,
    node_id: node._id,
    code_text: codeText || '',
    code_image_file_id: codeImageFileId || '',
    submitted_at: toIsoString(),
    teacher_score: null,
    teacher_comment: '',
    scored_at: null,
    created_at: toIsoString(),
  });

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

  return {
    token: createAuthToken('student', updated._id),
    student: {
      id: updated._id,
      username: updated.username,
      name: updated.name || '',
      wechat_openid: updated.wechat_openid,
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

  return {
    token: createAuthToken('student', student._id),
    student: {
      id: student._id,
      username: student.username,
      name: student.name || '',
    },
  };
}

async function handleStudentTrees(request) {
  const student = await resolveStudentByTokenOrOpenId(request);

  const [trees, nodes, scores, submissions] = await Promise.all([
    getAllDocs(COLLECTIONS.trees),
    getAllDocs(COLLECTIONS.nodes),
    getScoresForStudent(student._id),
    getSubmissionsForStudent(student._id),
  ]);

  const decoratedSubmissions = await decorateSubmissions(sortSubmissionsDesc(submissions));
  const scoreByNodeId = new Map(scores.map((item) => [item.node_id, item]));
  const historyByNodeId = new Map();

  decoratedSubmissions.forEach((item) => {
    if (!historyByNodeId.has(item.node_id)) {
      historyByNodeId.set(item.node_id, []);
    }
    historyByNodeId.get(item.node_id).push(item);
  });

  const detailByNodeId = new Map();
  nodes.forEach((node) => {
    const history = historyByNodeId.get(node._id) || [];
    const scoredValues = history
      .map((item) => Number(item.teacher_score))
      .filter((score) => !Number.isNaN(score));
    const latest = history[0] || null;
    const score = scoreByNodeId.get(node._id);

    detailByNodeId.set(node._id, {
      score: score ? score.score : null,
      comment: score ? score.comment || '' : '',
      codeText: latest ? latest.code_text || '' : '',
      codeImageUrl: latest ? latest.code_image_url || '' : '',
      latestTeacherScore: latest ? latest.teacher_score : null,
      latestTeacherComment: latest ? latest.teacher_comment || '' : '',
      latestSubmittedAt: latest ? latest.submitted_at : '',
      submissionCount: history.length,
      submissionHistory: history,
      highestTeacherScore: scoredValues.length ? Math.max(...scoredValues) : null,
      averageTeacherScore: scoredValues.length
        ? scoredValues.reduce((sum, value) => sum + value, 0) / scoredValues.length
        : null,
    });
  });

  const nodesByTree = new Map();
  nodes.forEach((node) => {
    if (!nodesByTree.has(node.tree_id)) {
      nodesByTree.set(node.tree_id, []);
    }
    nodesByTree.get(node.tree_id).push(node);
  });

  return trees
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')))
    .map((tree) => {
      const treeNodes = sortNodes(nodesByTree.get(tree._id) || []);
      return {
        id: tree._id,
        title: tree.title,
        chapterDesc: tree.chapter_desc || '',
        createdAt: tree.created_at,
        root: buildTree(treeNodes, detailByNodeId),
      };
    });
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

  if (method === 'GET' && path === '/trees') {
    return handleTreesList(request);
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
  if (method === 'POST' && path === '/student/node-submissions') {
    return handleStudentSubmissionCreate(request);
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
