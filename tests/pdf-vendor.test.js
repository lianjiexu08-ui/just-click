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
