import { fallbackTitle, urlKey } from '../shared/urls.js';

/**
 * 普通历史只读查询 Chrome History API。
 * 明确传 startTime: 0，避免默认只查最近 24 小时。
 */
export function createHistoryService({ chromeApi }) {
  if (!chromeApi) throw new Error('createHistoryService 缺少 chromeApi');

  return {
    async searchNormal(query, maxResults) {
      const text = typeof query === 'string' ? query.trim().slice(0, 200) : '';
      const limit = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 500;
      const items = await chromeApi.history.search({ text, startTime: 0, maxResults: limit });
      const entries = (Array.isArray(items) ? items : [])
        .filter((item) => item && urlKey(item.url) && Number.isFinite(item.lastVisitTime))
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
        })
        .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
      return { entries, loaded: entries.length, limit };
    },
  };
}
