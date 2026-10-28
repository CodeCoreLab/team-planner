/* ============================================================
 * data/repo.js —— 仓储层基础工具
 *
 * 提供所有实体共用的能力：
 *   - CRUD（带字段归一化、软删除、变更事件）
 *   - 作用域过滤（self / dept / all）
 *   - 分页
 *   - 批量操作
 *
 * 为什么要有这一层：
 *   12 张表如果各自手写 get/put/del，会有 12 份几乎相同的代码，
 *   且"要不要软删除""要不要发事件"很容易漏。集中后只有一份实现。
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const S = window.Schema;
  const DB = window.DB;

  /** 发数据变更事件（所有写操作都必须调用，UI 靠它刷新） */
  function emitChange(entity, action, id) {
    if (window.Bus) {
      window.Bus.emit(window.Bus.EVENTS.DATA_CHANGED, { entity, action, id });
      const map = {
        tasks: 'TASK_CHANGED', plans: 'PLAN_CHANGED', logs: 'LOG_CHANGED',
        users: 'USER_CHANGED', settings: 'SETTINGS_CHANGED',
      };
      if (map[entity]) {
        window.Bus.emit(window.Bus.EVENTS[map[entity]], { action, id });
      }
    }
    if (window.FileIO) window.FileIO.markDirty(true);
  }

  /** 软删除标记检查（内部也用它过滤查询结果） */
  function alive(row) {
    return !!row && !row.deleted;
  }

  function aliveOnly(rows) {
    return (rows || []).filter(alive);
  }

  /* ------------------------------------------------------------
   * 通用 CRUD
   * ------------------------------------------------------------ */

  /**
   * 创建或更新
   *
   * @param {string} entity
   * @param {object} input
   * @param {object} opts { keepId, strict, now }
   * @returns {Promise<object>} 落库后的完整行
   */
  async function save(entity, input, opts) {
    const o = opts || {};
    const row = S.normalize(entity, input, { keepId: o.keepId !== false, strict: o.strict !== false });
    const now = S.nowStr();

    const saved = await DB.write(entity, async (c) => {
      if (row.id) {
        const old = await c.get(entity, row.id);
        if (!old) throw new E.AppError('记录不存在或已被删除', 'E_NOTFOUND');
        row.created_at = old.created_at || now;
        row.updated_at = now;
        // 保留调用方未提交的字段（部分更新语义）
        const merged = Object.assign({}, old, row);
        await c.put(entity, merged);
        return merged;
      }
      row.created_at = row.created_at || now;
      row.updated_at = now;
      const id = await c.add(entity, row);
      row.id = id;
      return row;
    });

    emitChange(entity, row.id ? 'update' : 'create', saved.id);
    return saved;
  }

  /** 取单条（默认不带软删除的） */
  async function get(entity, id, opts) {
    const o = opts || {};
    const key = Number(id);
    if (!(key > 0)) return null;
    const row = await DB.read(entity, (c) => c.get(entity, key));
    if (!row) return null;
    if (!o.withDeleted && row.deleted) return null;
    return row;
  }

  /** 取全部（过滤软删除） */
  async function all(entity, opts) {
    const o = opts || {};
    const rows = await DB.read(entity, (c) => c.getAll(entity));
    return o.withDeleted ? (rows || []) : aliveOnly(rows);
  }

  /** 按索引取 */
  async function byIndex(entity, indexName, query, opts) {
    const o = opts || {};
    const rows = await DB.read(entity, (c) => c.index(entity, indexName, query));
    return o.withDeleted ? (rows || []) : aliveOnly(rows);
  }

  /** 软删除（进回收站语义） */
  async function softDelete(entity, id) {
    const key = Number(id);
    const done = await DB.write(entity, async (c) => {
      const row = await c.get(entity, key);
      if (!row) throw new E.AppError('记录不存在', 'E_NOTFOUND');
      row.deleted = true;
      row.updated_at = S.nowStr();
      await c.put(entity, row);
      return row;
    });
    emitChange(entity, 'delete', key);
    return done;
  }

  /** 恢复软删除 */
  async function restore(entity, id) {
    const key = Number(id);
    const done = await DB.write(entity, async (c) => {
      const row = await c.get(entity, key);
      if (!row) throw new E.AppError('记录不存在', 'E_NOTFOUND');
      row.deleted = false;
      row.updated_at = S.nowStr();
      await c.put(entity, row);
      return row;
    });
    emitChange(entity, 'restore', key);
    return done;
  }

  /** 物理删除 */
  async function hardDelete(entity, id) {
    const key = Number(id);
    await DB.write(entity, (c) => c.del(entity, key));
    emitChange(entity, 'hard-delete', key);
    return true;
  }

  /**
   * 批量软删除
   * 在一个事务里做，避免一半成功一半失败
   */
  async function bulkSoftDelete(entity, ids) {
    const keys = (ids || []).map(Number).filter(n => n > 0);
    if (!keys.length) return 0;
    const n = await DB.write(entity, async (c) => {
      let count = 0;
      for (const k of keys) {
        const row = await c.get(entity, k);
        if (!row) continue;
        row.deleted = true;
        row.updated_at = S.nowStr();
        await c.put(entity, row);
        count++;
      }
      return count;
    });
    if (n) emitChange(entity, 'bulk-delete', keys);
    return n;
  }

  /* ------------------------------------------------------------
   * 分页
   * ------------------------------------------------------------ */

  function paginate(rows, page, perPage) {
    const p = Math.max(1, Number(page) || 1);
    const n = Math.max(1, Math.min(200, Number(perPage) || 20));
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / n));
    const safePage = Math.min(p, totalPages);
    const start = (safePage - 1) * n;
    return {
      items: rows.slice(start, start + n),
      total,
      page: safePage,
      per_page: n,
      total_pages: totalPages,
    };
  }

  /* ------------------------------------------------------------
   * 文本搜索（大小写不敏感，支持中文子串）
   * ------------------------------------------------------------ */

  function matchText(haystack, needle) {
    if (!needle) return true;
    const h = String(haystack == null ? '' : haystack).toLowerCase();
    const n = String(needle).toLowerCase();
    return h.indexOf(n) >= 0;
  }

  /** 多字段匹配（任一字段命中即算） */
  function matchAny(row, needle, fields) {
    if (!needle) return true;
    for (const f of fields) {
      if (matchText(row[f], needle)) return true;
    }
    return false;
  }

  /** 排序：按多个键依次比较，支持数字/字符串/日期（YYYY-MM-DD 字典序即时间序） */
  function sortBy(rows, keys) {
    const ks = Array.isArray(keys) ? keys : [keys];
    return rows.slice().sort((a, b) => {
      for (const k of ks) {
        let field = k, dir = 1;
        if (typeof k === 'string' && k.charAt(0) === '-') { field = k.slice(1); dir = -1; }
        const va = a[field], vb = b[field];
        if (va === vb) continue;
        if (va === null || va === undefined) return 1 * dir;
        if (vb === null || vb === undefined) return -1 * dir;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), 'zh-CN') * dir;
      }
      return 0;
    });
  }

  /* ------------------------------------------------------------
   * ID 生成（用于需要预先知道 ID 的场景）
   *
   * IndexedDB 的 autoIncrement 要 add 之后才知道 ID，
   * 但循环任务生成实例时需要提前分配（子任务/标签要引用）。
   * 这里用 meta 表里的计数器，保证单调递增且不冲突。
   * ------------------------------------------------------------ */


  window.Repo = {
    alive, aliveOnly,
    save, get, all, byIndex, softDelete, restore, hardDelete, bulkSoftDelete,
    paginate, matchText, matchAny, sortBy,
    emitChange,
  };
})();
