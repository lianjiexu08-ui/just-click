/**
 * 迭代 6 E2E：本地静态服务。
 *
 * 只服务 tests/e2e/fixtures/ 下的文件，监听 127.0.0.1:0（随机端口）。
 * 必须走 http：content_scripts 的 matches 是 http/https，file:// 页面注入不了。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (e) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    // 只取 basename：禁止 ../ 穿越到 fixtures 之外
    const name = path.basename(pathname);
    const file = path.join(FIXTURES_DIR, name);
    if (!file.startsWith(FIXTURES_DIR + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found: ' + name);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(buf);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: (file) => `http://127.0.0.1:${port}/${file}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export const PAGES = {
  greenhouse: 'greenhouse-mock.html',
  zhipin: 'zhipin-mock.html',
  workday: 'workday-shadow-mock.html',
  iframe: 'iframe-page.html'
};
