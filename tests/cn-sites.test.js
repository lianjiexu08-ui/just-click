'use strict';

/**
 * 迭代 5 验收 3：中国求职站点适配（Boss直聘 / 智联 / 51job / 拉勾 / 猎聘）。
 *
 * 新语义（0.6.1 返修）：
 * - 五站规则与通用 ATS 规则在同一个 ATS_RULES 数组里，站点规则靠 sites 做 host 隔离；
 * - 六组中文词条直接在 DICTIONARY 里，不再受 options.fieldKeys 门禁限制；
 * - 模板既有的 degree / work_years 是 education / experience_years 的取值别名；
 * - 反硬编码红线不放松：任意自建 key（如 wechat）永远不能靠字典命中。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/lib/field-matcher.js');
const S = require('../src/lib/resume-schema.js');

const ZHIPIN = 'https://www.zhipin.com/web/geek/job';
const ZHAOPIN = 'https://sou.zhaopin.com/apply/123';
const JOB51 = 'https://i.51job.com/resume/apply.php';
const LAGOU = 'https://www.lagou.com/wn/jobs/apply';
const LIEPIN = 'https://c.liepin.com/job/apply';

const SITES = [
  ['zhipin', ZHIPIN],
  ['zhaopin', ZHAOPIN],
  ['51job', JOB51],
  ['lagou', LAGOU],
  ['liepin', LIEPIN]
];

function hit(desc, options) {
  return M.detectFieldType(desc, options);
}

test('五站规则已并入 ATS_RULES，SITE_RULES 是同一批对象的派生视图', () => {
  for (const [site] of SITES) {
    const rules = M.ATS_RULES.filter((rule) => rule.ats === site);
    assert.ok(rules.length >= 3, `${site} 在 ATS_RULES 里应 ≥3 条，实际 ${rules.length}`);
    assert.ok(
      rules.every((rule) => Array.isArray(rule.sites) && rule.sites.length > 0),
      `${site} 的每条规则都必须带 sites 做 host 隔离`
    );
  }

  const derived = M.ATS_RULES.filter((rule) => Array.isArray(rule.sites) && rule.sites.length);
  assert.equal(M.SITE_RULES.length, derived.length, 'SITE_RULES 必须是 ATS_RULES 的派生视图');
  assert.equal(M.SITE_RULES[0], derived[0], '派生视图应复用同一批规则对象');
  assert.ok(M.ATS_RULES.slice(0, derived.length).every((rule) => rule.sites), '中国五站规则必须排在数组前部');
});

test('Boss直聘：投递弹窗的 name / phone / email 通用属性名由站点规则命中（原始证据场景）', () => {
  const name = hit({ name: 'name', placeholder: '请输入姓名' }, { url: ZHIPIN });
  assert.equal(name.key, 'fullName');
  assert.equal(name.ats, 'zhipin', 'Boss 弹窗的 name 不能被通用 Lever 规则吃掉');
  assert.equal(name.site, 'zhipin.com');
  assert.equal(name.confidence, 1);

  const phone = hit({ name: 'phone', placeholder: '请输入手机号' }, { url: ZHIPIN });
  assert.equal(phone.key, 'phone');
  assert.equal(phone.ats, 'zhipin');
  assert.equal(phone.confidence, 1);

  const email = hit({ name: 'email' }, { url: ZHIPIN });
  assert.equal(email.key, 'email');
  assert.equal(email.ats, 'zhipin');

  assert.equal(hit({ name: 'geekName' }, { url: ZHIPIN }).ats, 'zhipin');
  assert.equal(hit({ name: 'geekMobile' }, { url: ZHIPIN }).ats, 'zhipin');
  assert.equal(hit({ name: 'mobile' }, { url: ZHIPIN }).ats, 'zhipin');
  assert.equal(hit({ placeholder: '请输入姓名' }, { url: ZHIPIN }).key, 'fullName');
  assert.equal(hit({ placeholder: '请输入手机号' }, { url: ZHIPIN }).key, 'phone');
});

test('智联 / 51job / 拉勾 / 猎聘：公开 DOM 属性名全部按站点命中', () => {
  assert.equal(hit({ name: 'userName' }, { url: ZHAOPIN }).ats, 'zhaopin');
  assert.equal(hit({ id: 'resumeName' }, { url: ZHAOPIN }).key, 'fullName');
  assert.equal(hit({ name: 'realName' }, { url: ZHAOPIN }).key, 'fullName');
  assert.equal(hit({ name: 'mobile' }, { url: ZHAOPIN }).ats, 'zhaopin');
  assert.equal(hit({ id: 'email' }, { url: ZHAOPIN }).ats, 'zhaopin');

  assert.equal(hit({ id: 'inputRealName' }, { url: JOB51 }).ats, '51job');
  assert.equal(hit({ name: 'mobilePhone' }, { url: JOB51 }).key, 'phone');
  assert.equal(hit({ id: 'mobile' }, { url: JOB51 }).key, 'phone');
  assert.equal(hit({ name: 'mobile' }, { url: JOB51 }).ats, '51job');

  assert.equal(hit({ name: 'userName' }, { url: LAGOU }).ats, 'lagou');
  assert.equal(hit({ name: 'phone' }, { url: LAGOU }).key, 'phone');
  assert.equal(hit({ name: 'mobile' }, { url: LAGOU }).ats, 'lagou');
  assert.equal(hit({ placeholder: '请输入手机号' }, { url: LAGOU }).ats, 'lagou');

  assert.equal(hit({ name: 'realName' }, { url: LIEPIN }).ats, 'liepin');
  assert.equal(hit({ id: 'name' }, { url: LIEPIN }).key, 'fullName');
  assert.equal(hit({ name: 'mobile' }, { url: LIEPIN }).ats, 'liepin');
  assert.equal(hit({ name: 'email' }, { url: LIEPIN }).ats, 'liepin');
});

test('每站 ≥2 个字段经 buildFillPlan 命中，且每条 assignment 的 ats 等于站点名', () => {
  const forms = [
    {
      site: 'zhipin',
      url: ZHIPIN,
      fields: [
        { name: 'name', placeholder: '请输入姓名' },
        { name: 'phone', placeholder: '请输入手机号' },
        { name: 'email' }
      ],
      values: { fullName: '张三', phone: '13800138000', email: 'z@example.com' },
      keys: ['email', 'fullName', 'phone']
    },
    {
      site: 'zhaopin',
      url: ZHAOPIN,
      fields: [{ name: 'userName' }, { name: 'mobile' }, { id: 'email' }],
      values: { fullName: '张三', phone: '13800138000', email: 'z@example.com' },
      keys: ['email', 'fullName', 'phone']
    },
    {
      site: '51job',
      url: JOB51,
      fields: [{ id: 'inputRealName' }, { name: 'mobilePhone' }, { name: 'email' }],
      values: { fullName: '张三', phone: '13800138000', email: 'z@example.com' },
      keys: ['email', 'fullName', 'phone']
    },
    {
      site: 'lagou',
      url: LAGOU,
      fields: [{ name: 'userName' }, { name: 'phone' }, { name: 'email' }],
      values: { fullName: '张三', phone: '13800138000', email: 'z@example.com' },
      keys: ['email', 'fullName', 'phone']
    },
    {
      site: 'liepin',
      url: LIEPIN,
      fields: [{ name: 'realName' }, { name: 'mobile' }, { name: 'email' }],
      values: { fullName: '张三', phone: '13800138000', email: 'z@example.com' },
      keys: ['email', 'fullName', 'phone']
    }
  ];

  for (const form of forms) {
    const plan = M.buildFillPlan(form.fields, form.values, { url: form.url });
    assert.equal(plan.assignments.length, form.fields.length, `${form.site}: 所有字段都应填上`);
    assert.deepEqual(
      plan.assignments.map((a) => a.key).sort(),
      form.keys,
      `${form.site}: key 集合不符合预期`
    );
    assert.ok(
      plan.assignments.every((a) => a.ats === form.site),
      `${form.site}: 每条 assignment 的 ats 都应是 ${form.site}，实际 ${plan.assignments.map((a) => a.ats).join(',')}`
    );
    assert.deepEqual(plan.missing, [], `${form.site}: 不应有 missing`);
    assert.deepEqual(plan.notFound, [], `${form.site}: 不应有 notFound`);
  }
});

test('六组中文词条已进 DICTIONARY：每组 ≥2 变体，不传 options 也能命中', () => {
  const expected = {
    expected_salary: 'expected_salary',
    available_date: 'available_date',
    education: 'education',
    school: 'school',
    major: 'major',
    experience_years: 'experience_years'
  };

  for (const key of Object.keys(expected)) {
    assert.ok(Object.prototype.hasOwnProperty.call(M.DICTIONARY, key), `DICTIONARY 缺少 ${key}`);
    assert.ok(M.DICTIONARY[key].length >= 2, `${key} 至少要有 2 个变体`);
    assert.equal(M.PRESET_DICTIONARY[key], M.DICTIONARY[key], `${key} 的 PRESET 视图必须是同一数组引用`);
  }

  const labels = {
    期望薪资: 'expected_salary',
    月薪: 'expected_salary',
    到岗时间: 'available_date',
    可到岗: 'available_date',
    学历: 'education',
    最高学历: 'education',
    学校: 'school',
    毕业院校: 'school',
    专业: 'major',
    专业方向: 'major',
    工作年限: 'experience_years',
    工龄: 'experience_years'
  };
  for (const [label, key] of Object.entries(labels)) {
    const found = hit({ labelText: label });
    assert.ok(found, `中文 label「${label}」不应为 null`);
    assert.equal(found.key, key, `中文 label「${label}」应为 ${key}`);
    assert.equal(found.ats, null, `「${label}」应走字典而不是站点规则`);
  }

  // 英文属性名 token：name 本身也要能命中
  assert.equal(hit({ name: 'expected_salary' }).key, 'expected_salary');
  assert.equal(hit({ name: 'available_date' }).key, 'available_date');
  assert.equal(hit({ name: 'education' }).key, 'education');
  assert.equal(hit({ name: 'school' }).key, 'school');
  assert.equal(hit({ name: 'major' }).key, 'major');
  assert.equal(hit({ name: 'work_years' }).key, 'experience_years');
});

test('用户原始探针：{name:"expected_salary", label:"期望薪资"} 必须非 null（label 来源）', () => {
  const found = hit({ name: 'expected_salary', label: '期望薪资' });
  assert.ok(found, '不传 options 也必须命中');
  assert.equal(found.key, 'expected_salary');
  assert.equal(found.attr, 'label');
  assert.equal(found.ats, null);
});

test('别名：简历里只有 degree，页面 label 是「学历」也能填上且不报 notFound', () => {
  const descriptors = [{ labelText: '学历' }, { labelText: '工作年限' }, { labelText: 'Email' }];
  const values = { degree: '本科', work_years: '5 年', email: 'z@example.com' };
  const fieldLabels = { degree: '学历', work_years: '工作年限', email: '邮箱' };

  const plan = M.buildFillPlan(descriptors, values, {
    fieldKeys: S.FIELD_KEYS.concat(['degree', 'work_years']),
    fieldLabels
  });

  assert.deepEqual(plan.assignments.map((a) => a.key), ['education', 'experience_years', 'email']);
  assert.deepEqual(plan.assignments.map((a) => a.value), ['本科', '5 年', 'z@example.com']);
  assert.equal(plan.assignments[0].label, '学历', 'label 应回落到别名 degree 的展示名');
  assert.equal(plan.assignments[1].label, '工作年限');
  assert.deepEqual(plan.notFound, [], 'degree/work_years 已填，不能再报 canonical key 的 notFound');
  assert.deepEqual(plan.missing, []);

  // 反方向：简历存 canonical key，页面匹配到别名 key 也要取到值（resolveValue 双向）
  assert.equal(S.resolveValue({ customFields: [{ key: 'degree', label: '学历', value: '硕士' }] }, 'education'), '硕士');
  assert.equal(
    S.resolveValue({ customFields: [{ key: 'education', label: '学历', value: '博士' }] }, 'degree'),
    '博士'
  );
  assert.equal(
    S.resolveValue({ customFields: [{ key: 'work_years', label: '工作年限', value: '3 年' }] }, 'experience_years'),
    '3 年'
  );
  assert.equal(
    S.resolveValue({ customFields: [{ key: 'experience_years', label: '工作年限', value: '8 年' }] }, 'work_years'),
    '8 年'
  );
});

test('中文「期望薪资」走字典：缺值时进 missing，给值时能填上', () => {
  const descriptors = [{ labelText: '期望薪资', name: 'salary' }];

  const empty = M.buildFillPlan(descriptors, {}, {});
  assert.deepEqual(empty.missing.map((m) => m.key), ['expected_salary']);
  assert.equal(empty.missing[0].label, 'expected_salary');
  assert.deepEqual(empty.assignments, []);

  const filled = M.buildFillPlan(descriptors, { expected_salary: '30k / 月' }, {});
  assert.equal(filled.assignments.length, 1);
  assert.equal(filled.assignments[0].key, 'expected_salary');
  assert.equal(filled.assignments[0].value, '30k / 月');
  assert.equal(filled.assignments[0].ats, null, '字典命中不带 site/ats');
  assert.deepEqual(filled.missing, []);
});

test('站点隔离：zhipin 规则在 lever.com 不生效，hostMatches 后缀严格匹配', () => {
  assert.equal(M.matchAts({ name: 'geekName' }, { url: ZHIPIN }).ats, 'zhipin');
  assert.equal(M.matchAts({ name: 'geekName' }, { url: 'https://www.lever.co/apply' }), null);
  assert.equal(M.matchAts({ name: 'geekMobile' }, { url: 'https://jobs.lever.co/example' }), null);

  // 不带 url 时站点规则一律跳过，通用 Lever 规则仍然是旧行为
  assert.equal(hit({ name: 'name' }).ats, 'lever');

  // 猎聘的 id=name 规则也不能在 Lever 上生效
  assert.equal(M.matchAts({ id: 'name' }, { url: 'https://jobs.lever.co/example' }), null);

  assert.equal(M.hostMatches('https://www.zhipin.com/x', ['zhipin.com']), true);
  assert.equal(M.hostMatches('https://zhipin.com/x', ['zhipin.com']), true);
  assert.equal(M.hostMatches('https://zhipin.com.evil.com/x', ['zhipin.com']), false);
  assert.equal(M.hostMatches('https://notzhipin.com/x', ['zhipin.com']), false);
  assert.equal(M.hostMatches('', ['zhipin.com']), false);
  assert.equal(M.hostMatches('https://zhipin.com/x', []), false);
});

test('反硬编码红线：任意用户自建 key（wechat）任何情况下都不被字典命中', () => {
  const desc = { labelText: '微信', name: 'wechat', placeholder: 'wechat id' };
  assert.equal(hit(desc), null);
  assert.equal(hit(desc, { fieldKeys: ['wechat'] }), null);
  assert.equal(hit(desc, { fieldKeys: ['wechat', 'email', 'phone'] }), null);
  assert.equal(hit(desc, { url: ZHIPIN, fieldKeys: ['wechat'] }), null);
  assert.equal(Object.prototype.hasOwnProperty.call(M.DICTIONARY, 'wechat'), false);

  // 用户规则是唯一出路
  const R = require('../src/lib/rules.js');
  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'wechat', matchType: 'exact' },
    target: 'wechat'
  });
  assert.equal(hit(desc, { fieldKeys: ['wechat'], rules: [rule] }).key, 'wechat');
});

test('取消 fieldKeys 门禁：传无关 key 或空数组都不影响六组中文词条命中', () => {
  assert.equal(hit({ labelText: '期望薪资' }, { fieldKeys: ['wechat'] }).key, 'expected_salary');
  assert.equal(hit({ labelText: '学历' }, { fieldKeys: [] }).key, 'education');
  assert.equal(hit({ labelText: '工作年限' }, { fieldKeys: ['custom_field_1'] }).key, 'experience_years');
  assert.equal(hit({ name: 'expected_salary' }, { fieldKeys: ['wechat'] }).key, 'expected_salary');
});

test('响应结构：站点规则带 site，通用 ATS 规则不带 site', () => {
  const boss = hit({ name: 'name' }, { url: ZHIPIN });
  assert.equal(boss.site, 'zhipin.com');
  assert.equal(boss.ats, 'zhipin');

  const zhaopin = hit({ name: 'userName' }, { url: ZHAOPIN });
  assert.equal(zhaopin.site, 'zhaopin.com');
  assert.equal(zhaopin.ats, 'zhaopin');

  const lever = hit({ name: 'name' });
  assert.equal(lever.ats, 'lever');
  assert.equal(Object.prototype.hasOwnProperty.call(lever, 'site'), false, '通用规则不应带 site');
});

test('站点隔离矩阵：每站规则在其它站点 url 上都不命中', () => {
  const probes = [
    ['zhipin', { name: 'geekName' }, [ZHAOPIN, JOB51, LAGOU, LIEPIN]],
    ['zhaopin', { id: 'resumeName' }, [ZHIPIN, JOB51, LAGOU, LIEPIN]],
    ['51job', { id: 'inputRealName' }, [ZHIPIN, ZHAOPIN, LAGOU, LIEPIN]],
    ['lagou', { name: 'userName' }, [ZHIPIN, LIEPIN]],
    ['liepin', { id: 'name' }, [ZHIPIN, ZHAOPIN, JOB51, LAGOU]]
  ];
  for (const [site, desc, urls] of probes) {
    for (const url of urls) {
      const matched = M.matchAts(desc, { url });
      assert.equal(matched, null, `${site} 规则不应在 ${url} 上命中，实际 ${JSON.stringify(matched)}`);
    }
  }
});

test('collectSources：desc.label 作为 label 来源参与，权重与 labelText 一致', () => {
  const sources = M.collectSources({ label: '期望薪资' });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].attr, 'label');
  assert.equal(sources[0].text, '期望薪资');

  const fromLabel = M.detectFieldType({ name: 'salary', label: '期望薪资' });
  const fromLabelText = M.detectFieldType({ name: 'salary', labelText: '期望薪资' });
  assert.equal(fromLabel.attr, 'label');
  assert.equal(fromLabelText.attr, 'label');
  assert.equal(fromLabel.score, fromLabelText.score, 'label 与 labelText 的权重必须一致');
  assert.equal(M.ATTR_WEIGHTS.label, 3.0);
});

test('反向别名：页面命中的 key 是 degree 时，用 canonical education 的值填充', () => {
  const R = require('../src/lib/rules.js');
  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'degree_field', matchType: 'contains' },
    target: 'degree'
  });
  const plan = M.buildFillPlan(
    [{ name: 'degree_field' }],
    { education: '本科' },
    { fieldKeys: ['education'], rules: [rule] }
  );
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].key, 'degree');
  assert.equal(plan.assignments[0].value, '本科', 'degree 应回落到 education 的值');
  assert.deepEqual(plan.notFound, [], 'education 已通过别名填入，不应报 notFound');
});

test('REJECTS：六组预置 key 都有负向词条目，且关键负向词在位', () => {
  const keys = ['expected_salary', 'available_date', 'education', 'school', 'major', 'experience_years'];
  for (const key of keys) {
    assert.ok(Array.isArray(M.REJECTS[key]), `REJECTS 缺少 ${key}`);
  }
  assert.ok(M.REJECTS.expected_salary.includes('现有'));
  assert.ok(M.REJECTS.expected_salary.includes('当前'));
  assert.ok(M.REJECTS.education.includes('学校'));
  assert.ok(M.REJECTS.school.includes('学历'));
  assert.ok(M.REJECTS.major.includes('技能'));
});

test('预置字段负向词：当前薪资/现有薪酬/学校/专业技能仍判不出对应 key', () => {
  assert.equal(hit({ labelText: '当前薪资' }), null);
  assert.equal(hit({ labelText: '现有薪酬' }), null);
  assert.equal(hit({ labelText: 'currently expected salary' }), null);
  // 负向词的真正含义是「不串到别的字段」：学校 → school，但不能是 education
  assert.equal(hit({ labelText: '学校' }).key, 'school');
  assert.notEqual(hit({ labelText: '学校' }).key, 'education');
  assert.equal(hit({ labelText: '学历' }).key, 'education');
  assert.notEqual(hit({ labelText: '学历' }).key, 'school');
  assert.equal(hit({ labelText: '专业' }).key, 'major');
  assert.equal(hit({ labelText: '专业技能' }), null);
  assert.equal(hit({ labelText: '项目专业' }), null);
});
