const { request } = require('../../utils/request');
const { getStudent, setStudentProfile, clearSession } = require('../../utils/auth');
const { pickRandomTip } = require('../../utils/loading-tips.js');

const SHARE_POSTER_WIDTH = 1080;
const SHARE_POSTER_HEIGHT = 2280;
const MONTH_WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUBMISSION_ATTACHMENTS = 9;
const TREE_THEME_PRESETS = [
  {
    cardClass: 'tree-theme-ocean',
    coverClass: 'tree-cover-theme-ocean',
    chipClass: 'tree-preview-chip-ocean',
    badge: 'Ocean Chapter',
  },
  {
    cardClass: 'tree-theme-forest',
    coverClass: 'tree-cover-theme-forest',
    chipClass: 'tree-preview-chip-forest',
    badge: 'Forest Chapter',
  },
  {
    cardClass: 'tree-theme-sunrise',
    coverClass: 'tree-cover-theme-sunrise',
    chipClass: 'tree-preview-chip-sunrise',
    badge: 'Sunrise Chapter',
  },
  {
    cardClass: 'tree-theme-cosmos',
    coverClass: 'tree-cover-theme-cosmos',
    chipClass: 'tree-preview-chip-cosmos',
    badge: 'Cosmos Chapter',
  },
];
const HEATMAP_LEGEND_ITEMS = [
  { label: '未提交', band: 'none' },
  { label: '待评分', band: 'pending' },
  { label: '0-3 分', band: 'low' },
  { label: '4-7 分', band: 'mid' },
  { label: '8-10 分', band: 'high' },
];

const KNOWLEDGE_SCENE_BRANCH_PRESETS = [
  { key: 'right-low', startX: 346, startY: 446, length: 186, angle: -14 },
  { key: 'right-mid', startX: 350, startY: 352, length: 214, angle: -28 },
  { key: 'right-top', startX: 338, startY: 256, length: 186, angle: -42 },
  { key: 'left-top', startX: 324, startY: 258, length: 184, angle: -138 },
  { key: 'left-mid', startX: 304, startY: 352, length: 214, angle: -152 },
  { key: 'left-low', startX: 292, startY: 446, length: 186, angle: -166 },
];

const KNOWLEDGE_SCENE_SPARKLE_PRESETS = [
  { left: 60, top: 78, size: 10 },
  { left: 118, top: 150, size: 12 },
  { left: 212, top: 84, size: 8 },
  { left: 278, top: 142, size: 14 },
  { left: 372, top: 96, size: 10 },
  { left: 454, top: 166, size: 12 },
  { left: 560, top: 122, size: 9 },
  { left: 602, top: 214, size: 8 },
  { left: 86, top: 250, size: 10 },
  { left: 178, top: 210, size: 8 },
  { left: 512, top: 252, size: 11 },
  { left: 620, top: 324, size: 12 },
];

const CONSTELLATION_GLOW_SCORE = 8;
const CONSTELLATION_SCENE_CONFIG = {
  knowledge: {
    sceneType: 'knowledge',
    title: '知识点星图',
    rootLabel: 'C++知识点树',
    emptyText: '老师还没有配置知识点树节点。',
    hintText: '手指滑动旋转 · 8分+节点会点亮',
    themeClass: 'constellation-scene-knowledge',
  },
  reward: {
    sceneType: 'reward',
    title: '悬赏星图',
    rootLabel: '每周悬赏树',
    emptyText: '老师还没有配置每周悬赏树节点。',
    hintText: '手指滑动旋转 · 8分+节点会点亮',
    themeClass: 'constellation-scene-reward',
  },
};

function parseSafeDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatHeatmapDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatHeatmapMonthLabel(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function getHeatmapBand(score, hasSubmission) {
  const numericScore = score === null || score === undefined || Number.isNaN(Number(score))
    ? null
    : Number(score);
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

function getHeatmapBandClass(band) {
  return `heatmap-band-${band || 'none'}`;
}

function buildHeatmapLegendItems() {
  return HEATMAP_LEGEND_ITEMS.map((item) => ({
    ...item,
    bandClass: getHeatmapBandClass(item.band),
  }));
}

function buildEmptyHeatmapSummary(now = new Date()) {
  return {
    monthLabel: formatHeatmapMonthLabel(now),
    title: `${formatHeatmapMonthLabel(now)} 学习热力图`,
    summaryText: '本月还没有提交记录，开始第一次提交吧。',
    activeDays: 0,
    reviewedDays: 0,
    submittedCount: 0,
    weekdayLabels: MONTH_WEEKDAY_LABELS.slice(),
    legendItems: buildHeatmapLegendItems(),
    cells: [],
  };
}

function buildEmptyRewardPrompt() {
  return {
    claimableCount: 0,
    claimablePoints: 0,
    hintText: '',
    buttonText: '领取积分',
    hasClaimable: false,
  };
}

function buildRewardPrompt(raw = {}) {
  const claimableCount = Math.max(0, Number(raw.claimable_reward_count || 0));
  const claimablePoints = Math.max(0, Number(raw.claimable_total_points || 0));
  return {
    claimableCount,
    claimablePoints,
    buttonText: '领取积分',
    hintText: claimableCount > 0
      ? `可领 ${claimableCount} 份 · ${formatNumber(claimablePoints)} 分`
      : '',
    hasClaimable: claimableCount > 0,
  };
}

function buildMonthActivityCalendar(submissions = [], now = new Date()) {
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
    const submittedAt = parseSafeDate(item.submittedAt || item.submitted_at);
    if (!submittedAt) {
      return;
    }
    if (submittedAt.getFullYear() !== year || submittedAt.getMonth() !== month) {
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
    const numericScore = item.teacherScoreValue === null || item.teacherScoreValue === undefined || Number.isNaN(Number(item.teacherScoreValue))
      ? null
      : Number(item.teacherScoreValue);
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
        placeholder: true,
        dayLabel: '',
        hasSubmission: false,
        highestScore: null,
        scoreText: '',
        band: 'none',
        bandClass: getHeatmapBandClass('none'),
        isToday: false,
      });
      continue;
    }

    const cellDate = new Date(year, month, dayNumber);
    const key = formatHeatmapDateKey(cellDate);
    const summary = daySummary.get(key) || null;
    const hasSubmission = !!(summary && summary.hasSubmission);
    const highestScore = summary ? summary.highestScore : null;
    const band = getHeatmapBand(highestScore, hasSubmission);
    cells.push({
      key,
      placeholder: false,
      dateKey: key,
      dayLabel: String(dayNumber),
      hasSubmission,
      highestScore,
      scoreText: highestScore === null || Number.isNaN(Number(highestScore)) ? '' : formatNumber(highestScore),
      band,
      bandClass: getHeatmapBandClass(band),
      isToday: key === todayKey,
    });
  }

  const activeDays = cells.filter((cell) => cell.hasSubmission).length;
  const reviewedDays = cells.filter((cell) => cell.highestScore !== null).length;
  const submittedCount = [...daySummary.values()].reduce((sum, item) => sum + Number(item.submittedCount || 0), 0);

  return {
    monthLabel: formatHeatmapMonthLabel(firstDay),
    title: formatHeatmapMonthLabel(firstDay),
    summaryText: activeDays
      ? `活跃 ${activeDays} 天 · 提交 ${submittedCount} 次${reviewedDays ? ` · 已评分 ${reviewedDays} 天` : ''}`
      : '本月还没有提交记录。',
    activeDays,
    reviewedDays,
    submittedCount,
    weekdayLabels: MONTH_WEEKDAY_LABELS.slice(),
    legendItems: buildHeatmapLegendItems(),
    cells,
  };
}

function collectSubmissionHistoryFromTrees(trees = []) {
  const entries = [];
  const seen = new Set();

  trees.forEach((tree) => {
    (tree.flatNodes || []).forEach((node) => {
      (node.submissionHistory || []).forEach((item) => {
        const key = item.id ? `submission:${item.id}` : `${node.id}:${item.submittedAt || item.submitted_at || ''}:${item.codeText || item.code_text || ''}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        entries.push(item);
      });
    });
  });

  return entries;
}

function buildMonthActivityFromTrees(trees = [], now = new Date()) {
  return buildMonthActivityCalendar(collectSubmissionHistoryFromTrees(trees), now);
}

function toHeatmapDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function buildStudentProfileSummaryFromTrees(trees = []) {
  const submissions = collectSubmissionHistoryFromTrees(trees);
  if (!submissions.length) {
    return {
      totalSubmissions: 0,
      highScoreCount: 0,
      perfectScoreCount: 0,
      maxStreakDays: 0,
      lastSubmittedAtText: '暂无提交',
      lastSubmittedAtValue: '',
    };
  }

  let highScoreCount = 0;
  let perfectScoreCount = 0;
  let lastSubmittedAt = null;
  const dayStarts = new Set();

  submissions.forEach((item) => {
    const submittedAt = parseSafeDate(item.submittedAt || item.submitted_at);
    if (!submittedAt) {
      return;
    }
    if (!lastSubmittedAt || submittedAt.getTime() > lastSubmittedAt.getTime()) {
      lastSubmittedAt = submittedAt;
    }
    dayStarts.add(toHeatmapDayStart(submittedAt));

    const score = item.teacherScoreValue === null || item.teacherScoreValue === undefined || Number.isNaN(Number(item.teacherScoreValue))
      ? null
      : Number(item.teacherScoreValue);
    if (score !== null && score >= 8) {
      highScoreCount += 1;
    }
    if (score !== null && score >= 10) {
      perfectScoreCount += 1;
    }
  });

  const orderedDays = [...dayStarts].sort((left, right) => left - right);
  let maxStreakDays = 0;
  let currentStreak = 0;
  let prevDay = null;
  orderedDays.forEach((dayStart) => {
    if (prevDay === null || dayStart - prevDay > DAY_MS) {
      currentStreak = 1;
    } else if (dayStart - prevDay === DAY_MS) {
      currentStreak += 1;
    }
    if (currentStreak > maxStreakDays) {
      maxStreakDays = currentStreak;
    }
    prevDay = dayStart;
  });

  return {
    totalSubmissions: submissions.length,
    highScoreCount,
    perfectScoreCount,
    maxStreakDays,
    lastSubmittedAtText: lastSubmittedAt ? formatDateTime(lastSubmittedAt) : '暂无提交',
    lastSubmittedAtValue: lastSubmittedAt ? lastSubmittedAt.toISOString() : '',
  };
}

function buildEmptyStudentProfileSummary() {
  return {
    totalSubmissions: 0,
    highScoreCount: 0,
    perfectScoreCount: 0,
    maxStreakDays: 0,
    lastSubmittedAtText: '暂无提交',
    lastSubmittedAtValue: '',
  };
}

function buildStudentHeroProfile(student) {
  const safe = student || {};
  return {
    username: String(safe.username || '').trim(),
    displayName: String(safe.name || safe.username || '同学').trim() || '同学',
    level: Number(safe.level || 0),
    totalPoints: Number(safe.total_points || safe.totalPoints || 0),
  };
}

function getCurrentWeekStartMs(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  return start.getTime();
}

function buildEmptyRewardTreeProgress() {
  return {
    title: '本周作业树进度',
    qualifiedCount: 0,
    targetCount: 2,
    progressPercent: 0,
    summaryText: '当前还没有配置每周悬赏树任务。',
    available: false,
  };
}

function buildWeeklyRewardTreeProgressFromTrees(trees = [], now = new Date()) {
  const rewardTrees = (Array.isArray(trees) ? trees : []).filter((tree) => String(tree.treeType || '') === 'reward');
  if (!rewardTrees.length) {
    return buildEmptyRewardTreeProgress();
  }

  const weekStartMs = getCurrentWeekStartMs(now);
  const qualifiedNodeIds = new Set();
  rewardTrees.forEach((tree) => {
    (tree.flatNodes || []).forEach((node) => {
      if (!node || !node.isLeafTask) {
        return;
      }
      (node.submissionHistory || []).forEach((item) => {
        const submittedAt = parseSafeDate(item.submittedAt || item.submitted_at);
        if (!submittedAt || submittedAt.getTime() < weekStartMs) {
          return;
        }
        const score = item.teacherScoreValue === null || item.teacherScoreValue === undefined || Number.isNaN(Number(item.teacherScoreValue))
          ? null
          : Number(item.teacherScoreValue);
        if (score === null || score < 8) {
          return;
        }
        qualifiedNodeIds.add(String(node.id));
      });
    });
  });

  const qualifiedCount = qualifiedNodeIds.size;
  return {
    title: '本周作业树进度',
    qualifiedCount,
    targetCount: 2,
    progressPercent: Math.max(0, Math.min(100, Math.round((Math.min(qualifiedCount, 2) / 2) * 100))),
    summaryText: `本周已完成 ${Math.min(qualifiedCount, 2)} / 2 道老师批改且评分 8 分以上的作业题`,
    available: true,
  };
}

function normalizeShareSummaryCalendar(raw) {
  if (!raw || !Array.isArray(raw.cells) || !raw.cells.length) {
    return buildEmptyHeatmapSummary(new Date());
  }

  return {
    monthLabel: raw.month_label || '',
    title: raw.month_label || '本月',
    summaryText: raw.summary_text || '',
    activeDays: Number(raw.active_days || 0),
    reviewedDays: Number(raw.reviewed_days || 0),
    submittedCount: Number(raw.submitted_count || 0),
    weekdayLabels: MONTH_WEEKDAY_LABELS.slice(),
    legendItems: buildHeatmapLegendItems(),
    cells: raw.cells.map((cell, index) => {
      const band = cell && cell.band ? cell.band : 'none';
      const highestScore = cell && cell.highest_score !== undefined ? cell.highest_score : null;
      return {
        key: cell && cell.key ? cell.key : `share-cell-${index}`,
        placeholder: !!(cell && cell.placeholder),
        dayLabel: cell && cell.day_label ? String(cell.day_label) : '',
        hasSubmission: !!(cell && cell.has_submission),
        highestScore,
        scoreText: highestScore === null || highestScore === undefined || Number.isNaN(Number(highestScore))
          ? ''
          : formatNumber(highestScore),
        band,
        bandClass: getHeatmapBandClass(band),
        isToday: !!(cell && cell.is_today),
      };
    }),
  };
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  const num = Number(value);
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

function getScoreClass(value) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return '';
  }
  if (num <= 3) {
    return 'score-low';
  }
  if (num <= 6) {
    return 'score-mid';
  }
  return 'score-high';
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toAbsoluteImageUrl(imageUrl) {
  if (!imageUrl) {
    return '';
  }
  return imageUrl;
}


function formatShareScore(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return '-';
  }
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

function formatShareScoreWithDenominator(value, denominator = 10) {
  const formatted = formatShareScore(value);
  return formatted === '-' ? '-' : `${formatted} / ${denominator}`;
}

function getShareThemeIndex(seed = '') {
  const value = String(seed || '').slice(0, 2);
  const num = Number.parseInt(value || '0', 16);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num % 3;
}

function normalizeShareSummaryHighlights(raw) {
  return Array.isArray(raw)
    ? raw.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 4)
    : [];
}

function buildShareNodeMetrics(raw) {
  return [
    { label: '最高得分', value: formatShareScoreWithDenominator(raw.highest_teacher_score) },
    { label: '提交次数', value: `${Number(raw.submission_count || 0)} 次` },
    { label: '节点得分', value: `${formatShareScore(raw.node_current_score)} / ${formatShareScore(raw.node_total_score)}` },
  ];
}

function buildShareSummaryMetrics(raw, scopeLabel) {
  return [
    { label: `${scopeLabel || '阶段'}提交`, value: `${Number(raw.submission_count || 0)} 次` },
    { label: '覆盖节点', value: `${Number(raw.active_node_count || 0)} 个` },
    { label: '平均评分', value: formatShareScoreWithDenominator(raw.average_teacher_score) },
  ];
}

function buildShareCardModel(raw = {}) {
  const shareKind = raw.share_kind === 'summary' ? 'summary' : 'node';
  const isSummary = shareKind === 'summary';
  const themeIndex = getShareThemeIndex(raw.theme_seed || '');
  const totalScore = Number(raw.tree_total_score || 0);
  const currentScore = Number(raw.tree_current_score || 0);
  const progressPercent = totalScore > 0
    ? Math.max(0, Math.min(100, Math.round((currentScore / totalScore) * 100)))
    : 0;
  const codeSnippet = String(raw.code_snippet || '').trim() || '// 暂无可展示的代码片段';
  const scopeLabel = String(raw.summary_scope_label || '').trim();
  const summaryCalendar = normalizeShareSummaryCalendar(raw.summary_calendar);
  const isMonthSummary = isSummary && String(raw.summary_scope || '').trim() === 'month' && summaryCalendar.cells.some((cell) => !cell.placeholder);
  const metrics = isSummary ? buildShareSummaryMetrics(raw, scopeLabel) : buildShareNodeMetrics(raw);
  const tags = [];
  if (isSummary && scopeLabel) {
    tags.push(scopeLabel);
  } else if (!isSummary) {
    tags.push(raw.tree_type === 'reward' ? '悬赏任务' : '知识学习');
  }
  if (totalScore > 0) {
    tags.push(`进度 ${progressPercent}%`);
  }

  let insightTitle = '';
  let insightMeta = '';
  let insightLines = [];
  if (isSummary) {
    insightTitle = '学习节点';
    insightMeta = '';
    insightLines = normalizeShareSummaryHighlights(raw.summary_highlights);
  } else if (raw.latest_teacher_comment) {
    insightTitle = '老师点评';
    insightMeta = formatDateTime(raw.latest_reviewed_at);
    insightLines = [String(raw.latest_teacher_comment || '').trim()];
  }

  return {
    id: raw.id || '',
    shareKind,
    isSummary,
    scopeLabel,
    shareTitle: raw.share_title || '学习成果卡',
    shareSubtitle: '',
    studentDisplayName: raw.student_display_name || '同学',
    studentLevel: Number(raw.student_level || 0),
    studentTotalPoints: Number(raw.student_total_points || 0),
    nodeName: raw.node_name || '任务点',
    pathText: isSummary ? '' : (raw.node_path || raw.node_name || ''),
    codeSnippet,
    codeLineCount: Number(raw.code_line_count || (codeSnippet ? codeSnippet.split('\n').length : 0)),
    generatedAtText: formatDateTime(raw.created_at),
    latestSubmittedText: formatDateTime(raw.latest_submitted_at),
    metrics,
    tags,
    insightTitle,
    insightMeta,
    insightLines,
    insightText: insightLines.join('\n'),
    coverImageUrl: raw.cover_image_url || '',
    coverImageCount: Number(raw.cover_image_count || 0),
    coverTitle: '附图',
    codeSectionTitle: '代码',
    footerLeftText: totalScore > 0 ? `总进度 ${progressPercent}%` : '总进度待生成',
    footerRightText: `积分 ${Number(raw.student_total_points || 0)}`,
    encouragementText: String(raw.encouragement_text || '').trim(),
    progressPercent,
    themeIndex,
    themeClass: `theme-${themeIndex + 1}`,
    isMonthSummary,
    summaryCalendar,
  };
}

function drawShareRoundedRect(ctx, x, y, width, height, radius, fillColor, strokeColor) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  if (fillColor) {
    ctx.setFillStyle(fillColor);
    ctx.fill();
  }
  if (strokeColor) {
    ctx.setStrokeStyle(strokeColor);
    ctx.stroke();
  }
}

function wrapShareText(ctx, text, maxWidth, maxLines) {
  const source = String(text || '');
  const rawLines = source.split('\n');
  const result = [];
  rawLines.forEach((rawLine) => {
    let current = '';
    Array.from(rawLine).forEach((char) => {
      const candidate = current + char;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        result.push(current);
        current = char;
      } else {
        current = candidate;
      }
    });
    result.push(current || '');
  });
  if (maxLines > 0 && result.length > maxLines) {
    const trimmed = result.slice(0, maxLines);
    trimmed[maxLines - 1] = `${trimmed[maxLines - 1].replace(/[\s…]+$/g, '')}…`;
    return trimmed;
  }
  return result;
}

function fillShareWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const lines = wrapShareText(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
  return y + lines.length * lineHeight;
}

function showShareModalPromise(options) {
  return new Promise((resolve) => {
    wx.showModal({
      ...options,
      success: (resp) => resolve(!!resp.confirm),
      fail: () => resolve(false),
    });
  });
}

function getShareImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
      fail: reject,
    });
  });
}

function inferImageMimeType(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function readFileAsBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (resp) => resolve(resp.data),
      fail: (err) => reject(err),
    });
  });
}

function getProblemAttachmentKind(item = {}) {
  const kind = String(item.problemAttachmentKind || item.problem_attachment_kind || item.kind || '').toLowerCase();
  if (kind === 'pdf' || kind === 'image') {
    return kind;
  }
  const mimeType = String(item.problemAttachmentMimeType || item.problem_attachment_mime_type || item.mimeType || item.mime_type || '').toLowerCase();
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  return '';
}

function getProblemAttachments(node = {}) {
  const rawList = Array.isArray(node.problemAttachments || node.problem_attachments)
    ? (node.problemAttachments || node.problem_attachments)
    : [];
  const normalized = rawList
    .map((item, index) => {
      const url = String(item.url || '').trim();
      if (!url) {
        return null;
      }
      const fileName = String(item.fileName || item.file_name || `题目资料${index + 1}`).trim() || `题目资料${index + 1}`;
      const displayName = String(item.displayName || item.display_name || fileName).trim() || fileName;
      const mimeType = String(item.mimeType || item.mime_type || '').trim();
      const kind = getProblemAttachmentKind({ ...item, mimeType });
      return {
        fileId: String(item.fileId || item.file_id || '').trim(),
        url,
        fileName,
        displayName,
        mimeType,
        kind,
        kindLabel: kind === 'pdf' ? 'PDF 题面' : (kind === 'image' ? '题图附件' : '题目附件'),
        previewUrl: kind === 'image' ? toAbsoluteImageUrl(url) : '',
      };
    })
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }

  const fallbackUrl = String(node.problemAttachmentUrl || node.problem_attachment_url || '').trim();
  if (!fallbackUrl) {
    return [];
  }
  const fileName = String(node.problemAttachmentFileName || node.problem_attachment_file_name || '题目资料').trim() || '题目资料';
  const displayName = String(node.problemAttachmentDisplayName || node.problem_attachment_display_name || fileName).trim() || fileName;
  const mimeType = String(node.problemAttachmentMimeType || node.problem_attachment_mime_type || '').trim();
  const kind = getProblemAttachmentKind(node);
  return [{
    fileId: String(node.problemAttachmentFileId || node.problem_attachment_file_id || '').trim(),
    url: fallbackUrl,
    fileName,
    displayName,
    mimeType,
    kind,
    kindLabel: kind === 'pdf' ? 'PDF 题面' : (kind === 'image' ? '题图附件' : '题目附件'),
    previewUrl: kind === 'image' ? toAbsoluteImageUrl(fallbackUrl) : '',
  }];
}

function getSubmissionFileKind(item = {}) {
  const rawKind = String(item.kind || item.fileKind || item.file_kind || '').toLowerCase();
  if (rawKind) {
    if (rawKind === 'image') {
      return 'image';
    }
    if (rawKind === 'pdf') {
      return 'pdf';
    }
    if (rawKind === 'doc' || rawKind === 'docx') {
      return 'doc';
    }
    if (rawKind === 'code' || rawKind === 'txt' || rawKind === 'text') {
      return 'code';
    }
    return 'file';
  }

  const mimeType = String(item.mimeType || item.mime_type || '').toLowerCase();
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }
  if (
    mimeType === 'application/msword'
    || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'doc';
  }
  if (mimeType.startsWith('text/')) {
    return 'code';
  }

  const fileName = String(item.fileName || item.file_name || item.name || item.url || '').toLowerCase();
  if (/\.(png|jpg|jpeg|gif|bmp|webp|svg)$/.test(fileName)) {
    return 'image';
  }
  if (/\.pdf$/.test(fileName)) {
    return 'pdf';
  }
  if (/\.(doc|docx)$/.test(fileName)) {
    return 'doc';
  }
  if (/\.(cpp|cc|cxx|c|h|hpp|java|py|js|ts|json|md|txt)$/.test(fileName)) {
    return 'code';
  }
  return 'file';
}

function getSubmissionFileKindLabel(kind) {
  if (kind === 'image') {
    return '图片';
  }
  if (kind === 'pdf') {
    return 'PDF';
  }
  if (kind === 'doc') {
    return '文档';
  }
  if (kind === 'code') {
    return '代码';
  }
  return '附件';
}

function getSubmissionFileItems(item = {}) {
  const hasExplicitFileItems = Array.isArray(item.submissionFileItems) || Array.isArray(item.submission_file_items);
  const rawItems = hasExplicitFileItems
    ? (item.submissionFileItems || item.submission_file_items || [])
    : [];
  const normalized = rawItems
    .map((entry, index) => {
      const url = String(entry.url || '').trim();
      if (!url) {
        return null;
      }
      const fileName = String(entry.fileName || entry.file_name || `附件${index + 1}`).trim() || `附件${index + 1}`;
      const mimeType = String(entry.mimeType || entry.mime_type || '').trim();
      const kind = getSubmissionFileKind({ ...entry, fileName, mimeType });
      return {
        url,
        fileName,
        mimeType,
        kind,
        kindLabel: getSubmissionFileKindLabel(kind),
        previewUrl: kind === 'image' ? toAbsoluteImageUrl(url) : '',
      };
    })
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }

  const hasExplicitFileUrls = Array.isArray(item.submissionFileUrls) || Array.isArray(item.submission_file_urls);
  const urlList = hasExplicitFileUrls
    ? (item.submissionFileUrls || item.submission_file_urls || [])
    : [];
  const normalizedUrls = urlList
    .map((url, index) => {
      const normalizedUrl = String(url || '').trim();
      if (!normalizedUrl) {
        return null;
      }
      const fileName = getFileNameFromPath(normalizedUrl, `附件${index + 1}`);
      const kind = getSubmissionFileKind({ url: normalizedUrl, fileName });
      return {
        url: normalizedUrl,
        fileName,
        mimeType: '',
        kind,
        kindLabel: getSubmissionFileKindLabel(kind),
        previewUrl: kind === 'image' ? toAbsoluteImageUrl(normalizedUrl) : '',
      };
    })
    .filter(Boolean);
  if (normalizedUrls.length) {
    return normalizedUrls;
  }

  if (hasExplicitFileItems || hasExplicitFileUrls) {
    return [];
  }

  const fallbackImages = getSubmissionImageItems(item);
  if (fallbackImages.length) {
    return fallbackImages.map((entry) => ({
      ...entry,
      kind: 'image',
      kindLabel: '图片',
    }));
  }

  return [];
}

function getSubmissionImageItems(item = {}) {
  const genericItems = Array.isArray(item.submissionFileItems || item.submission_file_items)
    ? getSubmissionFileItems(item).filter((entry) => entry.kind === 'image')
    : [];
  if (genericItems.length) {
    return genericItems;
  }

  const rawItems = Array.isArray(item.codeImageItems || item.code_image_items)
    ? (item.codeImageItems || item.code_image_items)
    : [];
  const normalized = rawItems
    .map((entry, index) => {
      const url = String(entry.url || entry.code_image_url || '').trim();
      if (!url) {
        return null;
      }
      return {
        url,
        fileName: String(entry.fileName || entry.file_name || `图片${index + 1}`).trim() || `图片${index + 1}`,
        mimeType: String(entry.mimeType || entry.mime_type || '').trim(),
        kind: 'image',
        kindLabel: '图片',
        previewUrl: toAbsoluteImageUrl(url),
      };
    })
    .filter(Boolean);
  if (normalized.length) {
    return normalized;
  }

  const urlList = Array.isArray(item.codeImageUrls || item.code_image_urls)
    ? (item.codeImageUrls || item.code_image_urls)
    : [];
  if (urlList.length) {
    return urlList
      .map((url, index) => ({
        url: String(url || '').trim(),
        fileName: `图片${index + 1}`,
        mimeType: '',
        kind: 'image',
        kindLabel: '图片',
        previewUrl: toAbsoluteImageUrl(url),
      }))
      .filter((entry) => entry.url);
  }

  const fallbackUrl = String(item.codeImageUrl || item.code_image_url || '').trim();
  return fallbackUrl
    ? [{
      url: fallbackUrl,
      fileName: '图片1',
      mimeType: '',
      kind: 'image',
      kindLabel: '图片',
      previewUrl: toAbsoluteImageUrl(fallbackUrl),
    }]
    : [];
}

function getSubmissionNonImageItems(item = {}) {
  return getSubmissionFileItems(item).filter((entry) => entry.kind !== 'image');
}

function getFileNameFromPath(filePath, fallbackName) {
  const rawName = String(filePath || '').split(/[\\/]/).pop() || '';
  return rawName || fallbackName;
}

function buildDraftImageViewItems(items = []) {
  return items
    .map((item, index) => ({
      key: item.key || `draft-${index}`,
      fileName: String(item.fileName || `提交图片${index + 1}`).trim() || `提交图片${index + 1}`,
      previewUrl: item.tempFilePath || item.previewUrl || '',
    }))
    .filter((item) => item.previewUrl);
}

function buildDraftFileViewItems(items = []) {
  return items
    .map((item, index) => {
      const fileName = String(item.fileName || `提交附件${index + 1}`).trim() || `提交附件${index + 1}`;
      const kind = getSubmissionFileKind(item);
      return {
        key: item.key || `draft-file-${index}`,
        fileName,
        mimeType: String(item.mimeType || '').trim(),
        kind,
        kindLabel: getSubmissionFileKindLabel(kind),
      };
    })
    .filter((item) => item.fileName);
}

function downloadRemoteFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (resp) => {
        if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.tempFilePath) {
          resolve(resp);
          return;
        }
        reject(new Error('下载题目资料失败'));
      },
      fail: (err) => reject(err),
    });
  });
}

function downloadCloudFile(fileId) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID: fileId,
      success: resolve,
      fail: reject,
    });
  });
}

async function resolveProblemAttachmentDownloadFileId(nodeId, attachment = {}) {
  const rawFileId = String(attachment.fileId || '').trim();
  if (!rawFileId) {
    return '';
  }
  if (rawFileId.startsWith('cloud://')) {
    return rawFileId;
  }

  const result = await request('/api/student/problem-attachments/download-file', {
    method: 'POST',
    data: {
      nodeId,
      fileId: rawFileId,
    },
  });
  return String(result.fileId || '').trim();
}

async function downloadProblemAttachmentFile(nodeId, attachment = {}) {
  const downloadFileId = await resolveProblemAttachmentDownloadFileId(nodeId, attachment);
  if (downloadFileId) {
    return downloadCloudFile(downloadFileId);
  }
  if (!attachment.url) {
    throw new Error('题目资料下载地址不存在');
  }
  return downloadRemoteFile(attachment.url);
}

async function resolveProblemAttachmentPreviewInfo(nodeId, attachment = {}) {
  const rawFileId = String(attachment.fileId || '').trim();
  if (rawFileId) {
    const result = await request('/api/student/problem-attachments/preview-url', {
      method: 'POST',
      data: {
        nodeId,
        fileId: rawFileId,
      },
    });
    return {
      url: String(result.url || '').trim(),
      fileName: String(result.fileName || attachment.fileName || '题目资料.pdf').trim() || '题目资料.pdf',
      mimeType: String(result.mimeType || attachment.mimeType || '').trim(),
    };
  }

  return {
    url: String(attachment.url || '').trim(),
    fileName: String(attachment.fileName || '题目资料.pdf').trim() || '题目资料.pdf',
    mimeType: String(attachment.mimeType || '').trim(),
  };
}

function openLocalDocument(filePath, fileType = 'pdf') {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType,
      showMenu: true,
      success: resolve,
      fail: reject,
    });
  });
}


function chooseSummaryShareScope() {
  const options = [
    { label: '本周报告', value: 'week' },
    { label: '本月报告', value: 'month' },
    { label: '最近10次提交', value: 'recent10' },
  ];
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: options.map((item) => item.label),
      success: (resp) => resolve(options[resp.tapIndex] || null),
      fail: () => resolve(null),
    });
  });
}

function saveTempFile(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: resolve,
      fail: reject,
    });
  });
}

function saveImageToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: reject,
    });
  });
}

function inferDraftFileMimeType(fileName) {
  const lowerName = String(fileName || '').toLowerCase();
  if (/\.(png|jpg|jpeg|gif|bmp|webp|svg)$/.test(lowerName)) {
    return inferImageMimeType(lowerName);
  }
  if (/\.pdf$/.test(lowerName)) {
    return 'application/pdf';
  }
  if (/\.doc$/.test(lowerName)) {
    return 'application/msword';
  }
  if (/\.docx$/.test(lowerName)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (/\.(cpp|cc|cxx|c|h|hpp|java|py|js|ts|json|md|txt)$/.test(lowerName)) {
    return 'text/plain';
  }
  return '';
}

function inferDocumentFileType(fileName, mimeType) {
  const lowerMime = String(mimeType || '').toLowerCase();
  const lowerName = String(fileName || '').toLowerCase();
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'pdf';
  }
  if (lowerMime === 'application/msword' || lowerName.endsWith('.doc')) {
    return 'doc';
  }
  if (
    lowerMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || lowerName.endsWith('.docx')
  ) {
    return 'docx';
  }
  if (lowerName.endsWith('.xls')) {
    return 'xls';
  }
  if (lowerName.endsWith('.xlsx')) {
    return 'xlsx';
  }
  if (lowerName.endsWith('.ppt')) {
    return 'ppt';
  }
  if (lowerName.endsWith('.pptx')) {
    return 'pptx';
  }
  if (
    lowerMime.startsWith('text/')
    || /\.(cpp|cc|cxx|c|h|hpp|java|py|js|ts|json|md|txt)$/.test(lowerName)
  ) {
    return 'txt';
  }
  return '';
}

function getDraftImageKey(nodeId) {
  return `node:${String(nodeId)}`;
}

function formatStudentName(student) {
  if (!student) {
    return '';
  }
  const prefix = student.name
    ? `${student.username} (${student.name})`
    : student.username;
  return `${prefix} / Lv.${student.level || 0} / 积分 ${student.total_points || 0}`;
}

function buildPageSummary(trees) {
  const learningTrees = (Array.isArray(trees) ? trees : []).filter((tree) => String(tree.treeType || '') !== 'reward');
  const availableTasks = learningTrees.reduce((sum, tree) => sum + Number(tree.stats.totalTasks || 0), 0);
  const scoredTasks = learningTrees.reduce((sum, tree) => sum + Number(tree.stats.scoredTasks || 0), 0);
  const currentScoreValue = learningTrees.reduce((sum, tree) => sum + Number(tree.stats.currentScoreValue || 0), 0);
  const totalScoreValue = learningTrees.reduce((sum, tree) => sum + Number(tree.stats.totalScoreValue || 0), 0);
  const progressPercent = totalScoreValue > 0
    ? Math.max(0, Math.min(100, Math.round((currentScoreValue / totalScoreValue) * 100)))
    : 0;

  return {
    treeCount: learningTrees.length,
    availableTasks,
    scoredTasks,
    currentScoreValue,
    totalScoreValue,
    currentScoreText: formatNumber(currentScoreValue) || '0',
    totalScoreText: formatNumber(totalScoreValue) || '0',
    progressPercent,
    overviewText: availableTasks
      ? `已完成 ${scoredTasks} / ${availableTasks} 个知识任务点，学习树整体进度 ${progressPercent}%`
      : '当前还没有开放的知识学习任务点，等待老师布置新的章节。',
  };
}

function getConstellationSceneConfig(sceneType = 'knowledge') {
  return CONSTELLATION_SCENE_CONFIG[sceneType] || CONSTELLATION_SCENE_CONFIG.knowledge;
}

function buildEmptyConstellationScene(sceneType = 'knowledge') {
  const config = getConstellationSceneConfig(sceneType);
  return {
    sceneType,
    title: config.title,
    progressPercent: 0,
    summaryText: '当前还没有可点亮的节点。',
    stageText: '从第一道题开始，让这棵树慢慢亮起来。',
    hintText: config.hintText,
    emptyText: config.emptyText,
    litNodeCount: 0,
    totalNodeCount: 0,
    glowingLinkCount: 0,
    themeClass: config.themeClass,
    graph: {
      nodes: [],
      edges: [],
    },
  };
}

function buildEmptyKnowledgeScene() {
  return buildEmptyConstellationScene('knowledge');
}

function buildEmptyRewardScene() {
  return buildEmptyConstellationScene('reward');
}

function getConstellationRelevantTrees(trees = [], sceneType = 'knowledge') {
  return (Array.isArray(trees) ? trees : []).filter((tree) => {
    const treeType = String(tree.treeType || '');
    return sceneType === 'reward' ? treeType === 'reward' : treeType !== 'reward';
  });
}

function buildConstellationLayout(nodes = [], edges = [], rootId = '', sceneType = 'knowledge') {
  const nodeMap = new Map(nodes.map((node) => [String(node.id), { ...node }]));
  const validEdges = edges.filter((edge) => nodeMap.has(String(edge.sourceId)) && nodeMap.has(String(edge.targetId)));
  const childrenByParent = new Map();
  validEdges.forEach((edge) => {
    const parentId = String(edge.sourceId);
    const childIds = childrenByParent.get(parentId) || [];
    childIds.push(String(edge.targetId));
    childrenByParent.set(parentId, childIds);
  });

  const root = nodeMap.get(String(rootId));
  if (!root) {
    return {
      nodes: [],
      edges: [],
    };
  }

  const sceneConfig = sceneType === 'reward'
    ? {
      rootYOffset: 78,
      rootAngleStart: -156,
      rootAngleEnd: 18,
      distanceBase: 138,
      distanceGain: 26,
      branchFloor: 42,
      depthWave: 46,
      rootPointSize: 15,
    }
    : {
      rootYOffset: 84,
      rootAngleStart: -164,
      rootAngleEnd: 14,
      distanceBase: 148,
      distanceGain: 30,
      branchFloor: 46,
      depthWave: 54,
      rootPointSize: 16,
    };

  function getSeedRatio(seed) {
    return Array.from(String(seed || '')).reduce((sum, char, index) => {
      return (sum + char.charCodeAt(0) * (index + 3)) % 997;
    }, 0) / 997;
  }

  const subtreeSpanCache = new Map();
  function getSubtreeSpan(nodeId) {
    const key = String(nodeId);
    if (subtreeSpanCache.has(key)) {
      return subtreeSpanCache.get(key);
    }
    const childIds = childrenByParent.get(key) || [];
    if (!childIds.length) {
      subtreeSpanCache.set(key, 1);
      return 1;
    }
    const span = childIds.reduce((sum, childId) => sum + getSubtreeSpan(childId), 0);
    const nextSpan = Math.max(1, span);
    subtreeSpanCache.set(key, nextSpan);
    return nextSpan;
  }

  function getPointSize(node) {
    if (node.isRoot) {
      return sceneConfig.rootPointSize;
    }
    if (node.depth === 1) {
      return 9.6;
    }
    return node.isLeafTask ? 6.4 : 7.3;
  }

  function placeNode(nodeId, depth, angleStart, angleEnd, parentId) {
    const key = String(nodeId);
    const node = nodeMap.get(key);
    if (!node) {
      return;
    }

    const childIds = childrenByParent.get(key) || [];
    const seedRatio = getSeedRatio(key);
    const parent = parentId ? nodeMap.get(String(parentId)) : null;

    if (!parent) {
      node.worldX = 0;
      node.worldY = sceneConfig.rootYOffset;
      node.worldZ = 0;
      node.pointSize = getPointSize(node);
    } else {
      const angleMid = (angleStart + angleEnd) / 2;
      const jitterLimit = Math.min(16, Math.max(6, (angleEnd - angleStart) * 0.18));
      const angle = angleMid + (seedRatio - 0.5) * jitterLimit;
      const angleRad = angle * Math.PI / 180;
      const spanBoost = Math.min(30, getSubtreeSpan(key) * 7);
      const distance = sceneConfig.distanceBase + (depth - 1) * sceneConfig.distanceGain + spanBoost;
      const orbitWave = Math.cos((depth + seedRatio) * 1.18) * sceneConfig.depthWave;

      node.worldX = parent.worldX + Math.cos(angleRad) * distance;
      node.worldY = parent.worldY + Math.sin(angleRad) * distance * 0.92 + depth * 10;
      node.worldZ = parent.worldZ * 0.24 + orbitWave + Math.sin(angleRad * 1.62) * 22;
      node.pointSize = getPointSize(node);
    }

    if (!childIds.length) {
      return;
    }

    const totalChildSpan = childIds.reduce((sum, childId) => sum + getSubtreeSpan(childId), 0) || childIds.length;
    let cursor = angleStart;
    childIds.forEach((childId) => {
      const childSpan = getSubtreeSpan(childId);
      const sectorSpan = Math.max(sceneConfig.branchFloor, ((angleEnd - angleStart) * childSpan) / totalChildSpan);
      const childCenter = cursor + sectorSpan / 2;
      const childSpread = Math.max(sceneConfig.branchFloor, sectorSpan * (childIds.length > 2 ? 0.82 : 0.72));
      placeNode(
        childId,
        depth + 1,
        childCenter - childSpread / 2,
        childCenter + childSpread / 2,
        key,
      );
      cursor += sectorSpan;
    });
  }

  placeNode(rootId, 0, sceneConfig.rootAngleStart, sceneConfig.rootAngleEnd, '');

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  [...nodeMap.values()].forEach((node) => {
    minX = Math.min(minX, Number(node.worldX || 0));
    maxX = Math.max(maxX, Number(node.worldX || 0));
    minY = Math.min(minY, Number(node.worldY || 0));
    maxY = Math.max(maxY, Number(node.worldY || 0));
    minZ = Math.min(minZ, Number(node.worldZ || 0));
    maxZ = Math.max(maxZ, Number(node.worldZ || 0));
  });

  const rawWidth = Math.max(1, maxX - minX);
  const rawHeight = Math.max(1, maxY - minY);
  const rawDepth = Math.max(1, maxZ - minZ);
  const targetWidth = sceneType === 'reward' ? 404 : 432;
  const targetHeight = sceneType === 'reward' ? 312 : 334;
  const targetDepth = sceneType === 'reward' ? 170 : 188;
  const normalizeScale = Math.min(targetWidth / rawWidth, targetHeight / rawHeight, targetDepth / rawDepth);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;

  return {
    nodes: [...nodeMap.values()].map((node) => ({
      ...node,
      worldX: (Number(node.worldX || 0) - centerX) * normalizeScale,
      worldY: (Number(node.worldY || 0) - centerY) * normalizeScale,
      worldZ: (Number(node.worldZ || 0) - centerZ) * normalizeScale,
      pointSize: Number(node.pointSize || 8),
    })),
    edges: validEdges.map((edge) => ({
      ...edge,
      sourceId: String(edge.sourceId),
      targetId: String(edge.targetId),
    })),
  };
}

function buildConstellationSceneFromTrees(trees = [], sceneType = 'knowledge') {
  const config = getConstellationSceneConfig(sceneType);
  const relevantTrees = getConstellationRelevantTrees(trees, sceneType);
  if (!relevantTrees.length) {
    return buildEmptyConstellationScene(sceneType);
  }

  const sceneRootId = `${sceneType}-scene-root`;
  const sceneNodeMap = new Map();
  const sceneEdges = [];

  sceneNodeMap.set(sceneRootId, {
    id: sceneRootId,
    label: config.rootLabel,
    depth: 0,
    unlocked: true,
    isRoot: true,
    isLeafTask: false,
    litSeed: false,
    activeSeed: true,
    currentScoreValue: 0,
    taskCount: 0,
    scoredTaskCount: 0,
  });

  relevantTrees.forEach((tree) => {
    (tree.flatNodes || []).forEach((node) => {
      if (!node || Number(node.depth || 0) <= 0) {
        return;
      }
      const nodeId = String(node.id);
      const rawLeafScore = node.highestTeacherScore === null || node.highestTeacherScore === undefined || Number.isNaN(Number(node.highestTeacherScore))
        ? null
        : Number(node.highestTeacherScore);
      const scoreValue = node.isLeafTask
        ? (rawLeafScore === null ? 0 : rawLeafScore)
        : Number(node.currentScoreValue || 0);
      const unlocked = !!node.unlocked;
      const litSeed = unlocked && (
        (node.isLeafTask && rawLeafScore !== null && rawLeafScore >= CONSTELLATION_GLOW_SCORE)
        || (!node.isLeafTask && Number(node.currentScoreValue || 0) >= CONSTELLATION_GLOW_SCORE)
      );
      const activeSeed = unlocked && (
        (node.isLeafTask && (Number(node.submissionCount || 0) > 0 || (rawLeafScore !== null && rawLeafScore > 0)))
        || (!node.isLeafTask && (Number(node.currentScoreValue || 0) > 0 || Number(node.scoredTaskCount || 0) > 0))
      );

      sceneNodeMap.set(nodeId, {
        id: nodeId,
        label: String(node.name || '未命名节点'),
        depth: Number(node.depth || 0),
        parentId: Number(node.depth || 0) === 1 ? sceneRootId : String(node.parentId || sceneRootId),
        unlocked,
        isRoot: false,
        isLeafTask: !!node.isLeafTask,
        litSeed,
        activeSeed,
        currentScoreValue: Number(node.currentScoreValue || 0),
        taskCount: Number(node.taskCount || 0),
        scoredTaskCount: Number(node.scoredTaskCount || 0),
        highestTeacherScore: rawLeafScore,
        progressText: node.nodeProgressTaskText || '',
      });
      sceneEdges.push({
        sourceId: Number(node.depth || 0) === 1 ? sceneRootId : String(node.parentId || sceneRootId),
        targetId: nodeId,
      });
    });
  });

  if (sceneNodeMap.size <= 1) {
    return buildEmptyConstellationScene(sceneType);
  }

  const childrenByParent = new Map();
  sceneEdges.forEach((edge) => {
    const parentId = String(edge.sourceId);
    const childIds = childrenByParent.get(parentId) || [];
    childIds.push(String(edge.targetId));
    childrenByParent.set(parentId, childIds);
  });

  const resolvedState = new Map();
  function resolveNodeState(nodeId) {
    const key = String(nodeId);
    if (resolvedState.has(key)) {
      return resolvedState.get(key);
    }
    const node = sceneNodeMap.get(key);
    if (!node) {
      const emptyState = { lit: false, active: false };
      resolvedState.set(key, emptyState);
      return emptyState;
    }
    const childIds = childrenByParent.get(key) || [];
    const childStates = childIds.map((childId) => resolveNodeState(childId));
    const lit = !!node.litSeed || childStates.some((childState) => childState.lit);
    const active = node.isRoot ? true : (!!node.activeSeed || lit || childStates.some((childState) => childState.active));
    const nextState = { lit, active };
    resolvedState.set(key, nextState);
    return nextState;
  }

  [...sceneNodeMap.keys()].forEach((nodeId) => resolveNodeState(nodeId));

  const nodes = [...sceneNodeMap.values()].map((node) => {
    const state = resolvedState.get(String(node.id)) || { lit: false, active: false };
    return {
      ...node,
      lit: state.lit,
      active: state.active,
    };
  });
  const nodeLookup = new Map(nodes.map((node) => [String(node.id), node]));
  const edges = sceneEdges
    .filter((edge) => nodeLookup.has(String(edge.sourceId)) && nodeLookup.has(String(edge.targetId)))
    .map((edge) => {
      const sourceNode = nodeLookup.get(String(edge.sourceId));
      const targetNode = nodeLookup.get(String(edge.targetId));
      return {
        sourceId: String(edge.sourceId),
        targetId: String(edge.targetId),
        glow: !!(sourceNode && targetNode && sourceNode.lit && targetNode.lit),
        active: !!(sourceNode && targetNode && (sourceNode.active || targetNode.active)),
      };
    });

  const graph = buildConstellationLayout(nodes, edges, sceneRootId, sceneType);
  const totalNodeCount = nodes.filter((node) => !node.isRoot).length;
  const litNodeCount = nodes.filter((node) => !node.isRoot && node.lit).length;
  const glowingLinkCount = edges.filter((edge) => edge.glow).length;
  const currentScoreValue = relevantTrees.reduce((sum, tree) => sum + Number((tree.stats && tree.stats.currentScoreValue) || 0), 0);
  const totalScoreValue = relevantTrees.reduce((sum, tree) => sum + Number((tree.stats && tree.stats.totalScoreValue) || 0), 0);
  const progressPercent = totalScoreValue > 0
    ? Math.max(0, Math.min(100, Math.round((currentScoreValue / totalScoreValue) * 100)))
    : 0;

  let stageText = '先完成第一批节点，让星图从暗处亮起来。';
  if (progressPercent >= 82) {
    stageText = sceneType === 'reward'
      ? '悬赏星图已经连成高亮主网，继续冲击更高分。'
      : '知识点主干已经被完全点亮，整张星图开始形成清晰轮廓。';
  } else if (progressPercent >= 45) {
    stageText = sceneType === 'reward'
      ? '已经有部分悬赏节点开始发光，继续冲高分会点亮更多连线。'
      : '你已经点亮了中段主枝，继续推进会让更多连线发光。';
  } else if (litNodeCount > 0) {
    stageText = sceneType === 'reward'
      ? '第一批悬赏节点已被点亮，继续拿到高分会扩散到更多星点。'
      : '已经出现第一批亮点节点，继续提交会让整张星图更像一片星座。';
  }

  return {
    sceneType,
    title: config.title,
    progressPercent,
    summaryText: totalNodeCount
      ? `8分+ 节点 ${litNodeCount}/${totalNodeCount}`
      : '当前还没有可点亮的节点。',
    stageText,
    hintText: config.hintText,
    emptyText: config.emptyText,
    litNodeCount,
    totalNodeCount,
    glowingLinkCount,
    themeClass: config.themeClass,
    graph,
  };
}

function buildKnowledgeSceneFromTrees(trees = []) {
  return buildConstellationSceneFromTrees(trees, 'knowledge');
}

function buildRewardSceneFromTrees(trees = []) {
  return buildConstellationSceneFromTrees(trees, 'reward');
}

function createConstellationStars(sceneType = 'knowledge', width = 0, height = 0) {
  const count = sceneType === 'reward' ? 18 : 22;
  return Array.from({ length: count }, (_, index) => ({
    x: ((index * 73) % 97) / 97 * width,
    y: (((index * 37) + 19) % 89) / 89 * Math.max(height * 0.78, 1),
    radius: 0.8 + (index % 4) * 0.46,
    alpha: 0.12 + (index % 5) * 0.05,
    drift: 0.9 + (index % 6) * 0.18,
    phase: index * 0.72 + (sceneType === 'reward' ? 0.8 : 0.2),
  }));
}

function traceConstellationRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillConstellationRoundedRect(ctx, x, y, width, height, radius, fillColor, strokeColor) {
  traceConstellationRoundedRect(ctx, x, y, width, height, radius);
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.stroke();
  }
}

function getConstellationTheme(sceneType = 'knowledge') {
  if (sceneType === 'reward') {
    return {
      backgroundTop: '#071824',
      backgroundBottom: '#04111a',
      halo: 'rgba(47, 243, 214, 0.14)',
      haloAlt: 'rgba(77, 164, 255, 0.14)',
      linkDim: 'rgba(86, 152, 182, 0.18)',
      linkActive: 'rgba(74, 211, 255, 0.38)',
      linkGlow: 'rgba(121, 255, 223, 0.88)',
      nodeDim: '#17324b',
      nodeActive: '#2e7597',
      nodeGlow: '#7bf5db',
      labelFill: 'rgba(6, 18, 28, 0.84)',
      labelStroke: 'rgba(92, 186, 208, 0.16)',
      labelText: '#e9fffb',
      labelDimText: 'rgba(187, 219, 226, 0.76)',
      rootGlow: '#a8fff0',
      star: 'rgba(168, 255, 240, 0.88)',
    };
  }
  return {
    backgroundTop: '#09182d',
    backgroundBottom: '#050f1c',
    halo: 'rgba(74, 143, 255, 0.18)',
    haloAlt: 'rgba(75, 234, 255, 0.12)',
    linkDim: 'rgba(84, 118, 168, 0.18)',
    linkActive: 'rgba(88, 166, 255, 0.42)',
    linkGlow: 'rgba(132, 221, 255, 0.92)',
    nodeDim: '#172944',
    nodeActive: '#2f6bbd',
    nodeGlow: '#8bdcff',
    labelFill: 'rgba(8, 19, 35, 0.84)',
    labelStroke: 'rgba(109, 161, 241, 0.16)',
    labelText: '#edf6ff',
    labelDimText: 'rgba(189, 210, 238, 0.76)',
    rootGlow: '#c8f0ff',
    star: 'rgba(186, 228, 255, 0.86)',
  };
}

function computeConstellationRawProjection(node, runtime) {
  const x = Number(node.worldX || 0);
  const y = Number(node.worldY || 0);
  const z = Number(node.worldZ || 0);
  const cosY = Math.cos(runtime.rotationY);
  const sinY = Math.sin(runtime.rotationY);
  const cosX = Math.cos(runtime.rotationX);
  const sinX = Math.sin(runtime.rotationX);

  const rotatedX = x * cosY - z * sinY;
  const rotatedZ = x * sinY + z * cosY;
  const rotatedY = y * cosX - rotatedZ * sinX;
  const depthZ = y * sinX + rotatedZ * cosX;
  const perspective = runtime.cameraDistance / (runtime.cameraDistance - depthZ);
  return {
    rawX: rotatedX * perspective,
    rawY: -rotatedY * perspective,
    z: depthZ,
    perspective,
  };
}

function projectConstellationPoint(node, runtime, rawProjection) {
  const raw = rawProjection || computeConstellationRawProjection(node, runtime);
  const fitScale = Number(runtime.fitScale || 1);
  const fitOffsetX = runtime.fitOffsetX !== undefined ? Number(runtime.fitOffsetX) : runtime.width / 2;
  const fitOffsetY = runtime.fitOffsetY !== undefined ? Number(runtime.fitOffsetY) : runtime.baseLineY;
  return {
    x: fitOffsetX + raw.rawX * fitScale,
    y: fitOffsetY + raw.rawY * fitScale,
    z: raw.z,
    scale: raw.perspective * fitScale,
    perspective: raw.perspective,
  };
}

function drawConstellationSceneFrame(runtime) {
  if (!runtime || !runtime.ctx || !runtime.scene) {
    return;
  }

  const scene = runtime.scene;
  const ctx = runtime.ctx;
  const width = runtime.width;
  const height = runtime.height;
  const now = Date.now() * 0.001;
  const theme = getConstellationTheme(scene.sceneType);

  ctx.clearRect(0, 0, width, height);

  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, theme.backgroundTop);
  background.addColorStop(1, theme.backgroundBottom);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const halo = ctx.createRadialGradient(width * 0.5, height * 0.12, 0, width * 0.5, height * 0.12, width * 0.5);
  halo.addColorStop(0, theme.halo);
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  const haloAlt = ctx.createRadialGradient(width * 0.24, height * 0.24, 0, width * 0.24, height * 0.24, width * 0.34);
  haloAlt.addColorStop(0, theme.haloAlt);
  haloAlt.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = haloAlt;
  ctx.fillRect(0, 0, width, height);

  (runtime.stars || []).forEach((star) => {
    const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * star.drift + star.phase));
    ctx.globalAlpha = star.alpha * twinkle;
    ctx.fillStyle = theme.star;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  const nodes = Array.isArray(scene.graph && scene.graph.nodes) ? scene.graph.nodes : [];
  const edges = Array.isArray(scene.graph && scene.graph.edges) ? scene.graph.edges : [];
  if (!nodes.length) {
    return;
  }

  const rawProjectedNodes = nodes.map((node) => ({
    ...node,
    rawProjection: computeConstellationRawProjection(node, runtime),
  }));
  let minRawX = Infinity;
  let maxRawX = -Infinity;
  let minRawY = Infinity;
  let maxRawY = -Infinity;
  rawProjectedNodes.forEach((node) => {
    const raw = node.rawProjection;
    const approxRadius = Math.max(node.isRoot ? 14 : 8, Number(node.pointSize || 7) * raw.perspective);
    const labelReserve = Math.min(72, 16 + String(node.label || '').length * 6);
    minRawX = Math.min(minRawX, raw.rawX - approxRadius - labelReserve);
    maxRawX = Math.max(maxRawX, raw.rawX + approxRadius + labelReserve);
    minRawY = Math.min(minRawY, raw.rawY - approxRadius - 28);
    maxRawY = Math.max(maxRawY, raw.rawY + approxRadius + 36);
  });
  const safeLeft = width * 0.04;
  const safeRight = width * 0.96;
  const safeTop = 18;
  const safeBottom = Math.max(safeTop + 210, height - 118);
  const rawWidth = Math.max(1, maxRawX - minRawX);
  const rawHeight = Math.max(1, maxRawY - minRawY);
  const fitScale = Math.min(
    (safeRight - safeLeft) / rawWidth,
    (safeBottom - safeTop) / rawHeight,
    3.2,
  );
  runtime.fitScale = Math.max(0.52, Math.min(2.9, fitScale * 1.28));
  runtime.fitOffsetX = (safeLeft + safeRight) / 2 - ((minRawX + maxRawX) / 2) * runtime.fitScale;
  runtime.fitOffsetY = (safeTop + safeBottom) / 2 - ((minRawY + maxRawY) / 2) * runtime.fitScale;

  const projectedNodes = rawProjectedNodes.map((node) => ({
    ...node,
    projected: projectConstellationPoint(node, runtime, node.rawProjection),
  }));
  const nodeLookup = new Map(projectedNodes.map((node) => [String(node.id), node]));
  const projectedEdges = edges
    .map((edge) => ({
      ...edge,
      source: nodeLookup.get(String(edge.sourceId)),
      target: nodeLookup.get(String(edge.targetId)),
    }))
    .filter((edge) => edge.source && edge.target)
    .sort((left, right) => ((left.source.projected.z + left.target.projected.z) / 2) - ((right.source.projected.z + right.target.projected.z) / 2));

  ctx.lineCap = 'round';
  projectedEdges.forEach((edge) => {
    const source = edge.source.projected;
    const target = edge.target.projected;
    const averageScale = (source.scale + target.scale) / 2;
    const opacity = edge.glow ? 0.96 : (edge.active ? 0.56 : 0.24);
    const widthScale = edge.glow ? 2.8 : (edge.active ? 2.05 : 1.36);

    if (edge.glow) {
      ctx.save();
      ctx.strokeStyle = theme.linkGlow;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = widthScale * averageScale * 3.8;
      ctx.shadowBlur = 22;
      ctx.shadowColor = theme.linkGlow;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = edge.glow ? theme.linkGlow : (edge.active ? theme.linkActive : theme.linkDim);
    ctx.globalAlpha = opacity;
    ctx.lineWidth = widthScale * averageScale;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.restore();
  });

  projectedNodes.sort((left, right) => left.projected.z - right.projected.z).forEach((node) => {
    const projected = node.projected;
    const baseRadius = Math.max(
      node.isRoot ? 4.8 : 1.45,
      Number(node.pointSize || 7) * (node.lit ? projected.perspective * 0.16 : projected.perspective * 0.085),
    );

    if (node.lit) {
      const glowRadius = baseRadius * (node.isRoot ? 6.2 : 4.6);
      const glowGradient = ctx.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, glowRadius);
      glowGradient.addColorStop(0, node.isRoot ? 'rgba(236, 250, 255, 0.96)' : 'rgba(255, 255, 255, 0.82)');
      glowGradient.addColorStop(0.2, node.isRoot ? 'rgba(200, 244, 255, 0.72)' : 'rgba(142, 220, 255, 0.62)');
      glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.save();
      ctx.globalAlpha = 0.94;
      ctx.fillStyle = glowGradient;
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const rayLength = glowRadius * (node.isRoot ? 0.92 : 0.82);
      ctx.save();
      ctx.strokeStyle = node.isRoot ? theme.rootGlow : theme.nodeGlow;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = Math.max(0.8, baseRadius * 0.34);
      ctx.shadowBlur = 12;
      ctx.shadowColor = node.isRoot ? theme.rootGlow : theme.nodeGlow;
      ctx.beginPath();
      ctx.moveTo(projected.x - rayLength, projected.y);
      ctx.lineTo(projected.x + rayLength, projected.y);
      ctx.moveTo(projected.x, projected.y - rayLength);
      ctx.lineTo(projected.x, projected.y + rayLength);
      ctx.moveTo(projected.x - rayLength * 0.68, projected.y - rayLength * 0.68);
      ctx.lineTo(projected.x + rayLength * 0.68, projected.y + rayLength * 0.68);
      ctx.moveTo(projected.x - rayLength * 0.68, projected.y + rayLength * 0.68);
      ctx.lineTo(projected.x + rayLength * 0.68, projected.y - rayLength * 0.68);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = node.lit ? 1 : (node.active ? 0.58 : 0.3);
    ctx.fillStyle = node.lit
      ? 'rgba(255, 255, 255, 0.98)'
      : 'rgba(243, 247, 255, 0.92)';
    ctx.shadowBlur = node.lit ? 8 : (node.active ? 4 : 0);
    ctx.shadowColor = node.lit
      ? (node.isRoot ? theme.rootGlow : theme.nodeGlow)
      : 'rgba(188, 215, 255, 0.22)';
    ctx.beginPath();
    ctx.arc(projected.x, projected.y, baseRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const label = String(node.label || '').trim();
    if (!label) {
      return;
    }

    const seed = Array.from(String(node.id || node.label || '')).reduce((sum, char, index) => {
      return (sum + char.charCodeAt(0) * (index + 5)) % 997;
    }, 0);
    const side = seed % 2 === 0 ? 1 : -1;
    const verticalJitter = ((seed % 5) - 2) * 3;
    const fontSize = Math.max(7.8, Math.min(10.2, 7.2 + projected.perspective * 0.96));
    ctx.save();
    ctx.font = `${node.isRoot ? 700 : 500} ${fontSize}px sans-serif`;
    ctx.textAlign = side > 0 ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = node.lit ? 0.82 : (node.active ? 0.4 : 0.22);
    ctx.fillStyle = node.lit ? theme.labelText : 'rgba(222, 232, 246, 0.88)';
    ctx.shadowBlur = node.lit ? 8 : 3;
    ctx.shadowColor = node.lit ? (node.isRoot ? theme.rootGlow : theme.nodeGlow) : 'rgba(255, 255, 255, 0.10)';
    ctx.fillText(
      label,
      projected.x + side * (baseRadius + 8),
      projected.y + verticalJitter,
    );
    ctx.restore();
  });
}

function decorateSubmission(item) {
  const teacherScoreValue = item.teacher_score === null || item.teacher_score === undefined
    ? null
    : Number(item.teacher_score);
  const fileItems = getSubmissionFileItems(item);
  const imageItems = fileItems.filter((entry) => entry.kind === 'image');
  const nonImageFileItems = fileItems.filter((entry) => entry.kind !== 'image');
  const firstImage = imageItems[0] || null;
  return {
    id: item.id,
    codeText: item.code_text || '',
    codeImageUrl: firstImage ? firstImage.url : '',
    imagePreviewUrl: firstImage ? firstImage.previewUrl : '',
    fileItems,
    imageItems,
    nonImageFileItems,
    imagePreviewUrls: imageItems.map((entry) => entry.previewUrl).filter(Boolean),
    submittedAt: item.submitted_at || '',
    submittedAtText: formatDateTime(item.submitted_at),
    teacherScoreValue,
    teacherScoreText: teacherScoreValue === null || Number.isNaN(teacherScoreValue)
      ? '-'
      : formatNumber(teacherScoreValue),
    teacherScoreClass: teacherScoreValue === null || Number.isNaN(teacherScoreValue)
      ? ''
      : getScoreClass(teacherScoreValue),
    teacherComment: item.teacher_comment || '',
    scoredAt: item.scored_at || '',
    scoredAtText: formatDateTime(item.scored_at),
  };
}

function findNodeIndexById(flatNodes = [], nodeId) {
  return flatNodes.findIndex((item) => String(item.id) === String(nodeId));
}

function applyBranchVisibility(flatNodes = []) {
  const nodeById = new Map(flatNodes.map((item) => [String(item.id), item]));

  flatNodes.forEach((item) => {
    if (item.depth === 0) {
      item.isVisible = false;
      return;
    }

    let visible = true;
    let parent = nodeById.get(String(item.parentId));
    while (parent) {
      if (parent.depth > 0 && !parent.branchExpanded) {
        visible = false;
        break;
      }
      if (parent.depth === 0) {
        break;
      }
      parent = nodeById.get(String(parent.parentId));
    }

    item.isVisible = visible;
  });

  return flatNodes;
}

function decorateTree(tree, treeIndex = 0) {
  const list = [];

  function walk(node, depth, path) {
    if (!node) {
      return null;
    }

    const currentPath = path ? `${path} / ${node.name}` : node.name;
    const isKnowledge = depth > 0;
    const requiredLevel = Number(node.requiredLevel || node.required_level || 0);
    const unlocked = node.unlocked !== undefined
      ? !!node.unlocked
      : (requiredLevel <= 0);
    const codeText = node.codeText || node.code_text || '';
    const submissionHistory = Array.isArray(node.submissionHistory)
      ? node.submissionHistory.map((item) => decorateSubmission(item))
      : (Array.isArray(node.submission_history)
        ? node.submission_history.map((item) => decorateSubmission(item))
        : []);
    const latestTeacherScore = node.latestTeacherScore === null || node.latestTeacherScore === undefined
      ? null
      : Number(node.latestTeacherScore);
    const scoredSubmissionValues = submissionHistory
      .map((item) => item.teacherScoreValue)
      .filter((score) => score !== null && !Number.isNaN(score));
    const highestTeacherScore = node.highestTeacherScore === null || node.highestTeacherScore === undefined
      ? (scoredSubmissionValues.length ? Math.max(...scoredSubmissionValues) : null)
      : Number(node.highestTeacherScore);
    const averageTeacherScore = node.averageTeacherScore === null || node.averageTeacherScore === undefined
      ? (scoredSubmissionValues.length
        ? scoredSubmissionValues.reduce((sum, score) => sum + score, 0) / scoredSubmissionValues.length
        : null)
      : Number(node.averageTeacherScore);
    const submissionCount = submissionHistory.length || Number(node.submissionCount || 0);
    const latestFileItems = getSubmissionFileItems(node);
    const latestImageItems = latestFileItems.filter((entry) => entry.kind === 'image');
    const latestNonImageFileItems = latestFileItems.filter((entry) => entry.kind !== 'image');
    const firstLatestImage = latestImageItems[0] || null;
    const problemAttachments = getProblemAttachments(node);
    const firstProblemAttachment = problemAttachments[0] || null;

    const decoratedNode = {
      id: node.id,
      parentId: node.parentId ?? node.parent_id ?? null,
      depth,
      name: node.name,
      indent: '　'.repeat(depth),
      path: currentPath,
      isKnowledge,
      isLeafTask: false,
      hasChildren: false,
      branchExpanded: depth === 0,
      isVisible: false,
      unlocked,
      requiredLevel,
      lockedText: node.lockedText || (requiredLevel > 0 ? `达到 ${requiredLevel} 级后解锁` : ''),
      canSubmit: false,
      comment: node.comment || '',
      codeText,
      codeDraft: '',
      codeImageUrl: firstLatestImage ? firstLatestImage.url : '',
      latestFileItems,
      latestImageItems,
      latestNonImageFileItems,
      latestImagePreviewUrl: firstLatestImage ? firstLatestImage.previewUrl : '',
      draftImageItems: [],
      draftFileItems: [],
      draftImagePreviewUrl: '',
      problemAttachments,
      problemAttachmentUrl: firstProblemAttachment ? firstProblemAttachment.url : '',
      problemAttachmentPreviewUrl: firstProblemAttachment ? firstProblemAttachment.previewUrl : '',
      problemAttachmentFileName: firstProblemAttachment ? firstProblemAttachment.fileName : '',
      problemAttachmentDisplayName: firstProblemAttachment ? firstProblemAttachment.displayName : '',
      problemAttachmentMimeType: firstProblemAttachment ? firstProblemAttachment.mimeType : '',
      problemAttachmentKind: firstProblemAttachment ? firstProblemAttachment.kind : '',
      hasProblemAttachment: problemAttachments.length > 0,
      submissionCount,
      submissionHistory,
      latestTeacherScore,
      latestTeacherScoreText: latestTeacherScore === null || Number.isNaN(latestTeacherScore)
        ? '-'
        : formatNumber(latestTeacherScore),
      latestTeacherScoreClass: latestTeacherScore === null || Number.isNaN(latestTeacherScore)
        ? ''
        : getScoreClass(latestTeacherScore),
      highestTeacherScore,
      highestTeacherScoreText: highestTeacherScore === null || Number.isNaN(highestTeacherScore)
        ? '-'
        : formatNumber(highestTeacherScore),
      highestTeacherScoreClass: highestTeacherScore === null || Number.isNaN(highestTeacherScore)
        ? ''
        : getScoreClass(highestTeacherScore),
      averageTeacherScore,
      averageTeacherScoreText: averageTeacherScore === null || Number.isNaN(averageTeacherScore)
        ? '-'
        : formatNumber(averageTeacherScore),
      averageTeacherScoreClass: averageTeacherScore === null || Number.isNaN(averageTeacherScore)
        ? ''
        : getScoreClass(averageTeacherScore),
      latestTeacherComment: node.latestTeacherComment || '',
      latestSubmittedAt: node.latestSubmittedAt || '',
      latestSubmittedAtText: formatDateTime(node.latestSubmittedAt),
      currentScoreValue: 0,
      currentScoreText: '0',
      currentScoreClass: '',
      totalScoreValue: 0,
      totalScoreText: '0',
      taskCount: 0,
      scoredTaskCount: 0,
      editorExpanded: false,
      working: false,
      shareWorking: false,
    };

    list.push(decoratedNode);

    const childItems = Array.isArray(node.children)
      ? node.children.map((child) => walk(child, depth + 1, currentPath)).filter(Boolean)
      : [];
    const isLeafTask = isKnowledge && childItems.length === 0;
    const currentScoreValue = isLeafTask
      ? (unlocked
        ? (highestTeacherScore === null || Number.isNaN(highestTeacherScore) ? 0 : highestTeacherScore)
        : 0)
      : childItems.reduce((sum, item) => sum + item.currentScoreValue, 0);
    const totalScoreValue = isLeafTask
      ? (unlocked ? 10 : 0)
      : childItems.reduce((sum, item) => sum + item.totalScoreValue, 0);
    const taskCount = isLeafTask
      ? (unlocked ? 1 : 0)
      : childItems.reduce((sum, item) => sum + item.taskCount, 0);
    const scoredTaskCount = isLeafTask
      ? ((!unlocked || highestTeacherScore === null || Number.isNaN(highestTeacherScore)) ? 0 : 1)
      : childItems.reduce((sum, item) => sum + item.scoredTaskCount, 0);

    const pathParts = currentPath.split(' / ');
    const nodeTrailText = depth > 1
      ? pathParts.slice(1, -1).join(' · ')
      : (depth === 1 ? '本章主线入口' : '');
    const nodeSummaryText = !unlocked
      ? (decoratedNode.lockedText || '当前暂未解锁')
      : (isLeafTask
        ? `已提交 ${submissionCount} 次，最高分 ${highestTeacherScore === null || Number.isNaN(highestTeacherScore) ? '-' : formatNumber(highestTeacherScore)} / 10`
        : (taskCount
          ? `包含 ${taskCount} 个任务点`
          : (childItems.length ? `继续展开查看 ${childItems.length} 个下级节点` : '继续展开查看子节点')));
    const nodeProgressPercent = totalScoreValue > 0
      ? Math.max(0, Math.min(100, Math.round((currentScoreValue / totalScoreValue) * 100)))
      : 0;
    const nodeProgressScoreText = `${formatNumber(currentScoreValue) || '0'} / ${formatNumber(totalScoreValue) || '0'}`;
    const nodeProgressTaskText = !unlocked
      ? (decoratedNode.lockedText || '当前未解锁')
      : (isLeafTask
        ? `已计分 ${highestTeacherScore === null || Number.isNaN(highestTeacherScore) ? '0' : '1'} / 1`
        : (taskCount ? `已完成 ${scoredTaskCount} / ${taskCount} 个任务点` : '当前暂无可计分任务'));

    Object.assign(decoratedNode, {
      isLeafTask,
      hasChildren: childItems.length > 0,
      canSubmit: isLeafTask && unlocked,
      currentScoreValue,
      currentScoreText: formatNumber(currentScoreValue),
      currentScoreClass: getScoreClass(currentScoreValue),
      totalScoreValue,
      totalScoreText: formatNumber(totalScoreValue),
      taskCount,
      scoredTaskCount,
      nodeProgressPercent,
      nodeProgressScoreText,
      nodeProgressTaskText,
      moduleId: `node-${node.id}`,
      nodeToneClass: isLeafTask ? 'node-tone-leaf' : (depth === 1 ? 'node-tone-chapter' : 'node-tone-branch'),
      nodeCardStyle: depth > 1 ? `margin-left: ${(depth - 1) * 20}rpx;` : '',
      nodeTrailText,
      nodeSummaryText,
    });

    return decoratedNode;
  }

  const rootNode = walk(tree.root, 0, '');
  const flatNodes = applyBranchVisibility(list);
  const knowledgeNodes = flatNodes.filter((item) => item.isKnowledge);
  const leafTasks = knowledgeNodes.filter((item) => item.isLeafTask && item.unlocked);
  const topLevelNodes = flatNodes.filter((item) => item.depth === 1);
  const previewNodes = (topLevelNodes.length ? topLevelNodes : leafTasks).slice(0, 3);
  const theme = TREE_THEME_PRESETS[treeIndex % TREE_THEME_PRESETS.length];

  const totalTasks = leafTasks.length;
  const scoredTasks = leafTasks.filter((item) => item.highestTeacherScore !== null && !Number.isNaN(item.highestTeacherScore)).length;
  const currentScoreValue = rootNode ? rootNode.currentScoreValue : 0;
  const totalScoreValue = rootNode ? rootNode.totalScoreValue : 0;
  const progressPercent = totalScoreValue > 0
    ? Math.max(0, Math.min(100, Math.round((currentScoreValue / totalScoreValue) * 100)))
    : 0;

  return {
    ...tree,
    moduleId: `tree-${tree.id}`,
    treeExpanded: false,
    themeClass: theme.cardClass,
    coverThemeClass: theme.coverClass,
    previewChipClass: theme.chipClass,
    coverBadgeText: `${theme.badge} ${String(treeIndex + 1).padStart(2, '0')}`,
    previewChips: previewNodes.map((item) => item.name).filter(Boolean),
    flatNodes,
    stats: {
      totalTasks,
      scoredTasks,
      currentScoreValue,
      currentScoreText: rootNode ? formatNumber(rootNode.currentScoreValue) : '0',
      currentScoreClass: rootNode ? getScoreClass(rootNode.currentScoreValue) : '',
      totalScoreValue,
      totalScoreText: rootNode ? formatNumber(rootNode.totalScoreValue) : '0',
      progressPercent,
      remainingTasks: Math.max(0, totalTasks - scoredTasks),
      statusText: totalTasks
        ? `已完成 ${scoredTasks} / ${totalTasks} 个任务点`
        : '当前还没有开放的任务点',
      highlightText: totalTasks
        ? (progressPercent >= 80
          ? '本章已经接近通关，可以开始冲刺下一章节。'
          : (progressPercent >= 40
            ? '已经进入稳定推进阶段，继续保持当前节奏。'
            : '先从第一个已开放任务点开始，逐步把分支点亮。'))
        : '等待老师开放新的任务点后再开始本章学习。',
    },
  };
}

Page({
  data: {
    loading: false,
    errorText: '',
    studentName: '',
    studentProfile: buildStudentHeroProfile(null),
    studentProfileSummary: buildEmptyStudentProfileSummary(),
    knowledgeScene: buildEmptyKnowledgeScene(),
    rewardScene: buildEmptyRewardScene(),
    trees: [],
    pageSummary: {
      treeCount: 0,
      availableTasks: 0,
      scoredTasks: 0,
      currentScoreText: '0',
      totalScoreText: '0',
    },
    monthActivity: buildEmptyHeatmapSummary(new Date()),
    rewardTreeProgress: buildEmptyRewardTreeProgress(),
    rewardPrompt: buildEmptyRewardPrompt(),
    starScenesExpanded: false,
    profileExpanded: false,
    summaryShareWorking: false,
    submitOverlayVisible: false,
    activeLoadingTip: pickRandomTip(),
    activeModuleId: 'hero',
    shareMode: false,
    shareId: '',
    shareCard: null,
    saving: false,
  },

  draftImageStore: new Map(),
  draftFileStore: new Map(),
  hasBootstrapped: false,
  shareModeSource: 'normal',
  focusModuleMeasureTimer: null,
  focusModuleMetrics: [],
  lastPageScrollTop: 0,
  viewportHeight: 0,
  sharePosterPreviewSourceId: '',
  sharePosterPreviewFilePath: '',
  sharePosterPreviewPromise: null,
  constellationSetupTimer: null,
  constellationRenderTimer: null,
  constellations: {},

  resetSharePosterPreview() {
    this.sharePosterPreviewSourceId = '';
    this.sharePosterPreviewFilePath = '';
    this.sharePosterPreviewPromise = null;
  },

  getSharePreviewImageUrl() {
    return this.sharePosterPreviewFilePath || (this.data.shareCard && this.data.shareCard.coverImageUrl) || '';
  },

  prepareSharePosterPreview(card) {
    if (!card) {
      this.resetSharePosterPreview();
      return Promise.resolve('');
    }
    const sourceId = String(card.id || `${card.shareKind || 'share'}:${card.nodeName || ''}:${card.generatedAtText || ''}`);
    if (this.sharePosterPreviewSourceId === sourceId && this.sharePosterPreviewFilePath) {
      return Promise.resolve(this.sharePosterPreviewFilePath);
    }
    if (this.sharePosterPreviewSourceId === sourceId && this.sharePosterPreviewPromise) {
      return this.sharePosterPreviewPromise;
    }

    this.sharePosterPreviewSourceId = sourceId;
    this.sharePosterPreviewFilePath = '';
    this.sharePosterPreviewPromise = (async () => {
      await this.drawSharePoster(card);
      const tempFilePath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'sharePosterCanvas',
          destWidth: SHARE_POSTER_WIDTH,
          destHeight: SHARE_POSTER_HEIGHT,
          width: SHARE_POSTER_WIDTH,
          height: SHARE_POSTER_HEIGHT,
          success: (resp) => resolve(resp.tempFilePath),
          fail: reject,
        }, this);
      });
      if (this.sharePosterPreviewSourceId === sourceId) {
        this.sharePosterPreviewFilePath = tempFilePath;
      }
      return tempFilePath;
    })().catch(() => '')
      .finally(() => {
        if (this.sharePosterPreviewSourceId === sourceId) {
          this.sharePosterPreviewPromise = null;
        }
      });

    return this.sharePosterPreviewPromise;
  },

  onLoad(options = {}) {
    this.hasBootstrapped = true;
    const windowInfo = typeof wx.getWindowInfo === 'function'
      ? wx.getWindowInfo()
      : wx.getSystemInfoSync();
    this.viewportHeight = Number((windowInfo && windowInfo.windowHeight) || 0);
    if (typeof wx.showShareMenu === 'function') {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    }
    const shareId = String(options.shareId || options.id || '').trim();
    if (shareId) {
      this.shareModeSource = 'route';
      this.setData({
        shareMode: true,
        shareId,
        shareCard: null,
        loading: true,
        errorText: '',
      });
      this.loadShareCard(shareId);
      return;
    }
    this.shareModeSource = 'normal';
    this.bootstrap();
  },

  onReady() {
    this.scheduleFocusModuleMeasure();
    this.scheduleConstellationSetup(140);
  },

  scheduleConstellationSetup(delay = 100) {
    if (this.data.shareMode || !this.data.starScenesExpanded) {
      return;
    }
    if (this.constellationSetupTimer) {
      clearTimeout(this.constellationSetupTimer);
    }
    this.constellationSetupTimer = setTimeout(async () => {
      this.constellationSetupTimer = null;
      await Promise.all([
        this.ensureConstellationCanvas('knowledge', '#knowledgeConstellationCanvas'),
        this.ensureConstellationCanvas('reward', '#rewardConstellationCanvas'),
      ]);
      this.syncConstellationScene('knowledge');
      this.syncConstellationScene('reward');
      this.startConstellationLoop();
      this.renderConstellations();
    }, delay);
  },

  async ensureConstellationCanvas(sceneType, selector) {
    return new Promise((resolve) => {
      const query = this.createSelectorQuery();
      query.select(selector).fields({ node: true, size: true }, (res) => {
        if (!res || !res.node || !res.width || !res.height) {
          resolve(false);
          return;
        }
        const existing = this.constellations[sceneType] || {};
        const sys = typeof wx.getWindowInfo === 'function'
          ? wx.getWindowInfo()
          : wx.getSystemInfoSync();
        const dpr = Math.max(1, Number((sys && sys.pixelRatio) || 1));
        const width = Number(res.width || 0);
        const height = Number(res.height || 0);
        const canvas = res.node;
        const ctx = canvas.getContext('2d');
        if (!ctx || !width || !height) {
          resolve(false);
          return;
        }
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        if (typeof ctx.setTransform === 'function') {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else {
          ctx.scale(dpr, dpr);
        }
        this.constellations[sceneType] = {
          sceneType,
          canvas,
          ctx,
          width,
          height,
          dpr,
          cameraDistance: sceneType === 'reward' ? 520 : 560,
          baseLineY: height * 0.72,
          rotationX: existing.rotationX !== undefined ? existing.rotationX : (sceneType === 'reward' ? -0.12 : -0.18),
          rotationY: existing.rotationY !== undefined ? existing.rotationY : (sceneType === 'reward' ? 0.22 : -0.36),
          targetRotationX: existing.targetRotationX !== undefined ? existing.targetRotationX : (sceneType === 'reward' ? -0.12 : -0.18),
          targetRotationY: existing.targetRotationY !== undefined ? existing.targetRotationY : (sceneType === 'reward' ? 0.22 : -0.36),
          autoRotationY: sceneType === 'reward' ? -0.0038 : 0.0042,
          dragging: false,
          lastTouchX: 0,
          lastTouchY: 0,
          stars: createConstellationStars(sceneType, width, height),
          scene: existing.scene || null,
        };
        resolve(true);
      });
      query.exec();
    });
  },

  syncConstellationScene(sceneType) {
    const runtime = this.constellations[sceneType];
    if (!runtime) {
      return;
    }
    runtime.scene = sceneType === 'reward' ? this.data.rewardScene : this.data.knowledgeScene;
  },

  startConstellationLoop() {
    if (this.data.shareMode || this.constellationRenderTimer) {
      return;
    }
    this.constellationRenderTimer = setInterval(() => {
      this.renderConstellations();
    }, 33);
  },

  stopConstellationLoop() {
    if (this.constellationRenderTimer) {
      clearInterval(this.constellationRenderTimer);
      this.constellationRenderTimer = null;
    }
  },

  renderConstellations() {
    if (this.data.shareMode) {
      return;
    }
    Object.keys(this.constellations).forEach((sceneType) => {
      const runtime = this.constellations[sceneType];
      if (!runtime || !runtime.scene) {
        return;
      }
      if (!runtime.dragging) {
        runtime.targetRotationY += runtime.autoRotationY;
      }
      runtime.targetRotationX = Math.max(-0.72, Math.min(0.38, runtime.targetRotationX));
      runtime.rotationX += (runtime.targetRotationX - runtime.rotationX) * 0.14;
      runtime.rotationY += (runtime.targetRotationY - runtime.rotationY) * 0.12;
      drawConstellationSceneFrame(runtime);
    });
  },

  handleConstellationTouchStart(e) {
    const sceneType = String((e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.scene) || '');
    const runtime = this.constellations[sceneType];
    const touch = e.touches && e.touches[0];
    if (!runtime || !touch) {
      return;
    }
    runtime.dragging = true;
    runtime.lastTouchX = Number(touch.pageX || touch.clientX || 0);
    runtime.lastTouchY = Number(touch.pageY || touch.clientY || 0);
  },

  handleConstellationTouchMove(e) {
    const sceneType = String((e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.scene) || '');
    const runtime = this.constellations[sceneType];
    const touch = e.touches && e.touches[0];
    if (!runtime || !runtime.dragging || !touch) {
      return;
    }
    const nextX = Number(touch.pageX || touch.clientX || 0);
    const nextY = Number(touch.pageY || touch.clientY || 0);
    const deltaX = nextX - runtime.lastTouchX;
    const deltaY = nextY - runtime.lastTouchY;
    runtime.lastTouchX = nextX;
    runtime.lastTouchY = nextY;
    runtime.targetRotationY += deltaX * 0.012;
    runtime.targetRotationX -= deltaY * 0.008;
    runtime.targetRotationX = Math.max(-0.72, Math.min(0.38, runtime.targetRotationX));
    this.renderConstellations();
  },

  handleConstellationTouchEnd(e) {
    const sceneType = String((e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.scene) || '');
    const runtime = this.constellations[sceneType];
    if (runtime) {
      runtime.dragging = false;
    }
  },

  onUnload() {
    if (this.focusModuleMeasureTimer) {
      clearTimeout(this.focusModuleMeasureTimer);
      this.focusModuleMeasureTimer = null;
    }
    if (this.constellationSetupTimer) {
      clearTimeout(this.constellationSetupTimer);
      this.constellationSetupTimer = null;
    }
    this.stopConstellationLoop();
    this.constellations = {};
    this.focusModuleMetrics = [];
  },

  onPageScroll(e) {
    if (this.data.shareMode) {
      return;
    }
    this.lastPageScrollTop = Number((e && e.scrollTop) || 0);
    this.applyActiveFocusModule(this.lastPageScrollTop);
    if (!this.focusModuleMetrics.length) {
      this.scheduleFocusModuleMeasure(0);
    }
  },

  scheduleFocusModuleMeasure(delay = 80) {
    if (this.data.shareMode) {
      return;
    }
    if (this.focusModuleMeasureTimer) {
      clearTimeout(this.focusModuleMeasureTimer);
    }
    this.focusModuleMeasureTimer = setTimeout(() => {
      this.focusModuleMeasureTimer = null;
      this.measureFocusModules();
    }, delay);
  },

  measureFocusModules() {
    if (this.data.shareMode) {
      return;
    }
    const query = this.createSelectorQuery();
    query.selectAll('.focus-module').boundingClientRect();
    query.exec((res) => {
      const rects = Array.isArray(res && res[0]) ? res[0] : [];
      const scrollTop = this.lastPageScrollTop || 0;
      this.focusModuleMetrics = rects.map((rect) => {
        const rawId = String((rect && rect.id) || '').trim();
        const moduleId = rawId.startsWith('module-') ? rawId.slice('module-'.length) : rawId;
        if (!moduleId) {
          return null;
        }
        const top = scrollTop + Number((rect && rect.top) || 0);
        const height = Number((rect && rect.height) || 0);
        return {
          id: moduleId,
          top,
          bottom: top + height,
          height,
          center: top + (height / 2),
        };
      }).filter(Boolean);
      this.applyActiveFocusModule(scrollTop);
    });
  },

  applyActiveFocusModule(scrollTop = 0) {
    if (this.data.shareMode) {
      return;
    }
    const metrics = this.focusModuleMetrics || [];
    if (!metrics.length) {
      return;
    }
    const viewportHeight = this.viewportHeight || Number((wx.getSystemInfoSync() || {}).windowHeight || 0) || 0;
    const viewportCenter = scrollTop + Math.max(120, viewportHeight * 0.5);
    const containingMetrics = metrics.filter((item) => viewportCenter >= item.top && viewportCenter <= item.bottom);
    let activeMetric = null;
    if (containingMetrics.length) {
      activeMetric = containingMetrics.reduce((best, item) => {
        if (!best) {
          return item;
        }
        if (Number(item.height || 0) !== Number(best.height || 0)) {
          return Number(item.height || 0) < Number(best.height || 0) ? item : best;
        }
        return Math.abs(item.center - viewportCenter) < Math.abs(best.center - viewportCenter) ? item : best;
      }, null);
    }
    if (!activeMetric) {
      activeMetric = metrics.reduce((best, item) => {
        if (!best) {
          return item;
        }
        return Math.abs(item.center - viewportCenter) < Math.abs(best.center - viewportCenter) ? item : best;
      }, null);
    }
    const nextActiveId = activeMetric ? activeMetric.id : '';
    if (nextActiveId && nextActiveId !== this.data.activeModuleId) {
      this.setData({ activeModuleId: nextActiveId });
    }
  },

  onShow() {
    if (this.data.shareMode) {
      return;
    }
    const app = getApp();
    if (app && app.globalData && app.globalData.rewardCenterDirty) {
      app.globalData.rewardCenterDirty = false;
      this.handleRefresh();
      return;
    }
    if (!this.hasBootstrapped) {
      this.hasBootstrapped = true;
      this.bootstrap();
      return;
    }
    if (!this.data.loading && !this.data.trees.length) {
      this.bootstrap();
      return;
    }
    if (this.data.trees.length && this.data.starScenesExpanded) {
      this.scheduleConstellationSetup(80);
    }
  },

  onHide() {
    this.stopConstellationLoop();
  },

  async loadShareCard(shareId) {
    this.setData({ loading: true, errorText: '', shareId });
    try {
      const payload = await request(`/api/share-cards/${shareId}`, {
        method: 'GET',
        needAuth: false,
      });
      const shareCard = buildShareCardModel(payload);
      this.resetSharePosterPreview();
      this.setData({
        loading: false,
        shareMode: true,
        shareCard,
      }, () => {
        this.prepareSharePosterPreview(shareCard);
      });
    } catch (err) {
      this.resetSharePosterPreview();
      this.setData({
        loading: false,
        shareMode: true,
        errorText: err.message || '加载分享卡失败',
      });
    }
  },

  async enterShareMode(payload = {}, source = 'inline') {
    const shareId = String((payload && payload.id) || '').trim();
    const rawCard = payload && payload.card ? payload.card : null;
    const shareCard = rawCard ? buildShareCardModel(rawCard) : null;

    this.shareModeSource = source;
    this.stopConstellationLoop();
    this.resetSharePosterPreview();
    this.setData({
      shareMode: true,
      shareId,
      shareCard,
      loading: !shareCard && !!shareId,
      errorText: '',
    }, () => {
      if (shareCard) {
        this.prepareSharePosterPreview(shareCard);
      }
    });

    if (typeof wx.pageScrollTo === 'function') {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }

    if (!shareCard && shareId) {
      await this.loadShareCard(shareId);
    }
  },

  onShareAppMessage() {
    if (!this.data.shareMode || !this.data.shareCard) {
      return {
        title: '我的学习树',
        path: '/pages/trees/trees',
      };
    }
    const card = this.data.shareCard || {};
    const payload = {
      title: card.shareTitle || '学习成果卡',
      path: `/pages/trees/trees?shareId=${this.data.shareId}`,
    };
    const sharePreviewImageUrl = this.getSharePreviewImageUrl();
    if (sharePreviewImageUrl) {
      payload.imageUrl = sharePreviewImageUrl;
    }
    return payload;
  },

  onShareTimeline() {
    if (!this.data.shareMode || !this.data.shareCard) {
      return {
        title: '我的学习树',
        query: '',
      };
    }
    const card = this.data.shareCard || {};
    const payload = {
      title: card.shareTitle || '学习成果卡',
      query: `shareId=${this.data.shareId}`,
    };
    const sharePreviewImageUrl = this.getSharePreviewImageUrl();
    if (sharePreviewImageUrl) {
      payload.imageUrl = sharePreviewImageUrl;
    }
    return payload;
  },

  async handleShareBack() {
    const source = this.shareModeSource || 'normal';
    const hasTrees = Array.isArray(this.data.trees) && this.data.trees.length > 0;
    if (source === 'route' && getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    this.shareModeSource = 'normal';
    this.resetSharePosterPreview();
    this.setData({
      shareMode: false,
      shareId: '',
      shareCard: null,
      errorText: '',
      loading: false,
    });
    if (hasTrees) {
      if (typeof wx.pageScrollTo === 'function') {
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      }
      if (this.data.starScenesExpanded) {
        this.scheduleConstellationSetup(80);
      }
      return;
    }
    await this.bootstrap();
  },

  async handleTimelineTip() {
    await showShareModalPromise({
      title: '分享到朋友圈',
      content: '请点击右上角“...”菜单，再选择“分享到朋友圈”。保存后的资料卡图片也可以直接发朋友圈。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  async handleSaveSharePoster() {
    const card = this.data.shareCard;
    if (!card || this.data.saving) {
      return;
    }

    this.setData({ saving: true, errorText: '' });
    try {
      await this.drawSharePoster(card);
      const tempFilePath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'sharePosterCanvas',
          destWidth: SHARE_POSTER_WIDTH,
          destHeight: SHARE_POSTER_HEIGHT,
          width: SHARE_POSTER_WIDTH,
          height: SHARE_POSTER_HEIGHT,
          success: (resp) => resolve(resp.tempFilePath),
          fail: reject,
        }, this);
      });
      this.sharePosterPreviewSourceId = String(card.id || this.sharePosterPreviewSourceId || '');
      this.sharePosterPreviewFilePath = tempFilePath;
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: tempFilePath,
          success: resolve,
          fail: reject,
        });
      });
      wx.showToast({ title: '资料卡已保存', icon: 'success' });
    } catch (err) {
      const message = String((err && (err.errMsg || err.message)) || '保存资料卡失败');
      if (message.includes('auth deny') || message.includes('authorize') || message.includes('deny')) {
        const confirmed = await showShareModalPromise({
          title: '需要相册权限',
          content: '保存资料卡需要相册写入权限，是否前往设置开启？',
          confirmText: '去设置',
          cancelText: '取消',
        });
        if (confirmed) {
          wx.openSetting();
        }
      } else {
        this.setData({ errorText: message });
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  drawShareCalendarPanel(ctx, calendar, theme, top) {
    if (!calendar || !Array.isArray(calendar.cells) || !calendar.cells.some((cell) => !cell.placeholder)) {
      return top;
    }

    const panelX = 128;
    const panelY = top;
    const panelWidth = SHARE_POSTER_WIDTH - 256;
    const paddingX = 38;
    const cells = (calendar.cells || []).slice(0, 42);
    const rowCount = Math.max(1, Math.ceil(cells.length / 7));
    const cellSize = 40;
    const cellGap = 10;
    const weekdayStep = cellSize + cellGap;
    const gridWidth = cellSize * 7 + cellGap * 6;
    const statGap = 16;
    const statCardHeight = 84;
    const statCardWidth = Math.floor((panelWidth - paddingX * 2 - statGap * 2) / 3);
    const monthLabel = String(calendar.monthLabel || '本月热力图').trim() || '本月热力图';
    const summaryText = String(calendar.summaryText || '本月热力图').trim() || '本月热力图';
    const bandStyleMap = {
      none: { fill: 'rgba(18, 33, 58, 0.9)', stroke: 'rgba(121, 153, 201, 0.08)', text: 'rgba(176, 202, 236, 0.58)' },
      pending: { fill: 'rgba(84, 144, 255, 0.18)', stroke: 'rgba(144, 196, 255, 0.62)', text: '#eff7ff' },
      low: { fill: 'rgba(244, 99, 110, 0.94)', stroke: 'rgba(255, 176, 186, 0.26)', text: '#fff2f4' },
      mid: { fill: 'rgba(246, 193, 78, 0.94)', stroke: 'rgba(255, 232, 173, 0.24)', text: '#fff8e4' },
      high: { fill: 'rgba(58, 205, 147, 0.94)', stroke: 'rgba(173, 255, 225, 0.24)', text: '#effff8' },
    };
    const statItems = [
      { label: '活跃天数', value: `${Number(calendar.activeDays || 0)} 天`, tone: 'rgba(88, 166, 255, 0.22)' },
      { label: '提交次数', value: `${Number(calendar.submittedCount || 0)} 次`, tone: 'rgba(31, 213, 185, 0.20)' },
      { label: '已评分天', value: `${Number(calendar.reviewedDays || 0)} 天`, tone: 'rgba(126, 241, 212, 0.14)' },
    ];

    ctx.setFontSize(24);
    const summaryBottom = fillShareWrappedText(ctx, summaryText, panelX + paddingX, panelY + 74, panelWidth - paddingX * 2 - 180, 30, 2);
    const statTop = Math.max(panelY + 122, summaryBottom + 26);
    const boardX = panelX + 24;
    const boardY = statTop + statCardHeight + 28;
    const boardWidth = panelWidth - 48;
    const startX = boardX + Math.max(22, Math.floor((boardWidth - gridWidth) / 2));
    const weekdayY = boardY + 42;
    const gridStartY = boardY + 78;
    const gridHeight = rowCount * cellSize + Math.max(0, rowCount - 1) * cellGap;
    const boardHeight = gridHeight + 110;
    const legendStartY = boardY + boardHeight + 24;
    const legendMaxX = panelX + panelWidth - paddingX;
    const legendItems = [];
    let legendX = panelX + paddingX;
    let legendY = legendStartY;
    ctx.setFontSize(18);
    (calendar.legendItems || []).forEach((legend) => {
      const label = String((legend && legend.label) || '').trim();
      if (!label) {
        return;
      }
      const width = Math.min(170, 56 + ctx.measureText(label).width);
      if (legendX + width > legendMaxX) {
        legendX = panelX + paddingX;
        legendY += 40;
      }
      legendItems.push({
        x: legendX,
        y: legendY,
        width,
        label,
        band: (legend && legend.band) || 'none',
      });
      legendX += width + 12;
    });
    const legendBottom = legendItems.length ? legendItems[legendItems.length - 1].y + 28 : legendStartY;
    const panelHeight = legendBottom - panelY + 36;
    const monthChipWidth = Math.min(220, 52 + ctx.measureText(monthLabel).width);

    drawShareRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 34, 'rgba(8, 18, 34, 0.94)', 'rgba(125, 171, 255, 0.16)');
    drawShareRoundedRect(ctx, panelX + 18, panelY + 18, panelWidth - 36, 88, 28, theme.accentSoft, 'rgba(125, 171, 255, 0.08)');
    drawShareRoundedRect(ctx, panelX + panelWidth - monthChipWidth - 28, panelY + 28, monthChipWidth, 42, 21, 'rgba(10, 24, 48, 0.86)', 'rgba(125, 171, 255, 0.24)');

    ctx.setFillStyle(theme.neon);
    ctx.setFontSize(24);
    ctx.fillText('月度热力图', panelX + paddingX, panelY + 44);
    ctx.setFillStyle('#dbe9ff');
    ctx.setFontSize(22);
    ctx.fillText(monthLabel, panelX + panelWidth - monthChipWidth - 2, panelY + 55);
    ctx.setFillStyle('rgba(226, 239, 255, 0.88)');
    ctx.setFontSize(24);
    fillShareWrappedText(ctx, summaryText, panelX + paddingX, panelY + 74, panelWidth - paddingX * 2 - 180, 30, 2);

    statItems.forEach((item, index) => {
      const x = panelX + paddingX + index * (statCardWidth + statGap);
      drawShareRoundedRect(ctx, x, statTop, statCardWidth, statCardHeight, 24, item.tone, 'rgba(125, 171, 255, 0.14)');
      ctx.setFillStyle('rgba(196, 216, 244, 0.72)');
      ctx.setFontSize(20);
      ctx.fillText(item.label, x + 18, statTop + 28);
      ctx.setFillStyle('#f4fbff');
      ctx.setFontSize(28);
      ctx.fillText(item.value, x + 18, statTop + 62);
    });

    drawShareRoundedRect(ctx, boardX, boardY, boardWidth, boardHeight, 30, 'rgba(10, 22, 40, 0.92)', 'rgba(125, 171, 255, 0.12)');

    ctx.save();
    ctx.setTextAlign('center');
    (calendar.weekdayLabels || []).forEach((weekday, index) => {
      ctx.setFillStyle('rgba(172, 197, 233, 0.66)');
      ctx.setFontSize(18);
      ctx.fillText(String(weekday || ''), startX + index * weekdayStep + (cellSize / 2), weekdayY);
    });

    cells.forEach((cell, index) => {
      const col = index % 7;
      const row = Math.floor(index / 7);
      const x = startX + col * weekdayStep;
      const y = gridStartY + row * weekdayStep;
      if (cell.placeholder) {
        drawShareRoundedRect(ctx, x, y, cellSize, cellSize, 14, 'rgba(9, 18, 32, 0.24)', 'rgba(125, 171, 255, 0.03)');
        return;
      }
      const style = bandStyleMap[cell.band || 'none'] || bandStyleMap.none;
      drawShareRoundedRect(ctx, x, y, cellSize, cellSize, 14, style.fill, style.stroke);
      if (cell.isToday) {
        ctx.setStrokeStyle('rgba(255, 255, 255, 0.66)');
        ctx.setLineWidth(2);
        ctx.strokeRect(x + 3, y + 3, cellSize - 6, cellSize - 6);
      }
      ctx.setFillStyle(style.text);
      ctx.setFontSize(18);
      ctx.fillText(String(cell.dayLabel || ''), x + (cellSize / 2), y + 26);
      if (cell.scoreText) {
        ctx.setFillStyle('rgba(255, 255, 255, 0.76)');
        ctx.setFontSize(10);
        ctx.fillText(String(cell.scoreText), x + (cellSize / 2), y + 37);
      }
    });
    ctx.restore();

    legendItems.forEach((item) => {
      const style = bandStyleMap[item.band] || bandStyleMap.none;
      drawShareRoundedRect(ctx, item.x, item.y - 14, item.width, 30, 15, 'rgba(10, 23, 42, 0.9)', 'rgba(125, 171, 255, 0.12)');
      drawShareRoundedRect(ctx, item.x + 12, item.y - 5, 14, 14, 7, style.fill, style.stroke);
      ctx.setFillStyle('rgba(205, 223, 247, 0.84)');
      ctx.setFontSize(18);
      ctx.fillText(item.label, item.x + 36, item.y + 3);
    });

    return panelY + panelHeight + 34;
  },

  async drawSharePoster(card) {
    const ctx = wx.createCanvasContext('sharePosterCanvas', this);
    const themes = [
      { top: '#0b1e42', bottom: '#07111f', accentSoft: 'rgba(88, 166, 255, 0.18)', neon: '#7de6ff' },
      { top: '#072127', bottom: '#071319', accentSoft: 'rgba(31, 213, 185, 0.18)', neon: '#74ffe5' },
      { top: '#2a1310', bottom: '#120908', accentSoft: 'rgba(255, 138, 76, 0.18)', neon: '#ffd285' },
    ];
    const theme = themes[card.themeIndex] || themes[0];
    const coverImageInfo = card.coverImageUrl
      ? await getShareImageInfo(card.coverImageUrl).catch(() => null)
      : null;

    ctx.clearRect(0, 0, SHARE_POSTER_WIDTH, SHARE_POSTER_HEIGHT);
    const bg = ctx.createLinearGradient(0, 0, 0, SHARE_POSTER_HEIGHT);
    bg.addColorStop(0, theme.top);
    bg.addColorStop(1, theme.bottom);
    ctx.setFillStyle(bg);
    ctx.fillRect(0, 0, SHARE_POSTER_WIDTH, SHARE_POSTER_HEIGHT);

    ctx.setStrokeStyle('rgba(157, 190, 255, 0.08)');
    ctx.setLineWidth(1);
    for (let x = 0; x <= SHARE_POSTER_WIDTH; x += 54) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SHARE_POSTER_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= SHARE_POSTER_HEIGHT; y += 54) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SHARE_POSTER_WIDTH, y);
      ctx.stroke();
    }

    drawShareRoundedRect(ctx, 64, 72, SHARE_POSTER_WIDTH - 128, SHARE_POSTER_HEIGHT - 144, 42, 'rgba(8, 18, 34, 0.88)', 'rgba(125, 171, 255, 0.18)');
    drawShareRoundedRect(ctx, 96, 106, SHARE_POSTER_WIDTH - 192, 108, 28, theme.accentSoft, 'rgba(125, 171, 255, 0.14)');

    ctx.setFillStyle('#f7fbff');
    ctx.setFontSize(54);
    const titleBottom = fillShareWrappedText(ctx, card.nodeName, 128, 168, SHARE_POSTER_WIDTH - 256, 68, 2);

    ctx.setFillStyle('rgba(215, 231, 255, 0.82)');
    ctx.setFontSize(28);
    const subtitleBottom = card.shareSubtitle
      ? fillShareWrappedText(ctx, card.shareSubtitle, 128, titleBottom + 12, SHARE_POSTER_WIDTH - 320, 40, 2)
      : titleBottom;

    drawShareRoundedRect(ctx, SHARE_POSTER_WIDTH - 278, 130, 150, 64, 32, 'rgba(10, 24, 48, 0.85)', 'rgba(125, 171, 255, 0.24)');
    ctx.setFillStyle('#d8e8ff');
    ctx.setFontSize(28);
    ctx.fillText(`Lv.${card.studentLevel}`, SHARE_POSTER_WIDTH - 234, 172);

    ctx.setFillStyle('rgba(194, 214, 248, 0.76)');
    ctx.setFontSize(24);
    ctx.fillText(`${card.studentDisplayName} · ${card.generatedAtText}`, 128, subtitleBottom + (card.shareSubtitle ? 54 : 42));

    const metricTop = subtitleBottom + (card.shareSubtitle ? 96 : 84);
    const metricWidth = 392;
    const metricHeight = 120;
    card.metrics.forEach((metric, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = 128 + col * (metricWidth + 28);
      const y = metricTop + row * (metricHeight + 24);
      drawShareRoundedRect(ctx, x, y, metricWidth, metricHeight, 28, 'rgba(12, 25, 49, 0.88)', 'rgba(125, 171, 255, 0.14)');
      ctx.setFillStyle('rgba(194, 214, 248, 0.74)');
      ctx.setFontSize(22);
      ctx.fillText(metric.label, x + 24, y + 34);
      ctx.setFillStyle('#ffffff');
      ctx.setFontSize(36);
      ctx.fillText(metric.value, x + 24, y + 82);
    });

    let tagX = 128;
    let tagY = metricTop + metricHeight * 2 + 48;
    ctx.setFontSize(24);
    card.tags.forEach((tag) => {
      const width = Math.min(260, ctx.measureText(tag).width + 40);
      if (tagX + width > SHARE_POSTER_WIDTH - 128) {
        tagX = 128;
        tagY += 58;
      }
      drawShareRoundedRect(ctx, tagX, tagY, width, 44, 22, 'rgba(10, 24, 44, 0.82)', 'rgba(128, 173, 255, 0.2)');
      ctx.setFillStyle('#bcd8ff');
      ctx.fillText(tag, tagX + 20, tagY + 29);
      tagX += width + 14;
    });

    let contentTop = tagY + 84;
    if (card.isMonthSummary) {
      contentTop = this.drawShareCalendarPanel(ctx, card.summaryCalendar, theme, contentTop);
    }
    if (coverImageInfo && !card.isMonthSummary) {
      const coverX = 128;
      const coverY = contentTop;
      const coverWidth = SHARE_POSTER_WIDTH - 256;
      const coverHeight = 210;
      drawShareRoundedRect(ctx, coverX, coverY, coverWidth, coverHeight, 30, 'rgba(7, 15, 29, 0.9)', 'rgba(125, 171, 255, 0.18)');
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(coverX + 30, coverY);
      ctx.lineTo(coverX + coverWidth - 30, coverY);
      ctx.arcTo(coverX + coverWidth, coverY, coverX + coverWidth, coverY + 30, 30);
      ctx.lineTo(coverX + coverWidth, coverY + coverHeight - 30);
      ctx.arcTo(coverX + coverWidth, coverY + coverHeight, coverX + coverWidth - 30, coverY + coverHeight, 30);
      ctx.lineTo(coverX + 30, coverY + coverHeight);
      ctx.arcTo(coverX, coverY + coverHeight, coverX, coverY + coverHeight - 30, 30);
      ctx.lineTo(coverX, coverY + 30);
      ctx.arcTo(coverX, coverY, coverX + 30, coverY, 30);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(coverImageInfo.path, coverX, coverY, coverWidth, coverHeight);
      ctx.restore();
      ctx.setFillStyle('rgba(4, 10, 20, 0.54)');
      ctx.fillRect(coverX, coverY + coverHeight - 58, coverWidth, 58);
      ctx.setFillStyle('#eaf5ff');
      ctx.setFontSize(24);
      ctx.fillText(`${card.coverTitle} ${card.coverImageCount} 张`, coverX + 26, coverY + coverHeight - 22);
      contentTop += coverHeight + 34;
    }

    const codeBoxHeight = card.isMonthSummary ? 220 : 320;
    const codeMaxLines = card.isMonthSummary ? 6 : 9;
    const codeBoxTop = contentTop;
    drawShareRoundedRect(ctx, 128, codeBoxTop, SHARE_POSTER_WIDTH - 256, codeBoxHeight, 32, 'rgba(7, 15, 29, 0.9)', 'rgba(125, 171, 255, 0.18)');
    ctx.setFillStyle(theme.neon);
    ctx.setFontSize(24);
    ctx.fillText(String(card.codeSectionTitle || '代码'), 160, codeBoxTop + 42);
    ctx.setFillStyle('rgba(194, 214, 248, 0.74)');
    ctx.setFontSize(22);
    ctx.fillText(`${card.codeLineCount} 行`, SHARE_POSTER_WIDTH - 230, codeBoxTop + 42);
    ctx.setFillStyle('#edf6ff');
    ctx.setFontSize(24);
    fillShareWrappedText(ctx, card.codeSnippet, 160, codeBoxTop + 92, SHARE_POSTER_WIDTH - 320, 34, codeMaxLines);

    let footerTop = codeBoxTop + codeBoxHeight + 40;
    if (card.insightText) {
      const insightHeight = card.isMonthSummary ? 148 : 180;
      drawShareRoundedRect(ctx, 128, footerTop, SHARE_POSTER_WIDTH - 256, insightHeight, 28, 'rgba(10, 24, 38, 0.86)', 'rgba(88, 210, 190, 0.18)');
      ctx.setFillStyle(theme.neon);
      ctx.setFontSize(24);
      ctx.fillText(String(card.insightTitle || 'Insight').toUpperCase(), 160, footerTop + 38);
      ctx.setFillStyle('rgba(194, 214, 248, 0.72)');
      ctx.setFontSize(22);
      if (card.insightMeta) {
        ctx.fillText(card.insightMeta, SHARE_POSTER_WIDTH - 270, footerTop + 38);
      }
      ctx.setFillStyle('rgba(226, 239, 255, 0.88)');
      ctx.setFontSize(24);
      fillShareWrappedText(ctx, card.insightText, 160, footerTop + 82, SHARE_POSTER_WIDTH - 320, 34, card.isMonthSummary ? 3 : 4);
      footerTop += insightHeight + 26;
    }

    ctx.setFillStyle('rgba(194, 214, 248, 0.72)');
    ctx.setFontSize(24);
    if (card.pathText) {
      ctx.fillText(`路径：${card.pathText}`, 128, footerTop);
    }
    ctx.fillText(card.footerLeftText, 128, footerTop + 40);
    ctx.fillText(card.footerRightText, SHARE_POSTER_WIDTH - 290, footerTop + 40);
    if (card.encouragementText) {
      ctx.setFillStyle('rgba(226, 239, 255, 0.88)');
      fillShareWrappedText(ctx, `寄语：${card.encouragementText}`, 128, footerTop + 86, SHARE_POSTER_WIDTH - 256, 34, 2);
    }

    return new Promise((resolve) => ctx.draw(false, resolve));
  },

  getDraftImagesForNode(nodeId) {
    return this.draftImageStore.get(getDraftImageKey(nodeId)) || [];
  },

  getDraftImageForNode(nodeId) {
    return this.getDraftImagesForNode(nodeId)[0] || null;
  },

  setDraftImagesForNode(nodeId, payloads) {
    const key = getDraftImageKey(nodeId);
    if (!Array.isArray(payloads) || !payloads.length) {
      this.draftImageStore.delete(key);
      return;
    }
    this.draftImageStore.set(key, payloads);
  },

  setDraftImageForNode(nodeId, payload) {
    this.setDraftImagesForNode(nodeId, payload ? [payload] : []);
  },

  getDraftFilesForNode(nodeId) {
    return this.draftFileStore.get(getDraftImageKey(`file:${nodeId}`)) || [];
  },

  setDraftFilesForNode(nodeId, payloads) {
    const key = getDraftImageKey(`file:${nodeId}`);
    if (!Array.isArray(payloads) || !payloads.length) {
      this.draftFileStore.delete(key);
      return;
    }
    this.draftFileStore.set(key, payloads);
  },

  getDraftAttachmentCountForNode(nodeId) {
    return this.getDraftImagesForNode(nodeId).length + this.getDraftFilesForNode(nodeId).length;
  },

  setTreeData(treeIndex, patch) {
    if (!Number.isInteger(treeIndex)) {
      return;
    }
    const updates = {};
    Object.keys(patch).forEach((key) => {
      updates[`trees[${treeIndex}].${key}`] = patch[key];
    });
    this.setData(updates);
  },

  setNodeData(treeIndex, nodeId, patch) {
    if (!Number.isInteger(treeIndex) || nodeId === undefined || nodeId === null || nodeId === '') {
      return;
    }

    const tree = this.data.trees[treeIndex];
    if (!tree) {
      return;
    }

    const nodeIndex = findNodeIndexById(tree.flatNodes, nodeId);
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0) {
      return;
    }

    const updates = {};
    Object.keys(patch).forEach((key) => {
      updates[`trees[${treeIndex}].flatNodes[${nodeIndex}].${key}`] = patch[key];
    });
    this.setData(updates);
  },

  getNodeFromDataset(dataset = {}, options = {}) {
    const treeIndex = Number(dataset.treeIndex);
    const nodeId = dataset.nodeId === undefined || dataset.nodeId === null
      ? ''
      : String(dataset.nodeId);

    if (!Number.isInteger(treeIndex) || !nodeId) {
      return null;
    }

    const tree = this.data.trees[treeIndex];
    if (!tree) {
      return null;
    }

    const nodeIndex = findNodeIndexById(tree.flatNodes, nodeId);
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0) {
      return null;
    }

    const node = tree.flatNodes[nodeIndex];
    if (!node) {
      return null;
    }

    if (options.requireSubmittable && !node.canSubmit) {
      return null;
    }

    return { treeIndex, nodeId, nodeIndex, node };
  },

  confirmAction(options = {}) {
    return new Promise((resolve) => {
      wx.showModal({
        title: options.title || '请确认',
        content: options.content || '是否继续？',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        success: (resp) => resolve(!!resp.confirm),
        fail: () => resolve(false),
      });
    });
  },


  buildLazyPanelPatch(trees = [], options = {}) {
    const starScenesExpanded = options.starScenesExpanded !== undefined
      ? !!options.starScenesExpanded
      : !!this.data.starScenesExpanded;
    const profileExpanded = options.profileExpanded !== undefined
      ? !!options.profileExpanded
      : !!this.data.profileExpanded;
    return {
      knowledgeScene: starScenesExpanded ? buildKnowledgeSceneFromTrees(trees) : buildEmptyKnowledgeScene(),
      rewardScene: starScenesExpanded ? buildRewardSceneFromTrees(trees) : buildEmptyRewardScene(),
      studentProfileSummary: profileExpanded ? buildStudentProfileSummaryFromTrees(trees) : buildEmptyStudentProfileSummary(),
    };
  },

  handleToggleStarScenes() {
    const nextExpanded = !this.data.starScenesExpanded;
    const patch = this.buildLazyPanelPatch(this.data.trees, {
      starScenesExpanded: nextExpanded,
      profileExpanded: this.data.profileExpanded,
    });
    if (!nextExpanded) {
      this.stopConstellationLoop();
      this.constellations = {};
    }
    this.setData({
      starScenesExpanded: nextExpanded,
      ...patch,
    }, () => {
      this.scheduleFocusModuleMeasure();
      if (nextExpanded) {
        this.scheduleConstellationSetup(60);
      }
    });
  },

  handleToggleProfilePanel() {
    const nextExpanded = !this.data.profileExpanded;
    const patch = this.buildLazyPanelPatch(this.data.trees, {
      starScenesExpanded: this.data.starScenesExpanded,
      profileExpanded: nextExpanded,
    });
    this.setData({
      profileExpanded: nextExpanded,
      ...patch,
    }, () => {
      this.scheduleFocusModuleMeasure();
    });
  },

  async bootstrap() {
    const localStudent = getStudent();
    if (!localStudent) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    this.setData({ loading: true, errorText: '' });

    try {
      await this.loadStudentProfile();
      await Promise.all([
        this.loadTrees(),
        this.loadRewardPrompt(),
      ]);
    } catch (err) {
      clearSession();
      this.setData({ errorText: err.message || '登录状态已失效，请重新登录' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login/login' });
      }, 400);
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadStudentProfile() {
    const me = await request('/api/student/me');
    setStudentProfile(me);
    this.setData({
      studentName: formatStudentName(me),
      studentProfile: buildStudentHeroProfile(me),
    });
    return me;
  },

  async loadTrees() {
    this.draftImageStore.clear();
    this.draftFileStore.clear();
    const trees = (await request('/api/student/trees')).map((tree, index) => decorateTree(tree, index));
    this.setData({
      trees,
      pageSummary: buildPageSummary(trees),
      monthActivity: buildMonthActivityFromTrees(trees),
      rewardTreeProgress: buildWeeklyRewardTreeProgressFromTrees(trees),
      ...this.buildLazyPanelPatch(trees),
    }, () => {
      this.scheduleFocusModuleMeasure();
      if (this.data.starScenesExpanded) {
        this.scheduleConstellationSetup(120);
      } else {
        this.stopConstellationLoop();
        this.constellations = {};
      }
    });
  },

  async loadRewardPrompt() {
    const payload = await request('/api/student/reward-center');
    const rewardPrompt = buildRewardPrompt(payload || {});
    const previousCount = Number((this.data.rewardPrompt && this.data.rewardPrompt.claimableCount) || 0);
    this.setData({
      rewardPrompt,
    }, () => {
      this.scheduleFocusModuleMeasure();
    });
    if (rewardPrompt.hasClaimable && rewardPrompt.claimableCount !== previousCount) {
      wx.showToast({
        title: `可领 ${rewardPrompt.claimablePoints} 积分`,
        icon: 'none',
      });
    }
    return payload;
  },

  async handleRefresh() {
    this.setData({ loading: true, errorText: '' });
    try {
      if (this.data.shareMode && this.data.shareId) {
        await this.loadShareCard(this.data.shareId);
      } else {
        await this.loadStudentProfile();
        await Promise.all([
          this.loadTrees(),
          this.loadRewardPrompt(),
        ]);
      }
      wx.showToast({ title: '已刷新', icon: 'success' });
    } catch (err) {
      this.setData({ errorText: err.message || '刷新失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  handleOpenRewardCenter() {
    wx.navigateTo({ url: '/pages/rewards/rewards' });
  },

  async handleLogout() {
    const confirmed = await this.confirmAction({
      title: '退出登录',
      content: '确定退出当前学生账号吗？',
    });
    if (!confirmed) {
      return;
    }

    try {
      await request('/api/student/logout', {
        method: 'POST',
      });
    } catch (_err) {
    }

    clearSession();
    wx.redirectTo({ url: '/pages/login/login' });
  },

  onCodeInput(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeId, {
      codeDraft: e.detail.value || '',
    });
  },

  handleToggleWorkPanel(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeId, {
      editorExpanded: !located.node.editorExpanded,
    });
    this.scheduleFocusModuleMeasure();
  },

  handleToggleBranch(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located || !located.node.hasChildren) {
      return;
    }

    const tree = this.data.trees[located.treeIndex];
    if (!tree) {
      return;
    }

    const nextNodes = applyBranchVisibility(tree.flatNodes.map((item) => (
      String(item.id) === String(located.nodeId)
        ? { ...item, branchExpanded: !item.branchExpanded }
        : { ...item }
    )));

    this.setTreeData(located.treeIndex, { flatNodes: nextNodes });
    this.scheduleFocusModuleMeasure();
  },

  handleToggleTree(e) {
    const treeIndex = Number(e.currentTarget.dataset.treeIndex);
    if (!Number.isInteger(treeIndex)) {
      return;
    }
    const tree = this.data.trees[treeIndex];
    if (!tree) {
      return;
    }
    this.setTreeData(treeIndex, { treeExpanded: !tree.treeExpanded });
    this.scheduleFocusModuleMeasure();
  },

  async handleOpenProblemAttachment(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    const attachmentIndex = Number(e.currentTarget.dataset.attachmentIndex);
    const attachment = located && Array.isArray(located.node.problemAttachments)
      ? located.node.problemAttachments[attachmentIndex]
      : null;
    if (!located || !attachment || (!attachment.url && !attachment.fileId)) {
      return;
    }

    try {
      this.setData({ errorText: '' });
      if (attachment.kind === 'image') {
        wx.previewImage({
          current: attachment.previewUrl || attachment.url,
          urls: [attachment.previewUrl || attachment.url],
        });
        return;
      }

      wx.showLoading({
        title: '加载预览',
        mask: true,
      });
      const previewInfo = await resolveProblemAttachmentPreviewInfo(located.node.id, attachment);
      const previewUrl = String(previewInfo.url || '').trim();
      if (!previewUrl) {
        throw new Error('题目预览地址不存在');
      }
      await new Promise((resolve, reject) => {
        wx.navigateTo({
          url: `/pages/pdf-viewer/pdf-viewer?file=${encodeURIComponent(previewUrl)}&name=${encodeURIComponent(previewInfo.fileName || attachment.fileName || '题目资料.pdf')}`,
          success: resolve,
          fail: reject,
        });
      });
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '打开题目资料失败');
      this.setData({ errorText: msg });
    } finally {
      wx.hideLoading();
    }
  },

  async handleSaveProblemAttachment(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    const attachmentIndex = Number(e.currentTarget.dataset.attachmentIndex);
    const attachment = located && Array.isArray(located.node.problemAttachments)
      ? located.node.problemAttachments[attachmentIndex]
      : null;
    if (!located || !attachment || (!attachment.url && !attachment.fileId)) {
      return;
    }

    try {
      this.setData({ errorText: '' });
      const documentType = inferDocumentFileType(attachment.fileName, attachment.mimeType) || 'pdf';
      wx.showLoading({
        title: '保存中',
        mask: true,
      });
      const downloaded = await downloadProblemAttachmentFile(located.node.id, attachment);
      if (attachment.kind === 'image') {
        await saveImageToAlbum(downloaded.tempFilePath);
        wx.showToast({ title: '题图已保存', icon: 'success' });
        return;
      }

      const saved = await saveTempFile(downloaded.tempFilePath);
      const reopen = await this.confirmAction({
        title: '题目资料已保存',
        content: '题目资料已保存到小程序本地文件，是否立即打开？',
        confirmText: '打开',
        cancelText: '关闭',
      });
      if (reopen) {
        await openLocalDocument(saved.savedFilePath || downloaded.tempFilePath, documentType);
      } else {
        wx.showToast({ title: '题目资料已保存', icon: 'success' });
      }
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '保存题目资料失败');
      this.setData({ errorText: msg });
    } finally {
      wx.hideLoading();
    }
  },

  getSubmissionFileFromDataset(dataset = {}) {
    const located = this.getNodeFromDataset(dataset, { requireSubmittable: true });
    if (!located) {
      return null;
    }

    const fileIndex = Number(dataset.fileIndex);
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      return null;
    }

    const fileSource = String(dataset.fileSource || 'latest');
    if (fileSource === 'history') {
      const submissionId = String(dataset.submissionId || '');
      const submission = (located.node.submissionHistory || []).find((item) => String(item.id) === submissionId);
      const fileItem = submission && Array.isArray(submission.nonImageFileItems)
        ? submission.nonImageFileItems[fileIndex]
        : null;
      return fileItem ? { located, fileItem } : null;
    }

    const fileItem = Array.isArray(located.node.latestNonImageFileItems)
      ? located.node.latestNonImageFileItems[fileIndex]
      : null;
    return fileItem ? { located, fileItem } : null;
  },

  async openSubmissionFileItem(fileItem, mode = 'open') {
    if (!fileItem || !fileItem.url) {
      return;
    }

    const downloaded = await downloadRemoteFile(fileItem.url);
    const documentType = inferDocumentFileType(fileItem.fileName, fileItem.mimeType);

    if (mode === 'save') {
      const saved = await saveTempFile(downloaded.tempFilePath);
      if (!documentType) {
        wx.showToast({ title: '附件已保存', icon: 'success' });
        return;
      }

      const reopen = await this.confirmAction({
        title: '附件已保存',
        content: `${fileItem.fileName} 已保存，是否立即打开？`,
        confirmText: '打开',
        cancelText: '关闭',
      });
      if (reopen) {
        await openLocalDocument(saved.savedFilePath || downloaded.tempFilePath, documentType);
      } else {
        wx.showToast({ title: '附件已保存', icon: 'success' });
      }
      return;
    }

    if (!documentType) {
      await saveTempFile(downloaded.tempFilePath);
      wx.showToast({ title: '该格式已保存', icon: 'success' });
      return;
    }

    await openLocalDocument(downloaded.tempFilePath, documentType);
  },

  async handleOpenSubmissionFile(e) {
    const resolved = this.getSubmissionFileFromDataset(e.currentTarget.dataset);
    if (!resolved) {
      return;
    }

    try {
      this.setData({ errorText: '' });
      await this.openSubmissionFileItem(resolved.fileItem, 'open');
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '打开附件失败');
      this.setData({ errorText: msg });
    }
  },

  async handleSaveSubmissionFile(e) {
    const resolved = this.getSubmissionFileFromDataset(e.currentTarget.dataset);
    if (!resolved) {
      return;
    }

    try {
      this.setData({ errorText: '' });
      await this.openSubmissionFileItem(resolved.fileItem, 'save');
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '保存附件失败');
      this.setData({ errorText: msg });
    }
  },

  async submitNodeSubmission(located) {
    if (!located || located.node.working) {
      return;
    }

    const codeText = (located.node.codeDraft || '').trim();
    const draftImages = this.getDraftImagesForNode(located.node.id);
    const draftFiles = this.getDraftFilesForNode(located.node.id);
    if (!codeText && !draftImages.length && !draftFiles.length) {
      this.setData({ errorText: '请先输入代码文本或选择附件再提交' });
      return;
    }

    const activeLoadingTip = pickRandomTip(this.data.activeLoadingTip ? this.data.activeLoadingTip.key : '');
    this.setNodeData(located.treeIndex, located.nodeId, { working: true });
    this.setData({ errorText: '', submitOverlayVisible: true, activeLoadingTip });

    try {
      const fileItems = draftImages
        .map((item, index) => ({
          base64: item.base64,
          mimeType: item.mimeType,
          fileName: item.fileName || `提交图片${index + 1}`,
        }))
        .concat(
          draftFiles.map((item, index) => ({
            base64: item.base64,
            mimeType: item.mimeType,
            fileName: item.fileName || `提交附件${index + 1}`,
          }))
        );

      const payload = await request('/api/student/node-submissions', {
        method: 'POST',
        data: {
          nodeId: located.node.id,
          codeText,
          fileItems,
        },
      });

      const newHistoryItem = decorateSubmission(payload);
      const nextSubmissionHistory = [newHistoryItem].concat(located.node.submissionHistory || []);
      const scoredSubmissionValues = nextSubmissionHistory
        .map((item) => item.teacherScoreValue)
        .filter((score) => score !== null && !Number.isNaN(score));

      const highestTeacherScore = scoredSubmissionValues.length
        ? Math.max(...scoredSubmissionValues)
        : null;
      const averageTeacherScore = scoredSubmissionValues.length
        ? scoredSubmissionValues.reduce((sum, score) => sum + score, 0) / scoredSubmissionValues.length
        : null;

      const latestTeacherScore = payload.teacher_score === null || payload.teacher_score === undefined
        ? null
        : Number(payload.teacher_score);
      const nextSubmissionCount = nextSubmissionHistory.length;
      const latestFileItems = newHistoryItem.fileItems || [];
      const latestImageItems = newHistoryItem.imageItems || [];
      const latestNonImageFileItems = newHistoryItem.nonImageFileItems || [];
      const firstLatestImage = latestImageItems[0] || null;

      const nextNodePatch = {
        codeText: payload.code_text || '',
        codeImageUrl: firstLatestImage ? firstLatestImage.url : '',
        latestFileItems,
        latestImageItems,
        latestNonImageFileItems,
        latestImagePreviewUrl: firstLatestImage ? firstLatestImage.previewUrl : '',
        submissionHistory: nextSubmissionHistory,
        submissionCount: nextSubmissionCount,
        latestTeacherScore,
        latestTeacherScoreText: latestTeacherScore === null || Number.isNaN(latestTeacherScore)
          ? '-'
          : formatNumber(latestTeacherScore),
        latestTeacherScoreClass: latestTeacherScore === null || Number.isNaN(latestTeacherScore)
          ? ''
          : getScoreClass(latestTeacherScore),
        highestTeacherScore,
        highestTeacherScoreText: highestTeacherScore === null || Number.isNaN(highestTeacherScore)
          ? '-'
          : formatNumber(highestTeacherScore),
        highestTeacherScoreClass: highestTeacherScore === null || Number.isNaN(highestTeacherScore)
          ? ''
          : getScoreClass(highestTeacherScore),
        averageTeacherScore,
        averageTeacherScoreText: averageTeacherScore === null || Number.isNaN(averageTeacherScore)
          ? '-'
          : formatNumber(averageTeacherScore),
        averageTeacherScoreClass: averageTeacherScore === null || Number.isNaN(averageTeacherScore)
          ? ''
          : getScoreClass(averageTeacherScore),
        latestTeacherComment: payload.teacher_comment || '',
        latestSubmittedAt: payload.submitted_at || '',
        latestSubmittedAtText: formatDateTime(payload.submitted_at),
        codeDraft: '',
        draftImageItems: [],
        draftFileItems: [],
        draftImagePreviewUrl: '',
        working: false,
      };

      const nextTrees = this.data.trees.map((tree, treeIndex) => {
        if (treeIndex !== located.treeIndex) {
          return tree;
        }
        return {
          ...tree,
          flatNodes: (tree.flatNodes || []).map((item) => (
            String(item.id) === String(located.nodeId)
              ? { ...item, ...nextNodePatch }
              : item
          )),
        };
      });

      this.setDraftImagesForNode(located.node.id, []);
      this.setDraftFilesForNode(located.node.id, []);
      this.setNodeData(located.treeIndex, located.nodeId, nextNodePatch);
      this.setData({
        pageSummary: buildPageSummary(nextTrees),
        monthActivity: buildMonthActivityFromTrees(nextTrees),
        rewardTreeProgress: buildWeeklyRewardTreeProgressFromTrees(nextTrees),
        submitOverlayVisible: false,
        ...this.buildLazyPanelPatch(nextTrees),
      }, () => {
        this.scheduleFocusModuleMeasure();
        if (this.data.starScenesExpanded) {
          this.scheduleConstellationSetup(80);
        } else {
          this.stopConstellationLoop();
          this.constellations = {};
        }
      });

      wx.showToast({ title: '提交成功', icon: 'success' });
    } catch (err) {
      this.setNodeData(located.treeIndex, located.nodeId, { working: false });
      this.setData({ errorText: err.message || '提交失败', submitOverlayVisible: false });
    }
  },

  async handleSubmitSubmission(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }
    await this.submitNodeSubmission(located);
  },

  async handleCreateShareCard(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located || located.node.shareWorking) {
      return;
    }

    if (!located.node.submissionCount && !String(located.node.codeText || '').trim()) {
      this.setData({ errorText: '请先完成一次提交后再生成成果卡' });
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeId, { shareWorking: true });
    this.setData({ errorText: '' });
    try {
      const payload = await request('/api/student/share-cards', {
        method: 'POST',
        data: {
          nodeId: located.node.id,
        },
      });
      await this.enterShareMode(payload, 'inline');
    } catch (err) {
      const message = err.message || '生成成果卡失败';
      this.setData({ errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setNodeData(located.treeIndex, located.nodeId, { shareWorking: false });
    }
  },


  async handleCreateSummaryShareCard() {
    if (this.data.summaryShareWorking) {
      return;
    }

    const selected = await chooseSummaryShareScope();
    if (!selected) {
      return;
    }

    this.setData({ summaryShareWorking: true, errorText: '' });
    try {
      const payload = await request('/api/student/share-cards', {
        method: 'POST',
        data: {
          mode: 'summary',
          summaryScope: selected.value,
        },
      });
      await this.enterShareMode(payload, 'inline');
    } catch (err) {
      const message = err.message || '生成学习报告失败';
      this.setData({ errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setData({ summaryShareWorking: false });
    }
  },

  async handlePickImage(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    const existingDrafts = this.getDraftImagesForNode(located.node.id);
    const remaining = MAX_SUBMISSION_ATTACHMENTS - this.getDraftAttachmentCountForNode(located.node.id);
    if (remaining <= 0) {
      this.setData({ errorText: `最多只能附带 ${MAX_SUBMISSION_ATTACHMENTS} 份提交附件` });
      return;
    }

    try {
      const chosen = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: Math.min(remaining, MAX_SUBMISSION_ATTACHMENTS),
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject,
        });
      });

      const tempFiles = Array.isArray(chosen.tempFiles) && chosen.tempFiles.length
        ? chosen.tempFiles
        : (Array.isArray(chosen.tempFilePaths)
          ? chosen.tempFilePaths.map((filePath) => ({ tempFilePath: filePath, path: filePath }))
          : []);
      if (!tempFiles.length) {
        throw new Error('未选择到图片');
      }

      const nextDrafts = [];
      for (let index = 0; index < tempFiles.length; index += 1) {
        const file = tempFiles[index] || {};
        const filePath = file.path || file.tempFilePath || (chosen.tempFilePaths && chosen.tempFilePaths[index]) || '';
        if (!filePath) {
          continue;
        }
        const mimeType = inferImageMimeType(filePath);
        const defaultExt = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
        nextDrafts.push({
          key: `draft-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`,
          base64: await readFileAsBase64(filePath),
          mimeType,
          fileName: getFileNameFromPath(filePath, `提交图片${existingDrafts.length + index + 1}.${defaultExt}`),
          tempFilePath: filePath,
          kind: 'image',
        });
      }

      const mergedDrafts = existingDrafts.concat(nextDrafts).slice(0, MAX_SUBMISSION_ATTACHMENTS);
      this.setDraftImagesForNode(located.node.id, mergedDrafts);
      this.setNodeData(located.treeIndex, located.nodeId, {
        draftImageItems: buildDraftImageViewItems(mergedDrafts),
        draftImagePreviewUrl: mergedDrafts[0] ? mergedDrafts[0].tempFilePath : '',
      });
      this.setData({ errorText: '' });
      wx.showToast({ title: `已选 ${nextDrafts.length} 张`, icon: 'success' });
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (msg.includes('cancel')) {
        return;
      }
      this.setData({ errorText: msg || '上传图片失败' });
    }
  },

  async handlePickFile(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    const existingImages = this.getDraftImagesForNode(located.node.id);
    const existingFiles = this.getDraftFilesForNode(located.node.id);
    const remaining = MAX_SUBMISSION_ATTACHMENTS - this.getDraftAttachmentCountForNode(located.node.id);
    if (remaining <= 0) {
      this.setData({ errorText: `最多只能附带 ${MAX_SUBMISSION_ATTACHMENTS} 份提交附件` });
      return;
    }

    try {
      const chosen = await new Promise((resolve, reject) => {
        wx.chooseMessageFile({
          count: Math.min(remaining, MAX_SUBMISSION_ATTACHMENTS),
          type: 'file',
          success: resolve,
          fail: reject,
        });
      });

      const tempFiles = Array.isArray(chosen.tempFiles) ? chosen.tempFiles : [];
      if (!tempFiles.length) {
        throw new Error('未选择到附件');
      }

      const nextImages = [];
      const nextFiles = [];
      for (let index = 0; index < tempFiles.length; index += 1) {
        const file = tempFiles[index] || {};
        const filePath = file.path || file.tempFilePath || '';
        if (!filePath) {
          continue;
        }
        const fileName = String(file.name || getFileNameFromPath(filePath, `提交附件${existingFiles.length + index + 1}`)).trim() || `提交附件${existingFiles.length + index + 1}`;
        const mimeType = String(file.type || '').trim() || inferDraftFileMimeType(fileName);
        const kind = getSubmissionFileKind({ fileName, mimeType });
        const payload = {
          key: `draft-file-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`,
          base64: await readFileAsBase64(filePath),
          mimeType,
          fileName,
          tempFilePath: filePath,
          kind,
        };
        if (kind === 'image') {
          nextImages.push(payload);
        } else {
          nextFiles.push(payload);
        }
      }

      const mergedImages = existingImages.concat(nextImages).slice(0, MAX_SUBMISSION_ATTACHMENTS);
      const remainingFileSlots = Math.max(0, MAX_SUBMISSION_ATTACHMENTS - mergedImages.length);
      const mergedFiles = existingFiles.concat(nextFiles).slice(0, remainingFileSlots);

      this.setDraftImagesForNode(located.node.id, mergedImages);
      this.setDraftFilesForNode(located.node.id, mergedFiles);
      this.setNodeData(located.treeIndex, located.nodeId, {
        draftImageItems: buildDraftImageViewItems(mergedImages),
        draftFileItems: buildDraftFileViewItems(mergedFiles),
        draftImagePreviewUrl: mergedImages[0] ? mergedImages[0].tempFilePath : '',
      });
      this.setData({ errorText: '' });
      wx.showToast({ title: `已选 ${nextImages.length + nextFiles.length} 份`, icon: 'success' });
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (msg.includes('cancel')) {
        return;
      }
      this.setData({ errorText: msg || '选择附件失败' });
    }
  },

  handleRemoveDraftImage(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    const imageKey = String(e.currentTarget.dataset.imageKey || '');
    const currentDrafts = this.getDraftImagesForNode(located.node.id);
    const target = currentDrafts.find((item) => item.key === imageKey);

    this.confirmAction({
      title: '删除草稿图片',
      content: target ? `确定移除草稿图片“${target.fileName}”吗？` : '确定移除当前待提交的图片吗？',
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }

      const nextDrafts = imageKey
        ? currentDrafts.filter((item) => item.key !== imageKey)
        : currentDrafts.slice(0, -1);
      this.setDraftImagesForNode(located.node.id, nextDrafts);
      this.setNodeData(located.treeIndex, located.nodeId, {
        draftImageItems: buildDraftImageViewItems(nextDrafts),
        draftImagePreviewUrl: nextDrafts[0] ? nextDrafts[0].tempFilePath : '',
      });
      wx.showToast({ title: '图片已删除', icon: 'success' });
    });
  },

  handleRemoveDraftFile(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    const fileKey = String(e.currentTarget.dataset.fileKey || '');
    const currentDrafts = this.getDraftFilesForNode(located.node.id);
    const target = currentDrafts.find((item) => item.key === fileKey);

    this.confirmAction({
      title: '删除草稿附件',
      content: target ? `确定移除草稿附件“${target.fileName}”吗？` : '确定移除当前待提交的附件吗？',
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }

      const nextDrafts = fileKey
        ? currentDrafts.filter((item) => item.key !== fileKey)
        : currentDrafts.slice(0, -1);
      this.setDraftFilesForNode(located.node.id, nextDrafts);
      this.setNodeData(located.treeIndex, located.nodeId, {
        draftFileItems: buildDraftFileViewItems(nextDrafts),
      });
      wx.showToast({ title: '附件已删除', icon: 'success' });
    });
  },

  async handleClearDraft(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset, { requireSubmittable: true });
    if (!located) {
      return;
    }

    const confirmed = await this.confirmAction({
      title: '清空草稿',
      content: '确定清空当前文本和草稿附件吗？',
    });
    if (!confirmed) {
      return;
    }

    this.setDraftImagesForNode(located.node.id, []);
    this.setDraftFilesForNode(located.node.id, []);
    this.setNodeData(located.treeIndex, located.nodeId, {
      codeDraft: '',
      draftImageItems: [],
      draftFileItems: [],
      draftImagePreviewUrl: '',
    });
    this.setData({ errorText: '' });
    wx.showToast({ title: '草稿已清空', icon: 'success' });
  },

  handlePreviewImage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) {
      return;
    }
    wx.previewImage({
      current: url,
      urls: [url],
    });
  },
});
