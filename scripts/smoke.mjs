#!/usr/bin/env node
/**
 * JustClick smoke 测试：不依赖浏览器，直接驱动字段识别引擎跑真实 ATS 场景。
 * 用法：npm run smoke
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../src/lib/field-matcher.js');

// —— 场景 1：单字段类型识别（跨 ATS 命名风格）——
const fieldCases = [
  ['Greenhouse first_name', { id: 'first_name', name: 'job_application[first_name]', label: 'First name', type: 'text' }, 'firstName'],
  ['Lever name', { id: 'apply-name', name: 'name', placeholder: 'Full name', type: 'text' }, 'fullName'],
  ['Workday email', { 'aria-label': 'Email Address', name: 'email', type: 'email' }, 'email'],
  ['Boss直聘 手机号', { name: 'phone', placeholder: '请输入手机号', type: 'tel' }, 'phone'],
  ['拉勾 电话', { name: 'phone', placeholder: '手机号', type: 'tel' }, 'phone'],
];
let ok = 0;
for (const [site, el, want] of fieldCases) {
  const r = api.detectFieldType(el);
  assert.equal(r?.key, want, `${site}: 期望 ${want}，得到 ${r?.key}`);
  assert.ok(r.confidence >= 0.99, `${site}: 置信度应满分，得到 ${r.confidence}`);
  ok += 1;
  console.log(`  ✓ ${site} → ${r.key} (conf ${r.confidence}, ats ${r.ats || '-'})`);
}

// —— 场景 1b（迭代 5）：中国五站点，站点规则只在对应 host 生效 ——
const CN_KEYS = api.FIELD_KEYS.concat([
  'expected_salary',
  'available_date',
  'degree',
  'school',
  'major',
  'work_years',
]);
const siteCases = [
  ['Boss直聘 姓名（geekName）', 'https://www.zhipin.com/web/geek/job', { name: 'geekName', placeholder: '请输入姓名', type: 'text' }, 'fullName'],
  ['Boss直聘 手机号（geekMobile）', 'https://www.zhipin.com/web/geek/job', { name: 'geekMobile', placeholder: '请输入手机号', type: 'tel' }, 'phone'],
  ['智联招聘 姓名（userName）', 'https://sou.zhaopin.com/apply/123', { name: 'userName', type: 'text' }, 'fullName'],
  ['前程无忧 手机号（mobilePhone）', 'https://i.51job.com/resume/apply.php', { name: 'mobilePhone', type: 'tel' }, 'phone'],
  ['拉勾 姓名（userName）', 'https://www.lagou.com/wn/jobs/apply', { name: 'userName', type: 'text' }, 'fullName'],
  ['猎聘 手机号（mobile）', 'https://c.liepin.com/job/apply', { name: 'mobile', type: 'tel' }, 'phone'],
];
let siteOk = 0;
for (const [label, url, el, want] of siteCases) {
  const r = api.detectFieldType(el, { url, fieldKeys: CN_KEYS });
  assert.equal(r?.key, want, `${label}: 期望 ${want}，得到 ${r?.key}`);
  assert.equal(r?.confidence, 1, `${label}: 站点规则应给满分，得到 ${r?.confidence}`);
  assert.ok(r?.ats, `${label}: 应由站点规则命中，实际 ats=${r?.ats}`);
  siteOk += 1;
  console.log(`  ✓ ${label} → ${r.key} (conf ${r.confidence}, ats ${r.ats})`);
}

// —— 场景 3（0.6.1）：中国五站表单，buildFillPlan 级验证（含中文 label） ——
const siteForms = [
  {
    site: 'zhipin',
    url: 'https://www.zhipin.com/web/geek/job',
    fields: [
      { name: 'name', placeholder: '请输入姓名', type: 'text' },
      { name: 'phone', placeholder: '请输入手机号', type: 'tel' },
      { name: 'email', type: 'email' },
    ],
    values: { fullName: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
    keys: ['email', 'fullName', 'phone'],
  },
  {
    site: 'zhaopin',
    url: 'https://sou.zhaopin.com/apply/123',
    fields: [
      { name: 'userName', type: 'text' },
      { name: 'mobile', type: 'tel' },
      { id: 'email', type: 'email' },
    ],
    values: { fullName: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
    keys: ['email', 'fullName', 'phone'],
  },
  {
    site: '51job',
    url: 'https://i.51job.com/resume/apply.php',
    fields: [
      { id: 'inputRealName', type: 'text' },
      { name: 'mobilePhone', type: 'tel' },
      { name: 'email', type: 'email' },
    ],
    values: { fullName: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
    keys: ['email', 'fullName', 'phone'],
  },
  {
    site: 'lagou',
    url: 'https://www.lagou.com/wn/jobs/apply',
    fields: [
      { name: 'userName', type: 'text' },
      { name: 'phone', type: 'tel' },
      { name: 'email', type: 'email' },
    ],
    values: { fullName: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
    keys: ['email', 'fullName', 'phone'],
  },
  {
    site: 'liepin',
    url: 'https://c.liepin.com/job/apply',
    fields: [
      { name: 'realName', type: 'text' },
      { name: 'mobile', type: 'tel' },
      { name: 'email', type: 'email' },
    ],
    values: { fullName: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
    keys: ['email', 'fullName', 'phone'],
  },
];
let formOk = 0;
for (const form of siteForms) {
  const plan = api.buildFillPlan(form.fields, form.values, { url: form.url });
  assert.deepEqual(
    plan.assignments.map((item) => item.key).sort(),
    form.keys,
    `${form.site}: key 集合不符合预期`,
  );
  assert.ok(
    plan.assignments.every((item) => item.ats === form.site),
    `${form.site}: 每条 assignment 的 ats 都应是 ${form.site}`,
  );
  assert.deepEqual(plan.missing, [], `${form.site}: 不应有 missing`);
  assert.deepEqual(plan.notFound, [], `${form.site}: 不应有 notFound`);
  formOk += 1;
  console.log(
    `  ✓ ${form.site} 表单 → ${plan.assignments.map((item) => `${item.key}@${item.ats}`).join(', ')}`,
  );
}

// —— 场景 3b（0.6.1）：中文「期望薪资」走 DICTIONARY，不传 fieldKeys ——
const salaryField = [{ labelText: '期望薪资', name: 'salary', type: 'text' }];
const salaryMissing = api.buildFillPlan(salaryField, {});
assert.ok(
  salaryMissing.missing.some((item) => item.key === 'expected_salary'),
  '没给值时 expected_salary 应进 missing',
);
const salaryPlan = api.buildFillPlan(salaryField, { expected_salary: '30k / 月' });
assert.equal(salaryPlan.assignments.length, 1);
assert.equal(salaryPlan.assignments[0].key, 'expected_salary');
assert.equal(salaryPlan.assignments[0].value, '30k / 月');
assert.equal(salaryPlan.assignments[0].ats, null, '字典命中不带 ats');
let salaryOk = 0;
salaryOk += 1;
console.log('  ✓ 中文「期望薪资」→ expected_salary（字典命中，ats null；缺值进 missing，给值可填）');

// —— 场景 2：Greenhouse 完整表单填充计划 ——
const greenhouse = [
  { id: 'first_name', name: 'job_application[first_name]', label: 'First name', type: 'text' },
  { id: 'last_name', name: 'job_application[last_name]', label: 'Last name', type: 'text' },
  { id: 'email', name: 'job_application[email]', label: 'Email', type: 'email' },
  { id: 'phone', name: 'job_application[phone]', label: 'Phone', type: 'tel' },
  { id: 'question_1234', name: 'job_application[questions][1234]', label: 'Why do you want to work here?', type: 'textarea' },
  { id: 'search-keywords', name: 'keywords', label: 'Search keywords', type: 'text' },
];
const plan = api.buildFillPlan(greenhouse, { firstName: '三', fullName: '张三', email: 'z@example.com', phone: '13800138000' });
assert.equal(plan.assignments.length, 3, '应填 3 个字段（first/email/phone）');
assert.ok(plan.assignments.every((item) => item.confidence === 1), 'ATS 精确规则应满分');
assert.deepEqual(plan.missing.map((m) => m.key), ['lastName'], '缺 lastName 应报 missing');
assert.deepEqual(plan.notFound.map((n) => n.key), ['fullName'], 'fullName 表单没有应报 notFound');
assert.ok(
  !plan.assignments.some((item) => ['question_1234', 'search-keywords'].includes(String(item.index))),
  '开放问题与搜索框必须被排除',
);
console.log('  ✓ Greenhouse 完整表单：3 填入 / 1 missing / 1 notFound / 开放问题排除');

const total = ok + siteOk + formOk + salaryOk + 1;
console.log(`\nsmoke 通过：${total} 项场景全绿（单字段 ${ok} + 站点单字段 ${siteOk} + 站点表单 ${formOk} + 中文薪资 ${salaryOk} + Greenhouse 表单 1）。`);
