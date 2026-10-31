# 验收对照表

PRD 的三条验收标准，逐条给出「自动化证据」与「人工验证步骤」。凡是不能在 CI 里断言的（真实 Chrome 里点一下），这里明确标"需人工"，不假装已验证。

## 验收标准 1：加载插件后，在 Greenhouse/Lever 公开职位页点 JustClick，姓名 / 邮箱 / 电话自动填入并高亮

| 环节 | 证据类型 | 位置 |
| --- | --- | --- |
| 三家 ATS 选择器 / 属性规则正确 | 自动化单测 | `tests/field-matcher.test.js`：「ATS 适配：Greenhouse」「Lever」「Workday」三组 |
| 字段能被打分并生成填充计划 | 自动化单测 | 「buildFillPlan：Greenhouse 表单最小验收（姓名/邮箱/电话全部命中）」 |
| 高亮 2 秒 | 需人工 | `src/content/content.js` 的 `highlight()`：加 `jc-filled-highlight` class，`setTimeout` 2000ms 后移除 |
| 真实页面填入 | 需人工 | 见下方手工步骤 |

人工步骤：
1. `npm run build` → Chrome `chrome://extensions` → 开发者模式 → 加载 `dist/`。
2. 打开 `dist` 之前先在 options 页填好姓名、邮箱、电话并保存。
3. 打开任一 Greenhouse 或 Lever 公开职位申请页（如 boards.greenhouse.io 上的职位）。
4. 点扩展图标 →「一键填充当前页面」。
5. 期望：First Name / Last Name（或 Name）、Email、Phone 被填入并高亮约 2 秒；右下角 toast 与 popup 都显示「已填 N 项」。

> 说明：本仓库没有真实网站的 DOM 快照，所以「页面里到底有没有被填上」只能人工确认；能自动保证的是识别与赋值计划的正确性。

## 验收标准 2：options 页保存的数据持久化（chrome.storage.local）

| 环节 | 证据类型 | 位置 |
| --- | --- | --- |
| 写入用 `chrome.storage.local.set`，读取用 `.get`，键固定 `jc.resume` | 代码 | `src/lib/storage.js`（`STORAGE_KEY`） |
| 保存前校验、失败给出 errors | 自动化单测 | `tests/resume-schema.test.js` 校验相关用例 |
| 导入导出往返不丢字段 | 自动化单测 | 「exportJSON / importJSON 往返不丢字段」 |
| 刷新后仍在 | 需人工 | 保存 → 关闭 options 页 → 重开，字段应回填；popup 的完整度应同步 |

## 验收标准 3：npm run build 产出 dist 可加载；npm test 通过

| 环节 | 证据类型 | 位置 |
| --- | --- | --- |
| manifest 引用文件全部存在、字段合法、content_scripts 顺序正确 | 自动化单测 + 构建校验 | `tests/manifest.test.js`、`scripts/build.mjs` |
| 源文件不含 ES module 语法（content script 只能跑经典脚本） | 自动化单测 | `tests/manifest.test.js` |
| `npm test` 全绿、`npm run build` 产出 dist | 命令输出 | 见交付汇报里的原始输出 |

## 已知不覆盖（MVP 有意不做）

- iframe 内的表单（`all_frames: false`）
- 文件上传字段（简历 PDF）
- 自定义下拉组件、日期选择器
- 学习式自定义映射、多份简历切换、7 家 ATS 全覆盖（PRD 明确列为后续迭代）
