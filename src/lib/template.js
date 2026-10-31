/**
 * JustClick — 简历模板（迭代 3）
 *
 * 三组模板：基本信息 / 求职意向 / 教育与其他。内置字段与用户自定义字段混合渲染，
 * 所有逻辑都是纯函数（不碰 DOM、不碰 chrome.*），便于单测：
 *   - templatesFor(resume)          把 resume 摊平成「分组 → 行」的渲染模型
 *   - seedTemplateResume(resume)    首次使用时播种「求职意向 / 教育与其他」的预置自定义项
 *   - computeCompleteness(rows, resume)  完整度（总数 / 已填 / 每组进度）
 *   - addCustomField / removeCustomField 自定义项增删（key 确定性生成 + 去重）
 *   - createDebouncedSaver          失焦即保存的防抖器（可注入计时器，单测不需要真等待）
 *
 * UMD 双模导出，禁止 ES module 语法（popup / options 用经典 <script> 加载）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.JC = root.JC || {};
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) root.JC[k] = api[k];
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var S = null;

  function schema() {
    if (S) return S;
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.resolveValue) {
      S = globalThis.JC;
      return S;
    }
    if (typeof require === 'function') {
      try {
        S = require('./resume-schema.js');
        return S;
      } catch (e) {
        /* ignore */
      }
    }
    throw new Error('resume-schema 未加载');
  }

  /** 防抖保存的默认延迟（PRD 要求 ≤ 500ms） */
  var SAVE_DELAY = 400;

  /** 模板分组：fields 里 kind=builtin 走 resume-schema，kind=custom 是预置自定义项（可删） */
  var GROUPS = [
    {
      id: 'basic',
      title: '基本信息',
      hint: '姓名建议同时填「姓 / 名」与全名，以适配不同 ATS 的拆分方式。',
      fields: [
        { key: 'lastName', label: '姓氏', placeholder: '张', kind: 'builtin' },
        { key: 'firstName', label: '名', placeholder: '三', kind: 'builtin' },
        {
          key: 'fullName',
          label: '姓名全名',
          placeholder: '张三（留空时自动用姓 + 名拼接）',
          kind: 'builtin',
          autoCompose: true
        },
        { key: 'email', label: '邮箱', placeholder: 'san.zhang@example.com', kind: 'builtin', type: 'email' },
        { key: 'phone', label: '电话', placeholder: '+86 138 0000 0000', kind: 'builtin', type: 'tel' },
        { key: 'city', label: '城市', placeholder: '上海', kind: 'builtin' },
        { key: 'address', label: '详细地址', placeholder: '上海市徐汇区某路 100 号', kind: 'builtin' }
      ]
    },
    {
      id: 'intent',
      title: '求职意向',
      hint: '这三个是预置的自定义项，可以改成你要的名字，也可以直接删掉。',
      fields: [
        { key: 'expected_role', label: '期望职位', placeholder: '前端工程师', kind: 'custom', preset: true },
        { key: 'expected_salary', label: '期望薪资', placeholder: '30k / 月', kind: 'custom', preset: true },
        { key: 'available_date', label: '到岗时间', placeholder: '2026-03', kind: 'custom', preset: true }
      ]
    },
    {
      id: 'extra',
      title: '教育与其他',
      hint: '新建的自定义项默认落在这里。',
      fields: [
        { key: 'school', label: '学校', placeholder: '某某大学', kind: 'custom', preset: true },
        { key: 'major', label: '专业', placeholder: '计算机科学与技术', kind: 'custom', preset: true },
        { key: 'degree', label: '学历', placeholder: '本科 / 硕士', kind: 'custom', preset: true },
        { key: 'graduation_year', label: '毕业年份', placeholder: '2021', kind: 'custom', preset: true },
        { key: 'work_years', label: '工作年限', placeholder: '5 年', kind: 'custom', preset: true },
        { key: 'summary', label: '经历摘要', placeholder: '5 年前端经验，负责……', kind: 'builtin', multiline: true },
        { key: 'website', label: '作品集链接', placeholder: 'https://xxx.dev', kind: 'builtin' }
      ]
    }
  ];

  var GROUP_IDS = GROUPS.map(function (group) {
    return group.id;
  });

  function declaredFields(groupId) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].id === groupId) return GROUPS[i].fields;
    }
    return [];
  }

  function allPresetFields() {
    var out = [];
    for (var i = 0; i < GROUPS.length; i++) {
      for (var j = 0; j < GROUPS[i].fields.length; j++) {
        var field = GROUPS[i].fields[j];
        if (field.kind === 'custom' && field.preset) {
          out.push({
            key: field.key,
            label: field.label,
            group: GROUPS[i].id,
            placeholder: field.placeholder || ''
          });
        }
      }
    }
    return out;
  }

  function customList(resume) {
    var S2 = schema();
    if (!S2.isPlainObject(resume) || !Array.isArray(resume.customFields)) return [];
    return resume.customFields;
  }

  function findCustom(resume, key) {
    var list = customList(resume);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === key) return list[i];
    }
    return null;
  }

  function groupOfField(field) {
    var S2 = schema();
    var group = S2.normalizeCustomGroup(field && field.group);
    return group && GROUP_IDS.indexOf(group) !== -1 ? group : S2.DEFAULT_CUSTOM_GROUP;
  }

  /**
   * 首次使用时播种预置自定义项（只播一次）。
   * 用户删掉的预置项不会因为重新打开 options 又长回来 —— presetsSeeded 记住这件事。
   * @returns {{resume:object, changed:boolean, added:string[]}}
   */
  function seedTemplateResume(resume, options) {
    var S2 = schema();
    var force = options && options.force === true;
    var base = S2.isPlainObject(resume) ? resume : S2.createEmptyResume();
    if (base.presetsSeeded === true && !force) {
      return { resume: base, changed: false, added: [] };
    }

    var customs = base.customFields.slice();
    var added = [];
    var presets = allPresetFields();
    for (var i = 0; i < presets.length; i++) {
      if (findCustom(base, presets[i].key)) continue;
      customs.push({
        key: presets[i].key,
        label: presets[i].label,
        value: '',
        group: presets[i].group,
        preset: true
      });
      added.push(presets[i].key);
    }

    var next = S2.migrateResume(base);
    next.customFields = customs;
    next.presetsSeeded = true;
    next.updatedAt = base.updatedAt || null;
    return { resume: next, changed: added.length > 0 || base.presetsSeeded !== true, added: added };
  }

  /**
   * 渲染模型：分组 → 行。
   * 规则：内置字段永远出现；预置自定义项只在 resume 里存在时出现（删掉就不显示）；
   * 用户新建的自定义项按 group 落到对应组，group 不认识就落到第三组。
   */
  function templatesFor(resume, options) {
    var S2 = schema();
    var seeded = options && options.seed === false ? resume : seedTemplateResume(resume).resume;
    var customs = customList(seeded);
    var knownKeys = Object.create(null);
    var groups = [];

    for (var g = 0; g < GROUPS.length; g++) {
      var def = GROUPS[g];
      var rows = [];

      for (var f = 0; f < def.fields.length; f++) {
        var declared = def.fields[f];
        if (declared.kind === 'builtin') {
          knownKeys[declared.key] = true;
          rows.push({
            key: declared.key,
            label: declared.label,
            group: def.id,
            kind: 'builtin',
            value: S2.resolveValue(seeded, declared.key),
            placeholder: declared.placeholder || '',
            multiline: declared.multiline === true,
            type: declared.type || 'text',
            autoCompose: declared.autoCompose === true,
            removable: false,
            preset: false
          });
          continue;
        }
        var stored = findCustom(seeded, declared.key);
        if (!stored) continue; // 预置项被删掉了
        knownKeys[declared.key] = true;
        rows.push({
          key: stored.key,
          label: stored.label || declared.label,
          group: def.id,
          kind: 'custom',
          value: S2.sanitizeText(stored.value || ''),
          placeholder: declared.placeholder || '',
          multiline: false,
          type: 'text',
          autoCompose: false,
          removable: true,
          preset: true
        });
      }
      groups.push({ id: def.id, title: def.title, hint: def.hint || '', rows: rows });
    }

    // 用户自定义项：先按 group 归类，未登记的 group 全部落到第三组
    for (var c = 0; c < customs.length; c++) {
      var field = customs[c];
      if (!field || knownKeys[field.key]) continue;
      var targetGroup = groupOfField(field);
      var target = null;
      for (var t = 0; t < groups.length; t++) {
        if (groups[t].id === targetGroup) target = groups[t];
      }
      if (!target) target = groups[groups.length - 1];
      knownKeys[field.key] = true;
      target.rows.push({
        key: field.key,
        label: field.label || field.key,
        group: target.id,
        kind: 'custom',
        value: S2.sanitizeText(field.value || ''),
        placeholder: '值',
        multiline: false,
        type: 'text',
        autoCompose: false,
        removable: true,
        preset: field.preset === true
      });
    }

    return groups;
  }

  /** 完整度：按行统计（空串算未填），并给出每组进度 */
  function computeCompleteness(groups, resume) {
    var S2 = schema();
    var list = Array.isArray(groups) ? groups : [];
    var total = 0;
    var filled = 0;
    var detail = [];

    for (var i = 0; i < list.length; i++) {
      var rows = list[i].rows || [];
      var groupTotal = 0;
      var groupFilled = 0;
      for (var r = 0; r < rows.length; r++) {
        var value = typeof rows[r].value === 'string' ? rows[r].value : S2.resolveValue(resume, rows[r].key);
        groupTotal++;
        total++;
        if (S2.sanitizeText(value)) {
          groupFilled++;
          filled++;
        }
      }
      detail.push({
        id: list[i].id,
        title: list[i].title,
        total: groupTotal,
        filled: groupFilled,
        percent: groupTotal ? Math.round((groupFilled / groupTotal) * 100) : 0
      });
    }

    return {
      total: total,
      filled: filled,
      missing: total - filled,
      percent: total ? Math.round((filled / total) * 100) : 0,
      groups: detail
    };
  }

  /** 32 位 FNV-1a，纯中文 label 也能量出稳定的 key */
  function stableHash(text) {
    var str = typeof text === 'string' ? text : '';
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
  }

  /**
   * label → key：英文/拼音走迭代 2 的 slug 规则；纯中文走确定性哈希 cf_xxxx。
   * 同一个 label 永远得到同一个 key，因此重复添加不会产生两个字段。
   */
  function keyForLabel(label, resume) {
    var S2 = schema();
    var text = S2.sanitizeText(label);
    if (!text) return '';
    var key = S2.slugifyKey(text).slice(0, 40).replace(/_+$/g, '');
    if (key && S2.CUSTOM_KEY_RE.test(key) && !S2.isBuiltinFieldKey(key)) return key;
    return 'cf_' + stableHash(text).toString(36);
  }

  function existingKeys(resume) {
    var S2 = schema();
    var keys = S2.getFieldKeys(resume).slice();
    keys.push('summary', 'experience');
    return keys;
  }

  /**
   * 添加自定义项（幂等：同 label 只会有一个字段）。
   * @returns {{ok:boolean, resume:object, field:object|null, created:boolean, error:string|null}}
   */
  function addCustomField(resume, label, group) {
    var S2 = schema();
    var text = S2.sanitizeText(label);
    if (!text) {
      return { ok: false, resume: resume, field: null, created: false, error: 'label 必填' };
    }
    if (text.length > S2.CUSTOM_LABEL_MAX) {
      return { ok: false, resume: resume, field: null, created: false, error: 'label 不能超过 ' + S2.CUSTOM_LABEL_MAX + ' 字' };
    }

    var base = S2.migrateResume(resume);
    var key = keyForLabel(text, base);
    if (!key) {
      return { ok: false, resume: base, field: null, created: false, error: '无法为这个 label 生成 key' };
    }

    var found = findCustom(base, key);
    if (found) {
      // 同 key（同 label）已存在：返回已有字段，不重复创建
      return { ok: true, resume: base, field: found, created: false, error: null };
    }

    var used = existingKeys(base);
    if (used.indexOf(key) !== -1) {
      // 与内置字段撞名（比如 label 写成「邮箱」）→ 退到哈希 key
      key = 'cf_' + stableHash(text).toString(36);
    }
    if (used.indexOf(key) !== -1) {
      return { ok: false, resume: base, field: null, created: false, error: 'key 冲突：' + key };
    }

    var targetGroup = S2.normalizeCustomGroup(group) || S2.DEFAULT_CUSTOM_GROUP;
    if (GROUP_IDS.indexOf(targetGroup) === -1) targetGroup = S2.DEFAULT_CUSTOM_GROUP;

    var field = { key: key, label: text, value: '', group: targetGroup };
    var next = S2.migrateResume(base);
    next.customFields = base.customFields.concat([field]);
    return { ok: true, resume: next, field: field, created: true, error: null };
  }

  /** 删除自定义项（内置字段删不掉，只能清空） */
  function removeCustomField(resume, key) {
    var S2 = schema();
    if (S2.isBuiltinFieldKey(key)) {
      return { ok: false, resume: resume, removed: false, error: '内置字段不可删除，只能清空' };
    }
    var base = S2.migrateResume(resume);
    var next = [];
    var removed = false;
    for (var i = 0; i < base.customFields.length; i++) {
      if (base.customFields[i].key === key) {
        removed = true;
        continue;
      }
      next.push(base.customFields[i]);
    }
    if (!removed) return { ok: false, resume: base, removed: false, error: '字段不存在：' + key };
    base.customFields = next;
    if (base.presetsSeeded !== true) base.presetsSeeded = true;
    return { ok: true, resume: base, removed: true, error: null };
  }

  /* ------------------------------------------------------------ 防抖保存 */

  /**
   * 失焦即保存的防抖器。
   * 计时器可注入（setTimer / clearTimer），单测用手动 tick 驱动，不依赖真实等待。
   * @param {{delay?:number, save:Function, setTimer?:Function, clearTimer?:Function}} options
   */
  function createDebouncedSaver(options) {
    var opts = options || {};
    var delay = typeof opts.delay === 'number' && opts.delay >= 0 ? opts.delay : SAVE_DELAY;
    var save = typeof opts.save === 'function' ? opts.save : function () {};
    var setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : setTimeout;
    var clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : clearTimeout;

    var timer = null;
    var pending = null;
    var hasPending = false;
    var stats = { scheduled: 0, saves: 0, lastDelay: delay };

    function push(value) {
      pending = value;
      hasPending = true;
      stats.scheduled++;
      if (timer !== null && timer !== undefined) clearTimer(timer);
      timer = setTimer(function () {
        timer = null;
        if (!hasPending) return;
        hasPending = false;
        stats.saves++;
        save(pending);
      }, delay);
      return stats.scheduled;
    }

    function flush() {
      if (!hasPending) return null;
      if (timer !== null && timer !== undefined) {
        clearTimer(timer);
        timer = null;
      }
      hasPending = false;
      stats.saves++;
      var value = pending;
      return save(value);
    }

    function cancel() {
      if (timer !== null && timer !== undefined) clearTimer(timer);
      timer = null;
      pending = null;
      hasPending = false;
    }

    return {
      delay: delay,
      push: push,
      flush: flush,
      cancel: cancel,
      isPending: function () {
        return hasPending;
      },
      stats: function () {
        return { scheduled: stats.scheduled, saves: stats.saves, delay: delay };
      }
    };
  }

  return {
    SAVE_DELAY: SAVE_DELAY,
    GROUPS: GROUPS,
    GROUP_IDS: GROUP_IDS,
    allPresetFields: allPresetFields,
    seedTemplateResume: seedTemplateResume,
    templatesFor: templatesFor,
    computeCompleteness: computeCompleteness,
    stableHash: stableHash,
    keyForLabel: keyForLabel,
    addCustomField: addCustomField,
    removeCustomField: removeCustomField,
    groupOfField: groupOfField,
    createDebouncedSaver: createDebouncedSaver
  };
});
