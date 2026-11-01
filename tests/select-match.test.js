'use strict';

/**
 * 迭代 5 验收 3：中文 select 值匹配。
 * 纯函数，只吃 [{text, value}]，DOM 侧由 content.js 负责 selectedIndex + 事件。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/lib/select-match.js');

const DEGREE = [
  { text: '请选择', value: '' },
  { text: '大专', value: 'college' },
  { text: '本科及以上', value: 'bachelor' },
  { text: '硕士研究生', value: 'master' },
  { text: '博士', value: 'phd' }
];

test('归一化精确匹配：忽略大小写、空格与全角空格', () => {
  const options = [
    { text: '请选择', value: '' },
    { text: '男', value: 'MALE' },
    { text: '女', value: 'female' }
  ];
  assert.equal(S.matchSelectOption(options, 'male'), 1, 'value 精确命中（大小写不敏感）');
  assert.equal(S.matchSelectOption(options, ' 女 '), 2);
  assert.equal(S.matchSelectOption([{ text: '北 京', value: 'bj' }], '北京'), 0);
});

test('包含式：本科 命中 本科及以上', () => {
  assert.equal(S.matchSelectOption(DEGREE, '本科'), 2);
});

test('同义词组：硕士 命中 研究生', () => {
  assert.equal(S.matchSelectOption(DEGREE, '硕士'), 3);
  const options = [{ text: '研究生', value: 'graduate' }];
  assert.equal(S.matchSelectOption(options, '硕士'), 0);
});

test('到岗语义：随时 / 一周内 / 一个月内 都能命中对应选项', () => {
  const arrival = [
    { text: '随时到岗', value: 'now' },
    { text: '一周以内', value: 'week' },
    { text: '一个月以内', value: 'month' }
  ];
  assert.equal(S.matchSelectOption(arrival, '随时'), 0);
  assert.equal(S.matchSelectOption(arrival, '立即'), 0);
  assert.equal(S.matchSelectOption(arrival, '一周内'), 1);
  assert.equal(S.matchSelectOption(arrival, '一个月内'), 2);
  assert.equal(S.matchSelectOption([{ text: '一月内', value: 'm' }], '一个月内'), 0);
});

test('无匹配返回 -1（空 options / 空值 / 无关文案）', () => {
  assert.equal(S.matchSelectOption(DEGREE, '中专'), -1);
  assert.equal(S.matchSelectOption([], '本科'), -1);
  assert.equal(S.matchSelectOption(DEGREE, ''), -1);
  assert.equal(S.matchSelectOption(null, '本科'), -1);
});

test('单字不参与包含式：本 不命中 本科', () => {
  assert.equal(S.matchSelectOption(DEGREE, '本'), -1);
  assert.equal(S.matchSelectOption([{ text: '本科', value: 'bk' }], '本'), -1);
});

test('精确优先于包含式：本科 选 本科 而不是 本科及以上', () => {
  const options = [
    { text: '本科及以上', value: 'bachelor+' },
    { text: '本科', value: 'bachelor' }
  ];
  assert.equal(S.matchSelectOption(options, '本科'), 1);
});

test('normalizeOption 去掉标点与全角空格', () => {
  assert.equal(S.normalizeOption(' 本科（全日制） '), '本科全日制');
  assert.equal(S.normalizeOption('硕士 / 研究生'), '硕士研究生');
  assert.equal(S.normalizeOption(null), '');
});
