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

console.log(`\nsmoke 通过：${ok + 1} 项场景全绿。`);
