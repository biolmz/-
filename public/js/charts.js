/* ============================================================
   感官评价 — 纯 SVG 图表库（零依赖，离线可用）
   提供：柱状图（带误差棒 + 显著性字母）、雷达图、分组柱状图
   ============================================================ */

(function (global) {
  'use strict';

  var PALETTE = [
    '#b45309', '#0f766e', '#7c3aed', '#be123c', '#0369a1',
    '#4d7c0f', '#a16207', '#7e22ce', '#0e7490', '#9a3412',
  ];

  var C = {
    text: '#1e1c19',
    text2: '#4a453d',
    muted: '#857e73',
    grid: '#e7e3db',
    axis: '#d8d2c6',
    surface: '#ffffff',
    accent: '#b45309',
  };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(v, d) {
    if (v === null || v === undefined || v === '' || !isFinite(v)) return '—';
    return Number(v).toFixed(d === undefined ? 2 : d);
  }

  /** 生成"好看"的坐标轴上限与刻度 */
  function niceScale(maxValue, ticks) {
    ticks = ticks || 5;
    if (!(maxValue > 0)) return { max: 10, step: 2 };
    var raw = maxValue / ticks;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 2) nice = 2;
    else if (norm <= 2.5) nice = 2.5;
    else if (norm <= 5) nice = 5;
    else nice = 10;
    var step = nice * mag;
    var max = Math.ceil(maxValue / step) * step;
    return { max: max, step: step };
  }

  function svgOpen(w, h, title) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(title || '图表') +
      '" style="width:100%;height:auto;display:block;font-family:inherit" xmlns="http://www.w3.org/2000/svg">';
  }

  function txt(x, y, s, opt) {
    opt = opt || {};
    return '<text x="' + x + '" y="' + y + '"' +
      ' font-size="' + (opt.size || 12) + '"' +
      ' fill="' + (opt.fill || C.text2) + '"' +
      ' font-weight="' + (opt.weight || 400) + '"' +
      (opt.anchor ? ' text-anchor="' + opt.anchor + '"' : '') +
      (opt.baseline ? ' dominant-baseline="' + opt.baseline + '"' : '') +
      (opt.transform ? ' transform="' + opt.transform + '"' : '') +
      (opt.mono ? ' style="font-variant-numeric:tabular-nums"' : '') +
      '>' + esc(s) + '</text>';
  }

  /* ==================== 柱状图（误差棒 + 字母） ==================== */

  /**
   * @param {object} o
   *   categories  类别（样品编号）
   *   values      均值
   *   errors      标准差（可选，画误差棒）
   *   letters     显著性字母（可选）
   *   yLabel      纵轴标题
   *   unit        单位
   *   yMax        纵轴上限（可选，默认自适应）
   *   title       图表标题
   */
  function barChart(o) {
    var cats = o.categories || [];
    var vals = o.values || [];
    var errs = o.errors || [];
    var letters = o.letters || [];
    var unit = o.unit || '';
    var n = cats.length;

    var W = 700;
    var H = o.height || 340;
    var M = { top: 46, right: 22, bottom: 52, left: 58 };
    var pw = W - M.left - M.right;
    var ph = H - M.top - M.bottom;

    var dataMax = 0;
    vals.forEach(function (v, i) {
      var top = (v || 0) + (errs[i] || 0);
      if (top > dataMax) dataMax = top;
    });
    var sc = niceScale(o.yMax || dataMax, 5);
    var yMax = o.yMax || sc.max;
    var yMin = 0;
    var yToPx = function (v) { return M.top + ph - ((v - yMin) / (yMax - yMin)) * ph; };

    var s = svgOpen(W, H, o.title || '柱状图');
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.surface + '"/>';

    if (o.title) s += txt(W / 2, 22, o.title, { size: 14, weight: 650, fill: C.text, anchor: 'middle' });

    // 网格 + Y 轴刻度
    var step = sc.step;
    for (var t = yMin; t <= yMax + 1e-9; t += step) {
      var y = yToPx(t);
      s += '<line x1="' + M.left + '" y1="' + y.toFixed(1) + '" x2="' + (M.left + pw) + '" y2="' + y.toFixed(1) +
        '" stroke="' + (Math.abs(t) < 1e-9 ? C.axis : C.grid) + '" stroke-width="1"' +
        (Math.abs(t) < 1e-9 ? '' : ' stroke-dasharray="3 3"') + '/>';
      s += txt(M.left - 9, y, fmt(t, step < 1 ? 1 : 0), { anchor: 'end', baseline: 'middle', size: 11, fill: C.muted, mono: true });
    }

    // 纵轴标题
    if (o.yLabel) {
      s += txt(16, M.top + ph / 2, o.yLabel, {
        size: 11.5, fill: C.muted, anchor: 'middle',
        transform: 'rotate(-90 16 ' + (M.top + ph / 2) + ')',
      });
    }

    // 柱体
    var slot = pw / Math.max(n, 1);
    var bw = Math.min(slot * 0.5, 74);
    for (var i = 0; i < n; i += 1) {
      var cx = M.left + slot * i + slot / 2;
      var v = vals[i] || 0;
      var yTop = yToPx(v);
      var yBase = yToPx(yMin);
      var h = Math.max(yBase - yTop, 0);
      var color = PALETTE[i % PALETTE.length];

      s += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="4" fill="' + color + '" opacity="0.92"/>';

      // 误差棒
      var e = errs[i];
      var labelY = yTop - 8;
      if (e !== null && e !== undefined && isFinite(e) && e > 0) {
        var yHi = yToPx(Math.min(v + e, yMax));
        var yLo = yToPx(Math.max(v - e, yMin));
        var cap = Math.min(bw * 0.36, 13);
        s += '<line x1="' + cx.toFixed(1) + '" y1="' + yHi.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yLo.toFixed(1) +
          '" stroke="' + C.text + '" stroke-width="1.6"/>';
        s += '<line x1="' + (cx - cap).toFixed(1) + '" y1="' + yHi.toFixed(1) + '" x2="' + (cx + cap).toFixed(1) + '" y2="' + yHi.toFixed(1) +
          '" stroke="' + C.text + '" stroke-width="1.6"/>';
        s += '<line x1="' + (cx - cap).toFixed(1) + '" y1="' + yLo.toFixed(1) + '" x2="' + (cx + cap).toFixed(1) + '" y2="' + yLo.toFixed(1) +
          '" stroke="' + C.text + '" stroke-width="1.6"/>';
        labelY = yHi - 8;
      }

      // 显著性字母
      if (letters[i]) {
        s += txt(cx, labelY, letters[i], { size: 13, weight: 700, fill: C.accent, anchor: 'middle' });
        labelY -= 17;
      }
      // 数值
      s += txt(cx, labelY, fmt(v, 1) + unit, { size: 12.5, weight: 650, fill: C.text, anchor: 'middle', mono: true });

      // 类别标签
      s += txt(cx, M.top + ph + 20, cats[i], { size: 12.5, weight: 600, fill: C.text2, anchor: 'middle', mono: true });
    }

    // 轴线
    s += '<line x1="' + M.left + '" y1="' + (M.top + ph) + '" x2="' + (M.left + pw) + '" y2="' + (M.top + ph) +
      '" stroke="' + C.axis + '" stroke-width="1.2"/>';

    if (o.xLabel) {
      s += txt(M.left + pw / 2, H - 12, o.xLabel, { size: 11.5, fill: C.muted, anchor: 'middle' });
    }

    s += '</svg>';
    return s;
  }

  /* ==================== 分组柱状图 ==================== */

  /**
   * @param {object} o
   *   categories 分组名（各项指标）
   *   series     [{name, values:[...]}]
   *   yMax, yLabel, unit, title
   */
  function groupedBarChart(o) {
    var cats = o.categories || [];
    var series = o.series || [];
    var unit = o.unit || '';
    var n = cats.length;
    var m = series.length;

    var W = 700;
    var H = o.height || 340;
    var M = { top: 58, right: 22, bottom: 54, left: 58 };
    var pw = W - M.left - M.right;
    var ph = H - M.top - M.bottom;

    var dataMax = 0;
    series.forEach(function (se) {
      se.values.forEach(function (v) { if (isFinite(v) && v > dataMax) dataMax = v; });
    });
    var sc = niceScale(o.yMax || dataMax, 5);
    var yMax = o.yMax || sc.max;
    var yToPx = function (v) { return M.top + ph - (v / yMax) * ph; };

    var s = svgOpen(W, H, o.title || '分组柱状图');
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.surface + '"/>';
    if (o.title) s += txt(W / 2, 20, o.title, { size: 14, weight: 650, fill: C.text, anchor: 'middle' });

    // 图例
    var legendY = 40;
    var legendTotal = 0;
    var legendItems = series.map(function (se, i) {
      var w = 16 + 6 + String(se.name).length * 12 + 18;
      var item = { x: legendTotal, w: w, color: PALETTE[i % PALETTE.length], name: se.name };
      legendTotal += w;
      return item;
    });
    var lx = Math.max(M.left, (W - legendTotal) / 2);
    legendItems.forEach(function (it) {
      s += '<rect x="' + lx.toFixed(1) + '" y="' + (legendY - 9) + '" width="14" height="11" rx="2.5" fill="' + it.color + '" opacity="0.92"/>';
      s += txt(lx + 20, legendY, it.name, { size: 12, fill: C.text2, mono: true });
      lx += it.w;
    });

    // 网格
    for (var t = 0; t <= yMax + 1e-9; t += sc.step) {
      var y = yToPx(t);
      s += '<line x1="' + M.left + '" y1="' + y.toFixed(1) + '" x2="' + (M.left + pw) + '" y2="' + y.toFixed(1) +
        '" stroke="' + (t === 0 ? C.axis : C.grid) + '" stroke-width="1"' + (t === 0 ? '' : ' stroke-dasharray="3 3"') + '/>';
      s += txt(M.left - 9, y, fmt(t, sc.step < 1 ? 1 : 0), { anchor: 'end', baseline: 'middle', size: 11, fill: C.muted, mono: true });
    }
    if (o.yLabel) {
      s += txt(16, M.top + ph / 2, o.yLabel, {
        size: 11.5, fill: C.muted, anchor: 'middle',
        transform: 'rotate(-90 16 ' + (M.top + ph / 2) + ')',
      });
    }

    var slot = pw / Math.max(n, 1);
    var groupW = slot * 0.66;
    var bw = Math.max(groupW / Math.max(m, 1) - 3, 5);

    cats.forEach(function (cat, ci) {
      var gx = M.left + slot * ci + (slot - groupW) / 2;
      series.forEach(function (se, si) {
        var v = se.values[ci];
        if (!isFinite(v)) return;
        var x = gx + si * (groupW / m) + (groupW / m - bw) / 2;
        var yTop = yToPx(v);
        s += '<rect x="' + x.toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(M.top + ph - yTop, 0).toFixed(1) + '" rx="3" fill="' +
          PALETTE[si % PALETTE.length] + '" opacity="0.9"/>';
      });
      s += txt(M.left + slot * ci + slot / 2, M.top + ph + 20, cat, { size: 12, weight: 600, fill: C.text2, anchor: 'middle' });
    });

    s += '<line x1="' + M.left + '" y1="' + (M.top + ph) + '" x2="' + (M.left + pw) + '" y2="' + (M.top + ph) +
      '" stroke="' + C.axis + '" stroke-width="1.2"/>';
    if (unit) {
      s += txt(W - M.right, M.top + ph + 40, unit, { size: 11, fill: C.muted, anchor: 'end' });
    }

    s += '</svg>';
    return s;
  }

  /* ==================== 雷达图 ==================== */

  /**
   * @param {object} o
   *   axes   [{label, max}]
   *   series [{name, values:[...]}]
   *   title, size
   */
  function radarChart(o) {
    var axes = o.axes || [];
    var series = o.series || [];
    var n = axes.length;
    if (n < 3) return '';

    var W = 700;
    var H = o.height || 440;
    var size = Math.min(H - 130, 310);
    var cx = W / 2;
    var cy = 58 + size / 2;
    var R = size / 2;

    var s = svgOpen(W, H, o.title || '雷达图');
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.surface + '"/>';
    if (o.title) s += txt(W / 2, 22, o.title, { size: 14, weight: 650, fill: C.text, anchor: 'middle' });

    function pt(i, r) {
      var ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
    }

    // 网格环
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var pts = [];
      for (var i = 0; i < n; i += 1) {
        var p = pt(i, R * f);
        pts.push(p[0].toFixed(1) + ',' + p[1].toFixed(1));
      }
      s += '<polygon points="' + pts.join(' ') + '" fill="none" stroke="' + C.grid + '" stroke-width="1"/>';
    });

    // 轴线 + 轴标签
    for (var i = 0; i < n; i += 1) {
      var pe = pt(i, R);
      s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + pe[0].toFixed(1) + '" y2="' + pe[1].toFixed(1) +
        '" stroke="' + C.grid + '" stroke-width="1"/>';

      var lp = pt(i, R + 26);
      var cos = Math.cos(-Math.PI / 2 + (2 * Math.PI * i) / n);
      var anchor = Math.abs(cos) < 0.2 ? 'middle' : (cos > 0 ? 'start' : 'end');
      s += txt(lp[0], lp[1], axes[i].label, { size: 12.5, weight: 600, fill: C.text2, anchor: anchor, baseline: 'middle' });
      // 满分标注
      var lp2 = pt(i, R + 26);
      s += txt(lp2[0], lp2[1] + 15, axes[i].max + ' 分', { size: 10.5, fill: C.muted, anchor: anchor, baseline: 'middle' });
    }

    // 各系列
    series.forEach(function (se, si) {
      var color = PALETTE[si % PALETTE.length];
      var pts = [];
      for (var i = 0; i < n; i += 1) {
        var v = Number(se.values[i]);
        var ratio = isFinite(v) ? Math.max(0, Math.min(1, v / axes[i].max)) : 0;
        var p = pt(i, R * ratio);
        pts.push(p[0].toFixed(1) + ',' + p[1].toFixed(1));
      }
      s += '<polygon points="' + pts.join(' ') + '" fill="' + color + '" fill-opacity="0.13" stroke="' + color +
        '" stroke-width="2" stroke-linejoin="round"/>';
      pts.forEach(function (p) {
        var xy = p.split(',');
        s += '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3.4" fill="' + color + '" stroke="#fff" stroke-width="1.4"/>';
      });
    });

    // 图例
    var legendY = H - 20;
    var legendTotal = 0;
    var items = series.map(function (se, i) {
      var w = 16 + 6 + String(se.name).length * 12 + 20;
      var it = { x: legendTotal, w: w, color: PALETTE[i % PALETTE.length], name: se.name };
      legendTotal += w;
      return it;
    });
    var lx = Math.max(12, (W - legendTotal) / 2);
    items.forEach(function (it) {
      s += '<line x1="' + lx.toFixed(1) + '" y1="' + (legendY - 4) + '" x2="' + (lx + 16).toFixed(1) + '" y2="' + (legendY - 4) +
        '" stroke="' + it.color + '" stroke-width="2.6"/>';
      s += '<circle cx="' + (lx + 8).toFixed(1) + '" cy="' + (legendY - 4) + '" r="3.2" fill="' + it.color + '"/>';
      s += txt(lx + 22, legendY, it.name, { size: 12, fill: C.text2, mono: true });
      lx += it.w;
    });

    s += '</svg>';
    return s;
  }

  /* ==================== 导出图片 ==================== */

  function downloadSVG(svgString, filename) {
    var blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svgString], { type: 'image/svg+xml;charset=utf-8' });
    triggerDownload(URL.createObjectURL(blob), filename, true);
  }

  function downloadPNG(svgString, filename, scale) {
    scale = scale || 2;
    var m = svgString.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    var w = m ? parseFloat(m[1]) : 700;
    var h = m ? parseFloat(m[2]) : 400;
    var blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      triggerDownload(canvas.toDataURL('image/png'), filename, false);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function triggerDownload(href, filename, revoke) {
    var a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 3000);
  }

  global.SensoryCharts = {
    PALETTE: PALETTE,
    barChart: barChart,
    groupedBarChart: groupedBarChart,
    radarChart: radarChart,
    downloadSVG: downloadSVG,
    downloadPNG: downloadPNG,
    fmt: fmt,
    niceScale: niceScale,
  };
})(window);
