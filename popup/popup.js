import {
  DEFAULT_POPUP_WIDTH,
  DEFAULT_SETTINGS,
  MODES,
  MESSAGES,
  PAGE_SIZE,
  STORAGE_KEYS,
  VIEWS,
} from '../shared/constants.js';
import {
  describeClampNotice,
  describeFieldError,
  modeMaxRecords,
  normalizeSettings,
  validateMaxRecords,
  validatePopupWidth,
} from '../shared/settings.js';
import { entrySignature } from '../shared/entries.js';
import { formatRelativeTime } from '../shared/time.js';
import { initialForRecord, recordTitle } from '../shared/urls.js';
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
  quotaWarningText,
  storageUsageText,
  trimConfirmText,
} from './state.js';

const ui = {
  body: document.body,
  search: document.getElementById('search'),
  tabRecent: document.getElementById('tab-recent'),
  tabHistory: document.getElementById('tab-history'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  pageLabel: document.getElementById('page-label'),
  banner: document.getElementById('banner'),
  content: document.getElementById('content'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  counts: document.getElementById('counts'),
  openSettings: document.getElementById('open-settings'),
  listView: document.getElementById('list-view'),
  settingsView: document.getElementById('settings-view'),
  backToList: document.getElementById('back-to-list'),
  maxScopeDesc: document.getElementById('max-scope-desc'),
  maxRecordsLabel: document.getElementById('max-records-label'),
  maxRecords: document.getElementById('max-records'),
  saveMaxRecords: document.getElementById('save-max-records'),
  maxRecordsError: document.getElementById('max-records-error'),
  maxRecordsStatus: document.getElementById('max-records-status'),
  historyLimitBlock: document.getElementById('history-limit-block'),
  historyMaxRecordsLabel: document.getElementById('history-max-records-label'),
  historyMaxRecords: document.getElementById('history-max-records'),
  saveHistoryMaxRecords: document.getElementById('save-history-max-records'),
  historyMaxRecordsError: document.getElementById('history-max-records-error'),
  historyMaxRecordsStatus: document.getElementById('history-max-records-status'),
  trimConfirm: document.getElementById('trim-confirm'),
  trimConfirmText: document.getElementById('trim-confirm-text'),
  trimConfirmYes: document.getElementById('trim-confirm-yes'),
  trimConfirmNo: document.getElementById('trim-confirm-no'),
  popupWidth: document.getElementById('popup-width'),
  savePopupWidth: document.getElementById('save-popup-width'),
  popupWidthError: document.getElementById('popup-width-error'),
  popupWidthStatus: document.getElementById('popup-width-status'),
  resetPopupWidth: document.getElementById('reset-popup-width'),
  incognitoBlock: document.getElementById('incognito-block'),
  incognitoStatus: document.getElementById('incognito-status'),
  incognitoUsage: document.getElementById('incognito-usage'),
  clearIncognitoData: document.getElementById('clear-incognito-data'),
  clearIncognitoConfirm: document.getElementById('clear-incognito-confirm'),
  clearIncognitoYes: document.getElementById('clear-incognito-yes'),
  clearIncognitoNo: document.getElementById('clear-incognito-no'),
  clearIncognitoStatus: document.getElementById('clear-incognito-status'),
  clearViewBlock: document.getElementById('clear-view-block'),
  clearViewDesc: document.getElementById('clear-view-desc'),
  clearView: document.getElementById('clear-view'),
  clearViewConfirm: document.getElementById('clear-view-confirm'),
  clearViewConfirmText: document.getElementById('clear-view-confirm-text'),
  clearViewYes: document.getElementById('clear-view-yes'),
  clearViewNo: document.getElementById('clear-view-no'),
  clearViewStatus: document.getElementById('clear-view-status'),
  manageHistoryBlock: document.getElementById('manage-history-block'),
  manageHistory: document.getElementById('manage-history'),
  manageHistoryStatus: document.getElementById('manage-history-status'),
  dataNote: document.getElementById('data-note'),
};

const state = {
  settings: normalizeSettings(null),
  windowId: null,
  mode: null,
  contextResolved: false,
  contextError: false,
  view: VIEWS.recent,
  query: '',
  page: 1,
  entries: [],
  total: 0,
  matchCount: 0,
  loaded: 0,
  limit: DEFAULT_SETTINGS.normal.maxRecords,
  limitReached: false,
  sessionId: null,
  sessionActive: false,
  topSignature: '',
  pendingCloseCount: 0,
  storage: null,
  storageIssue: null,
  incognitoAllowed: null,
  loading: true,
  loadError: '',
  viewSeq: 0,
  panel: 'list',
  toast: null,
  toastTimer: null,
  searchTimer: null,
  refreshTimer: null,
  busyIds: new Set(),
  feedbackTimers: new Map(),
  pendingMax: null,
  limitRequestSeq: 0,
  statusTimers: new Map(),
};

function sendMessage(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, ...payload })
    .then((response) => {
      if (!response || typeof response !== 'object') {
        return { ok: false, error: { code: 'unknown-error', message: '后台没有响应，请重试' } };
      }
      return response;
    })
    .catch(() => ({ ok: false, error: { code: 'unknown-error', message: '无法连接到扩展后台，请重试' } }));
}

function applySettings(raw) {
  state.settings = normalizeSettings(raw);
  applyPopupWidth(state.settings.popupWidth);
}

function applyPopupWidth(width) {
  const px = Number.isInteger(width) ? width : DEFAULT_POPUP_WIDTH;
  document.documentElement.style.setProperty('--popup-width', `${px}px`);
}

function currentMax(view = state.view) {
  return modeMaxRecords(state.settings, state.mode, view);
}

function applyContext(data) {
  if (data.mode === MODES.incognito || data.mode === MODES.normal) state.mode = data.mode;
  applySettings(data.settings);
  state.incognitoAllowed = data.incognitoAllowed === true;
  const session = data.session || {};
  state.sessionId = typeof session.sessionId === 'string' ? session.sessionId : null;
  state.sessionActive = session.active === true;
  state.pendingCloseCount = Number.isInteger(data.pendingCloseCount) ? data.pendingCloseCount : 0;
  state.storage = data.storage && typeof data.storage === 'object' ? data.storage : null;
  state.storageIssue = state.storage ? state.storage.issue || null : null;
  state.contextResolved = true;
  state.contextError = false;
}

function applyView(data) {
  state.entries = Array.isArray(data.entries) ? data.entries : [];
  state.total = Number.isInteger(data.total) ? data.total : 0;
  state.matchCount = Number.isInteger(data.matchCount) ? data.matchCount : state.entries.length;
  state.loaded = Number.isInteger(data.loaded) ? data.loaded : state.entries.length;
  state.limit = Number.isInteger(data.limit) ? data.limit : currentMax();
  state.limitReached = data.limitReached === true;
  state.sessionActive = data.sessionActive === true;
  state.sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  state.topSignature = typeof data.topSignature === 'string' ? data.topSignature : '';
  state.pendingCloseCount = Number.isInteger(data.pendingCloseCount)
    ? data.pendingCloseCount
    : state.pendingCloseCount;
  if (Object.prototype.hasOwnProperty.call(data, 'storageIssue')) state.storageIssue = data.storageIssue || null;
}

async function getWindowContext() {
  try {
    const win = await chrome.windows.getCurrent();
    if (!win || !Number.isInteger(win.id)) return null;
    return { windowId: win.id, incognito: win.incognito === true };
  } catch (error) {
    return null;
  }
}

async function loadContext() {
  if (!Number.isInteger(state.windowId)) return false;
  const response = await sendMessage(MESSAGES.getContext, { windowId: state.windowId });
  if (!response.ok) {
    if (response.error?.code === 'context-lost') {
      state.contextError = true;
      return false;
    }
    state.loadError = response.error?.message || '加载失败，请重试';
    return false;
  }
  applyContext(response.data);
  return true;
}

async function loadView({ resetPage = false } = {}) {
  if (!Number.isInteger(state.windowId) || state.contextError) return;
  if (resetPage) state.page = 1;
  const seq = ++state.viewSeq;
  state.loading = true;
  state.loadError = '';
  render();
  const response = await sendMessage(MESSAGES.queryView, {
    windowId: state.windowId,
    view: state.view,
    query: state.query,
  });
  if (seq !== state.viewSeq) return;
  state.loading = false;
  if (!response.ok) {
    if (response.error?.code === 'context-lost') {
      state.contextError = true;
    } else if (response.error?.code === 'session-ended') {
      state.sessionActive = false;
      state.entries = [];
    } else {
      state.loadError = response.error?.message || '加载失败，请重试';
    }
    render();
    return;
  }
  if (response.data.mode !== state.mode) {
    await retryBoot();
    return;
  }
  if (
    state.mode === MODES.incognito &&
    state.sessionId &&
    response.data.sessionId &&
    response.data.sessionId !== state.sessionId
  ) {
    await refreshAll();
    return;
  }
  applyView(response.data);
  render();
}

async function refreshAll() {
  if (!Number.isInteger(state.windowId) || state.contextError) {
    await retryBoot();
    return;
  }
  const ok = await loadContext();
  if (ok) await loadView();
  else render();
}

async function retryBoot() {
  state.contextError = false;
  state.loadError = '';
  const win = await getWindowContext();
  if (!win) {
    state.contextError = true;
    render();
    return;
  }
  state.windowId = win.windowId;
  const ok = await loadContext();
  if (ok) await loadView();
  else render();
}

/* ---------------- favicon ---------------- */

function faviconSource(pageUrl) {
  const params = new URLSearchParams({ pageUrl, size: '32' });
  return `${chrome.runtime.getURL('_favicon/')}?${params.toString()}`;
}

const FAVICON_FALLBACK_PROBE = 'https://undo-tab.invalid/';
const faviconCache = new Map();
let defaultFaviconPromise = null;

function getDefaultFaviconBytes() {
  if (!defaultFaviconPromise) {
    defaultFaviconPromise = fetch(faviconSource(FAVICON_FALLBACK_PROBE))
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((buffer) => (buffer ? new Uint8Array(buffer) : null))
      .catch(() => null);
  }
  return defaultFaviconPromise;
}

function bytesEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesToPngDataUrl(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

async function resolveFavicon(entry) {
  if (entry.hasFavicon !== true) return null;
  if (faviconCache.has(entry.url)) return faviconCache.get(entry.url);
  let dataUrl = null;
  try {
    const [defaultBytes, response] = await Promise.all([
      getDefaultFaviconBytes(),
      fetch(faviconSource(entry.url)),
    ]);
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const isPng =
        bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      if (isPng && !bytesEqual(bytes, defaultBytes)) dataUrl = bytesToPngDataUrl(bytes);
    }
  } catch (error) {
    dataUrl = null;
  }
  if (faviconCache.size > 500) faviconCache.clear();
  faviconCache.set(entry.url, dataUrl);
  return dataUrl;
}

/* ---------------- 列表 ---------------- */

function entryTime(entry) {
  return state.view === VIEWS.history ? entry.lastVisitedAt : entry.closedAt;
}

function absoluteTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderRow(entry) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = entry.id;

  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.setAttribute('aria-hidden', 'true');
  const letter = document.createElement('span');
  letter.className = 'row-icon-letter';
  letter.textContent = initialForRecord(entry);
  icon.append(letter);
  if (entry.hasFavicon === true) {
    void resolveFavicon(entry).then((dataUrl) => {
      if (!dataUrl) return;
      const image = document.createElement('img');
      image.className = 'row-icon-img';
      image.alt = '';
      image.decoding = 'async';
      image.src = dataUrl;
      image.addEventListener('load', () => icon.classList.add('has-image'));
      image.addEventListener('error', () => image.remove());
      icon.append(image);
    });
  }

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-main';
  main.dataset.action = 'open';
  main.dataset.id = entry.id;
  main.dataset.url = entry.url;
  const title = recordTitle(entry);
  main.title = `${title}\n${entry.url}`;
  main.setAttribute('aria-label', `打开 ${title}`);

  const titleEl = document.createElement('span');
  titleEl.className = 'row-title';
  titleEl.textContent = title;
  const urlEl = document.createElement('span');
  urlEl.className = 'row-url';
  urlEl.textContent = entry.url;
  main.append(titleEl, urlEl);

  const meta = document.createElement('span');
  meta.className = 'row-meta';
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = formatRelativeTime(entryTime(entry));
  time.title = absoluteTime(entryTime(entry));
  meta.append(time);
  if (state.view === VIEWS.history && Number.isInteger(entry.visitCount) && entry.visitCount > 1) {
    const visits = document.createElement('span');
    visits.className = 'row-extra';
    visits.textContent = `访问 ${entry.visitCount} 次`;
    visits.title = `访问 ${entry.visitCount} 次`;
    meta.append(visits);
  }
  const feedback = document.createElement('span');
  feedback.className = 'row-feedback';
  meta.append(feedback);

  row.append(icon, main, meta);
  if (canDelete(state.mode, state.view)) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-delete';
    remove.dataset.action = 'delete';
    remove.dataset.id = entry.id;
    remove.title = '删除这条记录';
    remove.setAttribute('aria-label', `删除 ${title}`);
    remove.textContent = '×';
    row.append(remove);
  }
  if (state.busyIds.has(entry.id)) setRowBusy(row, true);
  return row;
}

function setRowBusy(row, busy) {
  row.classList.toggle('is-busy', busy);
  for (const button of row.querySelectorAll('button')) button.disabled = busy;
}

function findRow(id) {
  return ui.list.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
}

function showRowFeedbackById(id, text, tone, duration = 3600) {
  const row = findRow(id);
  if (!row) return;
  const meta = row.querySelector('.row-meta');
  const feedback = row.querySelector('.row-feedback');
  if (!meta || !feedback) return;
  window.clearTimeout(state.feedbackTimers.get(id));
  feedback.textContent = text;
  feedback.title = text;
  feedback.className = `row-feedback tone-${tone}`;
  meta.classList.add('has-feedback');
  const timer = window.setTimeout(() => {
    meta.classList.remove('has-feedback');
    feedback.textContent = '';
    state.feedbackTimers.delete(id);
  }, duration);
  state.feedbackTimers.set(id, timer);
}

/* ---------------- 提示与渲染 ---------------- */

function setToast(text, tone = 'info') {
  window.clearTimeout(state.toastTimer);
  state.toast = { text, tone };
  state.toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
}

function currentBanner() {
  if (state.contextError) {
    return { tone: 'error', text: '窗口已关闭或无法识别，请重新打开弹窗', action: 'reboot' };
  }
  if (state.loadError) {
    return { tone: 'error', text: state.loadError, action: 'retry' };
  }
  if (state.mode === MODES.incognito && !state.sessionActive) {
    return { tone: 'info', text: '本次无痕会话已结束，记录已清空' };
  }
  if (state.mode === MODES.incognito && state.storageIssue === 'quota') {
    return {
      tone: 'error',
      text: '无痕临时存储空间已满，新记录暂存在内存中，扩展休眠后可能丢失。可在设置中下调上限或清空本次记录。',
    };
  }
  if (state.pendingCloseCount > 0) {
    return {
      tone: 'error',
      text: `有 ${state.pendingCloseCount} 条最近关闭记录尚未保存，正在重试。请检查浏览器存储空间。`,
    };
  }
  if (state.toast) return { tone: state.toast.tone, text: state.toast.text };
  return null;
}

function renderBanner() {
  const banner = currentBanner();
  ui.banner.textContent = '';
  if (!banner) {
    ui.banner.hidden = true;
    ui.banner.className = 'banner';
    return;
  }
  ui.banner.hidden = false;
  ui.banner.className = `banner is-${banner.tone}`;
  const text = document.createElement('span');
  text.className = 'banner-text';
  text.textContent = banner.text;
  ui.banner.append(text);
  if (banner.action === 'retry' || banner.action === 'reboot') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'banner-action';
    action.textContent = '重试';
    action.addEventListener('click', () => {
      if (banner.action === 'reboot') void retryBoot();
      else void refreshAll();
    });
    ui.banner.append(action);
  }
}

function renderList(view) {
  ui.list.textContent = '';
  const text = view.items.length === 0
    ? (state.contextError || state.loadError
        ? ''
        : emptyText({
            mode: state.mode,
            view: state.view,
            query: state.query,
            sessionActive: state.sessionActive,
            loading: state.loading,
          }))
    : '';
  ui.empty.hidden = text === '';
  ui.empty.textContent = text;
  if (view.items.length === 0) return;
  const fragment = document.createDocumentFragment();
  for (const entry of view.items) fragment.append(renderRow(entry));
  ui.list.append(fragment);
}

function render() {
  ui.tabRecent.setAttribute('aria-selected', String(state.view === VIEWS.recent));
  ui.tabHistory.setAttribute('aria-selected', String(state.view === VIEWS.history));

  const view = paginate(state.entries, state.page, PAGE_SIZE);
  state.page = view.page;
  ui.prevPage.disabled = !view.canPrev;
  ui.nextPage.disabled = !view.canNext;
  ui.pageLabel.textContent = state.contextError ? '0/0' : view.pageLabel;
  ui.counts.textContent = state.contextError
    ? ''
    : footerText({
        mode: state.mode,
        view: state.view,
        query: state.query,
        total: state.total,
        matchCount: state.matchCount,
        loaded: state.loaded,
        limit: state.limit,
      });

  renderBanner();
  renderList(view);
  syncSettingsFields();
  syncSettingsSections();
}

/* ---------------- 设置 ---------------- */

function showPanel(panel) {
  state.panel = panel;
  ui.listView.hidden = panel !== 'list';
  ui.settingsView.hidden = panel !== 'settings';
  if (panel === 'settings') syncSettingsFields({ force: true });
}

function openSettings() {
  state.pendingMax = null;
  state.limitRequestSeq += 1;
  ui.trimConfirm.hidden = true;
  ui.clearViewConfirm.hidden = true;
  ui.clearIncognitoConfirm.hidden = true;
  ui.clearView.hidden = false;
  ui.clearIncognitoData.hidden = false;
  clearFieldError(ui.maxRecordsError, ui.maxRecords);
  clearFieldError(ui.historyMaxRecordsError, ui.historyMaxRecords);
  clearFieldError(ui.popupWidthError, ui.popupWidth);
  clearStatus(ui.clearViewStatus);
  clearStatus(ui.clearIncognitoStatus);
  clearStatus(ui.manageHistoryStatus);
  showPanel('settings');
  syncSettingsFields({ force: true });
}

function syncSettingsFields({ force = false } = {}) {
  if (force || document.activeElement !== ui.maxRecords) ui.maxRecords.value = String(currentMax(VIEWS.recent));
  if (force || document.activeElement !== ui.historyMaxRecords) {
    ui.historyMaxRecords.value = String(currentMax(VIEWS.history));
  }
  if (force || document.activeElement !== ui.popupWidth) {
    ui.popupWidth.value = String(state.settings.popupWidth);
  }
  ui.maxScopeDesc.textContent = maxScopeText(state.mode);
  ui.maxRecordsLabel.textContent = maxLabel(state.mode);
  ui.historyMaxRecordsLabel.textContent = state.mode === MODES.incognito
    ? '历史记录最多保留多少条'
    : '历史记录最多展示多少条';
  ui.dataNote.textContent = dataNote(state.mode);
  ui.incognitoStatus.textContent = state.sessionActive
    ? '本次无痕会话有效；关闭最后一个无痕窗口后，最近关闭与访问历史会自动清空。'
    : '本次无痕会话已结束，没有可读取的无痕记录。';
  ui.clearIncognitoData.disabled = !state.sessionActive;
  const showUsage = state.mode === MODES.incognito && state.sessionActive && state.storage !== null;
  ui.incognitoUsage.hidden = !showUsage;
  ui.incognitoUsage.textContent = showUsage ? storageUsageText(state.storage) : '';
}

function syncSettingsSections() {
  const incognito = state.mode === MODES.incognito;
  ui.incognitoBlock.hidden = !incognito;
  ui.historyLimitBlock.hidden = false;
  const clearable = canClear(state.mode, state.view);
  ui.clearViewBlock.hidden = !clearable;
  if (clearable) {
    ui.clearView.textContent = clearScopeText(state.mode, state.view);
    ui.clearViewDesc.textContent = state.view === VIEWS.recent
      ? (incognito
          ? '只清空本次无痕会话的最近关闭，不影响访问历史；普通数据不受影响。'
          : '只清空普通最近关闭，不影响 Chrome 历史，也不影响无痕数据。')
      : '只清空本次无痕会话的访问历史，不影响最近关闭。';
    ui.clearViewConfirmText.textContent = clearConfirmText(state.mode, state.view);
  }
  ui.manageHistoryBlock.hidden = state.mode !== MODES.normal || state.view !== VIEWS.history;
}

/** notice 用于“越界输入已按边界值保存”，以提醒色显示并停留更久。 */
function showStatus(element, text, { notice = false } = {}) {
  // 每个状态元素独立计时，避免后一个提示取消前一个的自动隐藏。
  window.clearTimeout(state.statusTimers.get(element));
  element.textContent = text;
  element.classList.toggle('is-notice', notice);
  element.hidden = false;
  state.statusTimers.set(element, window.setTimeout(() => {
    state.statusTimers.delete(element);
    element.hidden = true;
    element.textContent = '';
    element.classList.remove('is-notice');
  }, notice ? 6000 : 3200));
}

function clearStatus(element) {
  window.clearTimeout(state.statusTimers.get(element));
  state.statusTimers.delete(element);
  element.hidden = true;
  element.textContent = '';
  element.classList.remove('is-notice');
}

function showFieldError(element, input, text) {
  element.textContent = text;
  element.hidden = false;
  input.classList.add('is-invalid');
}

function clearFieldError(element, input) {
  element.hidden = true;
  element.textContent = '';
  input.classList.remove('is-invalid');
}

function limitControls(view) {
  return view === VIEWS.history
    ? { input: ui.historyMaxRecords, error: ui.historyMaxRecordsError, status: ui.historyMaxRecordsStatus }
    : { input: ui.maxRecords, error: ui.maxRecordsError, status: ui.maxRecordsStatus };
}

async function saveMaxRecords(view = VIEWS.recent) {
  const controls = limitControls(view);
  const seq = ++state.limitRequestSeq;
  state.pendingMax = null;
  ui.trimConfirm.hidden = true;
  clearFieldError(controls.error, controls.input);
  clearStatus(controls.status);
  const validation = validateMaxRecords(controls.input.value);
  if (!validation.ok) {
    showFieldError(controls.error, controls.input, describeFieldError(`${state.mode}.maxRecords`, validation.reason));
    return;
  }
  // 越界整数收紧到 10/1000：输入框显示实际将保存的值，保存后提示。
  const clamped = validation.clamped || null;
  if (clamped) controls.input.value = String(validation.value);
  const previewResponse = await sendMessage(MESSAGES.getTrimPreview, {
    windowId: state.windowId,
    view,
    maxRecords: validation.value,
  });
  if (seq !== state.limitRequestSeq) return;
  if (!previewResponse.ok) {
    showFieldError(controls.error, controls.input, previewResponse.error?.message || '保存失败，请重试');
    return;
  }
  const preview = previewResponse.data;
  const trimming = preview.recent > 0 || preview.history > 0;
  if (trimming || preview.quotaWarning) {
    state.pendingMax = { view, value: validation.value, clamped };
    const parts = [];
    if (clamped) parts.push(`${describeClampNotice('maxRecords', clamped, { pending: true })}。`);
    if (trimming) {
      parts.push(trimConfirmText({
        mode: state.mode,
        view,
        recent: preview.recent,
        history: preview.history,
        limit: validation.value,
      }));
    }
    if (preview.quotaWarning) parts.push(quotaWarningText(preview.quotaWarning));
    ui.trimConfirmText.textContent = parts.join(' ');
    ui.trimConfirm.hidden = false;
    return;
  }
  await commitMaxRecords(validation.value, view, clamped);
}

async function commitMaxRecords(value, view, clamped = null) {
  const controls = limitControls(view);
  ui.trimConfirm.hidden = true;
  state.pendingMax = null;
  const response = await sendMessage(MESSAGES.updateSettings, {
    windowId: state.windowId,
    view,
    patch: { maxRecords: value },
  });
  if (!response.ok) {
    showFieldError(controls.error, controls.input, response.error?.message || '保存失败，请重试');
    return;
  }
  applySettings(response.data.settings);
  const trimmed = response.data.trimmed || {};
  const parts = [];
  if (trimmed.recent > 0) parts.push(`最近关闭 ${trimmed.recent} 条`);
  if (trimmed.history > 0) parts.push(`访问历史 ${trimmed.history} 条`);
  const removedText = parts.length > 0 ? `删除了${parts.join('、')}` : '';
  if (clamped) {
    const notice = describeClampNotice('maxRecords', clamped);
    showStatus(controls.status, removedText ? `${notice}，${removedText}` : notice, { notice: true });
  } else {
    showStatus(controls.status, removedText ? `已保存，${removedText}` : '已保存');
  }
  await loadContext();
  await loadView();
}

async function savePopupWidth() {
  clearFieldError(ui.popupWidthError, ui.popupWidth);
  clearStatus(ui.popupWidthStatus);
  const validation = validatePopupWidth(ui.popupWidth.value);
  if (!validation.ok) {
    showFieldError(ui.popupWidthError, ui.popupWidth, describeFieldError('popupWidth', validation.reason));
    return;
  }
  // 越界整数收紧到 360/800 后保存并提示。
  if (validation.clamped) ui.popupWidth.value = String(validation.value);
  const response = await sendMessage(MESSAGES.updateSettings, {
    windowId: state.windowId,
    patch: { popupWidth: validation.value },
  });
  if (!response.ok) {
    showFieldError(ui.popupWidthError, ui.popupWidth, response.error?.message || '保存失败，请重试');
    return;
  }
  applySettings(response.data.settings);
  ui.popupWidth.value = String(state.settings.popupWidth);
  if (validation.clamped) {
    showStatus(ui.popupWidthStatus, describeClampNotice('popupWidth', validation.clamped), { notice: true });
  } else {
    showStatus(ui.popupWidthStatus, `已保存 ${state.settings.popupWidth}px`);
  }
  render();
}

async function resetPopupWidth() {
  clearFieldError(ui.popupWidthError, ui.popupWidth);
  const response = await sendMessage(MESSAGES.updateSettings, {
    windowId: state.windowId,
    patch: { popupWidth: DEFAULT_POPUP_WIDTH },
  });
  if (!response.ok) {
    showFieldError(ui.popupWidthError, ui.popupWidth, response.error?.message || '保存失败，请重试');
    return;
  }
  applySettings(response.data.settings);
  ui.popupWidth.value = String(state.settings.popupWidth);
  showStatus(ui.popupWidthStatus, `已恢复默认宽度 ${DEFAULT_POPUP_WIDTH}px`);
  render();
}

async function clearCurrentView() {
  clearStatus(ui.clearViewStatus);
  const response = await sendMessage(MESSAGES.clearView, {
    windowId: state.windowId,
    view: state.view,
    confirm: true,
  });
  if (!response.ok) {
    ui.clearViewStatus.className = 'field-error';
    ui.clearViewStatus.textContent = response.error?.message || '清空失败，请重试';
    ui.clearViewStatus.hidden = false;
    return;
  }
  ui.clearViewConfirm.hidden = true;
  ui.clearView.hidden = false;
  showStatus(ui.clearViewStatus, `已清空 ${response.data.removed} 条`);
  ui.clearViewStatus.className = 'status-text';
  await loadContext();
  await loadView();
}

async function clearIncognitoSession() {
  clearStatus(ui.clearIncognitoStatus);
  const response = await sendMessage(MESSAGES.clearIncognitoData, {
    windowId: state.windowId,
    confirm: true,
  });
  if (!response.ok) {
    ui.clearIncognitoStatus.textContent = response.error?.message || '清空失败，请重试';
    ui.clearIncognitoStatus.hidden = false;
    return;
  }
  ui.clearIncognitoConfirm.hidden = true;
  ui.clearIncognitoData.hidden = false;
  showStatus(ui.clearIncognitoStatus, `已清空 ${response.data.removed} 条本次记录`);
  ui.clearIncognitoStatus.className = 'status-text';
  await loadContext();
  await loadView();
}

async function openChromeHistory() {
  clearStatus(ui.manageHistoryStatus);
  try {
    await chrome.tabs.create({ url: 'chrome://history/' });
  } catch (error) {
    ui.manageHistoryStatus.textContent = '无法自动打开，请在地址栏访问 chrome://history';
    ui.manageHistoryStatus.hidden = false;
  }
}

/* ---------------- 行操作 ---------------- */

async function openEntry(entry) {
  if (state.busyIds.has(entry.id)) return;
  state.busyIds.add(entry.id);
  const row = findRow(entry.id);
  if (row) setRowBusy(row, true);
  const payload = { windowId: state.windowId, view: state.view, id: entry.id };
  if (state.mode === MODES.normal && state.view === VIEWS.history) {
    delete payload.id;
    payload.url = entry.url;
  }
  const response = await sendMessage(MESSAGES.openEntry, payload);
  state.busyIds.delete(entry.id);
  if (row) setRowBusy(row, false);
  if (response.ok) {
    showRowFeedbackById(entry.id, '已打开', 'success');
    return;
  }
  if (response.error?.code === 'session-ended') {
    await refreshAll();
    return;
  }
  showRowFeedbackById(entry.id, response.error?.message || '打开失败，请重试', 'error', 5200);
}

async function deleteEntry(entry) {
  if (state.busyIds.has(entry.id)) return;
  state.busyIds.add(entry.id);
  const row = findRow(entry.id);
  if (row) setRowBusy(row, true);
  const response = await sendMessage(MESSAGES.deleteEntry, {
    windowId: state.windowId,
    view: state.view,
    id: entry.id,
  });
  state.busyIds.delete(entry.id);
  if (!response.ok) {
    if (row) setRowBusy(row, false);
    if (response.error?.code === 'session-ended') {
      await refreshAll();
      return;
    }
    showRowFeedbackById(entry.id, response.error?.message || '删除失败，请重试', 'error', 5200);
    return;
  }
  setToast('已删除 1 条记录');
  await loadView();
}

/* ---------------- 事件绑定 ---------------- */

ui.search.addEventListener('input', () => {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    state.query = ui.search.value;
    state.page = 1;
    void loadView({ resetPage: true });
    ui.content.scrollTop = 0;
  }, 220);
});

ui.tabRecent.addEventListener('click', () => {
  if (state.view === VIEWS.recent) return;
  state.view = VIEWS.recent;
  state.page = 1;
  void loadView({ resetPage: true });
  ui.content.scrollTop = 0;
});

ui.tabHistory.addEventListener('click', () => {
  if (state.view === VIEWS.history) return;
  state.view = VIEWS.history;
  state.page = 1;
  void loadView({ resetPage: true });
  ui.content.scrollTop = 0;
});

ui.prevPage.addEventListener('click', () => {
  if (state.page <= 1) return;
  state.page -= 1;
  render();
  ui.content.scrollTop = 0;
});

ui.nextPage.addEventListener('click', () => {
  const view = paginate(state.entries, state.page, PAGE_SIZE);
  if (!view.canNext) return;
  state.page += 1;
  render();
  ui.content.scrollTop = 0;
});

ui.list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  if (button.dataset.action === 'open') void openEntry(entry);
  else if (button.dataset.action === 'delete') void deleteEntry(entry);
});

ui.openSettings.addEventListener('click', openSettings);
ui.backToList.addEventListener('click', () => {
  showPanel('list');
  render();
});

for (const view of [VIEWS.recent, VIEWS.history]) {
  const controls = limitControls(view);
  controls.input.addEventListener('input', () => {
    state.limitRequestSeq += 1;
    state.pendingMax = null;
    ui.trimConfirm.hidden = true;
    clearFieldError(controls.error, controls.input);
  });
}

ui.saveMaxRecords.addEventListener('click', () => void saveMaxRecords());
ui.saveHistoryMaxRecords.addEventListener('click', () => void saveMaxRecords(VIEWS.history));
ui.trimConfirmYes.addEventListener('click', () => {
  if (state.pendingMax === null) return;
  const { value, view, clamped } = state.pendingMax;
  void commitMaxRecords(value, view, clamped);
});
ui.trimConfirmNo.addEventListener('click', () => {
  const view = state.pendingMax?.view || VIEWS.recent;
  const controls = limitControls(view);
  state.pendingMax = null;
  ui.trimConfirm.hidden = true;
  controls.input.value = String(currentMax(view));
  clearFieldError(controls.error, controls.input);
});

ui.popupWidth.addEventListener('input', () => clearFieldError(ui.popupWidthError, ui.popupWidth));
ui.savePopupWidth.addEventListener('click', () => void savePopupWidth());
ui.resetPopupWidth.addEventListener('click', () => void resetPopupWidth());

ui.clearView.addEventListener('click', () => {
  clearStatus(ui.clearViewStatus);
  ui.clearViewConfirm.hidden = false;
  ui.clearView.hidden = true;
});
ui.clearViewNo.addEventListener('click', () => {
  ui.clearViewConfirm.hidden = true;
  ui.clearView.hidden = false;
});
ui.clearViewYes.addEventListener('click', () => void clearCurrentView());

ui.clearIncognitoData.addEventListener('click', () => {
  clearStatus(ui.clearIncognitoStatus);
  ui.clearIncognitoConfirm.hidden = false;
  ui.clearIncognitoData.hidden = true;
});
ui.clearIncognitoNo.addEventListener('click', () => {
  ui.clearIncognitoConfirm.hidden = true;
  ui.clearIncognitoData.hidden = false;
});
ui.clearIncognitoYes.addEventListener('click', () => void clearIncognitoSession());

ui.manageHistory.addEventListener('click', () => void openChromeHistory());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.panel === 'settings') {
    showPanel('list');
    render();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.settings && changes.settings.newValue) {
      applySettings(changes.settings.newValue);
      scheduleRefresh();
    }
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.normalRecent) && state.mode === MODES.normal) {
      scheduleRefresh();
    }
    return;
  }
  if (areaName !== 'session' || state.mode !== MODES.incognito) return;
  const metaChange = changes[STORAGE_KEYS.incognitoMeta];
  if (metaChange) {
    const meta = metaChange.newValue;
    if (!meta || meta.status !== 'active' || meta.sessionId !== state.sessionId) {
      scheduleRefresh();
      return;
    }
  }
  const listKey = state.view === VIEWS.history ? STORAGE_KEYS.incognitoHistory : STORAGE_KEYS.incognitoRecent;
  if (!Object.prototype.hasOwnProperty.call(changes, listKey)) return;
  const raw = changes[listKey].newValue;
  const list = Array.isArray(raw) ? raw : [];
  const length = list.length;
  const signature = entrySignature(list[0]);
  if (length !== state.total || signature !== state.topSignature) scheduleRefresh();
});

function scheduleRefresh() {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => void refreshAll(), 180);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  const win = await getWindowContext();
  if (!win) {
    state.contextError = true;
    document.body.classList.remove('booting');
    render();
    return;
  }
  state.windowId = win.windowId;
  const ok = await loadContext();
  document.body.classList.remove('booting');
  render();
  if (!ok) return;
  await loadView();
  ui.search.focus();
}

void boot();
