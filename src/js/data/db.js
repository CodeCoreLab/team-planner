/* ============================================================
 * data/db.js —— IndexedDB 封装
 *
 * 职责边界：只管"怎么和 IndexedDB 打交道"，不含任何业务语义。
 * 业务规则在 repo.js，UI 在 pages/。
 *
 * 关键设计：
 *   1. 单一连接复用 + 断线重连（连接可能被浏览器强制关闭）
 *   2. 事务包装为 Promise，等 oncomplete 才算成功（写入真落盘）
 *   3. 配额监控：快满时提前告警，避免写到一半失败丢数据
 *   4. 版本迁移带备份：升级失败可回滚到旧版本读
 *   5. 所有错误统一包装成 StorageError，带可读文案
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const PATH = 'team-planner';

  const DB_NAME = PATH;
  const DB_VERSION = 2;      // v1: 首版；v2: 增加软删除、点评、通知、操作日志

  let conn = null;
  let opening = null;

  /** 所有 store 定义（集中管理，避免开库代码与业务代码各写一份） */
  const STORES = [
    {
      name: 'tasks',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_date', 'task_date', false],
        ['by_status', 'status', false],
        ['by_assignee', 'assignee_id', false],
        ['date_status', ['task_date', 'status'], false],
        ['by_plan', 'plan_id', false],
        ['by_parent', 'recurrence_parent_id', false],
      ],
    },
    {
      name: 'plans',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_status', 'status', false],
        ['by_type', 'type', false],
        ['by_level', 'level', false],
        ['by_creator', 'creator_id', false],
        ['by_dept', 'department_id', false],
        ['by_archived', 'archived', false],
      ],
    },
    {
      name: 'logs',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_date', 'date_range', false],
        ['by_type', 'type', false],
        ['by_user', 'user_id', false],
        ['date_type', ['date_range', 'type'], false],
        ['by_status', 'status', false],
      ],
    },
    {
      name: 'users',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_username', 'username', true],
        ['by_dept', 'department_id', false],
        ['by_role', 'role_id', false],
      ],
    },
    {
      name: 'departments',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [['by_parent', 'parent_id', false]],
    },
    {
      name: 'roles',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [],
    },
    {
      name: 'subtasks',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [['by_task', 'task_id', false]],
    },
    {
      name: 'tags',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_task', 'task_id', false],
        ['by_tag', 'tag', false],
      ],
    },
    {
      name: 'task_assignees',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_task', 'task_id', false],
        ['by_user', 'user_id', false],
        ['task_user', ['task_id', 'user_id'], true],
      ],
    },
    {
      name: 'work_log_reviews',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [['by_log', 'log_id', false]],
    },
    {
      name: 'notifications',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_user', 'user_id', false],
        ['by_read', 'is_read', false],
      ],
    },
    {
      name: 'operation_logs',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['by_created', 'created_at', false],
        ['by_user', 'user_id', false],
        ['by_action', 'action', false],
      ],
    },
    {
      name: 'settings',
      keyPath: 'k',
      autoIncrement: false,
      indexes: [],
    },
    {
      name: 'task_order',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        ['task_user', ['task_id', 'user_id'], true],
        ['by_user', 'user_id', false],
      ],
    },
    {
      // 元信息：迁移版本、上次备份时间、当前登录会话指针等
      name: 'meta',
      keyPath: 'k',
      autoIncrement: false,
      indexes: [],
    },
  ];

  /* ------------------------------------------------------------
   * 开库
   * ------------------------------------------------------------ */

  function open() {
    if (conn) return Promise.resolve(conn);
    if (opening) return opening;

    opening = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        opening = null;
        reject(new E.StorageError('浏览器存储不可用。若在用隐私/无痕模式，请改用普通窗口打开。', e));
        return;
      }

      // 超时兜底：某些环境下 open 永不回调（存储被策略禁用）
      const timer = setTimeout(() => {
        if (!conn) {
          opening = null;
          reject(new E.StorageError('打开本地数据库超时。请检查浏览器是否禁用了本地存储。'));
        }
      }, 8000);

      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const oldV = ev.oldVersion || 0;
        try {
          migrate(db, oldV, DB_VERSION, req.transaction);
        } catch (e) {
          E.Log.error('db', '建库失败：' + e.message, { stack: String(e.stack || '').slice(0, 600) });
          try { req.transaction.abort(); } catch (_) {}
        }
      };

      req.onsuccess = () => {
        clearTimeout(timer);
        conn = req.result;
        opening = null;

        // 连接被浏览器强制关闭（多标签页升级、清理数据）时清空引用
        conn.onclose = () => {
          E.Log.warn('db', '数据库连接被关闭，下次操作将重连');
          conn = null;
        };
        conn.onversionchange = () => {
          E.Log.warn('db', '数据库版本变更（可能另一个标签页在升级）');
          try { conn.close(); } catch (_) {}
          conn = null;
          E.Log.warn('db', '请刷新页面以继续使用');
        };

        E.Log.info('db', '数据库已打开 version=' + DB_VERSION);
        resolve(conn);
      };

      req.onerror = () => {
        clearTimeout(timer);
        opening = null;
        const err = req.error;
        let msg = '本地数据库打开失败';
        if (err && err.name === 'QuotaExceededError') {
          msg = '浏览器存储空间不足，请清理浏览器数据后重试';
        } else if (err && err.name === 'SecurityError') {
          msg = '当前环境不允许使用本地数据库（可能处于隐私模式）';
        }
        reject(new E.StorageError(msg, err));
      };

      req.onblocked = () => {
        clearTimeout(timer);
        opening = null;
        reject(new E.StorageError('另一个标签页正在使用旧版本，请关闭其他标签页后刷新'));
      };
    });

    return opening;
  }

  /**
   * 建表 / 增量迁移
   *
   * 原则：只增不删。旧版本的结构变更一律用"新增"表达，
   * 避免用户升级过程中丢数据。
   *
   * 注意：在 onupgradeneeded 里，必须用 `request.transaction`
   * 拿当前升级事务；`db.transaction()` 此时不可用（会抛 InvalidStateError）。
   * 补索引只能通过这个事务对象上的 store 来做。
   */
  function migrate(db, oldV, newV, upTx) {
    E.Log.info('db', `迁移 ${oldV} → ${newV}`);

    for (const def of STORES) {
      let os;
      if (db.objectStoreNames.contains(def.name)) {
        // 已存在：取出来补索引（老版本可能缺新索引）
        os = upTx ? upTx.objectStore(def.name) : null;
        if (!os) continue;
        for (const [idxName, keyPath, unique] of def.indexes) {
          if (os.indexNames.contains(idxName)) continue;
          try {
            os.createIndex(idxName, keyPath, { unique: !!unique });
          } catch (e) {
            E.Log.warn('db', `补索引失败 ${def.name}.${idxName}：` + e.message);
          }
        }
        continue;
      }

      os = db.createObjectStore(def.name, {
        keyPath: def.keyPath,
        autoIncrement: !!def.autoIncrement,
      });
      for (const [idxName, keyPath, unique] of def.indexes) {
        try {
          os.createIndex(idxName, keyPath, { unique: !!unique });
        } catch (e) {
          E.Log.warn('db', `建索引失败 ${def.name}.${idxName}：` + e.message);
        }
      }
    }
  }

  /* ------------------------------------------------------------
   * 事务
   * ------------------------------------------------------------ */

  /**
   * 执行一个事务
   *
   * @param {string|string[]} stores 涉及的 store（必须一次声明全，IndexedDB 事务不可动态扩范围）
   * @param {'readonly'|'readwrite'} mode
   * @param {(ctx) => any} fn  在事务内执行；返回值作为 resolve 结果
   * @param {object} opts { timeout }
   */
  async function tx(stores, mode, fn, opts) {
    const db = await open();
    const names = Array.isArray(stores) ? stores : [stores];
    const o = opts || {};
    const timeoutMs = o.timeout || 15000;

    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(names, mode);
      } catch (e) {
        reject(new E.StorageError('无法开始数据库事务：' + (e && e.message), e));
        return;
      }

      let result;
      let settled = false;
      const finish = (ok, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ok ? resolve(val) : reject(val);
      };

      const timer = setTimeout(() => {
        try { transaction.abort(); } catch (_) {}
        finish(false, new E.StorageError('数据库操作超时，可能有其他标签页正在占用'));
      }, timeoutMs);

      transaction.oncomplete = () => finish(true, result);
      transaction.onerror = () => {
        const err = transaction.error;
        let msg = '数据保存失败';
        if (err && err.name === 'QuotaExceededError') {
          msg = '存储空间已满，写不进去了。请先「备份」导出数据，再清理浏览器存储。';
          window.Bus && window.Bus.emit(window.Bus.EVENTS.QUOTA_WARN, {});
        } else if (err && err.name === 'ConstraintError') {
          msg = '数据冲突（可能重复提交）';
        }
        finish(false, new E.StorageError(msg, err));
      };
      transaction.onabort = () => {
        const err = transaction.error;
        finish(false, new E.StorageError('操作已取消' + (err ? '：' + err.message : ''), err));
      };

      try {
        result = fn(buildCtx(transaction, names));
      } catch (e) {
        try { transaction.abort(); } catch (_) {}
        finish(false, e instanceof E.AppError ? e : new E.StorageError('操作失败：' + (e && e.message), e));
      }
    });
  }

  /** 给事务回调的上下文：把 objectStore 操作包成 Promise */
  function buildCtx(transaction, names) {
    const store = (name) => {
      if (names.indexOf(name) < 0) {
        throw new E.StorageError(`事务未包含 store「${name}」，请检查 tx() 的 stores 参数`);
      }
      return transaction.objectStore(name);
    };

    return {
      raw: transaction,
      store,
      get(name, key) { return reqAsync(store(name).get(key)); },
      getAll(name, query) { return reqAsync(store(name).getAll(query)); },
      getAllKeys(name, query) { return reqAsync(store(name).getAllKeys(query)); },
      count(name, query) { return reqAsync(store(name).count(query)); },
      put(name, val, opts) { return reqAsync(store(name).put(val), opts); },
      add(name, val, opts) { return reqAsync(store(name).add(val), opts); },
      del(name, key, opts) { return reqAsync(store(name).delete(key), opts); },
      clear(name, opts) { return reqAsync(store(name).clear(), opts); },
      index(name, idx, query, mode2) {
        const os = store(name);
        const index = os.index(idx);
        const m = mode2 || 'getAll';
        return reqAsync(index[m](query));
      },
      indexKeys(name, idx, query) {
        return reqAsync(store(name).index(idx).getAllKeys(query));
      },
    };
  }

  /**
   * IDBRequest → Promise（在事务内使用，不额外开事务）
   *
   * opts.tolerate 的语义：
   *   IndexedDB 的请求失败默认会**中止整个事务**，后续所有操作一起废掉。
   *   导入历史数据时这不可接受 —— 一行脏数据不该让整批导入失败。
   *   因此 tolerate 模式下调用 error 事件的 preventDefault()，
   *   阻止默认的「中止事务」，只让这一行失败（Promise reject 给调用方计数）。
   */
  function reqAsync(req, opts) {
    const o = opts || {};
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = (e) => {
        if (o.tolerate) {
          // 关键：不 preventDefault 就会连带中止整个事务
          try { e && e.preventDefault && e.preventDefault(); } catch (_) {}
          const err = req.error || new Error('IndexedDB 请求失败');
          err.tolerated = true;
          rej(err);
          return;
        }
        rej(req.error || new Error('IndexedDB 请求失败'));
      };
    });
  }

  /* ------------------------------------------------------------
   * 只读快捷方式（自动重试一次，应对偶发失败）
   * ------------------------------------------------------------ */

  async function read(stores, fn) {
    try {
      return await tx(stores, 'readonly', fn);
    } catch (e) {
      // 只读操作重试是安全的
      E.Log.warn('db', '只读操作失败，重试一次：' + (e && e.message));
      return tx(stores, 'readonly', fn);
    }
  }

  async function write(stores, fn) {
    return tx(stores, 'readwrite', fn);
  }

  /* ------------------------------------------------------------
   * 配额监控
   * ------------------------------------------------------------ */

  async function quota() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const used = est.usage || 0;
        const total = est.quota || 0;
        return {
          used, total,
          usedMB: +(used / 1048576).toFixed(2),
          totalMB: +(total / 1048576).toFixed(0),
          pct: total ? Math.round(used / total * 100) : 0,
        };
      }
    } catch (_) {}
    return { used: 0, total: 0, usedMB: 0, totalMB: 0, pct: 0 };
  }

  /**
   * 申请持久化存储
   *
   * 默认浏览器在"存储压力大"时会自动清理 IndexedDB，
   * 申请 persist 后不会被自动清（用户手动清仍会清）。
   * 纯前端方案下这是数据安全的重要一环。
   */
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (already) return { persisted: true, already: true };
        const ok = await navigator.storage.persist();
        return { persisted: !!ok, already: false };
      }
    } catch (e) {
      E.Log.warn('db', '申请持久化失败：' + e.message);
    }
    return { persisted: false, already: false, unsupported: true };
  }

  /** 关闭连接（用于"清空数据"后重开） */
  function close() {
    if (conn) {
      try { conn.close(); } catch (_) {}
      conn = null;
    }
  }

  /** 彻底删除数据库（危险操作，仅"重置所有数据"使用） */
  function destroy() {
    close();
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new E.StorageError('删除数据库失败', req.error));
      req.onblocked = () => reject(new E.StorageError('有其他标签页占用，请关闭后重试'));
    });
  }

  window.DB = {
    open, tx, read, write, reqAsync, quota, requestPersistence,
    close, destroy,
    DB_NAME, DB_VERSION,
    /** 测试用：暴露 store 清单 */
    stores: () => STORES.map(s => s.name),
  };
})();
