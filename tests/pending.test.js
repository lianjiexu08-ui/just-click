'use strict';

/**
 * 迭代 3 验收 5：pendingItems 跨会话存活、按 key 去重、补后清除。
 * 用 chrome.storage.local stub 驱动真实读写路径，不 mock 业务函数。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bag = {};
global.chrome = {
  storage: {
    local: {
      get(key) {
        if (typeof key === 'string') {
          const out = {};
          if (Object.prototype.hasOwnProperty.call(bag, key)) out[key] = bag[key];
          return Promise.resolve(out);
        }
        return Promise.resolve(Object.assign({}, bag));
      },
      set(obj) {
        Object.assign(bag, JSON.parse(JSON.stringify(obj)));
        return Promise.resolve();
      }
    }
  }
};

const Pending = require('../src/lib/pending.js');

test('存储键与 schema 版本固定', () => {
  assert.equal(Pending.PENDING_KEY, 'jc.pending');
  assert.equal(Pending.PENDING_SCHEMA_VERSION, 1);
});

test('验收 5：未补的待填项跨会话存活（重新加载模块仍读得到）', async () => {
  await Pending.clearPendingItems();
  await Pending.addPendingItems(
    [
      { key: 'phone', label: '电话', source: 'fill-report' },
      { key: 'city', label: '城市' }
    ],
    { host: 'jobs.example.com', now: '2026-11-01T10:00:00.000Z' }
  );

  // 模拟「关掉 popup 再打开」：清掉模块缓存，重新 require
  delete require.cache[require.resolve('../src/lib/pending.js')];
  const reloaded = require('../src/lib/pending.js');
  const bagAfterReload = await reloaded.getPendingItems();

  assert.equal(bagAfterReload.items.length, 2);
  assert.deepEqual(bagAfterReload.items.map((i) => i.key), ['phone', 'city']);
  assert.equal(bagAfterReload.items[0].host, 'jobs.example.com');
  assert.equal(bagAfterReload.items[0].at, '2026-11-01T10:00:00.000Z');
  assert.equal(bagAfterReload.items[0].label, '电话');
});

test('验收 5：按 key 去重，重复添加只留最新一条', async () => {
  await Pending.clearPendingItems();
  await Pending.addPendingItems([{ key: 'phone', label: '电话', at: '2026-11-01T10:00:00.000Z' }], {
    host: 'a.example.com'
  });
  await Pending.addPendingItems([{ key: 'phone', label: '电话号码', at: '2026-11-01T12:00:00.000Z' }], {
    host: 'b.example.com'
  });

  const result = await Pending.getPendingItems();
  assert.equal(result.items.length, 1, '同一 key 不应产生两条');
  assert.equal(result.items[0].host, 'b.example.com', '保留最新来源站点');
  assert.equal(result.items[0].label, '电话号码');
  assert.equal(result.items[0].at, '2026-11-01T12:00:00.000Z');

  // 时间更早的一条不该覆盖新的
  const merged = Pending.mergePendingItems(
    [{ key: 'phone', label: '电话号码', host: 'b.example.com', at: '2026-11-01T12:00:00.000Z' }],
    [{ key: 'phone', label: '电话', host: 'c.example.com', at: '2026-11-01T09:00:00.000Z' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].host, 'b.example.com');
  assert.equal(merged[0].label, '电话', '同 key 只是刷新展示名，来源仍取更新的那条');
});

test('验收 5：补值后从清单移除，忽略同理', async () => {
  await Pending.clearPendingItems();
  await Pending.addPendingItems(
    [
      { key: 'phone', label: '电话' },
      { key: 'city', label: '城市' },
      { key: 'expected_salary', label: '期望薪资' }
    ],
    { host: 'jobs.example.com' }
  );

  const removed = await Pending.removePendingItem('city');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);

  const after = await Pending.getPendingItems();
  assert.deepEqual(after.items.map((i) => i.key), ['phone', 'expected_salary']);

  const again = await Pending.removePendingItem('city');
  assert.equal(again.removed, false, '不存在的 key 不报错也不改动');
});

test('横幅文案：数量与上次来源站点', async () => {
  await Pending.clearPendingItems();
  await Pending.addPendingItems([{ key: 'phone', label: '电话' }], { host: 'jobs.example.com' });
  await Pending.addPendingItems([{ key: 'city', label: '城市' }], { host: 'lever.co' });

  const result = await Pending.getPendingItems();
  const summary = Pending.summary(result.items);
  assert.equal(summary.count, 2);
  assert.equal(summary.host, 'jobs.example.com');
  assert.deepEqual(summary.hosts, ['jobs.example.com', 'lever.co']);
  assert.equal(summary.label, '你有 2 个待填项（上次来自 jobs.example.com）');

  assert.equal(Pending.summary([]).label, '');
});

test('脏数据：缺 key 的条目丢弃，未知字段不影响读取', async () => {
  bag['jc.pending'] = {
    schemaVersion: 1,
    items: [
      { key: 'phone', label: '电话', host: 'x.com', at: '2026-11-01T10:00:00.000Z' },
      { label: '没有 key', host: 'x.com' },
      null,
      { key: 'phone', label: '重复', host: 'y.com', at: '2026-11-01T09:00:00.000Z' }
    ]
  };

  const result = await Pending.getPendingItems();
  assert.deepEqual(result.items.map((i) => i.key), ['phone']);
  assert.equal(result.items[0].label, '电话', '重复 key 保留先出现的那条');

  assert.equal(Pending.hostOf('https://jobs.example.com/apply?x=1'), 'jobs.example.com');
  assert.equal(Pending.hostOf(''), '');
});
