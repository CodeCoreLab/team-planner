/* ============================================================
 * core/bus.js —— 事件总线
 *
 * 为什么需要：
 *   UI 各页面直接调 store 会形成网状依赖（11 个页面 × 12 个 store 模块），
 *   改一处容易漏改。用事件解耦后：
 *     页面 → 发布「数据已变更」 → 订阅者各自刷新
 *   新增页面不需要修改 store，新增 store 也不需要修改页面。
 *
 * 额外能力：
 *   - 通配订阅（'*'）用于审计日志
 *   - 一次性订阅（once）
 *   - 错误隔离：某个订阅者抛错不影响其他订阅者
 * ============================================================ */

(function () {
  'use strict';

  const map = new Map(); // event -> Set<{fn, once}>
  const Wild = '*';

  function on(event, fn) {
    if (typeof fn !== 'function') throw new Error('订阅回调必须是函数');
    if (!map.has(event)) map.set(event, new Set());
    const rec = { fn, once: false };
    map.get(event).add(rec);
    return function off() {
      const s = map.get(event);
      if (s) s.delete(rec);
    };
  }

  function once(event, fn) {
    if (!map.has(event)) map.set(event, new Set());
    const rec = { fn, once: true };
    map.get(event).add(rec);
    return function off() {
      const s = map.get(event);
      if (s) s.delete(rec);
    };
  }

  function off(event, fn) {
    const s = map.get(event);
    if (!s) return;
    if (!fn) { s.clear(); return; }
    for (const rec of s) {
      if (rec.fn === fn) s.delete(rec);
    }
  }

  function emit(event, payload) {
    const run = (set, evtName) => {
      if (!set) return;
      // 复制一份再遍历：允许回调里取消订阅而不影响本轮
      for (const rec of Array.from(set)) {
        try {
          rec.fn(payload, evtName);
        } catch (e) {
          // 订阅者自己的错不能影响其他订阅者，也不能中断发布方
          if (window.Errors) {
            window.Errors.Log.error('bus', '订阅者异常 @' + evtName + '：' + (e && e.message), {
              stack: String((e && e.stack) || '').slice(0, 500),
            });
          } else {
            console.error('[bus]', evtName, e);
          }
        }
        if (rec.once) {
          const s = map.get(evtName);
          if (s) s.delete(rec);
        }
      }
    };

    run(map.get(event), event);
    run(map.get(Wild), event);
  }

  /** 事件名集中登记，避免各处手写字符串拼错 */
  const EVENTS = {
    // 数据变更
    DATA_CHANGED: 'data:changed',        // { entity, action, id }
    TASK_CHANGED: 'task:changed',
    PLAN_CHANGED: 'plan:changed',
    LOG_CHANGED: 'log:changed',
    USER_CHANGED: 'user:changed',
    SETTINGS_CHANGED: 'settings:changed',
    // 界面
    ROUTE_CHANGED: 'ui:route',
    THEME_CHANGED: 'ui:theme',
    DIRTY_CHANGED: 'ui:dirty',           // { dirty: boolean }
    // 文件
    FILE_CONNECTED: 'file:connected',    // { name }
    FILE_SAVED: 'file:saved',            // { file, counts }
    FILE_ERROR: 'file:error',            // { message }
    FILE_IMPORTED: 'file:imported',      // { counts }
    // 系统
    NET_ONLINE: 'sys:online',
    NET_OFFLINE: 'sys:offline',
    FATAL: 'sys:fatal',
    QUOTA_WARN: 'sys:quota',
  };

  window.Bus = { on, once, off, emit, EVENTS, Wild };
})();
