import { DEFAULT_SETTINGS, LIMITS, MODES, VIEWS } from '../shared/constants.js';

export function clampPage(page, totalPages) {
  const requested = Number.isInteger(page) && page > 0 ? page : 1;
  if (!Number.isInteger(totalPages) || totalPages <= 0) return 1;
  return Math.min(requested, totalPages);
}

export function paginate(items, page = 1, pageSize = 50) {
  const list = Array.isArray(items) ? items : [];
  const totalPages = list.length === 0 ? 0 : Math.ceil(list.length / pageSize);
  const currentPage = clampPage(page, totalPages);
  const start = totalPages === 0 ? 0 : (currentPage - 1) * pageSize;
  return {
    items: totalPages === 0 ? [] : list.slice(start, start + pageSize),
    page: currentPage,
    totalPages,
    pageLabel: totalPages === 0 ? '0/0' : `${currentPage}/${totalPages}`,
    canPrev: totalPages > 0 && currentPage > 1,
    canNext: totalPages > 0 && currentPage < totalPages,
  };
}

export function footerText({ mode, view, query = '', total = 0, matchCount = 0, loaded = 0, limit = DEFAULT_SETTINGS.normal.maxRecords }) {
  const hasQuery = typeof query === 'string' && query.trim() !== '';
  if (view === VIEWS.recent) {
    return hasQuery ? `匹配 ${matchCount} 条` : `共 ${total} 条 · 上限 ${limit}`;
  }
  if (mode === MODES.normal) {
    return hasQuery
      ? `匹配 ${loaded} 条 · 展示上限 ${limit}`
      : `已载入 ${loaded} 条 · 展示上限 ${limit}`;
  }
  return hasQuery ? `匹配 ${matchCount} 条` : `共 ${total} 条 · 上限 ${limit}`;
}

export function emptyText({ mode, view, query = '', sessionActive = true, loading = false }) {
  if (loading) return '正在加载…';
  const hasQuery = typeof query === 'string' && query.trim() !== '';
  if (view === VIEWS.recent) return hasQuery ? '没有匹配的记录' : '暂无最近关闭记录';
  if (mode === MODES.normal) {
    return hasQuery ? 'Chrome 历史中没有匹配的记录' : 'Chrome 历史中暂无可展示的记录';
  }
  if (!sessionActive) return '本次无痕会话已结束，记录已清空';
  return hasQuery ? '没有匹配的记录' : '本次无痕会话暂无访问记录';
}

export function canDelete(mode, view) {
  return !(mode === MODES.normal && view === VIEWS.history);
}

export function canClear(mode, view) {
  return !(mode === MODES.normal && view === VIEWS.history);
}

export function clearScopeText(mode, view) {
  if (view === VIEWS.recent) {
    return mode === MODES.incognito ? '清空本次无痕最近关闭' : '清空普通最近关闭';
  }
  return '清空本次无痕访问历史';
}

export function clearConfirmText(mode, view) {
  if (view === VIEWS.recent) {
    return mode === MODES.incognito
      ? '确认清空本次无痕会话的最近关闭记录？访问历史不受影响。'
      : '确认清空全部普通最近关闭记录？不会影响 Chrome 历史。';
  }
  return '确认清空本次无痕会话的访问历史？最近关闭不受影响。';
}

export function trimConfirmText({ mode, view = VIEWS.recent, recent = 0, history = 0, limit = DEFAULT_SETTINGS.normal.maxRecords }) {
  if (mode === MODES.incognito) {
    const isHistory = view === VIEWS.history;
    const label = isHistory ? '历史记录' : '最近关闭记录';
    const other = isHistory ? '最近关闭' : '历史记录';
    const count = isHistory ? history : recent;
    return `保存后将删除最旧的 ${count} 条${label}，保留最新 ${limit} 条；${other}不受影响。此操作不可撤销。`;
  }
  return `保存后将删除最旧的 ${recent} 条最近关闭记录，保留最新 ${limit} 条。此操作不可撤销。`;
}

export function maxScopeText(mode) {
  const { min, max } = LIMITS.maxRecords;
  const range = `可设置 ${min}–${max} 条，超出时按 ${min} 或 ${max} 条保存。`;
  return mode === MODES.incognito
    ? `最近关闭与历史记录的上限分别设置，修改其中一个不会裁剪另一个列表。${range}`
    : `当前模式：普通窗口。最近关闭保留上限与历史记录展示上限分别设置；调整展示上限不会删除 Chrome 历史。${range}`;
}

export function maxLabel(mode) {
  return mode === MODES.incognito ? '最近关闭最多保留多少条' : '普通最近关闭最多保留多少条';
}

export function dataNote(mode) {
  return mode === MODES.incognito
    ? '本次无痕会话的最近关闭与访问历史仅临时保存；关闭最后一个无痕窗口后自动删除，不上传，也不写入 Chrome 历史。'
    : '普通最近关闭保存在本机；普通历史由 Chrome 管理，扩展只读查询，不复制也不删除。';
}

export function formatMegabytes(bytes) {
  const mb = (Number.isFinite(bytes) ? bytes : 0) / (1024 * 1024);
  if (mb > 0 && mb < 0.1) return '<0.1';
  return mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}

export function quotaWarningText({ projectedBytes, quotaBytes }) {
  return `按当前记录的平均大小估算，两个列表都存满时约占 ${formatMegabytes(projectedBytes)} MB，接近或超过浏览器为无痕临时数据提供的 ${formatMegabytes(quotaBytes)} MB 空间；超出后新记录只能暂存在内存中，扩展休眠后可能丢失。`;
}

export function storageUsageText({ bytesInUse, quotaBytes }) {
  return `本次无痕记录约占 ${formatMegabytes(bytesInUse)} MB / ${formatMegabytes(quotaBytes)} MB 临时存储空间。`;
}
