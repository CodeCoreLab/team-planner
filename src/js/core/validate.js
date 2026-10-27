/* ============================================================
 * core/validate.js —— 严格输入校验
 *
 * 设计原则：
 *   1. 所有外部输入（表单、URL 参数、导入的数据文件）都必须过这里
 *   2. 校验分两层：类型/格式（硬约束）+ 业务规则（软约束）
 *   3. 失败抛 ValidationError，带 field 让 UI 能定位到具体输入框
 *   4. 校验函数只做判定，不做副作用，便于单元测试
 *
 * 为什么不信任任何输入：
 *   数据文件可以被用户手工编辑，URL hash 可以被随意改写，
 *   导入的备份可能来自老版本。任何假设"数据一定合法"的代码
 *   都会在某个用户的机器上炸掉，而纯前端没有服务端兜底。
 * ============================================================ */

(function () {
  'use strict';

  const V = window.Errors.ValidationError;

  /* ------------------------------------------------------------
   * 基础类型
   * ------------------------------------------------------------ */

  /** 任意值转字符串（null/undefined → ''，对象 → 明确报错而非 [object Object]） */
  function asText(v, field) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new V('字段类型不正确', field);
  }

  /** 转整数（容错：'12abc' → 12，NaN → 默认值；不接受对象/数组） */
  function asInt(v, dflt) {
    const base = dflt === undefined ? 0 : dflt;
    if (v === null || v === undefined || v === '') return base;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : base;
    if (typeof v === 'string') {
      const n = parseInt(v.replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) ? n : base;
    }
    return base;
  }

  /** 转浮点 */
  function asNum(v, dflt) {
    const base = dflt === undefined ? 0 : dflt;
    if (v === null || v === undefined || v === '') return base;
    const n = Number(v);
    return Number.isFinite(n) ? n : base;
  }

  /** 严格布尔 */
  function asBool(v) {
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    return false;
  }

  /* ------------------------------------------------------------
   * 字符串约束
   * ------------------------------------------------------------ */

  /** 必填文本：去首尾空白后不能为空 */
  function required(v, field, label) {
    const s = asText(v, field).trim();
    if (!s) throw new V((label || '此项') + '不能为空', field);
    return s;
  }

  /**
   * 按"字符"截断（不是字节）
   *
   * 用 Array.from 而非 slice：中文一字 3 字节、emoji 4 字节，
   * slice 会把代理对切成两半产生乱码。这与 PHP 版 u_substr 的语义一致。
   */
  function clip(v, max, field) {
    const s = asText(v, field);
    const chars = Array.from(s);
    return chars.length <= max ? s : chars.slice(0, max).join('');
  }

  /** 长度上限校验（超长直接报错，用于用户输入；clip 用于静默截断场景） */
  function maxLen(v, max, field, label) {
    const s = asText(v, field);
    if (Array.from(s).length > max) {
      throw new V((label || '内容') + '过长（最多 ' + max + ' 字）', field);
    }
    return s;
  }

  /** 长度下限 */
  function minLen(v, min, field, label) {
    const s = asText(v, field);
    if (Array.from(s).length < min) {
      throw new V((label || '内容') + '至少 ' + min + ' 个字符', field);
    }
    return s;
  }

  /** 枚举：不在白名单就回落默认值（静默容错，不报错） */
  function oneOf(v, allowed, dflt) {
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }

  /** 枚举严格版：不在白名单就报错 */
  function oneOfStrict(v, allowed, field, label) {
    if (allowed.indexOf(v) < 0) {
      throw new V((label || '取值') + '不合法', field);
    }
    return v;
  }

  /* ------------------------------------------------------------
   * 日期 / 时间
   *
   * 为什么不用 new Date(str) 直接判断：
   *   new Date('2026-13-45') 在部分浏览器返回 Invalid Date，
   *   在另一些浏览器会"自动进位"成 2027-02-14 —— 行为不一致。
   *   纯前端要跨浏览器一致，必须手工校验每个分量。
   * ------------------------------------------------------------ */

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isDate(v) {
    if (typeof v !== 'string') return false;
    const m = DATE_RE.exec(v.trim());
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1900 || y > 2999) return false;
    if (mo < 1 || mo > 12) return false;
    if (d < 1 || d > 31) return false;
    // 用 UTC 构造避免本地时区把日期推前/推后一天
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  /** 合法日期则返回，否则返回 fallback（默认今天） */
  function date(v, fallback) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (isDate(s)) return s;
    if (fallback !== undefined && fallback !== null) {
      const f = String(fallback).trim();
      if (isDate(f)) return f;
    }
    return today();
  }

  /** 严格日期：非法直接报错 */
  function dateStrict(v, field, label) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!isDate(s)) throw new V((label || '日期') + '格式不正确（应为 YYYY-MM-DD）', field);
    return s;
  }

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function isTime(v) {
    return typeof v === 'string' && TIME_RE.test(v.trim());
  }

  /** 时间：非法返回 null（允许"未设置"语义） */
  function time(v) {
    const s = typeof v === 'string' ? v.trim() : '';
    return TIME_RE.test(s) ? s : null;
  }

  function timeStrict(v, field) {
    const s = time(v);
    if (s === null) throw new V('时间格式不正确（应为 HH:MM）', field);
    return s;
  }

  /** 用 UTC 做日期加减，避免夏令时/时区导致的偏移 */
  function addDays(dateStr, n) {
    const s = date(dateStr);
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(n) || 0));
    return fmtUTC(dt);
  }

  function fmtUTC(dt) {
    return dt.getUTCFullYear() + '-'
         + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
         + String(dt.getUTCDate()).padStart(2, '0');
  }

  /** 两个日期相差天数（a - b） */
  function diffDays(a, b) {
    const pa = date(a).split('-').map(Number);
    const pb = date(b).split('-').map(Number);
    const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((ta - tb) / 86400000);
  }

  function today() {
    // 用本地时间（用户看到的"今天"是本地今天，不是 UTC 今天）
    const d = new Date();
    return d.getFullYear() + '-'
         + String(d.getMonth() + 1).padStart(2, '0') + '-'
         + String(d.getDate()).padStart(2, '0');
  }

  /** 星期几：0=周日 … 6=周六 */
  function dayOfWeek(dateStr) {
    const [y, m, d] = date(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** 本周区间（可配置周起始日，默认周一） */
  function weekRange(dateStr, weekStart) {
    const ref = date(dateStr);
    const startDow = weekStart === undefined ? 1 : (Number(weekStart) || 0) % 7; // 1=周一
    const dow = dayOfWeek(ref);
    const back = (dow - startDow + 7) % 7;
    const start = addDays(ref, -back);
    return { start, end: addDays(start, 6) };
  }

  /** ISO 周序号 */
  function weekNumber(dateStr) {
    const s = date(dateStr);
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayNum = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    const fd = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fd + 3);
    return 1 + Math.round((dt - firstThu) / (7 * 86400000));
  }

  /** 周期区间（与 PHP 版 dateRange 口径一致） */
  function range(period, refDate, weekStart) {
    const r = date(refDate);
    const p = oneOf(period, ['day', 'week', 'month', 'quarter', 'year'], 'day');
    if (p === 'day') return { start: r, end: r, type: 'day' };
    if (p === 'week') {
      const w = weekRange(r, weekStart);
      return { start: w.start, end: w.end, type: 'week' };
    }
    const [y, m] = r.split('-').map(Number);
    const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    if (p === 'month') {
      return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(lastDay(y, m))}`, type: 'month' };
    }
    if (p === 'quarter') {
      const q = Math.ceil(m / 3);
      const sm = (q - 1) * 3 + 1;
      const em = q * 3;
      return { start: `${y}-${pad2(sm)}-01`, end: `${y}-${pad2(em)}-${pad2(lastDay(y, em))}`, type: 'quarter' };
    }
    return { start: `${y}-01-01`, end: `${y}-12-31`, type: 'year' };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 日期区间内的工作日数量（按 work_days 配置） */
  function countWorkDays(start, end, workDays) {
    const days = Array.isArray(workDays) && workDays.length ? workDays : [1, 2, 3, 4, 5];
    const allowed = new Set(days.map(Number));
    let n = 0;
    let cur = date(start);
    const stop = date(end);
    let guard = 0;
    while (cur <= stop && guard++ < 3660) {
      // JS dayOfWeek 0=周日；配置里 1=周一…7=周日
      const jsDow = dayOfWeek(cur);
      const cfgDow = jsDow === 0 ? 7 : jsDow;
      if (allowed.has(cfgDow)) n++;
      cur = addDays(cur, 1);
    }
    return n;
  }

  /* ------------------------------------------------------------
   * 标识 / 数组
   * ------------------------------------------------------------ */

  /** 正整数 ID（0 与负数视为无效） */
  function id(v, field) {
    const n = asInt(v, 0);
    if (n <= 0) throw new V('ID 不合法', field || 'id');
    return n;
  }

  /** 宽松 ID：非法返回 0（用于"可选关联"字段） */
  function idLoose(v) {
    const n = asInt(v, 0);
    return n > 0 ? n : 0;
  }

  /** 去重去空的正整数数组 */
  function idList(v, max) {
    const cap = max || 200;
    let arr = v;
    if (typeof arr === 'string') {
      arr = arr.split(/[,，;\s]+/);
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const n = asInt(x, 0);
      if (n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** 标签数组：按逗号/空格拆分、去重、限制长度与数量 */
  function tagList(v, maxCount, maxLenEach) {
    const capN = maxCount || 10;
    const capL = maxLenEach || 32;
    let arr = v;
    if (typeof arr === 'string') {
      arr = arr.split(/[,，;；\s]+/);
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const s = clip(String(x == null ? '' : x).trim(), capL);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
        if (out.length >= capN) break;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------
   * 复用的业务校验
   * ------------------------------------------------------------ */

  const PASSWORD_MIN = 6;
  const PASSWORD_MAX = 128;

  /** 用户名：3-32 位，字母数字下划线点横线，不能纯数字 */
  function username(v) {
    const s = required(v, 'username', '用户名');
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(s)) {
      throw new V('用户名只能用 3-32 位字母、数字、下划线、点或横线', 'username');
    }
    if (/^\d+$/.test(s)) throw new V('用户名不能是纯数字', 'username');
    return s;
  }

  /** 密码：长度校验（强度策略由 UI 提示，不强制） */
  function password(v, field) {
    const s = asText(v, field || 'password');
    if (s.length < PASSWORD_MIN) throw new V('密码至少 ' + PASSWORD_MIN + ' 位', field || 'password');
    if (s.length > PASSWORD_MAX) throw new V('密码过长', field || 'password');
    return s;
  }

  /** 邮箱：允许为空；非空则必须形如 a@b.c */
  function email(v) {
    const s = asText(v, 'email').trim();
    if (!s) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new V('邮箱格式不正确', 'email');
    if (s.length > 120) throw new V('邮箱过长', 'email');
    return s;
  }

  /** 手机号：允许为空；非空则 11 位 1 开头 */
  function phone(v) {
    const s = asText(v, 'phone').trim();
    if (!s) return '';
    if (!/^1[3-9]\d{9}$/.test(s)) throw new V('手机号格式不正确', 'phone');
    return s;
  }

  /** 进度 0-100 */
  function progress(v) {
    const n = asNum(v, 0);
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ------------------------------------------------------------
   * 组合校验器：把一组规则串起来，一次报第一个错
   * ------------------------------------------------------------ */

  function check(value, rules) {
    let v = value;
    for (const r of rules) {
      v = r(v);
    }
    return v;
  }

  window.Validate = {
    // 基础
    asText, asInt, asNum, asBool,
    required, clip, maxLen, minLen, oneOf, oneOfStrict,
    // 日期时间
    isDate, isTime, date, dateStrict, time, timeStrict,
    addDays, diffDays, today, dayOfWeek, weekRange, weekNumber, range,
    pad2, countWorkDays,
    // 标识数组
    id, idLoose, idList, tagList,
    // 业务
    username, password, email, phone, progress,
    PASSWORD_MIN,
    check,
    // 错误类型别名：调用方写 Validate.ValidationError 或 Errors.ValidationError 都行，
    // 避免两套命名造成的隐性断裂
    ValidationError: window.Errors.ValidationError,
    AppError: window.Errors.AppError,
    StorageError: window.Errors.StorageError,
  };

  // 便捷别名（大量调用点用得到）
  window.U = window.U || {};
})();
