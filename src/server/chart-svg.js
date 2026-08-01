/**
 * CHART SVG — Gráficos vectoriales renderizados en el servidor
 *
 * ¿Por qué SVG y no ApexCharts?
 *   El reporte termina en (a) un PDF generado por Chromium headless y (b) el
 *   cuerpo de un email. En ambos contextos un <script> de CDN es frágil:
 *   Puppeteer puede cortar en `networkidle2` antes de que ApexCharts pinte, y
 *   ningún cliente de correo ejecuta JS. El SVG inline se renderiza siempre.
 *
 * Accesibilidad (CVD — daltonismo):
 *   La paleta categórica es Okabe-Ito (diseñada para deuteranopía/protanopía)
 *   con el dorado de marca como primer color. Además ninguna serie depende
 *   solo del color: todas llevan etiqueta de valor y texto en el eje.
 */

// ════════════════════════════════════════════
// PALETA — VTC + Okabe-Ito (CVD-safe)
// ════════════════════════════════════════════
const P = {
  navy: '#1a3a52',
  navyDeep: '#102435',
  gold: '#d4af37',
  goldSoft: '#e6c869',
  text: '#eef2f6',
  muted: '#9db0c2',
  grid: 'rgba(212,175,55,0.18)',
  gridSoft: 'rgba(255,255,255,0.07)',
  // Okabe-Ito + gold. Distinguibles en deuteranopía, protanopía y tritanopía.
  cat: ['#d4af37', '#56B4E9', '#009E73', '#E69F00', '#CC79A7', '#0072B2'],
  good: '#009E73',
  warn: '#E69F00',
  bad: '#D55E00'
};

const FONT = "Inter, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

/** Escapa texto para insertarlo dentro de un nodo SVG/XML. */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Redondea a 2 decimales (mantiene el SVG compacto). */
const r2 = (n) => Math.round(n * 100) / 100;

/** Convierte un ángulo (0 = arriba, sentido horario) a coordenadas cartesianas. */
function polar(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: r2(cx + radius * Math.cos(rad)), y: r2(cy + radius * Math.sin(rad)) };
}

/** Genera un id único por gráfico para que los <defs> no colisionen entre SVGs. */
let uidCounter = 0;
const uid = (prefix) => `${prefix}${++uidCounter}`;

/** Clampa un número al rango [min,max] y descarta no-finitos. */
function clamp(n, min, max, def) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  return Math.min(max, Math.max(min, x));
}

/** Envuelve el SVG con los atributos de accesibilidad correctos. */
function svgWrap(viewBox, title, desc, body) {
  const titleId = uid('t');
  const descId = uid('d');
  return `<svg viewBox="${viewBox}" role="img" aria-labelledby="${titleId} ${descId}" `
    + `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" class="chart-svg">`
    + `<title id="${titleId}">${esc(title)}</title>`
    + `<desc id="${descId}">${esc(desc)}</desc>`
    + body
    + `</svg>`;
}

/** Texto SVG con defaults de marca. */
function txt(x, y, content, opts = {}) {
  const {
    size = 12,
    fill = P.muted,
    anchor = 'start',
    weight = 500,
    letter = 0,
    baseline = 'middle',
    opacity = 1
  } = opts;
  return `<text x="${r2(x)}" y="${r2(y)}" font-family="${FONT}" font-size="${size}" `
    + `fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" `
    + `letter-spacing="${letter}" dominant-baseline="${baseline}"`
    + (opacity !== 1 ? ` opacity="${opacity}"` : '')
    + `>${esc(content)}</text>`;
}

/** Color semáforo (CVD-safe) según score 0-10. */
function scoreColor(score) {
  if (score >= 8.5) return P.good;
  if (score >= 7) return P.gold;
  if (score >= 5) return P.warn;
  return P.bad;
}

// ════════════════════════════════════════════
// 1. RADAR — Perfil de competencias
// ════════════════════════════════════════════
function radarChart(competencias) {
  const items = (competencias || []).filter((c) => c && c.name);
  if (items.length < 3) return emptyChart('Perfil de competencias');

  const W = 780;
  const H = 418;
  const cx = W / 2;
  const cy = 206;
  const R = 134;
  const n = items.length;
  const step = 360 / n;
  const gid = uid('radarGrad');

  let body = `<defs>`
    + `<radialGradient id="${gid}" cx="50%" cy="50%" r="50%">`
    + `<stop offset="0%" stop-color="${P.goldSoft}" stop-opacity="0.42"/>`
    + `<stop offset="100%" stop-color="${P.gold}" stop-opacity="0.12"/>`
    + `</radialGradient></defs>`;

  // Anillos de referencia (2,4,6,8,10) — polígonos, no círculos, para leer la escala
  for (let ring = 2; ring <= 10; ring += 2) {
    const rr = (ring / 10) * R;
    const pts = items
      .map((_, i) => {
        const p = polar(cx, cy, rr, i * step);
        return `${p.x},${p.y}`;
      })
      .join(' ');
    body += `<polygon points="${pts}" fill="none" stroke="${ring === 10 ? P.grid : P.gridSoft}" stroke-width="1"/>`;
    body += txt(cx + 5, cy - rr, String(ring), { size: 9, fill: P.muted, opacity: 0.55 });
  }

  // Ejes
  items.forEach((_, i) => {
    const p = polar(cx, cy, R, i * step);
    body += `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="${P.gridSoft}" stroke-width="1"/>`;
  });

  // Polígono de datos
  const dataPts = items.map((c, i) => {
    const score = clamp(c.score, 0, 10, 0);
    return { ...polar(cx, cy, (score / 10) * R, i * step), score, name: c.name, angle: i * step };
  });

  body += `<polygon points="${dataPts.map((p) => `${p.x},${p.y}`).join(' ')}" `
    + `fill="url(#${gid})" stroke="${P.gold}" stroke-width="2.5" stroke-linejoin="round"/>`;

  // Vértices + etiqueta de valor sobre cada punto (el color no es el único canal)
  dataPts.forEach((p) => {
    body += `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${scoreColor(p.score)}" stroke="${P.navyDeep}" stroke-width="1.5"/>`;
  });

  // Etiquetas de eje
  dataPts.forEach((p) => {
    const lp = polar(cx, cy, R + 32, p.angle);
    let anchor = 'middle';
    if (p.angle > 5 && p.angle < 175) anchor = 'start';
    else if (p.angle > 185 && p.angle < 355) anchor = 'end';
    body += txt(lp.x, lp.y - 7, p.name, { size: 12, fill: P.text, anchor, weight: 600 });
    body += txt(lp.x, lp.y + 9, `${p.score}/10`, { size: 11, fill: scoreColor(p.score), anchor, weight: 700 });
  });

  const desc = items.map((c) => `${c.name}: ${c.score} de 10`).join('. ');
  return svgWrap(`0 0 ${W} ${H}`, 'Perfil de competencias del asesor', desc, body);
}

// ════════════════════════════════════════════
// 2. BARRAS — Ranking de competencias
// ════════════════════════════════════════════
function barChart(competencias) {
  const items = (competencias || [])
    .filter((c) => c && c.name)
    .slice()
    .sort((a, b) => clamp(b.score, 0, 10, 0) - clamp(a.score, 0, 10, 0));

  if (!items.length) return emptyChart('Ranking de competencias');

  const W = 780;
  const rowH = 41;
  const padTop = 32;
  const padBottom = 28;
  const H = padTop + items.length * rowH + padBottom;
  const labelW = 168;
  const barX = labelW + 12;
  const barMax = W - barX - 68;

  let body = '';

  // Escala superior 0..10
  for (let s = 0; s <= 10; s += 2) {
    const x = barX + (s / 10) * barMax;
    body += `<line x1="${r2(x)}" y1="${padTop - 14}" x2="${r2(x)}" y2="${H - padBottom + 4}" `
      + `stroke="${P.gridSoft}" stroke-width="1"/>`;
    body += txt(x, padTop - 22, String(s), { size: 10, fill: P.muted, anchor: 'middle', opacity: 0.7 });
  }

  // Línea de meta VTC (8/10) — referencia explícita, no decorativa
  const metaX = barX + 0.8 * barMax;
  body += `<line x1="${r2(metaX)}" y1="${padTop - 14}" x2="${r2(metaX)}" y2="${H - padBottom + 4}" `
    + `stroke="${P.gold}" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.75"/>`;
  body += txt(metaX, H - padBottom + 18, 'Meta VTC 8.0', { size: 10, fill: P.gold, anchor: 'middle', weight: 600 });

  items.forEach((c, i) => {
    const score = clamp(c.score, 0, 10, 0);
    const y = padTop + i * rowH;
    const barY = y + 10;
    const barH = 20;
    const w = Math.max(3, (score / 10) * barMax);
    const color = scoreColor(score);
    const gid = uid('barGrad');

    body += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">`
      + `<stop offset="0%" stop-color="${color}" stop-opacity="0.55"/>`
      + `<stop offset="100%" stop-color="${color}" stop-opacity="1"/>`
      + `</linearGradient></defs>`;

    body += txt(labelW, barY + barH / 2, c.name, { size: 13, fill: P.text, anchor: 'end', weight: 600 });
    body += `<rect x="${barX}" y="${barY}" width="${r2(barMax)}" height="${barH}" rx="4" fill="rgba(255,255,255,0.045)"/>`;
    body += `<rect x="${barX}" y="${barY}" width="${r2(w)}" height="${barH}" rx="4" fill="url(#${gid})"/>`;
    body += txt(barX + w + 12, barY + barH / 2, `${score}`, { size: 13, fill: color, weight: 700 });
  });

  const desc = items.map((c) => `${c.name}: ${c.score} de 10`).join('. ');
  return svgWrap(`0 0 ${W} ${H}`, 'Ranking de competencias contra la meta VTC de 8.0', desc, body);
}

// ════════════════════════════════════════════
// 3. LÍNEA — Timeline de fases de la sesión
// ════════════════════════════════════════════
function lineChart(labels, values, opts = {}) {
  const L = (labels || []).map(String);
  const V = (values || []).map((v) => clamp(v, 0, 10, 0));
  if (L.length < 2 || V.length < 2) return emptyChart(opts.title || 'Timeline');

  const W = 780;
  const H = 322;
  const padL = 46;
  const padR = 30;
  const padT = 34;
  const padB = 62;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const gid = uid('lineGrad');

  const x = (i) => r2(padL + (i / (L.length - 1)) * plotW);
  const y = (v) => r2(padT + plotH - (v / 10) * plotH);

  let body = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${P.gold}" stop-opacity="0.34"/>`
    + `<stop offset="100%" stop-color="${P.gold}" stop-opacity="0"/>`
    + `</linearGradient></defs>`;

  // Grid horizontal + eje Y
  for (let v = 0; v <= 10; v += 2) {
    body += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="${P.gridSoft}" stroke-width="1"/>`;
    body += txt(padL - 12, y(v), String(v), { size: 10, fill: P.muted, anchor: 'end', opacity: 0.75 });
  }

  // Área bajo la curva
  const areaPts = V.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  body += `<polygon points="${padL},${y(0)} ${areaPts} ${x(L.length - 1)},${y(0)}" fill="url(#${gid})"/>`;

  // Línea
  body += `<polyline points="${areaPts}" fill="none" stroke="${P.gold}" stroke-width="2.5" `
    + `stroke-linejoin="round" stroke-linecap="round"/>`;

  // Puntos + valores + etiquetas de fase
  V.forEach((v, i) => {
    const c = scoreColor(v);
    body += `<circle cx="${x(i)}" cy="${y(v)}" r="5.5" fill="${P.navyDeep}" stroke="${c}" stroke-width="2.5"/>`;
    body += txt(x(i), y(v) - 18, String(v), { size: 12, fill: c, anchor: 'middle', weight: 700 });
    body += txt(x(i), H - padB + 22, L[i] || '', { size: 12, fill: P.text, anchor: 'middle', weight: 600 });
  });

  const desc = L.map((l, i) => `${l}: ${V[i]} de 10`).join('. ');
  return svgWrap(`0 0 ${W} ${H}`, opts.title || 'Evolución por fase de la sesión', desc, body);
}

// ════════════════════════════════════════════
// 4. ÁREA — Curva de engagement de la sesión
// ════════════════════════════════════════════
function areaChart(points, opts = {}) {
  const pts = (points || [])
    .map((p) => ({ x: Number(p.x), y: clamp(p.y, 0, 10, 0) }))
    .filter((p) => Number.isFinite(p.x));

  if (pts.length < 2) return emptyChart(opts.title || 'Curva de engagement');

  const W = 780;
  const H = 306;
  const padL = 46;
  const padR = 30;
  const padT = 30;
  const padB = 54;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const gid = uid('areaGrad');

  const maxX = Math.max(...pts.map((p) => p.x)) || 1;
  const X = (v) => r2(padL + (v / maxX) * plotW);
  const Y = (v) => r2(padT + plotH - (v / 10) * plotH);

  let body = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${P.cat[1]}" stop-opacity="0.45"/>`
    + `<stop offset="100%" stop-color="${P.cat[1]}" stop-opacity="0.02"/>`
    + `</linearGradient></defs>`;

  for (let v = 0; v <= 10; v += 2) {
    body += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="${P.gridSoft}" stroke-width="1"/>`;
    body += txt(padL - 12, Y(v), String(v), { size: 10, fill: P.muted, anchor: 'end', opacity: 0.75 });
  }

  const poly = pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
  body += `<polygon points="${padL},${Y(0)} ${poly} ${X(maxX)},${Y(0)}" fill="url(#${gid})"/>`;
  body += `<polyline points="${poly}" fill="none" stroke="${P.cat[1]}" stroke-width="2.5" stroke-linejoin="round"/>`;

  // Marcamos solo pico y valle: menos ruido, más señal
  const peak = pts.reduce((a, b) => (b.y > a.y ? b : a), pts[0]);
  const low = pts.reduce((a, b) => (b.y < a.y ? b : a), pts[0]);
  [[peak, 'Pico', P.good], [low, 'Valle', P.warn]].forEach(([p, label, color]) => {
    body += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5.5" fill="${P.navyDeep}" stroke="${color}" stroke-width="2.5"/>`;
    body += txt(X(p.x), Y(p.y) - 16, `${label} ${p.y}`, { size: 11, fill: color, anchor: 'middle', weight: 700 });
  });

  // Eje X en minutos. Paso entero para que las marcas queden equidistantes
  // (0,2,4,6,8) y no en 0,1.6,3.2… redondeado a 0,2,3,5,6.
  const step = Math.max(1, Math.ceil(maxX / 5));
  for (let v = 0; v <= maxX; v += step) {
    body += txt(X(v), H - padB + 22, `min ${v}`, { size: 11, fill: P.muted, anchor: 'middle' });
  }

  const desc = `Engagement por minuto. Pico ${peak.y} de 10 en el minuto ${peak.x}. `
    + `Punto más bajo ${low.y} de 10 en el minuto ${low.x}.`;
  return svgWrap(`0 0 ${W} ${H}`, opts.title || 'Curva de engagement de la sesión', desc, body);
}

// ════════════════════════════════════════════
// 5. DONUT — Distribución del habla
// ════════════════════════════════════════════
function donutChart(slices, opts = {}) {
  const data = (slices || [])
    .map((s) => ({ label: String(s.label || ''), value: Math.max(0, Number(s.value) || 0) }))
    .filter((s) => s.value > 0);

  if (!data.length) return emptyChart(opts.title || 'Distribución');

  const total = data.reduce((a, b) => a + b.value, 0);
  const W = 780;
  const H = 296;
  const cx = 196;
  const cy = 148;
  const rOut = 100;
  const rIn = 60;

  let body = '';
  let angle = 0;

  data.forEach((s, i) => {
    const sweep = (s.value / total) * 360;
    const color = P.cat[i % P.cat.length];

    if (data.length === 1 || sweep >= 359.9) {
      body += `<circle cx="${cx}" cy="${cy}" r="${(rOut + rIn) / 2}" fill="none" `
        + `stroke="${color}" stroke-width="${rOut - rIn}"/>`;
    } else {
      const a1 = angle;
      const a2 = angle + sweep;
      const large = sweep > 180 ? 1 : 0;
      const p1 = polar(cx, cy, rOut, a1);
      const p2 = polar(cx, cy, rOut, a2);
      const p3 = polar(cx, cy, rIn, a2);
      const p4 = polar(cx, cy, rIn, a1);
      body += `<path d="M ${p1.x} ${p1.y} A ${rOut} ${rOut} 0 ${large} 1 ${p2.x} ${p2.y} `
        + `L ${p3.x} ${p3.y} A ${rIn} ${rIn} 0 ${large} 0 ${p4.x} ${p4.y} Z" `
        + `fill="${color}" stroke="${P.navyDeep}" stroke-width="2"/>`;
    }

    // Porcentaje dentro del anillo cuando el sector es lo bastante grande
    const pct = Math.round((s.value / total) * 100);
    if (sweep > 26) {
      const mid = polar(cx, cy, (rOut + rIn) / 2, angle + sweep / 2);
      body += txt(mid.x, mid.y, `${pct}%`, { size: 13, fill: '#0d1b26', anchor: 'middle', weight: 800 });
    }
    angle += sweep;
  });

  // Centro
  body += txt(cx, cy - 9, opts.centerLabel || 'HABLA', {
    size: 11, fill: P.muted, anchor: 'middle', weight: 700, letter: 2
  });
  body += txt(cx, cy + 13, opts.centerValue || '100%', {
    size: 22, fill: P.gold, anchor: 'middle', weight: 800
  });

  // Leyenda con valor explícito (no depende del color)
  const legX = 400;
  let legY = cy - (data.length * 34) / 2 + 14;
  data.forEach((s, i) => {
    const color = P.cat[i % P.cat.length];
    const pct = Math.round((s.value / total) * 100);
    body += `<rect x="${legX}" y="${legY - 9}" width="18" height="18" rx="4" fill="${color}"/>`;
    body += txt(legX + 30, legY, s.label, { size: 13, fill: P.text, weight: 600 });
    body += txt(W - 40, legY, `${pct}%`, { size: 13, fill: color, anchor: 'end', weight: 700 });
    legY += 34;
  });

  const desc = data.map((s) => `${s.label}: ${Math.round((s.value / total) * 100)} por ciento`).join('. ');
  return svgWrap(`0 0 ${W} ${H}`, opts.title || 'Distribución del habla', desc, body);
}

// ════════════════════════════════════════════
// 6. BULLET — Brecha contra el estándar VTC
// ════════════════════════════════════════════
function gapChart(competencias, meta = 8) {
  const items = (competencias || []).filter((c) => c && c.name);
  if (!items.length) return emptyChart('Brecha contra el estándar');

  const W = 780;
  const rowH = 46;
  const padT = 36;
  const padB = 30;
  const H = padT + items.length * rowH + padB;
  const labelW = 168;
  const trackX = labelW + 12;
  const trackW = W - trackX - 96;

  let body = txt(trackX, padT - 20, `Estándar VTC = ${meta}/10 · la barra roja marca la brecha a cerrar`, {
    size: 11, fill: P.muted, opacity: 0.85
  });

  items.forEach((c, i) => {
    const score = clamp(c.score, 0, 10, 0);
    const y = padT + i * rowH;
    const barY = y + 12;
    const barH = 18;
    const scoreW = (score / 10) * trackW;
    const metaX = trackX + (meta / 10) * trackW;
    const gap = r2(Math.max(0, meta - score));

    body += txt(labelW, barY + barH / 2, c.name, { size: 13, fill: P.text, anchor: 'end', weight: 600 });
    body += `<rect x="${trackX}" y="${barY}" width="${r2(trackW)}" height="${barH}" rx="4" fill="rgba(255,255,255,0.045)"/>`;

    // Zona de brecha (solo si existe) — patrón diagonal + color, doble canal
    if (gap > 0) {
      body += `<rect x="${r2(trackX + scoreW)}" y="${barY}" width="${r2(metaX - trackX - scoreW)}" `
        + `height="${barH}" rx="4" fill="${P.bad}" opacity="0.3"/>`;
    }

    body += `<rect x="${trackX}" y="${barY}" width="${r2(Math.max(3, scoreW))}" height="${barH}" rx="4" `
      + `fill="${scoreColor(score)}"/>`;

    // Marcador de meta
    body += `<line x1="${r2(metaX)}" y1="${barY - 6}" x2="${r2(metaX)}" y2="${barY + barH + 6}" `
      + `stroke="${P.gold}" stroke-width="2.5"/>`;

    const gapLabel = gap > 0 ? `−${gap}` : 'OK';
    body += txt(W - 34, barY + barH / 2, gapLabel, {
      size: 13, fill: gap > 0 ? P.bad : P.good, anchor: 'end', weight: 700
    });
  });

  const desc = items
    .map((c) => {
      const gap = Math.max(0, meta - clamp(c.score, 0, 10, 0));
      return gap > 0 ? `${c.name} está ${r2(gap)} puntos debajo del estándar` : `${c.name} cumple el estándar`;
    })
    .join('. ');
  return svgWrap(`0 0 ${W} ${H}`, 'Brecha de cada competencia contra el estándar VTC', desc, body);
}

/** Placeholder legible cuando no hay datos suficientes para un gráfico. */
function emptyChart(title) {
  const body = `<rect x="1" y="1" width="778" height="158" rx="10" fill="rgba(255,255,255,0.03)" `
    + `stroke="${P.gridSoft}" stroke-width="1"/>`
    + txt(390, 80, 'Sin datos suficientes para este gráfico', {
      size: 13, fill: P.muted, anchor: 'middle'
    });
  return svgWrap('0 0 780 160', title, 'No hay datos disponibles', body);
}

// ════════════════════════════════════════════
// ORQUESTADOR — construye los 6 gráficos del reporte
// ════════════════════════════════════════════

/**
 * @param {object} data Datos ya mapeados (competencias + charts)
 * @returns {{chart_radar:string, chart_ranking:string, chart_timeline:string,
 *            chart_engagement:string, chart_habla:string, chart_brecha:string}}
 */
function buildReportCharts(data) {
  const d = data || {};
  const competencias = Array.isArray(d.competencias) ? d.competencias : [];
  const charts = d.charts || {};

  const timeline = charts.timeline || {};
  const emotional = charts.emotional || {};
  const speech = charts.speech || {};

  return {
    chart_radar: radarChart(competencias),
    chart_ranking: barChart(competencias),
    chart_timeline: lineChart(timeline.labels, timeline.points, {
      title: 'Desempeño por fase de la sesión'
    }),
    chart_engagement: areaChart(emotional.points, {
      title: 'Curva de engagement minuto a minuto'
    }),
    chart_habla: donutChart(
      [
        { label: `${d.nombre || 'Asesor'} (asesor)`, value: speech.usuario },
        { label: 'Cliente simulado (IA)', value: speech.victor },
        { label: 'Silencios / otros', value: speech.otros }
      ],
      {
        title: 'Distribución del habla en la sesión',
        centerLabel: 'ASESOR',
        centerValue: `${Math.round(
          ((Number(speech.usuario) || 0) /
            Math.max(
              1,
              (Number(speech.usuario) || 0) + (Number(speech.victor) || 0) + (Number(speech.otros) || 0)
            )) * 100
        )}%`
      }
    ),
    chart_brecha: gapChart(competencias, 8)
  };
}

module.exports = {
  buildReportCharts,
  radarChart,
  barChart,
  lineChart,
  areaChart,
  donutChart,
  gapChart,
  PALETTE: P
};