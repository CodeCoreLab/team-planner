/* ============================================================
 * tests/verify-hardening.mjs —— 本次加固的专项验证
 *
 * 覆盖三处改动：
 *   1. auth.js：PBKDF2 新格式 + 旧 salt$sha256 格式兼容 + 脱敏账号标记
 *   2. db.js：opts.tolerate 单行容错（不连带中止事务）
 *   3. orgRepo.js：profileSelfSave 白名单式更新（不越权改角色）
 *
 * 运行：node --test tests/verify-hardening.mjs
 * ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

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
  win.crypto = webcrypto;
  win.TextEncoder = TextEncoder;
  const ctx = vm.createContext(win);
  for (const f of files) {
    const code = readFileSync(join(JS, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return win;
}

// ---- 1. auth.js ----
const authWin = loadScripts('core/errors.js', 'core/validate.js', 'data/auth.js');
const Auth = authWin.Auth;

test('PBKDF2：新生成的密码记录是新格式', async () => {
  const stored = await Auth.hashPassword('Str0ngPass!');
  assert.ok(stored.startsWith('pbkdf2$'), `期望 pbkdf2$ 前缀，实际 ${stored}`);
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.ok(Number(parts[1]) >= 100000, '迭代轮数应 >= 100000');
  assert.equal(parts[2].length, 32, '盐应为 16 字节 hex');
  assert.equal(parts[3].length, 64, '派生值应为 32 字节 hex');
});

test('PBKDF2：正确口令校验通过', async () => {
  const stored = await Auth.hashPassword('Str0ngPass!');
  assert.equal(await Auth.verifyPassword('Str0ngPass!', stored), true);
});

test('PBKDF2：错误口令校验失败', async () => {
  const stored = await Auth.hashPassword('Str0ngPass!');
  assert.equal(await Auth.verifyPassword('wrong', stored), false);
});

test('PBKDF2：两次生成同一口令，盐不同 → 哈希不同', async () => {
  const a = await Auth.hashPassword('SamePwd');
  const b = await Auth.hashPassword('SamePwd');
  assert.notEqual(a, b, '盐必须随机');
  assert.equal(await Auth.verifyPassword('SamePwd', a), true);
  assert.equal(await Auth.verifyPassword('SamePwd', b), true);
});

test('旧格式兼容：salt$sha256 仍可校验', async () => {
  // 用旧算法（单次 SHA-256）复算存量数据的哈希
  const salt = '0123456789abcdef0123456789abcdef';
  const plain = 'LegacyPwd1';
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + plain));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const stored = salt + '$' + hash;
  assert.equal(await Auth.verifyPassword(plain, stored), true);
  assert.equal(await Auth.verifyPassword('nope', stored), false);
});

test('脱敏账号标记：isPasswordReset 识别标记值', () => {
  assert.equal(Auth.isPasswordReset(Auth.PWD_RESET_MARK), true);
  assert.equal(Auth.isPasswordReset('salt$hash'), false);
  assert.equal(Auth.isPasswordReset(''), false);
});

test('脱敏账号标记：校验时抛出 E_PWD_RESET 而非静默失败', async () => {
  await assert.rejects(
    () => Auth.verifyPassword('anything', Auth.PWD_RESET_MARK),
    (err) => err.code === 'E_PWD_RESET');
});

test('bcrypt 旧哈希：抛出可读错误', async () => {
  await assert.rejects(
    () => Auth.verifyPassword('x', '$2y$10$abcdefghijklmnopqrstuv'),
    (err) => err.code === 'E_BCRYPT');
});

// ---- 2. db.js：tolerate 语义 ----
const dbSrc = readFileSync(join(JS, 'data', 'db.js'), 'utf8');

test('db.js：put/add/del/clear 接受 opts 透传', () => {
  for (const fn of ['put', 'add', 'del', 'clear']) {
    const re = new RegExp(`${fn}\\(name, [^)]*opts\\)`);
    assert.ok(re.test(dbSrc), `${fn} 应接受 opts 参数`);
  }
});

test('db.js：tolerate 模式下调用 preventDefault 阻止事务中止', () => {
  assert.ok(/tolerate/.test(dbSrc), 'db.js 应含 tolerate 分支');
  assert.ok(/preventDefault/.test(dbSrc), 'tolerate 分支应调用 preventDefault');
  // preventDefault 必须出现在 tolerate 的**条件分支内部**，
  // 而不是只出现在文档注释里 —— 用「分支体」结构来判定。
  const branch = dbSrc.match(/if\s*\(\s*o\.tolerate\s*\)\s*\{([\s\S]{0,800}?)\n\s{4}\}/);
  assert.ok(branch, '应存在 if (o.tolerate) { ... } 分支');
  assert.ok(/preventDefault/.test(branch[1]),
    'preventDefault 必须位于 tolerate 分支体内');
});

// ---- 3. orgRepo.js：profileSelfSave 白名单 ----
const orgSrc = readFileSync(join(JS, 'data', 'orgRepo.js'), 'utf8');

test('orgRepo.js：profileSelfSave 已实现并导出', () => {
  assert.ok(/async function profileSelfSave/.test(orgSrc), '应实现 profileSelfSave');
  assert.ok(/profileSelfSave,/.test(orgSrc), '应加入 exports');
});

test('orgRepo.js：profileSelfSave 只更新 3 个个人字段', () => {
  const m = orgSrc.match(/async function profileSelfSave[\s\S]*?\n  \}/);
  assert.ok(m, '应能定位到 profileSelfSave 函数体');
  const body = m[0];
  assert.ok(/const patch = \{ real_name: realName, email, phone \}/.test(body),
    'patch 应只含 real_name / email / phone');
  assert.ok(!/role_id/.test(body.replace(/\/\/.*$/gm, '')),
    '不应修改 role_id');
  assert.ok(!/department_id/.test(body.replace(/\/\/.*$/gm, '')),
    '不应修改 department_id');
});
