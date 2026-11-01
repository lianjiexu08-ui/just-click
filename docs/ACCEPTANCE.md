# 迭代 2 验收对照（PRD 第 66–72 行）

全部 6 条来自 `PRD.md`「迭代 2：用户自定义（反过拟合）」的验收标准。

| # | 验收标准 | 自动证据（测试名） | 结果 |
| --- | --- | --- | --- |
| 1 | options 添加自定义字段「期望薪资」后，含 `name=expected_salary` 的模拟表单能填上该值 | `tests/custom-fields.test.js` →「验收 1：添加「期望薪资」后，name=expected_salary 的模拟表单能填上该值」 | 通过 |
| 2 | 规则 `name contains salary → expected_salary` 覆盖内置引擎误判（构造一个字典会判错的用例） | `tests/custom-fields.test.js` →「验收 2：用户规则覆盖内置字典误判（期望薪资被误判成电话）」；基线先断言无规则时确实是 `phone` | 通过 |
| 3 | 禁用该规则后引擎回退内置行为 | `tests/custom-fields.test.js` →「验收 3：禁用规则后回退内置行为」 | 通过 |
| 4 | 「从当前页学习」对模拟 DOM 扫描出字段清单并生成规则 | `tests/learner.test.js` →「验收 4：手写 DOM stub 扫描出字段清单并生成规则，忽略项不生成」 | 通过 |
| 5 | 原有 39 条测试不回归；新增 ≥ 8 条 | `npm test`：71 pass / 0 fail；新增 32 条（rules 13 / custom-fields 13 / learner 6） | 通过 |
| 6 | `npm test`、`npm run smoke`、`npm run build` 全绿 | 三份命令 exit code 均为 0；build 产出 dist v0.2.0（14 个文件） | 通过 |

## 验收 2 的用例为什么算「真误判」

```js
const tricky = { fillable: true, name: 'expected_salary', labelText: '期望薪资（可接受电话沟通）' };
M.detectFieldType(tricky);                 // → { key: 'phone', ats: null }   ← 字典被「电话」带偏
M.detectFieldType(tricky, { rules: [rule] }); // → { key: 'expected_salary', confidence: 1, source: 'user-rule' }
```

测试先断言基线是 `phone` 且 `ats === null`（证明不是 ATS 兜出来的），再断言规则命中后 `key/confidence/source/ruleId` 全部正确。

## 反过拟合的硬约束（有测试兜底）

- `M.DICTIONARY` 里没有 `expected_salary`
- `M.FIELD_KEYS` / `S.FIELD_KEYS` 里没有 `expected_salary`
- `M.ATS_RULES` 里没有 `target === 'expected_salary'` 的条目
- `detectFieldType({name:'expected_salary'})` 在没有规则时返回 `null`（自定义 key 不能靠猜命中）

## 测试计数

| 文件 | 条数 | 说明 |
| --- | --- | --- |
| tests/field-matcher.test.js | 15 | 迭代 1，未改动 |
| tests/resume-schema.test.js | 10 | 迭代 1，未改动 |
| tests/storage.test.js | 6 | 迭代 1，未改动 |
| tests/manifest.test.js | 8 | 迭代 1 的 8 条全部保留；其中 content_scripts 顺序断言随加载链收紧为五段精确顺序 |
| tests/rules.test.js | 13 | 新增：规则校验/CRUD/优先级/regex 防护/sitePattern |
| tests/custom-fields.test.js | 13 | 新增：slug、自定义字段校验、验收 1/2/3 |
| tests/learner.test.js | 6 | 新增：DOM stub 扫描、选择器兜底、规则生成 |
| **合计** | **71** | 0 fail |

## 需要人工点一遍的部分

Node 测试覆盖的是数据与规则逻辑，浏览器交互需人工确认，见 `docs/MANUAL-TEST.md`：options 页自定义字段增删改、规则表开关/编辑/删除、popup 学习面板与保存、真实页面填充后的 2 秒高亮。

---

# 迭代 3 验收对照（PRD 第 113–120 行）

七条全部来自 `PRD.md`「迭代 3：简历模板 + 填充报告 + 待填补充」。

| # | 验收标准 | 自动证据（测试名） | 结果 |
| --- | --- | --- | --- |
| 1 | options 按三组渲染模板，失焦保存（单测：防抖保存与完整度计数） | `tests/template.test.js` →「验收 1：模板正好三组…」「验收 1：完整度计数…」「验收 1：防抖保存…」「验收 1：失焦 flush…」 | 通过 |
| 2 | 添加自定义项「期望薪资」后出现在第三组，slug 化 key 稳定（同 label 两次不加出两个 key） | `tests/template.test.js` →「验收 2：添加「期望薪资」落进第三组，同 label 两次只产生一个 key」 | 通过 |
| 3 | 模拟表单填充后 popup 报告三区块数据正确（直接断言 filled/missing/unmatched） | `tests/report.test.js` →「验收 3：报告对象三区块结构正确」 | 通过 |
| 4 | 内联补填：补值写入存储 + 生成增量填充指令（不触发提交） | `tests/supplement.test.js` →「验收 4：内置字段补值 → 写入存储 → 重新读出」「…增量填充指令 submit 恒为 false」「…content script 只填值，源码里不存在任何提交调用」 | 通过 |
| 5 | pendingItems：未补的待填项跨会话存活（存储 stub 验证持久化与去重） | `tests/pending.test.js` →「验收 5：未补的待填项跨会话存活」「…按 key 去重」「…补值后从清单移除」 | 通过 |
| 6 | fullName 自动拼接逻辑与手动改写保护 | `tests/template.test.js` →「验收 6：fullName 中文按「姓 + 名」拼接，手动改写后不再自动覆盖」 | 通过 |
| 7 | 迭代 1/2 全部测试不回归；新增 ≥ 10 条；`npm test` / `npm run smoke` / `npm run build` 全绿 | `npm test`：97 pass / 0 fail（71 条旧用例全保留 + 新增 26 条）；smoke：6 个场景全绿 exit=0；build：manifest v0.3.0 校验通过、17 个引用文件齐全、产出 dist/ 18 个文件 exit=0 | 通过 |

## 几个关键实现口径

- **姓名拼接**：中文「姓 + 名」不留空格（张 + 三 → 张三）；拉丁字母保持迭代 1 的「名 姓」（San Zhang），因此 `tests/resume-schema.test.js` 里的旧断言一字未改。手动改过（含手动清空）会写 `fullNameManual: true`，此后不再自动覆盖。
- **自定义 key 确定性**：英文/拼音走迭代 2 的 `slugifyKey`（`Portfolio Link` → `portfolio_link`）；纯中文 `slugifyKey` 为空，退到 FNV-1a 哈希 `cf_<base36>`。同一个 label 永远同一个 key，所以重复添加返回既有字段而不是新建。
- **预置项只播种一次**：首次打开 options 会把「求职意向 / 教育与其他」的 10 个预置项写进 `customFields`（带 `group` + `preset: true`），并置 `presetsSeeded: true`；用户删掉的预置项不会因为刷新又长回来。
- **报告单测走生产代码**：`popup` 里调用的 `reportFromFillResult` / `buildReportFromPlan` 与测试断言的是同一函数，不存在「UI 一套、测试一套」。
- **P0 安全底线**：`supplement.test.js` 直接对 `src/content/content.js` 源码做静态断言 —— 不含 `.submit(`、`requestSubmit(`、`.click(`，且必须处理 `JC_FILL_ONE`。

## 迭代 3 测试计数

| 文件 | 条数 | 说明 |
| --- | --- | --- |
| tests/template.test.js | 8 | 新增：三组模板、预置播种、自定义项与 key 稳定性、完整度、防抖/flush、姓名拼接 |
| tests/report.test.js | 6 | 新增：三区块结构、20 字截断、去重、文本报告、旧格式兼容、空输入 |
| tests/supplement.test.js | 6 | 新增：内置/自定义/新建字段补值、空值拒绝、指令 submit=false、content 静态断言 |
| tests/pending.test.js | 6 | 新增：持久化跨会话、去重、移除、横幅文案、脏数据 |
| 迭代 1/2 既有 7 个文件 | 71 | 未改动，全部通过 |
| **合计** | **97** | 0 fail |

## 本轮实测暴露并修掉的两个问题（保留记录，避免「不可复现的绿」）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `isNonSubmittingInstruction(buildFillOneInstruction(...))` 恒为 `false`，popup 每次补填都自我中止 → **内联补填 100% 不可用**（值已存简历，但不会发给 content script） | `supplement.js` 的 `FORBIDDEN_KEYS` 里包含 `'submit'`，而指令本身必须带 `submit: false`，于是自检永远失败 | 从禁用列表去掉 `'submit'`，改由 `instruction.submit !== false` 单独严格校验（`submit:true` / `submit:undefined` 仍被拦下） |
| 2 | 静态断言误报「不得调用 form.submit()」 | 断言扫全文，命中了 `content.js` 注释里的 `form.submit()` 字面量 | 注释改成「不调用表单提交方法」；`tests/supplement.test.js` 先剥掉注释再匹配 |

第 1 条是**产品代码 bug**，不是断言写错 —— 如果不修，PRD 验收 4 的功能在真实插件里根本走不通。修复后回归：97 pass / 0 fail，smoke 与 build 仍 exit 0。

## 需要人工点一遍的部分（迭代 3）

见 `docs/MANUAL-TEST.md` 第 6–8 节：三组模板的失焦保存与自动拼接、报告三区块在真实页面上的显示、内联补填后页面确实被填上且**没有提交**、pendingItems 在关掉 popup 后仍在。

---

# 迭代 4 验收对照（PRD 第 157–164 行）

七条全部来自 `PRD.md`「迭代 4：AI 简历导入（BYOK）」。

| # | 验收标准 | 自动证据（测试文件 → 用例） | 结果 |
| --- | --- | --- | --- |
| 1 | `buildPrompt`：包含全部字段 label 与「只输出 JSON」约束、text 截断 30000 | `tests/ai-prompt.test.js` →「buildFieldSpecs：内置 ∪ 自定义…」「buildPrompt：包含全部字段 label 与 key」「…明确「只输出 JSON」、禁止编造」「…35000 字文本被截到 30000 并标记」 | 通过 |
| 2 | `parseAiResume` ≥6：正常 JSON / 围栏 / 杂质 / 未知 key / 数字转字符串 / 空值丢弃 | `tests/ai-parse.test.js`（11 条）：正常 JSON、```json 围栏、前后杂质、未知 key 忽略、数字转字符串、空值丢弃、非法 JSON、大小写/下划线、`{"fields":…}` 包裹、超长截断、数组不算简历 | 通过 |
| 3 | `chunkText(text, 30000)` 纯函数与边界（空串 / 恰好 / 超限） | `tests/ai-prompt.test.js` →「chunkText 边界：空串 / 恰好等于上限 / 超限 / 非字符串」「chunkText：非法 limit 退回默认 30000」；`tests/pdf-vendor.test.js` →「chunkText 与 ai.js 同源」 | 通过 |
| 4 | 设置持久化 round-trip；apiKey 不出现在任何 console/日志 | `tests/ai-settings.test.js` →「save → load round-trip」「apiKey 不进入任何 console 输出」（劫持 6 个 console 方法后断言零输出）「清除 key 保留 baseURL 与模型」「简历导出 JSON 里不含 API Key」 | 通过 |
| 5 | 测试连接 mock fetch 三分支（200 / 401 / 网络错误） | `tests/ai-client.test.js` →「测试连接 200：返回 ✓ 模型名」「…401：分类为 auth」「…网络失败：分类为 network」「…404：分类为 not_found，且不重试」；另有 429 / config / 空 content 分支 | 通过 |
| 6 | build 后 `dist/vendor/pdfjs/` 存在；manifest/WAR 不含远程 URL；全仓库无 CDN | `tests/pdf-vendor.test.js` →「pdf.js 已 vendor 进仓库（含 LICENSE）」「manifest 与 web_accessible_resources 里没有远程资源」「html 里没有远程 script / link」「全仓库源码里没有 CDN 链接」「npm run build 之后 dist/vendor/pdfjs 存在」（该用例**真的执行** `node scripts/build.mjs`） | 通过 |
| 7 | 迭代 1–3 测试不回归；新增 ≥ 10；`npm test`/`npm run smoke`/`npm run build` 全绿 | 见下方「测试计数」与「本轮实测」两节 | 通过 |

## 几个关键实现口径（迭代 4）

- **只发往用户配置的地址**：`callChat` 的 URL 由 `chatUrl(baseURL)` 唯一生成（去尾斜杠 + `/chat/completions`），没有任何代理或兜底域名；`missingConfig` 在缺 baseURL / model / key 时直接返回 `kind: "config"` 的引导文案，不发请求。
- **降级重试只做一次**：`response_format` 被拒（400/422）、5xx、坏 JSON 才去掉该参数重试一次；401/403（key 错）、404（路径/模型错）、429（限流）、网络失败**不重试**，避免放大问题。`attempts` 数组会回传每次尝试的 `{status, kind, withResponseFormat}`，UI 用它标「已降级重试」。
- **key 的三重隔离**：只出现在 `Authorization` 头；`scrub()` 会把端点回显的 key 替换成 `***` 再进错误文案；`ai-settings.js` / `ai-client.js` / `options.js` 里没有任何 `console.*` 调用（有测试劫持 console 断言零输出）。设置存在独立的 `jc.aiSettings`，`exportJSON` 只导出简历。
- **合并策略**：`applyAiRows` 是纯函数，先 `JSON.parse(JSON.stringify())` 深拷贝再写，最后统一走 `validateResume`；不合法就整体不写（返回 errors）。AI 空值/空白值直接 `skipped`，已有值且未勾「覆盖」进 `kept`，勾了才进 `applied`。
- **写入全名会冻结自动拼接**：AI 写入 `fullName` 时置 `fullNameManual: true`，与迭代 3「用户手改后不再自动覆盖」保持一致；只给姓+名时反而不写 fullName，交给 `resolveValue` 自动拼接。

## 迭代 4 测试计数

| 文件 | 条数 | 说明 |
| --- | --- | --- |
| tests/ai-prompt.test.js | 7 | 新增：字段清单、提示词约束、截断、chunkText 边界 |
| tests/ai-parse.test.js | 11 | 新增：容错解析 6 类 + 包裹/大小写/超长/非法 |
| tests/ai-settings.test.js | 9 | 新增：round-trip、校验、mask、清除 key、key 不落日志 |
| tests/ai-client.test.js | 13 | 新增：URL 拼接、200/401/404/网络、降级重试、429、config、extractResume、key 擦除 |
| tests/ai-import.test.js | 15 | 新增：预览行、覆盖/保留/跳过/空值、自定义字段、fullName（含派生值语义）、纯函数性 |
| tests/pdf-vendor.test.js | 9 | 新增：vendor 文件、getURL、扫描件判定、无 CDN、build 产出 |
| 迭代 1–3 既有 11 个文件 | 97 | 未改动，全部通过 |
| **合计** | **161** | 0 fail |

## 本轮实测（同一份交付代码的终端运行记录）

每个验证实例都在自己的副本里跑、父目录全程只读；跑前/跑后对父目录 36 个代码文件（src/tests/scripts 全量 .js/.mjs）做 shasum 对比，`CODE_HASHES_IDENTICAL=36_FILES`。run3 由两个独立实例各跑一次，run4 是对交付快照的回退复核。

| 轮次 | 快照内容 | 结果 | 说明 |
| --- | --- | --- | --- |
| run1 | 首版代码（`normalizeSettings` 未修、fullName 用例未补 `overwrite`） | 159 tests / 155 pass / **4 fail** / exit 1 | 暴露真问题：显式空串被当成缺省，导致「空模型能存进去、空 baseURL 算已配置」 |
| run2 | 修完 `normalizeSettings` | 160 tests / 159 pass / **1 fail** / exit 1 | 只剩 fullName 用例：`firstName=San/lastName=Zhang` 由 `resolveValue` 派生出 `San Zhang` 算已有值 → 不勾覆盖就保留；**测试断言写错，产品语义正确** |
| run3（定稿） | 补 `overwrite:true` + 新增「派生值不勾覆盖则保留」用例 + build 产物计数文案 | **161 tests / 161 pass / 0 fail，EXIT_TEST=0** | 两个独立验证实例各跑一次，结果一致；`node --check` 36/36；`npm run smoke` 6/6、EXIT_SMOKE=0；`npm run build` EXIT_BUILD=0，dist 25 文件（22 主 + 3 vendor）；`^✔` 计数同为 161 |
| run4（交付快照） | 把预览表说明列两行文案回退（去掉 `AI 抽取 · ` 前缀），使交付树与已验证快照逐字节一致 | **161 / 161 / 0，EXIT_TEST=0，EXIT_BUILD=0** | `src/options/options.js` = `144e18e1…37b6a`（与 run3 快照同一 hash）；`node --check` EXIT=0；36 文件 shasum 跑前跑后 `CODE_HASHES_IDENTICAL=36_FILES`；副本与父目录 `diff -rq` 无差异 |

node v26.8.1 / npm 11.19.0。真实终端原始输出摘要：

```
EXIT_TEST=0
ℹ tests 161
ℹ pass 161
ℹ fail 0
EXIT_SMOKE=0      （6 个识别场景全绿）
EXIT_BUILD=0      （manifest V3 v0.5.0；24 个引用文件；dist 22 主文件 + 3 vendor，273.8 KB 主产物）
CHECKED_COUNT=36  SYNTAX_FAILED: <none>
```

## 需要人工点一遍的部分（迭代 4）

Node 里跑不出浏览器行为，见 `docs/MANUAL-TEST.md` 第 9–12 节：

1. 真实 key 的「测试连接」成功分支、401 分支的**真实**响应体；
2. 真实 PDF（文字版 / 扫描件）经 pdf.js 提取的页数与文本质量，以及 `dist/vendor/pdfjs/` 在 Chrome 里能否正常加载 worker；
3. 预览表的编辑/跳过/覆盖在真实 UI 上的手感与最终落库结果；
4. DevTools Network 里确认「简历文本只发往自己配置的 baseURL」、控制台搜不到 key。

这四条没有自动断言，不在测试结论里冒充已验证。
