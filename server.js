#!/usr/bin/env node
/**
 * 感官评价线上评分系统 —— 后端服务
 *
 * 设计目标：
 *   1. 零第三方依赖：只用 Node 内置模块，拷到服务器上 `node server.js` 即可运行
 *   2. 数据落盘为 JSON（data/ 目录），随项目一起迁移，无需安装数据库
 *   3. 评价员端 + 管理端 一体化托管
 *   4. 支持多「场次」：可关闭本次评分、新建下一次评分，历史数据保留并可随时导出
 *
 * 启动：
 *   node server.js                     # 默认 0.0.0.0:8200
 *   PORT=8080 node server.js           # 自定义端口
 *   ADMIN_PASSWORD=xxx node server.js  # 用环境变量覆盖管理密码
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const stats = require('./lib/stats');

/* ==================== 全局配置 ==================== */

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = parseInt(process.env.PORT || '8200', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

const MAX_BODY = 1024 * 1024; // 1MB 请求体上限
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天

/* ==================== 基础工具 ==================== */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/** 原子写入，避免断电/并发导致文件损坏 */
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hashPassword(password, salt) {
  return sha256(`${salt}|${password}|sensory-eval`);
}

function nowISO() {
  return new Date().toISOString();
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

/** 三位数随机编码（100~999），不重复 */
function genSampleCodes(count, used) {
  const taken = new Set(used);
  const out = [];
  let guard = 0;
  while (out.length < count && guard < 100000) {
    guard += 1;
    const code = String(Math.floor(Math.random() * 900) + 100);
    if (taken.has(code)) continue;
    taken.add(code);
    out.push(code);
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mean(list) {
  if (!list.length) return null;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

/** 样本标准差（n-1）；n<2 时返回 null */
function stdev(list) {
  if (list.length < 2) return null;
  const m = mean(list);
  const variance = list.reduce((s, v) => s + (v - m) ** 2, 0) / (list.length - 1);
  return Math.sqrt(variance);
}

function round(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ==================== 默认数据（首次运行自动生成） ==================== */

const DEFAULT_CRITERIA = [
  {
    key: 'appearance',
    name: '形态',
    max: 20,
    levels: [
      { min: 16, max: 20, desc: '外形完整，厚薄均匀，不收缩、不变形、不起泡、无破损，无较大凹底' },
      { min: 11, max: 15, desc: '外形基本完整，厚薄略有不均，有少量破损、起泡或凹底' },
      { min: 1, max: 10, desc: '外形不完整，破损较多，厚薄明显不均，收缩变形或有较多较大凹底' },
    ],
  },
  {
    key: 'color',
    name: '色泽',
    max: 20,
    levels: [
      { min: 16, max: 20, desc: '表面与断面色泽均匀，呈浅棕褐色或金黄色，有光泽，无焦糊、无白斑' },
      { min: 11, max: 15, desc: '色泽基本均匀，略有深浅差异，光泽一般，个别部位稍焦或稍白' },
      { min: 1, max: 10, desc: '色泽明显不均匀，有较严重焦糊、白斑或过深过浅现象' },
    ],
  },
  {
    key: 'taste',
    name: '滋味与口感',
    max: 30,
    levels: [
      { min: 25, max: 30, desc: '口感酥松易碎、不黏牙，甜度适中，具有麦糟特有的麦香与谷物烘焙香，风味协调，无异味' },
      { min: 13, max: 24, desc: '口感较酥松，略有硬心或轻微黏牙，风味较平淡或甜味略有失调，香气较淡，无异味' },
      { min: 1, max: 12, desc: '口感紧实发硬或过于绵软，黏牙明显，过甜或过于平淡，有酸败味、焦糊味或其他不良异味' },
    ],
  },
  {
    key: 'texture',
    name: '组织',
    max: 15,
    levels: [
      { min: 12, max: 15, desc: '断面结构呈细密多孔状，气孔均匀，无大孔洞' },
      { min: 6, max: 11, desc: '断面组织较均匀，气孔欠均匀，有少量大孔洞' },
      { min: 1, max: 5, desc: '断面组织粗糙，气孔过大、过少或分布不均，有明显大孔洞或结块' },
    ],
  },
  {
    key: 'overall',
    name: '整体接受度',
    max: 15,
    levels: [
      { min: 12, max: 15, desc: '综合品质好，口感风味协调，愿意购买并推荐' },
      { min: 6, max: 11, desc: '综合品质一般，尚可接受，购买意愿不强' },
      { min: 1, max: 5, desc: '综合品质差，不可接受，无购买意愿' },
    ],
  },
];

const DEFAULT_CONSENT = {
  title: '麦糟无糖酥性饼干感官评价知情同意书',
  intro:
    '尊敬的感官评价员：您好！感谢您参与本次麦糟无糖酥性饼干的感官评价活动。在您开始评价前，请仔细阅读以下内容，确认理解并同意后签字。参与者须为年满18周岁、具有完全民事行为能力的自然人。',
  sections: [
    {
      h: '一、评价目的与流程',
      p: [
        '本次评价旨在对麦糟无糖酥性饼干的外观、香气、滋味、口感及整体接受度进行感官评定，用于学术研究、质量控制、配方优化。',
        '您将品尝编号样品，按随机顺序呈送，采用盲评方式（样品以三位数字编号标识，不标注品牌或配方信息）。',
        '评价过程中请独立打分，请勿与他人讨论。每个样品之间请用温开水漱口，必要时可使用无盐苏打饼干清口，间隔 1～2 min 后再评价下一个样品。',
      ],
    },
    {
      h: '二、样品成分说明',
      p: [
        '配料表：低筋面粉、鸡蛋、玉米油、啤酒麦糟粉、奶粉、食品添加剂（木糖醇、复配膨松剂：碳酸氢钠、磷酸二氢钙、焦磷酸二氢钠）。',
        '致敏原：本品含有麸质的谷物及其制品、蛋类及其制品、乳及乳制品。',
        '特别提示：“无糖”指不添加蔗糖、葡萄糖等糖类，但产品仍含碳水化合物，并非零热量或零升糖，血糖异常或相关基础病患者谨慎食用！',
        '本次评价所用样品尚未送至具备 CMA/CNAS 资质的第三方检测机构进行全项食品安全指标检测。组织方承诺所用原料均符合国家常规采购标准及食品安全基础要求，生产过程遵循基本卫生规范。参与者需充分知悉，未经专业机构检测的样品可能存在未知的微生物、理化指标等潜在安全隐患。您在充分了解上述情况的前提下，自愿参与本次品尝评价。',
      ],
    },
    {
      h: '三、潜在风险与不适告知',
      p: [
        '麸质相关：本品含小麦及麦糟成分，麸质过敏者、乳糜泻患者请勿参与。',
        '糖醇耐受：本品使用糖醇作为甜味剂，部分人群大量摄入可能引起腹胀、腹泻等肠胃不适。评价用量控制在 150 g（以饼干质量计）以内，通常不会引发不适，但如您已知对糖醇不耐受，请主动退出。',
        '其他过敏：如您对配方中任何成分过敏，请勿参与。',
        '身体状况：评价当日如有感冒、口腔溃疡、咽喉炎症、服药期间或身体不适，请主动告知组织者，可改期参与。',
        '评价前准备：评价前 1 小时内请勿吸烟、饮酒或食用辛辣、重口味食物，以免影响感官灵敏度。',
        '组织方承诺履行现场配备基础急救药品的义务，并承诺若因样品本身存在隐蔽质量缺陷导致参与者人身损害，组织方将依法承担相应的医疗及赔偿责任。若参与者故意隐瞒既往过敏史、基础疾病或未按告知要求执行而导致损害发生或扩大的，组织方依法减轻相应的赔偿责任。',
      ],
    },
    {
      h: '四、权利与退出',
      p: [
        '您的参与完全出于自愿，拒绝参与或中途退出不会受到任何不利影响，不影响您的学业、工作、人际关系或任何既得权益。',
        '如评价过程中感到任何不适，请立即停止品尝并告知现场工作人员。',
        '您有权拒绝品尝任一特定样品。',
      ],
    },
    {
      h: '五、数据与隐私',
      p: [
        '您的评分数据将用于包括但不限于产品研发、学术研究等，所有个人身份信息将脱敏处理，仅以编号代替。参与者对其个人信息享有查阅、复制、更正、删除的法定权利及行使路径。',
        '未经您同意，不会将您的个人信息或评价内容用于其他用途。',
        '本研究为纯学术研究，不提供金钱报酬、学分补偿或物质奖励。您的参与完全出于对科学研究的兴趣和自愿支持。',
        '评价原始记录由组织方存档保管，保存期限 5 年。期满后，纸质档案粉碎销毁。',
      ],
    },
    {
      h: '六、保密义务',
      p: [
        '评价过程中所见的产品配方、样品编号对应关系、产品信息均属保密内容。',
        '请勿向无关人员透露本次评价的具体内容、样品特征及评分结果。',
      ],
    },
    {
      h: '七、联系人',
      p: [
        '评价组织 / 流程咨询：李奥娜  19554395296',
        '健康不适 / 数据 / 隐私咨询：刘铭哲  15020702901',
        '因本同意书引起的任何争议，双方应友好协商解决；协商不成的，任何一方均有权向组织方所在地人民法院提起诉讼。',
      ],
    },
  ],
  declarations: [
    '本人已阅读并理解上述全部内容。',
    '本人身体健康，无嗅觉、味觉缺陷及口腔疾病，无相关食物过敏史，适合参与本次评价。',
    '本人自愿参与，同意按上述规则进行评价。',
    '本人同意个人评分数据按上述方式使用。',
    '本人同意参与完全出于对科学研究的兴趣和自愿支持，无金钱报酬、学分补偿或物质奖励。',
  ],
};

function defaultConfig() {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    title: '麦糟无糖酥性饼干感官评价',
    subtitle: '啤酒麦糟酥性饼干感官评价系统',
    notice: '请按随机顺序逐一评价样品，每评完一个样品后用温开水漱口，间隔 1～2 min 再评价下一个样品。',
    criteria: DEFAULT_CRITERIA,
    consent: DEFAULT_CONSENT,
    adminSalt: salt,
    adminHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
    passwordChanged: false,
    activeSessionId: null,
    createdAt: nowISO(),
  };
}

function defaultSamples() {
  return [
    { code: '137', note: '', createdAt: nowISO() },
    { code: '462', note: '', createdAt: nowISO() },
    { code: '805', note: '', createdAt: nowISO() },
  ];
}

function newSession(name, samples) {
  return {
    id: genId('ss'),
    name: name || '第 1 次评价',
    status: 'open',
    createdAt: nowISO(),
    closedAt: null,
    samples: samples || [],
    evaluators: [],
  };
}

/* ==================== 数据层 ==================== */

ensureDir(DATA_DIR);

const FILE_CONFIG = path.join(DATA_DIR, 'config.json');
const FILE_SESSIONS = path.join(DATA_DIR, 'sessions.json');
const FILE_SECRET = path.join(DATA_DIR, 'secret.key');
// 旧版单场次文件（用于自动迁移）
const FILE_LEGACY_SAMPLES = path.join(DATA_DIR, 'samples.json');
const FILE_LEGACY_EVALUATORS = path.join(DATA_DIR, 'evaluators.json');

let config = readJSON(FILE_CONFIG, null);
if (!config || !Array.isArray(config.criteria)) {
  config = defaultConfig();
  writeJSON(FILE_CONFIG, config);
}

let sessions = readJSON(FILE_SESSIONS, null);
if (!Array.isArray(sessions) || !sessions.length) {
  // 尝试从旧版结构迁移
  const legacySamples = readJSON(FILE_LEGACY_SAMPLES, null);
  const legacyEvaluators = readJSON(FILE_LEGACY_EVALUATORS, null);
  const first = newSession('第 1 次评价',
    Array.isArray(legacySamples) && legacySamples.length ? legacySamples : defaultSamples());
  if (Array.isArray(legacyEvaluators)) first.evaluators = legacyEvaluators;
  sessions = [first];
  writeJSON(FILE_SESSIONS, sessions);
}

// 数据结构补齐
sessions.forEach((s) => {
  if (!Array.isArray(s.samples)) s.samples = [];
  if (!Array.isArray(s.evaluators)) s.evaluators = [];
  if (!s.status) s.status = 'open';
  if (!s.name) s.name = '未命名场次';
});

if (!config.activeSessionId || !sessions.find((s) => s.id === config.activeSessionId)) {
  config.activeSessionId = sessions[0].id;
  writeJSON(FILE_CONFIG, config);
}

let SECRET = '';
try {
  SECRET = fs.readFileSync(FILE_SECRET, 'utf8').trim();
} catch (e) {
  SECRET = crypto.randomBytes(32).toString('hex');
}
if (!SECRET) SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(FILE_SECRET, SECRET, 'utf8');

const save = {
  config: () => writeJSON(FILE_CONFIG, config),
  sessions: () => writeJSON(FILE_SESSIONS, sessions),
};

function getSession(id) {
  if (!id) return null;
  return sessions.find((s) => s.id === id) || null;
}

function activeSession() {
  return getSession(config.activeSessionId) || sessions[0];
}

/** 解析要操作的场次：优先用传入的 id，否则用当前场次 */
function resolveSession(id) {
  return getSession(id) || activeSession();
}

function isActiveSession(s) {
  return !!s && s.id === config.activeSessionId;
}

/* ==================== 令牌 ==================== */

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function issueEvaluatorToken(ev, sessionId) {
  return signToken({ t: 'ev', id: ev.id, sid: sessionId, exp: Date.now() + TOKEN_TTL_MS });
}

function issueAdminToken() {
  return signToken({ t: 'ad', exp: Date.now() + TOKEN_TTL_MS });
}

/** 返回 { session, evaluator }，令牌里带了场次，切换场次后旧令牌自然失效 */
function getEvaluatorFromReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload || payload.t !== 'ev') return null;
  const session = getSession(payload.sid);
  if (!session) return null;
  const evaluator = session.evaluators.find((e) => e.id === payload.id);
  if (!evaluator) return null;
  return { session, evaluator };
}

function isAdminReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  return !!(payload && payload.t === 'ad');
}

/* ==================== 业务逻辑 ==================== */

function publicConfig() {
  const s = activeSession();
  return {
    title: config.title,
    subtitle: config.subtitle,
    notice: config.notice,
    criteria: config.criteria,
    consent: config.consent,
    totalScore: config.criteria.reduce((sum, c) => sum + Number(c.max || 0), 0),
    sessionName: s ? s.name : '',
    open: !!s && s.status === 'open',
  };
}

function sampleCodes(session) {
  return session.samples.map((s) => s.code);
}

function publicSamples(session) {
  return session.samples.map((s) => ({ code: s.code, note: s.note || '' }));
}

function findEvaluatorByCode(session, code) {
  const c = String(code || '').trim();
  return session.evaluators.find((e) => String(e.code) === c) || null;
}

function createEvaluator(session, code, name) {
  const ev = {
    id: genId('ev'),
    code: String(code).trim(),
    name: String(name || '').trim(),
    consented: false,
    consentAt: null,
    signature: '',
    createdAt: nowISO(),
    lastSeenAt: nowISO(),
    submitted: false,
    submittedAt: null,
    order: shuffle(sampleCodes(session)),
    scores: {},
  };
  session.evaluators.push(ev);
  return ev;
}

/** 新加入的样品自动补进各评价员的评价顺序中 */
function syncEvaluatorOrders(session) {
  const codes = sampleCodes(session);
  let changed = false;
  session.evaluators.forEach((ev) => {
    if (!Array.isArray(ev.order)) {
      ev.order = shuffle(codes);
      changed = true;
      return;
    }
    const missing = codes.filter((c) => !ev.order.includes(c));
    if (missing.length) {
      ev.order = ev.order.concat(shuffle(missing));
      changed = true;
    }
    const before = ev.order.length;
    ev.order = ev.order.filter((c) => codes.includes(c));
    if (ev.order.length !== before) changed = true;
  });
  return changed;
}

function orderedSamplesFor(session, ev) {
  const map = new Map(session.samples.map((s) => [s.code, s]));
  const list = (ev.order || []).map((c) => map.get(c)).filter(Boolean);
  session.samples.forEach((s) => {
    if (!list.find((x) => x.code === s.code)) list.push(s);
  });
  return list.map((s) => ({ code: s.code, note: s.note || '' }));
}

function validateScores(input) {
  const out = {};
  const errors = [];
  config.criteria.forEach((c) => {
    const raw = input ? input[c.key] : undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      errors.push(`${c.name} 需要填写整数分数`);
      return;
    }
    if (v < 1 || v > Number(c.max)) {
      errors.push(`${c.name} 分数应在 1～${c.max} 之间`);
      return;
    }
    out[c.key] = v;
  });
  return { scores: out, errors };
}

function totalOf(scores) {
  return config.criteria.reduce((s, c) => s + (Number(scores[c.key]) || 0), 0);
}

function evaluatorPublic(ev, session) {
  const total = (ev.order || []).length || (session ? session.samples.length : 0);
  return {
    id: ev.id,
    code: ev.code,
    name: ev.name,
    consented: !!ev.consented,
    signature: ev.signature || '',
    consentAt: ev.consentAt,
    submitted: !!ev.submitted,
    submittedAt: ev.submittedAt,
    scoredCount: Object.keys(ev.scores || {}).length,
    totalSamples: total,
  };
}

function evaluatorSelf(ev, session) {
  const scores = {};
  Object.keys(ev.scores || {}).forEach((code) => {
    const s = ev.scores[code];
    scores[code] = Object.assign({}, s, { total: totalOf(s) });
  });
  return Object.assign(evaluatorPublic(ev, session), { scores });
}

/** 统计：仅纳入已提交的评价员 */
function computeStats(session) {
  const keys = config.criteria.map((c) => c.key);
  const done = session.evaluators.filter((e) => e.submitted);

  const rows = session.samples.map((s) => {
    const bucket = {};
    keys.forEach((k) => {
      bucket[k] = [];
    });
    bucket.total = [];

    done.forEach((ev) => {
      const sc = ev.scores ? ev.scores[s.code] : null;
      if (!sc) return;
      let sum = 0;
      let ok = true;
      keys.forEach((k) => {
        const v = Number(sc[k]);
        if (!Number.isFinite(v)) {
          ok = false;
          return;
        }
        bucket[k].push(v);
        sum += v;
      });
      if (ok) bucket.total.push(sum);
    });

    const row = { code: s.code, note: s.note || '', n: bucket.total.length };
    config.criteria.forEach((c) => {
      row[c.key] = { mean: round(mean(bucket[c.key])), sd: round(stdev(bucket[c.key])) };
    });
    row.total = { mean: round(mean(bucket.total)), sd: round(stdev(bucket.total)) };
    return row;
  });

  const ranked = rows
    .filter((r) => r.total.mean !== null)
    .slice()
    .sort((a, b) => b.total.mean - a.total.mean)
    .map((r, i) => ({ code: r.code, mean: r.total.mean, rank: i + 1 }));

  // 异常值提示：个体总分偏离该样品全体均值 ±2 倍标准差
  const outliers = [];
  session.samples.forEach((s) => {
    const totals = [];
    const pairs = [];
    done.forEach((ev) => {
      const sc = ev.scores ? ev.scores[s.code] : null;
      if (!sc) return;
      const t = totalOf(sc);
      totals.push(t);
      pairs.push({ evaluatorCode: ev.code, name: ev.name, total: t });
    });
    const m = mean(totals);
    const sd = stdev(totals);
    if (m === null || sd === null) return;
    pairs.forEach((p) => {
      if (Math.abs(p.total - m) > 2 * sd) {
        outliers.push({
          sample: s.code,
          evaluatorCode: p.evaluatorCode,
          name: p.name,
          total: p.total,
          mean: round(m),
          sd: round(sd),
        });
      }
    });
  });

  return {
    sessionId: session.id,
    sampleCount: session.samples.length,
    evaluatorCount: session.evaluators.length,
    submittedCount: done.length,
    inProgressCount: session.evaluators.filter((e) => !e.submitted && Object.keys(e.scores || {}).length > 0).length,
    rows,
    ranked,
    outliers,
    criteria: config.criteria,
  };
}

/* ==================== 数据分析（描述统计 + ANOVA + Duncan） ==================== */

const METRIC_TOTAL = { key: 'total', name: '总分' };

function metricsOf() {
  const maxTotal = config.criteria.reduce((a, c) => a + Number(c.max), 0);
  return [Object.assign({}, METRIC_TOTAL, { max: maxTotal, isTotal: true })]
    .concat(config.criteria.map((c) => ({ key: c.key, name: c.name, max: Number(c.max), isTotal: false })));
}

function metricValues(session, sampleCode, metricKey) {
  const out = [];
  session.evaluators.forEach((ev) => {
    if (!ev.submitted) return;
    const sc = ev.scores ? ev.scores[sampleCode] : null;
    if (!sc) return;
    if (metricKey === 'total') {
      out.push(totalOf(sc));
    } else {
      const v = Number(sc[metricKey]);
      if (Number.isFinite(v)) out.push(v);
    }
  });
  return out;
}

/**
 * 生成完整分析结果：描述统计 + 单因素方差分析 + Duncan 多重比较
 * @param {object} session 场次
 * @param {number} alpha   显著性水平
 */
function buildAnalysis(session, alpha) {
  const metrics = metricsOf();
  const submitted = session.evaluators.filter((e) => e.submitted);

  // ---- 描述统计 ----
  const descriptive = session.samples.map((s) => {
    const m = {};
    metrics.forEach((mt) => {
      m[mt.key] = stats.describe(metricValues(session, s.code, mt.key));
    });
    return { code: s.code, note: s.note || '', metrics: m };
  });

  // ---- 方差分析 + Duncan ----
  const anova = {};
  metrics.forEach((mt) => {
    const groups = session.samples.map((s) => ({
      code: s.code,
      values: metricValues(session, s.code, mt.key),
    }));
    const a = stats.oneWayANOVA(groups);
    if (!a) {
      anova[mt.key] = null;
      return;
    }
    const d = stats.duncanTest(a, alpha);
    anova[mt.key] = {
      key: mt.key,
      name: mt.name,
      max: mt.max,
      k: a.k,
      N: a.N,
      grandMean: round(a.grandMean, 4),
      ssBetween: round(a.ssBetween, 4),
      ssWithin: round(a.ssWithin, 4),
      ssTotal: round(a.ssTotal, 4),
      dfBetween: a.dfBetween,
      dfWithin: a.dfWithin,
      dfTotal: a.dfTotal,
      msBetween: round(a.msBetween, 4),
      msWithin: round(a.msWithin, 4),
      f: round(a.f, 4),
      p: a.p,
      significant: a.p < alpha,
      // 各样品均值 + 字母
      letters: d.letters.map((l) => ({
        code: l.code,
        mean: round(l.mean, 3),
        sd: round(l.sd, 3),
        n: l.n,
        letter: l.letter,
      })),
      // 两两比较
      comparisons: d.comparisons.map((c) => ({
        a: c.a,
        b: c.b,
        diff: round(c.diff, 3),
        critical: round(c.R, 3),
        significant: c.significant,
      })),
    };
  });

  return {
    sessionId: session.id,
    sessionName: session.name,
    alpha,
    submittedCount: submitted.length,
    evaluatorCount: session.evaluators.length,
    sampleCount: session.samples.length,
    criteria: config.criteria,
    metrics: metrics.map((m) => ({ key: m.key, name: m.name, max: m.max, isTotal: m.isTotal })),
    descriptive,
    anova,
  };
}

function analysisToCSV(a) {
  const lines = [];
  lines.push([`场次：${a.sessionName}`, `显著性水平 α=${a.alpha}`, `已提交评价员：${a.submittedCount} 人`, `样品数：${a.sampleCount}`]);
  lines.push([]);

  // 描述统计
  lines.push(['一、描述统计']);
  const head1 = ['样品编号', '备注', '指标', '满分', 'n', '均值', '标准差', '标准误', '变异系数CV(%)', '最小值', '最大值', '中位数', '极差'];
  lines.push(head1);
  a.descriptive.forEach((d) => {
    a.metrics.forEach((mt) => {
      const s = d.metrics[mt.key];
      lines.push([d.code, d.note, mt.name, mt.max, s.n, s.mean, s.sd, s.se, s.cv, s.min, s.max, s.median, s.range]);
    });
  });
  lines.push([]);

  // 方差分析表
  lines.push(['二、单因素方差分析表']);
  lines.push(['指标', '变异来源', '平方和SS', '自由度df', '均方MS', 'F值', 'P值', '显著性']);
  a.metrics.forEach((mt) => {
    const t = a.anova[mt.key];
    if (!t) return;
    lines.push([mt.name, '组间（样品间）', t.ssBetween, t.dfBetween, t.msBetween, t.f, t.p, t.significant ? '显著' : '不显著']);
    lines.push(['', '组内（误差）', t.ssWithin, t.dfWithin, t.msWithin, '', '', '']);
    lines.push(['', '总计', t.ssTotal, t.dfTotal, '', '', '', '']);
  });
  lines.push([]);

  // 多重比较
  lines.push(['三、Duncan 新复极差法多重比较（字母不同表示差异显著）']);
  lines.push(['指标', '样品编号', '均值', '标准差', 'n', '显著性字母']);
  a.metrics.forEach((mt) => {
    const t = a.anova[mt.key];
    if (!t) return;
    t.letters.forEach((l) => {
      lines.push([mt.name, l.code, l.mean, l.sd, l.n, l.letter]);
    });
  });

  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${lines.map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}

function sessionSummary(s) {  return {
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.createdAt,
    closedAt: s.closedAt,
    sampleCount: s.samples.length,
    evaluatorCount: s.evaluators.length,
    submittedCount: s.evaluators.filter((e) => e.submitted).length,
    recordCount: s.evaluators.reduce((a, e) => a + Object.keys(e.scores || {}).length, 0),
    isActive: isActiveSession(s),
  };
}

function toCSV(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  rows.forEach((r) => lines.push(r.map(esc).join(',')));
  return `\uFEFF${lines.join('\r\n')}\r\n`; // BOM 便于 Excel 直接打开
}

function sendCSV(res, filename, text) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(text);
}

/* ==================== HTTP 辅助 ==================== */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求数据格式错误'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  if (rel === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const safeRel = path.normalize(rel).replace(/^([/\\])+/, '').replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeRel);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, '403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      sendText(res, 404, '404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ==================== 路由 ==================== */

async function handleAPI(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  /* ---------- 公开接口 ---------- */

  if (pathname === '/api/bootstrap' && method === 'GET') {
    const s = activeSession();
    return sendJSON(res, 200, {
      config: publicConfig(),
      samples: s ? publicSamples(s) : [],
    });
  }

  /* ---------- 评价员端 ---------- */

  if (pathname === '/api/evaluator/login' && method === 'POST') {
    const body = await readBody(req);
    const code = String(body.code || '').trim();
    if (!code) return sendJSON(res, 400, { error: '请填写评价员编号' });
    if (code.length > 40) return sendJSON(res, 400, { error: '编号过长' });

    const session = activeSession();
    if (!session) return sendJSON(res, 400, { error: '尚未创建评价场次，请联系组织者' });

    let ev = findEvaluatorByCode(session, code);
    if (!ev) {
      if (session.status !== 'open') return sendJSON(res, 403, { error: '本次评价暂未开放，请联系组织者' });
      if (!session.samples.length) return sendJSON(res, 400, { error: '尚未设置样品，请联系组织者' });
      ev = createEvaluator(session, code, body.name);
      save.sessions();
    } else {
      if (body.name && !ev.name) ev.name = String(body.name).trim();
      ev.lastSeenAt = nowISO();
      if (syncEvaluatorOrders(session)) save.sessions();
      else save.sessions();
    }

    return sendJSON(res, 200, {
      token: issueEvaluatorToken(ev, session.id),
      evaluator: evaluatorSelf(ev, session),
      samples: orderedSamplesFor(session, ev),
      config: publicConfig(),
    });
  }

  if (pathname === '/api/evaluator/me' && method === 'GET') {
    const ctx = getEvaluatorFromReq(req);
    if (!ctx) return sendJSON(res, 401, { error: '登录已过期，请重新进入' });
    ctx.evaluator.lastSeenAt = nowISO();
    save.sessions();
    return sendJSON(res, 200, {
      evaluator: evaluatorSelf(ctx.evaluator, ctx.session),
      samples: orderedSamplesFor(ctx.session, ctx.evaluator),
      config: publicConfig(),
    });
  }

  if (pathname === '/api/evaluator/consent' && method === 'POST') {
    const ctx = getEvaluatorFromReq(req);
    if (!ctx) return sendJSON(res, 401, { error: '登录已过期，请重新进入' });
    const body = await readBody(req);
    if (body.agreed !== true) return sendJSON(res, 400, { error: '请阅读并勾选同意后再继续' });
    const signature = String(body.signature || '').trim();
    if (!signature) return sendJSON(res, 400, { error: '请填写签名' });
    ctx.evaluator.consented = true;
    ctx.evaluator.consentAt = nowISO();
    ctx.evaluator.signature = signature;
    if (body.name) ctx.evaluator.name = String(body.name).trim();
    save.sessions();
    return sendJSON(res, 200, { ok: true, evaluator: evaluatorSelf(ctx.evaluator, ctx.session) });
  }

  if (pathname === '/api/evaluator/score' && method === 'POST') {
    const ctx = getEvaluatorFromReq(req);
    if (!ctx) return sendJSON(res, 401, { error: '登录已过期，请重新进入' });
    if (ctx.session.status !== 'open') return sendJSON(res, 403, { error: '本次评价已关闭，无法继续评分' });
    if (!ctx.evaluator.consented) return sendJSON(res, 403, { error: '请先签署知情同意书' });
    if (ctx.evaluator.submitted) return sendJSON(res, 403, { error: '您已提交评分，如需修改请联系组织者' });

    const body = await readBody(req);
    const code = String(body.sampleCode || '').trim();
    if (!ctx.session.samples.find((s) => s.code === code)) {
      return sendJSON(res, 400, { error: '样品编号不存在' });
    }
    const { scores, errors } = validateScores(body.scores);
    if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });

    ctx.evaluator.scores[code] = Object.assign({}, scores, {
      note: String(body.note || '').slice(0, 500),
      updatedAt: nowISO(),
    });
    ctx.evaluator.lastSeenAt = nowISO();
    save.sessions();
    return sendJSON(res, 200, { ok: true, evaluator: evaluatorSelf(ctx.evaluator, ctx.session) });
  }

  if (pathname === '/api/evaluator/submit' && method === 'POST') {
    const ctx = getEvaluatorFromReq(req);
    if (!ctx) return sendJSON(res, 401, { error: '登录已过期，请重新进入' });
    if (ctx.session.status !== 'open') return sendJSON(res, 403, { error: '本次评价已关闭，无法提交' });
    if (!ctx.evaluator.consented) return sendJSON(res, 403, { error: '请先签署知情同意书' });
    const missing = orderedSamplesFor(ctx.session, ctx.evaluator)
      .filter((s) => !ctx.evaluator.scores[s.code])
      .map((s) => s.code);
    if (missing.length) {
      return sendJSON(res, 400, { error: `还有样品未评分：${missing.join('、')}` });
    }
    ctx.evaluator.submitted = true;
    ctx.evaluator.submittedAt = nowISO();
    ctx.evaluator.lastSeenAt = nowISO();
    save.sessions();
    return sendJSON(res, 200, { ok: true, evaluator: evaluatorSelf(ctx.evaluator, ctx.session) });
  }

  /* ---------- 管理端 ---------- */

  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    const pwd = String(body.password || '');
    if (ENV_ADMIN_PASSWORD) {
      if (pwd !== ENV_ADMIN_PASSWORD) return sendJSON(res, 401, { error: '密码错误' });
    } else if (hashPassword(pwd, config.adminSalt) !== config.adminHash) {
      return sendJSON(res, 401, { error: '密码错误' });
    }
    return sendJSON(res, 200, {
      token: issueAdminToken(),
      passwordChanged: !!config.passwordChanged,
      usingEnvPassword: !!ENV_ADMIN_PASSWORD,
    });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdminReq(req)) return sendJSON(res, 401, { error: '管理登录已过期，请重新登录' });
  }

  if (pathname === '/api/admin/state' && method === 'GET') {
    const session = resolveSession(query.get('sessionId'));
    return sendJSON(res, 200, {
      config: {
        title: config.title,
        subtitle: config.subtitle,
        notice: config.notice,
        criteria: config.criteria,
        consent: config.consent,
        passwordChanged: !!config.passwordChanged,
        usingEnvPassword: !!ENV_ADMIN_PASSWORD,
      },
      activeSessionId: config.activeSessionId,
      sessions: sessions.map(sessionSummary),
      session: session
        ? {
            id: session.id,
            name: session.name,
            status: session.status,
            createdAt: session.createdAt,
            closedAt: session.closedAt,
            isActive: isActiveSession(session),
            samples: publicSamples(session),
            evaluators: session.evaluators.map((e) =>
              Object.assign(evaluatorSelf(e, session), { lastSeenAt: e.lastSeenAt, order: e.order || [] })
            ),
          }
        : null,
      stats: session ? computeStats(session) : null,
      dataDir: DATA_DIR,
    });
  }

  if (pathname === '/api/admin/defaults' && method === 'GET') {
    return sendJSON(res, 200, { criteria: DEFAULT_CRITERIA, consent: DEFAULT_CONSENT });
  }

  if (pathname === '/api/admin/config' && method === 'PUT') {
    const body = await readBody(req);
    if (typeof body.title === 'string' && body.title.trim()) config.title = body.title.trim().slice(0, 100);
    if (typeof body.subtitle === 'string') config.subtitle = body.subtitle.trim().slice(0, 200);
    if (typeof body.notice === 'string') config.notice = body.notice.slice(0, 1000);
    if (Array.isArray(body.criteria) && body.criteria.length) {
      const ok = body.criteria.every(
        (c) => c && typeof c.key === 'string' && typeof c.name === 'string' && Number(c.max) > 0 && Array.isArray(c.levels)
      );
      if (!ok) return sendJSON(res, 400, { error: '评分指标格式不正确' });
      config.criteria = body.criteria.map((c) => ({
        key: String(c.key),
        name: String(c.name),
        max: Number(c.max),
        levels: c.levels.map((l) => ({
          min: Number(l.min),
          max: Number(l.max),
          desc: String(l.desc || ''),
        })),
      }));
    }
    if (body.consent && typeof body.consent === 'object') {
      config.consent = body.consent;
    }
    save.config();
    return sendJSON(res, 200, { ok: true, config: publicConfig() });
  }

  if (pathname === '/api/admin/password' && method === 'POST') {
    const body = await readBody(req);
    const oldPwd = String(body.oldPassword || '');
    const newPwd = String(body.newPassword || '');
    if (newPwd.length < 6) return sendJSON(res, 400, { error: '新密码至少 6 位' });
    if (ENV_ADMIN_PASSWORD) {
      return sendJSON(res, 400, { error: '当前使用环境变量 ADMIN_PASSWORD 指定密码，请在服务器上修改环境变量' });
    }
    if (hashPassword(oldPwd, config.adminSalt) !== config.adminHash) {
      return sendJSON(res, 400, { error: '原密码错误' });
    }
    const salt = crypto.randomBytes(8).toString('hex');
    config.adminSalt = salt;
    config.adminHash = hashPassword(newPwd, salt);
    config.passwordChanged = true;
    save.config();
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 场次管理 ---- */

  // 新建下一次评分（自动关闭当前场次并切换为新场次）
  if (pathname === '/api/admin/sessions' && method === 'POST') {
    const body = await readBody(req);
    const prev = activeSession();
    const index = sessions.length + 1;
    const name = String(body.name || '').trim().slice(0, 60) ||
      `第 ${index} 次评价（${fmtDate(new Date())}）`;

    let sampleList = [];
    if (body.copySamples && prev && prev.samples.length) {
      sampleList = prev.samples.map((s) => ({ code: s.code, note: s.note || '', createdAt: nowISO() }));
    }

    if (prev && prev.status === 'open') {
      prev.status = 'closed';
      prev.closedAt = nowISO();
    }

    const session = newSession(name, sampleList);
    sessions.push(session);
    config.activeSessionId = session.id;
    save.sessions();
    save.config();

    return sendJSON(res, 200, {
      ok: true,
      session: sessionSummary(session),
      activeSessionId: config.activeSessionId,
    });
  }

  // 重命名场次
  if (pathname === '/api/admin/sessions' && method === 'PUT') {
    const body = await readBody(req);
    const session = getSession(body.id);
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return sendJSON(res, 400, { error: '场次名称不能为空' });
    session.name = name;
    save.sessions();
    return sendJSON(res, 200, { ok: true, session: sessionSummary(session) });
  }

  // 开放 / 关闭场次
  if (pathname === '/api/admin/sessions/status' && method === 'POST') {
    const body = await readBody(req);
    const session = getSession(body.id) || activeSession();
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const status = body.status === 'open' ? 'open' : 'closed';
    session.status = status;
    session.closedAt = status === 'closed' ? nowISO() : null;
    save.sessions();
    return sendJSON(res, 200, { ok: true, session: sessionSummary(session) });
  }

  // 把历史场次设为当前场次（例如误关后重新开放）
  if (pathname === '/api/admin/sessions/activate' && method === 'POST') {
    const body = await readBody(req);
    const session = getSession(body.id);
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    config.activeSessionId = session.id;
    save.config();
    return sendJSON(res, 200, { ok: true, activeSessionId: session.id });
  }

  // 删除场次（不允许删除最后一个场次）
  if (pathname === '/api/admin/sessions' && method === 'DELETE') {
    const id = query.get('id');
    if (sessions.length <= 1) return sendJSON(res, 400, { error: '至少要保留一个场次' });
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: '场次不存在' });
    const wasActive = sessions[idx].id === config.activeSessionId;
    sessions.splice(idx, 1);
    if (wasActive) {
      config.activeSessionId = sessions[0].id;
      save.config();
    }
    save.sessions();
    return sendJSON(res, 200, { ok: true, activeSessionId: config.activeSessionId });
  }

  /* ---- 样品与评价员 ---- */

  if (pathname === '/api/admin/samples' && method === 'POST') {
    const body = await readBody(req);
    const session = resolveSession(body.sessionId);
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const list = Array.isArray(body.samples) ? body.samples : null;
    if (!list) return sendJSON(res, 400, { error: '参数格式不正确' });

    const codes = [];
    for (const item of list) {
      const code = String(item && item.code ? item.code : '').trim();
      if (!code) return sendJSON(res, 400, { error: '样品编号不能为空' });
      if (code.length > 20) return sendJSON(res, 400, { error: `样品编号 ${code} 过长` });
      if (codes.includes(code)) return sendJSON(res, 400, { error: `样品编号 ${code} 重复` });
      codes.push(code);
    }

    session.samples = list.map((item) => ({
      code: String(item.code).trim(),
      note: String(item.note || '').slice(0, 100),
      createdAt: nowISO(),
    }));
    syncEvaluatorOrders(session);
    save.sessions();
    return sendJSON(res, 200, { ok: true, samples: publicSamples(session) });
  }

  if (pathname === '/api/admin/samples/generate' && method === 'POST') {
    const body = await readBody(req);
    const session = resolveSession(body.sessionId);
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 60);
    const codes = genSampleCodes(count, sampleCodes(session));
    session.samples = codes.map((code) => ({ code, note: '', createdAt: nowISO() }));
    syncEvaluatorOrders(session);
    save.sessions();
    return sendJSON(res, 200, { ok: true, samples: publicSamples(session) });
  }

  if (pathname === '/api/admin/evaluator' && method === 'DELETE') {
    const session = resolveSession(query.get('sessionId'));
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const id = query.get('id');
    const idx = session.evaluators.findIndex((e) => e.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: '评价员不存在' });
    session.evaluators.splice(idx, 1);
    save.sessions();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/reset' && method === 'POST') {
    const body = await readBody(req);
    if (String(body.confirm || '') !== 'RESET') {
      return sendJSON(res, 400, { error: '请输入 RESET 以确认操作' });
    }
    const session = resolveSession(body.sessionId);
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    session.evaluators = [];
    if (body.scope === 'all') session.samples = [];
    save.sessions();
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 数据分析 ---- */

  if (pathname === '/api/admin/analysis' && method === 'GET') {
    const session = resolveSession(query.get('sessionId'));
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const alpha = query.get('alpha') === '0.01' ? 0.01 : 0.05;
    return sendJSON(res, 200, buildAnalysis(session, alpha));
  }

  if (pathname === '/api/admin/export/analysis.csv' && method === 'GET') {
    const session = resolveSession(query.get('sessionId'));
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const alpha = query.get('alpha') === '0.01' ? 0.01 : 0.05;
    const a = buildAnalysis(session, alpha);
    return sendCSV(res, `感官评价分析结果-${session.name}.csv`, analysisToCSV(a));
  }

  /* ---- 数据导出 ---- */

  if (pathname === '/api/admin/export/records.csv' && method === 'GET') {
    const session = resolveSession(query.get('sessionId'));
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const keys = config.criteria.map((c) => c.key);
    const headers = ['场次', '评价员编号', '姓名', '样品编号', '样品备注']
      .concat(config.criteria.map((c) => `${c.name}(${c.max}分)`))
      .concat(['总分', '备注', '提交状态', '提交时间', '记录更新时间']);
    const rows = [];
    session.evaluators.forEach((ev) => {
      orderedSamplesFor(session, ev).forEach((s) => {
        const sc = ev.scores ? ev.scores[s.code] : null;
        if (!sc) return;
        rows.push(
          [session.name, ev.code, ev.name, s.code, s.note || '']
            .concat(keys.map((k) => sc[k]))
            .concat([
              totalOf(sc),
              sc.note || '',
              ev.submitted ? '已提交' : '未提交',
              ev.submittedAt || '',
              sc.updatedAt || '',
            ])
        );
      });
    });
    return sendCSV(res, `感官评价原始记录-${session.name}.csv`, toCSV(headers, rows));
  }

  if (pathname === '/api/admin/export/summary.csv' && method === 'GET') {
    const session = resolveSession(query.get('sessionId'));
    if (!session) return sendJSON(res, 404, { error: '场次不存在' });
    const stats = computeStats(session);
    const headers = ['场次', '样品编号', '备注', '有效样本数']
      .concat(config.criteria.map((c) => `${c.name}均值`))
      .concat(config.criteria.map((c) => `${c.name}标准差`))
      .concat(['总分均值', '总分标准差', '排名']);
    const rankMap = new Map(stats.ranked.map((r) => [r.code, r.rank]));
    const rows = stats.rows.map((r) =>
      [session.name, r.code, r.note, r.n]
        .concat(config.criteria.map((c) => r[c.key].mean))
        .concat(config.criteria.map((c) => r[c.key].sd))
        .concat([r.total.mean, r.total.sd, rankMap.get(r.code) || ''])
    );
    return sendCSV(res, `感官评价统计汇总-${session.name}.csv`, toCSV(headers, rows));
  }

  if (pathname === '/api/admin/export/all.csv' && method === 'GET') {
    const keys = config.criteria.map((c) => c.key);
    const headers = ['场次', '评价员编号', '姓名', '样品编号', '样品备注']
      .concat(config.criteria.map((c) => `${c.name}(${c.max}分)`))
      .concat(['总分', '备注', '提交状态', '提交时间']);
    const rows = [];
    sessions.forEach((session) => {
      session.evaluators.forEach((ev) => {
        orderedSamplesFor(session, ev).forEach((s) => {
          const sc = ev.scores ? ev.scores[s.code] : null;
          if (!sc) return;
          rows.push(
            [session.name, ev.code, ev.name, s.code, s.note || '']
              .concat(keys.map((k) => sc[k]))
              .concat([totalOf(sc), sc.note || '', ev.submitted ? '已提交' : '未提交', ev.submittedAt || ''])
          );
        });
      });
    });
    return sendCSV(res, '感官评价全部场次原始记录.csv', toCSV(headers, rows));
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

/* ==================== 服务器 ==================== */

const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    return sendText(res, 400, '400 Bad Request');
  }
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    try {
      await handleAPI(req, res, pathname, parsed.searchParams);
    } catch (err) {
      if (!res.headersSent) {
        sendJSON(res, 500, { error: err && err.message ? err.message : '服务器内部错误' });
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, '405 Method Not Allowed');
  }

  return serveStatic(res, pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise 拒绝]', err);
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    });
  });
  return out;
}

server.listen(PORT, HOST, () => {
  const s = activeSession();
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log(`  ${config.title}`);
  console.log(`  感官评价线上评分系统已启动`);
  console.log(`${line}`);
  console.log(`  本机访问   http://localhost:${PORT}`);
  lanAddresses().forEach((ip) => {
    console.log(`  局域网访问 http://${ip}:${PORT}   ← 评价员用手机/平板打开`);
  });
  console.log(`  管理后台   http://localhost:${PORT}/admin`);
  console.log(`${line}`);
  console.log(`  当前场次   ${s ? s.name : '（无）'}  ·  ${s && s.status === 'open' ? '开放中' : '已关闭'}`);
  console.log(`  场次总数   ${sessions.length}`);
  console.log(`  数据目录   ${DATA_DIR}`);
  if (ENV_ADMIN_PASSWORD) {
    console.log(`  管理密码   由环境变量 ADMIN_PASSWORD 指定`);
  } else if (!config.passwordChanged) {
    console.log(`  管理密码   默认 admin123（请登录后台后立即修改）`);
  }
  console.log(`${line}\n`);
});

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log('\n正在关闭服务，数据已保存...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
});
