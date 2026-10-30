/* ============================================================
 * tests/verify-fileio-script.mjs —— data.js 序列化防注入专项验证
 *
 * data.js 通过 <script src> 加载：若用户数据里含 "</script>"，
 * JSON.stringify 不转义它，浏览器会在该字面量处提前结束脚本标签，
 * 其后内容可被注入任意标签（script-context 注入）。
 *
 * 修复：toScript() 把 JSON 文本里的 "<" 统一写成 \u003c 转义，
 * 产物中不再出现 "<"，同时回读解析必须无损还原。
 *
 * 运行：node --test tests/verify-fileio-script.mjs
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
  win.document = { createElement: () => ({ style: {} }) };
  win.APP_VERSION = '1.0.3';
  const ctx = vm.createContext(win);
  for (const f of files) {
    const code = readFileSync(join(JS, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return win;
}

const { FileIO } = loadScripts('core/errors.js', 'core/schema.js', 'data/db.js', 'io/fileio.js');

const EVIL = '</script><script>alert(1)</script>';

test('toScript：产物中不出现 </ 字面量（script 标签无法提前闭合）', () => {
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: EVIL }] } });
  assert.ok(!out.includes('</'), '产物含 "</"，可在 HTML 解析中提前闭合 script: ' + out.slice(-200));
});

test('toScript：转义无损，JSON.parse 回读还原原始字符串', () => {
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: EVIL }] } });
  const m = out.match(/window\.__DATA = (.*);\n/s);
  assert.ok(m, '应能提取 JSON 主体');
  const back = JSON.parse(m[1]);
  assert.equal(back.data.tasks[0].title, EVIL, '回读必须与原数据逐字符一致');
});

test('toScript：parse() 容错路径回读一致（当前格式）', () => {
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: EVIL }] } });
  const snap = FileIO.parse(out);
  assert.ok(snap && snap.data, 'parse 应识别当前格式');
  assert.equal(snap.data.tasks[0].title, EVIL);
});

test('toScript：纯 JSON 格式（用户手工另存）回读一致', () => {
  const payload = JSON.stringify({ data: { tasks: [{ id: 1, title: EVIL }] } });
  const snap = FileIO.parse(payload);
  assert.ok(snap && snap.data);
  assert.equal(snap.data.tasks[0].title, EVIL);
});

test('toScript：U+2028/U+2029 被转义（JS 字面量行终止符）', () => {
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: 'a b c' }] } });
  assert.ok(!out.includes(' ') && !out.includes(' '), '行终止符必须转义');
});

test('toScript：普通中文与 emoji 不受影响', () => {
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: '写周报 📝 <普通尖括号>' }] } });
  const snap = FileIO.parse(out);
  assert.equal(snap.data.tasks[0].title, '写周报 📝 <普通尖括号>');
});

test('toScript：嵌套对象/数组中的注入同样被拦截', () => {
  const out = FileIO.toScript({
    schema: 1,
    data: { logs: [{ id: 2, content: { deep: ['x</script>y'] } }] },
  });
  assert.ok(!out.includes('</'));
  const m = out.match(/window\.__DATA = (.*);\n/s);
  assert.equal(JSON.parse(m[1]).data.logs[0].content.deep[0], 'x</script>y');
});

test('XSS 回归：拼接进 HTML 的 data.js 内容不再携带可执行标签边界', () => {
  // 模拟 data.js 被放进 <script>…</script> 块：解析器在此块中遇到 "</script>" 才结束。
  const out = FileIO.toScript({ schema: 1, data: { tasks: [{ id: 1, title: EVIL }] } });
  const html = '<script src="app.js"></script>\n<script>' + out + '</script>';
  // 数据内容中不能出现 "</script>"，否则 html 中的第二个 script 块会提前结束
  const scriptBody = html.slice(html.indexOf('<script>' + '/*') + 8);
  assert.ok(!scriptBody.includes('</script>' + '<'), '数据不得含脚本边界字面量');
});
