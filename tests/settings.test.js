import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeClampNotice,
  describeFieldError,
  mergeSettings,
  modeMaxRecords,
  normalizeSettings,
  settingsEqual,
  validateMaxRecords,
  validatePopupWidth,
} from '../shared/settings.js';

test('schema 2 默认设置与旧版 maxRecords 迁移', () => {
  assert.deepEqual(normalizeSettings(null), {
    schemaVersion: 2,
    popupWidth: 440,
    normal: { maxRecords: 100, historyMaxRecords: 100 },
    incognito: { recentMaxRecords: 100, historyMaxRecords: 100 },
  });
  assert.deepEqual(normalizeSettings({ maxRecords: 42, popupWidth: 700 }), {
    schemaVersion: 2,
    popupWidth: 700,
    normal: { maxRecords: 42, historyMaxRecords: 42 },
    incognito: { recentMaxRecords: 42, historyMaxRecords: 42 },
  });
});

test('分模式设置独立规范化', () => {
  const settings = normalizeSettings({
    popupWidth: 600,
    normal: { maxRecords: 12 },
    incognito: { maxRecords: 'abc' },
  });
  assert.equal(settings.normal.maxRecords, 12);
  assert.equal(settings.incognito.recentMaxRecords, 100);
  assert.equal(settings.incognito.historyMaxRecords, 100);
  assert.equal(modeMaxRecords(settings, 'normal'), 12);
  assert.equal(modeMaxRecords(settings, 'incognito'), 100);
});

test('条数边界：10–1000 内原样保留，越界整数收紧并标记', () => {
  assert.deepEqual(validateMaxRecords(10), { ok: true, value: 10 });
  assert.deepEqual(validateMaxRecords(1000), { ok: true, value: 1000 });
  assert.deepEqual(validateMaxRecords('500'), { ok: true, value: 500 });
  assert.deepEqual(validateMaxRecords(' 12 '), { ok: true, value: 12 });
  assert.deepEqual(validateMaxRecords(9), { ok: true, value: 10, clamped: 'min' });
  assert.deepEqual(validateMaxRecords('0'), { ok: true, value: 10, clamped: 'min' });
  assert.deepEqual(validateMaxRecords('-5'), { ok: true, value: 10, clamped: 'min' });
  assert.deepEqual(validateMaxRecords(1001), { ok: true, value: 1000, clamped: 'max' });
  assert.deepEqual(validateMaxRecords('10000'), { ok: true, value: 1000, clamped: 'max' });
  assert.deepEqual(validateMaxRecords('99999999999999999999'), { ok: true, value: 1000, clamped: 'max' });
  assert.equal(validateMaxRecords(1.5).reason, 'not-integer');
  assert.equal(validateMaxRecords('12.5').reason, 'not-integer');
  assert.equal(validateMaxRecords('abc').reason, 'not-integer');
  assert.equal(validateMaxRecords('').reason, 'empty');
  assert.equal(validateMaxRecords(null).reason, 'empty');
});

test('宽度边界：360–800 内原样保留，越界整数收紧并标记', () => {
  assert.deepEqual(validatePopupWidth('360'), { ok: true, value: 360 });
  assert.deepEqual(validatePopupWidth(800), { ok: true, value: 800 });
  assert.deepEqual(validatePopupWidth(359), { ok: true, value: 360, clamped: 'min' });
  assert.deepEqual(validatePopupWidth('801'), { ok: true, value: 800, clamped: 'max' });
  assert.equal(validatePopupWidth(440.5).reason, 'not-integer');
  assert.equal(validatePopupWidth('').reason, 'empty');
});

test('越界提示文案', () => {
  assert.equal(describeClampNotice('maxRecords', 'min'), '记录条数最小为 10，已按 10 条保存');
  assert.equal(describeClampNotice('maxRecords', 'max'), '记录条数最大为 1000，已按 1000 条保存');
  assert.equal(describeClampNotice('maxRecords', 'max', { pending: true }), '记录条数最大为 1000，将按 1000 条保存');
  assert.equal(describeClampNotice('popupWidth', 'min'), '弹窗宽度最小为 360px，已按 360px 保存');
  assert.equal(describeClampNotice('popupWidth', 'max'), '弹窗宽度最大为 800px，已按 800px 保存');
});

test('已保存的越界值在规范化时收紧到当前范围', () => {
  assert.deepEqual(normalizeSettings({
    popupWidth: 900,
    normal: { maxRecords: 4, historyMaxRecords: 5000 },
    incognito: { recentMaxRecords: 2, historyMaxRecords: 10000 },
  }), {
    schemaVersion: 2,
    popupWidth: 800,
    normal: { maxRecords: 10, historyMaxRecords: 1000 },
    incognito: { recentMaxRecords: 10, historyMaxRecords: 1000 },
  });
  // 旧版共用上限越界时同样收紧后回填。
  assert.deepEqual(normalizeSettings({ maxRecords: 5000, popupWidth: 300 }).incognito,
    { recentMaxRecords: 1000, historyMaxRecords: 1000 });
  assert.equal(normalizeSettings({ maxRecords: 5000, popupWidth: 300 }).popupWidth, 360);
});

test('合并设置：只改普通上限不动无痕与宽度', () => {
  const current = { schemaVersion: 2, popupWidth: 600, normal: { maxRecords: 10 }, incognito: { maxRecords: 20 } };
  const result = mergeSettings(current, { normal: { maxRecords: 13 } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.normal.maxRecords, 13);
  assert.equal(result.settings.normal.historyMaxRecords, 10);
  assert.equal(result.settings.incognito.recentMaxRecords, 20);
  assert.equal(result.settings.incognito.historyMaxRecords, 20);
  assert.equal(result.settings.popupWidth, 600);
});

test('合并设置：非整数保留原配置并返回字段错误；越界整数收紧后保存', () => {
  const current = { schemaVersion: 2, popupWidth: 600, normal: { maxRecords: 20 }, incognito: { maxRecords: 20 } };
  const result = mergeSettings(current, { normal: { maxRecords: 'abc' } });
  assert.equal(result.settings.normal.maxRecords, 20);
  assert.deepEqual(result.errors, [{ field: 'normal.maxRecords', reason: 'not-integer' }]);
  assert.equal(result.changed, false);

  const low = mergeSettings(current, { normal: { maxRecords: 0 }, popupWidth: 1200 });
  assert.deepEqual(low.errors, []);
  assert.equal(low.settings.normal.maxRecords, 10);
  assert.equal(low.settings.popupWidth, 800);
  assert.equal(low.changed, true);
  const high = mergeSettings(current, { incognito: { historyMaxRecords: 5000 } });
  assert.equal(high.settings.incognito.historyMaxRecords, 1000);
  assert.equal(high.settings.incognito.recentMaxRecords, 20);
});

test('合并设置：宽度与未知字段', () => {
  const current = { schemaVersion: 2, popupWidth: 440, normal: { maxRecords: 10 }, incognito: { maxRecords: 20 } };
  const result = mergeSettings(current, { popupWidth: 800, theme: 'dark' });
  assert.equal(result.settings.popupWidth, 800);
  assert.equal(result.errors.length, 0);
  assert.equal(mergeSettings(current, null).errors.length, 1);
});

test('settingsEqual 与错误文案', () => {
  assert.equal(settingsEqual(normalizeSettings(null), normalizeSettings({})), true);
  assert.equal(settingsEqual(normalizeSettings(null), normalizeSettings({ normal: { maxRecords: 10 } })), false);
  assert.match(describeFieldError('incognito.maxRecords', 'empty'), /10–1000/);
  assert.equal(describeFieldError('normal.maxRecords', 'not-integer'), '记录条数必须是整数');
  assert.match(describeFieldError('popupWidth', 'empty'), /360/);
  assert.equal(describeFieldError('unknown', 'empty'), '设置参数无效');
});

test('旧无痕上限回填两个字段，新字段优先且各自独立', () => {
  const legacy = { normal: { maxRecords: 10 }, incognito: { maxRecords: 42 }, popupWidth: 600 };
  assert.deepEqual(normalizeSettings(legacy).incognito, { recentMaxRecords: 42, historyMaxRecords: 42 });
  const mixed = normalizeSettings({ ...legacy, incognito: { maxRecords: 42, recentMaxRecords: 11 } });
  assert.deepEqual(mixed.incognito, { recentMaxRecords: 11, historyMaxRecords: 42 });
  const result = mergeSettings(mixed, { incognito: { historyMaxRecords: 12 } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings.incognito, { recentMaxRecords: 11, historyMaxRecords: 12 });
  assert.equal(result.settings.normal.maxRecords, 10);
  assert.equal(result.settings.popupWidth, 600);
  assert.equal(modeMaxRecords(result.settings, 'incognito', 'recent'), 11);
  assert.equal(modeMaxRecords(result.settings, 'incognito', 'history'), 12);
  assert.equal(settingsEqual(mixed, result.settings), false);
  const invalid = mergeSettings(result.settings, { incognito: { historyMaxRecords: '' } });
  assert.equal(invalid.changed, false);
  assert.deepEqual(invalid.errors, [{ field: 'incognito.historyMaxRecords', reason: 'empty' }]);
});

test('普通历史上限兼容旧值，独立保存且参与设置比较与校验', () => {
  assert.deepEqual(normalizeSettings({ normal: { maxRecords: 500 } }).normal,
    { maxRecords: 500, historyMaxRecords: 500 });
  const current = normalizeSettings({ popupWidth: 600, normal: { maxRecords: 12, historyMaxRecords: 80 } });
  assert.equal(modeMaxRecords(current, 'normal', 'recent'), 12);
  assert.equal(modeMaxRecords(current, 'normal', 'history'), 80);
  const saved = mergeSettings(current, { normal: { historyMaxRecords: 15 } });
  assert.deepEqual(saved.settings.normal, { maxRecords: 12, historyMaxRecords: 15 });
  assert.deepEqual(saved.settings.incognito, current.incognito);
  assert.equal(saved.settings.popupWidth, 600);
  assert.equal(saved.changed, true);
  assert.equal(settingsEqual(current, saved.settings), false);
  const invalid = mergeSettings(current, { normal: { historyMaxRecords: 1.5 } });
  assert.equal(invalid.changed, false);
  assert.deepEqual(invalid.errors, [{ field: 'normal.historyMaxRecords', reason: 'not-integer' }]);
  assert.match(describeFieldError('normal.historyMaxRecords', 'empty'), /10–1000/);
  // 已保存的 0、负数从未合法，视为损坏并回退默认值，不会被收紧为 10 而触发启动裁剪。
  assert.deepEqual(normalizeSettings({ normal: { maxRecords: 0, historyMaxRecords: -1 } }).normal,
    { maxRecords: 100, historyMaxRecords: 100 });
  assert.deepEqual(normalizeSettings({ maxRecords: 42, normal: { maxRecords: -5 } }).normal,
    { maxRecords: 42, historyMaxRecords: 42 });
  assert.deepEqual(normalizeSettings({ incognito: { recentMaxRecords: 0, historyMaxRecords: 3 } }).incognito,
    { recentMaxRecords: 100, historyMaxRecords: 10 });
  assert.deepEqual(normalizeSettings({ normal: { maxRecords: 'x', historyMaxRecords: null } }).normal,
    { maxRecords: 100, historyMaxRecords: 100 });
});
