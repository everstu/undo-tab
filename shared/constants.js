/**
 * 全扩展共用常量。普通与无痕使用独立数据域，不共享记录集合或条数配额。
 */

export const SCHEMA_VERSION = 2;

/** 窗口模式。值来自 Window.incognito / Tab.incognito。 */
export const MODES = Object.freeze({
  normal: 'normal',
  incognito: 'incognito',
});

export const MODE_LABELS = Object.freeze({
  [MODES.normal]: '普通',
  [MODES.incognito]: '无痕',
});

/** 弹窗内的两个视图。 */
export const VIEWS = Object.freeze({
  recent: 'recent',
  history: 'history',
});

export const VIEW_LABELS = Object.freeze({
  [VIEWS.recent]: '最近关闭',
  [VIEWS.history]: '历史记录',
});

export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  /** storage.local：普通最近关闭 { generation, lastOrder, entries } */
  normalRecent: 'normal.recent',
  /** storage.session：普通活动标签快照 */
  normalLiveTabs: 'normal.liveTabs',
  /** storage.session：普通待补写关闭事件 */
  normalPendingCloses: 'normal.pendingCloses',
  /** storage.session：无痕会话状态（含最近关闭、访问历史、快照、待写事件） */
  incognitoState: 'incognito.state',
  // 旧版本 key，仅用于迁移与清理
  legacyRecords: 'history.records',
  legacyLiveTabs: 'live.tabs',
});

export const LIMITS = Object.freeze({
  maxRecords: Object.freeze({ min: 1, max: 10000 }),
  popupWidth: Object.freeze({ min: 360, max: 800 }),
});

export const DEFAULT_POPUP_WIDTH = 440;

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  popupWidth: DEFAULT_POPUP_WIDTH,
  normal: Object.freeze({ maxRecords: 500 }),
  incognito: Object.freeze({ recentMaxRecords: 500, historyMaxRecords: 500 }),
});

/** 弹窗每页条数 */
export const PAGE_SIZE = 50;

/** 弹窗高度上限（Chrome 工具栏弹窗最大 600px，这里留出余量） */
export const POPUP_MAX_HEIGHT = 580;

/** 搜索词最大长度，避免异常长消息 */
export const MAX_QUERY_LENGTH = 200;

/** 无痕访问事件去重窗口 */
export const APPLIED_VISIT_EVENT_LIMIT = 200;

export const MESSAGES = Object.freeze({
  getContext: 'undoTab:getContext',
  queryView: 'undoTab:queryView',
  openEntry: 'undoTab:openEntry',
  deleteEntry: 'undoTab:deleteEntry',
  clearView: 'undoTab:clearView',
  clearIncognitoData: 'undoTab:clearIncognitoData',
  updateSettings: 'undoTab:updateSettings',
  getTrimPreview: 'undoTab:getTrimPreview',
});

export const ERROR_CODES = Object.freeze({
  invalidRequest: 'invalid-request',
  invalidUrl: 'invalid-url',
  entryNotFound: 'entry-not-found',
  contextLost: 'context-lost',
  sessionEnded: 'session-ended',
  forbidden: 'forbidden',
  storageFailure: 'storage-error',
  incognitoDenied: 'incognito-denied',
  windowUnavailable: 'window-unavailable',
  unknown: 'unknown-error',
});
