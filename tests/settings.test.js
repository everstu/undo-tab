import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
    incognito: { maxRecords: 0 },
  });
  assert.equal(settings.normal.maxRecords, 12);
  assert.equal(settings.incognito.recentMaxRecords, 100);
  assert.equal(settings.incognito.historyMaxRecords, 100);
  assert.equal(modeMaxRecords(settings, 'normal'), 12);
  assert.equal(modeMaxRecords(settings, 'incognito'), 100);
});

test('条数边界', () => {
  assert.deepEqual(validateMaxRecords(1), { ok: true, value: 1 });
  assert.deepEqual(validateMaxRecords(10000), { ok: true, value: 10000 });
  assert.deepEqual(validateMaxRecords('500'), { ok: true, value: 500 });
  assert.equal(validateMaxRecords(0).reason, 'out-of-range');
  assert.equal(validateMaxRecords(10001).reason, 'out-of-range');
  assert.equal(validateMaxRecords(1.5).reason, 'not-integer');
  assert.equal(validateMaxRecords('').reason, 'empty');
});

test('宽度边界', () => {
  assert.deepEqual(validatePopupWidth('360'), { ok: true, value: 360 });
  assert.deepEqual(validatePopupWidth(800), { ok: true, value: 800 });
  assert.equal(validatePopupWidth(359).reason, 'out-of-range');
  assert.equal(validatePopupWidth(801).reason, 'out-of-range');
  assert.equal(validatePopupWidth(440.5).reason, 'not-integer');
});

test('合并设置：只改普通上限不动无痕与宽度', () => {
  const current = { schemaVersion: 2, popupWidth: 600, normal: { maxRecords: 10 }, incognito: { maxRecords: 20 } };
  const result = mergeSettings(current, { normal: { maxRecords: 3 } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.normal.maxRecords, 3);
  assert.equal(result.settings.normal.historyMaxRecords, 10);
  assert.equal(result.settings.incognito.recentMaxRecords, 20);
  assert.equal(result.settings.incognito.historyMaxRecords, 20);
  assert.equal(result.settings.popupWidth, 600);
});

test('合并设置：非法模式值保留原配置并返回字段错误', () => {
  const current = { schemaVersion: 2, popupWidth: 600, normal: { maxRecords: 10 }, incognito: { maxRecords: 20 } };
  const result = mergeSettings(current, { normal: { maxRecords: 0 } });
  assert.equal(result.settings.normal.maxRecords, 10);
  assert.deepEqual(result.errors, [{ field: 'normal.maxRecords', reason: 'out-of-range' }]);
  assert.equal(result.changed, false);
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
  assert.equal(settingsEqual(normalizeSettings(null), normalizeSettings({ normal: { maxRecords: 1 } })), false);
  assert.match(describeFieldError('incognito.maxRecords', 'out-of-range'), /10000/);
  assert.match(describeFieldError('popupWidth', 'empty'), /360/);
  assert.equal(describeFieldError('unknown', 'empty'), '设置参数无效');
});

test('旧无痕上限回填两个字段，新字段优先且各自独立', () => {
  const legacy = { normal: { maxRecords: 10 }, incognito: { maxRecords: 42 }, popupWidth: 600 };
  assert.deepEqual(normalizeSettings(legacy).incognito, { recentMaxRecords: 42, historyMaxRecords: 42 });
  const mixed = normalizeSettings({ ...legacy, incognito: { maxRecords: 42, recentMaxRecords: 2 } });
  assert.deepEqual(mixed.incognito, { recentMaxRecords: 2, historyMaxRecords: 42 });
  const result = mergeSettings(mixed, { incognito: { historyMaxRecords: 3 } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings.incognito, { recentMaxRecords: 2, historyMaxRecords: 3 });
  assert.equal(result.settings.normal.maxRecords, 10);
  assert.equal(result.settings.popupWidth, 600);
  assert.equal(modeMaxRecords(result.settings, 'incognito', 'recent'), 2);
  assert.equal(modeMaxRecords(result.settings, 'incognito', 'history'), 3);
  assert.equal(settingsEqual(mixed, result.settings), false);
  const invalid = mergeSettings(result.settings, { incognito: { historyMaxRecords: 0 } });
  assert.equal(invalid.changed, false);
  assert.deepEqual(invalid.errors, [{ field: 'incognito.historyMaxRecords', reason: 'out-of-range' }]);
});

test('普通历史上限兼容旧值，独立保存且参与设置比较与校验', () => {
  assert.deepEqual(normalizeSettings({ normal: { maxRecords: 500 } }).normal,
    { maxRecords: 500, historyMaxRecords: 500 });
  const current = normalizeSettings({ popupWidth: 600, normal: { maxRecords: 12, historyMaxRecords: 80 } });
  assert.equal(modeMaxRecords(current, 'normal', 'recent'), 12);
  assert.equal(modeMaxRecords(current, 'normal', 'history'), 80);
  const saved = mergeSettings(current, { normal: { historyMaxRecords: 3 } });
  assert.deepEqual(saved.settings.normal, { maxRecords: 12, historyMaxRecords: 3 });
  assert.deepEqual(saved.settings.incognito, current.incognito);
  assert.equal(saved.settings.popupWidth, 600);
  assert.equal(saved.changed, true);
  assert.equal(settingsEqual(current, saved.settings), false);
  const invalid = mergeSettings(current, { normal: { historyMaxRecords: 0 } });
  assert.equal(invalid.changed, false);
  assert.deepEqual(invalid.errors, [{ field: 'normal.historyMaxRecords', reason: 'out-of-range' }]);
  assert.match(describeFieldError('normal.historyMaxRecords', 'out-of-range'), /1–10000/);
  assert.deepEqual(normalizeSettings({ normal: { maxRecords: 0, historyMaxRecords: -1 } }).normal,
    { maxRecords: 100, historyMaxRecords: 100 });
});
