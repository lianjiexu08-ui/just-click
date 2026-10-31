# JustClick

一键求职填充 Chrome 插件（Manifest V3，零依赖）：填一次简历，在任意 ATS 表单上只点一下。

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
  manifest.json          MV3 声明（content_scripts 顺序：schema → rules → matcher → learner → content）
  background/            service worker（安装时初始化存储）
  content/content.js     DOM 抽取 / 写值 / 高亮 / 消息（JC_FILL、JC_SCAN_FIELDS）
  lib/resume-schema.js   简历 schema、自定义字段、slug、校验、导入导出（UMD）
  lib/rules.js           用户规则引擎：创建/校验/匹配/排序（UMD，纯函数）
  lib/field-matcher.js   字段识别：用户规则 → ATS → 字典（UMD，纯函数）
  lib/learner.js         从当前页学习：扫描、选择器、生成规则（UMD，纯函数）
  lib/storage.js         chrome.storage 封装（jc.resume / jc.rules，schemaVersion 2）
  options/               简历编辑 + 自定义字段 + 规则表
  popup/                 一键填充 + 从当前页学习
tests/                   node:test，71 条
scripts/build.mjs        零依赖构建：校验 manifest/html 引用 → 产出 dist/
docs/                    验收对照与手动测试步骤
```

## 开发与验证

```bash
npm test          # node --test tests/ —— 71 条
npm run smoke     # 6 个识别场景
npm run build     # 校验 + 产出 dist/
```

零依赖，无需 `npm install`（Node ≥ 18）。

## 安装

`npm run build` → Chrome `chrome://extensions` → 打开开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`。

## 使用

1. 打开扩展的 options 页，填写基本信息；需要的话在「自定义字段」里加 `期望薪资 / expected_salary`。
2. 在职位表单页打开 popup → 「一键填充当前页面」，命中字段会高亮 2 秒。
3. 填错了：点「从当前页学习」→ 给该字段选正确的目标字段 → 保存。之后这条规则优先于 ATS 与字典，可在 options 页随时禁用或删除。

数据只存在本机 `chrome.storage.local`，不上传任何服务器；填充永远不会点提交按钮。
