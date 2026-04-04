const { request } = require('../../utils/request');
const { getStudent, setStudentProfile, clearSession } = require('../../utils/auth');

function buildEmptyPetCenter() {
  return {
    student: {
      level: 0,
      total_points: 0,
      username: '',
      name: '',
    },
    pet: {
      name: '',
      species: '',
      species_key: '',
      species_selected: false,
      species_locked: false,
      species_selected_at: '',
      hunger: 0,
      health: 0,
      mood: 0,
      animated_assets: {
        hungry: '',
        gloomy: '',
        happy: '',
        super_happy: '',
      },
      frame_sequences: {
        hungry: [],
        gloomy: [],
        happy: [],
        super_happy: [],
      },
      active_animation_url: '',
      active_frames: [],
      active_frame_count: 0,
      current_frame_url: '',
      visual_state: 'happy',
      visual_title: '开心',
      visual_description: '',
      visual_score: 0,
      visual_options: [],
      animation_fps: 8,
      placeholder_text: '宠物状态动图资源预留中。',
      illness: {
        active: false,
        status_text: '状态稳定',
        week_label: '',
      },
      elapsed_days: 0,
      overfed_count: 0,
    },
    shop: {
      affordable_count: 0,
      items: [],
    },
    bag: {
      total_count: 0,
      items: [],
    },
    pet_selection: {
      can_select: true,
      locked: false,
      selected_species_key: '',
      selected_species_title: '',
      species_list: [],
    },
    rules: {
      daily_hunger_decay_percent: 10,
      weekly_illness_probability_percent: 50,
      mood_decay_factor_percent: 50,
      overfed_threshold: 90,
      overfed_health_penalty: 10,
      illness_health_decay_per_day: 8,
    },
  };
}

function normalizePetCenter(raw = {}) {
  const fallback = buildEmptyPetCenter();
  return {
    ...fallback,
    ...raw,
    student: {
      ...fallback.student,
      ...(raw.student || {}),
    },
    pet: {
      ...fallback.pet,
      ...(raw.pet || {}),
      animated_assets: {
        ...fallback.pet.animated_assets,
        ...((raw.pet && raw.pet.animated_assets) || {}),
      },
      frame_sequences: {
        ...fallback.pet.frame_sequences,
        ...((raw.pet && raw.pet.frame_sequences) || {}),
      },
      illness: {
        ...fallback.pet.illness,
        ...((raw.pet && raw.pet.illness) || {}),
      },
      active_animation_url: String(raw.pet && raw.pet.active_animation_url || '').trim(),
      active_frames: Array.isArray(raw.pet && raw.pet.active_frames) ? raw.pet.active_frames.filter(Boolean) : [],
      active_frame_count: Number(raw.pet && raw.pet.active_frame_count) || 0,
      current_frame_url: String(raw.pet && raw.pet.current_frame_url || '').trim(),
      visual_options: Array.isArray(raw.pet && raw.pet.visual_options) ? raw.pet.visual_options : [],
    },
    pet_selection: {
      ...fallback.pet_selection,
      ...(raw.pet_selection || {}),
      species_list: Array.isArray(raw.pet_selection && raw.pet_selection.species_list)
        ? raw.pet_selection.species_list.map((item) => ({
          key: String(item.key || '').trim(),
          title: String(item.title || '').trim(),
          default_pet_name: String(item.default_pet_name || '').trim(),
          description: String(item.description || '').trim(),
          preview_frames: Array.isArray(item.preview_frames) ? item.preview_frames.filter(Boolean) : [],
          preview_cover_url: String(item.preview_cover_url || pickPreviewFrameUrl(item)).trim(),
          preview_frame_count: Number(item.preview_frame_count) || 0,
          has_preview_frames: !!item.has_preview_frames,
          frame_sequences: item.frame_sequences || {},
        })).filter((item) => item.key)
        : [],
    },
    shop: {
      ...fallback.shop,
      ...(raw.shop || {}),
      items: Array.isArray(raw.shop && raw.shop.items) ? raw.shop.items : [],
    },
    bag: {
      ...fallback.bag,
      ...(raw.bag || {}),
      items: Array.isArray(raw.bag && raw.bag.items) ? raw.bag.items : [],
    },
    rules: {
      ...fallback.rules,
      ...(raw.rules || {}),
    },
  };
}

function pickCurrentFrameUrl(activeFrames = [], index = 0) {
  if (!Array.isArray(activeFrames) || !activeFrames.length) {
    return '';
  }
  const safeIndex = Math.max(0, index % activeFrames.length);
  return String(activeFrames[safeIndex] || '').trim();
}

function pickPreviewFrameUrl(species) {
  const directUrl = String(species && species.preview_cover_url || '').trim();
  if (directUrl) {
    return directUrl;
  }
  const animatedHappy = String(species && species.animated_assets && species.animated_assets.happy || '').trim();
  if (animatedHappy) {
    return animatedHappy;
  }
  const previewFrames = Array.isArray(species && species.preview_frames)
    ? species.preview_frames.filter(Boolean)
    : [];
  if (previewFrames.length) {
    return String(previewFrames[0] || '').trim();
  }
  return '';
}

function formatStudentLabel(student) {
  if (!student) {
    return '';
  }
  const namePart = student.name ? `${student.username}（${student.name}）` : (student.username || '');
  return `${namePart} · Lv.${student.level || 0} · 积分 ${student.total_points || 0}`;
}

Page({
  frameTimer: null,
  frameIndex: 0,

  data: {
    loading: false,
    actionLoadingKey: '',
    errorText: '',
    studentLabel: '',
    petCenter: buildEmptyPetCenter(),
  },

  onLoad() {
    this.bootstrap();
  },

  onUnload() {
    this.stopFrameAnimation();
  },

  onHide() {
    this.stopFrameAnimation();
  },

  onShow() {
    this.startFrameAnimation();
  },

  async bootstrap() {
    const localStudent = getStudent();
    if (!localStudent) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    await this.loadPetCenter();
  },

  stopFrameAnimation() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  },

  startFrameAnimation() {
    this.stopFrameAnimation();
    const pet = this.data.petCenter && this.data.petCenter.pet ? this.data.petCenter.pet : null;
    const activeAnimationUrl = String(pet && pet.active_animation_url || '').trim();
    if (activeAnimationUrl) {
      return;
    }
    const activeFrames = pet ? pet.active_frames : [];
    if (!Array.isArray(activeFrames) || activeFrames.length <= 1) {
      return;
    }
    const fps = Number(this.data.petCenter.pet.animation_fps || 8);
    const delay = Math.max(80, Math.round(1000 / fps));
    this.frameTimer = setInterval(() => {
      const frames = this.data.petCenter && this.data.petCenter.pet
        ? this.data.petCenter.pet.active_frames
        : [];
      if (!Array.isArray(frames) || !frames.length) {
        this.stopFrameAnimation();
        return;
      }
      this.frameIndex = (this.frameIndex + 1) % frames.length;
      this.setData({
        'petCenter.pet.current_frame_url': pickCurrentFrameUrl(frames, this.frameIndex),
      });
    }, delay);
  },

  applyPetAnimationState(petCenter) {
    const activeFrames = petCenter && petCenter.pet && Array.isArray(petCenter.pet.active_frames)
      ? petCenter.pet.active_frames.filter(Boolean)
      : [];
    const activeAnimationUrl = String(petCenter && petCenter.pet && petCenter.pet.active_animation_url || '').trim();
    this.frameIndex = 0;
    return {
      ...petCenter,
      pet: {
        ...petCenter.pet,
        active_animation_url: activeAnimationUrl,
        active_frames: activeFrames,
        active_frame_count: activeFrames.length,
        current_frame_url: activeAnimationUrl ? '' : pickCurrentFrameUrl(activeFrames, 0),
      },
    };
  },

  async loadPetCenter() {
    this.setData({ loading: true, errorText: '' });
    try {
      const payload = await request('/api/student/pet');
      const petCenter = this.applyPetAnimationState(normalizePetCenter(payload.pet_center || {}));
      if (payload.student) {
        setStudentProfile(payload.student);
      }
      this.setData({
        loading: false,
        petCenter,
        studentLabel: formatStudentLabel(payload.student || petCenter.student),
      });
      this.startFrameAnimation();
    } catch (err) {
      const message = err.message || '宠物中心加载失败';
      if (/登录|失效|未找到学生登录态/.test(message)) {
        clearSession();
        wx.redirectTo({ url: '/pages/login/login' });
        return;
      }
      this.setData({ loading: false, errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },

  handleBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: '/pages/rewards/rewards' });
  },

  async handleRefresh() {
    await this.loadPetCenter();
    if (!this.data.errorText) {
      wx.showToast({ title: '已刷新', icon: 'success' });
    }
  },

  async handlePurchase(e) {
    if (!this.data.petCenter.pet.species_selected) {
      wx.showToast({ title: '请先选择宠物', icon: 'none' });
      return;
    }
    const itemKey = String(e.currentTarget.dataset.itemKey || '').trim();
    if (!itemKey || this.data.actionLoadingKey) {
      return;
    }
    this.setData({ actionLoadingKey: `buy:${itemKey}`, errorText: '' });
    try {
      const payload = await request('/api/student/pet/purchase', {
        method: 'POST',
        data: { itemKey, quantity: 1 },
      });
      const petCenter = this.applyPetAnimationState(normalizePetCenter(payload.pet_center || {}));
      if (payload.student) {
        setStudentProfile(payload.student);
      }
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.rewardCenterDirty = true;
      }
      this.setData({
        actionLoadingKey: '',
        petCenter,
        studentLabel: formatStudentLabel(payload.student || petCenter.student),
      });
      this.startFrameAnimation();
      wx.showToast({ title: payload.purchase_result && payload.purchase_result.copy ? payload.purchase_result.copy : '购买成功', icon: 'none' });
    } catch (err) {
      const message = err.message || '购买失败';
      this.setData({ actionLoadingKey: '', errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },

  async handleUse(e) {
    if (!this.data.petCenter.pet.species_selected) {
      wx.showToast({ title: '请先选择宠物', icon: 'none' });
      return;
    }
    const itemKey = String(e.currentTarget.dataset.itemKey || '').trim();
    if (!itemKey || this.data.actionLoadingKey) {
      return;
    }
    this.setData({ actionLoadingKey: `use:${itemKey}`, errorText: '' });
    try {
      const payload = await request('/api/student/pet/use', {
        method: 'POST',
        data: { itemKey },
      });
      const petCenter = this.applyPetAnimationState(normalizePetCenter(payload.pet_center || {}));
      if (payload.student) {
        setStudentProfile(payload.student);
      }
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.rewardCenterDirty = true;
      }
      this.setData({
        actionLoadingKey: '',
        petCenter,
        studentLabel: formatStudentLabel(payload.student || petCenter.student),
      });
      this.startFrameAnimation();
      wx.showToast({ title: payload.use_result && payload.use_result.copy ? payload.use_result.copy : '使用成功', icon: 'none' });
    } catch (err) {
      const message = err.message || '使用失败';
      this.setData({ actionLoadingKey: '', errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },

  async handleSelectSpecies(e) {
    const speciesKey = String(e.currentTarget.dataset.speciesKey || '').trim();
    if (!speciesKey || this.data.actionLoadingKey) {
      return;
    }
    if (this.data.petCenter.pet.species_locked && this.data.petCenter.pet.species_selected) {
      wx.showToast({ title: '宠物已经选定，不能再次更改', icon: 'none' });
      return;
    }
    this.setData({ actionLoadingKey: `select:${speciesKey}`, errorText: '' });
    try {
      const payload = await request('/api/student/pet/select-species', {
        method: 'POST',
        data: { speciesKey },
      });
      const petCenter = this.applyPetAnimationState(normalizePetCenter(payload.pet_center || {}));
      if (payload.student) {
        setStudentProfile(payload.student);
      }
      this.setData({
        actionLoadingKey: '',
        petCenter,
        studentLabel: formatStudentLabel(payload.student || petCenter.student),
      });
      this.startFrameAnimation();
      wx.showToast({
        title: payload.select_result && payload.select_result.copy ? payload.select_result.copy : '选宠成功',
        icon: 'none',
      });
    } catch (err) {
      const message = err.message || '选宠失败';
      this.setData({ actionLoadingKey: '', errorText: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
});
