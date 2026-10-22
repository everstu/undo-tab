import { createQueue } from '../shared/queue.js';
import { createHistoryService } from './history-service.js';
import { createIncognitoSession } from './incognito-session.js';
import { createIncognitoWindowSync } from './incognito-windows.js';
import { createMessageHandler, isTrustedSender } from './messenger.js';
import { migrateLegacyData } from './migrator.js';
import { createNavigationTracker } from './navigation-tracker.js';
import { createNormalStore } from './normal-store.js';
import { createSettingsStore } from './settings-store.js';
import { createTabTracker } from './tab-tracker.js';

/**
 * 可测试的 Undo Tab worker 装配。
 *
 * 普通与无痕数据完全分域：
 * - 普通最近关闭写 storage.local，持久保存；
 * - 无痕最近关闭与访问历史只写 storage.session 的 incognito.state，
 *   最后一个无痕窗口关闭后自动清空。
 * 所有窗口/标签/导航事件与消息操作共用同一条串行队列。
 */
export function createUndoTabWorker({ chrome, logger = console }) {
  if (!chrome) throw new Error('createUndoTabWorker 缺少 chrome');

  const localArea = chrome.storage.local;
  const sessionArea = chrome.storage.session;

  const settingsStore = createSettingsStore({ localArea });
  const normalStore = createNormalStore({ localArea, sessionArea });
  const incognitoSession = createIncognitoSession({ sessionArea, logger });
  const historyService = createHistoryService({ chromeApi: chrome });
  const tracker = createTabTracker({
    chromeApi: chrome,
    sessionArea,
    normalStore,
    incognitoSession,
    getSettings: () => settingsStore.get(),
    logger,
  });
  const navigationTracker = createNavigationTracker({
    chromeApi: chrome,
    incognitoSession,
    getSettings: () => settingsStore.get(),
    logger,
  });
  const incognitoWindows = createIncognitoWindowSync({
    chromeApi: chrome,
    incognitoSession,
    tracker,
    logger,
  });
  const queue = createQueue();
  const handleMessage = createMessageHandler({
    settingsStore,
    normalStore,
    incognitoSession,
    historyService,
    chromeApi: chrome,
    logger,
  });

  let readyPromise = null;

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        // 迁移在前；随后先核对无痕窗口、结束失效会话，再重建标签快照。
        await migrateLegacyData({ localArea, sessionArea, logger });
        await settingsStore.ensure();
        await incognitoWindows.sync();
        await tracker.init();
      })().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  function runExclusive(task) {
    return queue(async () => {
      await ensureReady();
      await incognitoWindows.ensurePermission();
      // 会话已核对后再补写；补写失败不能阻断用户清空/查询等操作。
      try {
        await tracker.flushPendingCloses();
      } catch (error) {
        logger.warn('undo-tab: 待写记录补写失败，稍后重试', error && error.name ? error.name : 'error');
      }
      return task();
    });
  }

  /** 窗口生命周期事件不先补写，避免最后一个无痕窗口关闭后旧数据被短暂写回。 */
  function runCritical(task) {
    return queue(async () => {
      await ensureReady();
      return task();
    });
  }

  function runInBackground(task) {
    runExclusive(task).catch((error) => {
      logger.warn('undo-tab: 后台任务失败', error && error.name ? error.name : 'error');
    });
  }

  function runCriticalInBackground(task) {
    runCritical(task).catch((error) => {
      logger.warn('undo-tab: 窗口事件处理失败', error && error.name ? error.name : 'error');
    });
  }

  chrome.runtime.onInstalled.addListener(() => {
    runInBackground(() => ensureReady());
  });

  chrome.runtime.onStartup.addListener(() => {
    runInBackground(() => ensureReady());
  });

  chrome.windows.onCreated.addListener((win) => {
    if (!win || win.incognito !== true) return;
    // 用真实枚举校正，而不是直接把新窗口并入旧会话：
    // 若旧窗口已经全部消失，这里应生成新的空会话。
    runCriticalInBackground(() => incognitoWindows.sync());
  });

  chrome.windows.onRemoved.addListener(() => {
    runCriticalInBackground(async () => {
      await incognitoWindows.sync();
      // 会话已结束的旧无痕 pending 会被丢弃；仍有效的普通 pending 可继续补写。
      try {
        await tracker.flushPendingCloses();
      } catch (error) {
        logger.warn('undo-tab: 关窗后补写失败，稍后重试', error && error.name ? error.name : 'error');
      }
    });
  });

  chrome.tabs.onCreated.addListener((tab) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabCreated(tab, captured));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabUpdated(tabId, changeInfo, tab, captured));
  });

  chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabMoved(tabId, moveInfo, captured));
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabAttached(tabId, attachInfo, captured));
  });

  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabDetached(tabId, detachInfo, captured));
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabReplaced(addedTabId, removedTabId, captured));
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    tracker.noteTabRemoved(tabId);
    const captured = incognitoSession.peekContext();
    runInBackground(() => tracker.handleTabRemoved(tabId, removeInfo, captured));
  });

  function handleNavigation(details) {
    const captured = incognitoSession.peekContext();
    runInBackground(() => navigationTracker.handle(details, captured));
  }

  chrome.webNavigation.onCommitted.addListener((details) => handleNavigation(details));
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => handleNavigation(details));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => handleNavigation(details));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedSender(sender, chrome)) return false;
    runExclusive(() => handleMessage(message, sender))
      .then((response) => sendResponse(response))
      .catch(() => {
        sendResponse({
          ok: false,
          error: { code: 'unknown-error', message: '操作失败，请重试' },
        });
      });
    return true;
  });

  return {
    ensureReady,
    runExclusive,
    queue,
    syncIncognitoWindows: () => incognitoWindows.sync(),
    stores: { settingsStore, normalStore, incognitoSession, historyService, tracker },
  };
}
