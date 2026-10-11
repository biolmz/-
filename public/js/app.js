/* ============================================================
   感官评价线上评分系统 — 评价员端
   ============================================================ */

(function () {
  'use strict';

  var TOKEN_KEY = 'sensory_eval_token';
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    config: null,
    samples: [],
    evaluator: null,
    current: 0,
    draft: {},        // { 样品编号: { 指标key: 分数, note: '' } }
    levelChoice: {},  // { 样品编号: { 指标key: 档位索引 } }
  };

  var token = localStorage.getItem(TOKEN_KEY) || '';

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(path, opts) {
    var o = opts || {};
    var headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token && o.auth !== false) headers['Authorization'] = 'Bearer ' + token;
    var res = await fetch(path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined
    });
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      var err = new Error(data.error || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function showView(name) {
    ['loading', 'login', 'consent', 'score', 'done'].forEach(function (v) {
      var el = $('view-' + v);
      if (el) el.classList.toggle('hidden', v !== name);
    });
    window.scrollTo(0, 0);
  }

  function setUserBadge() {
    var box = $('userBox');
    if (!state.evaluator) { box.classList.add('hidden'); box.style.display = 'none'; return; }
    box.classList.remove('hidden');
    box.style.display = 'flex';
    $('userBadge').textContent = '评价员 ' + state.evaluator.code +
      (state.evaluator.name ? ' · ' + state.evaluator.name : '');
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    try {
      var data = await api('/api/bootstrap', { auth: false });
      state.config = data.config;
      applyBranding();
    } catch (e) {
      $('view-loading').innerHTML = '<div class="alert alert-error">无法连接服务器：' + esc(e.message) + '</div>';
      return;
    }

    if (token) {
      try {
        var me = await api('/api/evaluator/me');
        state.evaluator = me.evaluator;
        state.samples = me.samples;
        state.config = me.config;
        applyBranding();
        seedDraftFromServer();
        route();
        return;
      } catch (e) {
        localStorage.removeItem(TOKEN_KEY);
        token = '';
      }
    }
    showView('login');
  }

  function applyBranding() {
    if (!state.config) return;
    document.title = state.config.title + ' · 线上评分';
    $('brandTitle').textContent = state.config.title;
    $('brandSub').textContent = state.config.subtitle || 'Sensory Evaluation System';
    $('heroTitle').textContent = state.config.title;
    $('heroDesc').textContent = state.config.open
      ? '请填写您的评价员编号进入评分。评分全程盲评，样品以随机三位数编号呈现。'
      : '本次评价当前未开放，如有疑问请联系组织者。';

    var badge = document.querySelector('.hero-badge');
    if (badge) {
      badge.textContent = state.config.sessionName
        ? '感官评价 · ' + state.config.sessionName
        : '感官评价 · 线上评分';
    }

    var alertBox = $('loginAlert');
    if (alertBox) {
      alertBox.innerHTML = state.config.open
        ? ''
        : '<div class="alert alert-warn"><span>⚠️</span><span>本次评价（' +
          esc(state.config.sessionName || '') + '）已关闭，暂不能进入评分。如有疑问请联系组织者。</span></div>';
    }
  }

  function route() {
    var ev = state.evaluator;
    setUserBadge();
    if (ev.submitted) return renderDone();
    if (!ev.consented) return renderConsent();
    return renderScore();
  }

  function seedDraftFromServer() {
    var ev = state.evaluator;
    state.draft = {};
    state.levelChoice = {};
    Object.keys(ev.scores || {}).forEach(function (code) {
      var s = ev.scores[code];
      var d = { note: s.note || '' };
      state.config.criteria.forEach(function (c) { d[c.key] = s[c.key]; });
      state.draft[code] = d;
      state.levelChoice[code] = {};
      state.config.criteria.forEach(function (c, i) {
        state.levelChoice[code][c.key] = pickLevel(c, s[c.key]);
      });
    });
  }

  function pickLevel(crit, value) {
    var v = Number(value);
    if (!Number.isFinite(v)) return -1;
    for (var i = 0; i < crit.levels.length; i += 1) {
      var l = crit.levels[i];
      if (v >= l.min && v <= l.max) return i;
    }
    return -1;
  }

  /* ---------------- 登录 ---------------- */

  $('btnLogin').addEventListener('click', doLogin);
  $('inputCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('inputName').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    var code = $('inputCode').value.trim();
    var name = $('inputName').value.trim();
    if (!code) {
      $('loginAlert').innerHTML = '<div class="alert alert-error">请填写评价员编号</div>';
      return;
    }
    $('loginAlert').innerHTML = '';
    var btn = $('btnLogin');
    btn.disabled = true;
    btn.textContent = '正在进入…';
    try {
      var data = await api('/api/evaluator/login', { method: 'POST', auth: false, body: { code: code, name: name } });
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      state.evaluator = data.evaluator;
      state.samples = data.samples;
      state.config = data.config;
      applyBranding();
      seedDraftFromServer();
      route();
    } catch (e) {
      $('loginAlert').innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = '进入评价';
    }
  }

  $('btnLogout').addEventListener('click', function () {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    state.evaluator = null;
    state.draft = {};
    setUserBadge();
    $('inputCode').value = '';
    $('inputName').value = '';
    showView('login');
  });

  /* ---------------- 知情同意书 ---------------- */

  var agreedFlags = [];

  function renderConsent() {
    var c = state.config.consent || {};
    $('consentTitle').textContent = c.title || '知情同意书';

    var html = '';
    if (c.intro) html += '<p>' + esc(c.intro) + '</p>';
    (c.sections || []).forEach(function (sec) {
      html += '<h3>' + esc(sec.h) + '</h3>';
      (sec.p || []).forEach(function (p) { html += '<p>' + esc(p) + '</p>'; });
    });
    $('consentBody').innerHTML = html;

    agreedFlags = (c.declarations || []).map(function () { return false; });
    var dHtml = '';
    (c.declarations || []).forEach(function (text, i) {
      dHtml += '<label class="check-row" data-i="' + i + '">' +
        '<input type="checkbox" data-decl="' + i + '">' +
        '<span>' + esc(text) + '</span></label>';
    });
    $('declarations').innerHTML = dHtml;

    $('inputSignature').value = state.evaluator.signature || state.evaluator.name || '';

    $('declarations').querySelectorAll('input[data-decl]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var i = Number(cb.getAttribute('data-decl'));
        agreedFlags[i] = cb.checked;
        cb.closest('.check-row').classList.toggle('checked', cb.checked);
        updateConsentButton();
      });
    });
    updateConsentButton();

    $('consentBody').scrollTop = 0;
    showView('consent');
  }

  function updateConsentButton() {
    var all = agreedFlags.length > 0 && agreedFlags.every(Boolean);
    $('btnConsent').disabled = !all;
  }

  $('inputSignature').addEventListener('input', updateConsentButton);

  $('btnConsent').addEventListener('click', async function () {
    var sig = $('inputSignature').value.trim();
    if (!sig) {
      $('consentAlert').innerHTML = '<div class="alert alert-error">请填写签名后再继续</div>';
      return;
    }
    var btn = $('btnConsent');
    btn.disabled = true;
    btn.textContent = '正在提交…';
    try {
      var data = await api('/api/evaluator/consent', {
        method: 'POST',
        body: { agreed: true, signature: sig }
      });
      state.evaluator = data.evaluator;
      $('consentAlert').innerHTML = '';
      setUserBadge();
      renderScore();
    } catch (e) {
      $('consentAlert').innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>';
      btn.disabled = false;
    } finally {
      btn.textContent = '同意并开始评价';
      updateConsentButton();
    }
  });

  /* ---------------- 评分 ---------------- */

  function draftOf(code) {
    if (!state.draft[code]) {
      state.draft[code] = { note: '' };
      state.levelChoice[code] = {};
      state.config.criteria.forEach(function (c) { state.levelChoice[code][c.key] = -1; });
    }
    return state.draft[code];
  }

  function isComplete(code) {
    var d = state.draft[code];
    if (!d) return false;
    return state.config.criteria.every(function (c) {
      var v = Number(d[c.key]);
      return Number.isInteger(v) && v >= 1 && v <= Number(c.max);
    });
  }

  function totalOfDraft(code) {
    var d = state.draft[code] || {};
    return state.config.criteria.reduce(function (s, c) {
      var v = Number(d[c.key]);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  }

  function renderScore() {
    renderChips();
    renderNotice();
    renderCriteria();
    renderCurrent();
    showView('score');
  }

  function renderNotice() {
    var n = state.config.notice;
    $('noticeBox').innerHTML = n
      ? '<div class="alert alert-info"><span>ℹ️</span><span>' + esc(n) + '</span></div>'
      : '';
  }

  function renderChips() {
    var html = '';
    state.samples.forEach(function (s, i) {
      var done = isComplete(s.code);
      var cls = 'chip' + (done ? ' done' : '') + (i === state.current ? ' active' : '');
      html += '<button class="' + cls + '" data-idx="' + i + '">' +
        '<span class="chip-dot"></span>' + esc(s.code) + '</button>';
    });
    $('chips').innerHTML = html;

    $('chips').querySelectorAll('.chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.current = Number(btn.getAttribute('data-idx'));
        renderScore();
      });
    });

    var done = state.samples.filter(function (s) { return isComplete(s.code); }).length;
    var pct = state.samples.length ? (done / state.samples.length) * 100 : 0;
    $('progressFill').style.width = pct + '%';
  }

  function renderCurrent() {
    var s = state.samples[state.current];
    $('curSample').textContent = s ? s.code : '—';
    var noteBox = $('sampleNoteBox');
    if (s && s.note) {
      noteBox.innerHTML = '<span class="badge badge-info">' + esc(s.note) + '</span>';
    } else {
      noteBox.innerHTML = '<span class="badge badge-muted">第 ' + (state.current + 1) + ' / ' + state.samples.length + ' 个样品</span>';
    }

    var d = draftOf(s.code);
    $('inputNote').value = d.note || '';

    $('totalMax').textContent = state.config.criteria.reduce(function (a, c) { return a + Number(c.max); }, 0);
    updateTotal();

    $('btnPrev').disabled = state.current === 0;
    var last = state.current === state.samples.length - 1;
    var allDone = state.samples.every(function (x) { return isComplete(x.code); });
    $('btnSaveNext').textContent = (last && allDone) ? '提交全部评分' : '保存并下一个';
  }

  function updateTotal() {
    var s = state.samples[state.current];
    if (!s) return;
    $('totalScore').textContent = totalOfDraft(s.code);
  }

  function renderCriteria() {
    var s = state.samples[state.current];
    var d = draftOf(s.code);
    var choices = state.levelChoice[s.code] || {};

    var html = '';
    state.config.criteria.forEach(function (c) {
      var v = d[c.key];
      var hasVal = Number.isFinite(Number(v));
      var sel = choices[c.key];
      if (sel === undefined) sel = pickLevel(c, v);

      html += '<div class="crit" data-key="' + esc(c.key) + '">';
      html += '  <div class="crit-head">';
      html += '    <span class="crit-name">' + esc(c.name) + '</span>';
      html += '    <span class="crit-max">满分 ' + c.max + ' 分</span>';
      html += '    <span class="crit-score' + (hasVal ? ' filled' : '') + '" data-score>' +
        (hasVal ? v : '—') + '<small>/' + c.max + '</small></span>';
      html += '  </div>';
      html += '  <div class="levels">';
      c.levels.forEach(function (l, i) {
        html += '<button class="level' + (sel === i ? ' selected' : '') + '" data-level="' + i + '">' +
          '<span class="level-radio"></span>' +
          '<span class="level-range">' + l.min + '～' + l.max + ' 分</span>' +
          '<span class="level-desc">' + esc(l.desc) + '</span>' +
          '</button>';
      });
      html += '  </div>';
      html += '  <div class="slider-box' + (sel >= 0 ? ' show' : '') + '" data-slider>';
      html += '    <div class="slider-row">';
      html += '      <div class="stepper">';
      html += '        <button data-step="-1">−</button>';
      html += '        <span class="stepper-val" data-val>' + (hasVal ? v : '—') + '</span>';
      html += '        <button data-step="1">+</button>';
      html += '      </div>';
      html += '      <input type="range" data-range min="0" max="1" step="1" value="0">';
      html += '    </div>';
      html += '    <div class="range-hint" data-range-hint></div>';
      html += '  </div>';
      html += '</div>';
    });

    $('criteriaBox').innerHTML = html;

    state.config.criteria.forEach(function (c) {
      var box = $('criteriaBox').querySelector('.crit[data-key="' + c.key + '"]');
      wireCriterion(box, c, s.code);
    });
  }

  function wireCriterion(box, crit, code) {
    var d = draftOf(code);
    var choices = state.levelChoice[code];

    box.querySelectorAll('.level').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.getAttribute('data-level'));
        var lv = crit.levels[i];
        choices[crit.key] = i;
        var mid = Math.round((lv.min + lv.max) / 2);
        var cur = Number(d[crit.key]);
        if (!Number.isFinite(cur) || cur < lv.min || cur > lv.max) {
          d[crit.key] = mid;
        }
        renderCriteria();
        renderChips();
        updateTotal();
      });
    });

    var range = box.querySelector('[data-range]');
    var valEl = box.querySelector('[data-val]');
    var hint = box.querySelector('[data-range-hint]');
    var sel = choices[crit.key];
    var lv = sel >= 0 ? crit.levels[sel] : null;

    if (lv) {
      range.min = lv.min;
      range.max = lv.max;
      var v = Number(d[crit.key]);
      if (!Number.isFinite(v)) v = Math.round((lv.min + lv.max) / 2);
      v = Math.max(lv.min, Math.min(lv.max, Math.round(v)));
      d[crit.key] = v;
      range.value = v;
      valEl.textContent = v;
      hint.textContent = '按 ' + lv.min + '～' + lv.max + ' 分区间微调（当前 ' + v + ' 分）';
    }

    function setVal(v) {
      if (!lv) return;
      v = Math.max(lv.min, Math.min(lv.max, Math.round(v)));
      d[crit.key] = v;
      range.value = v;
      valEl.textContent = v;
      hint.textContent = '按 ' + lv.min + '～' + lv.max + ' 分区间微调（当前 ' + v + ' 分）';
      var scoreEl = box.querySelector('[data-score]');
      scoreEl.innerHTML = v + '<small>/' + crit.max + '</small>';
      scoreEl.classList.add('filled');
      renderChips();
      updateTotal();
    }

    range.addEventListener('input', function () { setVal(Number(range.value)); });

    box.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        setVal(Number(d[crit.key]) + Number(b.getAttribute('data-step')));
      });
    });
  }

  $('inputNote').addEventListener('input', function () {
    var s = state.samples[state.current];
    if (s) draftOf(s.code).note = $('inputNote').value;
  });

  $('btnPrev').addEventListener('click', function () {
    if (state.current > 0) {
      state.current -= 1;
      renderScore();
    }
  });

  async function saveCurrent() {
    var s = state.samples[state.current];
    var d = draftOf(s.code);
    var payload = { sampleCode: s.code, note: d.note || '', scores: {} };
    state.config.criteria.forEach(function (c) { payload.scores[c.key] = Number(d[c.key]); });
    var data = await api('/api/evaluator/score', { method: 'POST', body: payload });
    state.evaluator = data.evaluator;
  }

  $('btnSaveNext').addEventListener('click', async function () {
    var s = state.samples[state.current];
    if (!isComplete(s.code)) {
      var missing = state.config.criteria.filter(function (c) {
        var v = Number(state.draft[s.code][c.key]);
        return !(Number.isInteger(v) && v >= 1 && v <= Number(c.max));
      }).map(function (c) { return c.name; });
      toast('请先完成：' + missing.join('、'), 'err');
      return;
    }

    var btn = $('btnSaveNext');
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '保存中…';
    try {
      await saveCurrent();

      var allDone = state.samples.every(function (x) { return isComplete(x.code); });
      var last = state.current === state.samples.length - 1;

      if (last && allDone) {
        btn.disabled = false;
        btn.textContent = original;
        renderScore();
        return askSubmit();
      }

      if (last) {
        var idx = state.samples.findIndex(function (x) { return !isComplete(x.code); });
        state.current = idx >= 0 ? idx : 0;
      } else {
        state.current += 1;
      }
      renderScore();
      toast('已保存 样品 ' + s.code, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  function askSubmit() {
    var total = state.samples.reduce(function (a, x) { return a + totalOfDraft(x.code); }, 0);
    var root = $('modalRoot');
    root.innerHTML =
      '<div class="modal-mask"><div class="modal">' +
      '<h3>确认提交全部评分？</h3>' +
      '<p>您已完成 ' + state.samples.length + ' 个样品的评价，合计 ' + total + ' 分。提交后评分将不可自行修改，如需更正请联系组织者。</p>' +
      '<div class="btn-row" style="justify-content:flex-end">' +
      '<button class="btn" id="mCancel">再检查一下</button>' +
      '<button class="btn btn-primary" id="mOk">确认提交</button>' +
      '</div></div></div>';

    $('mCancel').addEventListener('click', function () { root.innerHTML = ''; });
    $('mOk').addEventListener('click', async function () {
      var okBtn = $('mOk');
      okBtn.disabled = true;
      okBtn.textContent = '提交中…';
      try {
        var data = await api('/api/evaluator/submit', { method: 'POST', body: {} });
        state.evaluator = data.evaluator;
        root.innerHTML = '';
        renderDone();
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = '确认提交';
        toast(e.message, 'err');
      }
    });
  }

  /* ---------------- 完成页 ---------------- */

  function renderDone() {
    var ev = state.evaluator;
    var html = '';
    state.samples.forEach(function (s) {
      var t = totalOfDraft(s.code);
      var done = isComplete(s.code);
      html += '<tr><td class="mono"><b>' + esc(s.code) + '</b></td>' +
        '<td class="num mono">' + (done ? t : '—') + '</td>' +
        '<td>' + (done ? '<span class="badge badge-ok">已评分</span>' : '<span class="badge badge-muted">未评分</span>') + '</td></tr>';
    });
    $('doneTable').innerHTML = html;

    if (ev.submitted) {
      $('doneTitle').textContent = '评分已提交，感谢您的参与！';
      $('doneDesc').textContent = '您的评分数据已记录，请勿与他人讨论评分内容。';
      $('doneFooter').textContent = '提交时间：' + new Date(ev.submittedAt).toLocaleString('zh-CN');
    } else {
      $('doneTitle').textContent = '您已完成全部样品评分';
      $('doneDesc').textContent = '请确认无误后提交，提交后不可自行修改。';
      $('doneFooter').innerHTML = '<button class="btn btn-primary" id="btnFinalSubmit">提交全部评分</button>';
      var b = $('btnFinalSubmit');
      if (b) b.addEventListener('click', askSubmit);
    }
    setUserBadge();
    showView('done');
  }

  /* ---------------- 启动 ---------------- */
  boot();
})();
