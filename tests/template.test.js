'use strict';

/**
 * 迭代 3 验收 1 / 2 / 6：简历模板三组、自定义项与 key 稳定性、完整度、防抖保存、姓名拼接。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/lib/resume-schema.js');
const T = require('../src/lib/template.js');
const SUP = require('../src/lib/supplement.js');

function seededResume() {
  return T.seedTemplateResume(S.createEmptyResume()).resume;
}

test('验收 1：模板正好三组，组名与内置字段符合 PRD', () => {
  assert.deepEqual(T.GROUPS.map((g) => g.id), ['basic', 'intent', 'extra']);
  assert.deepEqual(T.GROUPS.map((g) => g.title), ['基本信息', '求职意向', '教育与其他']);

  const groups = T.templatesFor(S.createEmptyResume());
  const basic = groups[0];
  const basicKeys = basic.rows.map((r) => r.key);
  for (const key of ['lastName', 'firstName', 'fullName', 'email', 'phone', 'city', 'address']) {
    assert.ok(basicKeys.includes(key), `基本信息缺少 ${key}`);
  }
  assert.equal(basic.rows.find((r) => r.key === 'lastName').label, '姓氏');

  const extraKeys = groups[2].rows.map((r) => r.key);
  for (const key of ['summary', 'website', 'school', 'degree']) {
    assert.ok(extraKeys.includes(key), `教育与其他缺少 ${key}`);
  }
});

test('预置项只播种一次：删掉后刷新不会自动长回来', () => {
  const first = T.seedTemplateResume(S.createEmptyResume());
  assert.equal(first.changed, true);
  assert.equal(first.resume.presetsSeeded, true);
  assert.deepEqual(
    first.resume.customFields.filter((f) => f.group === 'intent').map((f) => f.key),
    ['expected_role', 'expected_salary', 'available_date']
  );
  assert.ok(first.resume.customFields.every((f) => f.preset === true && f.value === ''));

  const removed = T.removeCustomField(first.resume, 'expected_salary');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);

  const again = T.seedTemplateResume(removed.resume);
  assert.equal(again.changed, false);
  assert.ok(!again.resume.customFields.some((f) => f.key === 'expected_salary'), '删掉的预置项不该复活');

  const groups = T.templatesFor(removed.resume);
  assert.ok(!groups[1].rows.some((r) => r.key === 'expected_salary'));
});

test('验收 2：添加「期望薪资」落进第三组，同 label 两次只产生一个 key', () => {
  const base = seededResume();
  const first = T.addCustomField(base, '期望薪资', 'extra');
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.match(first.field.key, /^cf_[a-z0-9]+$/, '纯中文 label 应得到确定性哈希 key');
  assert.equal(first.field.group, 'extra');

  const second = T.addCustomField(first.resume, '期望薪资', 'extra');
  assert.equal(second.ok, true);
  assert.equal(second.created, false, '同 label 第二次添加不应新建字段');
  assert.equal(second.field.key, first.field.key);
  assert.equal(
    second.resume.customFields.filter((f) => f.label === '期望薪资' && f.key === first.field.key).length,
    1
  );

  const groups = T.templatesFor(first.resume, { seed: false });
  const extra = groups.find((g) => g.id === 'extra');
  assert.ok(
    extra.rows.some((r) => r.key === first.field.key && r.label === '期望薪资'),
    '新加的项应出现在第三组'
  );

  // 英文 label 走 slug，仍然稳定
  const en = T.addCustomField(base, 'Portfolio Link', 'extra');
  assert.equal(en.field.key, 'portfolio_link');
  assert.equal(T.addCustomField(en.resume, 'Portfolio Link', 'extra').created, false);
});

test('内置字段不可删，只能清空', () => {
  const base = seededResume();
  const result = T.removeCustomField(base, 'email');
  assert.equal(result.ok, false);
  assert.match(result.error, /内置字段/);
});

test('验收 1：完整度计数（总数 / 已填 / 每组进度）', () => {
  const base = seededResume();
  base.basics.lastName = '张';
  base.basics.firstName = '三';
  base.basics.email = 'san@example.com';

  const groups = T.templatesFor(base, { seed: false });
  const stats = T.computeCompleteness(groups, base);

  assert.equal(stats.total, 17, '7 基本信息 + 3 求职意向 + 7 教育与其他');
  // 姓、名、全名（自动拼接）都算填了
  assert.equal(stats.filled, 4);
  assert.equal(stats.missing, 13);
  assert.equal(stats.percent, 24);

  const basic = stats.groups.find((g) => g.id === 'basic');
  assert.deepEqual({ filled: basic.filled, total: basic.total }, { filled: 4, total: 7 });
  assert.equal(basic.percent, 57);
  assert.deepEqual(stats.groups.map((g) => g.id), ['basic', 'intent', 'extra']);
  assert.equal(stats.groups.find((g) => g.id === 'intent').filled, 0);
});

test('验收 1：防抖保存 —— 连续输入只落盘一次，延迟不超过 500ms', () => {
  const timers = [];
  const saved = [];
  const saver = T.createDebouncedSaver({
    delay: T.SAVE_DELAY,
    save: (value) => {
      saved.push(value);
      return value;
    },
    setTimer: (fn, ms) => {
      timers.push({ fn: fn, ms: ms });
      return timers.length;
    },
    clearTimer: () => {}
  });

  assert.ok(saver.delay <= 500, 'PRD 要求防抖 ≤ 500ms');

  saver.push('a');
  saver.push('b');
  saver.push('c');
  assert.equal(saved.length, 0, '防抖期内不应落盘');
  assert.equal(saver.stats().scheduled, 3);
  assert.equal(saver.isPending(), true);

  timers[timers.length - 1].fn();
  assert.deepEqual(saved, ['c'], '只保存最后一次输入');
  assert.equal(saver.isPending(), false);
  assert.equal(saver.stats().saves, 1);
});

test('验收 1：失焦 flush 立即保存，且不会重复保存', () => {
  const timers = [];
  const saved = [];
  const saver = T.createDebouncedSaver({
    delay: 400,
    save: (value) => {
      saved.push(value);
      return value;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {}
  });

  saver.push('x');
  saver.flush();
  assert.deepEqual(saved, ['x'], 'flush 应立刻保存');
  assert.equal(saver.isPending(), false);

  timers.forEach((fn) => fn());
  assert.deepEqual(saved, ['x'], '定时器晚到不能再存一次');
  assert.equal(saver.flush(), null, '没有待保存内容时 flush 返回 null');
});

test('验收 6：fullName 中文按「姓 + 名」拼接，手动改写后不再自动覆盖', () => {
  assert.equal(S.composeFullName('三', '张'), '张三');
  assert.equal(S.composeFullName('San', 'Zhang'), 'San Zhang');
  assert.equal(S.composeFullName('', '张'), '张');
  assert.equal(S.composeFullName('三', ''), '三');
  assert.equal(S.composeFullName('', ''), '');

  const resume = S.createEmptyResume();
  resume.basics.firstName = '三';
  resume.basics.lastName = '张';
  assert.equal(S.resolveValue(resume, 'fullName'), '张三', '留空时自动拼接');

  // 用户手改：以用户写的为准
  resume.basics.fullName = '张三丰';
  assert.equal(S.resolveValue(resume, 'fullName'), '张三丰');

  // 用户手动清空 + 标记 manual：不再自动回落
  resume.basics.fullName = '';
  resume.fullNameManual = true;
  assert.equal(S.resolveValue(resume, 'fullName'), '');

  const checked = S.validateResume(resume);
  assert.equal(checked.resume.fullNameManual, true, '校验/迁移要保留手动标记');
  assert.equal(JSON.parse(S.exportJSON(resume)).fullNameManual, true, '导出的 JSON 要保留手动标记');

  // 补填写全名同样算手动改过
  const applied = SUP.applySupplement(S.createEmptyResume(), 'fullName', '李四');
  assert.equal(applied.ok, true);
  assert.equal(applied.resume.basics.fullName, '李四');
  assert.equal(applied.resume.fullNameManual, true);
});
