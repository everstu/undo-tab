import { DEFAULT_SETTINGS, MAX_QUERY_LENGTH } from '../shared/constants.js';
import { fallbackTitle, urlKey } from '../shared/urls.js';

/**
 * 普通历史只读查询 Chrome History API。
 * 明确传 startTime: 0，避免默认只查最近 24 小时。
 */
export function createHistoryService({ chromeApi }) {
  if (!chromeApi) throw new Error('createHistoryService 缺少 chromeApi');

  return {
    async searchNormal(query, maxResults) {
      const text = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY_LENGTH) : '';
      const limit = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : DEFAULT_SETTINGS.normal.historyMaxRecords;
      let requested = limit;
      let candidates;
      // API 上限包含 file:// 等不可展示项；逐步扩大查询，直到有效项足够或结果耗尽。
      // 重查同一前缀，避免按时间翻页漏掉同一毫秒内的记录。
      while (true) {
        const result = await chromeApi.history.search({ text, startTime: 0, maxResults: requested });
        const items = Array.isArray(result) ? result : [];
        candidates = items.filter((item) => item && urlKey(item.url) && Number.isFinite(item.lastVisitTime));
        if (candidates.length >= limit || items.length < requested) break;
        requested *= 2;
      }
      const entries = candidates
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        .slice(0, limit)
        .map((item) => {
          const key = urlKey(item.url);
          return {
            id: key,
            url: item.url,
            urlKey: key,
            title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : fallbackTitle(item.url),
            lastVisitedAt: item.lastVisitTime,
            visitCount: Number.isInteger(item.visitCount) && item.visitCount > 0 ? item.visitCount : 0,
            hasFavicon: true,
          };
        });
      return { entries, loaded: entries.length, limit };
    },
  };
}
