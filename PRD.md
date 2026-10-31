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
