#!/usr/bin/env node
/**
 * 迭代 6：浏览器 E2E runner。
 *
 * 真实链路：真 Chromium（channel: chromium，非 headless shell）+ 真扩展（--load-extension 指向 dist）
 * + 本地 http mock ATS 站点。填充动作完全复用 popup 的协议：
 *   JC_PING → chrome.scripting.executeScript(allFrames) 枚举 frame → 每 frame 发 JC_FILL。
 * 生产代码里没有任何测试钩子。
 *
 * 退出码：全部通过 0，任一失败 1，构建失败 1。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

import { startFixtureServer, PAGES } from './lib/server.mjs';
import {
  prepareUserDataDir,
  prepareChromiumTmpDir,
  waitForServiceWorker,
  extensionIdOf,
  inServiceWorker
} from './lib/extension.mjs';
import { readByIds, countHighlights, readNestedShadow, readSubmitted } from './lib/dom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const ARTIFACTS = path.join(HERE, '.artifacts');
const CASE_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 10000;

const require = createRequire(import.meta.url);
const JC = require(path.join(ROOT, 'src', 'lib', 'resume-schema.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 简历 */

function buildResume() {
  const resume = JC.createEmptyResume();
  resume.basics.firstName = '三';
  resume.basics.lastName = '张';
  resume.basics.email = 'zhangsan@example.com';
  resume.basics.phone = '13800138000';
  resume.basics.city = '上海';
  resume.summary = '五年后端开发经验，熟悉 Node.js 与分布式系统。';
  resume.presetsSeeded = true;
  const checked = JC.validateResume(resume);
  if (!checked.ok) {
    throw new Error('E2E 简历不合法：' + JSON.stringify(checked.errors));
  }
  return checked.resume;
}

const RESUME = buildResume();
const EXPECT = {
  fullName: JC.resolveValue(RESUME, 'fullName'),
  firstName: JC.resolveValue(RESUME, 'firstName'),
  lastName: JC.resolveValue(RESUME, 'lastName'),
  email: JC.resolveValue(RESUME, 'email'),
  phone: JC.resolveValue(RESUME, 'phone')
};

/* -------------------------------------------------------------- 断言小工具 */

function fail(message) {
  throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function expectTrue(value, label) {
  if (!value) fail(label);
}

/* ------------------------------------------------------------ 浏览器侧封装 */

let context = null;
let server = null;
let extensionId = '';

async function tabIdFor(url) {
  for (let i = 0; i < 40; i++) {
    const id = await inServiceWorker(
      context,
      async (target) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((t) => t.url === target);
        return hit ? hit.id : null;
      },
      url
    );
    if (id !== null && id !== undefined) return id;
    await sleep(250);
  }
  throw new Error('找不到 mock 页 tab：' + url);
}

/** 等所有 frame 的 content script 都能回 JC_PING（document_idle 有延迟）。 */
async function waitForFramesReady(tabId) {
  const deadline = Date.now() + PING_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await inServiceWorker(
      context,
      async (id) => {
        const frames = await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: true },
          func: () => location.href
        });
        const out = [];
        for (const f of frames) {
          const frameId = typeof f.frameId === 'number' ? f.frameId : 0;
          try {
            const res = await chrome.tabs.sendMessage(id, { type: 'JC_PING' }, { frameId });
            out.push({ frameId, frameUrl: f.result, ok: !!(res && res.ok), scanned: res && res.scanned });
          } catch (e) {
            out.push({ frameId, frameUrl: f.result, ok: false, error: String((e && e.message) || e) });
          }
        }
        return out;
      },
      tabId
    );
    if (last.length && last.every((f) => f.ok)) return last;
    await sleep(250);
  }
  throw new Error('JC_PING 超时（10s）：' + JSON.stringify(last));
}

/**
 * 复用 popup 的真实做法：先枚举 frame，再逐 frame 发 JC_FILL。
 * 单 frame 首次可能还没注入好，按 frame 重试。
 */
async function fillAllFrames(tabId, url) {
  return inServiceWorker(
    context,
    async ({ id, resume, pageUrl }) => {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        func: () => location.href
      });
      const results = [];
      for (const f of frames) {
        const frameId = typeof f.frameId === 'number' ? f.frameId : 0;
        let done = false;
        let lastError = null;
        for (let attempt = 0; attempt < 20 && !done; attempt++) {
          try {
            const res = await chrome.tabs.sendMessage(
              id,
              { type: 'JC_FILL', resume, rules: [], url: pageUrl },
              { frameId }
            );
            results.push({ frameId, frameUrl: f.result, result: res });
            done = true;
          } catch (e) {
            lastError = String((e && e.message) || e);
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (!done) results.push({ frameId, frameUrl: f.result, error: lastError });
      }
      return results;
    },
    { id: tabId, resume: RESUME, pageUrl: url }
  );
}

async function seedStorage() {
  await inServiceWorker(
    context,
    async (resume) => {
      await chrome.storage.local.set({ 'jc.resume': resume });
      const bag = await chrome.storage.local.get('jc.resume');
      return !!(bag && bag['jc.resume']);
    },
    RESUME
  );
}

async function openMock(file) {
  const page = await context.newPage();
  const url = server.url(file);
  await page.goto(url, { waitUntil: 'load' });
  const tabId = await tabIdFor(url);
  await waitForFramesReady(tabId);
  return { page, tabId, url };
}

/* -------------------------------------------------------------------- 用例 */

async function caseGreenhouse() {
  const { page, tabId, url } = await openMock(PAGES.greenhouse);
  const frames = await fillAllFrames(tabId, url);
  const main = frames.find((f) => f.frameId === 0);
  expectTrue(main && main.result && main.result.ok, 'JC_FILL 主 frame 未返回 ok：' + JSON.stringify(main));
  expectTrue(main.result.filled >= 4, `主 frame filled=${main.result.filled}，期望 >= 4`);

  const values = await page.evaluate(readByIds, ['first_name', 'last_name', 'email', 'phone', 'why']);
  const highlights = await page.evaluate(countHighlights);
  const submitted = await page.evaluate(readSubmitted);

  expectEqual(values.first_name, EXPECT.firstName, 'First name');
  expectEqual(values.last_name, EXPECT.lastName, 'Last name');
  expectEqual(values.email, EXPECT.email, 'Email');
  expectEqual(values.phone, EXPECT.phone, 'Phone');
  expectTrue(highlights.total > 0, '填充后没有 .jc-filled-highlight 高亮');
  expectEqual(values.why, '', '开放问题 textarea 必须保持为空');
  expectEqual(submitted, 0, '「提交申请」按钮被点了（window.__submitted）');
  await page.close();
  return `filled=${main.result.filled} highlight=${highlights.total}`;
}

async function caseZhipin() {
  const { page, tabId, url } = await openMock(PAGES.zhipin);
  const frames = await fillAllFrames(tabId, url);
  const main = frames.find((f) => f.frameId === 0);
  expectTrue(main && main.result && main.result.ok, 'JC_FILL 主 frame 未返回 ok：' + JSON.stringify(main));

  const values = await page.evaluate(readByIds, ['zp-name', 'zp-phone', 'zp-email']);
  const highlights = await page.evaluate(countHighlights);

  expectEqual(values['zp-name'], EXPECT.fullName, '姓名');
  expectEqual(values['zp-phone'], EXPECT.phone, '手机号');
  expectEqual(values['zp-email'], EXPECT.email, '邮箱');
  expectTrue(highlights.total >= 3, `弹窗内高亮 ${highlights.total} 个，期望 >= 3`);

  const dialog = await page.evaluate(() => {
    const el = document.querySelector('.dialog-wrap');
    return !!(el && el.querySelectorAll('.jc-filled-highlight').length >= 3);
  });
  expectTrue(dialog, '.dialog-wrap 内没有 3 个高亮');
  await page.close();
  return `姓名/手机/邮箱 3 项，highlight=${highlights.total}`;
}

async function caseWorkdayShadow() {
  const { page, tabId, url } = await openMock(PAGES.workday);
  const frames = await fillAllFrames(tabId, url);
  const main = frames.find((f) => f.frameId === 0);
  expectTrue(main && main.result && main.result.ok, 'JC_FILL 主 frame 未返回 ok：' + JSON.stringify(main));

  const shadow = await page.evaluate(readNestedShadow, {
    hostId: 'workday-host',
    innerHostId: 'inner-host',
    ids: ['wd-last', 'wd-first', 'wd-email', 'wd-password']
  });
  expectTrue(!shadow.error, 'shadow 读取失败：' + shadow.error);
  expectEqual(shadow['wd-last'], EXPECT.lastName, 'shadow 姓');
  expectEqual(shadow['wd-first'], EXPECT.firstName, 'shadow 名');
  expectEqual(shadow['wd-email'], EXPECT.email, 'shadow 邮箱');
  expectEqual(shadow['wd-password'], '', 'shadow 内 password 必须保持为空');
  expectTrue(shadow.__innerHighlights > 0, '最内层 shadow 里没有高亮');
  await page.close();
  return `两层 shadow 3 项 + highlight=${shadow.__innerHighlights}`;
}

async function caseIframe() {
  const { page, tabId, url } = await openMock(PAGES.iframe);
  const frames = await fillAllFrames(tabId, url);
  const inner = frames.find((f) => String(f.frameUrl || '').endsWith(PAGES.greenhouse));
  expectTrue(inner, '没有枚举到 iframe 的 frame：' + JSON.stringify(frames.map((f) => f.frameUrl)));
  expectTrue(inner.result && inner.result.ok, 'iframe 内 JC_FILL 未返回 ok：' + JSON.stringify(inner));
  expectTrue(inner.result.filled >= 3, `iframe 内 filled=${inner.result && inner.result.filled}，期望 >= 3`);

  const parent = await page.evaluate(readByIds, ['company_site']);
  expectEqual(parent.company_site, '', '父页「公司官网」被误填');

  const inFrame = page.frames().find((f) => f.url().endsWith(PAGES.greenhouse));
  expectTrue(inFrame, 'page.frames() 里找不到 iframe');
  const iframeValues = await inFrame.evaluate(readByIds, ['first_name', 'last_name', 'email']);
  expectEqual(iframeValues.first_name, EXPECT.firstName, 'iframe 内 First name');
  expectEqual(iframeValues.last_name, EXPECT.lastName, 'iframe 内 Last name');
  expectEqual(iframeValues.email, EXPECT.email, 'iframe 内 Email');
  await page.close();
  return `frameUrl=${inner.frameUrl} filled=${inner.result.filled}，父页保持空`;
}

async function caseHighlightLifetime() {
  const { page, tabId, url } = await openMock(PAGES.greenhouse);
  await fillAllFrames(tabId, url);
  const before = await page.evaluate(countHighlights);
  expectTrue(before.total > 0, '填充后立刻没有高亮（应为 2s 生命周期）');
  await sleep(2200);
  const after = await page.evaluate(countHighlights);
  expectEqual(after.total, 0, `2200ms 后仍有 ${after.total} 个 .jc-filled-highlight`);
  await page.close();
  return `before=${before.total} after=${after.total}`;
}

async function caseReportContract() {
  const { page, tabId, url } = await openMock(PAGES.greenhouse);
  const frames = await fillAllFrames(tabId, url);
  const main = frames.find((f) => f.frameId === 0);
  const res = main && main.result;
  expectTrue(res && res.ok, 'JC_FILL 未返回 ok：' + JSON.stringify(main));
  for (const key of ['filled', 'filledItems', 'notFound', 'missing']) {
    expectTrue(Object.prototype.hasOwnProperty.call(res, key), `响应缺少字段 ${key}`);
  }
  expectTrue(Array.isArray(res.filledItems) && res.filledItems.length > 0, 'filledItems 为空');
  for (const item of res.filledItems) {
    expectTrue(!!item.key, 'filledItem 缺 key：' + JSON.stringify(item));
    expectTrue(!!item.label, 'filledItem 缺 label：' + JSON.stringify(item));
    expectTrue(!!item.value, 'filledItem 缺 value：' + JSON.stringify(item));
  }
  const values = await page.evaluate(readByIds, ['why']);
  expectEqual(values.why, '', '开放问题 textarea 被填了');
  const summaryLabel = JC.labelFor ? JC.labelFor(RESUME, 'summary') : '经历摘要';
  expectTrue(
    res.notFound.indexOf(summaryLabel) !== -1,
    `notFound 里没有开放问题对应的「${summaryLabel}」：${JSON.stringify(res.notFound)}`
  );
  expectTrue(
    res.filledLabels.indexOf(summaryLabel) === -1,
    `开放问题错误地出现在 filledLabels：${JSON.stringify(res.filledLabels)}`
  );
  await page.close();
  return `filledItems=${res.filledItems.length} notFound=${res.notFound.length}`;
}

const CASES = [
  { name: 'greenhouse：4 字段 + 高亮 + 开放问题留空 + 不点提交', run: caseGreenhouse },
  { name: 'Boss 直聘弹窗：姓名/手机/邮箱 + 高亮', run: caseZhipin },
  { name: 'Workday 两层 shadow：内层填充 + password 留空', run: caseWorkdayShadow },
  { name: 'iframe：填充发生在 iframe 内，父页不动', run: caseIframe },
  { name: '高亮生命周期：2200ms 后归零', run: caseHighlightLifetime },
  { name: '报告契约：filled/filledItems/notFound/missing', run: caseReportContract }
];

/* -------------------------------------------------------------------- 主流程 */

function build() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    return false;
  }
  const files = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('dist/')).length;
  console.log(`✔ build 完成（src → dist，${files} 个文件）`);
  return true;
}

async function saveArtifacts(index, page, error) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const base = path.join(ARTIFACTS, `case-${index + 1}`);
  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: base + '.png', fullPage: true });
      fs.writeFileSync(base + '.html', await page.content());
    }
  } catch (e) {
    /* 截图失败不遮蔽原始错误 */
  }
  fs.writeFileSync(base + '.error.txt', String((error && error.stack) || error));
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function main() {
  console.log('▶ E2E：先构建 dist（GGB 门禁里 e2e 早于 build，dist 不进版本库）');
  if (!build()) {
    console.error('✗ build 失败，E2E 退出');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error('✗ dist/manifest.json 不存在，E2E 退出');
    process.exit(1);
  }

  server = await startFixtureServer();
  console.log(`▶ fixtures: ${server.origin}/  （127.0.0.1 随机端口）`);

  context = await chromium.launchPersistentContext(prepareUserDataDir(), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    env: { ...process.env, MAC_CHROMIUM_TMPDIR: prepareChromiumTmpDir() },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const sw = await waitForServiceWorker(context, PING_TIMEOUT_MS);
  extensionId = extensionIdOf(sw);
  console.log(`▶ 扩展已加载：${extensionId}（SW: ${sw.url()}）`);

  await seedStorage();

  let pass = 0;
  let failCount = 0;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const started = Date.now();
    let page = null;
    try {
      const pagesBefore = new Set(context.pages());
      const detail = await withTimeout(c.run(), CASE_TIMEOUT_MS, c.name);
      page = context.pages().find((p) => !pagesBefore.has(p)) || null;
      const ms = Date.now() - started;
      pass++;
      console.log(`✔ [${i + 1}/${CASES.length}] ${c.name} (${ms}ms)${detail ? ' — ' + detail : ''}`);
    } catch (e) {
      failCount++;
      const ms = Date.now() - started;
      const reason = String((e && e.message) || e).split('\n')[0];
      console.log(`✗ [${i + 1}/${CASES.length}] ${c.name} — ${reason} (${ms}ms)`);
      const openPages = context.pages();
      await saveArtifacts(i, openPages[openPages.length - 1], e);
    }
  }

  console.log(`E2E_SUMMARY cases=${CASES.length} pass=${pass} fail=${failCount}`);
  return failCount === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error('✗ E2E 基础设施失败：' + ((e && e.stack) || e));
  exitCode = 1;
} finally {
  try {
    if (context) await context.close();
  } catch (e) {
    /* ignore */
  }
  try {
    if (server) await server.close();
  } catch (e) {
    /* ignore */
  }
}
process.exit(exitCode);
