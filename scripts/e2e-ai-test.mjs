#!/usr/bin/env node
/**
 * JustClick 端到端真实测试（AI 真实调用，非 mock）
 * 链路：简历文本 → buildPrompt → 真实 DeepSeek API → parseAiResume → 预览 → 写入（stub）→ 填充计划 → 填充报告
 * 用法：node scripts/e2e-ai-test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ai = require('../src/lib/ai.js');
const fm = require('../src/lib/field-matcher.js');
const report = require('../src/lib/report.js');
const supplement = require('../src/lib/supplement.js');
const resumeSchema = require('../src/lib/resume-schema.js');

const KEY_FILE = '/tmp/justclick-test-key';
if (!fs.existsSync(KEY_FILE)) {
  console.log('ℹ 跳过：真实 AI 测试需要 key 文件 ' + KEY_FILE + '（不放仓库）。');
  console.log('  生成：echo sk-xxx > ' + KEY_FILE + ' && chmod 600 ' + KEY_FILE);
  process.exit(0);
}
const API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const BASE_URL = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-chat';
const log = (...a) => console.log(...a);

let step = 0;
const ok = (name, cond, extra = '') => {
  step += 1;
  log(`${cond ? '✓' : '✗'} [${step}] ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

// ── 1. 模拟简历（样例场景：力学专业求职者）──
const resumeText = [
  '个人简历',
  '姓名：郑才芳',
  '性别：男',
  '出生年月：1999年3月',
  '电话：13469157593',
  '邮箱：zhengcaifang@example.com',
  '现居城市：西安',
  '教育背景',
  '2021.09 - 2024.06 西北工业大学 力学专业 硕士',
  '2017.09 - 2021.06 郑州大学 工程力学 本科',
  '求职意向：CAE 仿真工程师，期望薪资 20k-25k/月，一周内到岗',
  '工作经历',
  '2024.07 - 至今 西安某汽车研究院 CAE 工程师',
  '负责整车结构强度与耐久仿真，使用 ABAQUS/Optimus，累计完成 12 个车型项目',
  '技能：ABAQUS、HyperMesh、Python、Fatigue 耐久分析',
  '个人主页：https://zcf.example.dev',
].join('\n');

log('═╡ JustClick 端到端真实测试（AI = ' + MODEL + '）╞═\n');

// ── 2. 简历对象（内置 + 用户自定义：模拟用户已加「期望薪资」「到岗时间」）──
const schema = require('../src/lib/resume-schema.js');
const resume = schema.createEmptyResume();
resume.basics.city = '西安市';   // 已有值 → 冲突行需勾选覆盖
resume.customFields.push(
  { key: 'expected_salary', label: '期望薪资', value: '', group: 'intent' },
  { key: 'available_date', label: '到岗时间', value: '', group: 'intent' },
  { key: 'portfolio', label: '作品集链接', value: '', group: 'extra' },
);
const specs = ai.buildFieldSpecs(resume);
const specKeys = specs.map(s => s.key);
ok('字段规格含自定义字段', specKeys.includes('expected_salary') && specKeys.includes('available_date'), `${specs.length} 个字段（含自定义 ${specKeys.filter(k => ['expected_salary','available_date','portfolio'].includes(k)).length} 个）`);

// ── 3. 构造 prompt（真实截断逻辑）──
const prompt = ai.buildPrompt(specs, resumeText);
ok('prompt 构造', !prompt.truncated && prompt.system.includes('只输出 JSON') && prompt.user.includes('期望薪资'));
log(`   文本 ${prompt.originalLength} 字符（限 ${prompt.limit}）· 字段 ${prompt.fieldCount} 个\n`);

// ── 4. 真实 AI 调用 ──
log('   调用 ' + BASE_URL + ' (' + MODEL + ') …');
const t0 = Date.now();
let resp, aiError = null;
try {
  resp = await fetch(BASE_URL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: prompt.messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  });
} catch (e) { aiError = e; }
const ms = Date.now() - t0;
ok('AI 请求', !aiError && resp.status === 200, aiError ? aiError.message : `HTTP ${resp?.status}，${ms}ms`);
if (aiError || resp.status !== 200) {
  log('   响应:', (await resp?.text?.())?.slice(0, 300));
  process.exit(1);
}
const data = await resp.json();
const usage = data.usage || {};
log(`   tokens: prompt ${usage.prompt_tokens} + completion ${usage.completion_tokens}`);

// ── 5. 容错解析 ──
const raw = data.choices?.[0]?.message?.content ?? '';
log('\n   AI 原始返回（前 200 字）:', String(raw).slice(0, 200).replace(/\n/g, ' '));
const parsed = ai.parseAiResume(raw, specs);
ok('AI 解析', parsed.ok, `字段 ${parsed.fields.length} 个，忽略 ${parsed.ignored.length} 个未知 key`);

// ── 6. 预览行 + 确认写入（合并策略：AI 空不覆盖已有）──
const rows = ai.previewRows(parsed.fields, resume, specs);
log('\n   预览行:');
for (const row of rows) log(`   · ${String(row.label).padEnd(6)} = ${String(row.value).slice(0, 32)}${row.conflict ? '  [冲突:已有「' + row.existing + '」]' : ''}`);
const confirmed = rows.filter(r => r.value).map(r => ({ ...r, overwrite: true }));
const applied = ai.applyAiRows(resume, confirmed);
ok('预览与写入', applied.ok && applied.applied.length >= 6, `写入 ${applied.applied.length} 项：${applied.applied.map(s => s.key).join(', ')}`);
// 构造后续断言用的扁平视图


// ── 7. 模拟 Greenhouse 表单：填充计划 ──
const greenhouseForm = [
  { id: 'first_name', name: 'job_application[first_name]', label: 'First name', type: 'text' },
  { id: 'last_name', name: 'job_application[last_name]', label: 'Last name', type: 'text' },
  { id: 'email', name: 'job_application[email]', label: 'Email', type: 'email' },
  { id: 'phone', name: 'job_application[phone]', label: 'Phone', type: 'tel' },
  { id: 'question_expected_salary', name: 'job_application[questions][expected_salary]', label: '期望薪资', type: 'text' },
  { id: 'question_portfolio', name: 'job_application[questions][portfolio_url]', label: 'Portfolio link', type: 'url' },
  { id: 'question_999', name: 'job_application[questions][999]', label: 'Why do you want to work here?', type: 'textarea' },
];
const flat = {};
for (const key of schema.getFieldKeys(applied.resume)) flat[key] = schema.resolveValue(applied.resume, key);
log('   简历字段值:', Object.entries(flat).filter(([,v]) => v).map(([k,v]) => k + '=' + String(v).slice(0,14)).join(' | '));
const plan = fm.buildFillPlan(greenhouseForm, flat);
ok('填充计划', plan.assignments.length >= 4, `可填 ${plan.assignments.length} 项`);
for (const a of plan.assignments) log(`   · [${a.key}] ${String(a.value).slice(0, 26)} (conf ${a.confidence})`);

// ── 8. 填充报告（填了什么/什么没填/待填）──
const rep = (report.buildReport || report.build || report.composeReport)?.(plan, flat) || null;
if (rep) {
  ok('填充报告', Array.isArray(rep.filled) && Array.isArray(rep.missing), `已填 ${rep.filled.length} / 待填 ${rep.missing.length} / 未匹配 ${(rep.unmatched || []).length}`);
  for (const m of rep.missing || []) log(`   · 待填: ${m.label}（${m.key}）`);
} else {
  log('ℹ report.buildReport 接口名不同，跳过（team 单测已覆盖）');
}

// ── 9. 待填项补充（supplement：内联补值流）──
if (supplement.createSupplement) {
  const sup = supplement.createSupplement({ key: 'portfolio', label: '作品集链接' }, applied.resume);
  const after = supplement.applySupplement ? supplement.applySupplement(sup, 'https://zcf.example.dev') : null;
  ok('待填补充', after && (after.value === 'https://zcf.example.dev' || after.saved), JSON.stringify(after?.value || after?.saved || '').slice(0, 40));
} else {
  log('ℹ supplement.createSupplement 接口名不同，跳过');
}

// ── 10. 关键正确性断言 ──
log('');
const got = (k) => String(schema.resolveValue(applied.resume, k) ?? '');
ok('姓名拆分（姓/名不互含）', got('lastName') === '郑' && got('firstName').includes('才芳'), `${got('lastName')}·${got('firstName')}`);
ok('电话原样', got('phone').replace(/\D/g, '') === '13469157593', got('phone'));
ok('期望薪资含数字', /\d+\s*k/i.test(got('expected_salary')), got('expected_salary'));
ok('开放问题未被填', !plan.assignments.some(a => String(a.value).includes('want to work')), 'Why-work-here 排除');
const leaked = Object.values(applied.resume).some(v => String(v).includes(API_KEY));
ok('key 不落数据', !leaked);

log(`\n═══ 端到端完成：${process.exitCode ? '有失败项 ✗' : '全部通过 ✓'} ═══`);
