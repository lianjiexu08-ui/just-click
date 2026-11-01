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

---

# 迭代 3：简历模板 + 填充报告 + 待填补充

## 场景
用户手里是一份 PDF 简历（如「姓名-个人简历-手机号-专业.pdf」）。他要的不是"解析 PDF"，而是：
1. 照着一份**简单模板**把常用项录一次（分组合理、别让用户面对裸 JSON）
2. 每次填充后清楚**填了什么、什么没填**
3. 没填的项形成**待填清单**，当场就能补充并补填，不用翻设置页

## 需求 1：简历模板（options 页重构）
模板分三组，内置推荐字段 + 用户自定义项混合展示：
- **基本信息**：姓氏、名、姓名全名（姓+名自动拼接可改）、邮箱、电话、城市、详细地址
- **求职意向**（预置自定义示例，可删）：期望职位、期望薪资、到岗时间
- **教育与其他**：学校、专业、学历、毕业年份、工作年限、经历摘要、作品集链接
交互要求：
- 每项一行：label + 输入框，失焦即保存（防抖 ≤500ms），无需"保存"按钮；显示"已保存 ✓"微提示
- 「+ 添加自定义项」按钮：label 必填、key 自动 slug（中文用 pinyin 首拼或确定性哈希，与迭代 2 的 slug 规则一致）、可删除（内置字段不可删只能清空）
- 顶部工具条：导出 JSON / 导入 JSON（覆盖前确认）
- 完整度指示：已填 x/总数，分组维度显示进度条

## 需求 2：填充报告（popup 结果页重构）
填充执行后，popup 按三个区块渲染（替代现在的单行提示）：
- **已填 N 项**：每项显示「字段 label = 值」（值超 20 字截断，点击展开）
- **待填 M 项**（表单匹配到但简历没值）：每项一行 = 字段 label + **内联输入框 + 「补填」按钮**
  - 补填动作：写入简历存储（该字段若有则覆盖，无则作为自定义字段创建）→ 立即让 content script 填该输入框 → 该项移入"已填"
- **未匹配 K 项**（简历有值但页面没有对应输入框）：折叠显示，默认收起
- 报告底部：「复制报告」按钮（导出为文本，便于粘贴给团队/记录）

## 需求 3：待填项持久化（跨页面携带）
- 报告中的待填项若用户没当场补，存入 `pendingItems`（chrome.storage，按字段 key 去重，含来源站点域名+时间）
- popup 顶部若有待填项，显示「你有 N 个待填项（上次来自 xxx.com）」，点击展开可补值或忽略
- 补值后自动从 pendingItems 移除；options 页也显示同一份清单（与模板对应字段联动）

## 边界与约束
- 不做 PDF 解析（后续迭代），模板手填 + JSON 导入导出已覆盖核心流
- 内联补填不得自动提交任何表单（只填值不点提交按钮——安全底线不变）
- 姓/名拼接：fullName 为空时自动 = lastName + firstName，用户可手动改，改后不再自动覆盖

## 验收标准（全部必须）
1. options 按三组渲染模板，失焦保存（单测：防抖保存与完整度计数）
2. 添加自定义项「期望薪资」后出现在模板第三组，slug 化 key 稳定（同 label 两次添加不产生两个 key）
3. 模拟表单填充后 popup 报告三区块数据正确（单测直接断言报告对象结构：filled/missing/unmatched）
4. 内联补填：单测验证补值写入存储 + 生成增量填充指令（不触发提交）
5. pendingItems：未补的待填项跨"会话"存活（单测用存储 stub 验证持久化与去重）
6. fullName 自动拼接逻辑与手动改写保护（单测）
7. 迭代 1/2 全部测试不回归；新增测试 ≥ 10；`npm test`/`npm run smoke`/`npm run build` 全绿

---

# 迭代 4：AI 简历导入（BYOK：baseURL + API Key + 上传简历自动解析）

## 场景
用户手里是 PDF 简历。手动填模板仍嫌麻烦。给他：自己配一个 OpenAI 兼容接口（baseURL + API Key + 模型名），上传 PDF → AI 抽取成结构化字段 → 预览确认 → 写入简历 → 之后照常一键填表。

## 需求 1：AI 供应商设置（options 新增「AI 简历导入」区）
- 三个输入：`baseURL`（默认 `https://api.deepseek.com/v1`，含 /v1）、`apiKey`（password 型，存储于 chrome.storage.local，仅发往用户配置的 baseURL）、`model`（文本框，如 deepseek-chat）
- 「测试连接」按钮：发一个 max_tokens=8 的请求，2 秒内显示 ✓ 模型名 / ✗ 原因（网络/401/404/CORS）
- 明示隐私一行字：「简历文本只发送到你配置的接口地址」
- 设置独立于简历数据保存；key 输入后显示为 ●●●，可清除

## 需求 2：上传与文本提取
- 文件选择器接受 `.pdf,.txt`，以及拖拽到虚线框；另提供「粘贴文本」多行框（无文件时的兜底）
- PDF 提取：**vendor 化 pdf.js**（Apache-2.0）——`vendor/pdfjs/` 提交进仓库（pdf.min.mjs + pdf.worker.min.mjs），`build.mjs` 拷贝到 `dist/vendor/`，options 页用动态 import 加载（MV3 禁止远程代码，**严禁 CDN**）
- 提取为纯函数 `extractPdfText(arrayBuffer): Promise<string>`（逐页拼接，页间 \n）；worker 路径用 chrome.runtime.getURL 指向 dist 内资源
- 文本超 30000 字符截断（提示已截断）

## 需求 3：AI 结构化解析
- 纯函数 `buildPrompt(fieldSpecs, text)`：fieldSpecs = 当前全部字段（内置 + 用户自定义，含 label 与说明：姓/名分开、期望薪资带单位等），要求「只输出 JSON 对象，key 为字段 key，值为字符串，不确定的字段省略，禁止编造」
- 请求：POST {baseURL}/chat/completions，`response_format: {type:"json_object"}`（部分兼容端点不支持——失败则自动重试一次不带该参数），temperature 0
- 纯函数 `parseAiResume(json, fieldSpecs)`：容错解析（剥 ```json 围栏、JSON.parse 失败时提取首个 {...} 块）、未知 key 忽略、值转字符串 trim、空值丢弃
- 结果进入**预览表**：每行 = 字段 label + AI 值（可编辑）+ 来源置信提示；「确认写入」才落库，可勾选跳过某些行；与现有简历值合并策略：默认「AI 为空不覆盖已有值」，预览中每行可切换覆盖
- key 不存在/未配时，导入区显示引导而非报错堆栈

## 需求 4：解析后直接可填
写入成功后提示「可到任意申请页一键填充」；不自动打开页面（保持用户控制）。

## 边界与安全
- 扫描件（图片型 PDF）提取为空文本 → 明确提示「该 PDF 无文本层，可能是扫描件，请用粘贴文本方式」
- API 错误分类展示：网络失败 / 401 key 无效 / 404 路径或模型不存在 / 429 限流 / 响应非 JSON
- 不自动提交任何表单（底线不变）；不在日志/console 打印 apiKey 与完整简历文本
- MVP 不做：流式输出、多文件批量、docx（后续迭代）

## 验收标准（全部必须）
1. `buildPrompt` 单测：包含全部字段 label 与「只输出 JSON」约束、text 截断到 30000
2. `parseAiResume` 单测 ≥6：正常 JSON / ```json 围栏 / 前后杂质文本 / 未知 key 忽略 / 数字值转字符串 / 空值丢弃
3. `extractPdfText` 无法在 node 直测（依赖 DOM），但须提供 `chunkText(text, 30000)` 纯函数并单测边界（空串/恰好在限/超限）
4. 设置持久化：save/load round-trip 单测（storage stub），apiKey 不出现在任何 console/日志输出（单测断言 console 调用参数不含 key）
5. 测试连接按钮：mock fetch 三分支（200/401/网络错误）单测
6. build 后 `dist/vendor/pdfjs/` 存在且 manifest/web_accessible 资源不含远程 URL；grep 全仓库无 CDN 链接
7. 迭代 1-3 全部测试不回归；新增测试 ≥ 10；`npm test`/`npm run smoke`/`npm run build` 全绿

---

# 迭代 5：真实可用性——iframe / Shadow DOM / 中国求职站点

## 审计结论（为什么是这三个）
迭代 1-4 的引擎与 AI 链路已验证，但对着真实站点有致命缺口：
1. `manifest.json` 的 `content_scripts.all_frames=false`——**Greenhouse/Lever 的申请表单就是 iframe 嵌入的**，脚本根本注入不进去，「支持 Greenhouse」目前名存实亡；
2. content.js 完全没有 shadowRoot 遍历——**Workday 全系大量使用 Shadow DOM**，同样填不进；
3. 只有 greenhouse/lever/workday 三套规则——用户场景（中文简历/手机号/期望薪资）明显是国内求职，**Boss直聘/智联/51job/拉勾/猎聘零适配**。

## 需求 1：iframe 表单支持（all_frames）
- manifest `all_frames: true`（matches 不变 http/https 全站）
- popup 填充流：向 active tab 的**所有 frame** 广播（chrome.tabs.sendMessage 带 frameId 或逐 frame 发送），content script 各自收集+填充；**聚合报告**：每个 frame 返回 {frameUrl: 域名+路径, assignments, missing, notFound}，popup 合并去重（跨 frame 的同 key missing 只显示一次，标注来源站点）
- 「从当前页学习」同样遍历所有 frame
- 主 frame 与子 frame 都无字段时才显示「未发现可填字段」

## 需求 2：Shadow DOM 穿透
- 字段收集递归遍历 `shadowRoot`（含多层嵌套 shadow），收集时记录 `shadowPath`（宿主选择器链）；填充时按原路径重新定位（不能缓存元素引用跨消息——popup 触发是两条消息，要重新查询）
- `isExcluded` 判断在 shadow 内同样生效（type=password 排除、隐藏排除）
- 单测：jsdom 不支持 shadowRoot，用最小 DOM stub（构造带 shadowRoot 属性的假对象树）验证遍历与路径重建逻辑

## 需求 3：中国求职站点适配
- 新增 ATS 精确规则（基于公开 DOM 结构）：
  - `zhipin.com`（Boss直聘快速投递弹窗：name/phone/email + .dialog 容器）
  - `zhaopin.com`（智联投递弹窗）
  - `51job.com`（前程无忧申请表）
  - `lagou.com`（拉勾投递）
  - `liepin.com`（猎聘）
- 中文词库扩展（DICTIONARY）：期望薪资（薪资/待遇/月薪/年薪）、到岗时间（到岗/入职时间/上岗）、学历（学历/教育程度）、学校（学校/院校/毕业院校）、专业（专业/方向）、工作年限（工作年限/工作经验/年经验）
- 中文 select 值匹配：本科/硕士/大专 等（值匹配大小写不敏感 + 包含式）；「一周内/随时/一个月内」到岗语义归一到原文直填
- 每个站点规则在 smoke 里配一个「字段样本 → 期望 key」用例（Boss直聘 phone 弹窗必测）

## 验收标准（全部必须）
1. manifest all_frames=true；popup 聚合多 frame 报告（单测：两个 frame 结果合并去重）
2. shadow 遍历单测（stub DOM 树）：嵌套 2 层 shadow 可收集、路径重建后能重新定位、password 在 shadow 内仍被排除
3. 中国站点 smoke：zhipin/zhaopin/51job/lagou/liepin 各 ≥2 个字段样本命中（其中 Boss直聘 name+phone 必测）；中文词库单测（薪资/到岗/学历/专业各 ≥2 变体）
4. 现有 161 测试不回归；新增测试 ≥ 15；`npm test`/`npm run smoke`/`npm run build` 全绿
5. build 后 grep dist 无 CDN/远程 URL；all_frames 不改变 matches 范围（仍 http/https）
6. options「从当前页学习」在多 frame 页面能列出子 frame 字段（标注 frame 域名）
