const crypto = require('crypto');
const rawPetSpeciesCatalog = require('./pet-species-catalog');

const DAY_MS = 24 * 60 * 60 * 1000;
const REWARD_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const PET_MAX_STAT = 100;
const PET_MIN_STAT = 0;
const PET_HUNGER_DECAY_PER_DAY = 10;
const PET_ILLNESS_HEALTH_DECAY_PER_DAY = 8;
const PET_MOOD_DECAY_FACTOR = 0.5;
const PET_LOW_HUNGER_WARNING = 48;
const PET_LOW_HEALTH_WARNING = 55;
const PET_LOW_MOOD_WARNING = 46;
const PET_HAPPY_MIN_STAT = 60;
const PET_SUPER_HAPPY_MIN_STAT = 88;
const PET_OVERFED_THRESHOLD = 90;
const PET_OVERFED_HEALTH_PENALTY = 10;
const PET_WEEKLY_ILLNESS_PROBABILITY = 0.5;
const PET_CURED_WEEK_MEMORY = 8;

const PET_VISUAL_STATES = [
  { key: 'hungry', title: '饥寒交迫' },
  { key: 'gloomy', title: '郁闷' },
  { key: 'happy', title: '开心' },
  { key: 'super_happy', title: '超级开心' },
];

const PET_ITEM_DEFINITIONS = [
  {
    key: 'food_basic',
    title: '营养食粮',
    category: 'food',
    cost: 12,
    description: '补充饱食度，少量提升心情。吃得太撑会掉健康值。',
    effects: {
      hunger: 24,
      health: 0,
      mood: 4,
    },
  },
  {
    key: 'medicine_basic',
    title: '基础药剂',
    category: 'medicine',
    cost: 18,
    description: '恢复健康值，并在本周生病时完成一次治愈。',
    effects: {
      hunger: 0,
      health: 24,
      mood: 6,
      cureIllness: true,
    },
  },
  {
    key: 'toy_basic',
    title: '星球玩具',
    category: 'toy',
    cost: 16,
    description: '显著提升心情，玩耍会消耗少量饱食度。',
    effects: {
      hunger: -6,
      health: 0,
      mood: 18,
    },
  },
];

const PET_ITEM_MAP = new Map(PET_ITEM_DEFINITIONS.map((item) => [item.key, item]));

function toIsoString(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRewardLocalDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + (REWARD_TIMEZONE_OFFSET_MINUTES * 60 * 1000));
}

function formatRewardDateKey(value = new Date()) {
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

function getRewardDayOrdinal(key) {
  const date = parseRewardDateKey(key);
  if (!date) {
    return null;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function toPositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return 0;
  }
  return num;
}

function clampPetStat(value) {
  return Math.max(PET_MIN_STAT, Math.min(PET_MAX_STAT, Math.round(Number(value) || 0)));
}

function getStudentTotalPoints(student) {
  return Math.max(0, Number(student && student.total_points) || 0);
}

function getStudentLevel(student) {
  const num = Number(student && student.level);
  return Number.isInteger(num) && num > 0 ? num : 0;
}

function getStudentLabel(student) {
  return {
    level: getStudentLevel(student),
    total_points: getStudentTotalPoints(student),
    username: String(student && student.username || '').trim(),
    name: String(student && student.name || '').trim(),
  };
}

function buildDefaultInventory() {
  return PET_ITEM_DEFINITIONS.reduce((result, item) => {
    result[item.key] = 0;
    return result;
  }, {});
}

function buildEmptyFrameSequenceMap() {
  return {
    hungry: [],
    gloomy: [],
    happy: [],
    super_happy: [],
  };
}

function buildEmptyAnimatedAssetMap() {
  return {
    hungry: '',
    gloomy: '',
    happy: '',
    super_happy: '',
  };
}

function normalizeFrameSequenceMap(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = buildEmptyFrameSequenceMap();
  PET_VISUAL_STATES.forEach((item) => {
    result[item.key] = Array.isArray(source[item.key])
      ? source[item.key].map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
  });
  return result;
}

function normalizeAnimatedAssetMap(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = buildEmptyAnimatedAssetMap();
  PET_VISUAL_STATES.forEach((item) => {
    result[item.key] = String(source[item.key] || '').trim();
  });
  return result;
}

function normalizePetSpeciesCatalog(rawCatalog = []) {
  return (Array.isArray(rawCatalog) ? rawCatalog : [])
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const key = String(item.key || '').trim().toLowerCase();
      const title = String(item.title || '').trim();
      if (!key || !title) {
        return null;
      }
      return {
        key,
        title,
        default_pet_name: String(item.default_pet_name || '').trim() || title,
        description: String(item.description || '').trim(),
        animated_assets: normalizeAnimatedAssetMap(item.animated_assets),
        frame_sequences: normalizeFrameSequenceMap(item.frame_sequences),
      };
    })
    .filter(Boolean);
}

function normalizeFrameSequenceMapWithLegacy(raw, legacyAssets) {
  const normalized = normalizeFrameSequenceMap(raw);
  const legacy = legacyAssets && typeof legacyAssets === 'object' ? legacyAssets : {};
  PET_VISUAL_STATES.forEach((item) => {
    if (normalized[item.key].length) {
      return;
    }
    const legacyValue = String(legacy[item.key] || '').trim();
    if (legacyValue) {
      normalized[item.key] = [legacyValue];
    }
  });
  return normalized;
}

function cloneFrameSequenceMap(raw) {
  const normalized = normalizeFrameSequenceMap(raw);
  const result = buildEmptyFrameSequenceMap();
  PET_VISUAL_STATES.forEach((item) => {
    result[item.key] = normalized[item.key].slice();
  });
  return result;
}

const PET_SPECIES_CATALOG = normalizePetSpeciesCatalog(rawPetSpeciesCatalog);
const PET_SPECIES_MAP = new Map(PET_SPECIES_CATALOG.map((item) => [item.key, item]));

function normalizePetSpeciesKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getPetSpeciesDefinition(speciesKey) {
  return PET_SPECIES_MAP.get(normalizePetSpeciesKey(speciesKey)) || null;
}

function buildPetSpeciesCatalog() {
  return PET_SPECIES_CATALOG.map((item) => {
    const frameSequences = cloneFrameSequenceMap(item.frame_sequences);
    const previewFrames = frameSequences.happy.slice();
    const animatedAssets = normalizeAnimatedAssetMap(item.animated_assets);
    return {
      key: item.key,
      title: item.title,
      default_pet_name: item.default_pet_name,
      description: item.description,
      animated_assets: animatedAssets,
      frame_sequences: frameSequences,
      preview_frames: previewFrames,
      preview_cover_url: String(animatedAssets.happy || '').trim(),
      preview_frame_count: previewFrames.length,
      has_preview_frames: previewFrames.length > 0 || Boolean(animatedAssets.happy),
    };
  });
}

function buildInitialPetProfile(now = new Date()) {
  const nowIso = toIsoString(now);
  return {
    version: 1,
    pet_name: '',
    pet_species: '',
    pet_species_key: '',
    pet_species_selected_at: '',
    pet_species_locked: false,
    hunger: 78,
    health: 84,
    mood: 80,
    inventory: buildDefaultInventory(),
    last_decay_at: nowIso,
    last_interacted_at: nowIso,
    cured_illness_week_keys: [],
    animated_assets: buildEmptyAnimatedAssetMap(),
    frame_sequences: buildEmptyFrameSequenceMap(),
    overfed_count: 0,
  };
}

function normalizeWeekKeys(keys = []) {
  return [...new Set(
    (Array.isArray(keys) ? keys : [])
      .map((item) => String(item || '').trim())
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)),
  )]
    .sort((left, right) => left.localeCompare(right))
    .slice(-PET_CURED_WEEK_MEMORY);
}

function normalizePetProfile(rawProfile, now = new Date()) {
  const defaults = buildInitialPetProfile(now);
  const raw = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
  const inventory = buildDefaultInventory();
  const rawInventory = raw.inventory && typeof raw.inventory === 'object' ? raw.inventory : {};
  PET_ITEM_DEFINITIONS.forEach((item) => {
    inventory[item.key] = Math.max(0, toPositiveInt(rawInventory[item.key]));
  });

  return {
    ...defaults,
    ...raw,
    pet_name: String(raw.pet_name || defaults.pet_name).trim(),
    pet_species: String(raw.pet_species || defaults.pet_species).trim(),
    pet_species_key: normalizePetSpeciesKey(raw.pet_species_key || raw.petSpeciesKey || defaults.pet_species_key),
    pet_species_selected_at: raw.pet_species_selected_at ? toIsoString(raw.pet_species_selected_at) : '',
    pet_species_locked: !!raw.pet_species_locked,
    hunger: clampPetStat(raw.hunger !== undefined ? raw.hunger : defaults.hunger),
    health: clampPetStat(raw.health !== undefined ? raw.health : defaults.health),
    mood: clampPetStat(raw.mood !== undefined ? raw.mood : defaults.mood),
    inventory,
    cured_illness_week_keys: normalizeWeekKeys(raw.cured_illness_week_keys),
    animated_assets: normalizeAnimatedAssetMap(raw.animated_assets),
    frame_sequences: normalizeFrameSequenceMapWithLegacy(raw.frame_sequences, raw.image_assets),
    last_decay_at: raw.last_decay_at ? toIsoString(raw.last_decay_at) : defaults.last_decay_at,
    last_interacted_at: raw.last_interacted_at ? toIsoString(raw.last_interacted_at) : defaults.last_interacted_at,
    overfed_count: Math.max(0, toPositiveInt(raw.overfed_count)),
  };
}

function calculatePetCareScore(profile, illnessState) {
  const score = Math.round(
    (profile.hunger * 0.36)
    + (profile.health * 0.36)
    + (profile.mood * 0.28)
    - (illnessState.active ? 10 : 0),
  );
  return clampPetStat(score);
}

function getPetVisualState(profile, illnessState) {
  const careScore = calculatePetCareScore(profile, illnessState);
  if (
    profile.hunger <= 26
    || profile.health <= 24
    || (profile.hunger <= 34 && profile.health <= 34)
    || careScore <= 34
  ) {
    return {
      key: 'hungry',
      title: '饥寒交迫',
      description: '饱食度或健康值过低，需要优先补给和恢复。',
      score: careScore,
    };
  }
  if (
    illnessState.active
    || profile.mood <= PET_LOW_MOOD_WARNING
    || profile.hunger <= PET_LOW_HUNGER_WARNING
    || profile.health <= PET_LOW_HEALTH_WARNING
    || careScore < 62
  ) {
    return {
      key: 'gloomy',
      title: '郁闷',
      description: '状态开始下滑，先补饱食或治疗，再陪它玩。',
      score: careScore,
    };
  }
  if (
    !illnessState.active
    && profile.hunger >= PET_SUPER_HAPPY_MIN_STAT
    && profile.health >= PET_SUPER_HAPPY_MIN_STAT
    && profile.mood >= 90
    && careScore >= 90
  ) {
    return {
      key: 'super_happy',
      title: '超级开心',
      description: '三维都接近满格，宠物正在闪闪发光。',
      score: careScore,
    };
  }
  return {
    key: 'happy',
    title: '开心',
    description: '状态稳定明亮，保持节奏就能继续成长。',
    score: careScore,
  };
}

function hasWeeklyIllness(studentId, weekKey) {
  if (!studentId || !weekKey) {
    return false;
  }
  const digest = crypto.createHash('sha256').update(`${studentId}:${weekKey}:pet-weekly-illness`).digest();
  return (digest[0] / 255) < PET_WEEKLY_ILLNESS_PROBABILITY;
}

function resolvePetRuntime(student, now = new Date()) {
  const studentId = String(student && (student._id || student.id || student.username) || '').trim();
  const profile = normalizePetProfile(student && student.pet_profile, now);
  const nowDateKey = formatRewardDateKey(now);
  const lastDateKey = formatRewardDateKey(profile.last_decay_at || now);
  const nowOrdinal = getRewardDayOrdinal(nowDateKey);
  const lastOrdinal = getRewardDayOrdinal(lastDateKey);
  const elapsedDays = nowOrdinal === null || lastOrdinal === null ? 0 : Math.max(0, nowOrdinal - lastOrdinal);
  const weekKey = getRewardWeekStartKey(now);
  const illnessTriggered = hasWeeklyIllness(studentId, weekKey);
  const curedWeekKeys = normalizeWeekKeys(profile.cured_illness_week_keys);
  const illnessCured = curedWeekKeys.includes(weekKey);
  const illnessActive = illnessTriggered && !illnessCured;

  let hunger = profile.hunger;
  let health = profile.health;
  let mood = profile.mood;
  if (elapsedDays > 0) {
    const hungerLoss = elapsedDays * PET_HUNGER_DECAY_PER_DAY;
    const healthLoss = illnessActive ? elapsedDays * PET_ILLNESS_HEALTH_DECAY_PER_DAY : 0;
    hunger = clampPetStat(hunger - hungerLoss);
    health = clampPetStat(health - healthLoss);
    const hungerPressure = hunger < PET_HAPPY_MIN_STAT
      ? Math.ceil((PET_HAPPY_MIN_STAT - hunger) / 16) * elapsedDays
      : 0;
    const healthPressure = health < 68
      ? Math.ceil((68 - health) / 18) * elapsedDays
      : 0;
    mood = clampPetStat(
      mood
      - Math.round((hungerLoss * PET_MOOD_DECAY_FACTOR) + (healthLoss * PET_MOOD_DECAY_FACTOR))
      - hungerPressure
      - healthPressure,
    );
  }

  const resolvedProfile = {
    ...profile,
    hunger,
    health,
    mood,
    cured_illness_week_keys: curedWeekKeys,
  };
  const illnessState = {
    week_key: weekKey,
    week_label: formatRewardWeekLabel(weekKey),
    probability_text: `${Math.round(PET_WEEKLY_ILLNESS_PROBABILITY * 100)}%`,
    triggered: illnessTriggered,
    cured: illnessTriggered && illnessCured,
    active: illnessActive,
    status_text: illnessActive
      ? '本周生病中'
      : (illnessTriggered && illnessCured ? '本周已治愈' : '本周状态稳定'),
  };
  const visualState = getPetVisualState(resolvedProfile, illnessState);
  const activeFrames = Array.isArray(resolvedProfile.frame_sequences[visualState.key])
    ? resolvedProfile.frame_sequences[visualState.key].filter(Boolean)
    : [];
  const activeAnimationUrl = String(resolvedProfile.animated_assets[visualState.key] || '').trim();
  const visualOptions = PET_VISUAL_STATES.map((item) => ({
    key: item.key,
    title: item.title,
    active: item.key === visualState.key,
    animated_asset_url: String(resolvedProfile.animated_assets[item.key] || '').trim(),
    has_animation: Boolean(String(resolvedProfile.animated_assets[item.key] || '').trim()),
    frame_count: Array.isArray(resolvedProfile.frame_sequences[item.key])
      ? resolvedProfile.frame_sequences[item.key].filter(Boolean).length
      : 0,
    has_frames: Array.isArray(resolvedProfile.frame_sequences[item.key])
      ? resolvedProfile.frame_sequences[item.key].filter(Boolean).length > 0
      : false,
  }));
  const totalInventoryCount = PET_ITEM_DEFINITIONS.reduce((sum, item) => sum + Number(resolvedProfile.inventory[item.key] || 0), 0);

  return {
    nowIso: toIsoString(now),
    elapsedDays,
    profile: resolvedProfile,
    illnessState,
    visualState,
    activeFrames,
    activeAnimationUrl,
    visualOptions,
    totalInventoryCount,
  };
}

function buildPetItemEffectText(item) {
  const parts = [];
  if (item.effects.hunger) {
    parts.push(`饱食 ${item.effects.hunger > 0 ? '+' : ''}${item.effects.hunger}%`);
  }
  if (item.effects.health) {
    parts.push(`健康 ${item.effects.health > 0 ? '+' : ''}${item.effects.health}%`);
  }
  if (item.effects.mood) {
    parts.push(`心情 ${item.effects.mood > 0 ? '+' : ''}${item.effects.mood}%`);
  }
  if (item.effects.cureIllness) {
    parts.push('可治愈本周生病');
  }
  return parts.join(' · ');
}

function buildPetCenterState(student, options = {}) {
  const now = options.now || new Date();
  const runtime = resolvePetRuntime(student, now);
  const points = getStudentTotalPoints(student);
  const speciesCatalog = buildPetSpeciesCatalog();
  const selectedSpecies = getPetSpeciesDefinition(runtime.profile.pet_species_key);
  const speciesSelected = !!selectedSpecies;
  const shopItems = PET_ITEM_DEFINITIONS.map((item) => ({
    key: item.key,
    title: item.title,
    category: item.category,
    cost: item.cost,
    description: item.description,
    effect_text: buildPetItemEffectText(item),
    affordable: points >= item.cost,
    owned_count: Number(runtime.profile.inventory[item.key] || 0),
  }));
  const bagItems = shopItems.filter((item) => item.owned_count > 0);
  const affordableCount = shopItems.filter((item) => item.affordable).length;

  return {
    student: getStudentLabel(student),
    pet: {
      name: runtime.profile.pet_name || (selectedSpecies ? selectedSpecies.default_pet_name : '待选宠物'),
      species: runtime.profile.pet_species || (selectedSpecies ? selectedSpecies.title : '未选择宠物'),
      species_key: runtime.profile.pet_species_key,
      species_selected: speciesSelected,
      species_locked: !!runtime.profile.pet_species_locked,
      species_selected_at: runtime.profile.pet_species_selected_at || '',
      hunger: runtime.profile.hunger,
      health: runtime.profile.health,
      mood: runtime.profile.mood,
      animated_assets: runtime.profile.animated_assets,
      frame_sequences: runtime.profile.frame_sequences,
      active_animation_url: runtime.activeAnimationUrl,
      active_frames: runtime.activeFrames,
      active_frame_count: runtime.activeFrames.length,
      visual_state: runtime.visualState.key,
      visual_title: runtime.visualState.title,
      visual_description: runtime.visualState.description,
      visual_score: runtime.visualState.score,
      visual_options: runtime.visualOptions,
      placeholder_text: '宠物状态动图资源预留中，后续可分别接入四套 animated WebP。',
      illness: runtime.illnessState,
      last_decay_at: runtime.profile.last_decay_at,
      last_interacted_at: runtime.profile.last_interacted_at,
      elapsed_days: runtime.elapsedDays,
      overfed_count: runtime.profile.overfed_count,
    },
    pet_selection: {
      can_select: !runtime.profile.pet_species_locked,
      locked: !!runtime.profile.pet_species_locked,
      selected_species_key: runtime.profile.pet_species_key,
      selected_species_title: runtime.profile.pet_species || (selectedSpecies ? selectedSpecies.title : ''),
      species_list: speciesCatalog,
    },
    shop: {
      affordable_count: affordableCount,
      items: shopItems,
    },
    bag: {
      total_count: runtime.totalInventoryCount,
      items: bagItems,
    },
    rules: {
      daily_hunger_decay_percent: PET_HUNGER_DECAY_PER_DAY,
      weekly_illness_probability_percent: Math.round(PET_WEEKLY_ILLNESS_PROBABILITY * 100),
      mood_decay_factor_percent: Math.round(PET_MOOD_DECAY_FACTOR * 100),
      overfed_threshold: PET_OVERFED_THRESHOLD,
      overfed_health_penalty: PET_OVERFED_HEALTH_PENALTY,
      illness_health_decay_per_day: PET_ILLNESS_HEALTH_DECAY_PER_DAY,
    },
    _profile: {
      ...runtime.profile,
      last_decay_at: runtime.nowIso,
    },
  };
}

function buildPetSummaryState(student, options = {}) {
  const state = buildPetCenterState(student, options);
  return {
    title: state.pet.name || '待选宠物',
    visual_title: state.pet.visual_title,
    visual_state: state.pet.visual_state,
    active_frame_count: state.pet.active_frame_count,
    hunger: state.pet.hunger,
    health: state.pet.health,
    mood: state.pet.mood,
    illness_active: !!state.pet.illness.active,
    status_text: state.pet.illness.status_text,
    summary_text: `饱食 ${state.pet.hunger}% · 健康 ${state.pet.health}% · 心情 ${state.pet.mood}%`,
    affordable_count: state.shop.affordable_count,
    inventory_count: state.bag.total_count,
  };
}

function selectPetSpecies(student, speciesKey, options = {}) {
  const now = options.now || new Date();
  const normalizedKey = normalizePetSpeciesKey(speciesKey);
  const species = getPetSpeciesDefinition(normalizedKey);
  if (!species) {
    throw new Error('图鉴里不存在这个宠物');
  }

  const state = buildPetCenterState(student, { now });
  if (state.pet.species_locked && state.pet.species_key) {
    throw new Error('宠物已经选定，不能再次更改');
  }

  const nextProfile = {
    ...state._profile,
    pet_name: species.default_pet_name,
    pet_species: species.title,
    pet_species_key: species.key,
    pet_species_selected_at: toIsoString(now),
    pet_species_locked: true,
    animated_assets: normalizeAnimatedAssetMap(species.animated_assets),
    frame_sequences: cloneFrameSequenceMap(species.frame_sequences),
    last_interacted_at: toIsoString(now),
  };

  const nextStudent = {
    ...student,
    pet_profile: nextProfile,
  };

  return {
    studentPatch: {
      pet_profile: nextProfile,
    },
    result: {
      title: '选宠成功',
      copy: `已选择 ${species.title}，后续将不能再次更换。`,
      pet_species_key: species.key,
      pet_species_title: species.title,
    },
    state: buildPetCenterState(nextStudent, { now }),
  };
}

function normalizePurchaseQuantity(quantity) {
  const value = Number(quantity);
  if (!Number.isInteger(value) || value <= 0) {
    return 1;
  }
  return Math.min(value, 9);
}

function purchasePetItem(student, itemKey, quantity = 1, options = {}) {
  const now = options.now || new Date();
  const item = PET_ITEM_MAP.get(String(itemKey || '').trim());
  if (!item) {
    throw new Error('宠物商店中不存在这个道具');
  }
  const state = buildPetCenterState(student, { now });
  if (!state.pet.species_selected) {
    throw new Error('请先选择宠物');
  }
  const count = normalizePurchaseQuantity(quantity);
  const totalCost = item.cost * count;
  const currentPoints = getStudentTotalPoints(student);
  if (currentPoints < totalCost) {
    throw new Error('积分不足，无法购买该道具');
  }

  const nextProfile = {
    ...state._profile,
    inventory: {
      ...state._profile.inventory,
      [item.key]: Number(state._profile.inventory[item.key] || 0) + count,
    },
    last_interacted_at: toIsoString(now),
  };
  const nextStudent = {
    ...student,
    total_points: currentPoints - totalCost,
    pet_profile: nextProfile,
  };
  return {
    studentPatch: {
      total_points: nextStudent.total_points,
      pet_profile: nextProfile,
    },
    result: {
      title: '购买成功',
      copy: `已购买 ${item.title} ×${count}`,
      points_text: `-${totalCost}`,
      item_key: item.key,
      item_title: item.title,
      quantity: count,
      total_cost: totalCost,
    },
    state: buildPetCenterState(nextStudent, { now }),
  };
}

function usePetItem(student, itemKey, options = {}) {
  const now = options.now || new Date();
  const item = PET_ITEM_MAP.get(String(itemKey || '').trim());
  if (!item) {
    throw new Error('背包里不存在这个道具');
  }
  const state = buildPetCenterState(student, { now });
  if (!state.pet.species_selected) {
    throw new Error('请先选择宠物');
  }
  const currentCount = Number(state._profile.inventory[item.key] || 0);
  if (currentCount <= 0) {
    throw new Error('该道具数量不足');
  }

  const nextProfile = {
    ...state._profile,
    inventory: {
      ...state._profile.inventory,
      [item.key]: currentCount - 1,
    },
    last_interacted_at: toIsoString(now),
  };

  let copy = '';
  if (item.category === 'food') {
    const beforeHunger = nextProfile.hunger;
    nextProfile.hunger = clampPetStat(nextProfile.hunger + Number(item.effects.hunger || 0));
    nextProfile.mood = clampPetStat(nextProfile.mood + Number(item.effects.mood || 0));
    if (beforeHunger >= PET_OVERFED_THRESHOLD) {
      nextProfile.health = clampPetStat(nextProfile.health - PET_OVERFED_HEALTH_PENALTY);
      nextProfile.mood = clampPetStat(nextProfile.mood - Math.round(PET_OVERFED_HEALTH_PENALTY * PET_MOOD_DECAY_FACTOR));
      nextProfile.overfed_count = Math.max(0, Number(nextProfile.overfed_count || 0)) + 1;
      copy = `${item.title} 已喂食，但吃得太多，健康值下降了。`;
    } else {
      copy = `${item.title} 已喂食，饱食度正在回升。`;
    }
  }

  if (item.category === 'medicine') {
    nextProfile.health = clampPetStat(nextProfile.health + Number(item.effects.health || 0));
    nextProfile.mood = clampPetStat(nextProfile.mood + Number(item.effects.mood || 0));
    if (state.pet.illness.active && item.effects.cureIllness) {
      nextProfile.cured_illness_week_keys = normalizeWeekKeys((nextProfile.cured_illness_week_keys || []).concat(state.pet.illness.week_key));
      copy = `${item.title} 已使用，本周生病状态已治愈。`;
    } else {
      copy = `${item.title} 已使用，健康值正在恢复。`;
    }
  }

  if (item.category === 'toy') {
    nextProfile.hunger = clampPetStat(nextProfile.hunger + Number(item.effects.hunger || 0));
    nextProfile.mood = clampPetStat(nextProfile.mood + Number(item.effects.mood || 0));
    copy = `${item.title} 已使用，宠物心情明显变好了。`;
  }

  const nextStudent = {
    ...student,
    pet_profile: nextProfile,
  };
  return {
    studentPatch: {
      pet_profile: nextProfile,
    },
    result: {
      title: '使用成功',
      copy,
      points_text: '+0',
      item_key: item.key,
      item_title: item.title,
    },
    state: buildPetCenterState(nextStudent, { now }),
  };
}

module.exports = {
  PET_ITEM_DEFINITIONS,
  PET_SPECIES_CATALOG,
  PET_VISUAL_STATES,
  buildPetSpeciesCatalog,
  buildInitialPetProfile,
  buildPetCenterState,
  buildPetSummaryState,
  purchasePetItem,
  selectPetSpecies,
  usePetItem,
};
