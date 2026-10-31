# JustClick — 一键求职填充 Chrome 插件

定位：求职者填表太痛苦——每个 ATS（Greenhouse/Lever/Workday…）表单结构都不同。JustClick 让用户"只点一下"就把常用字段填完。

## MVP 范围（本次交付）
1. Chrome MV3 插件骨架：popup + content script + options 页
2. 简历数据：JSON schema（姓名/邮箱/电话/地址/链接/经历摘要），options 页表单编辑 + 导出/导入 JSON
3. 字段识别引擎（content script）：
   - 通用启发式：label/placeholder/aria/name/id 语义匹配（中英文词库：姓名、邮箱、电话、城市…）
   - 基础 ATS 适配：Greenhouse、Lever、Workday 三家的常见选择器
4. 一键填充：popup 点击 → 填充当前页可见字段 → 已填字段高亮 2 秒 → 完成通知（缺哪些字段）
5. 不做（后续迭代）：学习式自定义映射、7 ATS 全覆盖、TypeSafe 语义匹配、多简历切换

## 验收标准
- 加载插件后，在 Greenhouse/Lever 任一公开职位页点击 JustClick，姓名/邮箱/电话自动填入并高亮
- options 页保存的数据持久化（chrome.storage.local）
- npm run build 产出 dist 可加载；npm test 通过（字段识别引擎单元测试）

---

# 迭代 2：用户自定义（反过拟合）

## 动机
迭代 1 的 ATS 精确规则 + 中英文字典是对**已知表单的过拟合**。真实世界表单长尾巨大（公司内部 ATS、冷门站点、非标准命名），必须让用户能显式"教"插件，而不是继续堆硬编码规则。

## 需求 1：自定义简历字段
用户不局限于内置 7 个 key（fullName/firstName/lastName/email/phone/city/address），可添加任意字段：
- options 页「简历字段」区：新增/编辑/删除自定义字段（key 自动 slug 化、label 必填、value 自由文本）
- 例：`expected_salary`（期望薪资）、`portfolio`（作品集链接）、`available_date`（到岗时间）
- 识别引擎的匹配目标集合 = 内置 key ∪ 用户自定义 key（matchForm/detectFieldType 接受动态 key 集合，禁止把自定义 key 硬编码进字典）

## 需求 2：用户自定义映射规则（核心）
数据模型（chrome.storage，schemaVersion 升 2）：
```json
{
  "fieldRules": [{
    "id": "uuid",
    "match": { "attrs": ["name", "id"], "pattern": "expected_salary", "matchType": "contains" },
    "target": "expected_salary",
    "scope": { "sitePattern": "" },
    "enabled": true,
    "source": "manual",
    "createdAt": "ISO", "hitCount": 0
  }]
}
```
- `matchType`：exact / prefix / contains / regex（regex 长度 ≤200 且要 try/catch 失效防护）
- `attrs`：在 id / name / label / placeholder / aria-label 中任选若干
- `scope.sitePattern`：可选站点限制（对 location.href 做 contains 匹配；空 = 全站）
- 规则可禁用/删除/编辑

## 引擎优先级（必须实现）
1. **用户规则**（source=manual 优先于 learned；同分取 hitCount 高者）→ confidence 1.0
2. ATS 精确规则（迭代 1 的 ATS_RULES）
3. 内置字典启发式
用户规则命中即短路返回——用户显式教的永远压过猜测。

## 需求 3：从当前页学习
popup 增加「从当前页学习」按钮：
1. 向 content script 发消息，抓取当前页全部可见可填控件（input/select/textarea）
2. popup 列出字段清单（label + attr 样本 + 建议选择器）
3. 用户逐个下拉选择目标字段（内置 key / 自定义 key / 忽略）
4. 保存为 source=manual 的规则（含 sitePattern = 当前站点域名，可选去掉）
被引擎误填的字段，用户通过这个流纠正一次，之后全站/全页生效。

## 验收标准（全部必须）
1. options 页添加自定义字段「期望薪资」后，含 `name=expected_salary` 输入框的模拟表单能被填上该值
2. 添加规则 `name contains salary → expected_salary` 后，单测验证：该规则**覆盖**内置引擎的误判（构造一个内置字典会判错的用例）
3. 禁用该规则后引擎回退内置行为
4. 「从当前页学习」流：对模拟 DOM（jsdom 或手写 DOM stub 不引入重依赖——用现有测试基建）扫描出字段清单并生成规则
5. 原有 39 个测试不回归；新增测试 ≥ 8 个（规则 CRUD、优先级、regex 防护、sitePattern、学习流、自定义字段 slug 化）
6. `npm test`、`npm run smoke`、`npm run build` 全绿
