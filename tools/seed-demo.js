/**
 * 演示数据生成 / 清理工具
 * ------------------------------------------------------------
 * 用于在正式评价开始前，快速造一批仿真数据，以便预览
 * 「数据分析 · ANOVA」标签页的统计结果与图表效果。
 *
 * 用法（需先启动服务 node server.js）：
 *   node tools/seed-demo.js           # 生成演示数据（会先清空现有数据）
 *   node tools/seed-demo.js --clear   # 仅清空全部场次数据，恢复干净状态
 *
 * 可通过环境变量覆盖：
 *   BASE=http://127.0.0.1:8200   ADMIN_PASSWORD=admin123
 *
 * 注意：本工具会删除服务器上已有的场次数据，请勿在正式评价期间运行。
 */
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8200';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CLEAR_ONLY = process.argv.includes('--clear');

let AT = '';

async function req(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  return { status: res.status, data };
}

// 正态分布噪声（Box-Muller）
function gauss(sd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// 各样品的"真实水平"（模拟：462 最好，137 次之，805 最差）
const EFFECT = {
  137: { appearance: 17, color: 17, taste: 26, texture: 12.5, overall: 12.5 },
  462: { appearance: 19, color: 18.5, taste: 28.5, texture: 14, overall: 14 },
  805: { appearance: 14, color: 15, taste: 22, texture: 9, overall: 9.5 },
};

async function play(code, name) {
  const login = await req('POST', '/api/evaluator/login', { code, name });
  if (login.status !== 200) return;
  const token = login.data.token;
  await req('POST', '/api/evaluator/consent', { agreed: true, signature: name }, token);
  for (const sample of login.data.samples) {
    const e = EFFECT[sample.code] || EFFECT[137];
    const personal = gauss(0.7); // 评价员个人宽严差异
    await req(
      'POST',
      '/api/evaluator/score',
      {
        sampleCode: sample.code,
        note: '',
        scores: {
          appearance: clamp(e.appearance + personal + gauss(1.1), 1, 20),
          color: clamp(e.color + personal + gauss(1.1), 1, 20),
          taste: clamp(e.taste + personal * 1.4 + gauss(1.6), 1, 30),
          texture: clamp(e.texture + personal * 0.7 + gauss(0.9), 1, 15),
          overall: clamp(e.overall + personal * 0.7 + gauss(0.9), 1, 15),
        },
      },
      token
    );
  }
  await req('POST', '/api/evaluator/submit', {}, token);
}

async function main() {
  const login = await req('POST', '/api/admin/login', { password: PASSWORD });
  if (login.status !== 200) {
    console.error('管理端登录失败，请确认服务已启动且密码正确。');
    process.exit(1);
  }
  AT = login.data.token;

  let state = await req('GET', '/api/admin/state', undefined, AT);
  const sessions = state.data.sessions || [];
  if (!sessions.length) {
    console.error('未找到任何场次。');
    process.exit(1);
  }

  // 清空除第一个场次外的所有场次，并重置第一个场次
  for (const s of sessions.slice(1)) {
    await req('DELETE', '/api/admin/sessions?id=' + s.id, undefined, AT);
  }
  const first = sessions[0].id;
  await req('POST', '/api/admin/reset', { confirm: 'RESET', scope: 'all', sessionId: first }, AT);
  await req('POST', '/api/admin/sessions/status', { id: first, status: 'open' }, AT);
  await req('PUT', '/api/admin/sessions', { id: first, name: '第 1 次评价' }, AT);

  if (CLEAR_ONLY) {
    state = await req('GET', '/api/admin/state', undefined, AT);
    console.log('已清空演示数据。当前场次：', state.data.session.name, '（开放中，0 条记录）');
    return;
  }

  // 场次 1：3 个样品 × 20 名评价员
  await req(
    'POST',
    '/api/admin/samples',
    { samples: [{ code: '137', note: '配方 A' }, { code: '462', note: '配方 B' }, { code: '805', note: '配方 C' }] },
    AT
  );
  for (let i = 1; i <= 20; i++) {
    const c = String(i).padStart(2, '0');
    await play(c, '评价员' + c);
  }

  // 场次 2：复制样品编码 × 6 名评价员
  await req('POST', '/api/admin/sessions', { name: '第 2 次评价（响应面验证）', copySamples: true }, AT);
  for (let i = 1; i <= 6; i++) {
    const c = 'B' + String(i).padStart(2, '0');
    await play(c, '二批' + c);
  }

  state = await req('GET', '/api/admin/state', undefined, AT);
  console.log('演示数据已生成，共', state.data.sessions.length, '个场次：');
  state.data.sessions.forEach(s =>
    console.log(`  · ${s.name}  [${s.status}]  ${s.submittedCount}/${s.evaluatorCount} 人已提交`)
  );
  console.log('\n打开管理端 → 「数据分析 · ANOVA」即可查看统计结果与图表。');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
