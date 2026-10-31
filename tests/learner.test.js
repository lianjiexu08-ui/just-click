'use strict';

/**
 * 「从当前页学习」单元测试
 * 不引入 jsdom：用手写 DOM stub 验证扫描、选择器兜底、规则生成与忽略项。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/lib/learner.js');

/**
 * 极简元素：只有 tagName / id / getAttribute。
 * parentNode 仅用于 nth-of-type 的补充用例，不影响主验收。
 */
function stubElement(tagName, attrs, extra) {
  const data = attrs || {};
  const el = {
    tagName: String(tagName).toUpperCase(),
    id: data.id || '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
    }
  };
  if (extra && extra.parentNode) el.parentNode = extra.parentNode;
  if (extra && extra.throwOnGetAttribute) {
    el.getAttribute = function () {
      throw new Error('stub getAttribute failure');
    };
  }
  return el;
}

function stubRoot(elements) {
  return {
    querySelectorAll() {
      return elements;
    }
  };
}

function buildPage() {
  return [
    stubElement('input', { id: 'f1', name: 'expected_salary', 'aria-label': '期望薪资', type: 'text' }),
    stubElement('textarea', { name: 'cover_letter', 'aria-label': 'Cover Letter' }, { parentNode: null }),
    stubElement('input', { id: 'email', name: 'email', 'aria-label': 'Email', type: 'email' }),
    stubElement('input', { type: 'hidden', name: 'token' }),
    stubElement('input', { type: 'password', name: 'password' }),
    stubElement('input', { id: 'invisible', name: 'invisible', type: 'text' })
  ];
}

test('验收 4：手写 DOM stub 扫描出字段清单并生成规则，忽略项不生成', () => {
  const root = stubRoot(buildPage());
  const entries = L.collectFields(root, {
    isVisible(el) {
      return el.id !== 'invisible';
    }
  });

  assert.equal(entries.length, 3, 'hidden / password / 不可见字段必须被跳过');
  assert.deepEqual(entries.map((e) => e.index), [0, 1, 2]);
  assert.deepEqual(entries.map((e) => e.tag), ['input', 'textarea', 'input']);

  assert.equal(entries[0].label, '期望薪资');
  assert.equal(entries[0].attrs.name, 'expected_salary');
  assert.equal(entries[0].selector, '#f1');
  assert.equal(entries[0].suggestedKey, '', '自定义字段不该被字典猜出来');

  assert.equal(entries[1].selector, '[name="cover_letter"]');
  assert.equal(entries[2].suggestedKey, 'email', '内置字段应给出建议');

  const rules = L.buildRulesFromSelection(
    entries,
    { 0: 'expected_salary', 1: '__ignore__', 2: '__ignore__' },
    { sitePattern: 'jobs.example.com' }
  );

  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.target, 'expected_salary');
  assert.deepEqual(rule.match.attrs, ['name'], 'name 比短 id 更具体，应优先');
  assert.equal(rule.match.pattern, 'expected_salary');
  assert.equal(rule.match.matchType, 'contains');
  assert.equal(rule.scope.sitePattern, 'jobs.example.com');
  assert.equal(rule.source, 'manual');
  assert.equal(rule.enabled, true);
  assert.ok(rule.id);
});

test('collectFields 对空 root / 抛异常的 querySelectorAll 都返回空数组', () => {
  assert.deepEqual(L.collectFields(null), []);
  assert.deepEqual(L.collectFields({}), []);
  assert.deepEqual(
    L.collectFields({
      querySelectorAll() {
        throw new Error('boom');
      }
    }),
    []
  );
});

test('isVisible 抛异常时跳过该字段，而不是让整次扫描失败', () => {
  const root = stubRoot([stubElement('input', { name: 'email', type: 'text' })]);
  const entries = L.collectFields(root, {
    isVisible() {
      throw new Error('visibility unavailable');
    }
  });
  assert.deepEqual(entries, []);
});

test('selectorFor：id > name > nth-of-type > tag，且任何异常都不抛', () => {
  assert.equal(L.selectorFor(stubElement('input', { id: 'expected_salary' })), '#expected_salary');
  assert.equal(L.selectorFor(stubElement('input', { name: 'expected_salary' })), '[name="expected_salary"]');
  assert.equal(L.selectorFor(stubElement('textarea', {})), 'textarea');

  const first = stubElement('input', {});
  const second = stubElement('input', {});
  const parent = { children: [first, second] };
  first.parentNode = parent;
  second.parentNode = parent;
  assert.equal(L.selectorFor(second), 'input:nth-of-type(2)');

  const quote = stubElement('input', { name: 'weird"name' });
  assert.equal(L.selectorFor(quote), '[name="weird\\"name"]');

  const broken = stubElement('input', {}, { throwOnGetAttribute: true });
  assert.equal(L.selectorFor(broken), 'input', 'getAttribute 抛异常时兜底返回 tag');
  assert.equal(L.selectorFor(null), 'input');
});

test('suggestRuleFor：挑最具体的属性，支持 matchType 覆盖，无属性返回 null', () => {
  const entry = {
    index: 0,
    attrs: { id: 'f1', name: 'expected_salary', label: '期望薪资', placeholder: '', ariaLabel: '期望薪资' }
  };
  const rule = L.suggestRuleFor(entry, 'expected_salary', { sitePattern: '', matchType: 'exact' });
  assert.deepEqual(rule.match.attrs, ['name']);
  assert.equal(rule.match.pattern, 'expected_salary');
  assert.equal(rule.match.matchType, 'exact');

  assert.equal(L.suggestRuleFor({ attrs: {} }, 'expected_salary'), null);
  assert.equal(L.suggestRuleFor({ attrs: { name: '   ' } }, 'expected_salary'), null);
});

test('buildRulesFromSelection 对空选择 / 全忽略 / 不存在的 index 都返回空', () => {
  const entries = L.collectFields(stubRoot(buildPage()), { isVisible: () => true });
  assert.deepEqual(L.buildRulesFromSelection(entries, {}, {}), []);
  assert.deepEqual(
    L.buildRulesFromSelection(entries, { 0: '__ignore__', 1: '__ignore__', 2: '__ignore__' }, {}),
    []
  );
  assert.deepEqual(L.buildRulesFromSelection(entries, { 99: 'email' }, {}), []);
});
