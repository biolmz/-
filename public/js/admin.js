/* ============================================================
   感官评价线上评分系统 — 管理端（支持多场次）
   ============================================================ */

(function () {
  'use strict';

  var TOKEN_KEY = 'sensory_admin_token';
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    data: null,
    tab: 'overview',
    filter: '',
    viewSessionId: '',   // '' 表示跟随当前场次
    analysis: null,      // 分析结果缓存
    alpha: '0.05',
    charts: {}           // 已渲染图表的 SVG 源码，供下载
  };

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ms(v) {
    if (v === null || v === undefined || v === '') return '—';
    return Number(v).toFixed(2);
  }

  function when(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch (e) { return iso; }
  }

  function dayOf(iso) {
    if (!iso) return '';
    try { return iso.slice(0, 10); } catch (e) { return ''; }
  }

  async function api(path, opts) {
    var o = opts || {};
    var headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
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
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3000);
  }

  function sessionQuery(extra) {
    var sid = state.data && state.data.session ? state.data.session.id : '';
    var q = sid ? 'sessionId=' + encodeURIComponent(sid) : '';
    if (extra) q += (q ? '&' : '') + extra;
    return q ? '?' + q : '';
  }

  async function downloadCSV(path, filename) {
    try {
      var res = await fetch(path, { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) {
        var e = await res.json().catch(function () { return {}; });
        throw new Error(e.error || '导出失败');
      }
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast('已开始下载：' + filename, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function showView(name) {
    $('view-login').classList.toggle('hidden', name !== 'login');
    $('view-main').classList.toggle('hidden', name !== 'main');
    $('adminBox').classList.toggle('hidden', name !== 'main');
    $('adminBox').style.display = name === 'main' ? 'flex' : 'none';
    window.scrollTo(0, 0);
  }

  /* ---------------- 登录 ---------------- */

  $('btnLogin').addEventListener('click', doLogin);
  $('inputPwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    var pwd = $('inputPwd').value;
    if (!pwd) {
      $('loginAlert').innerHTML = '<div class="alert alert-error">请输入管理密码</div>';
      return;
    }
    var btn = $('btnLogin');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      var data = await api('/api/admin/login', { method: 'POST', body: { password: pwd } });
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, state.token);
      $('inputPwd').value = '';
      $('loginAlert').innerHTML = '';
      await loadState();
      showView('main');
    } catch (e) {
      $('loginAlert').innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }

  $('btnLogout').addEventListener('click', function () {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.data = null;
    showView('login');
  });

  /* ---------------- 数据加载 ---------------- */

  async function loadState() {
    var data = await api('/api/admin/state' + sessionQuery());
    state.data = data;
    state.analysis = null;   // 数据可能已变化，分析结果失效
    renderAll();
    if (state.tab === 'analysis') loadAnalysis();
  }

  function renderAll() {
    if (!state.data) return;
    renderHeader();
    renderSessionBar();
    renderOverview();
    renderStats();
    renderRecords();
    renderPeople();
    renderSettings();
  }

  function renderHeader() {
    var cfg = state.data.config;
    document.title = cfg.title + ' · 管理端';
    $('brandTitle').textContent = cfg.title;
    $('brandSub').textContent = cfg.subtitle || 'Sensory Evaluation Admin';
  }

  /* ---------------- 场次栏 ---------------- */

  function renderSessionBar() {
    var s = state.data.session;
    if (!s) return;

    var opts = state.data.sessions.map(function (x) {
      var tag = x.status === 'open' ? '开放中' : '已关闭';
      return '<option value="' + esc(x.id) + '"' + (x.id === s.id ? ' selected' : '') + '>' +
        esc(x.name) + ' · ' + tag + ' · ' + x.submittedCount + '/' + x.evaluatorCount + ' 人已提交' +
        (x.isActive ? '（当前）' : '') + '</option>';
    }).join('');
    $('sessionSelect').innerHTML = opts;

    var badge = $('sessionStatusBadge');
    badge.textContent = s.status === 'open' ? '开放中' : '已关闭';
    badge.className = 'badge ' + (s.status === 'open' ? 'badge-ok' : 'badge-danger');

    $('btnToggleSession').textContent = s.status === 'open'
      ? (s.isActive ? '关闭本次评分' : '关闭该场次')
      : (s.isActive ? '重新开放本次评分' : '重新开放该场次');

    $('btnDeleteSession').disabled = state.data.sessions.length <= 1;

    var banner = '';
    if (!s.isActive) {
      banner = '<div class="alert alert-info"><span>👁</span><span>' +
        '正在查看历史场次「<b>' + esc(s.name) + '</b>」，数据为只读。评价员当前看到的是「' +
        esc(activeName()) + '」。' +
        '<button class="btn btn-sm" id="btnActivate" style="margin-left:10px">设为当前场次</button>' +
        '</span></div>';
    }
    $('readonlyBanner').innerHTML = banner;
    var act = $('btnActivate');
    if (act) {
      act.addEventListener('click', function () {
        confirmModal('设为当前场次？', '评价员入口将切换到「' + s.name + '」。当前场次「' + activeName() + '」会保留，可随时切回。', '确认切换', async function () {
          await api('/api/admin/sessions/activate', { method: 'POST', body: { id: s.id } });
          toast('已切换当前场次', 'ok');
          await loadState();
        });
      });
    }
  }

  function activeName() {
    var a = state.data.sessions.find(function (x) { return x.isActive; });
    return a ? a.name : '—';
  }

  $('sessionSelect').addEventListener('change', async function () {
    state.viewSessionId = $('sessionSelect').value;
    try {
      await loadState();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnNewSession').addEventListener('click', newSessionModal);

  function newSessionModal() {
    var prev = state.data.session;
    var n = state.data.sessions.length + 1;
    var today = new Date().toISOString().slice(0, 10);
    var root = $('modalRoot');
    root.innerHTML =
      '<div class="modal-mask"><div class="modal">' +
      '<h3>新建下一次评分</h3>' +
      '<p>新建后，当前场次「' + esc(prev.name) + '」将自动关闭并归档，历史数据完整保留、随时可查看和导出；评价员入口会切换到新场次。</p>' +
      '<label class="field"><span class="field-label">场次名称</span>' +
      '<input class="input" id="nsName" value="第 ' + n + ' 次评价（' + today + '）" maxlength="60"></label>' +
      '<label class="check-row" style="margin-bottom:16px"><input type="checkbox" id="nsCopy"' +
      (prev.samples.length ? ' checked' : '') + '><span>复制本次的样品编码（' + prev.samples.length + ' 个）到新场次</span></label>' +
      '<div class="btn-row" style="justify-content:flex-end">' +
      '<button class="btn" id="mCancel">取消</button>' +
      '<button class="btn btn-primary" id="mOk">创建新场次</button>' +
      '</div></div></div>';

    $('mCancel').addEventListener('click', function () { root.innerHTML = ''; });
    $('mOk').addEventListener('click', async function () {
      var btn = $('mOk');
      btn.disabled = true;
      btn.textContent = '创建中…';
      try {
        var res = await api('/api/admin/sessions', {
          method: 'POST',
          body: { name: $('nsName').value.trim(), copySamples: $('nsCopy').checked }
        });
        state.viewSessionId = res.session.id;
        root.innerHTML = '';
        toast('已创建新场次，可以开始下一次评分了', 'ok');
        await loadState();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '创建新场次';
        toast(e.message, 'err');
      }
    });
  }

  $('btnToggleSession').addEventListener('click', async function () {
    var s = state.data.session;
    var toOpen = s.status !== 'open';
    var title = toOpen ? '重新开放该场次？' : '关闭本次评分？';
    var desc = toOpen
      ? '重新开放后，评价员可以继续进入并评分。'
      : '关闭后：新的评价员将无法进入；已进入但尚未提交的评价员仍可继续完成并提交，避免数据丢失。统计与导出不受影响。';
    confirmModal(title, desc, toOpen ? '确认开放' : '确认关闭', async function () {
      await api('/api/admin/sessions/status', { method: 'POST', body: { id: s.id, status: toOpen ? 'open' : 'closed' } });
      toast(toOpen ? '已开放' : '已关闭', 'ok');
      await loadState();
    });
  });

  $('btnRenameSession').addEventListener('click', function () {
    var s = state.data.session;
    var root = $('modalRoot');
    root.innerHTML =
      '<div class="modal-mask"><div class="modal">' +
      '<h3>重命名场次</h3>' +
      '<label class="field"><span class="field-label">场次名称</span>' +
      '<input class="input" id="rnName" value="' + esc(s.name) + '" maxlength="60"></label>' +
      '<div class="btn-row" style="justify-content:flex-end">' +
      '<button class="btn" id="mCancel">取消</button>' +
      '<button class="btn btn-primary" id="mOk">保存</button>' +
      '</div></div></div>';
    $('mCancel').addEventListener('click', function () { root.innerHTML = ''; });
    $('mOk').addEventListener('click', async function () {
      try {
        await api('/api/admin/sessions', { method: 'PUT', body: { id: s.id, name: $('rnName').value.trim() } });
        root.innerHTML = '';
        toast('已重命名', 'ok');
        await loadState();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('btnDeleteSession').addEventListener('click', function () {
    var s = state.data.session;
    confirmModal('删除场次「' + s.name + '」？',
      '该场次下的 ' + s.evaluators.length + ' 名评价员、' + s.evaluators.reduce(function (a, e) { return a + e.scoredCount; }, 0) +
      ' 条评分记录将被永久删除，此操作不可撤销。建议先导出原始数据。',
      '确认删除', async function () {
        var res = await api('/api/admin/sessions?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
        state.viewSessionId = res.activeSessionId;
        toast('场次已删除', 'ok');
        await loadState();
      }, true);
  });

  /* ---------------- 概览 ---------------- */

  function renderOverview() {
    var s = state.data.stats;
    var cfg = state.data.config;
    if (!s) return;

    $('statGrid').innerHTML =
      statCard('样品数量', s.sampleCount, '个') +
      statCard('评价员总数', s.evaluatorCount, '人') +
      statCard('已提交', s.submittedCount, '人') +
      statCard('进行中', s.inProgressCount, '人') +
      statCard('未开始', Math.max(0, s.evaluatorCount - s.submittedCount - s.inProgressCount), '人') +
      statCard('完成率', s.evaluatorCount ? Math.round((s.submittedCount / s.evaluatorCount) * 100) : 0, '%');

    $('pwdWarn').innerHTML = (!cfg.passwordChanged && !cfg.usingEnvPassword)
      ? '<div class="alert alert-warn"><span>⚠️</span><span>当前仍在使用默认管理密码 <b>admin123</b>，请前往「系统设置」立即修改，避免数据被误操作。</span></div>'
      : '';

    var rows = '';
    if (!s.ranked.length) {
      rows = '<tr><td colspan="5" class="empty">暂无已提交的评分数据</td></tr>';
    } else {
      s.ranked.forEach(function (r) {
        var row = s.rows.find(function (x) { return x.code === r.code; });
        rows += '<tr>' +
          '<td class="num ' + (r.rank === 1 ? 'rank-1' : r.rank === 2 ? 'rank-2' : '') + '">' + r.rank + '</td>' +
          '<td class="mono"><b>' + esc(r.code) + '</b>' + (row && row.note ? ' <span class="badge badge-muted">' + esc(row.note) + '</span>' : '') + '</td>' +
          '<td class="num mono" style="font-weight:700;color:var(--accent)">' + ms(r.mean) + '</td>' +
          '<td class="num mono">' + ms(row ? row.total.sd : null) + '</td>' +
          '<td class="num mono">' + (row ? row.n : 0) + '</td>' +
          '</tr>';
      });
    }
    $('rankTable').innerHTML = rows;

    var ob = $('outlierBox');
    if (!s.outliers.length) {
      ob.innerHTML = '<div class="alert alert-ok"><span>✓</span><span>未发现偏离 ±2 倍标准差的异常评分。</span></div>';
    } else {
      var html = '<div class="alert alert-warn"><span>⚠️</span><span>共发现 ' + s.outliers.length + ' 条可能的异常评分，请人工复核：</span></div>';
      html += '<div class="table-wrap"><table><thead><tr>' +
        '<th>样品编号</th><th>评价员编号</th><th>姓名</th><th class="num">该员总分</th>' +
        '<th class="num">全体均值</th><th class="num">标准差</th></tr></thead><tbody>';
      s.outliers.forEach(function (o) {
        html += '<tr><td class="mono"><b>' + esc(o.sample) + '</b></td>' +
          '<td class="mono">' + esc(o.evaluatorCode) + '</td>' +
          '<td>' + esc(o.name || '—') + '</td>' +
          '<td class="num mono">' + o.total + '</td>' +
          '<td class="num mono">' + ms(o.mean) + '</td>' +
          '<td class="num mono">' + ms(o.sd) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      ob.innerHTML = html;
    }
  }

  function statCard(label, value, unit) {
    return '<div class="stat"><div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(value) + (unit ? '<small> ' + esc(unit) + '</small>' : '') + '</div></div>';
  }

  /* ---------------- 统计分析 ---------------- */

  function renderStats() {
    var s = state.data.stats;
    if (!s) return;
    var crits = state.data.config.criteria;

    var head = '<thead><tr><th>样品编号</th><th>备注</th><th class="num">有效样本 n</th>';
    crits.forEach(function (c) { head += '<th class="num">' + esc(c.name) + '<br><span style="font-weight:400;color:var(--muted)">/' + c.max + ' 分</span></th>'; });
    head += '<th class="num">总分<br><span style="font-weight:400;color:var(--muted)">/' + (state.data.config.criteria.reduce(function (a, c) { return a + c.max; }, 0)) + ' 分</span></th><th class="num">排名</th></tr></thead>';

    var rankMap = {};
    s.ranked.forEach(function (r) { rankMap[r.code] = r.rank; });

    var body = '<tbody>';
    if (!s.rows.length) {
      body += '<tr><td colspan="' + (crits.length + 5) + '" class="empty">暂无数据</td></tr>';
    } else {
      s.rows.forEach(function (r) {
        body += '<tr><td class="mono"><b>' + esc(r.code) + '</b></td>';
        body += '<td>' + (r.note ? esc(r.note) : '—') + '</td>';
        body += '<td class="num mono">' + r.n + '</td>';
        crits.forEach(function (c) {
          body += '<td class="num mono">' + ms(r[c.key].mean) + ' <span style="color:var(--muted)">± ' + ms(r[c.key].sd) + '</span></td>';
        });
        body += '<td class="num mono" style="font-weight:700;color:var(--accent)">' + ms(r.total.mean) + ' <span style="color:var(--muted);font-weight:400">± ' + ms(r.total.sd) + '</span></td>';
        body += '<td class="num">' + (rankMap[r.code] || '—') + '</td></tr>';
      });
    }
    body += '</tbody>';
    $('statsTable').innerHTML = head + body;
  }

  /* ---------------- 原始记录 ---------------- */

  function renderRecords() {
    var sess = state.data.session;
    if (!sess) return;
    var crits = state.data.config.criteria;

    var rows = [];
    sess.evaluators.forEach(function (ev) {
      var order = ev.order && ev.order.length ? ev.order : sess.samples.map(function (x) { return x.code; });
      order.forEach(function (code) {
        var sc = ev.scores ? ev.scores[code] : null;
        if (!sc) return;
        var total = crits.reduce(function (a, c) { return a + (Number(sc[c.key]) || 0); }, 0);
        rows.push({ ev: ev, code: code, sc: sc, total: total });
      });
    });

    var f = state.filter.trim().toLowerCase();
    if (f) {
      rows = rows.filter(function (r) {
        return String(r.ev.code).toLowerCase().indexOf(f) >= 0 ||
          String(r.ev.name || '').toLowerCase().indexOf(f) >= 0 ||
          String(r.code).toLowerCase().indexOf(f) >= 0;
      });
    }

    $('recordCount').textContent = '共 ' + rows.length + ' 条记录' + (f ? '（已筛选）' : '');

    var head = '<thead><tr><th>评价员编号</th><th>姓名</th><th>样品编号</th>';
    crits.forEach(function (c) { head += '<th class="num">' + esc(c.name) + '</th>'; });
    head += '<th class="num">总分</th><th>备注</th><th>状态</th><th>更新时间</th></tr></thead>';

    var body = '<tbody>';
    if (!rows.length) {
      body += '<tr><td colspan="' + (crits.length + 7) + '" class="empty">暂无记录</td></tr>';
    } else {
      rows.sort(function (a, b) {
        return String(a.ev.code).localeCompare(String(b.ev.code), 'zh', { numeric: true }) ||
          String(a.code).localeCompare(String(b.code));
      });
      rows.forEach(function (r) {
        body += '<tr><td class="mono"><b>' + esc(r.ev.code) + '</b></td><td>' + esc(r.ev.name || '—') + '</td>' +
          '<td class="mono">' + esc(r.code) + '</td>';
        crits.forEach(function (c) { body += '<td class="num mono">' + esc(r.sc[c.key]) + '</td>'; });
        body += '<td class="num mono" style="font-weight:700">' + r.total + '</td>';
        body += '<td>' + (r.sc.note ? esc(r.sc.note) : '—') + '</td>';
        body += '<td>' + (r.ev.submitted ? '<span class="badge badge-ok">已提交</span>' : '<span class="badge badge-warn">未提交</span>') + '</td>';
        body += '<td style="color:var(--muted);font-size:12.5px">' + when(r.sc.updatedAt) + '</td></tr>';
      });
    }
    body += '</tbody>';
    $('recordTable').innerHTML = head + body;
  }

  $('recordFilter').addEventListener('input', function () {
    state.filter = $('recordFilter').value;
    renderRecords();
  });

  /* ---------------- 样品与评价员 ---------------- */

  function renderPeople() {
    var sess = state.data.session;
    if (!sess) return;
    var editable = sess.isActive;

    var html = '';
    if (!sess.samples.length) {
      html = '<div class="empty">还没有样品，请点击下方按钮添加或随机生成编号</div>';
    } else {
      sess.samples.forEach(function (s, i) {
        html += '<div class="sample-row" data-i="' + i + '">' +
          '<input class="input" data-code value="' + esc(s.code) + '" maxlength="20" placeholder="编号"' + (editable ? '' : ' disabled') + '>' +
          '<input class="input note-input" data-note value="' + esc(s.note || '') + '" maxlength="100" placeholder="备注（选填，如配方 A）"' + (editable ? '' : ' disabled') + '>' +
          '<button class="btn btn-sm btn-ghost" data-del' + (editable ? '' : ' disabled') + '>删除</button>' +
          '</div>';
      });
    }
    $('sampleRows').innerHTML = html;

    $('sampleRows').querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('.sample-row').remove(); });
    });

    $('btnAddSample').disabled = !editable;
    $('btnGenSample').disabled = !editable;
    $('btnSaveSamples').disabled = !editable;

    var evs = sess.evaluators.slice().sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code), 'zh', { numeric: true });
    });
    $('evTotal').textContent = evs.length;
    $('evDone').textContent = evs.filter(function (e) { return e.submitted; }).length;

    var head = '<thead><tr><th>评价员编号</th><th>姓名</th><th>知情同意</th><th class="num">已评样品</th><th>状态</th><th>提交时间</th><th>最后活跃</th><th></th></tr></thead>';
    var body = '<tbody>';
    if (!evs.length) {
      body += '<tr><td colspan="8" class="empty">还没有评价员进入</td></tr>';
    } else {
      evs.forEach(function (e) {
        body += '<tr>' +
          '<td class="mono"><b>' + esc(e.code) + '</b></td>' +
          '<td>' + esc(e.name || '—') + '</td>' +
          '<td>' + (e.consented ? '<span class="badge badge-ok">已签署</span>' : '<span class="badge badge-muted">未签署</span>') + '</td>' +
          '<td class="num mono">' + e.scoredCount + ' / ' + e.totalSamples + '</td>' +
          '<td>' + (e.submitted ? '<span class="badge badge-ok">已提交</span>'
            : (e.scoredCount > 0 ? '<span class="badge badge-warn">进行中</span>' : '<span class="badge badge-muted">未开始</span>')) + '</td>' +
          '<td style="font-size:12.5px;color:var(--muted)">' + when(e.submittedAt) + '</td>' +
          '<td style="font-size:12.5px;color:var(--muted)">' + when(e.lastSeenAt) + '</td>' +
          '<td><button class="btn btn-sm btn-ghost" data-del-ev="' + esc(e.id) + '" style="color:var(--danger)">删除</button></td>' +
          '</tr>';
      });
    }
    body += '</tbody>';
    $('evTable').innerHTML = head + body;

    $('evTable').querySelectorAll('[data-del-ev]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-del-ev');
        confirmModal('删除该评价员？', '该评价员的全部评分记录将被永久删除，此操作不可撤销。', '确认删除', async function () {
          await api('/api/admin/evaluator?id=' + encodeURIComponent(id) + '&sessionId=' + encodeURIComponent(sess.id), { method: 'DELETE' });
          toast('已删除', 'ok');
          await loadState();
        });
      });
    });
  }

  $('btnAddSample').addEventListener('click', function () {
    var div = document.createElement('div');
    div.className = 'sample-row';
    div.innerHTML = '<input class="input" data-code placeholder="编号" maxlength="20">' +
      '<input class="input note-input" data-note placeholder="备注（选填）" maxlength="100">' +
      '<button class="btn btn-sm btn-ghost" data-del>删除</button>';
    div.querySelector('[data-del]').addEventListener('click', function () { div.remove(); });
    $('sampleRows').appendChild(div);
    div.querySelector('[data-code]').focus();
  });

  $('btnGenSample').addEventListener('click', function () {
    var input = prompt('要生成多少个随机三位数编号？（将替换当前样品列表）', '5');
    if (input === null) return;
    var n = parseInt(input, 10);
    if (!n || n < 1 || n > 60) { toast('请输入 1～60 之间的数字', 'err'); return; }
    api('/api/admin/samples/generate', { method: 'POST', body: { count: n, sessionId: state.data.session.id } })
      .then(function () { toast('已生成 ' + n + ' 个随机编号', 'ok'); return loadState(); })
      .catch(function (e) { toast(e.message, 'err'); });
  });

  $('btnSaveSamples').addEventListener('click', async function () {
    var list = [];
    $('sampleRows').querySelectorAll('.sample-row').forEach(function (row) {
      var code = row.querySelector('[data-code]').value.trim();
      var note = row.querySelector('[data-note]').value.trim();
      if (code) list.push({ code: code, note: note });
    });
    if (!list.length) { toast('至少需要一个样品', 'err'); return; }
    try {
      await api('/api/admin/samples', { method: 'POST', body: { samples: list, sessionId: state.data.session.id } });
      toast('样品列表已保存', 'ok');
      await loadState();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  /* ==================== 数据分析 · ANOVA ==================== */

  async function loadAnalysis() {
    var box = $('chartTotal');
    if (box) box.innerHTML = '<div class="loading"><div class="spinner"></div>正在计算方差分析与多重比较…</div>';
    try {
      var data = await api('/api/admin/analysis' + sessionQuery('alpha=' + state.alpha));
      state.analysis = data;
      renderAnalysis();
    } catch (e) {
      if (box) box.innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>';
    }
  }

  function renderAnalysis() {
    var a = state.analysis;
    if (!a) return;

    var warn = '';
    if (a.submittedCount < 2) {
      warn = '<div class="alert alert-warn"><span>⚠️</span><span>当前场次只有 ' + a.submittedCount +
        ' 位评价员提交了评分，样本量过小，方差分析结果仅供参考。建议至少 10 位以上评价员提交后再分析。</span></div>';
    } else if (a.sampleCount < 2) {
      warn = '<div class="alert alert-warn"><span>⚠️</span><span>样品数量少于 2 个，无法进行样品间差异比较。</span></div>';
    }
    $('analysisWarn').innerHTML = warn;

    renderAnalysisCharts();
    renderAnovaTable();
    renderDescTable();
    renderPairTable();
  }

  function chartEmpty(el, msg) {
    el.innerHTML = '<div class="chart-empty">' + esc(msg) + '</div>';
  }

  function renderAnalysisCharts() {
    var a = state.analysis;
    var Ch = window.SensoryCharts;
    var hasData = a.submittedCount > 0 && a.sampleCount > 0;

    // ---- 总分柱状图 ----
    var el1 = $('chartTotal');
    if (!hasData) {
      chartEmpty(el1, '暂无已提交的评分数据');
      state.charts.chartTotal = '';
    } else {
      var letters = {};
      var totalAnova = a.anova.total;
      if (totalAnova) totalAnova.letters.forEach(function (l) { letters[l.code] = l.letter; });
      var svg1 = Ch.barChart({
        title: '',
        categories: a.descriptive.map(function (d) { return d.code; }),
        values: a.descriptive.map(function (d) { return d.metrics.total.mean; }),
        errors: a.descriptive.map(function (d) { return d.metrics.total.sd; }),
        letters: a.descriptive.map(function (d) { return letters[d.code] || ''; }),
        yLabel: '总分',
        unit: '',
        xLabel: '样品编号',
        height: 340
      });
      el1.innerHTML = svg1;
      state.charts.chartTotal = svg1;
    }

    // ---- 雷达图 ----
    var el2 = $('chartRadar');
    if (!hasData) {
      chartEmpty(el2, '暂无数据');
      state.charts.chartRadar = '';
    } else {
      var svg2 = Ch.radarChart({
        axes: a.criteria.map(function (c) { return { label: c.name, max: Number(c.max) }; }),
        series: a.descriptive.map(function (d) {
          return {
            name: d.code,
            values: a.criteria.map(function (c) {
              var m = d.metrics[c.key].mean;
              return m === null ? 0 : m;
            })
          };
        }),
        height: 440
      });
      el2.innerHTML = svg2;
      state.charts.chartRadar = svg2;
    }

    // ---- 各指标得分率 ----
    var el3 = $('chartCriteria');
    if (!hasData) {
      chartEmpty(el3, '暂无数据');
      state.charts.chartCriteria = '';
    } else {
      var svg3 = Ch.groupedBarChart({
        categories: a.criteria.map(function (c) { return c.name; }),
        series: a.descriptive.map(function (d) {
          return {
            name: d.code,
            values: a.criteria.map(function (c) {
              var m = d.metrics[c.key].mean;
              return m === null ? 0 : (m / Number(c.max)) * 100;
            })
          };
        }),
        yMax: 100,
        yLabel: '得分率 (%)',
        unit: '得分率 = 该项均值 ÷ 该项满分 × 100%',
        height: 340
      });
      el3.innerHTML = svg3;
      state.charts.chartCriteria = svg3;
    }
  }

  function pText(p) {
    if (p === null || p === undefined) return '—';
    if (p < 0.0001) return '< 0.0001';
    return p.toFixed(4);
  }

  function renderAnovaTable() {
    var a = state.analysis;
    var head = '<thead><tr><th>指标</th><th>变异来源</th><th class="num">平方和 SS</th><th class="num">自由度 df</th>' +
      '<th class="num">均方 MS</th><th class="num">F 值</th><th class="num">P 值</th><th>显著性</th></tr></thead>';
    var body = '<tbody>';
    var any = false;

    a.metrics.forEach(function (mt) {
      var t = a.anova[mt.key];
      if (!t) return;
      any = true;
      var sig = t.significant
        ? '<span class="sig-yes">差异显著 (P&lt;' + a.alpha + ')</span>'
        : '<span class="sig-no">差异不显著</span>';
      body += '<tr>' +
        '<td rowspan="3"><b>' + esc(mt.name) + '</b><br><span style="color:var(--muted);font-size:12px">满分 ' + mt.max + ' 分</span></td>' +
        '<td>组间（样品间）</td>' +
        '<td class="num mono">' + ms(t.ssBetween) + '</td>' +
        '<td class="num mono">' + t.dfBetween + '</td>' +
        '<td class="num mono">' + ms(t.msBetween) + '</td>' +
        '<td class="num mono" style="font-weight:700">' + ms(t.f) + '</td>' +
        '<td class="num mono" style="font-weight:700">' + pText(t.p) + '</td>' +
        '<td>' + sig + '</td></tr>';
      body += '<tr><td>组内（误差）</td>' +
        '<td class="num mono">' + ms(t.ssWithin) + '</td>' +
        '<td class="num mono">' + t.dfWithin + '</td>' +
        '<td class="num mono">' + ms(t.msWithin) + '</td><td></td><td></td><td></td></tr>';
      body += '<tr><td>总计</td>' +
        '<td class="num mono">' + ms(t.ssTotal) + '</td>' +
        '<td class="num mono">' + t.dfTotal + '</td><td></td><td></td><td></td><td></td></tr>';
    });

    if (!any) body += '<tr><td colspan="8" class="empty">数据不足，无法进行方差分析（需要至少 2 个样品且每个样品有评分数据）</td></tr>';
    body += '</tbody>';
    $('anovaTable').innerHTML = head + body;
  }

  function renderDescTable() {
    var a = state.analysis;
    var head = '<thead><tr><th>样品编号</th><th>备注</th><th>指标</th><th class="num">n</th>' +
      '<th class="num">均值</th><th class="num">标准差 SD</th><th class="num">标准误 SE</th>' +
      '<th class="num">变异系数 CV(%)</th><th class="num">最小</th><th class="num">最大</th><th class="num">中位数</th></tr></thead>';
    var body = '<tbody>';
    if (!a.descriptive.length) {
      body += '<tr><td colspan="11" class="empty">暂无数据</td></tr>';
    } else {
      a.descriptive.forEach(function (d) {
        a.metrics.forEach(function (mt, mi) {
          var s = d.metrics[mt.key];
          body += '<tr>';
          if (mi === 0) {
            body += '<td rowspan="' + a.metrics.length + '" class="mono"><b>' + esc(d.code) + '</b></td>' +
              '<td rowspan="' + a.metrics.length + '">' + (d.note ? esc(d.note) : '—') + '</td>';
          }
          body += '<td>' + esc(mt.name) + (mt.isTotal ? ' <span class="badge badge-muted">满分 ' + mt.max + '</span>' : '') + '</td>' +
            '<td class="num mono">' + s.n + '</td>' +
            '<td class="num mono" style="font-weight:600">' + ms(s.mean) + '</td>' +
            '<td class="num mono">' + ms(s.sd) + '</td>' +
            '<td class="num mono">' + ms(s.se) + '</td>' +
            '<td class="num mono">' + (s.cv === null ? '—' : ms(s.cv)) + '</td>' +
            '<td class="num mono">' + (s.min === null ? '—' : s.min) + '</td>' +
            '<td class="num mono">' + (s.max === null ? '—' : s.max) + '</td>' +
            '<td class="num mono">' + ms(s.median) + '</td></tr>';
        });
      });
    }
    body += '</tbody>';
    $('descTable').innerHTML = head + body;
  }

  function renderPairTable() {
    var a = state.analysis;
    // 主表：各指标 × 各样品 的「均值±标准差 字母」
    var head = '<thead><tr><th>指标</th><th class="num">F 值</th><th class="num">P 值</th>';
    a.descriptive.forEach(function (d) { head += '<th class="num">样品 ' + esc(d.code) + '</th>'; });
    head += '</tr></thead>';

    var body = '<tbody>';
    if (!a.descriptive.length) {
      body += '<tr><td colspan="' + (3 + a.descriptive.length) + '" class="empty">暂无数据</td></tr>';
    } else {
      a.metrics.forEach(function (mt) {
        var t = a.anova[mt.key];
        var letterMap = {};
        if (t) t.letters.forEach(function (l) { letterMap[l.code] = l; });
        body += '<tr><td><b>' + esc(mt.name) + '</b></td>';
        body += '<td class="num mono">' + (t ? ms(t.f) : '—') + '</td>';
        body += '<td class="num mono">' + (t ? pText(t.p) : '—') + '</td>';
        a.descriptive.forEach(function (d) {
          var l = letterMap[d.code];
          if (!l) {
            body += '<td class="num">—</td>';
            return;
          }
          body += '<td class="num mono">' + ms(l.mean) + ' ± ' + ms(l.sd) +
            ' <span class="letter-tag">' + esc(l.letter) + '</span></td>';
        });
        body += '</tr>';
      });
    }
    body += '</tbody>';

    // 附：两两比较明细
    var detail = '<thead><tr><th>指标</th><th>比较组</th><th class="num">均值差</th>' +
      '<th class="num">临界极差 R</th><th>结论</th></tr></thead><tbody>';
    var any = false;
    a.metrics.forEach(function (mt) {
      var t = a.anova[mt.key];
      if (!t) return;
      t.comparisons.forEach(function (c) {
        any = true;
        detail += '<tr><td>' + esc(mt.name) + '</td>' +
          '<td class="mono">' + esc(c.a) + ' vs ' + esc(c.b) + '</td>' +
          '<td class="num mono">' + ms(c.diff) + '</td>' +
          '<td class="num mono">' + ms(c.critical) + '</td>' +
          '<td>' + (c.significant ? '<span class="sig-yes">差异显著</span>' : '<span class="sig-no">差异不显著</span>') + '</td></tr>';
      });
    });
    if (!any) detail += '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    detail += '</tbody>';

    $('pairTable').innerHTML = head + body;
    $('pairDetailTable').innerHTML = detail;
  }

  $('alphaSel').addEventListener('change', function () {
    state.alpha = $('alphaSel').value;
    loadAnalysis();
  });

  $('dlAnalysis').addEventListener('click', function () {
    downloadCSV('/api/admin/export/analysis.csv' + sessionQuery('alpha=' + state.alpha),
      '感官评价分析结果-' + state.data.session.name + '.csv');
  });

  document.querySelectorAll('[data-png]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-png');
      var svg = state.charts[id];
      if (!svg) { toast('图表暂无数据', 'err'); return; }
      window.SensoryCharts.downloadPNG(svg, id + '-' + (state.data ? state.data.session.name : '') + '.png');
    });
  });

  document.querySelectorAll('[data-svg]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-svg');
      var svg = state.charts[id];
      if (!svg) { toast('图表暂无数据', 'err'); return; }
      window.SensoryCharts.downloadSVG(svg, id + '-' + (state.data ? state.data.session.name : '') + '.svg');
    });
  });

  /* ==================== 设置 ==================== */

  function renderSettings() {
    var cfg = state.data.config;
    $('inputNotice').value = cfg.notice || '';
    $('inputCriteria').value = JSON.stringify(cfg.criteria, null, 2);
    $('dataDirDesc').textContent = '数据保存在服务器目录：' + state.data.dataDir + '（拷贝该目录即可完成备份）';
    $('pwdModeDesc').textContent = cfg.usingEnvPassword
      ? '当前管理密码由服务器环境变量 ADMIN_PASSWORD 指定，无法在网页中修改。'
      : (cfg.passwordChanged ? '如需更换密码，请输入当前密码。' : '当前仍是默认密码，建议立即修改。');
    $('btnChangePwd').disabled = !!cfg.usingEnvPassword;
  }

  $('btnSaveBasic').addEventListener('click', async function () {
    try {
      await api('/api/admin/config', { method: 'PUT', body: { notice: $('inputNotice').value } });
      toast('设置已保存', 'ok');
      await loadState();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnChangePwd').addEventListener('click', async function () {
    var o = $('oldPwd').value, n = $('newPwd').value;
    if (n.length < 6) { toast('新密码至少 6 位', 'err'); return; }
    try {
      await api('/api/admin/password', { method: 'POST', body: { oldPassword: o, newPassword: n } });
      $('oldPwd').value = '';
      $('newPwd').value = '';
      toast('密码已修改，请牢记新密码', 'ok');
      await loadState();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnSaveCriteria').addEventListener('click', async function () {
    var parsed;
    try {
      parsed = JSON.parse($('inputCriteria').value);
    } catch (e) {
      toast('JSON 格式有误：' + e.message, 'err');
      return;
    }
    if (!Array.isArray(parsed) || !parsed.length) { toast('评分指标必须是非空数组', 'err'); return; }
    try {
      await api('/api/admin/config', { method: 'PUT', body: { criteria: parsed } });
      toast('评分标准已保存', 'ok');
      await loadState();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnResetCriteria').addEventListener('click', function () {
    confirmModal('恢复默认评分标准？', '将把评分指标恢复为方案中的 5 项标准（形态 20 / 色泽 20 / 滋味与口感 30 / 组织 15 / 整体接受度 15）。已有评分记录不会被删除，但统计口径会按新标准计算。', '确认恢复', async function () {
      try {
        var d = await api('/api/admin/defaults');
        await api('/api/admin/config', { method: 'PUT', body: { criteria: d.criteria } });
        toast('已恢复默认评分标准', 'ok');
        await loadState();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('btnResetScores').addEventListener('click', function () {
    var s = state.data.session;
    confirmModal('清空本场评价数据？', '「' + s.name + '」下所有评价员的评分与知情同意记录将被永久删除，样品列表保留。此操作不可撤销。', '确认清空', async function () {
      await api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET', scope: 'scores', sessionId: s.id } });
      toast('已清空本场评价数据', 'ok');
      await loadState();
    }, true);
  });

  $('btnResetAll').addEventListener('click', function () {
    var s = state.data.session;
    confirmModal('清空本场数据与样品？', '「' + s.name + '」的评价数据与样品列表都会被清空，回到空白场次。此操作不可撤销。', '确认清空', async function () {
      await api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET', scope: 'all', sessionId: s.id } });
      toast('已清空', 'ok');
      await loadState();
    }, true);
  });

  /* ---------------- 导出 ---------------- */

  $('dlRecords').addEventListener('click', function () {
    downloadCSV('/api/admin/export/records.csv' + sessionQuery(), '感官评价原始记录-' + state.data.session.name + '.csv');
  });
  $('dlRecords2').addEventListener('click', function () {
    downloadCSV('/api/admin/export/records.csv' + sessionQuery(), '感官评价原始记录-' + state.data.session.name + '.csv');
  });
  $('dlSummary').addEventListener('click', function () {
    downloadCSV('/api/admin/export/summary.csv' + sessionQuery(), '感官评价统计汇总-' + state.data.session.name + '.csv');
  });
  $('dlAll').addEventListener('click', function () {
    downloadCSV('/api/admin/export/all.csv', '感官评价全部场次原始记录.csv');
  });

  /* ---------------- 弹窗 ---------------- */

  function confirmModal(title, desc, okText, onOk, needType) {
    var root = $('modalRoot');
    var extra = needType
      ? '<label class="field"><span class="field-label">请输入 RESET 以确认</span><input class="input" id="mConfirmInput" placeholder="RESET"></label>'
      : '';
    root.innerHTML =
      '<div class="modal-mask"><div class="modal">' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(desc) + '</p>' + extra +
      '<div class="btn-row" style="justify-content:flex-end">' +
      '<button class="btn" id="mCancel">取消</button>' +
      '<button class="btn btn-danger" id="mOk">' + esc(okText) + '</button>' +
      '</div></div></div>';

    $('mCancel').addEventListener('click', function () { root.innerHTML = ''; });
    $('mOk').addEventListener('click', async function () {
      if (needType) {
        var v = ($('mConfirmInput').value || '').trim();
        if (v !== 'RESET') { toast('请输入 RESET 以确认', 'err'); return; }
      }
      var btn = $('mOk');
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        await onOk();
        root.innerHTML = '';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = okText;
        toast(e.message, 'err');
      }
    });
  }

  /* ---------------- 标签页 ---------------- */

  $('tabs').querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      state.tab = t.getAttribute('data-tab');
      $('tabs').querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('hidden', p.getAttribute('data-panel') !== state.tab);
      });
      if (state.tab === 'analysis') {
        if (state.analysis) renderAnalysis();
        else loadAnalysis();
      }
    });
  });

  $('btnRefresh').addEventListener('click', async function () {
    try {
      await loadState();
      toast('数据已刷新', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    if (!state.token) { showView('login'); return; }
    try {
      await loadState();
      showView('main');
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = '';
      showView('login');
    }
  })();
})();
