/**
 * 迭代 6 E2E：真实 Chromium + 已加载的扩展。
 *
 * 关键点：
 * - 必须 channel: 'chromium'。Playwright 默认 headless 走 chromium headless shell，
 *   它不支持扩展，SW 永远不会出现。
 * - 扩展走 --load-extension，DIST 必须是绝对路径。
 * - 沙箱/CI 机器上 macOS 的 /var/folders 可能不可写，Chromium 会在
 *   ProcessSingleton 阶段直接退出（"Failed to create socket directory"）。
 *   Chromium 对此留了 MAC_CHROMIUM_TMPDIR 这个官方逃生口，这里指向可写临时目录，
 *   不改变浏览器行为，只改它放单例 socket 的位置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function prepareUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jc-e2e-profile-'));
}

export function prepareChromiumTmpDir() {
  const dir = path.join(os.tmpdir(), 'jc-e2e-chromium-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 等扩展的 background service worker 起来。
 * @returns {Promise<import('playwright').Worker>}
 */
export async function waitForServiceWorker(context, timeout = 10000) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout });
}

/** SW 可能在用例之间被回收，取不到就等一个新的。 */
export async function getServiceWorker(context) {
  const live = context.serviceWorkers();
  if (live.length) return live[live.length - 1];
  return waitForServiceWorker(context);
}

export function extensionIdOf(worker) {
  const url = worker.url();
  const m = /^chrome-extension:\/\/([^/]+)\//.exec(url);
  if (!m) throw new Error(`无法从 SW URL 解析扩展 ID：${url}`);
  return m[1];
}

/**
 * 在 SW 里执行代码；SW 被回收时重新取一个再试一次。
 */
export async function inServiceWorker(context, fn, arg) {
  let worker = await getServiceWorker(context);
  try {
    return await worker.evaluate(fn, arg);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/closed|Target|destroyed|detached/i.test(msg)) throw e;
    worker = await waitForServiceWorker(context);
    return worker.evaluate(fn, arg);
  }
}
