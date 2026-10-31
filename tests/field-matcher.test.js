'use strict';

/**
 * 字段识别引擎单元测试
 * 覆盖 PRD 验收要求：中英文 label / placeholder / aria / name / id 语义匹配 + 三家 ATS 适配。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/lib/field-matcher.js');
const S = require('../src/lib/resume-schema.js');

/** 构造一个「可见可填」的描述符 */
function desc(extra) {
  return Object.assign({ fillable: true }, extra);
}

function keyOf(extra, options) {
  const hit = M.detectFieldType(desc(extra));
  if (!hit) return null;
  if (options && options.minConfidence && hit.confidence < options.minConfidence) return null;
  return hit.key;
}

test('归一化：大小写、空格、标点、连字符都被抹平', () => {
  assert.equal(M.normalizeText('E-Mail '), 'email');
  assert.equal(M.normalizeText('First Name *'), 'firstname');
  assert.equal(M.normalizeText('姓 名'), '姓名');
  assert.equal(M.normalizeText('phone-number'), 'phonenumber');
  assert.equal(M.normalizeText(null), '');
  assert.equal(M.normalizeText('   '), '');
});

test('英文 label 识别', () => {
  const cases = [
    ['First Name', 'firstName'],
    ['Last Name', 'lastName'],
    ['Full Name', 'fullName'],
    ['Name', 'fullName'],
    ['Email', 'email'],
    ['E-mail Address', 'email'],
    ['Phone', 'phone'],
    ['Mobile Number', 'phone'],
    ['City', 'city'],
    ['Street Address', 'address'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub', 'github'],
    ['Portfolio / Website', 'website'],
    ['Tell us about yourself', 'summary']
  ];
  for (const [label, expected] of cases) {
    assert.equal(keyOf({ labelText: label }), expected, `label "${label}" 应识别为 ${expected}`);
  }
});

test('中文 label 识别（含「姓 / 名」子串陷阱）', () => {
  assert.equal(keyOf({ labelText: '姓名' }), 'fullName');
  assert.equal(keyOf({ labelText: '真实姓名' }), 'fullName');
  assert.equal(keyOf({ labelText: '名字' }), 'fullName');
  assert.equal(keyOf({ labelText: '姓' }), 'lastName');
  assert.equal(keyOf({ labelText: '姓氏' }), 'lastName');
  assert.equal(keyOf({ labelText: '名' }), 'firstName');
  assert.equal(keyOf({ labelText: '邮箱' }), 'email');
  assert.equal(keyOf({ labelText: '电子邮箱' }), 'email');
  assert.equal(keyOf({ labelText: '手机号' }), 'phone');
  assert.equal(keyOf({ labelText: '联系电话' }), 'phone');
  assert.equal(keyOf({ labelText: '所在城市' }), 'city');
  assert.equal(keyOf({ labelText: '详细地址' }), 'address');
  assert.equal(keyOf({ labelText: '个人网站' }), 'website');
  assert.equal(keyOf({ labelText: '自我介绍' }), 'summary');
  assert.equal(keyOf({ labelText: '工作经历' }), 'summary');
});

test('只有 placeholder 时也能识别', () => {
  assert.equal(keyOf({ placeholder: '请输入邮箱' }), 'email');
  assert.equal(keyOf({ placeholder: 'Your full name' }), 'fullName');
  assert.equal(keyOf({ placeholder: 'Enter your email address' }), 'email');
});

test('aria-label / nearbyText / name / id 都能作为识别来源', () => {
  assert.equal(keyOf({ ariaLabel: '手机号码' }), 'phone');
  assert.equal(keyOf({ nearbyText: 'Email address' }), 'email');
  assert.equal(keyOf({ id: 'user_email' }), 'email');
  assert.equal(keyOf({ name: 'applicant_phone' }), 'phone');
  assert.equal(keyOf({ name: 'candidate_city' }), 'city');
});

test('label 的权重高于 id / class（冲突时以 label 为准）', () => {
  const hit = M.detectFieldType(desc({ labelText: 'Email', id: 'address-input', className: 'address' }));
  assert.equal(hit.key, 'email');
  assert.equal(hit.attr, 'label');
});

test('负向排除：密码、验证码、搜索、公司名不会被误填', () => {
  assert.equal(M.detectFieldType(desc({ type: 'password', labelText: 'Password' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: '密码' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: '验证码' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: 'Search jobs' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: 'Company Name' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: 'Username' })), null);
  assert.equal(M.detectFieldType(desc({ labelText: 'Nickname' })), null);
  assert.equal(M.detectFieldType(desc({ fillable: false, labelText: 'Email' })), null);
  assert.equal(M.isExcludedDescriptor(desc({ labelText: 'Confirm Password' })), true);
});

test('ATS 适配：Greenhouse（id / name 属性）', () => {
  const first = M.detectFieldType(desc({ id: 'first_name' }));
  assert.equal(first.key, 'firstName');
  assert.equal(first.ats, 'greenhouse');
  assert.equal(first.confidence, 1);

  const email = M.detectFieldType(desc({ name: 'job_application[email]' }));
  assert.equal(email.key, 'email');
  assert.equal(email.ats, 'greenhouse');

  const phone = M.detectFieldType(desc({ name: 'job_application[phone]' }));
  assert.equal(phone.key, 'phone');
});

test('ATS 适配：Lever（裸 name 属性，必须精确匹配）', () => {
  const name = M.detectFieldType(desc({ name: 'name' }));
  assert.equal(name.key, 'fullName');
  assert.equal(name.ats, 'lever');

  assert.equal(M.detectFieldType(desc({ name: 'urls[LinkedIn]' })).key, 'linkedin');
  assert.equal(M.detectFieldType(desc({ name: 'urls[GitHub]' })).key, 'github');
  assert.equal(M.detectFieldType(desc({ name: 'urls[Portfolio]' })).key, 'website');

  // 'user_name' / 'company_name' 不能被 lever 的裸 name 规则吃掉
  assert.equal(M.matchAts(desc({ name: 'user_name' })), null);
  assert.equal(M.matchAts(desc({ name: 'company_name' })), null);
});

test('ATS 适配：Workday（data-automation-id）', () => {
  assert.equal(M.detectFieldType(desc({ dataAutomationId: 'legalNameSection_firstName' })).key, 'firstName');
  assert.equal(M.detectFieldType(desc({ dataAutomationId: 'legalNameSection_lastName' })).key, 'lastName');
  assert.equal(M.detectFieldType(desc({ dataAutomationId: 'addressSection_addressLine1' })).key, 'address');
  assert.equal(M.detectFieldType(desc({ dataAutomationId: 'addressSection_city' })).key, 'city');
  assert.equal(M.detectFieldType(desc({ dataAutomationId: 'phone-number' })).ats, 'workday');
});

test('置信度阈值可配置', () => {
  // "First" 只有弱特征，满分 3 分里拿 1.5 -> 0.5
  assert.equal(keyOf({ labelText: 'First' }), 'firstName');
  assert.equal(keyOf({ labelText: 'First' }, { minConfidence: 0.6 }), null);
  // 完全无关的字段不产生匹配
  assert.equal(M.detectFieldType(desc({ labelText: 'Referred by' })), null);
});

test('matchForm 返回与描述符下标对齐的结果', () => {
  const descriptors = [
    desc({ labelText: 'First Name' }),
    desc({ labelText: 'Referred by' }),
    desc({ labelText: 'Email' })
  ];
  const matched = M.matchForm(descriptors);
  assert.deepEqual(matched.map((m) => m.index), [0, 2]);
  assert.deepEqual(matched.map((m) => m.key), ['firstName', 'email']);
});

test('buildFillPlan：填入、缺数据、页面无该字段 三类结果', () => {
  const descriptors = [
    desc({ labelText: 'First Name' }),
    desc({ labelText: 'Last Name' }),
    desc({ labelText: 'Email' }),
    desc({ labelText: 'Address' })
  ];
  const values = {
    firstName: 'San',
    lastName: 'Zhang',
    email: 'san@example.com',
    phone: '+86 138 0000 0000',
    address: ''
  };
  const plan = M.buildFillPlan(descriptors, values);

  assert.equal(plan.assignments.length, 3);
  assert.deepEqual(plan.assignments.map((a) => a.index), [0, 1, 2]);
  assert.deepEqual(plan.assignments.map((a) => a.value), ['San', 'Zhang', 'san@example.com']);

  // 页面上有 Address，但简历没写 -> missing
  assert.deepEqual(plan.missing.map((m) => m.key), ['address']);
  assert.equal(plan.missing[0].label, '地址');
  assert.equal(plan.missing[0].reason, 'no-value');

  // 简历有 phone，但页面上找不到 -> notFound
  assert.deepEqual(plan.notFound.map((m) => m.key), ['phone']);
});

test('buildFillPlan：Greenhouse 表单最小验收（姓名/邮箱/电话全部命中）', () => {
  const descriptors = [
    desc({ id: 'first_name', labelText: 'First Name' }),
    desc({ id: 'last_name', labelText: 'Last Name' }),
    desc({ id: 'email', labelText: 'Email' }),
    desc({ id: 'phone', labelText: 'Phone' }),
    desc({ id: 'resume_text', labelText: 'Resume/CV' })
  ];
  const values = {
    firstName: 'San',
    lastName: 'Zhang',
    email: 'san@example.com',
    phone: '+86 138 0000 0000',
    summary: '5 年前端'
  };
  const plan = M.buildFillPlan(descriptors, values);
  assert.deepEqual(plan.assignments.map((a) => a.key), ['firstName', 'lastName', 'email', 'phone']);
  assert.equal(plan.missing.length, 0);
  assert.deepEqual(plan.notFound.map((m) => m.key), ['summary']);
});

test('字段清单与 schema 保持一致（防止两处漂移）', () => {
  assert.deepEqual(M.FIELD_KEYS, S.FIELD_KEYS);
  assert.deepEqual(M.FIELD_LABELS, S.FIELD_LABELS);
});
