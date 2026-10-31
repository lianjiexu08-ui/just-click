#!/usr/bin/env node
/**
 * JustClick build —— 零依赖构建
 *
 * 这个 MV3 插件不需要打包器：浏览器直接吃源码。构建做两件事：
 *   1. 校验 manifest.json 与 html 里引用的文件是否真实存在（避免「加载扩展报错」）
 *   2. 把 src/ 原样拷到 dist/，Chrome「加载已解压的扩展程序」指向 dist/
 *
 * 用法：npm run build
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const errors = [];
const checked = [];

function fail(message) {
  errors.push(message);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, base = dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      out.push({ full, rel: path.relative(base, full) });
    }
  }
  return out;
}

/** 校验一个相对 src/ 的文件引用 */
async function checkRef(ref, referrer) {
  if (!ref || /^(https?:|data:|chrome:|#)/i.test(ref)) return;
  const clean = ref.split('?')[0].split('#')[0];
  const target = path.join(SRC, clean);
  checked.push(clean);
  if (!(await exists(target))) {
    fail(`${referrer} 引用了不存在的文件：${clean}`);
  }
}

const KNOWN_KEYS = new Set([
  'manifest_version', 'name', 'version', 'description', 'permissions', 'host_permissions',
  'action', 'options_ui', 'options_page', 'background', 'content_scripts',
  'web_accessible_resources', 'icons', 'minimum_chrome_version', 'default_locale',
  'author', 'homepage_url', 'short_name', 'commands', 'content_security_policy'
]);

async function validateManifest() {
  const manifestPath = path.join(SRC, 'manifest.json');
  if (!(await exists(manifestPath))) {
    fail('缺少 src/manifest.json');
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest.json 不是合法 JSON：${error.message}`);
    return null;
  }

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version 必须是 3，当前为 ${manifest.manifest_version}`);
  }
  for (const key of ['name', 'version']) {
    if (!manifest[key]) fail(`manifest.json 缺少 ${key}`);
  }
  if (!/^\d+\.\d+(\.\d+){0,2}$/.test(String(manifest.version || ''))) {
    fail(`manifest.version 不符合 Chrome 版本号格式：${manifest.version}`);
  }
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_KEYS.has(key)) fail(`manifest.json 含有未知字段（Chrome 会拒绝加载）：${key}`);
  }

  if (manifest.action?.default_popup) await checkRef(manifest.action.default_popup, 'manifest.action.default_popup');
  if (manifest.options_ui?.page) await checkRef(manifest.options_ui.page, 'manifest.options_ui.page');
  if (manifest.options_page) await checkRef(manifest.options_page, 'manifest.options_page');

  if (!manifest.background?.service_worker) {
    fail('manifest.json 缺少 background.service_worker（MV3 要求）');
  } else {
    await checkRef(manifest.background.service_worker, 'manifest.background.service_worker');
  }

  const scripts = manifest.content_scripts?.[0]?.js || [];
  if (!scripts.length) fail('manifest.json 缺少 content_scripts[0].js');
  for (const file of scripts) await checkRef(file, 'manifest.content_scripts');

  for (const bundle of manifest.web_accessible_resources || []) {
    for (const res of bundle.resources || []) await checkRef(res, 'manifest.web_accessible_resources');
  }

  // content script 有加载顺序依赖：schema 必须在 matcher 之前，matcher 必须在 content 之前
  const idx = (name) => scripts.findIndex((s) => s.includes(name));
  if (idx('resume-schema') > idx('field-matcher') || idx('field-matcher') > idx('content/')) {
    fail(`content_scripts 顺序错误，应为 resume-schema → field-matcher → content，当前为 ${scripts.join(' → ')}`);
  }

  if (!manifest.permissions?.includes('storage')) {
    fail('manifest.json 缺少 storage 权限（简历要存 chrome.storage.local）');
  }
  return manifest;
}

/** 校验 html 里的 <script src> / <link href> */
async function validateHtml() {
  const files = await walk(SRC);
  const htmlFiles = files.filter((f) => f.rel.endsWith('.html'));
  for (const file of htmlFiles) {
    const content = await readFile(file.full, 'utf8');
    const refs = [...content.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#|mailto:)/i.test(ref)) continue;
      const resolved = path.relative(SRC, path.resolve(path.dirname(file.full), ref.split('?')[0]));
      checked.push(resolved);
      if (!(await exists(path.join(SRC, resolved)))) {
        fail(`${file.rel} 引用了不存在的文件：${ref}`);
      }
    }
  }
  return files;
}

async function main() {
  const manifest = await validateManifest();
  const files = await validateHtml();

  if (errors.length) {
    console.error('\n✖ 构建校验失败：');
    for (const message of errors) console.error('  - ' + message);
    process.exit(1);
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(SRC, DIST, { recursive: true });

  const bytes = (
    await Promise.all(files.map(async (f) => (await stat(f.full)).size))
  ).reduce((sum, n) => sum + n, 0);

  console.log('✔ manifest.json 校验通过（Manifest V' + manifest.manifest_version + '，v' + manifest.version + '）');
  console.log('✔ ' + new Set(checked).size + ' 个引用文件全部存在');
  console.log('✔ 已产出 dist/（' + files.length + ' 个文件，' + (bytes / 1024).toFixed(1) + ' KB）');
  for (const file of files) console.log('  dist/' + file.rel.split(path.sep).join('/'));
  console.log('\n下一步：Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 dist/ 目录');
  console.log('（源码零依赖，无需 npm install）');
}

main().catch((error) => {
  console.error('构建异常：', error);
  process.exit(1);
});
