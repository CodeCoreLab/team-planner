/* ============================================================
 * tests/verify-escape.mjs —— 模板「默认转义」专项验证
 *
 * 覆盖 ui/kit.js 的本次改造：
 *   renderValue 对普通字符串默认 escape()；
 *   html`` 产物 / raw() / 数组聚合结果走 markSafe 标记对象原样放行；
 *   mount() 与 .toString() 两个消费点都能正确处理标记对象。
 *
 * 与 verify-hardening.mjs 同构：vm 加载经典 script，零 npm 依赖。
 *
 * 运行：node --test tests/verify-escape.mjs
 * ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = join(HERE, '..', 'src', 'js');

function loadScripts(...files) {
  const win = {};
  win.window = win;
  win.console = console;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.navigator = { storage: {} };
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  win.location = { href: '' };
  // kit.js 仅在调用 el()/mount() 时才触 DOM；html``/escape 纯字符串运算
  win.document = { createElement: () => ({ style: {} }) };
  const ctx = vm.createContext(win);
  for (const f of files) {
    const code = readFileSync(join(JS, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return win;
}

const { UI } = loadScripts('core/errors.js', 'ui/kit.js');
const XSS = '<img src=x onerror=alert(1)>';

test('默认转义：未标记字符串插值被 escape', () => {
  const out = String(UI.html`<p>${XSS}</p>`);
  assert.ok(out.includes('&lt;img'), '应输出转义后的实体: ' + out);
  assert.ok(!out.includes('<img'), '不得包含原始标签');
});

test('默认转义：属性位置的引号被转义', () => {
  const out = String(UI.html`<a title="${'x"onmouseover=alert(1)'}"></a>`);
  assert.ok(out.includes('&quot;'), '引号应转义: ' + out);
  assert.ok(!out.includes('onmouseover="'), '不得产生未转义属性断点');
});

test('嵌套 html`` 产物原样输出（不二次转义）', () => {
  const inner = UI.html`<b>加粗</b>`;
  const out = String(UI.html`<div>${inner}</div>`);
  assert.equal(out, '<div><b>加粗</b></div>');
});

test('数组插值：元素是 html`` 产物时逐个放行', () => {
  const arr = ['a', 'b'].map(x => UI.html`<i>${x}</i>`);
  const out = String(UI.html`${arr}`);
  assert.equal(out, '<i>a</i><i>b</i>');
});

test('数组插值：元素是普通字符串时默认转义', () => {
  const out = String(UI.html`${[XSS, 'ok']}`);
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.endsWith('ok'));
});

test('raw() 显式放行', () => {
  const out = String(UI.html`${UI.raw('<u>z</u>')}`);
  assert.equal(out, '<u>z</u>');
});

test('e()()（旧代码的显式转义）与新默认转义叠加后仍安全（双重转义仅显示实体，不产生标签）', () => {
  // 存量代码 e()(x) 先转义成实体字符串，插值时 renderValue 再次转义 & → &amp;
  // 结果在浏览器里显示为「实体原文」而不是标签 —— 安全（多余但无害）。
  const escaped = UI.escape(XSS);
  const out = String(UI.html`${escaped}`);
  assert.ok(!out.includes('<img'), '双重转义后不得出现原始标签: ' + out);
});

test('标记对象可被 mount 消费（__html 通道）——vm 无 DOM，仅验证对象形态', () => {
  const node = UI.html`<p>hi</p>`;
  assert.equal(typeof node.__html, 'string');
  assert.equal(typeof node.toString, 'function');
  assert.equal(String(node), '<p>hi</p>');
});

test('null/undefined/bool 插值为空串', () => {
  assert.equal(String(UI.html`a${null}b${undefined}c${false}d${true}e`), 'abcde');
});

test('number 插值：有限数字原样，NaN/Infinity 置空', () => {
  assert.equal(String(UI.html`${3}`), '3');
  assert.equal(String(UI.html`${NaN}`), '');
  assert.equal(String(UI.html`${Infinity}`), '');
});

test('UI.join：回调返回标记对象时正确拼接', () => {
  const out = String(UI.join(['x', '<y>'], s => UI.html`<em>${s}</em>`));
  assert.equal(out, '<em>x</em><em>&lt;y&gt;</em>');
});

test('XSS 回归：任务标题注入不影响模板结构', () => {
  const title = '"><script>alert(1)</script>';
  const out = String(UI.html`<span class="t">${title}</span>`);
  assert.ok(!out.includes('<script>'), '不得出现可执行的 script 标签');
  assert.ok(out.startsWith('<span class="t">'), '模板结构不被破坏');
});
