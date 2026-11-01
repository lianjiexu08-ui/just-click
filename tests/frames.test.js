'use strict';

/**
 * 迭代 5 验收 1：多 frame 结果聚合。
 *
 * mergeFrameResults 的入参是 popup 逐 frame 拿到的 JC_FILL 响应，
 * 出参必须与 buildReportFromPlan 的 plan 同形（assignments / missing / notFound）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../src/lib/frames.js');

function result(overrides) {
  return Object.assign(
    { ok: true, scanned: 0, filledItems: [], missingItems: [], unmatchedItems: [] },
    overrides || {}
  );
}

test('两个 frame 合并：同 key 已填只保留 1 条，frames 列出两个标签', () => {
  const merged = F.mergeFrameResults([
    {
      frameId: 0,
      url: 'https://jobs.example.com/apply',
      result: result({
        scanned: 4,
        filledItems: [{ key: 'email', label: '邮箱', value: 'a@example.com' }],
        missingItems: [{ key: 'phone', label: '电话' }]
      })
    },
    {
      frameId: 7,
      url: 'https://cdn.example.com/form?token=1#step2',
      result: result({
        scanned: 3,
        filledItems: [{ key: 'email', label: '邮箱', value: 'second@example.com' }]
      })
    }
  ]);

  assert.equal(merged.assignments.length, 1, '同 key 只能出现一次');
  assert.equal(merged.assignments[0].key, 'email');
  assert.equal(merged.assignments[0].value, 'a@example.com', '保留第一次的值');
  assert.deepEqual(merged.assignments[0].frames, ['jobs.example.com/apply', 'cdn.example.com/form']);
  assert.equal(merged.scanned, 7, 'scanned 应为各 frame 之和');
  assert.equal(merged.empty, false);
  assert.equal(merged.frames.length, 2);
});

test('跨 frame 同 key missing 只 1 条，并标注两个 frame', () => {
  const merged = F.mergeFrameResults([
    {
      frameId: 0,
      url: 'https://jobs.example.com/apply',
      result: result({ missingItems: [{ key: 'phone', label: '电话' }] })
    },
    {
      frameId: 2,
      url: 'https://apply.example.org/embed',
      result: result({ missingItems: [{ key: 'phone', label: '电话' }, { key: 'city', label: '城市' }] })
    }
  ]);

  assert.equal(merged.missing.length, 2);
  const phone = merged.missing.find((item) => item.key === 'phone');
  assert.deepEqual(phone.frames, ['jobs.example.com/apply', 'apply.example.org/embed']);
  assert.equal(merged.missing.find((item) => item.key === 'city').frames.length, 1);
  assert.equal(merged.empty, false);
});

test('unmatched 跨 frame 按 key 去重，值取第一个非空', () => {
  const merged = F.mergeFrameResults([
    {
      frameId: 0,
      url: 'https://a.example.com/x',
      result: result({ unmatchedItems: [{ key: 'github', label: 'GitHub', value: '' }] })
    },
    {
      frameId: 1,
      url: 'https://b.example.com/y',
      result: result({ unmatchedItems: [{ key: 'github', label: 'GitHub', value: 'https://github.com/x' }] })
    }
  ]);

  assert.equal(merged.notFound.length, 1);
  assert.equal(merged.notFound[0].value, 'https://github.com/x');
  assert.equal(merged.notFound[0].frames.length, 2);
});

test('某个 frame 失败只标 failed，不影响其它 frame 的已填结果', () => {
  const merged = F.mergeFrameResults([
    { frameId: 0, url: 'https://jobs.example.com/apply', result: result({ filledItems: [{ key: 'email', label: '邮箱', value: 'a@b.c' }] }) },
    { frameId: 9, url: 'https://broken.example.com/frame', result: { ok: false, error: '页面已卸载' } },
    { frameId: 5, url: 'https://nobody.example.com/frame', result: { error: 'Receiving end does not exist' } }
  ]);

  assert.equal(merged.frames.length, 3);
  assert.equal(merged.frames[0].ok, true);
  assert.equal(merged.frames[1].failed, true);
  assert.equal(merged.frames[1].error, '页面已卸载');
  assert.equal(merged.frames[2].failed, true);
  assert.equal(merged.frames[2].ok, false);
  assert.equal(merged.assignments.length, 1, '失败 frame 不产生 assignment');
  assert.equal(merged.empty, false);

  const frameShape = merged.frames[0];
  for (const key of ['frameId', 'label', 'ok', 'scanned', 'filled', 'missing', 'unmatched']) {
    assert.ok(Object.prototype.hasOwnProperty.call(frameShape, key), `frame 缺少 ${key}`);
  }
});

test('全部 frame 都没有字段 → empty:true，scanned 仍求和', () => {
  const merged = F.mergeFrameResults([
    { frameId: 0, url: 'https://a.example.com/', result: result({ scanned: 2 }) },
    { frameId: 1, url: 'about:blank', result: result({ scanned: 0 }) }
  ]);

  assert.equal(merged.empty, true);
  assert.equal(merged.scanned, 2);
  assert.deepEqual(merged.assignments, []);
  assert.deepEqual(merged.missing, []);
  assert.deepEqual(merged.notFound, []);
  assert.equal(merged.frames[1].label, '该页面');
});

test('frameLabel 去掉 query / hash，path 超长截断，非 http 回退', () => {
  assert.equal(F.frameLabel('https://jobs.example.com/apply/form?x=1#top'), 'jobs.example.com/apply/form');
  assert.equal(F.frameLabel('http://www.zhipin.com/web/geek/job'), 'www.zhipin.com/web/geek/job');
  assert.equal(F.frameLabel('about:blank'), '该页面');
  assert.equal(F.frameLabel('data:text/html,<input>'), '该页面');
  assert.equal(F.frameLabel(''), '该页面');
  assert.equal(F.frameLabel(null), '该页面');

  const longPath = 'https://example.com/' + 'a'.repeat(80);
  const label = F.frameLabel(longPath);
  assert.ok(label.endsWith('…'), '超长 path 应截断');
  // path 截到 40 个字符（含开头的 /），再加省略号 → 占 host 之后的 40 个字符
  assert.equal(label.split('/')[1].length, 40, '40 字（含 /）+ 省略号');
});

test('tagEntriesWithFrame 重排全局 index、打 frameLabel、保留 selector', () => {
  const tagged = F.tagEntriesWithFrame(
    [
      { index: 5, selector: '#email', label: '邮箱', attrs: { name: 'email' } },
      { index: 9, selector: 'x >>> y', label: '电话', attrs: {} }
    ],
    'jobs.example.com/apply'
  );

  assert.deepEqual(tagged.map((entry) => entry.index), [0, 1]);
  assert.equal(tagged[0].frameLabel, 'jobs.example.com/apply');
  assert.equal(tagged[0].selector, '#email');
  assert.equal(tagged[1].selector, 'x >>> y', 'shadow 路径不能被改写');
  assert.equal(tagged[1].attrs.name, undefined);
  assert.deepEqual(F.tagEntriesWithFrame(null, 'x'), []);
});

test('shadow 命中在合并后保留 shadow 标记', () => {
  const merged = F.mergeFrameResults([
    {
      frameId: 0,
      url: 'https://workday.example.com/apply',
      result: result({
        filledItems: [{ key: 'fullName', label: '姓名', value: '张三', shadow: true }],
        shadowFields: 1
      })
    }
  ]);

  assert.equal(merged.assignments.length, 1);
  assert.equal(merged.assignments[0].shadow, true);
});
