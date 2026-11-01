# 迭代 6 交付报告：浏览器 E2E 基建（Playwright + 真扩展 + mock ATS）

版本：**0.7.0**（基线 0.6.1 → 2026-11-02）
执行目录：`/Users/lianjie/.dsh-workbench/executions/89fe1bf8-9435-44f5-9095-a1140d9797dc/workspace`

## 第一屏：四条命令是否绿

| 命令 | 结果 | EXIT | 关键输出 |
| --- | --- | --- | --- |
| `npm test` | ✅ 绿 | `EXIT_TEST=0` | `tests 211 / pass 211 / fail 0`（204 既有 + 7 新增） |
| `npm run smoke` | ✅ 绿 | `EXIT_SMOKE=0` | `smoke 通过：18 项场景全绿` |
| `npm run build` | ✅ 绿 | `EXIT_BUILD=0` | `dist/` 25 个文件 |
| `npm run e2e` | ✅ 绿 | `EXIT_E2E=0` | `E2E_SUMMARY cases=6 pass=6 fail=0` |

**返修前的代码快照（sha256，供对账）**

> 门禁返修只动了 3 个文件（`package.json` 的 test 脚本、`tests/e2e-config.test.js` 的临时目录、`.gitignore`），fixture 已恢复到下表里的 `812001d4…`；返修后四命令实测见第 7 节。

```
1b6685921d8ec962f3ea42dffa0410b129c24144d5bbdfb20aa167c525a96f70  package.json
b297669e9a64e9c7942d6ad708aa5e3c89a738def76112ecde70b9d838a40d1f  src/manifest.json
ae8773ad98e142b1ed29288e045f9069b8a0defa31f191d9af37b98d07f2dad6  tests/e2e/run.mjs
619a1a120b93da195735056e9aefefacb52b1e4f60dfd58f3d4c2ee57280f5be  tests/e2e/fixtures/greenhouse-mock.html
bb86cb0e66425398bbc78da3a97dbb54f25406a8b08ed075a3228c4089a82028  tests/e2e/fixtures/iframe-page.html
812001d474a8a978740beafeb7a29357ec7e9c915aaeb5e4111d376cb5e70926  tests/e2e/fixtures/workday-shadow-mock.html
b07faeda230ee22f0247d7a28af8150ed8bf9942f745855af008804bd2e379b0  tests/e2e/fixtures/zhipin-mock.html
7b4884f99d0292d05b2a9cacc9983a4a8344eb08699a558c2f26339e6318cb37  tests/e2e-config.test.js
```

`find dist -path '*e2e*' | wc -l` → **0**；`node --check` 扫全部新增 js/mjs → **0 个 SYNTAX_FAILED**。

---

## 0. 基线核验（开工前）

```
$ node -v; npm -v
v26.8.1
11.19.0

$ grep -m1 '"version"' package.json src/manifest.json
package.json:  "version": "0.6.1",
src/manifest.json:  "version": "0.6.1",

$ npm test 2>&1 | tail -15
ℹ tests 204
ℹ suites 0
ℹ pass 204
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 298.1765
```

基线 = **204 pass / 0 fail / 0.6.1**，与要求一致，继续。

---

## 1. Phase 0 环境探针（原文）

### 1.1 安装 playwright 1.63.0

第一次按规格命令失败（原始输出）：

```
$ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -D playwright@1.63.0 --prefer-offline --no-audit --no-fund
npm error code EPERM
npm error syscall open
npm error path /Users/lianjie/.npm/_cacache/tmp/***
npm error errno EPERM
npm error Your cache folder contains root-owned files, due to a bug in previous versions of npm which has since been addressed.
npm error To permanently fix this problem, please run:
npm error   sudo chown -R 501:20 "/Users/lianjie/.npm"
npm error Log files were not written due to an error writing to the directory: /Users/lianjie/.npm/_logs
EXIT_INSTALL=1
```

`--offline` 重试（规格允许的第二次尝试）：

```
$ ... npm install -D playwright@1.63.0 --offline --no-audit --no-fund
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/playwright failed: cache mode is 'only-if-cached' but no cached response is available.
EXIT_INSTALL_OFFLINE=1
```

**根因（已用只读探针确认）**：不是包缺失，是 `~/.npm` 在本会话沙箱里**只读**——

```
$ touch ~/.npm/__probe_write
touch: /Users/lianjie/.npm/__probe_write: Operation not permitted
```

而 tarball 与 packument 都在缓存里：

```
$ grep -rh 'playwright' ~/.npm/_cacache/index-v5 | grep -o 'https://registry.npmjs.org/playwright...' | sort -u
https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz
https://registry.npmjs.org/playwright/-/playwright-1.63.0.tgz
```

**处理**：把缓存里这 4 条索引（playwright / playwright-core 的 packument 与 tarball）连同对应 content-v2 blob 镜像到可写的 `/tmp/jc-iter6/npm-cache`（`indexFiles=4 contentFiles=7`），再离线安装：

```
$ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -D playwright@1.63.0 \
    --offline --cache /tmp/jc-iter6/npm-cache --no-audit --no-fund
added 2 packages in 329ms
EXIT_INSTALL=0
```

未下载浏览器、未联网取包；`package-lock.json` 由 npm 生成后交付，并用
`npm install --package-lock-only --offline --cache /tmp/jc-iter6/npm-cache` 复核：
`up to date in 220ms`，`diff` 无变化（lock 与 package.json 一致，`playwright: "1.63.0"`）。

### 1.2 executablePath

```
$ node -e "const {chromium}=require('playwright'); console.log(chromium.executablePath())"
EXEC_PATH=/Users/lianjie/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
EXIT_PROBE2=0
```

指向 `chromium-1243`，与 playwright 1.63 的 browsers.json 对应，无需下载。

### 1.3 真扩展 + SW + JC_PING

第一次启动失败（原文，节选）：

```
browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.
  - [pid=12161][err] ... Failed to create socket directory.
  - [pid=12161][err] ... Aborting now to avoid profile corruption.
```

变体 1（`user-data-dir` 换到短路径 `/tmp/jcp-*`）：同样失败。
变体 2（`TMPDIR` 指向可写目录）：同样失败。只读探针定位到根因：

```
$ mkdir -p /var/folders/tr/.../T/jcprobe
mkdir: /var/folders/.../T/jcprobe: Operation not permitted
```

Chromium 的 `ScopedTempDir::CreateUniqueTempDir`（`process_singleton_posix.cc:1043`）用的是 macOS 系统临时目录（`/var/folders/...`），本会话沙箱只允许写 workspace 与 `/tmp`。查 Chromium 源码确认 macOS 上有一条官方逃生口 `MAC_CHROMIUM_TMPDIR`（`base/files/file_util_apple.mm::GetTempDir` 优先读它）。用它重跑：

```
$ MAC_CHROMIUM_TMPDIR=/tmp/jc-iter6/tmpdir node probe.mjs
DIST=/Users/.../workspace/dist
EXEC=/Users/lianjie/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
BASE=http://127.0.0.1:58335
LAUNCHED in 1010ms
SW_URL=chrome-extension://plckchgpbmdokfmhmlpbihbckpjlgbjl/background/service-worker.js EXT_ID=plckchgpbmdokfmhmlpbihbckpjlgbjl at 1012ms
PING={"tabId":82693035,"res":{"ok":true,"ready":true,"scanned":2}}
EXIT_PROBE=0
```

探针通过（SW 1.0s 出现；本地 http 页面上 `JC_PING` 返回 `{ok:true, ready:true, scanned:2}`）。
`run.mjs` 里以 `env: { ...process.env, MAC_CHROMIUM_TMPDIR: <tmp> }` 固化，**不改变浏览器行为**，只改单例 socket 的落点。

> 说明：这一步不是「用 jsdom 冒充 E2E」——后续全部断言都在真实 Chromium 的 DOM 上读值。

---

## 2. 交付物

### A. package.json / manifest

```json
"version": "0.7.0",
"scripts": {
  "e2e": "node tests/e2e/run.mjs",
  "e2e:ai": "node scripts/e2e-ai-test.mjs"
},
"devDependencies": { "playwright": "1.63.0" }
```

- 精确版本，无 `^`；`scripts/e2e-ai-test.mjs` 原样保留。
- `src/manifest.json` 版本同步 `0.7.0`（`src/` 唯一改动）。
- `package-lock.json` 一起交付（含 playwright + playwright-core 1.63.0）。
- `.gitignore` 追加 `tests/e2e/.artifacts/`。

### B. fixtures（4 个 mock 页，纯静态、零外部资源）

| 文件 | 内容 |
| --- | --- |
| `tests/e2e/fixtures/greenhouse-mock.html` | `job_application[first_name|last_name|email|phone]`，每个 input 有可见 `<label>`；开放问题 `<textarea name="job_application[questions][why]">`（label: Why do you want to work here?）；「提交申请」按钮 `onclick` 累加 `window.__submitted` |
| `tests/e2e/fixtures/zhipin-mock.html` | `.dialog-wrap` 投递弹窗，中文 label 姓名 / 手机号 / 邮箱，`name="name"/"phone"/"email"` |
| `tests/e2e/fixtures/workday-shadow-mock.html` | 一个 host，**两层 `attachShadow`**（内联脚本构建）；最内层姓 / 名 / 邮箱 + 一个 `type="password"`（必须保持空） |
| `tests/e2e/fixtures/iframe-page.html` | 父页「公司官网」`name="company_site"` + `<iframe src="greenhouse-mock.html">` |

### C. runner（`tests/e2e/run.mjs` + `tests/e2e/lib/`）

- `lib/server.mjs`：`node:http` 静态服务，`127.0.0.1:0` 随机端口，只服务 `tests/e2e/fixtures/`（basename + 前缀校验，防目录穿越），`cache-control: no-store`。
- `lib/extension.mjs`：持久化 profile、等 SW（10s）、按 URL 解析扩展 ID、SW 被回收时重取。
- `lib/dom.mjs`：页面侧取值函数（`readByIds` / `countHighlights` 深度遍历 shadow / `readNestedShadow` / `readSubmitted`），全部在浏览器里执行。
- `run.mjs`：
  1. 先 `node scripts/build.mjs`，失败 exit 1；
  2. `chromium.launchPersistentContext(mkdtemp, { channel:'chromium', headless:true, viewport:1280×900, args:[--disable-extensions-except, --load-extension] })`，`DIST` 绝对路径；
  3. 简历：`src/lib/resume-schema.js` 的 `createEmptyResume()` 填 basics（三 / 张 / zhangsan@example.com / 13800138000 / 上海）+ `presetsSeeded:true`，过 `validateResume()`；`chrome.storage.local.set({'jc.resume': resume})`；
  4. 触发：`JC_PING`（10s 重试）→ `chrome.scripting.executeScript({allFrames:true, func:() => location.href})` 枚举 frame → 逐 frame `chrome.tabs.sendMessage({type:'JC_FILL', resume, rules: [], url}, {frameId})`。**没有** `window.__justclick_fill__`，`src/` 行为零改动；
  5. 输出 `✔ [i/6] 名称 (123ms)` / `✗ [i/6] 名称 — 原因`，结尾 `E2E_SUMMARY cases=6 pass=6 fail=0`；失败落截图 + HTML + error.txt 到 `tests/e2e/.artifacts/`；单用例 15s 超时，单条失败不影响后续。

### D. `tests/e2e-config.test.js`（7 条，不依赖 playwright）

1. package.json：`playwright` 精确 1.63.0、`scripts.e2e`、`scripts['e2e:ai']`、旧脚本存在、版本 0.7.0；
2. greenhouse fixture 四字段 + 开放问题 textarea + 可见 label；
3. zhipin fixture `.dialog-wrap` + 三个中文字段；
4. workday 两次 `attachShadow` + password + iframe 页内嵌 greenhouse + `company_site`；
5. fixtures 与 run.mjs 无远程 http(s) 资源（放行 `127.0.0.1` / `localhost`）；
6. 执行 `node scripts/build.mjs` 后遍历 `dist/`，断言无任何含 `e2e` 的路径（在隔离临时 root 里构建，避免与并行跑着的 dist 读取型测试抢 `dist/`；真实 `dist/` 存在时再扫一遍）；
7. run.mjs 含 `channel: 'chromium'` 与 `--load-extension=${DIST}`、`2200`、`E2E_SUMMARY`，且 `.gitignore` 忽略 artifacts。

### E. 文档

- `PRD.md` 迭代 6 末尾新增「## 使用说明（本地跑 E2E）」；
- `README.md` 顶部「迭代 6 新增」小节 + 「开发与验证」补 `npm run e2e` / `npm run e2e:ai`，测试计数同步 211；
- `docs/ACCEPTANCE.md` 追加迭代 6 四条验收对照表 + 本轮实测记录；
- `tests/pdf-vendor.test.js:154` 版本断言 `0.6.1` → `0.7.0`（唯一改动的旧断言）。

---

## 3. 交付前原始输出

### 3.1 `npm test`

```
ℹ tests 211
ℹ suites 0
ℹ pass 211
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 324.529875
EXIT_TEST=0
```

### 3.2 `npm run smoke`

```
  ✓ liepin 表单 → fullName@liepin, phone@liepin, email@liepin
  ✓ 中文「期望薪资」→ expected_salary（字典命中，ats null；缺值进 missing，给值可填）
  ✓ Greenhouse 完整表单：3 填入 / 1 missing / 1 notFound / 开放问题排除

smoke 通过：18 项场景全绿（单字段 5 + 站点单字段 6 + 站点表单 5 + 中文薪资 1 + Greenhouse 表单 1）。
EXIT_SMOKE=0
```

### 3.3 `npm run build`

```
  dist/popup/popup.css
  dist/popup/popup.html
  dist/popup/popup.js

下一步：Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 dist/ 目录
（源码零依赖，无需 npm install）
EXIT_BUILD=0
```

### 3.4 `npm run e2e`

```
▶ E2E：先构建 dist（GGB 门禁里 e2e 早于 build，dist 不进版本库）
✔ build 完成（src → dist，25 个文件）
▶ fixtures: http://127.0.0.1:58991/  （127.0.0.1 随机端口）
▶ 扩展已加载：plckchgpbmdokfmhmlpbihbckpjlgbjl（SW: chrome-extension://plckchgpbmdokfmhmlpbihbckpjlgbjl/background/service-worker.js）
✔ [1/6] greenhouse：4 字段 + 高亮 + 开放问题留空 + 不点提交 (755ms) — filled=4 highlight=4
✔ [2/6] Boss 直聘弹窗：姓名/手机/邮箱 + 高亮 (641ms) — 姓名/手机/邮箱 3 项，highlight=3
✔ [3/6] Workday 两层 shadow：内层填充 + password 留空 (285ms) — 两层 shadow 3 项 + highlight=3
✔ [4/6] iframe：填充发生在 iframe 内，父页不动 (187ms) — frameUrl=http://127.0.0.1:58991/greenhouse-mock.html filled=4，父页保持空
✔ [5/6] 高亮生命周期：2200ms 后归零 (2271ms) — before=4 after=0
✔ [6/6] 报告契约：filled/filledItems/notFound/missing (93ms) — filledItems=4 notFound=3
E2E_SUMMARY cases=6 pass=6 fail=0
EXIT_E2E=0
```

### 3.5 语法 / dist / hash

```
$ for f in tests/e2e/run.mjs tests/e2e/lib/*.mjs tests/e2e-config.test.js scripts/*.mjs; do node --check "$f" || echo "SYNTAX_FAILED $f"; done
SYNTAX_SCAN_DONE        # 无 SYNTAX_FAILED

$ find dist -path '*e2e*' | wc -l
0

$ shasum -a 256 package.json src/manifest.json tests/e2e/run.mjs tests/e2e/fixtures/*.html tests/e2e-config.test.js
1b6685921d8ec962f3ea42dffa0410b129c24144d5bbdfb20aa167c525a96f70  package.json
b297669e9a64e9c7942d6ad708aa5e3c89a738def76112ecde70b9d838a40d1f  src/manifest.json
ae8773ad98e142b1ed29288e045f9069b8a0defa31f191d9af37b98d07f2dad6  tests/e2e/run.mjs
619a1a120b93da195735056e9aefefacb52b1e4f60dfd58f3d4c2ee57280f5be  tests/e2e/fixtures/greenhouse-mock.html
bb86cb0e66425398bbc78da3a97dbb54f25406a8b08ed075a3228c4089a82028  tests/e2e/fixtures/iframe-page.html
812001d474a8a978740beafeb7a29357ec7e9c915aaeb5e4111d376cb5e70926  tests/e2e/fixtures/workday-shadow-mock.html
b07faeda230ee22f0247d7a28af8150ed8bf9942f745855af008804bd2e379b0 tests/e2e/fixtures/zhipin-mock.html
7b4884f99d0292d05b2a9cacc9983a4a8344eb08699a558c2f26339e6318cb37  tests/e2e-config.test.js
```

---

## 4. 负向对照（证明断言不是恒真）

把 greenhouse 首个字段的 `id` / `name` / label 同时改成 `given_name` / `Given name`（即彻底断开所有识别线索）后重跑：

```
✔ [2/6] Boss 直聘弹窗：姓名/手机/邮箱 + 高亮 (317ms)
✗ [1/6] greenhouse：4 字段 + 高亮 + 开放问题留空 + 不点提交 — First name 期望 "三"，实际 null (139ms)
✗ [4/6] iframe：填充发生在 iframe 内，父页不动 — iframe 内 First name 期望 "三"，实际 null (196ms)
✗ [5/6] 高亮生命周期：2200ms 后归零 — 填充后立刻没有高亮（应为 2s 生命周期） (137ms)
E2E_SUMMARY cases=6 pass=3 fail=3
EXIT_E2E_NEGATIVE=1
tests/e2e/.artifacts/: case-1.{png,html,error.txt} case-4.* case-5.*
```

恢复 fixture 后重跑 6/6 全绿（见 3.4）。产物已清理，`.artifacts/` 不进交付。

> 另一个观察值得记录：只改 `name` 属性、或只改 label、或只改 `id` 时，字段仍能被填充（识别器会同时看 label / id / name 三路线索）。这解释了为什么单改一处无法造出失败——也说明 matcher 的线索冗余确实生效。

---

## 5. 已知限制 / 环境说明

1. **本会话 npm registry 不可用**：`registry.npmjs.org` 解析被拦，且 `~/.npm` 只读。playwright 从本地 npm 缓存的**最小镜像**离线安装（未联网取包）。在有网机器上直接 `npm install` 即可；`package-lock.json` 已交付，`npm ci` 可复现。
2. **Chromium 启动需要 `MAC_CHROMIUM_TMPDIR`**：本会话沙箱禁止写 macOS 系统临时目录 `/var/folders/...`，Chromium 的 ProcessSingleton 在创建 socket 目录时直接退出。`run.mjs` 把该官方环境变量指向可写临时目录（`os.tmpdir()/jc-e2e-chromium-tmp`）。在普通开发机/CI 上不设置也能跑，代码里只是「兜底设置」。
3. **headless 但非 headless shell**：必须 `channel: 'chromium'`。若有人改回默认 launch，SW 不会出现，`E2E_SUMMARY` 会直接失败——`tests/e2e-config.test.js` 守住这一点。
4. **mock 页不是真实站点**：断言覆盖 DOM 结构、shadow 穿透、iframe 多 frame、消息报告契约，但**不代表** Greenhouse/Boss/Workday 线上 DOM 已逐一回归；线上结构变更仍需 `docs/MANUAL-TEST.md` 的人工流程兜底。
5. **报告契约里「开放问题」的落点**：`notFound` 是字段 key 维度的清单，所以开放问题表现为「`经历摘要`（summary）在 `notFound` 且不在 `filledLabels`」，同时页面上 textarea 值为空。三件事在 C1/C6 都被断言。
6. `npm run e2e:ai` 保持旧语义（真实 API Key），本轮未执行，不作为本轮证据。

---

## 6. 改动清单

```
M  package.json                      0.7.0 / e2e / e2e:ai / playwright 1.63.0
M  package-lock.json                 新增（playwright + playwright-core 1.63.0）
M  src/manifest.json                 version 0.7.0（src/ 唯一改动）
M  .gitignore                        + tests/e2e/.artifacts/
M  tests/pdf-vendor.test.js:154      0.6.1 → 0.7.0（唯一改动的旧断言）
M  PRD.md                            迭代 6「使用说明（本地跑 E2E）」
M  README.md                         迭代 6 新增 + 开发与验证
M  docs/ACCEPTANCE.md                迭代 6 验收对照 + 实测记录
A  tests/e2e/run.mjs
A  tests/e2e/lib/server.mjs
A  tests/e2e/lib/extension.mjs
A  tests/e2e/lib/dom.mjs
A  tests/e2e/fixtures/greenhouse-mock.html
A  tests/e2e/fixtures/zhipin-mock.html
A  tests/e2e/fixtures/workday-shadow-mock.html
A  tests/e2e/fixtures/iframe-page.html
A  tests/e2e-config.test.js
A  docs/E2E-REPORT.md
```

产品缺陷：**0 个**（本轮 E2E 未暴露需要修改 `src/` 行为的问题；`src/` 仅 manifest 版本号变更）。

---

## 7. 门禁返修记录（平台验证第 1 次失败后）

平台门禁跑 `npm run test` 失败（498ms，`pass 210 / fail 1`），失败断言原文：

```
✖ 迭代 6：workday 是两层 shadow，iframe 页内嵌 greenhouse
  AssertionError [ERR_ASSERTION]: workday 必须是两层 shadowRoot
  4 !== 2
    at TestContext.<anonymous> (tests/e2e-config.test.js:74:10)
```

**根因**：`tests/e2e/fixtures/workday-shadow-mock.html` 的注释在转录时被改写，注释里多了两个 `attachShadow` 字样；而断言用 `(shadow.match(/attachShadow/g)||[]).length === 2` 按**字面量**计数，注释也参与计数 → 4 ≠ 2。与团队记忆里「静态断言误命中注释」是同一类坑。

**改了三处**：

1. fixture 注释恢复为已验证措辞，文件里 `attachShadow` 只剩第 23、34 行两处真实调用（sha256 回到 `812001d4…`）；
2. `package.json` 的 test 脚本从 `node --test tests/` 改为 `node --test tests/*.test.js`：目录递归在部分 Node 版本下会把 `tests/e2e/run.mjs`（`import 'playwright'`）当单测执行，门禁环境没有 `node_modules` 时必失败；
3. `tests/e2e-config.test.js` 里「e2e 不进 dist」用例的构建临时目录，从 `os.tmpdir()` 改到仓库内 `.tmp-build-check-*`（沙箱/CI 的系统临时目录可能不可写），并把该前缀写进 `.gitignore`。

**返修后实测**（门禁同构：干净副本、无 `node_modules`）：

| 场景 | 结果 |
| --- | --- |
| `npm run test` | **211 / 211 / 0**，`EXIT_TEST=0` |
| `TMPDIR=/nonexistent-jc npm run test`（模拟系统临时目录不可用） | 仍 211 / 211 / 0，`EXIT_TEST=0` |
| 带 `node_modules`：`npm run smoke` | 18 项全绿，`EXIT_SMOKE=0` |
| 带 `node_modules`：`npm run build` | `EXIT_BUILD=0`，dist 28 文件（25 主 + 3 vendor） |
| 带 `node_modules`：`npm run e2e` | `E2E_SUMMARY cases=6 pass=6 fail=0`，`EXIT_E2E=0` |
| `find dist -path '*e2e*' \| wc -l` | 0 |
