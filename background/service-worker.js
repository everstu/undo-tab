import { createUndoTabWorker } from './worker.js';

/**
 * Manifest V3 Service Worker 入口（incognito: spanning）。
 * 监听器在 createUndoTabWorker 内同步注册。
 */
createUndoTabWorker({ chrome });
