import { isRestorableUrl, urlKey } from '../shared/urls.js';

/**
 * 无痕访问采集：主框架提交、SPA pushState/replaceState、hash 变化。
 * 只处理 frameId === 0、http/https 且确认属于无痕标签的事件。
 */
export function createNavigationTracker({
  chromeApi,
  incognitoSession,
  getSettings,
  uuid = () => crypto.randomUUID(),
  now = () => Date.now(),
  logger = console,
}) {
  if (!chromeApi || !incognitoSession) throw new Error('createNavigationTracker 缺少依赖');
  let lastOrder = 0;

  function nextOrder(timestamp) {
    const base = Math.floor(timestamp * 1000);
    lastOrder = base > lastOrder ? base : lastOrder + 1;
    return lastOrder;
  }

  async function handle(details, capturedContext = null) {
    if (!details || details.frameId !== 0) return { recorded: false, reason: 'subframe' };
    if (details.documentLifecycle === 'prerender') return { recorded: false, reason: 'prerender' };
    if (!isRestorableUrl(details.url)) return { recorded: false, reason: 'unsupported-url' };
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return { recorded: false, reason: 'invalid-tab' };

    const context = capturedContext && capturedContext.active
      ? capturedContext
      : incognitoSession.peekContext();
    if (!context || !context.active) return { recorded: false, reason: 'session-ended' };

    let tab = null;
    try {
      tab = await chromeApi.tabs.get(details.tabId);
    } catch (error) {
      tab = null;
    }
    if (!tab || tab.incognito !== true) return { recorded: false, reason: 'not-incognito' };

    const settings = await getSettings().catch(() => null);
    if (!settings) return { recorded: false, reason: 'storage-error' };
    const visitedAt = Number.isFinite(details.timeStamp) ? details.timeStamp : now();
    const eventId = `nav:${details.tabId}:${details.documentId || ''}:${details.url}:${Math.round(visitedAt)}`;
    const currentTitle =
      tab.url === details.url && typeof tab.title === 'string' ? tab.title.trim() : '';
    const event = {
      eventId,
      kind: 'visit',
      sessionId: context.sessionId,
      generation: context.historyGeneration,
      url: details.url,
      urlKey: urlKey(details.url),
      title: currentTitle,
      visitedAt,
      order: nextOrder(visitedAt),
      tabId: details.tabId,
    };
    try {
      const result = await incognitoSession.recordVisit(event, settings.incognito.historyMaxRecords);
      return { recorded: result.applied === true, reason: result.reason || null };
    } catch (error) {
      logger.warn('undo-tab: 无痕访问写入失败', error && error.name ? error.name : 'error');
      return { recorded: false, reason: 'storage-error' };
    }
  }

  return { handle };
}
