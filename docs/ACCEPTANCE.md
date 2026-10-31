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
