# JustClick

一键求职填充 Chrome 插件（Manifest V3）。求职者填 ATS 表单太痛苦——每个平台结构都不同，JustClick 让用户「只点一下」就把常用字段填完。

## 当前进度：MVP 已实现

| PRD 范围 | 实现位置 | 状态 |
| --- | --- | --- |
| ① MV3 骨架：popup + content script + options | `src/manifest.json`、`src/popup/`、`src/content/`、`src/options/`、`src/background/` | 已实现 |
| ② 简历数据：schema + options 表单 + JSON 导入导出 | `src/lib/resume-schema.js`、`src/options/options.js` | 已实现，存 `chrome.storage.local` |
| ③ 字段识别引擎（中英文词库 + Greenhouse/Lever/Workday） | `src/lib/field-matcher.js` | 已实现，纯函数可单测 |
| ④ 一键填充 + 高亮 2 秒 + 完成通知（含缺失字段） | `src/content/content.js`、`src/popup/popup.js` | 已实现 |
| ⑤ 不做：学习式映射 / 7 家 ATS / TypeSafe 语义匹配 / 多简历 | — | 按 PRD 不实现 |

## 快速开始

```bash
npm test        # 单元测试（node:test，零依赖，无需 npm install）
npm run build   # 校验 manifest 并产出 dist/
npm run verify  # build + test 一起跑
```

安装：Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库的 `dist/` 目录。

使用：
1. 点扩展图标 → 「编辑简历」填写姓名 / 邮箱 / 电话等（保存后写入 `chrome.storage.local`）。
2. 打开任意 Greenhouse / Lever / Workday 职位申请表。
3. 点扩展图标 → 「一键填充当前页面」。
4. 已填字段高亮 2 秒，页面右下角弹出结果提示；popup 同时显示「已填 N 项」以及简历缺失、页面缺失的字段。

## 目录结构

```
src/
  manifest.json              MV3 声明（content_scripts 顺序：schema → matcher → content）
  lib/resume-schema.js       数据模型：默认值、校验、v1→v2 迁移、导入导出、取值规则
  lib/field-matcher.js       字段识别引擎：中英词库 + 属性加权打分 + ATS 规则 + 负向词
  lib/storage.js             chrome.storage.local 封装（唯一碰 chrome.* 的存储入口）
  content/content.js         DOM 描述符抽取 → 匹配 → 赋值（原生 setter 兼容 React）→ 高亮 → 回报
  popup/                     一键填充入口与结果展示
  options/                   简历编辑、JSON 导入导出、清空
  background/service-worker.js  安装时初始化存储 + 消息兜底路由
scripts/build.mjs            零依赖构建：校验引用完整性 + 拷贝到 dist/
tests/                       node:test 单元测试
```

## 识别引擎怎么打分

每个输入框先被抽成与 DOM 无关的「描述符」：

```js
{ labelText, ariaLabel, placeholder, nearbyText, title, name, id, dataAutomationId, className }
```

然后按 **属性权重 × 词库权重** 打分，取最高分：

- 属性权重：`label 3.0` > `aria-label 2.6` > `placeholder 2.4` > `data-automation-id 2.2` > `nearby 2.0` > `name 1.8` > `id 1.6`
- 词库权重：强特征 `1.0`（`email` / `邮箱` / `firstname` / `电话`…）、中 `0.7`、弱 `0.5`（`name`、`first` 这类泛词，避免抢分）
- `confidence = score / 3`，低于 `0.5` 不填
- ATS 精确规则命中直接给 `confidence = 1`（例如 Greenhouse `#first_name`、Lever `name="urls[LinkedIn]"`、Workday `data-automation-id="legalNameSection_firstName"`）；Lever 的裸 `name` 属性必须精确匹配，否则 `user_name` 会被误判
- 负向词保护：`REJECTS` 让「Company Name」不会变姓名、「Email Address」不会变地址；`GLOBAL_REJECTS` 整体跳过密码、验证码、搜索框

中文特例：「姓名」判全名，「姓」判姓氏，「名」判名字——靠 `REJECTS.firstName` 里的 `姓` 与 `REJECTS.lastName` 里的 `姓名` 做互斥，避免「姓」是「姓名」子串导致的错位。

## 测试覆盖

`npm test` 共 4 个测试文件：

- `tests/field-matcher.test.js`：中英文 label / placeholder / aria / name / id 识别、姓与名互斥、负向排除、三家 ATS 精确规则、置信度阈值、填充计划（已填 / 简历缺数据 / 页面无字段）、字段清单与 schema 一致性
- `tests/resume-schema.test.js`：默认值完整性、非法输入、数字转字符串、v1 扁平结构迁移、fullName 组合与 summary 回退、导出导入往返、表单路径合法性
- `tests/storage.test.js`：用假的 `chrome.storage.local` 验证保存/读回、校验失败不落盘、脏数据回退、清空
- `tests/manifest.test.js`：MV3 声明、版本号一致性、权限齐备、引用文件全部存在、content_scripts 顺序、html 内引用可解析、源文件不含 ES module 语法

## 已知边界（MVP 有意为之）

- 只处理顶层文档（`all_frames: false`），iframe 内表单不填
- `select` 只在选项文本能精确匹配时选中，不做省/国家这类字典映射
- 不处理文件上传（简历 PDF）与自定义下拉组件
- 高亮是内联注入的 `class`，个别站点用 Shadow DOM 时可能不生效
