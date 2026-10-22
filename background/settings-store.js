import { STORAGE_KEYS } from '../shared/constants.js';
import { createQueue } from '../shared/queue.js';
import { normalizeSettings, settingsEqual } from '../shared/settings.js';
import { StorageFailureError } from './normal-store.js';

/** 设置读写。所有写入都经过同一个串行队列。 */
export function createSettingsStore({ localArea }) {
  if (!localArea) throw new Error('createSettingsStore 缺少 storage.local');
  const enqueue = createQueue();

  async function readRaw() {
    try {
      const result = await localArea.get(STORAGE_KEYS.settings);
      return result ? result[STORAGE_KEYS.settings] : null;
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  async function write(settings) {
    try {
      await localArea.set({ [STORAGE_KEYS.settings]: settings });
    } catch (error) {
      throw new StorageFailureError(error);
    }
    return settings;
  }

  return {
    get() {
      return enqueue(async () => normalizeSettings(await readRaw()));
    },

    /** 补齐/修正设置字段；已有合法字段原样保留。 */
    ensure() {
      return enqueue(async () => {
        const raw = await readRaw();
        const normalized = normalizeSettings(raw);
        if (!settingsEqual(raw, normalized)) await write(normalized);
        return normalized;
      });
    },

    write(settings) {
      return enqueue(() => write(normalizeSettings(settings)));
    },
  };
}
