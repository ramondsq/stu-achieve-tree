const { request } = require('../../utils/request');

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 2280;

function formatScore(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return '-';
  }
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

function formatScoreWithDenominator(value, denominator = 10) {
  const formatted = formatScore(value);
  return formatted === '-' ? '-' : `${formatted} / ${denominator}`;
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

function getThemeIndex(seed = '') {
  const value = String(seed || '').slice(0, 2);
  const num = Number.parseInt(value || '0', 16);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num % 3;
}

function normalizeSummaryHighlights(raw) {
  return Array.isArray(raw)
    ? raw.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 4)
    : [];
}

function buildNodeMetrics(raw) {
  return [
    { label: '最高得分', value: formatScoreWithDenominator(raw.highest_teacher_score) },
    { label: '提交次数', value: `${Number(raw.submission_count || 0)} 次` },
    { label: '节点得分', value: `${formatScore(raw.node_current_score)} / ${formatScore(raw.node_total_score)}` },
    { label: '累计积分', value: `${Number(raw.student_total_points || 0)}` },
  ];
}

function buildSummaryMetrics(raw, scopeLabel) {
  return [
    { label: `${scopeLabel || '阶段'}提交`, value: `${Number(raw.submission_count || 0)} 次` },
    { label: '已获批改', value: `${Number(raw.reviewed_submission_count || 0)} 次` },
    { label: '覆盖任务点', value: `${Number(raw.active_node_count || 0)} 个` },
    { label: '平均评分', value: formatScoreWithDenominator(raw.average_teacher_score) },
  ];
}

function buildCardModel(raw = {}) {
  const shareKind = raw.share_kind === 'summary' ? 'summary' : 'node';
  const isSummary = shareKind === 'summary';
  const themeIndex = getThemeIndex(raw.theme_seed || '');
  const totalScore = Number(raw.tree_total_score || 0);
  const currentScore = Number(raw.tree_current_score || 0);
  const progressPercent = totalScore > 0
    ? Math.max(0, Math.min(100, Math.round((currentScore / totalScore) * 100)))
    : 0;
  const codeSnippet = String(raw.code_snippet || '').trim() || '// 暂无可展示的代码片段';
  const scopeLabel = String(raw.summary_scope_label || '').trim();
  const summaryCalendar = raw.summary_calendar && Array.isArray(raw.summary_calendar.cells)
    ? {
      monthLabel: raw.summary_calendar.month_label || '',
      summaryText: raw.summary_calendar.summary_text || '',
      activeDays: Number(raw.summary_calendar.active_days || 0),
      reviewedDays: Number(raw.summary_calendar.reviewed_days || 0),
      submittedCount: Number(raw.summary_calendar.submitted_count || 0),
      weekdayLabels: ['一', '二', '三', '四', '五', '六', '日'],
      legendItems: [
        { label: '未提交', band: 'none', bandClass: 'heatmap-band-none' },
        { label: '待评分', band: 'pending', bandClass: 'heatmap-band-pending' },
        { label: '0-3 分', band: 'low', bandClass: 'heatmap-band-low' },
        { label: '4-7 分', band: 'mid', bandClass: 'heatmap-band-mid' },
        { label: '8-10 分', band: 'high', bandClass: 'heatmap-band-high' },
      ],
      cells: raw.summary_calendar.cells.map((cell, index) => ({
        key: cell && cell.key ? cell.key : `share-cell-${index}`,
        placeholder: !!(cell && cell.placeholder),
        dayLabel: cell && cell.day_label ? String(cell.day_label) : '',
        band: cell && cell.band ? cell.band : 'none',
        bandClass: `heatmap-band-${cell && cell.band ? cell.band : 'none'}`,
        isToday: !!(cell && cell.is_today),
      })),
    }
    : null;
  const isMonthSummary = isSummary && String(raw.summary_scope || '').trim() === 'month' && summaryCalendar && summaryCalendar.cells.some((cell) => !cell.placeholder);
  const metrics = isSummary ? buildSummaryMetrics(raw, scopeLabel) : buildNodeMetrics(raw);
  const tags = [];
  if (isSummary && scopeLabel) {
    tags.push(scopeLabel);
  } else if (!isSummary) {
    tags.push(raw.tree_type === 'reward' ? '悬赏任务' : '知识学习');
  }
  if (totalScore > 0) {
    tags.push(`进度 ${progressPercent}%`);
  }
  if (raw.cover_image_count) {
    tags.push(`附图 ${Number(raw.cover_image_count || 0)} 张`);
  }

  let insightTitle = '';
  let insightMeta = '';
  let insightLines = [];
  if (isSummary) {
    insightTitle = '学习节点';
    insightMeta = '';
    insightLines = normalizeSummaryHighlights(raw.summary_highlights);
    if (!insightLines.length) {
      insightLines = [
        `${scopeLabel || '本阶段'}提交 ${Number(raw.submission_count || 0)} 次`,
        `覆盖 ${Number(raw.active_node_count || 0)} 个任务点`,
      ];
    }
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
    treeTitle: raw.tree_title || '学习树',
    treeType: raw.tree_type || '',
    nodeName: raw.node_name || '任务点',
    pathText: isSummary
      ? (raw.node_path || '整体学习情况')
      : (raw.node_path || raw.node_name || ''),
    codeSnippet,
    codeLineCount: Number(raw.code_line_count || (codeSnippet ? codeSnippet.split('\n').length : 0)),
    generatedAtText: formatDateTime(raw.created_at),
    latestSubmittedText: formatDateTime(raw.latest_submitted_at),
    latestReviewedText: formatDateTime(raw.latest_reviewed_at),
    highestScoreText: formatScore(raw.highest_teacher_score),
    latestScoreText: formatScore(raw.latest_teacher_score),
    averageScoreText: formatScore(raw.average_teacher_score),
    treeProgressText: `${formatScore(raw.tree_current_score)} / ${formatScore(raw.tree_total_score)}`,
    progressPercent,
    coverImageUrl: raw.cover_image_url || '',
    coverImageCount: Number(raw.cover_image_count || 0),
    coverTitle: '附图',
    codeSectionTitle: '代码',
    metrics,
    tags,
    insightTitle,
    insightMeta,
    insightLines,
    insightText: insightLines.join('\n'),
    footerLeftText: totalScore > 0 ? `总进度 ${progressPercent}%` : '总进度待生成',
    footerRightText: `积分 ${Number(raw.student_total_points || 0)}`,
    themeIndex,
    themeClass: `theme-${themeIndex + 1}`,
    summaryCalendar,
    isMonthSummary,
  };
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillColor, strokeColor) {
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

function wrapText(ctx, text, maxWidth, maxLines) {
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

function fillWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const lines = wrapText(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
  return y + lines.length * lineHeight;
}

function showModalPromise(options) {
  return new Promise((resolve) => {
    wx.showModal({
      ...options,
      success: (resp) => resolve(!!resp.confirm),
      fail: () => resolve(false),
    });
  });
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
      fail: reject,
    });
  });
}

Page({
  data: {
    loading: true,
    errorText: '',
    saving: false,
    shareId: '',
    card: null,
  },

  onLoad(options = {}) {
    if (typeof wx.showShareMenu === 'function') {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    }
    const shareId = String(options.id || '').trim();
    if (!shareId) {
      this.setData({ loading: false, errorText: '缺少分享卡 ID' });
      return;
    }
    this.loadCard(shareId);
  },

  async loadCard(shareId) {
    this.setData({ loading: true, errorText: '', shareId });
    try {
      const payload = await request(`/api/share-cards/${shareId}`, {
        method: 'GET',
        needAuth: false,
      });
      this.setData({
        loading: false,
        card: buildCardModel(payload),
      });
    } catch (err) {
      this.setData({
        loading: false,
        errorText: err.message || '加载分享卡失败',
      });
    }
  },

  async handleRefresh() {
    if (!this.data.shareId) {
      return;
    }
    await this.loadCard(this.data.shareId);
  },

  async handleTimelineTip() {
    await showModalPromise({
      title: '分享到朋友圈',
      content: '请点击右上角“...”菜单，再选择“分享到朋友圈”。保存后的资料卡图片也可以直接发朋友圈。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onShareAppMessage() {
    const card = this.data.card || {};
    const payload = {
      title: card.shareTitle || '学习成果卡',
      path: `/pages/trees/trees?shareId=${this.data.shareId}`,
    };
    if (card.coverImageUrl) {
      payload.imageUrl = card.coverImageUrl;
    }
    return payload;
  },

  onShareTimeline() {
    const card = this.data.card || {};
    const payload = {
      title: card.shareTitle || '学习成果卡',
      query: `id=${this.data.shareId}`,
    };
    if (card.coverImageUrl) {
      payload.imageUrl = card.coverImageUrl;
    }
    return payload;
  },

  async handleSavePoster() {
    const card = this.data.card;
    if (!card || this.data.saving) {
      return;
    }

    this.setData({ saving: true, errorText: '' });
    try {
      await this.drawPoster(card);
      const tempFilePath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'sharePosterCanvas',
          destWidth: POSTER_WIDTH,
          destHeight: POSTER_HEIGHT,
          width: POSTER_WIDTH,
          height: POSTER_HEIGHT,
          success: (resp) => resolve(resp.tempFilePath),
          fail: reject,
        }, this);
      });
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
        const confirmed = await showModalPromise({
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

  drawCalendarPanel(ctx, calendar, theme, top) {
    if (!calendar || !Array.isArray(calendar.cells) || !calendar.cells.some((cell) => !cell.placeholder)) {
      return top;
    }
    const panelX = 128;
    const panelY = top;
    const panelWidth = POSTER_WIDTH - 256;
    const paddingX = 38;
    const cells = (calendar.cells || []).slice(0, 42);
    const rowCount = Math.max(1, Math.ceil(cells.length / 7));
    const cellSize = 40;
    const cellGap = 10;
    const step = cellSize + cellGap;
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
    const summaryBottom = fillWrappedText(ctx, summaryText, panelX + paddingX, panelY + 74, panelWidth - paddingX * 2 - 180, 30, 2);
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

    drawRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 34, 'rgba(8, 18, 34, 0.94)', 'rgba(125, 171, 255, 0.16)');
    drawRoundedRect(ctx, panelX + 18, panelY + 18, panelWidth - 36, 88, 28, theme.accentSoft, 'rgba(125, 171, 255, 0.08)');
    drawRoundedRect(ctx, panelX + panelWidth - monthChipWidth - 28, panelY + 28, monthChipWidth, 42, 21, 'rgba(10, 24, 48, 0.86)', 'rgba(125, 171, 255, 0.24)');

    ctx.setFillStyle(theme.neon);
    ctx.setFontSize(24);
    ctx.fillText('月度热力图', panelX + paddingX, panelY + 44);
    ctx.setFillStyle('#dbe9ff');
    ctx.setFontSize(22);
    ctx.fillText(monthLabel, panelX + panelWidth - monthChipWidth - 2, panelY + 55);
    ctx.setFillStyle('rgba(226, 239, 255, 0.88)');
    ctx.setFontSize(24);
    fillWrappedText(ctx, summaryText, panelX + paddingX, panelY + 74, panelWidth - paddingX * 2 - 180, 30, 2);

    statItems.forEach((item, index) => {
      const x = panelX + paddingX + index * (statCardWidth + statGap);
      drawRoundedRect(ctx, x, statTop, statCardWidth, statCardHeight, 24, item.tone, 'rgba(125, 171, 255, 0.14)');
      ctx.setFillStyle('rgba(196, 216, 244, 0.72)');
      ctx.setFontSize(20);
      ctx.fillText(item.label, x + 18, statTop + 28);
      ctx.setFillStyle('#f4fbff');
      ctx.setFontSize(28);
      ctx.fillText(item.value, x + 18, statTop + 62);
    });

    drawRoundedRect(ctx, boardX, boardY, boardWidth, boardHeight, 30, 'rgba(10, 22, 40, 0.92)', 'rgba(125, 171, 255, 0.12)');

    ctx.save();
    ctx.setTextAlign('center');
    (calendar.weekdayLabels || []).forEach((weekday, index) => {
      ctx.setFillStyle('rgba(172, 197, 233, 0.66)');
      ctx.setFontSize(18);
      ctx.fillText(String(weekday || ''), startX + index * step + (cellSize / 2), weekdayY);
    });

    cells.forEach((cell, index) => {
      const col = index % 7;
      const row = Math.floor(index / 7);
      const x = startX + col * step;
      const y = gridStartY + row * step;
      if (cell.placeholder) {
        drawRoundedRect(ctx, x, y, cellSize, cellSize, 14, 'rgba(9, 18, 32, 0.24)', 'rgba(125, 171, 255, 0.03)');
        return;
      }
      const style = bandStyleMap[cell.band || 'none'] || bandStyleMap.none;
      drawRoundedRect(ctx, x, y, cellSize, cellSize, 14, style.fill, style.stroke);
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
      drawRoundedRect(ctx, item.x, item.y - 14, item.width, 30, 15, 'rgba(10, 23, 42, 0.9)', 'rgba(125, 171, 255, 0.12)');
      drawRoundedRect(ctx, item.x + 12, item.y - 5, 14, 14, 7, style.fill, style.stroke);
      ctx.setFillStyle('rgba(205, 223, 247, 0.84)');
      ctx.setFontSize(18);
      ctx.fillText(item.label, item.x + 36, item.y + 3);
    });

    return panelY + panelHeight + 34;
  },

  async drawPoster(card) {
    const ctx = wx.createCanvasContext('sharePosterCanvas', this);
    const themes = [
      { top: '#0b1e42', bottom: '#07111f', accentSoft: 'rgba(88, 166, 255, 0.18)', neon: '#7de6ff' },
      { top: '#072127', bottom: '#071319', accentSoft: 'rgba(31, 213, 185, 0.18)', neon: '#74ffe5' },
      { top: '#2a1310', bottom: '#120908', accentSoft: 'rgba(255, 138, 76, 0.18)', neon: '#ffd285' },
    ];
    const theme = themes[card.themeIndex] || themes[0];
    const coverImageInfo = card.coverImageUrl
      ? await getImageInfo(card.coverImageUrl).catch(() => null)
      : null;

    ctx.clearRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);
    const bg = ctx.createLinearGradient(0, 0, 0, POSTER_HEIGHT);
    bg.addColorStop(0, theme.top);
    bg.addColorStop(1, theme.bottom);
    ctx.setFillStyle(bg);
    ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);

    ctx.setStrokeStyle('rgba(157, 190, 255, 0.08)');
    ctx.setLineWidth(1);
    for (let x = 0; x <= POSTER_WIDTH; x += 54) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, POSTER_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= POSTER_HEIGHT; y += 54) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(POSTER_WIDTH, y);
      ctx.stroke();
    }

    drawRoundedRect(ctx, 64, 72, POSTER_WIDTH - 128, POSTER_HEIGHT - 144, 42, 'rgba(8, 18, 34, 0.88)', 'rgba(125, 171, 255, 0.18)');
    drawRoundedRect(ctx, 96, 106, POSTER_WIDTH - 192, 108, 28, theme.accentSoft, 'rgba(125, 171, 255, 0.14)');

    ctx.setFillStyle('#f7fbff');
    ctx.setFontSize(54);
    const titleBottom = fillWrappedText(ctx, card.nodeName, 128, 168, POSTER_WIDTH - 256, 68, 2);

    ctx.setFillStyle('rgba(215, 231, 255, 0.82)');
    ctx.setFontSize(28);
    const subtitleBottom = card.shareSubtitle
      ? fillWrappedText(ctx, card.shareSubtitle, 128, titleBottom + 12, POSTER_WIDTH - 320, 40, 2)
      : titleBottom;

    drawRoundedRect(ctx, POSTER_WIDTH - 278, 130, 150, 64, 32, 'rgba(10, 24, 48, 0.85)', 'rgba(125, 171, 255, 0.24)');
    ctx.setFillStyle('#d8e8ff');
    ctx.setFontSize(28);
    ctx.fillText(`Lv.${card.studentLevel}`, POSTER_WIDTH - 234, 172);

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
      drawRoundedRect(ctx, x, y, metricWidth, metricHeight, 28, 'rgba(12, 25, 49, 0.88)', 'rgba(125, 171, 255, 0.14)');
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
      if (tagX + width > POSTER_WIDTH - 128) {
        tagX = 128;
        tagY += 58;
      }
      drawRoundedRect(ctx, tagX, tagY, width, 44, 22, 'rgba(10, 24, 44, 0.82)', 'rgba(128, 173, 255, 0.2)');
      ctx.setFillStyle('#bcd8ff');
      ctx.fillText(tag, tagX + 20, tagY + 29);
      tagX += width + 14;
    });

    let contentTop = tagY + 84;
    if (card.isMonthSummary) {
      contentTop = this.drawCalendarPanel(ctx, card.summaryCalendar, theme, contentTop);
    }
    if (coverImageInfo && !card.isMonthSummary) {
      const coverX = 128;
      const coverY = contentTop;
      const coverWidth = POSTER_WIDTH - 256;
      const coverHeight = 210;
      drawRoundedRect(ctx, coverX, coverY, coverWidth, coverHeight, 30, 'rgba(7, 15, 29, 0.9)', 'rgba(125, 171, 255, 0.18)');
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
    drawRoundedRect(ctx, 128, codeBoxTop, POSTER_WIDTH - 256, codeBoxHeight, 32, 'rgba(7, 15, 29, 0.9)', 'rgba(125, 171, 255, 0.18)');
    ctx.setFillStyle(theme.neon);
    ctx.setFontSize(24);
    ctx.fillText(String(card.codeSectionTitle || '代码'), 160, codeBoxTop + 42);
    ctx.setFillStyle('rgba(194, 214, 248, 0.74)');
    ctx.setFontSize(22);
    ctx.fillText(`${card.codeLineCount} 行`, POSTER_WIDTH - 230, codeBoxTop + 42);
    ctx.setFillStyle('#edf6ff');
    ctx.setFontSize(24);
    fillWrappedText(ctx, card.codeSnippet, 160, codeBoxTop + 92, POSTER_WIDTH - 320, 34, codeMaxLines);

    let footerTop = codeBoxTop + codeBoxHeight + 40;
    if (card.insightText) {
      const insightHeight = card.isMonthSummary ? 148 : 180;
      drawRoundedRect(ctx, 128, footerTop, POSTER_WIDTH - 256, insightHeight, 28, 'rgba(10, 24, 38, 0.86)', 'rgba(88, 210, 190, 0.18)');
      ctx.setFillStyle(theme.neon);
      ctx.setFontSize(24);
      ctx.fillText(String(card.insightTitle || 'Insight').toUpperCase(), 160, footerTop + 38);
      ctx.setFillStyle('rgba(194, 214, 248, 0.72)');
      ctx.setFontSize(22);
      if (card.insightMeta) {
        ctx.fillText(card.insightMeta, POSTER_WIDTH - 270, footerTop + 38);
      }
      ctx.setFillStyle('rgba(226, 239, 255, 0.88)');
      ctx.setFontSize(24);
      fillWrappedText(ctx, card.insightText, 160, footerTop + 82, POSTER_WIDTH - 320, 34, card.isMonthSummary ? 3 : 4);
      footerTop += insightHeight + 26;
    }

    ctx.setFillStyle('rgba(194, 214, 248, 0.72)');
    ctx.setFontSize(24);
    ctx.fillText(`路径：${card.pathText || card.nodeName}`, 128, footerTop);
    ctx.fillText(card.footerLeftText, 128, footerTop + 40);
    ctx.fillText('保存后可直接发朋友圈', 128, footerTop + 86);
    ctx.fillText(card.footerRightText, POSTER_WIDTH - 290, footerTop + 40);

    return new Promise((resolve) => ctx.draw(false, resolve));
  },
});
