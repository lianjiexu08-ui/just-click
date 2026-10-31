'use strict';

/**
 * 结构完整性测试：manifest 与 html 引用的文件必须存在，
 * 否则 Chrome 加载扩展会直接报错（这类问题最不该留到人工验收才暴露）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function srcFile(rel) {
  return path.join(SRC, rel.replace(/^\//, ''));
}

function assertExists(rel, where) {
  assert.ok(fs.existsSync(srcFile(rel)), `${where} 引用的文件不存在：${rel}`);
}

test('manifest 是 MV3 且版本号与 package.json 一致', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version, 'manifest.version 与 package.json version 不一致');
  assert.ok(manifest.name && manifest.name.length > 0);
  assert.ok(manifest.description && manifest.description.length > 0);
});

test('manifest 声明的权限覆盖 MVP 需求', () => {
  for (const permission of ['storage', 'activeTab', 'scripting']) {
    assert.ok(manifest.permissions.includes(permission), `缺少 ${permission} 权限`);
  }
  assert.ok(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0);
});

test('popup / options / service worker 文件都存在', () => {
  assertExists(manifest.action.default_popup, 'action.default_popup');
  assertExists(manifest.options_ui.page, 'options_ui.page');
  assertExists(manifest.background.service_worker, 'background.service_worker');
  assert.equal(manifest.background.type, undefined, 'service worker 使用经典脚本时不应声明 type: module');
});

test('content script 存在且加载顺序正确', () => {
  const scripts = manifest.content_scripts[0].js;
  for (const file of scripts) assertExists(file, 'content_scripts');

  // 迭代 2 起依赖链更长：schema → rules → matcher → learner → content
  const expected = [
    'lib/resume-schema.js',
    'lib/rules.js',
    'lib/field-matcher.js',
    'lib/learner.js',
    'content/content.js'
  ];
  assert.deepEqual(
    scripts.map((s) => s.replace(/^\/+/, '')),
    expected,
    `content_scripts 顺序错误：${scripts.join(' → ')}`
  );
});

test('content script 的匹配范围覆盖 http/https', () => {
  const matches = manifest.content_scripts[0].matches;
  assert.ok(matches.some((m) => m.startsWith('http')), 'content script 必须能在普通网页运行');
});

test('html 里的 script / link 引用都能解析到真实文件', () => {
  const htmlFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(SRC);
  assert.ok(htmlFiles.length >= 2, '至少应有 popup 与 options 两个页面');

  for (const file of htmlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const refs = [...content.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#|mailto:)/i.test(ref)) continue;
      const resolved = path.resolve(path.dirname(file), ref.split('?')[0]);
      assert.ok(fs.existsSync(resolved), `${path.relative(SRC, file)} 引用了不存在的文件：${ref}`);
    }
  }
});

test('src 下的 js 不使用 ES module 语法（content script 只能跑经典脚本）', () => {
  const jsFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
  };
  walk(SRC);

  assert.ok(jsFiles.length >= 4, 'src 下的脚本数量异常');
  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!/^\s*import\s+[\w{*]/m.test(content), `${path.relative(SRC, file)} 含 import 语句`);
    assert.ok(!/^\s*export\s+(default|const|function|\{)/m.test(content), `${path.relative(SRC, file)} 含 export 语句`);
  }
});

test('库文件遵循 UMD 双模导出（可在 Node 里 require）', () => {
  for (const rel of [
    'lib/resume-schema.js',
    'lib/rules.js',
    'lib/field-matcher.js',
    'lib/learner.js',
    'lib/storage.js'
  ]) {
    const content = fs.readFileSync(srcFile(rel), 'utf8');
    assert.ok(content.includes('module.exports'), `${rel} 缺少 module.exports`);
    assert.ok(content.includes('globalThis'), `${rel} 缺少挂载到全局对象的逻辑`);
  }
});
