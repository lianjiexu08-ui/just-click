# JustClick

一键求职填充 Chrome 插件（Manifest V3，零依赖）：填一次简历，在任意 ATS 表单上只点一下。

## 迭代 6 新增（浏览器 E2E：Playwright + 真扩展 + mock ATS）

单测与 smoke 都是字段样本级的，证明不了「真浏览器里点一下能不能填」。迭代 6 把这条链路补成可执行门禁：

1. **真浏览器 + 真扩展**：`npm run e2e` 用 Playwright 启动 `channel: 'chromium'` 的 Chrome for Testing（默认 headless 是 headless shell，**不支持扩展**），`--load-extension=<abs dist>` 加载构建产物；扩展的 MV3 service worker 必须在 ~1s 内出现。
2. **mock ATS 站点**：`tests/e2e/fixtures/` 四个纯静态页，零外部资源 —— Greenhouse 标准申请表（四字段 + 开放问题 textarea + 提交按钮计数）、Boss 直聘风格投递弹窗（`.dialog-wrap`，中文字段）、Workday 两层 shadowRoot（最内层放姓/名/邮箱，外加一个必须保持为空的 password）、iframe 父页（`company_site` + 内嵌 Greenhouse）。
3. **复用真实协议，不加测试钩子**：runner 在 SW 里 `chrome.storage.local.set({'jc.resume': ...})` 注入 schema 合法的简历（仓库自己的 `resume-schema.js` 生成），再按 popup 的真实做法枚举 frame：`chrome.scripting.executeScript({allFrames:true})` → 逐 frame `chrome.tabs.sendMessage({type:'JC_FILL'})`。**没有** `window.__justclick_fill__`，`src/` 行为零改动。
4. **6 个用例**：Greenhouse 四字段 + 高亮 + 开放问题留空 + 不点提交；Boss 弹窗三项；Workday 两层 shadow（password 仍空）；iframe 内填充且父页不动；高亮 2200ms 后归零；报告契约（`filled/filledItems/notFound/missing`）。单用例 15s 超时，失败落截图 + HTML 到 `tests/e2e/.artifacts/`。

`npm test` 里另有 `tests/e2e-config.test.js` 守配置（不依赖 playwright 也能跑）：依赖/脚本契约、fixture 关键字段、无远程资源、e2e 不进 `dist`、runner 必须 `channel: 'chromium'` + `--load-extension`。

## 迭代 5 新增（真实可用性：iframe / Shadow DOM / 中国站点）

对着真实站点补三个致命缺口：表单在 iframe 里、字段在 Shadow DOM 里、公司用的是国内招聘站。

1. **iframe 表单**：`content_scripts.all_frames: true`，主 frame 与所有子 frame 各自收集/填充。popup 先用 `chrome.scripting.executeScript({allFrames:true})` 拿 frame 清单（过滤 `about:blank`/`data:`），再逐 frame 发 `JC_FILL`，最后用 `lib/frames.js` 的 `mergeFrameResults` 合并：**跨 frame 同 key 只显示一次**（filled 保留第一次的值、missing/notFound 用 `frames` 标出来源），单个 frame 失败只标 `failed`，不影响整体。报告顶部显示「扫描 N 个 frame」，全部没有字段时才提示「未发现可填字段」。
2. **Shadow DOM 穿透**：`lib/shadow.js` 递归遍历 `element.shadowRoot`（支持多层嵌套），为每个可填控件生成 `宿主选择器 >>> … >>> 叶子选择器` 的路径；填充时用 `resolvePath` 按路径重新定位（不缓存元素引用）。密码框 / `type=hidden` / `el.hidden` / `aria-hidden` / `display:none` / `disabled` / `readOnly` 在 shadow 内外统一排除。Workday 这类全 Shadow DOM 表单因此可填；content 响应里带 `shadowFields` / `shadowScanned` / `viaShadow` 三个计数与标记，报告里 shadow 命中项带 `shadow` 角标（角标样式待补，当前为纯文本）。
3. **中国求职站点**：Boss直聘 / 智联 / 51job / 拉勾 / 猎聘的精确规则直接并入 `ATS_RULES` 并排在数组前部（优先于 Greenhouse/Lever/Workday），每条带 `sites` 做 host 隔离（`hostMatches` 严格后缀匹配，`zhipin.com.evil.com` 不算）；`SITE_RULES` 保留为 `ATS_RULES.filter(r => r.sites?.length)` 的兼容视图。Boss 快速投递弹窗的 `name=name` / `name=phone` / `name=email` 这类通用属性名也由站点规则命中（`ats=zhipin`），不再落到通用 Lever 规则。六组中文词条（期望薪资 / 到岗时间 / 学历 / 学校 / 专业 / 工作年限）直接放在 `DICTIONARY`，**不再需要 `options.fieldKeys` 放行**，中文 label 可直接命中；模板既有的 `degree` / `work_years` 作为 `education` / `experience_years` 的取值别名双向兼容（`FIELD_KEY_ALIASES`，取值与 notFound 都按别名处理）。反硬编码红线不变：任意自建 key（如 `wechat`）不在词典里，只能靠用户规则命中。中文 `<select>` 走 `lib/select-match.js`：精确 → 包含式（两侧 ≥ 2 字）→ 同义词组（本科/学士、硕士/研究生、随时/立即、一周内/一周以内…）。站点规则来自公开 DOM 结构推断，**未在真实登录态逐站回归**。

无新增权限、无远程代码；`dist/` 里仍然只有本地文件。

## 迭代 4 新增（AI 简历导入，BYOK）

不再手抄 PDF：自己配一个 OpenAI 兼容接口（baseURL + API Key + 模型名），上传 PDF/TXT（或粘贴文本）→ AI 抽成结构化字段 → **预览表逐行确认** → 写入简历 → 照常一键填表。

1. **供应商设置**：`baseURL`（默认 `https://api.deepseek.com/v1`）、`apiKey`（password 型，存 `chrome.storage.local` 的 `jc.aiSettings`，与简历数据分开）、`model`。点「测试连接」发一个 `max_tokens=8` 的最小请求，2 秒内给出 `✓ 模型名` 或分类后的 `✗ 原因`（网络 / 401 / 404 / 429 / 非 JSON）。输入框旁有「清除」只删 key，保留地址与模型。
2. **上传与提取**：文件选择器 + 拖拽虚线框接受 `.pdf` / `.txt`，另有「粘贴文本」兜底。PDF 走 **vendor 化的 pdf.js**（`vendor/pdfjs/`，Apache-2.0，构建时拷进 `dist/vendor/`），`workerSrc` 用 `chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs')`，**全链路无 CDN、无远程代码**；`isEvalSupported:false` 避免 CSP 下的 eval。逐页拼接、页间 `\n`，文本超 30000 字符截断并提示。扫描件（无文本层）明确提示改用粘贴。
3. **结构化解析**：`buildPrompt(fieldSpecs, text)` 把「当前全部字段（内置 + 自定义）+ 说明」拼进提示词，要求只输出 JSON、不确定就省略、禁止编造；请求 `POST {baseURL}/chat/completions`，`temperature:0` + `response_format:{type:"json_object"}`，端点不支持该参数时**自动去掉重试一次**（只重试一次，且不对 401/404/429/网络失败重试）。`parseAiResume` 容错：剥 ```json 围栏、从杂质里按括号配平截 JSON、未知 key 忽略、数字转字符串、空值丢弃、超长截断。
4. **预览与合并**：每行可编辑、可勾「跳过」、可勾「覆盖」；默认「AI 为空不覆盖已有值」，已有值的行不勾覆盖就保留原值。点「确认写入」才落库（走 `validateResume` 校验），写入后提示「可到任意申请页一键填充」，**不自动打开页面**。

安全底线：key 只出现在 `Authorization` 头里，不写日志、不进错误文案（端点回显也会被 `***` 抹掉），不随「导出 JSON」导出；AI 导入全程不碰网页表单、不提交任何东西。

### 新增纯逻辑模块（都可单测，不碰 DOM）

| 文件 | 职责 |
| --- | --- |
| `lib/ai.js` | `chunkText` / `buildPrompt` / `parseJsonLoose` / `parseAiResume` / `previewRows` / `applyAiRows` / 错误分类，全部纯函数 |
| `lib/ai-client.js` | `chatUrl`、`callChat`（含 `response_format` 降级重试）、`testConnection`、`extractResume`；`fetchImpl` 可注入，key 不进错误文案 |
| `lib/ai-settings.js` | `jc.aiSettings` 存取与校验、`maskKey`、`clearApiKey`；零 console |
| `lib/pdf-text.js` | `extractPdfText`（动态 import 本地 pdf.js）、`extractTextFromFile`、扫描件判定、`chunkText` 转发 |

## 迭代 3 新增（简历模板 + 填充报告 + 待填补充）

用户手里是一份 PDF 简历时，他要的不是「解析 PDF」，而是三件事：照着模板录一次、每次填充知道填了什么没填什么、没填的当场补上。

1. **三组简历模板**（options 重构）：「基本信息」（姓氏/名/全名/邮箱/电话/城市/详细地址）、「求职意向」（期望职位/期望薪资/到岗时间，预置可删）、「教育与其他」（学校/专业/学历/毕业年份/工作年限/经历摘要/作品集链接）。每项一行、**失焦即保存**（防抖 400ms，无保存按钮），带「已保存 ✓」微提示；每组一条完整度进度条 + 顶部总进度。
2. **填充报告**（popup 重构）：填充后按三区块渲染 —— 「已填 N 项」（`label = 值`，超过 20 字截断可点开）、「待填 M 项」（每行内联输入框 + 「补填」按钮）、「未匹配 K 项」（折叠）。底部「复制报告」导出纯文本。
3. **待填项持久化 + 内联补填**：没当场补的待填项存进 `jc.pending`（按 key 去重，带来源站点与时间），popup 顶部显示「你有 N 个待填项（上次来自 xxx.com）」，options 页也能看到同一份清单。补值 → 写回简历 → 只填那一个输入框 → 立刻从清单移除。

**安全底线不变**：内联补填只写值，不点提交、不 `form.submit()`、不 `requestSubmit()`；`tests/supplement.test.js` 直接对 `content.js` 源码做静态断言。

### 姓名拼接规则

`fullName` 留空时自动拼接：中文按「姓 + 名」（张 + 三 = 张三，不留空格），拉丁字母按「名 姓」（San Zhang，保持迭代 1 行为）。用户手动改过（包括手动清空）后写入 `fullNameManual: true`，不再被自动覆盖。

### 新增纯逻辑模块（都可单测，不碰 DOM）

| 文件 | 职责 |
| --- | --- |
| `lib/template.js` | 三组模板定义、预置项播种（只播一次）、`templatesFor` 渲染模型、完整度计算、自定义项增删（key 确定性生成）、防抖保存器 |
| `lib/report.js` | `buildReportFromPlan` → filled/missing/unmatched、20 字截断、`reportToText` 文本报告 |
| `lib/supplement.js` | 补值写回简历模型（未知 key 自动建自定义字段）、增量填充指令 `JC_FILL_ONE`（`submit:false` 自检） |
| `lib/pending.js` | `jc.pending` 的读取/去重/移除、横幅文案 |

## 迭代 2 新增（用户自定义 / 反过拟合）

迭代 1 的字典 + 三家 ATS 精确规则是对已知表单的过拟合。迭代 2 让用户显式「教」插件：

1. **自定义简历字段**：内置 11 个 key 之外，可加任意字段（`expected_salary`、`portfolio`、`available_date`…）。key 由 label 自动 slug 化（`Expected Salary` → `expected_salary`），纯中文 label 退到 `custom_field_1/2…`。
2. **用户映射规则**：`{match:{attrs,pattern,matchType}, target, scope.sitePattern, enabled, source}`，matchType 支持 `exact / prefix / contains / regex`（regex ≤200 字符、编译失败只跳过该条规则）。
3. **从当前页学习**：popup 里点「从当前页学习」→ content script 扫描可见可填控件 → 逐个选目标字段（或忽略）→ 生成 `source=manual` 规则，默认只对当前站点生效（可取消勾选变成全站）。

### 引擎优先级（命中即短路）

```
用户规则（confidence 1.0） → ATS 精确规则 → 内置字典启发式
```

用户规则内部排序也是确定性的：`manual` 优先于 `learned` → `hitCount` 高者 → pattern 长者 → `createdAt` 新者 → id 升序。

**自定义 key 不会进入 `DICTIONARY` / `FIELD_KEYS` / `ATS_RULES`**：它只能靠用户规则命中。这条约束有单元测试断言防回归（`tests/custom-fields.test.js`）。

## 目录

```
src/
  manifest.json          MV3 声明（content_scripts 顺序：schema → rules → matcher → select-match → shadow → frames → learner → content，all_frames:true）
  background/            service worker（安装时初始化存储）
  content/content.js     DOM 抽取（含 shadow）/ 按 path 回定位写值 / 高亮 / 多 frame 消息（JC_FILL、JC_SCAN_FIELDS、JC_FILL_ONE）
  lib/resume-schema.js   简历 schema、自定义字段、slug、校验、导入导出（UMD）
  lib/rules.js           用户规则引擎：创建/校验/匹配/排序（UMD，纯函数）
  lib/field-matcher.js   字段识别：用户规则 → 站点/ATS 规则 → 字典 + 预置词库（UMD，纯函数）
  lib/shadow.js          Shadow DOM 遍历、路径重建、shadow 内排除规则（UMD，纯函数）
  lib/frames.js          多 frame 结果合并去重、frame 标签、学习条目打标（UMD，纯函数）
  lib/select-match.js    中文 select 值匹配：精确 / 包含 / 同义词组（UMD，纯函数）
  lib/learner.js         从当前页学习：扫描、选择器、生成规则（UMD，纯函数）
  lib/storage.js         chrome.storage 封装（jc.resume / jc.rules，schemaVersion 2）
  lib/template.js        三组模板、完整度、自定义项增删、防抖保存器（UMD，纯函数）
  lib/report.js          填充报告三区块 / 截断 / 文本导出（UMD，纯函数）
  lib/supplement.js      内联补值写回 + JC_FILL_ONE 增量指令（submit:false）
  lib/pending.js         jc.pending 待填项：去重、持久化、横幅文案
  lib/ai.js              AI 导入纯逻辑：提示词 / 容错解析 / 预览 / 合并 / 错误分类
  lib/ai-client.js       chat/completions 调用、测试连接、response_format 降级重试
  lib/ai-settings.js     jc.aiSettings：baseURL / apiKey / model 校验与存取
  lib/pdf-text.js        pdf.js 本地提取（chrome.runtime.getURL 指 worker）、扫描件判定
  options/               简历模板（三组）+ AI 简历导入 + 待填清单 + 规则表
  popup/                 一键填充 + 填充报告 + 内联补填 + 从当前页学习
vendor/pdfjs/            pdf.js（pdf.min.mjs + pdf.worker.min.mjs + LICENSE，Apache-2.0）
tests/                   node:test
scripts/build.mjs        零依赖构建：校验 manifest/html/vendor → 产出 dist/（含 dist/vendor/）
docs/                    验收对照与手动测试步骤
```

## 开发与验证

```bash
npm test          # node --test tests/*.test.js（211 条：204 既有 + 7 条 E2E 配置门禁）
npm run smoke     # 18 个识别场景（含中国五站点表单 + 中文「期望薪资」）
npm run build     # 校验 + 产出 dist/（含 dist/vendor/pdfjs）
npm run e2e       # 真 Chromium + 真扩展 + mock ATS 的 6 个端到端用例（会先自动 build）
npm run e2e:ai    # 旧的「真实 AI 链路」端到端脚本，需要真实 API Key
```

源码零依赖（Node ≥ 18）；只有跑 `npm run e2e` 需要 `npm install`（devDependency：playwright 1.63.0 + 本机 chromium）。

## 安装

`npm run build` → Chrome `chrome://extensions` → 打开开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`。

## 使用

1. （可选，迭代 4）options 页「AI 简历导入」区：填 baseURL / API Key / 模型 → 「测试连接」看到 ✓ → 上传 PDF/TXT 或粘贴文本 → 「开始解析」→ 预览表逐行核对（可改值、可跳过、冲突行按需勾「覆盖」）→「确认写入」。
2. 打开扩展的 options 页，按三组模板填一次（失焦即保存）；「求职意向」「教育与其他」里的预置项可以改名或删掉，「+ 添加自定义项」可以随时加，比如 `期望薪资`。
3. 在职位表单页打开 popup → 「一键填充当前页面」，命中字段会高亮 2 秒，随后弹出**填充报告**：已填 / 待填 / 未匹配。
4. 报告里「待填」那行可以直接补值 → 点「补填」：值写进简历，页面上的那个输入框立刻被填上（**不会提交表单**）。
5. 没当场补的项会挂进待填清单，下次打开 popup 顶部提示「你有 N 个待填项（上次来自 xxx.com）」，options 页也能看到同一份清单。
6. 识别错了：点「从当前页学习」→ 给该字段选正确的目标字段 → 保存。之后这条规则优先于 ATS 与字典，可在 options 页随时禁用或删除。

数据默认只存在本机 `chrome.storage.local`（`jc.resume` / `jc.rules` / `jc.pending` / `jc.aiSettings`）。**唯一的出网行为**是你主动点「开始解析」时，把简历文本发到**你自己配置的 baseURL**（不经过任何中转服务器）；AI Key 不会随导出 JSON 泄露。填充、补填、AI 导入都永远不会点提交按钮。

## 已知边界（迭代 5）

- **扫描件 PDF 不做 OCR**：提取不到文本层时只提示改用「粘贴文本」。
- **不做流式输出**：请求会等到完整响应（默认超时 60 秒），期间只有状态文案，没有逐字输出。
- **单文件、不批量、不支持 docx**（PRD 明确排除，后续迭代）。
- **PDF 解析依赖真实 Chrome**：Node 只能测纯函数与静态约束（本地 pdf.js、无 CDN、worker 走 `chrome.runtime.getURL`）；真实 PDF 的页数/文本质量需按 `docs/MANUAL-TEST.md` 第 10 节人工确认。
- **iframe**：跨域 iframe 依赖 `host_permissions` 的 http/https 通配；`about:blank` / `data:` / `chrome-extension://` frame 不扫描。子 frame 里的「补填」按 frame 逐个尝试，第一个成功即止。
- **Shadow DOM**：只穿透 `element.shadowRoot`（open shadow root）；closed shadow root 浏览器不允许访问。普通 DOM 元素的 path 是单段选择器（`#id` / `[name]` / `tag:nth-of-type(n)`），同名同结构元素极多时可能定位到第一个匹配项（content 会校验 tag，不一致按失败处理）。
- **国内站点规则基于公开 DOM 结构推断**：zhipin / zhaopin / 51job / lagou / liepin 的选择器没有在真实登录态页面逐站回归，站点改版会让规则失效；失效时仍可回落到中文词库与「从当前页学习」。
- **中文 select 同义词组有限**：目前覆盖学历四组与到岗三组，其它枚举值靠精确/包含式匹配。
