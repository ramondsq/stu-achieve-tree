const { request } = require('../../utils/request');
const { getStudent, setStudentProfile, clearSession } = require('../../utils/auth');

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '0';
  }
  const num = Number(value);
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
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

function buildEmptyRewardCenter() {
  return {
    student: {
      level: 0,
      total_points: 0,
    },
    learning_progress: {
      current_score: 0,
      total_score: 0,
      progress_percent: 0,
    },
    weekly_bounty: {
      week_label: '',
      qualified_count: 0,
      target_count: 2,
      progress_percent: 0,
      reward_points: 1,
      claimable: false,
      claimed: false,
      summary_text: '当前还没有配置每周悬赏树任务。',
      status_text: '未配置',
    },
    weekly_streak: {
      current_days: 0,
      target_days: 7,
      progress_percent: 0,
      reward_points: 2,
      claimable_count: 0,
      period_label: '本周',
      summary_text: '连续 7 天每天提交 4 分及以上题目即可领取积分',
      status_text: '未达成',
    },
    monthly_streak: {
      current_days: 0,
      target_days: 30,
      progress_percent: 0,
      reward_points: 10,
      claimable_count: 0,
      period_label: '本月',
      summary_text: '连续 30 天每天提交 4 分及以上题目即可领取积分',
      status_text: '未达成',
    },
    level_rewards: {
      current_level: 0,
      next_level: 1,
      claimable_count: 0,
      total_claimable_points: 0,
      items: [],
    },
    pet_summary: {
      title: '星尘伙伴',
      visual_title: '开心',
      visual_state: 'happy',
      hunger: 0,
      health: 0,
      mood: 0,
      illness_active: false,
      status_text: '状态稳定',
      summary_text: '先进入宠物页查看状态。',
      affordable_count: 0,
      inventory_count: 0,
    },
    claimable_reward_count: 0,
    claimable_total_points: 0,
  };
}

function normalizeRewardCenter(raw = {}) {
  const fallback = buildEmptyRewardCenter();
  const levelRewards = raw.level_rewards || {};
  return {
    ...fallback,
    ...raw,
    student: {
      ...fallback.student,
      ...(raw.student || {}),
    },
    learning_progress: {
      ...fallback.learning_progress,
      ...(raw.learning_progress || {}),
    },
    weekly_bounty: {
      ...fallback.weekly_bounty,
      ...(raw.weekly_bounty || {}),
    },
    weekly_streak: {
      ...fallback.weekly_streak,
      ...(raw.weekly_streak || {}),
    },
    monthly_streak: {
      ...fallback.monthly_streak,
      ...(raw.monthly_streak || {}),
    },
    level_rewards: {
      ...fallback.level_rewards,
      ...levelRewards,
      items: Array.isArray(levelRewards.items) ? levelRewards.items : [],
    },
    pet_summary: {
      ...fallback.pet_summary,
      ...(raw.pet_summary || {}),
    },
  };
}

Page({
  data: {
    loading: false,
    errorText: '',
    studentName: '',
    rewardCenter: buildEmptyRewardCenter(),
    claimWorking: false,
    claimWorkingKey: '',
    claimOverlayVisible: false,
    claimOverlayTitle: '',
    claimOverlayCopy: '',
    claimOverlayPointsText: '',
    claimOverlayParticles: [0, 1, 2, 3, 4, 5],
  },

  overlayTimer: null,

  onLoad() {
    this.bootstrap();
  },

  onShow() {
    const app = getApp();
    if (app && app.globalData && app.globalData.rewardCenterDirty) {
      app.globalData.rewardCenterDirty = false;
      this.loadRewardCenter();
    }
  },

  onUnload() {
    if (this.overlayTimer) {
      clearTimeout(this.overlayTimer);
      this.overlayTimer = null;
    }
  },

  async bootstrap() {
    const localStudent = getStudent();
    if (!localStudent) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    await this.loadRewardCenter();
  },

  async loadRewardCenter() {
    this.setData({ loading: true, errorText: '' });
    try {
      const payload = normalizeRewardCenter(await request('/api/student/reward-center'));
      setStudentProfile(payload.student);
      this.setData({
        loading: false,
        rewardCenter: payload,
        studentName: formatStudentName(payload.student),
      });
    } catch (err) {
      const message = err.message || '积分中心加载失败';
      if (/登录|失效|未找到学生登录态/.test(message)) {
        clearSession();
        wx.redirectTo({ url: '/pages/login/login' });
        return;
      }
      this.setData({ loading: false, errorText: message });
    }
  },

  async handleRefresh() {
    await this.loadRewardCenter();
    if (!this.data.errorText) {
      wx.showToast({ title: '已刷新', icon: 'success' });
    }
  },

  handleBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: '/pages/trees/trees' });
  },

  handleOpenPetPage() {
    wx.navigateTo({ url: '/pages/pet/pet' });
  },

  showClaimOverlay(result = {}) {
    if (this.overlayTimer) {
      clearTimeout(this.overlayTimer);
      this.overlayTimer = null;
    }
    this.setData({
      claimOverlayVisible: true,
      claimOverlayTitle: result.title || '积分已领取',
      claimOverlayCopy: result.copy || '积分已经入账。',
      claimOverlayPointsText: result.points_text || '+0',
    });
    if (typeof wx.vibrateShort === 'function') {
      try {
        wx.vibrateShort({ type: 'medium' });
      } catch (_err) {
      }
    }
    this.overlayTimer = setTimeout(() => {
      this.setData({ claimOverlayVisible: false });
      this.overlayTimer = null;
    }, 2200);
  },

  handleCloseClaimOverlay() {
    if (this.overlayTimer) {
      clearTimeout(this.overlayTimer);
      this.overlayTimer = null;
    }
    this.setData({ claimOverlayVisible: false });
  },

  async handleClaimReward(e) {
    if (this.data.claimWorking) {
      return;
    }
    const claimType = String(e.currentTarget.dataset.claimType || '').trim();
    const claimKey = String(e.currentTarget.dataset.claimKey || claimType || '').trim();
    const level = Number(e.currentTarget.dataset.level || 0);
    this.setData({ claimWorking: true, claimWorkingKey: claimKey, errorText: '' });
    try {
      const payload = await request('/api/student/reward-center/claim', {
        method: 'POST',
        data: {
          claimType,
          level,
        },
      });
      const rewardCenter = normalizeRewardCenter(payload.reward_center || {});
      if (payload.student) {
        setStudentProfile(payload.student);
      }
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.rewardCenterDirty = true;
      }
      this.setData({
        claimWorking: false,
        claimWorkingKey: '',
        rewardCenter,
        studentName: formatStudentName(payload.student || rewardCenter.student),
      });
      this.showClaimOverlay(payload.claim_result || {});
    } catch (err) {
      const message = err.message || '领取积分失败';
      this.setData({
        claimWorking: false,
        claimWorkingKey: '',
        errorText: message,
      });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
});
