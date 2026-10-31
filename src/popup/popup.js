/**
 * JustClick — popup
 *
 * 迭代 3 起 popup 有两条主线：
 *   1. 一键填充 → 渲染「填充报告」三区块（已填 / 待填 / 未匹配）
 *   2. 待填项：当场内联补填（写存储 + 只填这一个框，绝不提交表单），或者挂到 pendingItems 里跨页携带
 * 迭代 2 的「从当前页学习」保持不变。
 */
(function () {
  'use strict';

  var els = {
    fillBtn: document.getElementById('fill-btn'),
    learnBtn: document.getElementById('learn-btn'),
    learnPanel: document.getElementById('learn-panel'),
    learnList: document.getElementById('learn-list'),
    learnScope: document.getElementById('learn-scope'),
    learnScopeLabel: document.getElementById('learn-scope-label'),
    learnSave: document.getElementById('learn-save'),
    learnStatus: document.getElementById('learn-status'),
    learnClose: document.getElementById('learn-close'),
    result: document.getElementById('result'),
    completeness: document.getElementById('completeness'),
    completenessBar: document.getElementById('completeness-bar'),
    profileName: document.getElementById('profile-name'),
    missingChips: document.getElementById('missing-chips'),
    updatedAt: document.getElementById('updated-at'),
    optionsBtn: document.getElementById('options-btn'),
    refreshBtn: document.getElementById('refresh-btn'),

    // 待填横幅
    pendingBanner: document.getElementById('pending-banner'),
    pendingTitle: document.getElementById('pending-title'),
    pendingToggle: document.getElementById('pending-toggle'),
    pendingClear: document.getElementById('pending-clear'),
    pendingList: document.getElementById('pending-list'),

    // 报告
    report: document.getElementById('report'),
    reportTitle: document.getElementById('report-title'),
    reportTime: document.getElementById('report-time'),
    blockFilled: document.getElementById('block-filled'),
    filledTitle: document.getElementById('filled-title'),
    filledList: document.getElementById('filled-list'),
    blockMissing: document.getElementById('block-missing'),
    missingTitle: document.getElementById('missing-title'),
    missingList: document.getElementById('missing-list'),
    blockUnmatched: document.getElementById('block-unmatched'),
    unmatchedTitle: document.getElementById('unmatched-title'),
    unmatchedList: document.getElementById('unmatched-list'),
    copyReport: document.getElementById('copy-report'),
    copyStatus: document.getElementById('copy-status')
  };

  var resume = null;
  var busy = false;
  var learnEntries = [];
  var learnHost = '';
  var pendingItems = [];
  var lastReport = null;
  var activeTabId = null;
  var activeUrl = '';

  /* ---------------------------------------------------------------- 小工具 */

  function fieldKeys() {
    if (window.JC && typeof window.JC.getFieldKeys === 'function') return window.JC.getFieldKeys(resume);
    return (window.JC && window.JC.FIELD_KEYS) || [];
  }

  function fieldLabel(key) {
    if (window.JC && typeof window.JC.labelFor === 'function') return window.JC.labelFor(resume, key);
    return (window.JC && window.JC.FIELD_LABELS && window.JC.FIELD_LABELS[key]) || key;
  }

  function filledFieldKeys() {
    var keys = fieldKeys();
    var ready = [];
    for (var i = 0; i < keys.length; i++) {
      if (window.JC.resolveValue(resume, keys[i])) ready.push(keys[i]);
    }
    return ready;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return '';
    }
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  /* ------------------------------------------------------------ 简历概况 */

  function renderProfile() {
    var keys = fieldKeys();
    var ready = filledFieldKeys();
    els.completeness.textContent = ready.length + ' / ' + keys.length;
    els.completenessBar.style.width = keys.length ? Math.round((ready.length / keys.length) * 100) + '%' : '0%';

    var name = window.JC.resolveValue(resume, 'fullName');
    els.profileName.textContent = name ? name : '尚未填写简历';

    els.missingChips.innerHTML = '';
    keys.forEach(function (key) {
      if (ready.indexOf(key) !== -1) return;
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = fieldLabel(key);
      els.missingChips.appendChild(chip);
    });

    if (resume && resume.updatedAt) {
      var d = new Date(resume.updatedAt);
      els.updatedAt.textContent = '更新于 ' + (isNaN(d.getTime()) ? resume.updatedAt : d.toLocaleString('zh-CN'));
    } else {
      els.updatedAt.textContent = '还没有保存过简历';
    }

    els.fillBtn.disabled = ready.length === 0;
    els.fillBtn.textContent = ready.length === 0 ? '先填写简历' : '一键填充当前页面';
  }

  function showResult(kind, title, sub) {
    els.result.hidden = false;
    els.result.className = 'result' + (kind === 'error' ? ' error' : '');
    els.result.innerHTML = '';
    var t = document.createElement('div');
    t.className = 'result-title';
    t.textContent = title;
    els.result.appendChild(t);
    if (sub) {
      var s = document.createElement('div');
      s.className = 'result-sub';
      s.textContent = sub;
      els.result.appendChild(s);
    }
  }

  function showLearnStatus(text, kind) {
    els.learnStatus.textContent = text;
    els.learnStatus.className = 'learn-status' + (kind ? ' ' + kind : '');
  }

  /* -------------------------------------------------------- content 注入 */

  async function ensureContentScript(tabId) {
    try {
      var pong = await chrome.tabs.sendMessage(tabId, { type: 'JC_PING' });
      if (pong && pong.ok) return true;
    } catch (e) {
      /* 未注入，继续尝试注入 */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: [
          'lib/resume-schema.js',
          'lib/rules.js',
          'lib/field-matcher.js',
          'lib/learner.js',
          'content/content.js'
        ]
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function currentTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  function isInjectableUrl(url) {
    return typeof url === 'string' && /^https?:/i.test(url);
  }

  async function prepareTab() {
    var tab = await currentTab();
    if (!tab || !tab.id) {
      showResult('error', '拿不到当前标签页', '请在一个普通网页上重试。');
      return null;
    }
    if (!isInjectableUrl(tab.url)) {
      showResult('error', '这个页面不能操作', 'Chrome 内部页面和扩展商店页面无法注入脚本。');
      return null;
    }
    var ready = await ensureContentScript(tab.id);
    if (!ready) {
      showResult('error', '注入失败', '请刷新目标页面后重试，或检查是否被浏览器策略拦截。');
      return null;
    }
    activeTabId = tab.id;
    activeUrl = tab.url || '';
    return tab;
  }

  /* -------------------------------------------------------------- 报告渲染 */

  function renderFilledList(report) {
    els.filledList.innerHTML = '';
    var list = report.filled || [];
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'report-empty';
      empty.textContent = '这一页没有可填的字段';
      els.filledList.appendChild(empty);
    }
    list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'report-item';
      var key = document.createElement('span');
      key.className = 'ri-key';
      key.textContent = item.label;
      li.appendChild(key);
      li.appendChild(document.createTextNode(' = '));
      var value = document.createElement('span');
      value.className = 'ri-value';
      value.textContent = item.display || item.value || '';
      li.appendChild(value);

      if (item.truncated) {
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'link tiny';
        toggle.textContent = '展开';
        toggle.addEventListener('click', function () {
          var expanded = toggle.getAttribute('data-expanded') === '1';
          value.textContent = expanded ? item.display : item.value;
          toggle.textContent = expanded ? '展开' : '收起';
          toggle.setAttribute('data-expanded', expanded ? '0' : '1');
        });
        li.appendChild(toggle);
      }
      els.filledList.appendChild(li);
    });
    setText(els.filledTitle, '已填 ' + list.length + ' 项');
  }

  function renderMissingList(report) {
    els.missingList.innerHTML = '';
    var list = report.missing || [];
    els.blockMissing.hidden = list.length === 0;
    setText(els.missingTitle, '待填 ' + list.length + ' 项');

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'missing-row';
      row.setAttribute('data-missing-key', item.key);

      var label = document.createElement('span');
      label.className = 'mr-label';
      label.textContent = item.label;
      row.appendChild(label);

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'mr-input';
      input.placeholder = '补上「' + item.label + '」';
      input.autocomplete = 'off';
      row.appendChild(input);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary small';
      btn.textContent = '补填';
      row.appendChild(btn);

      var status = document.createElement('span');
      status.className = 'mr-status';
      row.appendChild(status);

      function submit() {
        var value = input.value;
        btn.disabled = true;
        status.className = 'mr-status';
        status.textContent = '填充中…';
        supplementValue(item.key, item.label, value).then(function (result) {
          btn.disabled = false;
          if (!result.ok) {
            status.className = 'mr-status warn';
            status.textContent = result.error;
            return;
          }
          row.remove();
          var left = els.missingList.querySelectorAll('.missing-row').length;
          setText(els.missingTitle, '待填 ' + left + ' 项');
          if (!left) els.blockMissing.hidden = true;
          if (result.pageFilled === false) {
            showResult('error', '已存进简历，但页面没填上', result.error || '可以刷新页面后再点一次填充。');
          } else {
            showResult('ok', '已补填 1 项：' + item.label, '值已保存，页面上这个框已填好（未提交表单）。');
          }
        });
      }

      btn.addEventListener('click', submit);
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      els.missingList.appendChild(row);
    });
  }

  function renderUnmatchedList(report) {
    els.unmatchedList.innerHTML = '';
    var list = report.unmatched || [];
    els.blockUnmatched.hidden = list.length === 0;
    setText(els.unmatchedTitle, '未匹配 ' + list.length + ' 项（简历有值、页面没有对应输入框）');
    list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'report-item muted';
      var key = document.createElement('span');
      key.className = 'ri-key';
      key.textContent = item.label;
      li.appendChild(key);
      if (item.value) {
        li.appendChild(document.createTextNode(' = '));
        var value = document.createElement('span');
        value.className = 'ri-value';
        value.textContent = item.display || item.value;
        li.appendChild(value);
      }
      els.unmatchedList.appendChild(li);
    });
  }

  function renderReport(report) {
    if (!report) return;
    lastReport = report;
    els.report.hidden = false;
    var counts = report.counts || { filled: 0, missing: 0, unmatched: 0 };
    setText(
      els.reportTitle,
      '填充报告：已填 ' + counts.filled + ' · 待填 ' + counts.missing + ' · 未匹配 ' + counts.unmatched
    );
    var when = report.at ? new Date(report.at) : null;
    setText(els.reportTime, when && !isNaN(when.getTime()) ? when.toLocaleTimeString('zh-CN') : '');
    els.copyStatus.textContent = '';
    renderFilledList(report);
    renderMissingList(report);
    renderUnmatchedList(report);
  }

  /* ---------------------------------------------------------- 待填横幅 */

  function renderPending() {
    var summary = window.JC.summary(pendingItems);
    if (!summary.count) {
      els.pendingBanner.hidden = true;
      els.pendingList.hidden = true;
      els.pendingToggle.textContent = '展开';
      return;
    }
    els.pendingBanner.hidden = false;
    els.pendingTitle.textContent = summary.label;
    els.pendingClear.hidden = false;
    renderPendingList();
  }

  function renderPendingList() {
    els.pendingList.innerHTML = '';
    pendingItems.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'pending-row';
      row.setAttribute('data-pending-key', item.key);

      var label = document.createElement('span');
      label.className = 'mr-label';
      label.textContent = item.label;
      row.appendChild(label);

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'mr-input';
      input.placeholder = '补上「' + item.label + '」';
      input.autocomplete = 'off';
      row.appendChild(input);

      var fill = document.createElement('button');
      fill.type = 'button';
      fill.className = 'primary small';
      fill.textContent = '补填';
      row.appendChild(fill);

      var ignore = document.createElement('button');
      ignore.type = 'button';
      ignore.className = 'link tiny';
      ignore.textContent = '忽略';
      row.appendChild(ignore);

      var status = document.createElement('span');
      status.className = 'mr-status';
      row.appendChild(status);

      fill.addEventListener('click', function () {
        fill.disabled = true;
        status.textContent = '填充中…';
        supplementValue(item.key, item.label, input.value).then(function (result) {
          fill.disabled = false;
          if (!result.ok) {
            status.className = 'mr-status warn';
            status.textContent = result.error;
            return;
          }
          status.className = 'mr-status';
          status.textContent = result.pageFilled === false ? '已存简历，页面未填上' : '已补填 ✓';
          if (result.pageFilled === false) {
            showResult('error', '已存进简历，但页面没填上', result.error || '可以刷新页面后再点一次填充。');
          }
        });
      });

      ignore.addEventListener('click', function () {
        window.JC.removePendingItem(item.key).then(function () {
          refreshPending();
        });
      });

      els.pendingList.appendChild(row);
    });
  }

  async function refreshPending() {
    try {
      var bag = await window.JC.getPendingItems();
      pendingItems = bag.items || [];
    } catch (e) {
      pendingItems = [];
    }
    renderPending();
  }

  /* ---------------------------------------------------------- 内联补填 */

  /**
   * 补填一个字段：写简历存储 → 生成增量指令 → 交给 content script 只填这一个框。
   * 无论页面填充是否成功，值都已经存下来了；页面失败只提示，不假装成功。
   */
  async function supplementValue(key, label, value) {
    var applied = window.JC.applySupplement(resume, key, value, { label: label, group: 'extra' });
    if (!applied.ok) {
      return { ok: false, error: (applied.errors || ['补填失败']).join('；') };
    }

    var saved = await window.JC.saveResume(applied.resume);
    if (!saved.ok) {
      return { ok: false, error: '保存失败：' + (saved.errors || []).join('；') };
    }
    resume = saved.resume;
    renderProfile();

    var instruction = window.JC.buildFillOneInstruction({
      key: applied.key,
      value: value,
      label: applied.label,
      url: activeUrl
    });
    if (!window.JC.isNonSubmittingInstruction(instruction)) {
      return { ok: false, error: '增量指令异常，已中止（不会提交表单）' };
    }

    await window.JC.removePendingItem(applied.key);
    await refreshPending();
    moveReportItemToFilled(applied.key, applied.label, value);

    if (!activeTabId) {
      var tab = await currentTab();
      if (tab && tab.id) {
        activeTabId = tab.id;
        activeUrl = tab.url || activeUrl;
      }
    }
    if (!activeTabId) {
      return { ok: true, pageFilled: false, error: '已保存到简历，但没有可填充的标签页' };
    }

    var res;
    try {
      res = await chrome.tabs.sendMessage(activeTabId, instruction);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    if (!res || !res.ok) {
      return { ok: true, pageFilled: false, error: '已保存到简历，页面填充失败：' + ((res && res.error) || '未知错误') };
    }
    return { ok: true, pageFilled: true };
  }

  /** 补填成功后把报告里的这一项从「待填」挪到「已填」 */
  function moveReportItemToFilled(key, label, value) {
    if (!lastReport) return;
    var missing = [];
    for (var i = 0; i < (lastReport.missing || []).length; i++) {
      if (lastReport.missing[i].key !== key) missing.push(lastReport.missing[i]);
    }
    var cut = window.JC.truncateValue(value, window.JC.MAX_VALUE_LEN);
    lastReport.filled = (lastReport.filled || []).concat([
      { key: key, label: label, value: value, display: cut.display, truncated: cut.truncated }
    ]);
    lastReport.missing = missing;
    lastReport.counts = {
      filled: lastReport.filled.length,
      missing: missing.length,
      unmatched: (lastReport.unmatched || []).length
    };
    renderFilledList(lastReport);
  }

  /* -------------------------------------------------------------- 一键填充 */

  async function handleFill() {
    if (busy) return;
    if (!window.JC.hasAnyData(resume)) {
      showResult('error', '简历还是空的', '点下面的「编辑简历」填几个字段再来。');
      return;
    }

    busy = true;
    els.fillBtn.disabled = true;
    els.fillBtn.textContent = '填充中…';

    try {
      var tab = await prepareTab();
      if (!tab) return;

      var rulesBag = await window.JC.getRules();
      var res = await chrome.tabs.sendMessage(tab.id, {
        type: 'JC_FILL',
        resume: resume,
        rules: rulesBag.fieldRules || [],
        url: tab.url
      });
      if (!res || !res.ok) {
        showResult('error', '填充失败', (res && res.error) || '未知错误');
        return;
      }

      // popup 负责落盘命中计数，content script 不直接碰存储
      if (res.ruleHits && res.ruleHits.length) {
        try {
          await window.JC.bumpRuleHits(res.ruleHits);
        } catch (e) {
          /* 计数失败不影响本次填充结果 */
        }
      }

      var report = window.JC.reportFromFillResult(res, { url: tab.url, scanned: res.scanned });
      renderReport(report);
      showResult('ok', '已填 ' + report.counts.filled + ' 项', report.counts.missing || report.counts.unmatched
        ? '待填 ' + report.counts.missing + ' 项、未匹配 ' + report.counts.unmatched + ' 项，见下方报告。'
        : '简历里的字段这一页都填上了。');

      // 没当场补的待填项挂到 pendingItems，跨页面/跨会话携带
      if (report.missing.length) {
        var host = hostOf(tab.url);
        await window.JC.addPendingItems(
          report.missing.map(function (item) {
            return { key: item.key, label: item.label, host: host, source: 'fill-report' };
          }),
          { host: host, url: tab.url }
        );
        await refreshPending();
      }
    } catch (e) {
      showResult('error', '出错了', String((e && e.message) || e));
    } finally {
      busy = false;
      renderProfile();
    }
  }

  async function copyReport() {
    if (!lastReport) return;
    var text = window.JC.reportToText(lastReport, { url: activeUrl });
    try {
      await navigator.clipboard.writeText(text);
      els.copyStatus.textContent = '已复制';
    } catch (e) {
      els.copyStatus.textContent = '复制失败，请手动选中';
    }
  }

  /* -------------------------------------------------------------- 学习流 */

  function attrSample(entry) {
    var attrs = entry.attrs || {};
    var parts = [];
    ['id', 'name', 'placeholder', 'ariaLabel'].forEach(function (key) {
      if (attrs[key]) parts.push(key + '=' + String(attrs[key]).slice(0, 60));
    });
    return parts.join(' · ') || '（无可匹配属性）';
  }

  function fieldChoices() {
    var keys = fieldKeys();
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push({ key: keys[i], label: fieldLabel(keys[i]) });
    return out;
  }

  function renderLearnList() {
    els.learnList.innerHTML = '';
    var choices = fieldChoices();
    var keys = choices.map(function (c) { return c.key; });

    learnEntries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'learn-item';

      var label = document.createElement('div');
      label.className = 'li-label';
      label.textContent = entry.label || entry.selector || '（无标签字段）';
      item.appendChild(label);

      var meta = document.createElement('div');
      meta.className = 'li-meta';
      meta.appendChild(document.createTextNode(attrSample(entry) + ' → '));
      var selector = document.createElement('span');
      selector.className = 'li-selector';
      selector.textContent = entry.selector;
      meta.appendChild(selector);
      item.appendChild(meta);

      var select = document.createElement('select');
      select.setAttribute('data-learn-index', String(entry.index));

      var ignore = document.createElement('option');
      ignore.value = '__ignore__';
      ignore.textContent = '忽略（不生成规则）';
      select.appendChild(ignore);

      choices.forEach(function (choice) {
        var option = document.createElement('option');
        option.value = choice.key;
        option.textContent = choice.label + ' · ' + choice.key;
        select.appendChild(option);
      });

      select.value = entry.suggestedKey && keys.indexOf(entry.suggestedKey) !== -1 ? entry.suggestedKey : '__ignore__';
      item.appendChild(select);
      els.learnList.appendChild(item);
    });
  }

  async function handleLearn() {
    if (busy) return;
    busy = true;
    els.learnBtn.disabled = true;
    showResult('ok', '正在扫描当前页…', '只列出可见、可填的 input / textarea / select。');

    try {
      var tab = await prepareTab();
      if (!tab) return;

      var res = await chrome.tabs.sendMessage(tab.id, { type: 'JC_SCAN_FIELDS' });
      if (!res || !res.ok) {
        showResult('error', '扫描失败', (res && res.error) || 'content script 没有返回结果。');
        return;
      }
      learnEntries = Array.isArray(res.entries) ? res.entries : [];
      learnHost = hostOf(res.url || tab.url);

      if (!learnEntries.length) {
        els.learnPanel.hidden = true;
        showResult('error', '没有可学习的字段', '这个页面没有可见的 input / textarea / select。');
        return;
      }

      els.learnScopeLabel.textContent = learnHost ? '只在此站点生效（' + learnHost + '）' : '只在此站点生效';
      els.learnScope.checked = Boolean(learnHost);
      renderLearnList();
      els.learnPanel.hidden = false;
      showLearnStatus('扫描到 ' + learnEntries.length + ' 个字段，选好后点「保存规则」。');
      showResult('ok', '扫描到 ' + learnEntries.length + ' 个字段', '在下方给每个字段选目标，或保持「忽略」。');
    } catch (e) {
      showResult('error', '扫描出错', String((e && e.message) || e));
    } finally {
      busy = false;
      els.learnBtn.disabled = false;
    }
  }

  async function saveLearnedRules() {
    var selects = els.learnList.querySelectorAll('select[data-learn-index]');
    var selection = {};
    for (var i = 0; i < selects.length; i++) {
      selection[selects[i].getAttribute('data-learn-index')] = selects[i].value;
    }

    var sitePattern = els.learnScope.checked ? learnHost : '';
    var rules = window.JC.buildRulesFromSelection(learnEntries, selection, { sitePattern: sitePattern });
    if (!rules.length) {
      showLearnStatus('没有选中任何字段，先给至少一个字段选目标。', 'warn');
      return;
    }

    els.learnSave.disabled = true;
    var saved = 0;
    var errors = [];
    try {
      for (var r = 0; r < rules.length; r++) {
        var result = await window.JC.addRule(rules[r]);
        if (result.ok) saved++;
        else errors.push((result.errors || []).join('；'));
      }
      if (saved) {
        showLearnStatus('已保存 ' + saved + ' 条规则' + (errors.length ? '，' + errors.length + ' 条失败' : '') + '。', errors.length ? 'warn' : '');
        showResult('ok', '已学习 ' + saved + ' 条规则', sitePattern ? '仅对 ' + sitePattern + ' 生效。' : '对所有站点生效。');
      } else {
        showLearnStatus('规则没有保存成功：' + errors.join('；'), 'warn');
      }
    } finally {
      els.learnSave.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  async function boot() {
    resume = await window.JC.getResume();
    renderProfile();
    await refreshPending();
    window.JC.onResumeChanged(function (next) {
      resume = next;
      renderProfile();
    });
  }

  els.fillBtn.addEventListener('click', handleFill);
  els.learnBtn.addEventListener('click', handleLearn);
  els.learnSave.addEventListener('click', saveLearnedRules);
  els.learnClose.addEventListener('click', function () {
    els.learnPanel.hidden = true;
  });
  els.copyReport.addEventListener('click', copyReport);
  els.pendingToggle.addEventListener('click', function () {
    var hidden = els.pendingList.hidden;
    els.pendingList.hidden = !hidden;
    els.pendingToggle.textContent = hidden ? '收起' : '展开';
  });
  els.pendingClear.addEventListener('click', function () {
    window.JC.clearPendingItems().then(function () {
      refreshPending();
    });
  });
  els.refreshBtn.addEventListener('click', boot);
  els.optionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  boot().catch(function (e) {
    showResult('error', '读取简历失败', String((e && e.message) || e));
  });
})();
