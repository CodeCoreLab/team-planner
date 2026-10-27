/* ============================================================
 * tests/run-tests.mjs —— 无依赖冒烟测试
 *
 * 为什么不用 jest/vitest：
 * 本项目是纯前端、零构建、零 npm 依赖，加测试框架就要引入 node_modules，
 * 与「解压即用、不联网也能跑」的产品定位冲突。
 * 这里用 Node 内置的 node:test + vm 加载经典 script 模块，
 * 依赖为零，克隆仓库后 `node --test tests/` 立刻能跑。
 *
 * 覆盖范围：core/ 层的纯逻辑（校验、错误体系、数据契约）——
 * 这些是最容易被改坏、且坏掉后用户直接受损的部分。
 *
 * 运行：node --test tests/
 * ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = join(HERE, '..', 'src', 'js');

/**
 * 造一个最小浏览器环境并加载经典 script。
 * 这些模块是 IIFE + window 挂载，不依赖 DOM，故 vm 足够。
 */
function loadScripts(...files) {
  const win = {};
  win.window = win;
  win.console = console;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.navigator = { storage: {} };
  // errors.js 会注册全局错误处理器，这里给出最简实现
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  win.location = { href: '' };
  win.document = { createElement: () => ({ style: {} }) };
  const ctx = vm.createContext(win);
  for (const f of files) {
    const code = readFileSync(join(JS, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return win;
}

const win = loadScripts('core/errors.js', 'core/validate.js');
const V = win.Validate;
const E = win.Errors;

/* ------------------------------------------------------------
 * 错误体系
 * ------------------------------------------------------------ */

test('AppError 默认可预期，UI 直接展示文案', () => {
  const err = new E.AppError('出错了', 'E_X');
  assert.equal(err.message, '出错了');
  assert.equal(err.code, 'E_X');
  assert.equal(err.expected, true);
});

test('ValidationError 携带 field，便于 UI 定位输入框', () => {
  const err = new E.ValidationError('标题不能为空', 'title');
  assert.equal(err.field, 'title');
  assert.equal(err.code, 'E_VALIDATION');
});

test('非 AppError 的异常不算可预期', () => {
  assert.notEqual(new TypeError('x').expected, true);
});

/* ------------------------------------------------------------
 * 基础类型转换
 * ------------------------------------------------------------ */

test('asText 拒绝对象而不是返回 [object Object]', () => {
  assert.equal(V.asText(null), '');
  assert.equal(V.asText(undefined), '');
  assert.equal(V.asText(123), '123');
  assert.equal(V.asText(true), 'true');
  assert.throws(() => V.asText({ a: 1 }), E.ValidationError);
});

test('asInt 无法解析时回落默认值', () => {
  assert.equal(V.asInt('42'), 42);
  assert.equal(V.asInt('abc', -1), -1);
  assert.equal(V.asInt(null, 0), 0);
});

test('required 拒绝纯空白', () => {
  assert.throws(() => V.required('   ', 'title', '标题'), E.ValidationError);
  assert.equal(V.required('ok', 'title', '标题'), 'ok');
});

test('maxLen 按字符数（而非字节）判定', () => {
  // '中文abc' 是 5 个字符 / 9 个 UTF-8 字节：
  // 按字符数应放行，按字节则应报错——这里锁定的是「按字符」这一语义
  assert.equal(V.maxLen('中文abc', 5, 'f', '内容'), '中文abc');
  assert.doesNotThrow(() => V.maxLen('中文abc', 5, 'f', '内容'));
  assert.throws(() => V.maxLen('中文abc', 4, 'f', '内容'), E.ValidationError);
  // emoji 按码点计数，算一个字符
  assert.doesNotThrow(() => V.maxLen('🔐🔐', 2, 'f', '内容'));
  assert.throws(() => V.maxLen('🔐🔐', 1, 'f', '内容'), E.ValidationError);
});

test('clip 静默截断，maxLen 显式报错——两者语义不可混用', () => {
  assert.equal(V.clip('abcdef', 3), 'abc');
  assert.throws(() => V.maxLen('abcdef', 3, 'f', '内容'), E.ValidationError);
});

test('oneOf 非法值回落默认值，oneOfStrict 抛错', () => {
  assert.equal(V.oneOf('x', ['a', 'b'], 'a'), 'a');
  assert.throws(() => V.oneOfStrict('x', ['a', 'b'], 'a'), E.ValidationError);
});

/* ------------------------------------------------------------
 * 日期时间
 * ------------------------------------------------------------ */

test('isDate 只接受 YYYY-MM-DD 且校验真实日期', () => {
  assert.equal(V.isDate('2026-10-27'), true);
  assert.equal(V.isDate('2026-13-01'), false);
  assert.equal(V.isDate('2026-02-30'), false);
  assert.equal(V.isDate('2026-1-1'), false);
});

test('dateStrict 对非法日期报错而不是猜成今天', () => {
  assert.throws(() => V.dateStrict('不是日期', 'task_date', '任务日期'), E.ValidationError);
});

test('date 无效时回落到 fallback', () => {
  assert.equal(V.date('2026-01-02', '2026-03-04'), '2026-01-02');
  assert.equal(V.date('乱写', '2026-03-04'), '2026-03-04');
});

test('addDays / diffDays 跨月跨年正确', () => {
  assert.equal(V.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(V.addDays('2026-12-31', 1), '2027-01-01');
  // diffDays 语义是 a - b（后往前为负）
  assert.equal(V.diffDays('2026-01-31', '2026-01-01'), 30);
  assert.equal(V.diffDays('2026-01-01', '2026-01-31'), -30);
  assert.equal(V.diffDays('2027-01-01', '2026-01-01'), 365);
});

test('range 返回闭区间边界', () => {
  const r = V.range('week', '2026-10-27');
  assert.ok(r.start <= '2026-10-27');
  assert.ok(r.end >= '2026-10-27');
  assert.ok(r.start <= r.end);
});

/* ------------------------------------------------------------
 * 标识与业务规则
 * ------------------------------------------------------------ */

test('username 拒绝空格与过短长度', () => {
  assert.throws(() => V.username('ab'), E.ValidationError);
  assert.throws(() => V.username('has space'), E.ValidationError);
});

test('password 长度不足报错', () => {
  assert.throws(() => V.password('123', 'password'), E.ValidationError);
});

test('email 拒绝明显非法格式', () => {
  assert.throws(() => V.email('not-an-email'), E.ValidationError);
  assert.equal(V.email('a@b.com'), 'a@b.com');
});

test('phone 接受手机号与座机，拒绝字母', () => {
  assert.doesNotThrow(() => V.phone('13800138000'));
  assert.throws(() => V.phone('abc'), E.ValidationError);
});

test('progress 被限制在 0~100', () => {
  assert.equal(V.progress(50), 50);
  assert.equal(V.progress(-10), 0);
  assert.equal(V.progress(200), 100);
});

test('idLoose 把非法输入归零而不是抛错', () => {
  assert.equal(V.idLoose('12'), 12);
  assert.equal(V.idLoose('abc'), 0);
  assert.equal(V.idLoose(null), 0);
});

test('tagList 限制数量与单项长度', () => {
  const tags = V.tagList(['a', 'b', 'c'], 2, 5);
  assert.equal(tags.length, 2);
  // 注：数组来自 vm 沙箱 realm，原型与宿主不同，
  // 深比较会因原型不等被判失败，故用 join 做值比较
  assert.equal(tags.join(','), 'a,b');
  // 超长单项是「静默截断到上限」而非丢弃（clip 语义）
  const long = V.tagList(['x'.repeat(50)], 10, 32);
  assert.equal(long.length, 1);
  assert.equal(long[0].length, 32);
  // 去重 + 去空
  assert.equal(V.tagList(['a', 'a', '', '  ', 'b'], 10, 32).join(','), 'a,b');
});
