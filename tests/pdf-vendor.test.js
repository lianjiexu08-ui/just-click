'use strict';

/**
 * 迭代 4 验收 3/6：chunkText 边界、pdf.js vendor 化、无 CDN、
 * 以及「build 之后 dist/vendor/pdfjs 真的存在」。
 *
 * extractPdfText 本身依赖 DOM + pdf.js，Node 里只验证「入口是扩展内 URL」
 * 与「空输入会被拒绝」，真实 PDF 解析留人工验收（docs/MANUAL-TEST.md）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const VENDOR = path.join(ROOT, 'vendor', 'pdfjs');

global.chrome = { runtime: { getURL: (rel) => 'chrome-extension://jc-test/' + rel } };

const Pdf = require('../src/lib/pdf-text.js');
const AI = require('../src/lib/ai.js');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('pdf.js 已 vendor 进仓库（含 LICENSE），不是运行时下载', () => {
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE.md']) {
    const file = path.join(VENDOR, name);
    assert.ok(fs.existsSync(file), `缺少 vendor/pdfjs/${name}`);
    assert.ok(fs.statSync(file).size > 100, `vendor/pdfjs/${name} 看起来是空文件`);
  }
  const license = fs.readFileSync(path.join(VENDOR, 'LICENSE.md'), 'utf8');
  assert.match(license, /Apache/i);
});

test('pdf-text 的模块 / worker 路径都指向扩展内资源', () => {
  assert.equal(Pdf.PDF_MODULE_PATH, 'vendor/pdfjs/pdf.min.mjs');
  assert.equal(Pdf.PDF_WORKER_PATH, 'vendor/pdfjs/pdf.worker.min.mjs');
  assert.equal(Pdf.extensionUrl(Pdf.PDF_WORKER_PATH), 'chrome-extension://jc-test/vendor/pdfjs/pdf.worker.min.mjs');
  const source = fs.readFileSync(path.join(SRC, 'lib', 'pdf-text.js'), 'utf8');
  assert.match(source, /chrome\.runtime\.getURL/);
  assert.ok(!/https?:\/\/[^\s'"]+\.(?:mjs|js)/.test(source), 'pdf-text.js 里不允许出现远程脚本地址');
});

test('chunkText 与 ai.js 同源（空串 / 恰好等于 / 超限）', () => {
  assert.deepEqual(Pdf.chunkText('', 5), AI.chunkText('', 5));
  assert.equal(Pdf.chunkText('abcde', 5).truncated, false);
  const over = Pdf.chunkText('abcdef', 5);
  assert.equal(over.truncated, true);
  assert.equal(over.text, 'abcde');
  assert.equal(Pdf.chunkText('x'.repeat(30001)).limit, 30000);
});

test('文件类型与扫描件判断', () => {
  assert.equal(Pdf.isPdfFile('简历.PDF'), true);
  assert.equal(Pdf.isPdfFile('resume.pdf'), true);
  assert.equal(Pdf.isPdfFile('resume.txt'), false);
  assert.equal(Pdf.isTextFile('resume.TXT'), true);
  assert.equal(Pdf.isTextFile('resume.md'), true);
  assert.equal(Pdf.isTextFile('resume.pdf'), false);
  assert.equal(Pdf.isProbablyScanned('   \n\t '), true);
  assert.equal(Pdf.isProbablyScanned('短'), true);
  assert.equal(Pdf.isProbablyScanned('这是一份可以正常提取文本的简历内容，字数足够长。'), false);
});

test('extractPdfText：空数组 / 无效输入直接报错，不会静默返回空串', async () => {
  await assert.rejects(() => Pdf.extractPdfText(new ArrayBuffer(0)), /为空/);
  await assert.rejects(() => Pdf.extractPdfText(null), /为空/);
});

test('manifest 与 web_accessible_resources 里没有远程资源', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const refs = [
    manifest.action.default_popup,
    manifest.options_ui.page,
    manifest.background.service_worker,
    ...manifest.content_scripts[0].js
  ];
  for (const bundle of manifest.web_accessible_resources || []) {
    refs.push(...(bundle.resources || []));
  }
  for (const ref of refs) {
    assert.ok(!/^https?:/i.test(ref), `manifest 引用了远程资源：${ref}`);
  }
});

test('html 里没有远程 script / link', () => {
  const htmlFiles = walk(SRC).filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length >= 2);
  for (const file of htmlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const refs = [...content.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      assert.ok(!/^https?:/i.test(ref), `${path.relative(SRC, file)} 引用了远程资源：${ref}`);
    }
  }
});

test('全仓库源码里没有 CDN 链接', () => {
  const targets = [SRC, path.join(ROOT, 'scripts')];
  const files = [];
  for (const dir of targets) walk(dir, files);
  files.push(path.join(ROOT, 'README.md'), path.join(ROOT, 'PRD.md'));
  const banned = /(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.|jsdelivr\.net)/i;
  const offenders = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (banned.test(content)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], '这些文件里出现了 CDN 地址：' + offenders.join(', '));
});

test('npm run build 之后 dist/vendor/pdfjs 存在且包含 pdf.js 两个文件', () => {
  const output = execFileSync(process.execPath, [path.join('scripts', 'build.mjs')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.match(output, /dist\/vendor/);
  const distVendor = path.join(ROOT, 'dist', 'vendor', 'pdfjs');
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    assert.ok(fs.existsSync(path.join(distVendor, name)), `dist/vendor/pdfjs/${name} 未生成`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'lib', 'ai.js')), 'dist 里应包含 AI 模块');
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'lib', 'pdf-text.js')), 'dist 里应包含 pdf-text.js');
});

/**
 * 迭代 5 验收 5：build 产物必须带 all_frames、包含 shadow/frames，且没有任何远程资源引用。
 *
 * 「远程资源引用」的判据（刻意写窄，避免把普通字符串误判成 CDN）：
 *   1) html 的 <script src="http(s)://"> / <link href="http(s)://">；
 *   2) JS 里 import("http…") / importScripts("http…")；
 *   3) CSS/JS 里 url(http…) 或 @import http…；
 *   4) 指向远程 .js/.mjs/.css/.woff/.ttf/.png/.jpg/.svg 等可加载资源的 URL 字面量。
 * 允许：chrome-extension:// 自引用、注释/文案里的示例地址（如默认 API baseURL
 * https://api.deepseek.com/v1、输入框 placeholder https://github.com/xxx），以及
 * vendor/ 下第三方库（pdf.js 内部含 XML 命名空间等非资源 URL）。
 */
test('迭代 5：dist 的 all_frames=true、包含 shadow/frames，且无远程资源引用', () => {
  const dist = path.join(ROOT, 'dist');
  const distManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  assert.equal(distManifest.content_scripts[0].all_frames, true);
  // 0.7.0：版本随 package.json / src/manifest.json 同步；这里校验 build 产物不带旧版本
  assert.equal(distManifest.version, '0.7.0');
  assert.ok(fs.existsSync(path.join(dist, 'lib', 'shadow.js')), 'dist/lib/shadow.js 未生成');
  assert.ok(fs.existsSync(path.join(dist, 'lib', 'frames.js')), 'dist/lib/frames.js 未生成');
  assert.ok(fs.existsSync(path.join(dist, 'lib', 'select-match.js')), 'dist/lib/select-match.js 未生成');

  const banned = [
    /<script[^>]+src\s*=\s*["']https?:/i,
    /<link[^>]+href\s*=\s*["']https?:/i,
    /import\s*\(\s*["']https?:/i,
    /importScripts\s*\(\s*["']https?:/i,
    /@import\s+(?:url\()?\s*["']?https?:/i,
    /url\(\s*["']?https?:/i,
    /https?:\/\/[^\s"'`)<>]+\.(?:js|mjs|css|woff2?|ttf|eot|png|jpe?g|gif|svg|webp)\b/i
  ];

  const offenders = [];
  for (const file of walk(dist)) {
    const rel = path.relative(dist, file).split(path.sep).join('/');
    if (rel.startsWith('vendor/')) continue; // 第三方本地库，单独审计
    if (!/\.(js|mjs|html|json|css)$/i.test(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      const match = pattern.exec(content);
      if (match) offenders.push(`${rel}: ${match[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], 'dist 里出现了远程资源引用：\n' + offenders.join('\n'));
});
