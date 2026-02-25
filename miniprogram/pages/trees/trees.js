const { request } = require('../../utils/request');
const { getStudent, clearSession } = require('../../utils/auth');

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

function getApiBaseUrl() {
  const app = getApp();
  const raw = (app && app.globalData && app.globalData.apiBaseUrl) || '';
  return raw.replace(/\/$/, '');
}

function toAbsoluteImageUrl(imageUrl) {
  if (!imageUrl) {
    return '';
  }
  if (/^https?:\/\//.test(imageUrl)) {
    return imageUrl;
  }
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${imageUrl}` : imageUrl;
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

function decorateSubmission(item) {
  const teacherScoreValue = item.teacher_score === null || item.teacher_score === undefined
    ? null
    : Number(item.teacher_score);
  return {
    id: item.id,
    codeText: item.code_text || '',
    codeImageUrl: item.code_image_url || '',
    imagePreviewUrl: toAbsoluteImageUrl(item.code_image_url || ''),
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

function decorateTree(tree) {
  const list = [];

  function walk(node, depth, path) {
    if (!node) return;

    const currentPath = path ? `${path} / ${node.name}` : node.name;
    const isKnowledge = depth > 0;
    const codeText = node.codeText || '';
    const codeImageUrl = node.codeImageUrl || '';
    const submissionHistory = Array.isArray(node.submissionHistory)
      ? node.submissionHistory.map((item) => decorateSubmission(item))
      : [];
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
    const scoreValue = node.score === null || node.score === undefined
      ? null
      : Number(node.score);

    list.push({
      id: node.id,
      depth,
      name: node.name,
      indent: '　'.repeat(depth),
      path: currentPath,
      isKnowledge,
      scoreValue,
      scoreText: scoreValue === null || Number.isNaN(scoreValue) ? '' : formatNumber(scoreValue),
      scoreClass: scoreValue === null || Number.isNaN(scoreValue) ? '' : getScoreClass(scoreValue),
      comment: node.comment || '',
      codeText,
      codeDraft: '',
      codeImageUrl,
      latestImagePreviewUrl: toAbsoluteImageUrl(codeImageUrl),
      draftImageBase64: '',
      draftImageMimeType: '',
      draftImagePreviewUrl: '',
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
      editorExpanded: false,
      working: false,
    });

    (node.children || []).forEach((child) => walk(child, depth + 1, currentPath));
  }

  walk(tree.root, 0, '');

  const knowledgeNodes = list.filter((item) => item.isKnowledge);
  const scoredNodes = knowledgeNodes.filter(
    (item) => item.scoreValue !== null && !Number.isNaN(item.scoreValue),
  );
  const totalScoreValue = scoredNodes.reduce((sum, item) => sum + item.scoreValue, 0);
  const averageScoreValue = scoredNodes.length ? totalScoreValue / scoredNodes.length : null;

  return {
    ...tree,
    treeExpanded: false,
    flatNodes: list,
    stats: {
      total: knowledgeNodes.length,
      scored: scoredNodes.length,
      totalScoreValue,
      totalScoreText: scoredNodes.length ? formatNumber(totalScoreValue) : '-',
      totalScoreClass: scoredNodes.length ? getScoreClass(totalScoreValue) : '',
      averageScoreValue,
      averageScoreText: averageScoreValue === null ? '-' : formatNumber(averageScoreValue),
      averageScoreClass: averageScoreValue === null ? '' : getScoreClass(averageScoreValue),
    },
  };
}

Page({
  data: {
    loading: false,
    errorText: '',
    studentName: '',
    trees: [],
  },

  onShow() {
    this.bootstrap();
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

  setNodeData(treeIndex, nodeIndex, patch) {
    if (!Number.isInteger(treeIndex) || !Number.isInteger(nodeIndex)) {
      return;
    }

    const updates = {};
    Object.keys(patch).forEach((key) => {
      updates[`trees[${treeIndex}].flatNodes[${nodeIndex}].${key}`] = patch[key];
    });
    this.setData(updates);
  },

  getNodeFromDataset(dataset = {}) {
    const treeIndex = Number(dataset.treeIndex);
    const nodeIndex = Number(dataset.nodeIndex);

    if (!Number.isInteger(treeIndex) || !Number.isInteger(nodeIndex)) {
      return null;
    }

    const tree = this.data.trees[treeIndex];
    if (!tree) {
      return null;
    }

    const node = tree.flatNodes[nodeIndex];
    if (!node || !node.isKnowledge) {
      return null;
    }

    return { treeIndex, nodeIndex, node };
  },

  async bootstrap() {
    const localStudent = getStudent();
    if (!localStudent) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }

    this.setData({
      studentName: localStudent.name
        ? `${localStudent.username} (${localStudent.name})`
        : localStudent.username,
    });

    this.setData({ loading: true, errorText: '' });

    try {
      await request('/api/student/me');
      await this.loadTrees();
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

  async loadTrees() {
    const trees = await request('/api/student/trees');
    this.setData({
      trees: trees.map((tree) => decorateTree(tree)),
    });
  },

  async handleRefresh() {
    this.setData({ loading: true, errorText: '' });
    try {
      await this.loadTrees();
      wx.showToast({ title: '已刷新', icon: 'success' });
    } catch (err) {
      this.setData({ errorText: err.message || '刷新失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleLogout() {
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
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeIndex, {
      codeDraft: e.detail.value || '',
    });
  },

  handleToggleWorkPanel(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeIndex, {
      editorExpanded: !located.node.editorExpanded,
    });
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
  },

  async submitNodeSubmission(located) {
    if (!located || located.node.working) {
      return;
    }

    const codeText = (located.node.codeDraft || '').trim();
    const hasDraftImage = !!located.node.draftImageBase64;
    if (!codeText && !hasDraftImage) {
      this.setData({ errorText: '请先输入代码文本或选择代码图片再提交' });
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeIndex, { working: true });
    this.setData({ errorText: '' });

    try {
      const payload = await request('/api/student/node-submissions', {
        method: 'POST',
        data: {
          nodeId: located.node.id,
          codeText,
          imageBase64: located.node.draftImageBase64 || undefined,
          imageMimeType: located.node.draftImageMimeType || undefined,
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

      this.setNodeData(located.treeIndex, located.nodeIndex, {
        codeText: payload.code_text || '',
        codeImageUrl: payload.code_image_url || '',
        latestImagePreviewUrl: toAbsoluteImageUrl(payload.code_image_url || ''),
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
        draftImageBase64: '',
        draftImageMimeType: '',
        draftImagePreviewUrl: '',
        working: false,
      });

      wx.showToast({ title: '提交成功', icon: 'success' });
    } catch (err) {
      this.setNodeData(located.treeIndex, located.nodeIndex, { working: false });
      this.setData({ errorText: err.message || '提交失败' });
    }
  },

  async handleSubmitSubmission(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }
    await this.submitNodeSubmission(located);
  },

  async handlePickImage(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }

    try {
      const chosen = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject,
        });
      });

      const first = chosen.tempFiles && chosen.tempFiles[0];
      const filePath = first && first.tempFilePath;
      if (!filePath) {
        throw new Error('未选择到图片');
      }

      const imageBase64 = await readFileAsBase64(filePath);
      const imageMimeType = inferImageMimeType(filePath);

      this.setNodeData(located.treeIndex, located.nodeIndex, {
        draftImageBase64: imageBase64,
        draftImageMimeType: imageMimeType,
        draftImagePreviewUrl: filePath,
      });
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (msg.includes('cancel')) {
        return;
      }
      this.setData({ errorText: msg || '上传图片失败' });
    }
  },

  handleRemoveDraftImage(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeIndex, {
      draftImageBase64: '',
      draftImageMimeType: '',
      draftImagePreviewUrl: '',
    });
  },

  handleClearDraft(e) {
    const located = this.getNodeFromDataset(e.currentTarget.dataset);
    if (!located) {
      return;
    }

    this.setNodeData(located.treeIndex, located.nodeIndex, {
      codeDraft: '',
      draftImageBase64: '',
      draftImageMimeType: '',
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
