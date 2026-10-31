/**
 * JustClick — popup
 * 读本地简历 → 向当前标签页的 content script 发填充指令 → 展示结果与缺口。
 */
(function () {
  'use strict';

  var els = {
    fillBtn: document.getElementById('fill-btn'),
    result: document.getElementById('result'),
    completeness: document.getElementById('completeness'),
    completenessBar: document.getElementById('completeness-bar'),
    profileName: document.getElementById('profile-name'),
    missingChips: document.getElementById('missing-chips'),
    updatedAt: document.getElementById('updated-at'),
    optionsBtn: document.getElementById('options-btn'),
    refreshBtn: document.getElementById('refresh-btn')
  };

  var resume = null;
  var busy = false;

  function filledFieldKeys() {
    var keys = window.JC.FIELD_KEYS || [];
    var ready = [];
    for (var i = 0; i < keys.length; i++) {
      if (window.JC.resolveValue(resume, keys[i])) ready.push(keys[i]);
    }
    return ready;
  }

  function renderProfile() {
    var keys = window.JC.FIELD_KEYS || [];
    var ready = filledFieldKeys();
    els.completeness.textContent = ready.length + ' / ' + keys.length;
    els.completenessBar.style.width = Math.round((ready.length / keys.length) * 100) + '%';

    var name = window.JC.resolveValue(resume, 'fullName');
    els.profileName.textContent = name ? name : '尚未填写简历';

    els.missingChips.innerHTML = '';
    keys.forEach(function (key) {
      if (ready.indexOf(key) !== -1) return;
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = window.JC.FIELD_LABELS[key] || key;
      els.missingChips.appendChild(chip);
    });

    if (resume && resume.updatedAt) {
      var d = new Date(resume.updatedAt);
      els.updatedAt.textContent = '更新于 ' + (isNaN(d.getTime()) ? resume.updatedAt : d.toLocaleString('zh-CN'));
    } else {
      els.updatedAt.textContent = '还没有保存过简历';
    }

    els.fillBtn.disabled = ready.length === 0;
    if (ready.length === 0) {
      els.fillBtn.textContent = '先填写简历';
    } else {
      els.fillBtn.textContent = '一键填充当前页面';
    }
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

  /** content script 可能因安装前已打开的页面而缺失，这里按需补注入 */
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
        files: ['lib/resume-schema.js', 'lib/field-matcher.js', 'content/content.js']
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
      var tab = await currentTab();
      if (!tab || !tab.id) {
        showResult('error', '拿不到当前标签页', '请在一个普通网页上重试。');
        return;
      }
      if (!isInjectableUrl(tab.url)) {
        showResult('error', '这个页面不能填', 'Chrome 内部页面和扩展商店页面无法注入脚本。');
        return;
      }

      var ready = await ensureContentScript(tab.id);
      if (!ready) {
        showResult('error', '注入失败', '请刷新目标页面后重试，或检查是否被浏览器策略拦截。');
        return;
      }

      var res = await chrome.tabs.sendMessage(tab.id, { type: 'JC_FILL', resume: resume });
      if (!res || !res.ok) {
        showResult('error', '填充失败', (res && res.error) || '未知错误');
        return;
      }

      if (res.filled > 0) {
        var subs = [];
        if (res.missing && res.missing.length) subs.push('简历缺少：' + res.missing.join('、'));
        if (res.notFound && res.notFound.length) subs.push('页面没找到：' + res.notFound.join('、'));
        if (res.failures && res.failures.length) subs.push('写入失败：' + res.failures.join('、'));
        showResult('ok', '已填 ' + res.filled + ' 项：' + res.filledLabels.join('、'), subs.join('\n'));
      } else if (res.scanned === 0) {
        showResult('error', '没发现表单', '这个页面似乎没有可填的输入框。');
      } else {
        var why = [];
        if (res.missing && res.missing.length) why.push('简历缺少：' + res.missing.join('、'));
        if (res.notFound && res.notFound.length) why.push('页面没找到：' + res.notFound.join('、'));
        showResult('error', '没找到可填字段', why.join('\n') || '识别到的 ' + res.scanned + ' 个输入框都不匹配简历字段。');
      }
    } catch (e) {
      showResult('error', '出错了', String((e && e.message) || e));
    } finally {
      busy = false;
      renderProfile();
    }
  }

  async function boot() {
    resume = await window.JC.getResume();
    renderProfile();
    window.JC.onResumeChanged(function (next) {
      resume = next;
      renderProfile();
    });
  }

  els.fillBtn.addEventListener('click', handleFill);
  els.refreshBtn.addEventListener('click', boot);
  els.optionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  boot().catch(function (e) {
    showResult('error', '读取简历失败', String((e && e.message) || e));
  });
})();
