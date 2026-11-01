'use strict';

/**
 * 迭代 5 验收 2：Shadow DOM 穿透。
 *
 * jsdom 不支持 shadowRoot，这里用手写的最小 DOM stub 树验证：
 * 两层嵌套 shadow 可收集、路径可重建、shadow 内的 password / hidden 仍被排除。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/lib/shadow.js');

/* --------------------------------------------------------------- DOM stub */

function matches(el, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[name="')) return el.getAttribute('name') === sel.slice(7, -2);
  const m = /^([a-z0-9]+)(?::nth-of-type\((\d+)\))?$/i.exec(sel);
  if (!m) return false;
  if (el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  if (!m[2]) return true;
  const parent = el.parentNode;
  if (!parent || !parent.children) return false;
  const same = parent.children.filter((child) => child.tagName.toLowerCase() === m[1].toLowerCase());
  return String(same.indexOf(el) + 1) === m[2];
}

function attachQuery(container) {
  function query(selector, all) {
    const found = [];
    const walk = (node) => {
      const kids = node.children || [];
      for (const child of kids) {
        if (matches(child, selector)) {
          found.push(child);
          if (!all) return true;
        }
        if (walk(child)) return true;
      }
      return false;
    };
    walk(container);
    return all ? found : found[0] || null;
  }
  container.querySelector = (selector) => query(selector, false);
  container.querySelectorAll = (selector) => query(selector, true);
  return container;
}

function makeRoot() {
  return attachQuery({ children: [] });
}

function makeShadowRoot(host) {
  return attachQuery({ children: [], host });
}

function node(tag, opts) {
  const options = opts || {};
  const attributes = Object.assign({}, options.attrs || {});
  if (options.name) attributes.name = options.name;
  if (options.type) attributes.type = options.type;
  const el = {
    tagName: tag.toUpperCase(),
    id: options.id || '',
    className: options.className || '',
    parentNode: null,
    children: [],
    shadowRoot: null,
    hidden: options.hidden === true,
    disabled: options.disabled === true,
    readOnly: options.readOnly === true,
    style: options.style || {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    }
  };
  return attachQuery(el);
}

function add(parent, child) {
  child.parentNode = parent;
  parent.children.push(child);
  return child;
}

/** 两层嵌套：root > #host-a > (shadow) > div.inner > (shadow) > input */
function buildNestedTree() {
  const root = makeRoot();
  const hostA = add(root, node('div', { id: 'host-a' }));
  const shadowA = makeShadowRoot(hostA);
  hostA.shadowRoot = shadowA;

  const inner = add(shadowA, node('div', { className: 'inner' }));
  const shadowB = makeShadowRoot(inner);
  inner.shadowRoot = shadowB;

  const email = add(shadowB, node('input', { name: 'email', type: 'text' }));
  const phone = add(shadowB, node('input', { name: 'phone', type: 'tel' }));
  return { root, hostA, shadowA, inner, shadowB, email, phone };
}

/* ------------------------------------------------------------------ 用例 */

test('两层嵌套 shadow 都能收集，path 含两处 HOST_SEP', () => {
  const tree = buildNestedTree();
  const entries = S.collectDeep(tree.root);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.el),
    [tree.email, tree.phone]
  );
  for (const entry of entries) {
    assert.equal(entry.inShadow, true);
    assert.equal(entry.path.split(S.HOST_SEP).length, 3, `path 应为三段：${entry.path}`);
    assert.ok(entry.path.indexOf(S.HOST_SEP) !== -1);
  }
  assert.equal(entries[0].path, '#host-a' + S.HOST_SEP + 'div:nth-of-type(1)' + S.HOST_SEP + '[name="email"]');
});

test('resolvePath 能把 shadow 路径重新定位回同一个 stub 元素', () => {
  const tree = buildNestedTree();
  const entries = S.collectDeep(tree.root);
  assert.equal(S.resolvePath(tree.root, entries[0].path), tree.email);
  assert.equal(S.resolvePath(tree.root, entries[1].path), tree.phone);
});

test('shadow 内的 type=password 被排除', () => {
  const tree = buildNestedTree();
  add(tree.shadowB, node('input', { type: 'password', name: 'pwd' }));

  const entries = S.collectDeep(tree.root);
  assert.equal(entries.length, 2, '密码框不应进入清单');
  assert.ok(!entries.some((entry) => entry.type === 'password'));
  assert.equal(S.excludedForShadow(node('input', { type: 'password' })), true);
  assert.equal(S.excludedForShadow(node('input', { type: 'text' })), false);
});

test('shadow 内的 hidden / aria-hidden / display:none / disabled / readOnly 都被排除', () => {
  const tree = buildNestedTree();
  const hiddenFlag = add(tree.shadowB, node('input', { name: 'h1' }));
  hiddenFlag.hidden = true;
  add(tree.shadowB, node('input', { name: 'h2', attrs: { 'aria-hidden': 'true' } }));
  add(tree.shadowB, node('input', { name: 'h3', style: { display: 'none' } }));
  add(tree.shadowB, node('input', { name: 'h4', disabled: true }));
  add(tree.shadowB, node('input', { name: 'h5', readOnly: true }));

  const entries = S.collectDeep(tree.root);
  assert.deepEqual(
    entries.map((entry) => entry.el.getAttribute('name')),
    ['email', 'phone']
  );
});

test('坏 path 返回 null 且不抛异常', () => {
  const tree = buildNestedTree();
  assert.equal(S.resolvePath(tree.root, 'nope >>> also >>> bad'), null);
  assert.equal(S.resolvePath(tree.root, '#host-a >>> nope'), null);
  assert.equal(S.resolvePath(tree.root, ''), null);
  assert.equal(S.resolvePath(null, '#host-a'), null);
  assert.equal(S.resolvePath({}, '#host-a'), null);
  assert.equal(S.resolvePath(tree.root, S.HOST_SEP + '#host-a'), null);
});

test('cssSelector 在没有 id / name 时退回 tag:nth-of-type(n)', () => {
  const root = makeRoot();
  const first = add(root, node('input'));
  const second = add(root, node('input', { attrs: { type: 'email' } }));
  assert.equal(S.cssSelector(first), 'input:nth-of-type(1)');
  assert.equal(S.cssSelector(second), 'input:nth-of-type(2)');
  assert.equal(S.cssSelector(node('input', { id: 'x y' })).startsWith('#'), true);
});

test('isVisible 返回 false 的元素被跳过，countShadowFields 统计正确', () => {
  const tree = buildNestedTree();
  const entries = S.collectDeep(tree.root, {
    isVisible: (el) => el !== tree.phone
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].el, tree.email);

  assert.equal(S.countShadowFields(entries), 1);
  assert.equal(S.isShadowPath(entries[0].path), true);
  assert.equal(S.isShadowPath('[name="email"]'), false);
  assert.equal(S.countShadowFields([{ path: '[name="a"]' }, { path: 'x >>> y' }, null]), 1);
});
