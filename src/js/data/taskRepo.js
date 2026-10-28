/* ============================================================
 * data/taskRepo.js —— 任务仓储
 *
 * 覆盖 PHP 版 api/tasks.php 全部 13 个 action：
 *   list / get / save / delete / toggle / reorder / upcoming
 *   save_subtask / delete_subtask / toggle_subtask
 *   tags / save_tags / bulk_complete
 *
 * 循环任务的语义（与 PHP 版一致，这里写清楚避免误解）：
 *   - 模板（recurrence_parent_id = 0 且 recurrence != 'none'）是"源头"
 *   - 实例（recurrence_parent_id > 0）是生成出来的具体某天
 *   - 改模板且循环规则变了 → 重建实例；只改内容 → 同步到未完成的实例
 *   - 改实例 → 同步公共属性回模板与兄弟实例（保留各自的完成状态）
 *   - 删实例默认连带整条链；传 single=true 只删这一条
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const V = window.Validate;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  /* ------------------------------------------------------------
   * 装饰：补上负责人姓名、标签、子任务进度、派生字段
   * ------------------------------------------------------------ */

  /**
   * 批量装饰（避免 N+1 查询）
   *
   * PHP 版是逐条查标签/子任务，任务多时往返数十次。
   * 这里一次性把涉及的标签、子任务、协助人、用户全取出来在内存里拼。
   */
  async function decorate(rows) {
    if (!rows || !rows.length) return [];

    const ids = rows.map(r => Number(r.id));
    const idSet = new Set(ids);

    /* 按需取关联数据，不做全表扫描
     *
     * 早期实现用 getAll('tags') / getAll('subtasks') 拉全库再在内存里过滤，
     * 复杂度是 O(全库) 而非 O(查询结果)。实测放大倍数随库增长：
     *   300 条 → 5.0x，1000 条 → 5.6x，3000 条 → 7.7x（读 255 行却要 36.8ms）
     * 改为按 idSet 逐个走 by_task 索引，成本与"结果集大小"成正比，
     * 与"库总量"无关。用户库越大，收益越明显。
     *
     * 上下限保护：ids 很多时（如导出全表）逐个查会退化成 N 次事务往返，
     * 超过阈值就退回全表读取 —— 那时全表本来就更划算。 */
    const users = await DB.read(['users'], c => c.getAll('users'));

    let allTags, allSubs, allAssignees;
    const PER_ID_LIMIT = 200;

    if (ids.length <= PER_ID_LIMIT) {
      /* 关键技术点：所有 id 的查询必须在**同一个事务**里并发发出，
       * 而不是逐个 await。
       *
       * 逐个 await 时每个 c.index 都要等前一个完成，N 个 id 就是 N 次串行
       * 往返，小库反而比全表扫描更慢（实测 300 条时放大到 11.7x）。
       * 改成先全部发起、再 Promise.all 收集，IndexedDB 在同一事务内可以
       * 并行调度这些请求，往返次数被压到常数级。 */
      const byTask = (store) => DB.read([store], (c) => {
        const reqs = ids.map(id => c.index(store, 'by_task', id));
        return Promise.all(reqs).then(parts => {
          const out = [];
          for (const part of parts) {
            if (part && part.length) out.push.apply(out, part);
          }
          return out;
        });
      });
      [allTags, allSubs, allAssignees] = await Promise.all([
        byTask('tags'), byTask('subtasks'), byTask('task_assignees'),
      ]);
    } else {
      // 大批量：全表读取反而更省（一次往返 vs N 次）
      [allTags, allSubs, allAssignees] = await Promise.all([
        DB.read(['tags'], c => c.getAll('tags')),
        DB.read(['subtasks'], c => c.getAll('subtasks')),
        DB.read(['task_assignees'], c => c.getAll('task_assignees')),
      ]);
    }
    const tagMap = new Map();
    for (const t of allTags) {
      const k = Number(t.task_id);
      if (!idSet.has(k)) continue;
      if (!tagMap.has(k)) tagMap.set(k, []);
      tagMap.get(k).push(t.tag);
    }

    const subMap = new Map();
    for (const s of allSubs) {
      const k = Number(s.task_id);
      if (!idSet.has(k)) continue;
      if (!subMap.has(k)) subMap.set(k, { total: 0, done: 0, items: [] });
      const rec = subMap.get(k);
      rec.total++;
      if (s.done) rec.done++;
    }

    const coMap = new Map();
    for (const a of allAssignees) {
      const k = Number(a.task_id);
      if (!idSet.has(k)) continue;
      if (!coMap.has(k)) coMap.set(k, []);
      coMap.get(k).push(Number(a.user_id));
    }

    const userMap = new Map();
    for (const u of users) userMap.set(Number(u.id), u);

    const today = V.today();

    return rows.map(t => {
      const tid = Number(t.id);
      const assignee = userMap.get(Number(t.assignee_id)) || null;
      const coIds = coMap.get(tid) || [];
      const subs = subMap.get(tid) || { total: 0, done: 0 };
      const isTemplate = Number(t.recurrence_parent_id || 0) === 0 && t.recurrence && t.recurrence !== 'none';

      return Object.assign({}, t, {
        tags: tagMap.get(tid) || [],
        co_assignees: coIds,
        co_names: coIds.map(id => (userMap.get(id) || {}).real_name || ('#' + id)),
        subtask_total: subs.total,
        subtask_done: subs.done,
        assignee_name: assignee ? (assignee.real_name || assignee.username) : '',
        assignee_avatar: assignee ? (assignee.avatar || null) : null,
        assignee_dept_id: assignee ? Number(assignee.department_id || 0) : 0,
        status_name: S.label('taskStatus', t.status),
        status_color: S.statusColor(t.status),
        priority_name: S.label('priority', t.priority),
        recurrence_name: S.label('recurrence', t.recurrence),
        is_overdue: !!t.task_date && t.task_date < today && t.status !== 'completed',
        is_template: isTemplate,
        is_instance: Number(t.recurrence_parent_id || 0) > 0,
      });
    });
  }

  /* ------------------------------------------------------------
   * 作用域
   * ------------------------------------------------------------ */

  /** 按数据范围过滤已装饰的任务 */
  function scopeFilter(rows) {
    const scope = window.Auth.dataScope();
    if (scope === 'all') return rows;
    const uid = window.Auth.currentUserId();
    const deptId = Number((window.Auth.currentUser() || {}).department_id || 0);

    return rows.filter(t => {
      if (Number(t.assignee_id) === uid) return true;
      if ((t.co_assignees || []).indexOf(uid) >= 0) return true;
      if (scope === 'dept' && deptId > 0 && Number(t.assignee_dept_id) === deptId) return true;
      return false;
    });
  }

  /** 是否可编辑某任务 */
  function canEdit(task) {
    if (!task) return false;
    if (Number((window.Auth.currentUser() || {}).role_id) === 1) return true;
    const uid = window.Auth.currentUserId();
    if (Number(task.assignee_id) === uid) return true;
    if ((task.co_assignees || []).indexOf(uid) >= 0) return true;
    return window.Auth.can('plans', 'edit') && window.Auth.dataScope() !== 'self';
  }

  /* ------------------------------------------------------------
   * 查询
   * ------------------------------------------------------------ */

  /**
   * 列表（对应 tasks/list）
   *
   * @param {object} q { view, date, plan_id, status, assignee_id, search, tag }
   */
  async function list(q) {
    const query = q || {};
    const view = V.oneOf(query.view, ['day', 'week', 'month', 'quarter', 'year', 'all'], 'week');
    const ref = V.date(query.date, V.today());

    let rows;
    if (view === 'all') {
      rows = await Repo.all('tasks');
    } else {
      const rg = V.range(view, ref);
      rows = await Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end));
    }

    rows = scopeFilter(await decorate(rows));

    if (query.plan_id) {
      const pid = V.idLoose(query.plan_id);
      rows = rows.filter(t => Number(t.plan_id) === pid);
    }
    if (query.status) {
      rows = rows.filter(t => t.status === query.status);
    }
    if (query.assignee_id) {
      const aid = V.idLoose(query.assignee_id);
      rows = rows.filter(t => Number(t.assignee_id) === aid || (t.co_assignees || []).indexOf(aid) >= 0);
    }
    if (query.tag) {
      const tag = String(query.tag);
      rows = rows.filter(t => (t.tags || []).indexOf(tag) >= 0);
    }
    if (query.search) {
      const s = String(query.search).slice(0, 60);
      rows = rows.filter(t => Repo.matchAny(t, s, ['title', 'description']) || (t.tags || []).some(g => Repo.matchText(g, s)));
    }

    rows = Repo.sortBy(rows, ['task_date', 'start_time', 'sort_order', 'id']);

    const rg = V.range(view, ref);
    const stats = statistics(rows);

    return {
      view, start: rg.start, end: rg.end,
      items: rows, stats,
      groups: buildGroups(view, rg, rows),
    };
  }

  /** 统计算法（对应 PHP 版 taskStats） */
  function statistics(rows) {
    const out = { total: rows.length, done: 0, in_progress: 0, delayed: 0, pending: 0, rate: 0 };
    for (const t of rows) {
      if (t.status === 'completed') out.done++;
      else if (t.status === 'in_progress') out.in_progress++;
      else if (t.status === 'delayed') out.delayed++;
      else out.pending++;
    }
    out.rate = out.total ? Math.round(out.done / out.total * 100) : 0;
    return out;
  }

  /**
   * 分组（对应 PHP 版 buildWeekData / buildMonthData / buildQuarterGroups）
   *
   * 返回结构：week → 7 天；month → 按日；quarter/year → 按月
   */
  function buildGroups(view, rg, rows) {
    const byDate = new Map();
    for (const t of rows) {
      const d = t.task_date || '';
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(t);
    }

    if (view === 'day') {
      return [{ key: rg.start, label: labelOf(rg.start, 'day'), items: byDate.get(rg.start) || [] }];
    }

    if (view === 'week') {
      const out = [];
      const weekStart = Number(window.Settings ? window.Settings.get('week_start', '1') : '1');
      for (let i = 0; i < 7; i++) {
        const d = V.addDays(rg.start, i);
        out.push({
          key: d, label: labelOf(d, 'day'),
          weekday: '周' + '日一二三四五六'[V.dayOfWeek(d)],
          is_weekend: V.dayOfWeek(d) === 0 || V.dayOfWeek(d) === 6,
          items: byDate.get(d) || [],
          is_today: d === V.today(),
        });
      }
      return out;
    }

    if (view === 'month') {
      const out = [];
      let cur = rg.start;
      let guard = 0;
      while (cur <= rg.end && guard++ < 32) {
        out.push({
          key: cur, label: labelOf(cur, 'day'),
          weekday: '周' + '日一二三四五六'[V.dayOfWeek(cur)],
          is_weekend: V.dayOfWeek(cur) === 0 || V.dayOfWeek(cur) === 6,
          items: byDate.get(cur) || [],
          is_today: cur === V.today(),
        });
        cur = V.addDays(cur, 1);
      }
      return out;
    }

    // quarter / year：按月分组
    const months = new Map();
    for (const t of rows) {
      const m = (t.task_date || '').slice(0, 7);
      if (!m) continue;
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(t);
    }
    const out = [];
    let [y, mo] = rg.start.split('-').map(Number);
    const [ey, emo] = rg.end.split('-').map(Number);
    let guard = 0;
    while ((y < ey || (y === ey && mo <= emo)) && guard++ < 13) {
      const key = y + '-' + V.pad2(mo);
      out.push({
        key, label: y + '年' + mo + '月',
        items: months.get(key) || [],
        stats: statistics(months.get(key) || []),
      });
      mo++;
      if (mo > 12) { mo = 1; y++; }
    }
    return out;
  }

  function labelOf(dateStr, kind) {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (kind === 'day') return m + '月' + d + '日';
    return dateStr;
  }

  /** 单条详情（含子任务明细、标签、协助人） */
  async function get(id) {
    const tid = V.idLoose(id);
    if (!tid) return null;
    const row = await Repo.get('tasks', tid);
    if (!row) return null;
    const [decorated] = await decorate([row]);
    const subs = await Repo.byIndex('subtasks', 'by_task', tid);
    decorated.subtask_items = Repo.sortBy(subs, ['sort_order', 'id']);
    return decorated;
  }

  /**
   * 近期任务（对应 tasks/upcoming）
   * 用于提醒中心：逾期 + 今天 + 未来 N 天
   */
  async function upcoming(days) {
    const n = Math.max(1, Math.min(60, Number(days) || 7));
    const today = V.today();
    const end = V.addDays(today, n);
    const rows = await Repo.byIndex('tasks', 'by_date', IDBKeyRange.upperBound(end));
    const live = scopeFilter(await decorate(rows)).filter(t => t.status !== 'completed');

    const overdue = live.filter(t => t.task_date && t.task_date < today);
    const todayItems = live.filter(t => t.task_date === today);
    const soon = live.filter(t => t.task_date && t.task_date > today && t.task_date <= end);

    return {
      overdue: Repo.sortBy(overdue, ['task_date', 'start_time']),
      today: Repo.sortBy(todayItems, ['start_time', 'id']),
      soon: Repo.sortBy(soon, ['task_date', 'start_time']),
      days: n,
    };
  }

  /* ------------------------------------------------------------
   * 循环任务
   * ------------------------------------------------------------ */

  /**
   * 计算循环日期集合（对应 PHP recurrenceDates）
   *
   * 边界处理：
   *   - monthly 遇到 31 号在小月时取当月最后一天（不跳过）
   *   - daily/weekly 最多生成 400 个（防止用户把结束日期设到 2099 年）
   *   - end <= start 时不生成
   */
  function recurrenceDates(rule, start, end) {
    const out = [];
    if (['daily', 'weekly', 'monthly'].indexOf(rule) < 0) return out;
    const s = V.date(start);
    const e = V.date(end);
    if (e <= s) return out;

    if (rule === 'monthly') {
      const day = Number(s.slice(8, 10));
      let [y, m] = [Number(s.slice(0, 4)), Number(s.slice(5, 7))];
      for (let i = 0; i < 60; i++) {
        m++;
        if (m > 12) { m = 1; y++; }
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const useDay = Math.min(day, lastDay);
        const cur = y + '-' + V.pad2(m) + '-' + V.pad2(useDay);
        if (cur > e) break;
        out.push(cur);
      }
      return out;
    }

    const step = rule === 'daily' ? 1 : 7;
    let cur = V.addDays(s, step);
    let guard = 0;
    while (cur <= e && guard++ < 400) {
      out.push(cur);
      cur = V.addDays(cur, step);
    }
    return out;
  }

  /** 删除某模板的全部/未完成实例，并清理附属数据 */
  async function deleteInstances(templateId, all) {
    const tid = Number(templateId);
    const rows = await Repo.byIndex('tasks', 'by_parent', tid);
    const targets = all ? rows : rows.filter(r => r.status !== 'completed');
    if (!targets.length) return 0;

    const ids = targets.map(r => Number(r.id));
    const idSet = new Set(ids);

    await DB.write(['tasks', 'subtasks', 'tags', 'task_assignees'], async (c) => {
      const [subs, tags, asg] = await Promise.all([
        c.getAll('subtasks'), c.getAll('tags'), c.getAll('task_assignees'),
      ]);
      for (const s of subs) if (idSet.has(Number(s.task_id))) await c.del('subtasks', s.id);
      for (const t of tags) if (idSet.has(Number(t.task_id))) await c.del('tags', t.id);
      for (const a of asg) if (idSet.has(Number(a.task_id))) await c.del('task_assignees', a.id);
      for (const id of ids) await c.del('tasks', id);
    });

    return ids.length;
  }

  /** 生成循环实例 */
  async function generateInstances(templateId, tpl, coIds) {
    const rule = tpl.recurrence || 'none';
    if (['daily', 'weekly', 'monthly'].indexOf(rule) < 0) return 0;

    const start = V.date(tpl.task_date);
    const end = tpl.recurrence_end_date
      ? V.date(tpl.recurrence_end_date)
      : V.addDays(start, 60);

    const dates = recurrenceDates(rule, start, end);
    if (!dates.length) return 0;

    // 已有实例日期，避免重复生成
    const existing = await Repo.byIndex('tasks', 'by_parent', Number(templateId));
    const have = new Set(existing.map(r => r.task_date));

    // 结束日期偏移（多天任务整体后移）
    const offset = (tpl.end_date && tpl.task_date) ? Math.max(0, V.diffDays(tpl.end_date, tpl.task_date)) : 0;

    const tags = await Repo.byIndex('tags', 'by_task', Number(templateId));
    const tagList = tags.map(t => t.tag);
    const coList = (coIds || []).filter(n => n > 0);

    const todo = dates.filter(d => !have.has(d));
    if (!todo.length) return 0;

    await DB.write(['tasks', 'task_assignees', 'tags'], async (c) => {
      for (const d of todo) {
        const row = {
          plan_id: Number(tpl.plan_id) || 0,
          title: tpl.title,
          description: tpl.description || '',
          time_slot: tpl.time_slot || '',
          start_time: tpl.start_time || null,
          end_time: tpl.end_time || null,
          end_date: offset > 0 ? V.addDays(d, offset) : null,
          status: 'pending',
          assignee_id: Number(tpl.assignee_id) || 0,
          priority: tpl.priority || 'medium',
          recurrence: 'none',              // 实例本身不再循环
          recurrence_end_date: null,
          recurrence_parent_id: Number(templateId),
          task_date: d,
          sort_order: 0,
          deleted: false,
          created_at: S.nowStr(),
          updated_at: S.nowStr(),
        };
        const id = await c.add('tasks', row);
        for (const uid of coList) {
          await c.add('task_assignees', { task_id: id, user_id: uid });
        }
        for (const tag of tagList) {
          await c.add('tags', { task_id: id, tag });
        }
      }
    });

    return todo.length;
  }

  /** 把模板改动同步到未完成的实例（保留各自日期与状态） */
  async function syncInstances(templateId, data, coIds, excludeId) {
    const rows = await Repo.byIndex('tasks', 'by_parent', Number(templateId));
    const targets = rows.filter(r =>
      r.status !== 'completed' && Number(r.id) !== Number(excludeId || 0)
    );
    if (!targets.length) return 0;

    const offset = (data.end_date && data.task_date) ? Math.max(0, V.diffDays(data.end_date, data.task_date)) : 0;
    const coList = (coIds || []).filter(n => n > 0);

    await DB.write(['tasks', 'task_assignees'], async (c) => {
      for (const t of targets) {
        const row = Object.assign({}, t, {
          plan_id: Number(data.plan_id) || 0,
          title: data.title,
          description: data.description || '',
          time_slot: data.time_slot || '',
          start_time: data.start_time || null,
          end_time: data.end_time || null,
          end_date: offset > 0 ? V.addDays(t.task_date, offset) : null,
          priority: data.priority,
          assignee_id: Number(data.assignee_id) || 0,
          updated_at: S.nowStr(),
        });
        await c.put('tasks', row);
        // 重置协助人
        const oldAsg = await c.index('task_assignees', 'by_task', Number(t.id));
        for (const a of oldAsg) await c.del('task_assignees', a.id);
        for (const uid of coList) {
          await c.add('task_assignees', { task_id: Number(t.id), user_id: uid });
        }
      }
    });

    return targets.length;
  }

  /* ------------------------------------------------------------
   * 写操作
   * ------------------------------------------------------------ */

  /**
   * 保存任务（新建或编辑）
   *
   * @param {object} input  表单数据
   * @returns {Promise<object>}
   */
  async function save(input) {
    const me = window.Auth.currentUser();
    if (!me) throw new E.AppError('请先登录', 'E_AUTH');

    const id = V.idLoose(input.id);
    if (!id && !window.Auth.can('plans', 'add')) {
      throw new E.AppError('您没有新建任务的权限', 'E_PERM');
    }

    const title = V.required(input.title, 'title', '任务标题');
    V.maxLen(title, 255, 'title', '任务标题');

    const recurrence = V.oneOf(input.recurrence, S.ENUMS.recurrence, 'none');
    const recEnd = input.recurrence_end_date ? V.date(input.recurrence_end_date, null) : null;
    const taskDate = V.date(input.task_date, V.today());
    let endDate = input.end_date ? V.date(input.end_date, null) : null;
    // 结束日期早于任务日期视为非法，直接忽略（不猜用户意图）
    if (endDate !== null && endDate < taskDate) endDate = null;

    // 时间段必须在配置内
    const slots = window.Settings.periodNames();
    const slot = slots.indexOf(input.time_slot) >= 0 ? input.time_slot : (slots[0] || '上午');

    const data = {
      plan_id: V.idLoose(input.plan_id),
      title,
      description: String(input.description || ''),
      time_slot: slot,
      start_time: V.time(input.start_time),
      end_time: V.time(input.end_time),
      end_date: endDate,
      status: V.oneOf(input.status, S.ENUMS.taskStatus, 'pending'),
      assignee_id: V.idLoose(input.assignee_id) || Number(me.id),
      priority: V.oneOf(input.priority, S.ENUMS.priority, 'medium'),
      recurrence,
      recurrence_end_date: recEnd,
      task_date: taskDate,
    };

    const coIds = V.idList(input.co_assignees, 50).filter(n => n !== data.assignee_id);
    const tags = V.tagList(input.tags, 10, 32);

    if (id) {
      return updateExisting(id, data, coIds, tags);
    }
    return createNew(data, coIds, tags);
  }

  /** 新建 */
  async function createNew(data, coIds, tags) {
    let createdId = 0;

    await DB.write(['tasks', 'task_assignees', 'tags'], async (c) => {
      const row = Object.assign({}, data, {
        recurrence_parent_id: 0,
        sort_order: 0,
        deleted: false,
        created_at: S.nowStr(),
        updated_at: S.nowStr(),
      });
      createdId = await c.add('tasks', row);
      for (const uid of coIds) {
        await c.add('task_assignees', { task_id: createdId, user_id: uid });
      }
      for (const tag of tags) {
        await c.add('tags', { task_id: createdId, tag });
      }
    });

    // 循环任务：生成实例（在单独事务里做，失败不回滚主任务）
    if (data.recurrence !== 'none') {
      try {
        await generateInstances(createdId, data, coIds);
      } catch (e) {
        E.Log.warn('task', '循环实例生成失败：' + e.message);
        // 主任务已建成，实例失败不算整体失败，只提示
        window.UI && window.UI.toast('任务已创建，但循环实例生成失败', 'warn');
      }
    }

    Repo.emitChange('tasks', 'create', createdId);
    window.OpLog && window.OpLog.write('新建任务', String(createdId), data.title);
    return get(createdId);
  }

  /** 编辑 */
  async function updateExisting(id, data, coIds, tags) {
    const existing = await Repo.get('tasks', id);
    if (!existing) throw new E.AppError('任务不存在或已被删除', 'E_NOTFOUND');

    const decorated = await get(id);
    if (!canEdit(decorated)) throw new E.AppError('您没有编辑该任务的权限', 'E_PERM');

    const isTemplate = Number(existing.recurrence_parent_id || 0) === 0;
    const oldRec = existing.recurrence;
    const oldRecEnd = existing.recurrence_end_date || '';

    await DB.write(['tasks', 'task_assignees', 'tags'], async (c) => {
      const cur = await c.get('tasks', id);
      if (!cur) throw new E.AppError('任务不存在', 'E_NOTFOUND');

      const patch = Object.assign({}, data, { updated_at: S.nowStr() });
      // 实例不写循环字段，避免反向污染模板语义
      if (!isTemplate) {
        delete patch.recurrence;
        delete patch.recurrence_end_date;
      }
      await c.put('tasks', Object.assign(cur, patch));

      // 重置协助人与标签
      const oldAsg = await c.index('task_assignees', 'by_task', id);
      for (const a of oldAsg) await c.del('task_assignees', a.id);
      for (const uid of coIds) {
        await c.add('task_assignees', { task_id: id, user_id: uid });
      }

      const oldTags = await c.index('tags', 'by_task', id);
      for (const t of oldTags) await c.del('tags', t.id);
      for (const tag of tags) {
        await c.add('tags', { task_id: id, tag });
      }
    });

    // 循环相关同步（主事务外做，失败不回滚已保存内容）
    try {
      if (isTemplate) {
        const changed = oldRec !== data.recurrence || oldRecEnd !== (data.recurrence_end_date || '');
        if (data.recurrence === 'none') {
          await deleteInstances(id, false);          // 只删未完成的，保留历史记录
        } else if (changed) {
          await deleteInstances(id, true);           // 规则变了，全部重建
          await generateInstances(id, data, coIds);
        } else {
          await syncInstances(id, data, coIds);      // 规则没变，同步内容
        }
      } else {
        // 编辑的是实例：把公共属性同步回模板与兄弟实例
        const parentId = Number(existing.recurrence_parent_id);
        const parent = await Repo.get('tasks', parentId);
        if (parent) {
          await DB.write(['tasks'], async (c) => {
            const fresh = await c.get('tasks', parentId);
            if (!fresh) return;
            const common = Object.assign({}, data, { task_date: fresh.task_date, updated_at: S.nowStr() });
            delete common.status;
            delete common.recurrence;
            delete common.recurrence_end_date;
            await c.put('tasks', Object.assign(fresh, common));
          });

          const changed = parent.recurrence !== data.recurrence
            || (parent.recurrence_end_date || '') !== (data.recurrence_end_date || '');
          if (data.recurrence === 'none') {
            await deleteInstances(parentId, true);
            await DB.write(['tasks'], async (c) => {
              const f = await c.get('tasks', parentId);
              if (f) {
                f.recurrence = 'none';
                f.recurrence_end_date = null;
                await c.put('tasks', f);
              }
            });
          } else if (changed) {
            await deleteInstances(parentId, true);
            await DB.write(['tasks'], async (c) => {
              const f = await c.get('tasks', parentId);
              if (f) {
                f.recurrence = data.recurrence;
                f.recurrence_end_date = data.recurrence_end_date;
                await c.put('tasks', f);
              }
            });
            await generateInstances(parentId, Object.assign({}, data, { task_date: parent.task_date }), coIds);
          } else {
            await syncInstances(parentId, data, coIds, id);
          }
        }
      }
    } catch (e) {
      E.Log.warn('task', '循环同步失败：' + e.message);
    }

    Repo.emitChange('tasks', 'update', id);
    window.OpLog && window.OpLog.write('编辑任务', String(id), data.title);
    return get(id);
  }

  /** 删除（默认连带整条循环链） */
  async function remove(id, single) {
    const tid = V.idLoose(id);
    const task = await Repo.get('tasks', tid);
    if (!task) throw new E.AppError('任务不存在', 'E_NOTFOUND');

    const decorated = await get(tid);
    if (!canEdit(decorated)) throw new E.AppError('您没有删除该任务的权限', 'E_PERM');
    if (!window.Auth.can('plans', 'delete')
        && Number(task.assignee_id) !== window.Auth.currentUserId()) {
      throw new E.AppError('您没有删除该任务的权限', 'E_PERM');
    }

    const parentId = Number(task.recurrence_parent_id || 0);
    let removed = 0;

    if (single && parentId > 0) {
      // 只删这一条实例
      await DB.write(['tasks', 'subtasks', 'tags', 'task_assignees'], async (c) => {
        const [subs, tags, asg] = await Promise.all([
          c.index('subtasks', 'by_task', tid),
          c.index('tags', 'by_task', tid),
          c.index('task_assignees', 'by_task', tid),
        ]);
        for (const x of (subs || [])) await c.del('subtasks', x.id);
        for (const x of (tags || [])) await c.del('tags', x.id);
        for (const x of (asg || [])) await c.del('task_assignees', x.id);
        await c.del('tasks', tid);
      });
      removed = 1;
    } else {
      const target = parentId > 0 ? parentId : tid;
      removed = await deleteInstances(target, true);
      await DB.write(['tasks', 'subtasks', 'tags', 'task_assignees'], async (c) => {
        const [subs, tags, asg] = await Promise.all([
          c.index('subtasks', 'by_task', target),
          c.index('tags', 'by_task', target),
          c.index('task_assignees', 'by_task', target),
        ]);
        for (const x of (subs || [])) await c.del('subtasks', x.id);
        for (const x of (tags || [])) await c.del('tags', x.id);
        for (const x of (asg || [])) await c.del('task_assignees', x.id);
        await c.del('tasks', target);
      });
      removed += 1;
    }

    Repo.emitChange('tasks', 'delete', tid);
    window.OpLog && window.OpLog.write('删除任务', String(tid), task.title);
    return { removed };
  }

  /**
   * 切换完成状态
   *
   * 关键：next 必须在事务内根据当前值计算，不能在事务外算好再写。
   * 早期实现在事务外读一次算出 next，快速连点（或两个标签页同时点）时
   * 所有并发调用都基于同一个旧值，2 次连点会停在 completed 而不是 pending。
   * 实测：2/10 次连点终态错误。改为事务内读取→计算→写回后，行为线性一致。
   */
  async function toggle(id) {
    const tid = V.idLoose(id);

    // 权限校验需要装饰后的数据（含协助人）；这一步只读，不影响并发正确性
    const decorated = await get(tid);
    if (!decorated) throw new E.AppError('任务不存在', 'E_NOTFOUND');
    if (!canEdit(decorated)) throw new E.AppError('您没有修改该任务的权限', 'E_PERM');

    const next = await DB.write('tasks', async (c) => {
      const row = await c.get('tasks', tid);
      if (!row) throw new E.AppError('任务不存在', 'E_NOTFOUND');
      const to = row.status === 'completed' ? 'pending' : 'completed';
      row.status = to;
      row.updated_at = S.nowStr();
      await c.put('tasks', row);
      return to;
    });

    Repo.emitChange('tasks', 'update', tid);
    return { id: tid, status: next };
  }

  /** 批量完成 */
  async function bulkComplete(ids, complete) {
    const list = V.idList(ids, 500);
    if (!list.length) throw new E.AppError('没有选中任何任务', 'E_EMPTY');
    const target = complete === false ? 'pending' : 'completed';

    const n = await DB.write('tasks', async (c) => {
      let count = 0;
      for (const id of list) {
        const row = await c.get('tasks', id);
        if (!row) continue;
        row.status = target;
        row.updated_at = S.nowStr();
        await c.put('tasks', row);
        count++;
      }
      return count;
    });

    Repo.emitChange('tasks', 'update', list);
    window.OpLog && window.OpLog.write(target === 'completed' ? '批量完成任务' : '批量取消完成', String(list.length));
    return { updated: n, ids: list };
  }

  /** 排序（拖拽后调用） */
  async function reorder(orderList) {
    const arr = Array.isArray(orderList) ? orderList : [];
    if (!arr.length) return { updated: 0 };

    const n = await DB.write('tasks', async (c) => {
      let count = 0;
      for (let i = 0; i < arr.length; i++) {
        const id = V.idLoose(arr[i]);
        if (!id) continue;
        const row = await c.get('tasks', id);
        if (!row) continue;
        row.sort_order = i;
        await c.put('tasks', row);
        count++;
      }
      return count;
    });

    Repo.emitChange('tasks', 'reorder', null);
    return { updated: n };
  }

  /* ------------------------------------------------------------
   * 子任务
   * ------------------------------------------------------------ */

  async function saveSubtask(taskId, title) {
    const tid = V.idLoose(taskId);
    if (!tid) throw new E.AppError('任务不存在', 'E_NOTFOUND');
    const t = V.required(title, 'title', '子任务内容');
    V.maxLen(t, 255, 'title', '子任务内容');

    const existing = await Repo.byIndex('subtasks', 'by_task', tid);
    const id = await DB.write('subtasks', (c) => c.add('subtasks', {
      task_id: tid,
      title: t,
      done: 0,
      sort_order: existing.length,
      created_at: S.nowStr(),
    }));

    Repo.emitChange('tasks', 'update', tid);
    return { id };
  }

  async function toggleSubtask(id) {
    const sid = V.idLoose(id);
    const sub = await Repo.get('subtasks', sid);
    if (!sub) throw new E.AppError('子任务不存在', 'E_NOTFOUND');

    const next = sub.done ? 0 : 1;
    await DB.write('subtasks', async (c) => {
      const row = await c.get('subtasks', sid);
      if (!row) return;
      row.done = next;
      await c.put('subtasks', row);
    });

    Repo.emitChange('tasks', 'update', sub.task_id);
    return { id: sid, done: next };
  }

  async function deleteSubtask(id) {
    const sid = V.idLoose(id);
    const sub = await Repo.get('subtasks', sid);
    if (!sub) throw new E.AppError('子任务不存在', 'E_NOTFOUND');

    await DB.write('subtasks', (c) => c.del('subtasks', sid));
    Repo.emitChange('tasks', 'update', sub.task_id);
    return { id: sid };
  }

  /* ------------------------------------------------------------
   * 标签
   * ------------------------------------------------------------ */

  /** 全部标签及使用次数（用于筛选器） */
  async function allTags() {
    const rows = await DB.read('tags', c => c.getAll('tags'));
    const tasks = await Repo.all('tasks');
    const liveIds = new Set(tasks.map(t => Number(t.id)));

    const m = new Map();
    for (const r of rows) {
      if (!liveIds.has(Number(r.task_id))) continue;
      m.set(r.tag, (m.get(r.tag) || 0) + 1);
    }
    return Array.from(m.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
  }

  /** 设置任务的标签（覆盖式） */
  async function saveTags(taskId, tags) {
    const tid = V.idLoose(taskId);
    if (!tid) throw new E.AppError('任务不存在', 'E_NOTFOUND');
    const list = V.tagList(tags, 10, 32);

    await DB.write('tags', async (c) => {
      const old = await c.index('tags', 'by_task', tid);
      for (const t of (old || [])) await c.del('tags', t.id);
      for (const tag of list) {
        await c.add('tags', { task_id: tid, tag });
      }
    });

    Repo.emitChange('tasks', 'update', tid);
    return { tags: list };
  }

  window.TaskRepo = {
    list, get, save, remove, toggle, bulkComplete, reorder, upcoming,
    saveSubtask, toggleSubtask, deleteSubtask,
    allTags, saveTags,
    decorate, scopeFilter, canEdit, statistics,
    recurrenceDates, generateInstances, deleteInstances, syncInstances,
  };
})();
