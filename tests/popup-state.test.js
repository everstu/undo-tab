import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canClear,
  canDelete,
  clearConfirmText,
  clearScopeText,
  dataNote,
  emptyText,
  footerText,
  maxLabel,
  maxScopeText,
  paginate,
  trimConfirmText,
} from '../popup/state.js';

test('分页与页码边界', () => {
  const items = Array.from({ length: 120 }, (_, index) => index);
  const page2 = paginate(items, 2, 50);
  assert.equal(page2.page, 2);
  assert.equal(page2.totalPages, 3);
  assert.equal(page2.pageLabel, '2/3');
  assert.equal(page2.items[0], 50);
  assert.equal(page2.items.length, 50);
  assert.equal(page2.canPrev, true);
  assert.equal(page2.canNext, true);

  const empty = paginate([], 9, 50);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageLabel, '0/0');
  assert.equal(empty.items.length, 0);
  assert.equal(empty.canPrev, false);
});

test('页脚只显示当前模式的当前视图数量', () => {
  assert.equal(
    footerText({ mode: 'normal', view: 'recent', query: '', total: 32, limit: 500 }),
    '共 32 条 · 上限 500',
  );
  assert.equal(
    footerText({ mode: 'normal', view: 'recent', query: 'a', total: 32, matchCount: 4, limit: 500 }),
    '匹配 4 条',
  );
  assert.equal(
    footerText({ mode: 'normal', view: 'history', query: '', loaded: 500, limit: 500 }),
    '已载入 500 条 · 展示上限 500',
  );
  assert.equal(
    footerText({ mode: 'normal', view: 'history', query: 'a', loaded: 4, limit: 500 }),
    '匹配 4 条 · 展示上限 500',
  );
  assert.equal(
    footerText({ mode: 'incognito', view: 'history', query: '', total: 12, limit: 500 }),
    '共 12 条 · 上限 500',
  );
  assert.equal(
    footerText({ mode: 'incognito', view: 'history', query: 'a', matchCount: 3, limit: 500 }),
    '匹配 3 条',
  );
});

test('空状态文案区分模式、视图、搜索与会话结束', () => {
  assert.equal(emptyText({ mode: 'normal', view: 'recent', loading: true }), '正在加载…');
  assert.equal(emptyText({ mode: 'normal', view: 'recent' }), '暂无最近关闭记录');
  assert.equal(emptyText({ mode: 'normal', view: 'recent', query: 'x' }), '没有匹配的记录');
  assert.equal(emptyText({ mode: 'normal', view: 'history' }), 'Chrome 历史中暂无可展示的记录');
  assert.equal(emptyText({ mode: 'normal', view: 'history', query: 'x' }), 'Chrome 历史中没有匹配的记录');
  assert.equal(emptyText({ mode: 'incognito', view: 'history', sessionActive: false }), '本次无痕会话已结束，记录已清空');
  assert.equal(emptyText({ mode: 'incognito', view: 'history' }), '本次无痕会话暂无访问记录');
});

test('普通历史不能删除或清空，其余可以', () => {
  assert.equal(canDelete('normal', 'history'), false);
  assert.equal(canClear('normal', 'history'), false);
  assert.equal(canDelete('normal', 'recent'), true);
  assert.equal(canDelete('incognito', 'history'), true);
  assert.equal(canClear('incognito', 'history'), true);
});

test('清空与裁剪文案分别说明范围', () => {
  assert.match(clearScopeText('normal', 'recent'), /普通最近关闭/);
  assert.match(clearScopeText('incognito', 'recent'), /无痕最近关闭/);
  assert.match(clearScopeText('incognito', 'history'), /无痕访问历史/);
  assert.match(clearConfirmText('normal', 'recent'), /不会影响 Chrome 历史/);
  assert.match(clearConfirmText('incognito', 'history'), /最近关闭不受影响/);
  assert.match(
    trimConfirmText({ mode: 'incognito', view: 'recent', recent: 3, history: 0, limit: 100 }),
    /3 条最近关闭记录.*历史记录不受影响/,
  );
  assert.match(
    trimConfirmText({ mode: 'incognito', view: 'history', recent: 0, history: 7, limit: 200 }),
    /7 条历史记录.*200 条.*最近关闭不受影响/,
  );
  assert.match(trimConfirmText({ mode: 'normal', recent: 2, history: 0, limit: 100 }), /2 条最近关闭/);
});

test('设置说明文案', () => {
  assert.match(maxScopeText('normal'), /Chrome 历史/);
  assert.match(maxScopeText('incognito'), /分别设置/);
  assert.match(maxLabel('incognito'), /最近关闭/);
  assert.match(dataNote('normal'), /只读查询/);
  assert.match(dataNote('incognito'), /关闭最后一个无痕窗口/);
});
