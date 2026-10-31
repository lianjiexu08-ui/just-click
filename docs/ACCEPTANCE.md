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
