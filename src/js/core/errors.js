/* ============================================================
 * core/errors.js —— 统一错误体系
 *
 * 为什么需要它：
 *   纯前端没有服务端兜底，一个未捕获的异常就会让界面停在半渲染状态，
 *   用户看到的是"点一下没反应"或白屏，且没有日志可查。
 *   这里把错误分成"可预期的业务错误"和"不可预期的程序错误"两类，
 *   前者用友好文案提示，后者记录堆栈并给用户可复制的诊断信息。
 *
 * 约定：
 *   - 业务校验失败 → throw new AppError('...')，UI 直接显示 message
 *   - 程序 BUG     → 任意其他 Error，会被 ErrorBoundary 兜住并记录
 * ============================================================ */

(function () {
  'use strict';

  /** 可预期的业务错误（文案可直接给用户看） */
  class AppError extends Error {
    constructor(message, code, detail) {
      super(message);
      this.name = 'AppError';
      this.code = code || 'E_BIZ';
      this.detail = detail || null;
      /** 标记：UI 层不需要上报堆栈 */
      this.expected = true;
    }
  }

  /** 数据校验错误 */
  class ValidationError extends AppError {
    constructor(message, field) {
      super(message, 'E_VALIDATION');
      this.name = 'ValidationError';
      this.field = field || null;
    }
  }

  /** 存储层错误（IndexedDB 失败、配额满、事务中止） */
  class StorageError extends AppError {
    constructor(message, cause) {
      super(message, 'E_STORAGE');
      this.name = 'StorageError';
      this.cause = cause || null;
    }
  }

  /**
   * 把任意抛出物归一化
   *
   * 真实世界里 throw 出来的可能是 Error、字符串、甚至 undefined
   * （第三方库、事件回调常见）。统一包一层，避免后续 e.message 报错。
   */
  function normalize(e) {
    if (e instanceof AppError) return e;
    if (e instanceof Error) return e;
    if (typeof e === 'string') return new Error(e);
    try {
      return new Error('未知错误：' + JSON.stringify(e));
    } catch (_) {
      return new Error('未知错误（无法序列化）');
    }
  }

  /** 给用户看的文案：业务错误照原样，程序错误加统一前缀 */
  function userMessage(e) {
    const err = normalize(e);
    if (err.expected) return err.message;
    return '操作失败，请重试。如果反复出现，请点右上角「诊断」复制日志。';
  }

  /* ------------------------------------------------------------
   * 日志环形缓冲
   *
   * 保留最近 300 条到内存 + localStorage，用于：
   *   - 用户点「诊断」时导出
   *   - 崩溃后重开页面仍能查到上次的线索
   * ------------------------------------------------------------ */
  const LOG_KEY = 'tp.logs.v1';
  const MAX_LOGS = 300;
  let ring = [];
  let ringLoaded = false;

  function loadRing() {
    if (ringLoaded) return;
    ringLoaded = true;
    try {
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) ring = arr.slice(-MAX_LOGS);
      }
    } catch (_) { /* 隐私模式或配额满，忽略 */ }
  }

  function persistRing() {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(ring.slice(-MAX_LOGS)));
    } catch (_) { /* 忽略 */ }
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function log(level, tag, msg, extra) {
    loadRing();
    const entry = { t: stamp(), level, tag, msg: String(msg).slice(0, 500) };
    if (extra !== undefined) {
      try {
        entry.extra = JSON.parse(JSON.stringify(extra));
      } catch (_) {
        entry.extra = '（无法序列化）';
      }
    }
    ring.push(entry);
    if (ring.length > MAX_LOGS) ring = ring.slice(-MAX_LOGS);
    persistRing();

    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn('[%s] %s %s', tag, entry.t, entry.msg);
    return entry;
  }

  const Log = {
    debug: (tag, msg, extra) => log('debug', tag, msg, extra),
    info: (tag, msg, extra) => log('info', tag, msg, extra),
    warn: (tag, msg, extra) => log('warn', tag, msg, extra),
    error: (tag, msg, extra) => log('error', tag, msg, extra),
    all() { loadRing(); return ring.slice(); },
    toText() {
      loadRing();
      return ring.map(e =>
        `${e.t} [${e.level}] ${e.tag} ${e.msg}` + (e.extra ? ' ' + JSON.stringify(e.extra) : '')
      ).join('\n');
    },
    clear() { ring = []; persistRing(); },
  };

  /* ------------------------------------------------------------
   * 全局兜底
   *
   * 三层都要挂，缺一层就会漏：
   *   - error            资源加载失败 / 脚本运行时错误
   *   - unhandledrejection  Promise 未 catch（最常见，因为全是 async）
   *   - 手动 ErrorBoundary（下方 wrap / guard）
   * ------------------------------------------------------------ */
  let onFatal = null;

  function installGlobalHandlers() {
    window.addEventListener('error', (ev) => {
      // 资源加载失败（img/script/css）没有 error 对象，只有 target
      if (ev.target && ev.target !== window && ev.target.tagName) {
        Log.warn('res', '资源加载失败：' + (ev.target.src || ev.target.href || ev.target.tagName));
        return;
      }
      Log.error('window', ev.message || 'script error', {
        file: ev.filename, line: ev.lineno, col: ev.colno,
      });
      if (onFatal) onFatal(normalize(ev.error || new Error(ev.message)));
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const err = normalize(ev.reason);
      Log.error('promise', err.message, { stack: String(err.stack || '').slice(0, 800) });
      if (onFatal) onFatal(err);
      // 阻止浏览器默认在控制台再打一遍（已记录）
      ev.preventDefault();
    });
  }

  /** 注册致命错误回调（UI 层用来弹提示） */
  function setFatalHandler(fn) {
    onFatal = typeof fn === 'function' ? fn : null;
  }

  /**
   * 包裹异步函数：捕获异常并走统一提示，不中断调用方
   * 用法：const safeFn = Errors.wrap(fn, '模块名')
   */
  function wrap(fn, tag) {
    return function (...args) {
      try {
        const r = fn.apply(this, args);
        if (r && typeof r.then === 'function') {
          return r.catch((e) => {
            const err = normalize(e);
            Log.error(tag || 'wrap', err.message, { stack: String(err.stack || '').slice(0, 800) });
            if (typeof window !== 'undefined' && window.UI && !err.expected) {
              window.UI.toast(userMessage(err), 'err');
            } else if (typeof window !== 'undefined' && window.UI && err.expected) {
              window.UI.toast(err.message, 'err');
            }
            return undefined;
          });
        }
        return r;
      } catch (e) {
        const err = normalize(e);
        Log.error(tag || 'wrap', err.message, { stack: String(err.stack || '').slice(0, 800) });
        if (typeof window !== 'undefined' && window.UI) {
          window.UI.toast(err.expected ? err.message : userMessage(err), 'err');
        }
        return undefined;
      }
    };
  }

  /**
   * 守卫一段可能失败的代码，失败时调用 fallback
   * 用于"某个卡片数据取不到不影响整页"的场景
   */
  async function guard(fn, fallback, tag) {
    try {
      return await fn();
    } catch (e) {
      const err = normalize(e);
      Log.warn(tag || 'guard', '已降级：' + err.message);
      return typeof fallback === 'function' ? fallback(err) : fallback;
    }
  }

  /** 重试（指数退避），用于 IndexedDB 偶发失败 */
  async function retry(fn, times, delay) {
    const n = times || 3;
    const base = delay || 60;
    let last;
    for (let i = 0; i < n; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (i < n - 1) {
          await new Promise(r => setTimeout(r, base * Math.pow(2, i)));
        }
      }
    }
    throw normalize(last);
  }

  installGlobalHandlers();

  window.Errors = {
    AppError, ValidationError, StorageError,
    normalize, userMessage,
    wrap, guard, retry,
    setFatalHandler,
    Log,
    /** 诊断信息（用户可复制） */
    diagnostics(extra) {
      loadRing();
      return JSON.stringify({
        when: new Date().toISOString(),
        ua: navigator.userAgent,
        url: location.href,
        online: navigator.onLine,
        storage: {
          ls: (() => { try { return localStorage.length; } catch (_) { return -1; } })(),
        },
        extra: extra || null,
        logs: ring.slice(-80),
      }, null, 2);
    },
  };
})();
