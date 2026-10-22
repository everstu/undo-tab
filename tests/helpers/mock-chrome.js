/**
 * 受控的 Chrome API mock，只实现扩展实际用到的部分。
 * 用于 Node 逻辑测试，不替代真实浏览器验收。
 */

export function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  const control = { failWrites: false, failReads: false, writes: 0 };
  return {
    data,
    control,
    async get(keys) {
      if (control.failReads) throw new Error('storage read failed');
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          result[key] = structuredClone(data[key]);
        }
      }
      return result;
    },
    async set(items) {
      if (control.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
      control.writes += 1;
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

export function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    get count() {
      return listeners.size;
    },
  };
}

export function createMockChrome({
  tabs = [],
  windows = [],
  incognitoAllowed = true,
  extensionId = 'abcdefghijklmnopabcdefghijklmnop',
} = {}) {
  const tabList = tabs.map((tab) => ({ title: '', pinned: false, ...tab }));
  const windowList = windows.map((win) => ({ type: 'normal', focused: false, ...win }));
  let nextTabId = 1000;
  let nextWindowId = 100;
  let currentWindowId = windowList.length > 0 ? windowList[0].id : null;
  let allowedIncognito = incognitoAllowed;
  const historyItems = [];
  const historySearchCalls = [];

  function tabView(tab) {
    return { ...tab };
  }

  function windowView(win) {
    return {
      ...win,
      tabs: tabList.filter((tab) => tab.windowId === win.id).map(tabView),
    };
  }

  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (path) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
    },
    storage: {
      local: createStorageArea(),
      session: createStorageArea(),
    },
    tabs: {
      async query(info = {}) {
        return tabList
          .filter((tab) => info.windowId === undefined || tab.windowId === info.windowId)
          .map(tabView);
      },
      async get(tabId) {
        const tab = tabList.find((item) => item.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tabView(tab);
      },
      async create(options = {}) {
        let windowId = options.windowId;
        if (windowId === undefined) {
          if (currentWindowId === null) throw new Error('No current window');
          windowId = currentWindowId;
        }
        const win = windowList.find((item) => item.id === windowId);
        if (!win) throw new Error(`Invalid window id: ${windowId}`);
        const siblings = tabList.filter((tab) => tab.windowId === windowId);
        const index = Number.isInteger(options.index)
          ? Math.min(Math.max(options.index, 0), siblings.length)
          : siblings.length;
        const tab = {
          id: nextTabId++,
          windowId,
          index,
          incognito: win.incognito === true,
          url: options.url || 'chrome://newtab/',
          title: '',
          pinned: options.pinned === true,
          active: options.active !== false,
        };
        tabList.push(tab);
        return tabView(tab);
      },
      onCreated: createEvent(),
      onUpdated: createEvent(),
      onMoved: createEvent(),
      onAttached: createEvent(),
      onDetached: createEvent(),
      onReplaced: createEvent(),
      onRemoved: createEvent(),
    },
    windows: {
      async getAll(info = {}) {
        const types = info.windowTypes;
        return windowList
          .filter((win) => !types || types.includes(win.type || 'normal'))
          .map(windowView);
      },
      async getCurrent() {
        const win = windowList.find((item) => item.id === currentWindowId);
        if (!win) throw new Error('No current window');
        return windowView(win);
      },
      async get(windowId) {
        const win = windowList.find((item) => item.id === windowId);
        if (!win) throw new Error(`No window with id: ${windowId}`);
        return windowView(win);
      },
      async create(options = {}) {
        const win = {
          id: nextWindowId++,
          incognito: options.incognito === true,
          type: 'normal',
          focused: options.focused !== false,
        };
        windowList.push(win);
        const tab = {
          id: nextTabId++,
          windowId: win.id,
          index: 0,
          incognito: win.incognito,
          url: options.url || 'chrome://newtab/',
          title: '',
          pinned: false,
          active: true,
        };
        tabList.push(tab);
        return windowView(win);
      },
      onCreated: createEvent(),
      onRemoved: createEvent(),
    },
    extension: {
      async isAllowedIncognitoAccess() {
        return allowedIncognito;
      },
    },
    history: {
      async search(options = {}) {
        historySearchCalls.push({ ...options });
        const text = typeof options.text === 'string' ? options.text.toLowerCase() : '';
        const startTime = Number.isFinite(options.startTime) ? options.startTime : 0;
        const maxResults = Number.isInteger(options.maxResults) ? options.maxResults : 100;
        return historyItems
          .filter((item) => {
            if (!item || !Number.isFinite(item.lastVisitTime) || item.lastVisitTime < startTime) return false;
            if (!text) return true;
            return (
              String(item.title || '').toLowerCase().includes(text) ||
              String(item.url || '').toLowerCase().includes(text)
            );
          })
          .slice(0, maxResults)
          .map((item) => ({ ...item }));
      },
      onVisited: createEvent(),
      onVisitRemoved: createEvent(),
    },
    webNavigation: {
      onCommitted: createEvent(),
      onHistoryStateUpdated: createEvent(),
      onReferenceFragmentUpdated: createEvent(),
    },
  };

  chrome.__test = {
    get tabs() {
      return tabList.map(tabView);
    },
    get windows() {
      return windowList.map(windowView);
    },
    get historySearchCalls() {
      return historySearchCalls.map((call) => ({ ...call }));
    },
    setHistory(items) {
      historyItems.length = 0;
      for (const item of items) historyItems.push({ ...item });
    },
    setIncognitoAllowed(value) {
      allowedIncognito = value;
    },
    setCurrentWindow(id) {
      currentWindowId = id;
    },
    addWindow(partial = {}) {
      const win = { id: nextWindowId++, incognito: false, type: 'normal', focused: false, ...partial };
      windowList.push(win);
      return windowView(win);
    },
    addTab(partial = {}) {
      const windowId = partial.windowId === undefined ? currentWindowId : partial.windowId;
      const siblings = tabList.filter((tab) => tab.windowId === windowId);
      const tab = {
        id: nextTabId++,
        windowId,
        index: siblings.length,
        incognito: false,
        url: 'https://example.com/',
        title: 'Example',
        pinned: false,
        active: false,
        ...partial,
      };
      tabList.push(tab);
      chrome.tabs.onCreated.emit(tabView(tab));
      return { ...tab };
    },
    updateTab(tabId, changes, changeInfo = null) {
      const tab = tabList.find((item) => item.id === tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      Object.assign(tab, changes);
      const info = changeInfo || changes;
      chrome.tabs.onUpdated.emit(tabId, info, tabView(tab));
      return tabView(tab);
    },
    moveTab(tabId, { windowId, toIndex }) {
      const tab = tabList.find((item) => item.id === tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      tab.windowId = windowId;
      tab.index = toIndex;
      chrome.tabs.onMoved.emit(tabId, { windowId, fromIndex: 0, toIndex });
    },
    attachTab(tabId, { newWindowId, newPosition = 0 }) {
      const tab = tabList.find((item) => item.id === tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      tab.windowId = newWindowId;
      tab.index = newPosition;
      chrome.tabs.onAttached.emit(tabId, { newWindowId, newPosition });
    },
    detachTab(tabId, { oldWindowId, oldPosition = 0 }) {
      chrome.tabs.onDetached.emit(tabId, { oldWindowId, oldPosition });
    },
    replaceTab(addedTabId, removedTabId) {
      chrome.tabs.onReplaced.emit(addedTabId, removedTabId);
    },
    removeTab(tabId, { isWindowClosing = false } = {}) {
      const index = tabList.findIndex((item) => item.id === tabId);
      if (index === -1) throw new Error(`No tab with id: ${tabId}`);
      const [tab] = tabList.splice(index, 1);
      chrome.tabs.onRemoved.emit(tabId, { windowId: tab.windowId, isWindowClosing });
      return tabView(tab);
    },
    closeWindow(windowId) {
      const win = windowList.find((item) => item.id === windowId);
      if (!win) throw new Error(`No window with id: ${windowId}`);
      const closing = tabList.filter((tab) => tab.windowId === windowId);
      for (const tab of closing) {
        tabList.splice(tabList.indexOf(tab), 1);
        chrome.tabs.onRemoved.emit(tab.id, { windowId, isWindowClosing: true });
      }
      windowList.splice(windowList.indexOf(win), 1);
      if (currentWindowId === windowId) currentWindowId = windowList.length > 0 ? windowList[0].id : null;
      return closing.length;
    },
  };

  return chrome;
}
