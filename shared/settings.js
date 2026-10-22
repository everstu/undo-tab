import { DEFAULT_SETTINGS, LIMITS, MODES, SCHEMA_VERSION, VIEWS } from './constants.js';

const DIGITS_ONLY = /^\d+$/;

/**
 * 把输入解析为整数；空值、小数、非法字符返回 null。
 * 接受数字或字符串（用于 input[type=number].value）。
 */
export function parseIntegerInput(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DIGITS_ONLY.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function validateIntegerField(field, value) {
  const limits = LIMITS[field];
  if (value === undefined || value === null) return { ok: false, reason: 'empty' };
  if (typeof value === 'string' && value.trim() === '') return { ok: false, reason: 'empty' };
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return { ok: false, reason: 'not-integer' };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false, reason: 'not-integer' };
  }
  const parsed = parseIntegerInput(value);
  if (parsed === null) return { ok: false, reason: 'not-integer' };
  if (parsed < limits.min || parsed > limits.max) {
    return { ok: false, reason: 'out-of-range' };
  }
  return { ok: true, value: parsed };
}

export function validateMaxRecords(value) {
  return validateIntegerField('maxRecords', value);
}

export function validatePopupWidth(value) {
  return validateIntegerField('popupWidth', value);
}

function normalizeMode(raw, legacyValue) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const current = validateMaxRecords(source.maxRecords);
  if (current.ok) return { maxRecords: current.value };
  const legacy = validateMaxRecords(legacyValue);
  return { maxRecords: legacy.ok ? legacy.value : DEFAULT_SETTINGS.normal.maxRecords };
}

function normalizeIncognito(raw, legacyValue) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const fallback = normalizeMode(source, legacyValue).maxRecords;
  const recent = validateMaxRecords(source.recentMaxRecords);
  const history = validateMaxRecords(source.historyMaxRecords);
  return {
    recentMaxRecords: recent.ok ? recent.value : fallback,
    historyMaxRecords: history.ok ? history.value : fallback,
  };
}

/**
 * 规范化为 schema 2 设置。旧版顶层 maxRecords 同时作为两种模式的初始值，
 * 旧无痕 maxRecords 分别作为最近关闭与访问历史上限的初始值。
 * 缺失或非法字段使用默认值 500。
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const popupWidth = validatePopupWidth(source.popupWidth);
  return {
    schemaVersion: SCHEMA_VERSION,
    popupWidth: popupWidth.ok ? popupWidth.value : DEFAULT_SETTINGS.popupWidth,
    normal: normalizeMode(source.normal, source.maxRecords),
    incognito: normalizeIncognito(source.incognito, source.maxRecords),
  };
}

export function settingsEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.schemaVersion === b.schemaVersion &&
    a.popupWidth === b.popupWidth &&
    a.normal?.maxRecords === b.normal?.maxRecords &&
    a.incognito?.recentMaxRecords === b.incognito?.recentMaxRecords &&
    a.incognito?.historyMaxRecords === b.incognito?.historyMaxRecords
  );
}

/**
 * 合并设置补丁：
 *   { popupWidth?, normal?: { maxRecords? }, incognito?: { recentMaxRecords?, historyMaxRecords? } }
 * 非法字段保留原值并返回错误；单独修改一个模式不会覆盖另一个模式。
 */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current);
  const next = {
    schemaVersion: SCHEMA_VERSION,
    popupWidth: base.popupWidth,
    normal: { ...base.normal },
    incognito: { ...base.incognito },
  };
  const errors = [];

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { settings: next, errors: [{ field: 'patch', reason: 'invalid' }], changed: false };
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'popupWidth')) {
    const result = validatePopupWidth(patch.popupWidth);
    if (result.ok) next.popupWidth = result.value;
    else errors.push({ field: 'popupWidth', reason: result.reason });
  }

  for (const mode of [MODES.normal, MODES.incognito]) {
    const modePatch = patch[mode];
    if (!modePatch || typeof modePatch !== 'object' || Array.isArray(modePatch)) continue;
    const fields = mode === MODES.normal ? ['maxRecords'] : ['recentMaxRecords', 'historyMaxRecords'];
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(modePatch, field)) continue;
      const result = validateMaxRecords(modePatch[field]);
      if (result.ok) next[mode][field] = result.value;
      else errors.push({ field: `${mode}.${field}`, reason: result.reason });
    }
  }

  return { settings: next, errors, changed: !settingsEqual(base, next) };
}

export function modeMaxRecords(settings, mode, view = VIEWS.recent) {
  const normalized = normalizeSettings(settings);
  if (mode !== MODES.incognito) return normalized.normal.maxRecords;
  return view === VIEWS.history
    ? normalized.incognito.historyMaxRecords
    : normalized.incognito.recentMaxRecords;
}

/** 供界面显示的中文错误文案。 */
export function describeFieldError(field, reason) {
  if (['popupWidth', 'normal.maxRecords', 'incognito.maxRecords', 'incognito.recentMaxRecords', 'incognito.historyMaxRecords'].includes(field)) {
    const isWidth = field === 'popupWidth';
    const limits = LIMITS[isWidth ? 'popupWidth' : 'maxRecords'];
    const range = `${limits.min}–${limits.max}`;
    if (isWidth) {
      if (reason === 'empty') return `请输入弹窗宽度（${range} 之间的整数）`;
      if (reason === 'not-integer') return '弹窗宽度必须是整数';
      return `弹窗宽度需在 ${range}px 之间`;
    }
    if (reason === 'empty') return `请输入记录条数（${range} 之间的整数）`;
    if (reason === 'not-integer') return '记录条数必须是整数';
    return `记录条数需在 ${range} 之间`;
  }
  return '设置参数无效';
}
