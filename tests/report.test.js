'use strict';

/**
 * 迭代 3 验收 3：填充报告三区块（filled / missing / unmatched）、截断与文本导出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/lib/field-matcher.js');
const R = require('../src/lib/report.js');

function desc(extra) {
  return Object.assign({ fillable: true }, extra);
}

/** 模拟一个真实表单：姓名/邮箱能填、地址缺值、城市页面没有 */
function scenario() {
  const descriptors = [
    desc({ id: 'first_name', labelText: 'First Name' }),
    desc({ id: 'email', labelText: 'Email' }),
    desc({ id: 'address', labelText: 'Address' })
  ];
  const values = {
    firstName: 'San',
    email: 'a-very-long-email-address@example.com',
    address: '',
    city: '上海'
  };
  return { descriptors: descriptors, values: values };
}

test('验收 3：报告对象三区块结构正确（filled / missing / unmatched）', () => {
  const { descriptors, values } = scenario();
  const plan = M.buildFillPlan(descriptors, values);
  const report = R.buildReportFromPlan(plan, values, { now: '2026-11-01T10:00:00.000Z' });

  assert.deepEqual(report.filled.map((f) => f.key), ['firstName', 'email']);
  assert.equal(report.filled[0].label, '名');
  assert.equal(report.filled[0].value, 'San');

  assert.deepEqual(report.missing.map((m) => m.key), ['address']);
  assert.equal(report.missing[0].label, '地址');
  assert.equal(report.missing[0].key, 'address');
  assert.ok(!('value' in report.missing[0]), '待填项没有值，不该带 value');

  assert.deepEqual(report.unmatched.map((u) => u.key), ['city']);
  assert.equal(report.unmatched[0].label, '城市');
  assert.equal(report.unmatched[0].value, '上海');

  assert.deepEqual(report.counts, { filled: 2, missing: 1, unmatched: 1 });
  assert.equal(report.total, 4);
  assert.equal(report.at, '2026-11-01T10:00:00.000Z');
});

test('值超过 20 字截断，保留全文供点击展开', () => {
  const { descriptors, values } = scenario();
  const report = R.buildReportFromPlan(M.buildFillPlan(descriptors, values), values);
  const email = report.filled.find((f) => f.key === 'email');

  assert.equal(email.truncated, true);
  assert.equal(email.display, values.email.slice(0, 20) + '…');
  assert.equal(email.value, values.email, '完整值必须保留，展开时要用');

  const short = R.truncateValue('短值');
  assert.deepEqual(short, { display: '短值', truncated: false });
  const exact = R.truncateValue('x'.repeat(20));
  assert.equal(exact.truncated, false, '正好 20 字不算截断');
  assert.equal(R.truncateValue('x'.repeat(21)).truncated, true);
});

test('同一字段既能填又是待填时，只出现在「已填」里', () => {
  const plan = {
    assignments: [{ index: 0, key: 'email', label: '邮箱', value: 'a@b.c' }],
    missing: [{ key: 'email', label: '邮箱', reason: 'no-value' }],
    notFound: [{ key: 'email', label: '邮箱' }]
  };
  const report = R.buildReportFromPlan(plan, { email: 'a@b.c' });
  assert.equal(report.filled.length, 1);
  assert.equal(report.missing.length, 0, '已填的字段不能同时出现在待填里');
  assert.equal(report.unmatched.length, 0, '页面已经填上的字段不算未匹配');
});

test('复制报告：文本包含三区块与计数', () => {
  const { descriptors, values } = scenario();
  const report = R.buildReportFromPlan(M.buildFillPlan(descriptors, values), values, {
    now: '2026-11-01T10:00:00.000Z'
  });
  const text = R.reportToText(report, { url: 'https://jobs.example.com/apply' });

  assert.match(text, /JustClick 填充报告/);
  assert.match(text, /https:\/\/jobs\.example\.com\/apply/);
  assert.match(text, /【已填 2 项】/);
  assert.match(text, /名 = San/);
  assert.match(text, /【待填 1 项】/);
  assert.match(text, /- 地址/);
  assert.match(text, /【未匹配 1 项】/);
  assert.match(text, /城市 = 上海/);
});

test('旧版 content script 只回 label 数组时也能生成报告', () => {
  const report = R.reportFromFillResult({
    filledLabels: ['姓名', '邮箱'],
    missing: ['电话'],
    notFound: ['城市']
  });
  assert.equal(report.counts.filled, 2);
  assert.equal(report.counts.missing, 1);
  assert.equal(report.counts.unmatched, 1);
  assert.equal(report.missing[0].label, '电话');
});

test('空输入不会抛异常', () => {
  const report = R.buildReportFromPlan(null, null);
  assert.deepEqual(report.counts, { filled: 0, missing: 0, unmatched: 0 });
  assert.deepEqual(report.filled, []);
  assert.equal(typeof R.reportToText(null), 'string');
});
