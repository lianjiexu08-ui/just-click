'use strict';

/**
 * 迭代 6 配置门禁：不依赖 playwright，也不需要浏览器。
 *
 * 守的是「E2E 基建别悄悄退化」：
 * - package.json 的依赖/脚本契约（e2e 换回旧 AI 脚本、版本漂回 ^ 都算退化）
 * - 四个 mock fixture 的关键字段还在
 * - fixtures 与 run.mjs 里没有远程资源（离线可跑）
 * - e2e 目录不会被打进 dist
 * - run.mjs 必须用 channel: chromium + --load-extension（否则退回 headless shell，扩展不加载）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'e2e', 'fixtures');
const RUNNER = path.join(ROOT, 'tests', 'e2e', 'run.mjs');

const read = (p) => fs.readFileSync(p, 'utf8');
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

/** 远程资源扫描：允许 127.0.0.1 / localhost 与 chrome-extension:// 自引用。 */
function remoteUrlsIn(text) {
  const hits = [];
  const re = /\bhttps?:\/\/[^\s"'<>)]+/gi;
  let m;
  while ((m = re.exec(text))) {
    const url = m[0];
    if (/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url)) continue;
    hits.push(url);
  }
  return hits;
}

test('迭代 6：package.json 锁定 playwright 1.63.0，e2e 指向 run.mjs，e2e:ai 仍是旧 AI 脚本', () => {
  assert.equal(pkg.version, '0.7.0');
  assert.equal(pkg.devDependencies.playwright, '1.63.0', 'playwright 必须是精确版本，不要 ^');
  assert.equal(pkg.scripts.e2e, 'node tests/e2e/run.mjs');
  assert.equal(pkg.scripts['e2e:ai'], 'node scripts/e2e-ai-test.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'e2e-ai-test.mjs')), 'scripts/e2e-ai-test.mjs 被删了');
  assert.ok(fs.existsSync(RUNNER), 'tests/e2e/run.mjs 不存在');
});

test('迭代 6：greenhouse fixture 有四个标准字段 + 开放问题 textarea', () => {
  const greenhouse = read(path.join(FIXTURES, 'greenhouse-mock.html'));
  for (const field of ['job_application[first_name]', 'job_application[last_name]', 'job_application[email]', 'job_application[phone]']) {
    assert.ok(greenhouse.includes(`name="${field}"`), `greenhouse 缺字段 ${field}`);
  }
  assert.match(greenhouse, /<textarea[^>]+name="job_application\[questions\]\[why\]"/, 'greenhouse 缺开放问题 textarea');
  for (const label of ['First name', 'Last name', 'Email', 'Phone', 'Why do you want to work here?']) {
    assert.ok(greenhouse.includes(`>${label}<`), `greenhouse 缺可见 label：${label}`);
  }
  assert.match(greenhouse, /window\.__submitted/, 'greenhouse 提交按钮没有计数钩子');

});

test('迭代 6：zhipin fixture 是 Boss 直聘风格弹窗，三个中文字段', () => {
  const zhipin = read(path.join(FIXTURES, 'zhipin-mock.html'));
  assert.ok(zhipin.includes('dialog-wrap'), 'zhipin 缺 .dialog-wrap 弹窗结构');
  for (const [name, label] of [['name', '姓名'], ['phone', '手机号'], ['email', '邮箱']]) {
    assert.ok(zhipin.includes(`name="${name}"`), `zhipin 缺字段 ${name}`);
    assert.ok(zhipin.includes(`>${label}<`), `zhipin 缺中文 label：${label}`);
  }
});

test('迭代 6：workday 是两层 shadow，iframe 页内嵌 greenhouse', () => {
  const shadow = read(path.join(FIXTURES, 'workday-shadow-mock.html'));
  assert.equal((shadow.match(/attachShadow/g) || []).length, 2, 'workday 必须是两层 shadowRoot');
  assert.match(shadow, /type="password"/, 'workday 缺 password 字段');
  assert.match(shadow, /<script>/, 'workday 必须由内联脚本构建 shadow DOM');

  const iframe = read(path.join(FIXTURES, 'iframe-page.html'));
  assert.match(iframe, /<iframe[^>]+src="greenhouse-mock\.html"/, 'iframe 页缺内嵌 greenhouse');
  assert.ok(iframe.includes('name="company_site"'), 'iframe 父页缺 company_site');
});

test('迭代 6：fixtures 与 run.mjs 不含任何远程资源（离线可跑）', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html')).map((f) => path.join(FIXTURES, f));
  files.push(RUNNER);
  for (const file of files) {
    const hits = remoteUrlsIn(read(file));
    assert.deepEqual(hits, [], `${path.basename(file)} 含远程资源：${hits.join(', ')}`);
  }
});

test('迭代 6：e2e 不进 dist（构建产物里没有任何 e2e 路径）', () => {
  // 在隔离的临时 root 里跑同一份 scripts/build.mjs：既真实执行构建，
  // 又不会和并行跑着的其它 dist 读取型测试抢 dist/。
  //
  // 临时目录刻意放在仓库内（而不是 os.tmpdir()）：CI / 沙箱里系统临时目录
  // 可能不可写（本轮就踩到过 Chromium 在 /var/folders 建 socket 目录失败），
  // 单测不该依赖那种环境假设。用完即删，前缀已进 .gitignore。
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-build-check-'));
  try {
    fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'build.mjs'), path.join(tmp, 'scripts', 'build.mjs'));
    const vendor = path.join(ROOT, 'vendor');
    if (fs.existsSync(vendor)) fs.cpSync(vendor, path.join(tmp, 'vendor'), { recursive: true });

    const build = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'build.mjs')], {
      cwd: tmp,
      encoding: 'utf8'
    });
    assert.equal(build.status, 0, `build 失败：${build.stderr || build.stdout}`);

    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/e2e/i.test(path.relative(tmp, full))) found.push(path.relative(tmp, full));
      }
    };
    walk(path.join(tmp, 'dist'));
    assert.deepEqual(found, [], 'dist 里出现了 e2e 相关路径');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 真实 dist 如果存在，也顺带守一道
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    const walkReal = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkReal(full);
        else assert.ok(!/e2e/i.test(path.relative(dist, full)), `dist 里出现了 ${path.relative(dist, full)}`);
      }
    };
    walkReal(dist);
  }
});

test('迭代 6：run.mjs 用 channel: chromium + --load-extension，且高亮用例等满 2200ms', () => {
  const runner = read(RUNNER);
  assert.match(runner, /channel:\s*'chromium'/, 'run.mjs 必须显式 channel: chromium');
  assert.match(runner, /--load-extension=\$\{DIST\}/, 'run.mjs 必须用 --load-extension 加载 dist');
  assert.match(runner, /--disable-extensions-except=\$\{DIST\}/, 'run.mjs 必须禁用其它扩展');
  assert.match(runner, /headless:\s*true/, 'run.mjs 应默认 headless 跑');
  assert.match(runner, /2200/, '高亮生命周期用例必须等到 2200ms 之后');
  assert.match(runner, /E2E_SUMMARY cases=/, 'run.mjs 必须输出机器可读的 E2E_SUMMARY');
  assert.ok(read(path.join(ROOT, '.gitignore')).includes('tests/e2e/.artifacts/'), '.gitignore 未忽略 E2E 产物');
});
