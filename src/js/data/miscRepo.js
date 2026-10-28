/* ============================================================
 * data/miscRepo.js —— 设置 / 通知 / 操作日志 / 搜索 / 导出
 *
 * 合并成一文件的原因：这几个模块各只有 1-2 个函数，
 * 拆成 5 个文件会让 boot 的加载列表变长而收益不大。
 *
 * 覆盖 PHP 版：
 *   api/settings.php  → get / save / reset
 *   api/dashboard.php → notifications / read_all / calendar
 *   api/oplogs.php    → list / clear
 *   api/search.php    → 全局搜索
 *   api/export.php    → CSV 导出
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const V = window.Validate;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  /* ============================================================
   * 设置
   * ============================================================ */

  // 内存缓存：设置项在渲染中被读几十次，每次都查库太浪费
  let _cache = null;

  async function ensureSettings() {
    const rows = await DB.read('settings', c => c.getAll('settings'));
    const map = {};
    for (const r of rows) map[r.k] = r.v;

    // 补齐缺失的默认值（升级老版本时新增的设置项）
    const missing = [];
    for (const k of Object.keys(S.DEFAULT_SETTINGS)) {
      if (map[k] === undefined) missing.push(k);
    }
    if (missing.length) {
      await DB.write('settings', async (c) => {
        for (const k of missing) {
          await c.put('settings', { k, v: S.DEFAULT_SETTINGS[k] });
        }
      });
      for (const k of missing) map[k] = S.DEFAULT_SETTINGS[k];
      E.Log.info('settings', '补齐默认设置项：' + missing.join(','));
    }

    _cache = map;
    return map;
  }

  function get(key, dflt) {
    if (!_cache) return dflt === undefined ? S.DEFAULT_SETTINGS[key] : dflt;
    const v = _cache[key];
    if (v === undefined || v === '') return dflt === undefined ? S.DEFAULT_SETTINGS[key] : dflt;
    return v;
  }

  function getNumber(key, dflt) {
    const v = Number(get(key, dflt));
    return Number.isFinite(v) ? v : dflt;
  }

  function getBool(key, dflt) {
    const v = get(key, dflt ? '1' : '0');
    return v === '1' || v === 'true' || v === true;
  }

  /** 全部设置（给设置页用） */
  async function getAll() {
    const map = _cache || await ensureSettings();
    const out = Object.assign({}, S.DEFAULT_SETTINGS, map);
    // 解析工作时段，UI 直接用
    out.periods = periodList(out.work_periods);
    out.work_day_list = parseWorkDays(out.work_days);
    return out;
  }

  /** 保存设置（白名单字段） */
  async function save(input) {
    window.Auth.requirePerm('settings', 'edit');
    const allowed = Object.keys(S.DEFAULT_SETTINGS);
    const patch = {};
    let n = 0;

    for (const k of allowed) {
      if (input[k] === undefined) continue;
      let v = String(input[k]);

      // 分字段校验
      if (k === 'page_size') {
        const num = V.asInt(v, 20);
        v = String(Math.max(5, Math.min(200, num)));
      }
      if (k === 'week_start') {
        v = String(Math.max(0, Math.min(6, V.asInt(v, 1))));
      }
      if (k === 'work_days') {
        const days = V.idList(v, 7).filter(d => d >= 1 && d <= 7);
        v = days.length ? days.join(',') : '1,2,3,4,5';
      }
      if (k === 'site_name') {
        v = V.clip(v.trim(), 64) || '团队协作台';
      }
      if (k === 'site_subtitle') {
        v = V.clip(v.trim(), 120);
      }
      if (k === 'theme_default') {
        v = V.oneOf(v, ['light', 'dark'], 'light');
      }
      if (k === 'work_periods') {
        // 允许传 JSON 字符串或数组
        let arr = input[k];
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); } catch (_) { arr = null; }
        }
        const cleaned = periodList(arr);
        v = JSON.stringify(cleaned);
      }

      patch[k] = v;
      n++;
    }

    if (!n) return { updated: 0 };

    await DB.write('settings', async (c) => {
      for (const k of Object.keys(patch)) {
        await c.put('settings', { k, v: patch[k] });
      }
    });

    await ensureSettings();   // 刷新缓存
    window.Bus && window.Bus.emit(window.Bus.EVENTS.SETTINGS_CHANGED, { changed: Object.keys(patch) });
    if (window.FileIO) window.FileIO.markDirty(true);
    window.OpLog && window.OpLog.write('修改系统设置', '', Object.keys(patch).join(','));
    return { updated: n, changed: patch };
  }

  /** 工作时段列表（带清洗与兜底） */
  function periodList(raw) {
    let arr = raw;
    if (typeof arr === 'string') {
      if (arr.trim().startsWith('[')) {
        try { arr = JSON.parse(arr); } catch (_) { arr = null; }
      } else if (arr.indexOf(',') >= 0) {
        // 兼容老格式："上午,下午,晚上"
        const defaults = defaultPeriods();
        const names = arr.split(',').map(s => s.trim());
        arr = defaults.filter(d => names.indexOf(d.n) >= 0);
      }
    }
    if (!Array.isArray(arr) || !arr.length) return defaultPeriods();

    const out = [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const name = V.clip(String(p.n || '').trim(), 16);
      if (!name) continue;
      out.push({
        n: name,
        s: V.time(p.s) || '06:00',
        e: V.time(p.e) || '12:00',
      });
      if (out.length >= 8) break;
    }
    return out.length ? out : defaultPeriods();
  }

  function defaultPeriods() {
    return [
      { n: '上午', s: '06:00', e: '12:00' },
      { n: '下午', s: '12:00', e: '18:00' },
      { n: '晚上', s: '18:00', e: '24:00' },
    ];
  }

  function periodNames() {
    const list = periodList(get('work_periods'));
    return list.map(p => p.n);
  }

  function periodTime(name) {
    const list = periodList(get('work_periods'));
    const hit = list.find(p => p.n === name);
    if (hit) return { s: hit.s, e: hit.e };
    return { s: '06:00', e: '12:00' };
  }

  function parseWorkDays(raw) {
    const nums = V.idList(String(raw || '1,2,3,4,5'), 7).filter(n => n >= 1 && n <= 7);
    return nums.length ? nums : [1, 2, 3, 4, 5];
  }

  function isWorkDay(dateStr) {
    const dow = V.dayOfWeek(dateStr);            // 0=周日
    const cfg = dow === 0 ? 7 : dow;
    return parseWorkDays(get('work_days')).indexOf(cfg) >= 0;
  }

  window.Settings = {
    ensureSettings, get, getNumber, getBool, getAll, save,
    periodList, periodNames, periodTime, defaultPeriods,
    parseWorkDays, isWorkDay,
    /** 缓存失效（导入数据后调用） */
    invalidate() { _cache = null; },
  };

  /* ============================================================
   * 通知
   * ============================================================ */

  async function notifications(limit) {
    const n = Math.max(1, Math.min(100, V.asInt(limit, 20)));
    const uid = window.Auth.currentUserId();
    const rows = (await Repo.all('notifications'))
      .filter(x => Number(x.user_id) === 0 || Number(x.user_id) === uid);
    const sorted = Repo.sortBy(rows, ['-created_at', '-id']);
    return {
      items: sorted.slice(0, n),
      unread: sorted.filter(x => !x.is_read).length,
      total: sorted.length,
    };
  }

  async function addNotification(title, content, type, userId) {
    const t = V.required(title, 'title', '通知标题');
    const id = await DB.write('notifications', (c) => c.add('notifications', {
      user_id: V.idLoose(userId),
      title: V.clip(t, 255),
      content: V.clip(String(content || ''), 5000),
      type: V.oneOf(type, ['system', 'task', 'log'], 'system'),
      is_read: 0,
      created_at: S.nowStr(),
    }));
    Repo.emitChange('notifications', 'create', id);
    return { id };
  }

  async function markAllRead() {
    const uid = window.Auth.currentUserId();
    const rows = await Repo.all('notifications');
    const targets = rows.filter(x => Number(x.user_id) === 0 || Number(x.user_id) === uid);

    const n = await DB.write('notifications', async (c) => {
      let count = 0;
      for (const r of targets) {
        if (r.is_read) continue;
        r.is_read = 1;
        await c.put('notifications', r);
        count++;
      }
      return count;
    });

    Repo.emitChange('notifications', 'update', null);
    return { updated: n };
  }

  async function markRead(id) {
    const nid = V.idLoose(id);
    await DB.write('notifications', async (c) => {
      const row = await c.get('notifications', nid);
      if (!row) return;
      row.is_read = 1;
      await c.put('notifications', row);
    });
    return { id: nid };
  }

  window.NoticeRepo = { notifications, addNotification, markAllRead, markRead };

  /* ============================================================
   * 操作日志
   * ============================================================ */

  /**
   * 写操作日志
   *
   * 失败不抛错：审计日志写失败不该影响业务操作。
   * 单机场景下也不做防篡改，只求能追溯"谁在什么时候改了什么"。
   */
  async function writeOpLog(action, target, detail) {
    try {
      const u = window.Auth.currentUser();
      await DB.write('operation_logs', (c) => c.add('operation_logs', {
        user_id: u ? Number(u.id) : 0,
        username: u ? (u.real_name || u.username) : '',
        action: V.clip(String(action || ''), 64),
        target: V.clip(String(target || ''), 255),
        detail: V.clip(String(detail || ''), 2000),
        ip: 'local',
        created_at: S.nowStr(),
      }));
    } catch (e) {
      E.Log.warn('oplog', '写操作日志失败：' + e.message);
    }
  }

  async function opLogList(q) {
    window.Auth.requirePerm('oplogs', 'view');
    const query = q || {};
    let rows = await Repo.all('operation_logs');

    if (query.action) rows = rows.filter(r => r.action === query.action);
    if (query.user_id) {
      const uid = V.idLoose(query.user_id);
      rows = rows.filter(r => Number(r.user_id) === uid);
    }
    if (query.search) {
      const s = String(query.search).slice(0, 60);
      rows = rows.filter(r => Repo.matchAny(r, s, ['action', 'target', 'detail', 'username']));
    }
    if (query.range) {
      const rg = V.range(query.range, query.date || V.today());
      rows = rows.filter(r => {
        const d = String(r.created_at || '').slice(0, 10);
        return d >= rg.start && d <= rg.end;
      });
    }

    rows = Repo.sortBy(rows, ['-created_at', '-id']);
    return Repo.paginate(rows, query.page, query.per_page || window.Settings.getNumber('page_size', 20));
  }

  /** 去重后的动作清单（给筛选下拉用） */
  async function opLogActions() {
    const rows = await Repo.all('operation_logs');
    const m = new Map();
    for (const r of rows) m.set(r.action, (m.get(r.action) || 0) + 1);
    return Array.from(m.entries())
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);
  }

  async function opLogClear(days) {
    window.Auth.requirePerm('settings', 'edit');
    const keepDays = Math.max(1, Math.min(3650, V.asInt(days, 90)));
    const cutoff = V.addDays(V.today(), -keepDays);

    const rows = await Repo.all('operation_logs');
    const targets = rows.filter(r => String(r.created_at || '').slice(0, 10) < cutoff);
    if (!targets.length) return { removed: 0, kept_days: keepDays };

    await DB.write('operation_logs', async (c) => {
      for (const r of targets) await c.del('operation_logs', Number(r.id));
    });

    return { removed: targets.length, kept_days: keepDays };
  }

  window.OpLog = { write: writeOpLog, list: opLogList, actions: opLogActions, clear: opLogClear };

  /* ============================================================
   * 全局搜索
   * ============================================================ */

  /**
   * 一次搜索任务 / 计划 / 日志 / 成员
   *
   * 各类型独立限额，避免某一类结果淹没其他类
   * （PHP 版也是分表 LIMIT 而不是 UNION 后统一排序）。
   */
  async function search(q, limit) {
    const keyword = V.clip(String(q || '').trim(), 60);
    const n = Math.max(3, Math.min(30, V.asInt(limit, 6)));
    const empty = { tasks: [], plans: [], logs: [], users: [], query: '', total: 0 };
    if (!keyword) return empty;

    const [tasks, plans, logs, users] = await Promise.all([
      Repo.all('tasks'),
      Repo.all('plans'),
      Repo.all('logs'),
      Repo.all('users'),
    ]);

    const scope = window.Auth.dataScope();
    const uid = window.Auth.currentUserId();
    const deptId = Number((window.Auth.currentUser() || {}).department_id || 0);

    // 任务（带作用域）
    const taskHits = Repo.sortBy(
      tasks.filter(t => {
        if (scope !== 'all') {
          const mine = Number(t.assignee_id) === uid;
          if (!mine && scope !== 'dept') return false;
        }
        return Repo.matchAny(t, keyword, ['title', 'description']);
      }),
      ['-task_date', '-id']
    ).slice(0, n);

    const planHits = Repo.sortBy(
      plans.filter(p => {
        if (p.archived) return false;
        if (scope !== 'all') {
          const mine = Number(p.creator_id) === uid;
          const inDept = scope === 'dept' && deptId > 0 && Number(p.department_id) === deptId;
          if (!mine && !inDept) return false;
        }
        return Repo.matchAny(p, keyword, ['title', 'description']);
      }),
      ['-updated_at']
    ).slice(0, n);

    const logHits = Repo.sortBy(
      logs.filter(l => {
        if (scope !== 'all' && Number(l.user_id) !== uid) return false;
        return Repo.matchAny(l, keyword, ['title', 'content', 'task_summary']);
      }),
      ['-date_range', '-id']
    ).slice(0, n);

    // 成员只在有组织架构权限时搜索
    const canSeeUsers = window.Auth.can('org', 'view');
    const userHits = canSeeUsers
      ? Repo.sortBy(
          users.filter(u => Repo.matchAny(u, keyword, ['username', 'real_name', 'email'])),
          ['id']
        ).slice(0, n)
      : [];

    // 装饰结果（带跳转需要的信息）
    const decoratedTasks = window.TaskRepo.decorate
      ? (await window.TaskRepo.decorate(taskHits)).map(t => ({
          id: t.id, title: t.title, status: t.status, status_name: t.status_name,
          task_date: t.task_date, time_slot: t.time_slot,
          priority: t.priority, priority_name: t.priority_name,
          assignee_name: t.assignee_name,
        }))
      : taskHits;

    const decoratedPlans = (await window.PlanRepo.decorate(planHits)).map(p => ({
      id: p.id, title: p.title, type: p.type, type_name: p.type_name,
      status: p.status, status_name: p.status_name, level: p.level,
    }));

    const decoratedLogs = logHits.map(l => ({
      id: l.id, date_range: l.date_range, type: l.type,
      type_name: S.label('logType', l.type),
      excerpt: V.clip(String(l.content || '').replace(/\s+/g, ' '), 80),
    }));

    const decoratedUsers = userHits.map(u => ({
      id: u.id, username: u.username, real_name: u.real_name,
      department_name: '', avatar_url: u.avatar || window.OrgRepo.avatarDataUri(u.real_name || u.username),
    }));

    return {
      query: keyword,
      tasks: decoratedTasks,
      plans: decoratedPlans,
      logs: decoratedLogs,
      users: decoratedUsers,
      total: decoratedTasks.length + decoratedPlans.length + decoratedLogs.length + decoratedUsers.length,
    };
  }

  window.SearchRepo = { search };

  /* ============================================================
   * CSV 导出
   * ============================================================ */

  /** 转义 CSV 单元格（含引号、逗号、换行都要包起来） */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCsv(headers, rows) {
    const lines = [];
    lines.push(headers.map(csvCell).join(','));
    for (const r of rows) {
      lines.push(headers.map(h => csvCell(r[h])).join(','));
    }
    // UTF-8 BOM：Excel 直接打开不乱码
    return '\ufeff' + lines.join('\r\n');
  }

  /**
   * 导出数据
   *
   * @param {'tasks'|'plans'|'logs'} type
   * @param {object} opts { view, date }
   * @returns {{filename:string, content:string, rows:number}}
   */
  async function exportCsv(type, opts) {
    const o = opts || {};
    const t = V.oneOf(type, ['tasks', 'plans', 'logs'], 'tasks');
    const view = V.oneOf(o.view, ['day', 'week', 'month', 'quarter', 'year', 'all'], 'month');
    const ref = V.date(o.date, V.today());
    const rg = view === 'all' ? null : V.range(view, ref);
    const stamp = V.today();

    if (t === 'tasks') {
      let rows = view === 'all'
        ? await Repo.all('tasks')
        : await Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end));
      rows = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(rows));
      rows = Repo.sortBy(rows, ['task_date', 'start_time', 'id']);

      const content = toCsv(
        ['日期', '任务标题', '时间段', '开始时间', '结束时间', '结束日期', '状态', '优先级', '负责人', '协助人', '标签', '子任务', '描述'],
        rows.map(x => ({
          日期: x.task_date || '',
          任务标题: x.title,
          时间段: x.time_slot || '',
          开始时间: x.start_time || '',
          结束时间: x.end_time || '',
          结束日期: x.end_date || '',
          状态: x.status_name,
          优先级: x.priority_name,
          负责人: x.assignee_name,
          协助人: (x.co_names || []).join('、'),
          标签: (x.tags || []).join('、'),
          子任务: x.subtask_total ? `${x.subtask_done}/${x.subtask_total}` : '',
          描述: String(x.description || '').replace(/\r?\n/g, ' '),
        }))
      );
      return { filename: `任务-${stamp}.csv`, content, rows: rows.length };
    }

    if (t === 'plans') {
      let rows = await Repo.all('plans');
      const scope = window.Auth.dataScope();
      if (scope !== 'all') {
        const uid = window.Auth.currentUserId();
        rows = rows.filter(p => Number(p.creator_id) === uid);
      }
      rows = Repo.sortBy(await window.PlanRepo.decorate(rows), ['-updated_at']);

      const content = toCsv(
        ['标题', '类型', '层级', '状态', '进度', '开始日期', '结束日期', '创建人', '任务数', '完成数', '描述'],
        rows.map(p => ({
          标题: p.title,
          类型: p.type_name,
          层级: p.level_name,
          状态: p.status_name,
          进度: p.progress + '%',
          开始日期: p.start_date || '',
          结束日期: p.end_date || '',
          创建人: p.creator_name,
          任务数: p.task_total,
          完成数: p.task_done,
          描述: String(p.description || '').replace(/\r?\n/g, ' '),
        }))
      );
      return { filename: `计划-${stamp}.csv`, content, rows: rows.length };
    }

    let rows = view === 'all'
      ? await Repo.all('logs')
      : (await Repo.all('logs')).filter(l => l.date_range >= rg.start && l.date_range <= rg.end);
    if (window.Auth.dataScope() !== 'all') {
      rows = rows.filter(l => Number(l.user_id) === window.Auth.currentUserId());
    }
    rows = Repo.sortBy(await window.LogRepo.decorate(rows), ['-date_range']);

    const content = toCsv(
      ['日期', '类型', '标题', '作者', '状态', '字数', '内容'],
      rows.map(l => ({
        日期: l.date_range || '',
        类型: l.type_name,
        标题: l.title || '',
        作者: l.owner_name,
        状态: l.status_name,
        字数: l.content_length,
        内容: String(l.content || '').replace(/\r?\n/g, ' '),
      }))
    );
    return { filename: `工作日志-${stamp}.csv`, content, rows: rows.length };
  }

  window.ExportRepo = { exportCsv, toCsv, csvCell };
})();
