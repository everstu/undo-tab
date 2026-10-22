import { checkIncognitoAccess } from './restore-service.js';

/**
 * 无痕窗口集合同步。
 *
 * 只有“枚举成功且为空”或“权限已明确撤销”才能结束并清空会话；
 * windows.getAll / 权限查询失败属于未知状态，必须保留现有会话等待重试。
 */
export function createIncognitoWindowSync({
  chromeApi,
  incognitoSession,
  tracker = null,
  logger = console,
}) {
  if (!chromeApi || !incognitoSession) throw new Error('createIncognitoWindowSync 缺少依赖');
  let uncertain = false;

  async function queryWindowIds() {
    try {
      const windows = await chromeApi.windows.getAll({ populate: false });
      const ids = (Array.isArray(windows) ? windows : [])
        .filter((win) => win && win.incognito === true && Number.isInteger(win.id))
        .map((win) => win.id);
      return { ok: true, ids };
    } catch (error) {
      logger.warn('undo-tab: 无痕窗口枚举失败，保留当前会话等待重试');
      return { ok: false, ids: [] };
    }
  }

  async function sync() {
    const access = await checkIncognitoAccess(chromeApi);
    if (!access.ok) {
      uncertain = true;
      const info = await incognitoSession.getInfo().catch(() => ({ active: false }));
      return { active: info.active === true, uncertain: true };
    }

    if (!access.allowed) {
      uncertain = false;
      const result = await incognitoSession.syncWindows([], { accessAllowed: false });
      if (!result.active && tracker) tracker.resetIncognito();
      return { ...result, accessRevoked: true, uncertain: false };
    }

    const query = await queryWindowIds();
    if (!query.ok) {
      uncertain = true;
      const info = await incognitoSession.getInfo().catch(() => ({ active: false }));
      return { active: info.active === true, uncertain: true };
    }

    uncertain = false;
    const result = await incognitoSession.syncWindows(query.ids, { accessAllowed: true });
    if (!result.active && tracker) tracker.resetIncognito();
    return { ...result, uncertain: false };
  }

  /** 消息/标签事件入口：权限撤销或之前枚举失败时重试核对。 */
  async function ensurePermission() {
    if (uncertain) {
      await sync();
      return;
    }
    const context = incognitoSession.peekContext();
    if (!context || !context.active) return;
    const access = await checkIncognitoAccess(chromeApi);
    if (!access.ok) {
      uncertain = true;
      return;
    }
    if (!access.allowed) await sync();
  }

  return {
    sync,
    ensurePermission,
    isUncertain: () => uncertain,
  };
}
