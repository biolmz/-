'use strict';
/**
 * 数理统计模块（零依赖）
 *   - 特殊函数：logΓ、正则化不完全 Γ、不完全 β、标准正态分布
 *   - 分布：χ²、F、学生化极差（studentized range）
 *   - 单因素方差分析（One-way ANOVA）
 *   - Duncan 新复极差法（DMRT）多重比较 + 字母标记
 */

/* ==================== 特殊函数 ==================== */

/** log Γ(x)，Lanczos 近似（g=7, n=9） */
function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  let z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-14;
const FPMIN = 1e-300;
const ITMAX = 400;

/** 正则化不完全 Γ 函数 P(a, x) = γ(a,x)/Γ(a) */
function gammaincP(a, x) {
  if (!(a > 0) || x < 0) return NaN;
  if (x === 0) return 0;
  const gln = logGamma(a);
  if (x < a + 1) {
    // 级数展开
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= ITMAX; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // 连分式展开求 Q(a,x)，再取 1-Q
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** 不完全 β 连分式 */
function betacf(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全 β 函数 I_x(a,b) */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/* ==================== 概率分布 ==================== */

const SQRT2PI = Math.sqrt(2 * Math.PI);

function normalPDF(z) {
  return Math.exp(-0.5 * z * z) / SQRT2PI;
}

/** 标准正态累积分布 Φ(z) */
function normalCDF(z) {
  if (z === 0) return 0.5;
  const t = gammaincP(0.5, (z * z) / 2);
  return z > 0 ? 0.5 * (1 + t) : 0.5 * (1 - t);
}

/** χ² 分布 CDF */
function chi2CDF(x, df) {
  return gammaincP(df / 2, x / 2);
}

/** F 分布上尾概率 P(F > f) */
function fSurvival(f, df1, df2) {
  if (!(f > 0)) return 1;
  if (!Number.isFinite(f)) return 0;
  return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}

/* ---------- 学生化极差分布 Q(k, ν) ---------- */

// P(W ≤ w)：k 个独立标准正态的极差分布，按 w 打表后线性插值
const rangeGridCache = new Map();

function buildRangeGrid(k, wMax) {
  const cached = rangeGridCache.get(k);
  if (cached && cached.wMax >= wMax) return cached;

  const STEP = 0.025;
  const N = Math.ceil(wMax / STEP);
  const NX = 300;              // 内层 Simpson 区间数
  const X0 = -8;
  const X1 = 8;
  const hx = (X1 - X0) / NX;

  const phiX = new Float64Array(NX + 1);
  const cdfX = new Float64Array(NX + 1);
  for (let i = 0; i <= NX; i += 1) {
    const x = X0 + i * hx;
    phiX[i] = normalPDF(x);
    cdfX[i] = normalCDF(x);
  }

  const ws = new Float64Array(N + 1);
  const cdfs = new Float64Array(N + 1);
  for (let j = 0; j <= N; j += 1) {
    const w = j * STEP;
    ws[j] = w;
    let s = 0;
    for (let i = 0; i <= NX; i += 1) {
      const d = normalCDF(X0 + i * hx + w) - cdfX[i];
      let v = phiX[i];
      if (d > 0) v *= Math.pow(d, k - 1);
      else v = 0;
      s += (i === 0 || i === NX) ? v : (i % 2 === 0 ? 2 * v : 4 * v);
    }
    const p = (k * s * hx) / 3;
    cdfs[j] = p > 1 ? 1 : p < 0 ? 0 : p;
  }

  const grid = { ws, cdfs, step: STEP, wMax };
  rangeGridCache.set(k, grid);
  return grid;
}

/** k 个标准正态的极差 W ≤ w 的概率 */
function rangeCDF(k, w, wMax) {
  if (w <= 0) return 0;
  const g = buildRangeGrid(k, wMax);
  if (w >= g.wMax) return 1;
  const idx = w / g.step;
  const i0 = Math.floor(idx);
  const frac = idx - i0;
  return g.cdfs[i0] + (g.cdfs[i0 + 1] - g.cdfs[i0]) * frac;
}

/**
 * 学生化极差 Q 的 CDF：P(Q ≤ q)
 *   P(Q ≤ q) = ∫ f_S(s) · P(W ≤ q·s) ds ，S = √(χ²_ν/ν)
 * 用 z = (s-1)·√(2ν) 作变量替换，使被积函数在任意 ν 下都被充分采样
 * （直接对 s 积分时，ν 很大时 S 的峰宽仅 ~1/√(2ν)，会漏掉峰）
 */
function studentizedRangeCDF(q, k, df) {
  if (!(q > 0)) return 0;
  if (k < 2) return 1;
  const nu = df;
  const invS = Math.sqrt(2 * nu);
  const scale = 1 / invS;
  const Z0 = -9;
  const Z1 = 14;
  const N = 800;
  const h = (Z1 - Z0) / N;
  const halfNu = nu / 2;
  const gln = logGamma(halfNu);
  const constTerm = -halfNu * Math.LN2 - gln;
  const wMax = q * (1 + Z1 * scale);

  let sum = 0;
  for (let i = 0; i <= N; i += 1) {
    const z = Z0 + i * h;
    const s = 1 + z * scale;
    let v = 0;
    if (s > 0) {
      const u = nu * s * s;
      const logf = (halfNu - 1) * Math.log(u) - u / 2 + constTerm;
      const fS = Math.exp(logf) * 2 * nu * s;
      v = fS * scale * rangeCDF(k, q * s, wMax);
    }
    sum += (i === 0 || i === N) ? v : (i % 2 === 0 ? 2 * v : 4 * v);
  }
  const p = (sum * h) / 3;
  return p > 1 ? 1 : p < 0 ? 0 : p;
}

/** 学生化极差分位数 q_{1-α}(k, df)，二分法求解 */
function studentizedRangeQuantile(alpha, k, df) {
  if (k < 2) return 0;
  if (df < 1) df = 1;
  const target = 1 - alpha;
  let lo = 0;
  let hi = 1;
  while (studentizedRangeCDF(hi, k, df) < target && hi < 200) hi *= 1.6;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (studentizedRangeCDF(mid, k, df) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ==================== 描述统计 ==================== */

function mean(v) {
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function sd(v) {
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

function median(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function describe(v) {
  const n = v.length;
  if (!n) return { n: 0, mean: null, sd: null, se: null, cv: null, min: null, max: null, median: null, range: null };
  const m = mean(v);
  const s = sd(v);
  return {
    n,
    mean: m,
    sd: s,
    se: s === null ? null : s / Math.sqrt(n),
    cv: (s === null || m === 0) ? null : (s / Math.abs(m)) * 100,
    min: Math.min.apply(null, v),
    max: Math.max.apply(null, v),
    median: median(v),
    range: Math.max.apply(null, v) - Math.min.apply(null, v),
  };
}

/* ==================== 单因素方差分析 ==================== */

/**
 * @param {Array<{code:string, values:number[]}>} groups
 * @returns 方差分析表 + 各组均值
 */
function oneWayANOVA(groups) {
  const gs = groups.filter((g) => g.values && g.values.length > 0);
  const k = gs.length;
  const N = gs.reduce((a, g) => a + g.values.length, 0);
  if (k < 2 || N <= k) return null;

  const all = [];
  gs.forEach((g) => g.values.forEach((v) => all.push(v)));
  const grand = mean(all);

  let ssBetween = 0;
  let ssWithin = 0;
  const stats = gs.map((g) => {
    const n = g.values.length;
    const m = mean(g.values);
    ssBetween += n * (m - grand) ** 2;
    g.values.forEach((v) => { ssWithin += (v - m) ** 2; });
    return { code: g.code, n, mean: m, sd: sd(g.values) };
  });

  const ssTotal = ssBetween + ssWithin;
  const dfB = k - 1;
  const dfW = N - k;
  const msB = ssBetween / dfB;
  const msW = ssWithin / dfW;
  const f = msW > 0 ? msB / msW : Infinity;
  const p = fSurvival(f, dfB, dfW);

  return {
    k, N, grandMean: grand,
    ssBetween, ssWithin, ssTotal,
    dfBetween: dfB, dfWithin: dfW, dfTotal: N - 1,
    msBetween: msB, msWithin: msW,
    f, p,
    groups: stats,
  };
}

/* ==================== Duncan 新复极差法 ==================== */

/**
 * Duncan 多重比较 + 字母标记
 * 临界值 r_p = q_{1-α_p}(p, dfWithin)，其中 α_p = 1-(1-α)^(p-1)
 * 最小显著极差 R_p = r_p · √( MS_within / 2 · (1/n_i + 1/n_j) )
 *
 * @param {object} anova  oneWayANOVA 的返回值
 * @param {number} alpha  显著性水平（0.05 / 0.01）
 */
function duncanTest(anova, alpha) {
  if (!anova) return null;
  const groups = anova.groups.slice().sort((a, b) => b.mean - a.mean);
  const k = groups.length;
  if (k < 2) {
    return { alpha, criticalValues: [], comparisons: [], letters: groups.map((g) => ({ code: g.code, mean: g.mean, n: g.n, letter: 'a' })) };
  }

  const msW = anova.msWithin;
  const dfW = anova.dfWithin;

  // 各 p 对应的临界值
  const crit = {};
  for (let p = 2; p <= k; p += 1) {
    const aP = 1 - Math.pow(1 - alpha, p - 1);
    crit[p] = studentizedRangeQuantile(aP, p, dfW);
  }

  // 两两比较
  const sig = [];
  for (let i = 0; i < k; i += 1) sig[i] = [];
  const comparisons = [];
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const p = j - i + 1;
      const se = Math.sqrt((msW / 2) * (1 / groups[i].n + 1 / groups[j].n));
      const R = crit[p] * se;
      const diff = Math.abs(groups[i].mean - groups[j].mean);
      const isSig = diff >= R;
      sig[i][j] = isSig;
      comparisons.push({
        a: groups[i].code, b: groups[j].code,
        diff, R, q: se > 0 ? diff / se : 0,
        significant: isSig,
      });
    }
  }

  // 连续区段：从每个起点向后扩展，要求区段内两两均不显著
  const columns = [];
  let i = 0;
  while (i < k) {
    let j = i;
    let t = i + 1;
    while (t < k) {
      let ok = true;
      for (let a = i; a < t; a += 1) {
        if (sig[a][t]) { ok = false; break; }
      }
      if (!ok) break;
      j = t;
      t += 1;
    }
    columns.push([i, j]);
    i = j === i ? i + 1 : j;
  }

  // 去掉被其它列完全包含的列（区段是连续的，用区间包含判断即可）
  let kept = columns.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let x = 0; x < kept.length; x += 1) {
      for (let y = 0; y < kept.length; y += 1) {
        if (x === y) continue;
        if (kept[x][0] >= kept[y][0] && kept[x][1] <= kept[y][1]) {
          if (kept[x][0] === kept[y][0] && kept[x][1] === kept[y][1]) {
            if (x > y) { kept.splice(x, 1); changed = true; }
            break;
          }
          kept.splice(x, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  kept.sort((a, b) => a[0] - b[0]);

  const letters = groups.map(() => '');
  kept.forEach((col, ci) => {
    const ch = String.fromCharCode(97 + (ci % 26));
    for (let t = col[0]; t <= col[1]; t += 1) letters[t] += ch;
  });

  return {
    alpha,
    criticalValues: Object.keys(crit).map((p) => ({ p: Number(p), r: crit[p] })),
    comparisons,
    letters: groups.map((g, idx) => ({
      code: g.code, mean: g.mean, n: g.n, sd: g.sd, letter: letters[idx] || 'a',
    })),
  };
}

module.exports = {
  logGamma, gammaincP, betai,
  normalPDF, normalCDF, chi2CDF, fSurvival,
  studentizedRangeCDF, studentizedRangeQuantile,
  mean, sd, median, describe,
  oneWayANOVA, duncanTest,
};
