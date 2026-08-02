/**
 * EMAIL SENDER — Envía los reportes de capacitación con Resend
 *
 * Responsabilidades:
 * - Formatear fecha/hora en America/Cancun (UTC-5, sin horario de verano)
 * - Construir el asunto y el cuerpo del correo
 * - Nombrar los adjuntos (PDF + MP3) con la misma base: Nombre_dd_mm_aaaa_hh_mm_am
 * - Enviar con reintentos y backoff exponencial
 *
 * Nota de diseño: el cuerpo del correo NO es el reporte completo. El reporte
 * viaja como PDF adjunto; el correo es el resumen ejecutivo que se lee en el
 * teléfono en 20 segundos.
 */

const { Resend } = require('resend');

const TZ = 'America/Cancun';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

// ════════════════════════════════════════════════════════════
// FORMATO DE FECHA Y HORA
// ════════════════════════════════════════════════════════════

/**
 * Descompone una fecha en sus partes según el huso de Cancún.
 *
 * Se usa `Intl` con locale en-US a propósito: el dayPeriod de es-MX varía
 * entre versiones de ICU ("a.m.", "a. m." con espacio fino, "AM"), y aquí
 * necesitamos una salida estable para nombres de archivo.
 *
 * @param {Date|string|number} input
 * @returns {{year:string, month:string, day:string, hour:string, minute:string, ampm:string}}
 */
function cancunParts(input) {
  const date = toDate(input);

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;

    // hour12 + 2-digit devuelve "12" para medianoche/mediodía; nunca "00".
    return {
      year: p.year,
      month: p.month,
      day: p.day,
      hour: String(p.hour).padStart(2, '0'),
      minute: p.minute,
      ampm: String(p.dayPeriod || '').toUpperCase() === 'PM' ? 'p.m.' : 'a.m.'
    };
  } catch (error) {
    // Fallback sin Intl/tzdata: Cancún es UTC-5 fijo desde 2015 (sin DST)
    console.warn('[EMAIL] Intl con timeZone no disponible, usando offset fijo UTC-5:', error.message);
    const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    const h24 = shifted.getUTCHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return {
      year: String(shifted.getUTCFullYear()),
      month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
      day: String(shifted.getUTCDate()).padStart(2, '0'),
      hour: String(h12).padStart(2, '0'),
      minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
      ampm: h24 >= 12 ? 'p.m.' : 'a.m.'
    };
  }
}

/** Normaliza cualquier entrada a Date válida (fallback: ahora). */
function toDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (input === null || input === undefined || input === '') return new Date();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Hora en America/Cancun, formato 12 horas.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "06:26 a.m."
 */
function formatTimezoneCancun(input) {
  const p = cancunParts(input);
  return `${p.hour}:${p.minute} ${p.ampm}`;
}

/**
 * Fecha local (Cancún) en formato dd/mm/aaaa.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "01/08/2026"
 */
function formatDateLocal(input) {
  const p = cancunParts(input);
  return `${p.day}/${p.month}/${p.year}`;
}

/**
 * Fecha larga en español, para leerse dentro de una frase.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "1 de agosto de 2026"
 */
function formatDateLong(input) {
  const p = cancunParts(input);
  const mes = MESES[Number(p.month) - 1] || p.month;
  return `${Number(p.day)} de ${mes} de ${p.year}`;
}

/**
 * Base compartida por el PDF y el MP3 — así ambos adjuntos se ordenan juntos
 * en el gestor de archivos del gerente.
 *
 * @param {string} nombre Nombre del asesor
 * @param {Date|string|number} [input] Momento de la sesión
 * @returns {string} p. ej. "Victor_01_08_2026_06_26_am"
 */
function buildAttachmentBasename(nombre, input) {
  const p = cancunParts(input);

  const safeName = String(nombre || 'Asesor')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')   // acentos fuera: sobreviven a cualquier cliente de correo
    .replace(/[^A-Za-z0-9]+/g, '_')   // sin espacios ni caracteres reservados en Windows
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'Asesor';

  const periodo = p.ampm.replace(/\./g, ''); // "a.m." -> "am"
  return `${safeName}_${p.day}_${p.month}_${p.year}_${p.hour}_${p.minute}_${periodo}`;
}

// ════════════════════════════════════════════════════════════
// ASUNTO Y CUERPO
// ════════════════════════════════════════════════════════════

/**
 * Asunto del correo.
 * Formato: "Reporte de Capacitación: Victor 01/08/2026 06:26 a.m."
 *
 * @param {object} data Datos del reporte
 * @param {Date|string|number} [when] Momento de la sesión
 */
function buildEmailSubject(data, when) {
  const nombre = (data && data.nombre) || 'Asesor VTC';
  return `Reporte de Capacitación: ${nombre} ${formatDateLocal(when)} ${formatTimezoneCancun(when)}`;
}

const DIVIDER = '------------------------------------------------------------';

/**
 * Cuerpo del correo en texto plano.
 * Es la fuente de verdad: la versión HTML se construye a partir de esta misma
 * estructura para que ambos digan exactamente lo mismo.
 *
 * @param {object} data
 * @param {Date|string|number} [when]
 * @returns {string}
 */
function buildEmailText(data, when) {
  const d = data || {};
  const nombre = d.nombre || 'el asesor';
  const fechaEmail = formatDateLong(when);
  const hora = formatTimezoneCancun(when);

  const scoreTotal = d.scoreTotal != null
    ? d.scoreTotal
    : Math.round(((Number(d.score_overall) || 0) / 10) * 100);

  return [
    'Estimados,',
    '',
    // Sin punto final: `hora` ya termina en "a.m." / "p.m."
    `Les envío el resumen de la sesión de entrenamiento de ${nombre} el día ${fechaEmail} a las ${hora}`,
    '',
    'RESUMEN DE LA SESIÓN',
    `Duración: ${d.duracion_texto || '—'} min`,
    `Módulo: ${d.modulo || '—'}`,
    `Desempeño general: ${d.score_overall != null ? d.score_overall : '—'}/10 (${scoreTotal}%)`,
    `Idioma: ${d.idioma || '—'}`,
    '',
    'ANÁLISIS:',
    listaTexto(d.resumen),
    '',
    'FORTALEZAS IDENTIFICADAS:',
    listaTexto(d.fortalezas),
    '',
    'AREAS A MEJORAR:',
    listaTexto(d.areas_mejora),
    '',
    'RECOMENDACIÓN DEL COACH:',
    listaTexto(d.recomendacion_coach),
    '',
    DIVIDER,
    '',
    'PROXIMOS PASOS',
    '',
    'Para acceder al reporte completo con gráficos, análisis detallado de competencias y '
      + 'plan de acción personalizado, descargue el archivo PDF adjunto.',
    '',
    'Para revisar la transcripción completa de la sesión, descargue el archivo de audio (MP3) adjunto.',
    '',
    DIVIDER,
    '',
    'Quedo atento a cualquier pregunta.',
    '',
    'Saludos cordiales,',
    '',
    'El equipo de Victor-IA',
    'Entrenamiento VTC Capacitación',
    'victor-ia.xyz'
  ].join('\n');
}

// ════════════════════════════════════════════════════════════
// PALETA — la misma del reporte (negro + oro, sin azules)
// ════════════════════════════════════════════════════════════
const COLOR = {
  bg: '#0D0D0D',        // fondo principal
  surface: '#1A1A1A',   // tarjeta del correo
  surface2: '#262626',  // badges y botones
  gold: '#E5B33E',      // acento
  goldSoft: '#F2C766',
  text: '#FFFFFF',
  muted: '#B8B8B8',
  good: '#10B981',      // score ≥ 8
  warn: '#F59E0B',      // score 6 – 7.99
  bad: '#EF4444'        // score < 6
};

/** Meta VTC: mismo umbral que el reporte y que los gráficos. */
const META_VTC = 8;

/** Color de estado de un score, con los cortes de la meta VTC. */
function scoreColor(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return COLOR.gold;
  if (n >= META_VTC) return COLOR.good;
  if (n >= 6) return COLOR.warn;
  return COLOR.bad;
}

/**
 * Prosa larga -> HTML legible dentro del correo.
 *
 * Mismo criterio que el reporte: si el texto trae la enumeración embebida
 * ("… (1) … (2) … (3) …") se parte en intro + puntos numerados con salto de
 * línea entre cada uno. Una parrafada de ocho renglones en el teléfono no se
 * lee; una lista de tres puntos sí.
 *
 * Se usan tablas de una celda por punto porque `display:block` sobre un <span>
 * no es fiable en Outlook; el margen de un <p> anidado, tampoco.
 */
function formatBlocks(text, estilos) {
  const raw = plain(text);
  if (raw === '—') return `<p style="${estilos.para}">—</p>`;

  const { intro, items } = splitEnumeracion(raw);

  let html = '';
  if (intro) html += `<p style="${estilos.para}">${nl2br(intro)}</p>`;

  for (const it of items) {
    html += `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 0">
        <tr>
          <td valign="top" style="${estilos.num}">${escapeHtml(it.n)}.-</td>
          <td valign="top" style="${estilos.para};margin:0">${nl2br(it.texto)}</td>
        </tr>
      </table>`;
  }
  return html;
}

/**
 * Separa "intro + (1) … (2) …" en sus partes.
 *
 * Reglas iguales a las del reporte:
 *   - Hacen falta AL MENOS DOS marcadores; con uno suele ser una cita.
 *   - La secuencia debe ir 1, 2, 3… — así "subió (2) puntos en (3) días" no se
 *     confunde con una lista.
 *
 * @returns {{intro:string, items:Array<{n:string,texto:string}>}}
 */
function splitEnumeracion(raw) {
  const LINEA_NUMERADA = /^(?:\((\d{1,2})\)|(\d{1,2})\s*[.)\-–—]+)\s*(.*)$/;

  // Caso A: ya viene una línea por punto
  const lineas = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lineas.length > 1 && lineas.filter((l) => LINEA_NUMERADA.test(l)).length >= 2) {
    const intro = [];
    const items = [];
    for (const linea of lineas) {
      const m = linea.match(LINEA_NUMERADA);
      if (m) items.push({ n: m[1] || m[2], texto: String(m[3] || '').trim() });
      else if (!items.length) intro.push(linea);
      else items[items.length - 1].texto += ` ${linea}`;
    }
    return { intro: intro.join(' '), items };
  }

  // Caso B: un solo párrafo con la enumeración embebida
  if (lineas.length > 1) return { intro: raw, items: [] };

  // El separador va como lookbehind y no como grupo que consume: si se consume,
  // "…a las 04:42. (1) El usuario…" pierde el marcador (1) —el "42. " se come
  // el espacio— y el párrafo entero se queda sin partir. Mismo criterio que
  // formatRichText en report-generator.js; los dos tienen que coincidir o el
  // correo y el PDF dirían lo mismo con distinta forma.
  const marcadores = [];
  const re = /(?<=^|[\s;:,.])\(?(\d{1,2})\)\s*|(?<=^|[\s;:,.])(\d{1,2})[.)]-?\s+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    marcadores.push({
      n: Number(m[1] || m[2]),
      inicio: m.index,
      fin: m.index + m[0].length
    });
  }

  const secuencia = [];
  for (const mk of marcadores) {
    if (mk.n === secuencia.length + 1) secuencia.push(mk);
  }
  if (secuencia.length < 2) return { intro: raw, items: [] };

  const items = secuencia.map((mk, i) => {
    const fin = i + 1 < secuencia.length ? secuencia[i + 1].inicio : raw.length;
    return { n: String(mk.n), texto: raw.slice(mk.fin, fin).trim().replace(/[;,]+$/, '') };
  });

  return { intro: raw.slice(0, secuencia[0].inicio).trim(), items };
}

/**
 * Cuerpo del correo en HTML.
 * Layout de tabla y estilos inline: es lo único que Outlook y Gmail renderizan
 * igual. Paleta VTC v4.0 (negro #0D0D0D / oro #E5B33E), la misma del reporte y
 * del formulario, sin depender de imágenes ni de fuentes externas.
 *
 * @param {object} data
 * @param {Date|string|number} [when]
 * @returns {string}
 */
function buildEmailHTML(data, when) {
  const d = data || {};
  const nombre = escapeHtml(d.nombre || 'el asesor');
  const fechaEmail = formatDateLong(when);
  const hora = formatTimezoneCancun(when);

  const scoreTotal = d.scoreTotal != null
    ? d.scoreTotal
    : Math.round(((Number(d.score_overall) || 0) / 10) * 100);

  const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";
  const label = `${font};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${COLOR.gold};font-weight:700;margin:0 0 8px`;
  const para = `${font};font-size:14px;line-height:1.7;color:#E4E4E4;margin:0 0 6px`;
  const num = `${font};font-size:14px;line-height:1.7;color:${COLOR.gold};font-weight:800;padding-right:8px;white-space:nowrap`;

  const block = (titulo, contenido) => `
      <p style="${label}">${escapeHtml(titulo)}</p>
      ${formatBlocks(contenido, { para, num })}
      <div style="height:22px"></div>`;

  const row = (k, v, color) => `
        <tr>
          <td style="${font};font-size:13px;color:${COLOR.muted};padding:8px 0;border-bottom:1px solid rgba(255,255,255,.09)">${escapeHtml(k)}</td>
          <td style="${font};font-size:14px;color:${color || COLOR.text};font-weight:600;text-align:right;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.09)">${escapeHtml(v)}</td>
        </tr>`;

  // El desempeño se colorea con el mismo criterio que el reporte: si el gerente
  // ve verde en el correo y rojo en el PDF deja de confiar en los dos.
  const colorScore = scoreColor(d.score_overall);

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reporte de Capacitación — ${nombre}</title></head>
<body style="margin:0;padding:0;background:${COLOR.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.bg};padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${COLOR.surface};border-radius:14px;overflow:hidden;border:1px solid rgba(229,179,62,.28)">

  <tr><td style="background:${COLOR.surface2};padding:32px 34px;border-bottom:3px solid ${COLOR.gold}">
    <p style="${font};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${COLOR.gold};font-weight:700;margin:0 0 10px">Victorious Travelers Club · Elite Training</p>
    <h1 style="${font};font-size:24px;color:${COLOR.text};margin:0;font-weight:700">Reporte de Capacitación</h1>
    <p style="${font};font-size:14px;color:${COLOR.muted};margin:6px 0 0">${nombre} · ${escapeHtml(formatDateLocal(when))} · ${escapeHtml(hora)}</p>
  </td></tr>

  <tr><td style="padding:32px 34px">

    <p style="${para}">Estimados,</p>
    <p style="${para}">Les envío el resumen de la sesión de entrenamiento de <strong style="color:${COLOR.goldSoft}">${nombre}</strong> el día ${escapeHtml(fechaEmail)} a las ${escapeHtml(hora)}</p>
    <div style="height:26px"></div>

    <p style="${label}">Resumen de la sesión</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 26px">
      ${row('Duración', `${d.duracion_texto || '—'} min`)}
      ${row('Módulo', String(d.modulo || '—'))}
      ${row('Desempeño general', `${d.score_overall != null ? d.score_overall : '—'}/10 (${scoreTotal}%)`, colorScore)}
      ${row('Meta VTC', `${META_VTC}.0/10`, COLOR.gold)}
      ${row('Idioma', String(d.idioma || '—'))}
    </table>

    ${block('Análisis', d.resumen)}
    ${block('Fortalezas identificadas', d.fortalezas)}
    ${block('Áreas a mejorar', d.areas_mejora)}
    ${block('Recomendación del coach', d.recomendacion_coach)}

    <div style="border-top:1px solid rgba(229,179,62,.28);margin:8px 0 26px"></div>

    <p style="${label}">Próximos pasos</p>
    <p style="${para}">Para acceder al reporte completo con gráficos, análisis detallado de competencias y plan de acción personalizado, descargue el archivo <strong style="color:${COLOR.goldSoft}">PDF adjunto</strong>.</p>
    <p style="${para}">Para revisar la transcripción completa de la sesión, descargue el archivo de <strong style="color:${COLOR.goldSoft}">audio (MP3) adjunto</strong>.</p>
    ${buildEmailCtas(d, { font })}

    <div style="border-top:1px solid rgba(229,179,62,.28);margin:26px 0"></div>

    <p style="${para}">Quedo atento a cualquier pregunta.</p>
    <p style="${para}">Saludos cordiales,</p>
    <div style="height:14px"></div>
    <p style="${para};margin:0"><strong style="color:${COLOR.text}">El equipo de Victor-IA</strong></p>
    <p style="${font};font-size:13px;color:${COLOR.muted};margin:2px 0 0">Entrenamiento VTC Capacitación</p>
    <p style="${font};font-size:13px;color:${COLOR.gold};margin:2px 0 0">victor-ia.xyz</p>

  </td></tr>

  <tr><td style="background:${COLOR.bg};padding:18px 34px;text-align:center;border-top:1px solid rgba(229,179,62,.22)">
    <p style="${font};font-size:11px;color:${COLOR.muted};margin:0">Generado automáticamente por Victor IA · ${escapeHtml(formatDateLocal(when))} ${escapeHtml(hora)} (America/Cancún)</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/**
 * Los tres CTAs del correo, en dorado sólido.
 *
 * Solo se pintan los que tienen destino real: un botón que lleva a "#" desde
 * el buzón del gerente es peor que no tenerlo. Si el pipeline no pudo firmar
 * los enlaces (falta el secreto), el bloque entero desaparece y quedan los
 * adjuntos, que siempre viajan.
 */
function buildEmailCtas(d, { font }) {
  const acciones = [
    { url: d.pop_up_url, texto: 'Escuchar la sesión', principal: true },
    { url: d.pdf_download_url, texto: 'Descargar el reporte', principal: false },
    { url: d.retrain_url, texto: 'Repetir el entrenamiento', principal: false }
  ].filter((a) => typeof a.url === 'string' && /^https?:\/\//i.test(a.url));

  if (!acciones.length) return '';

  const botones = acciones
    .map((a) => {
      const estilo = a.principal
        ? `background:${COLOR.gold};color:${COLOR.bg};border:1px solid ${COLOR.gold}`
        : `background:${COLOR.surface2};color:${COLOR.gold};border:1px solid ${COLOR.gold}`;
      return `<a href="${escapeHtml(a.url)}" style="${font};display:inline-block;${estilo};`
        + `font-weight:700;font-size:14px;padding:12px 20px;border-radius:8px;`
        + `text-decoration:none;margin:0 8px 10px 0">${escapeHtml(a.texto)}</a>`;
    })
    .join('');

  return `<div style="margin-top:20px">${botones}</div>`;
}

/**
 * Versión en texto plano de la misma enumeración que arma `formatBlocks`.
 * El cuerpo de texto es el fallback de entregabilidad: si dice lo mismo que el
 * HTML pero apelmazado, el que lo lee ahí sale perdiendo sin motivo.
 */
function listaTexto(text) {
  const raw = plain(text);
  if (raw === '—') return raw;

  const { intro, items } = splitEnumeracion(raw);
  if (!items.length) return raw;

  const partes = [];
  if (intro) partes.push(intro, '');
  for (const it of items) partes.push(`${it.n}.- ${it.texto}`);
  return partes.join('\n');
}

/** Aplana texto: quita viñetas heredadas y normaliza saltos. */
function plain(text) {
  if (text === null || text === undefined || text === '') return '—';
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

// ════════════════════════════════════════════════════════════
// ENVÍO
// ════════════════════════════════════════════════════════════

/**
 * Presupuesto de tiempo del envío.
 *
 * El correo es el ÚLTIMO paso de una lambda de 60s: cuando se ejecuta ya se
 * consumieron ~40s en fetch + render. Con 3 intentos y backoff exponencial
 * (2s + 4s de espera, más 3 llamadas sin techo) el paso podía tardar más que
 * toda la lambda y morir SIN enviar nada. Un intento acotado a 8s siempre cabe.
 * Resend además reintenta por su cuenta del lado del proveedor.
 */
const EMAIL_MAX_RETRIES = Number(process.env.EMAIL_MAX_RETRIES || 1);
const EMAIL_ATTEMPT_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 8000);

/** Corre una promesa con techo de tiempo, limpiando el temporizador siempre. */
function withTimeout(promise, ms, etiqueta) {
  let timer = null;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${etiqueta} timeout tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class EmailSender {
  constructor(apiKey, options = {}) {
    this.resend = new Resend(apiKey);
    this.maxRetries = Math.max(1, Number(options.maxRetries) || EMAIL_MAX_RETRIES);
    this.attemptTimeoutMs = Math.max(1000, Number(options.timeout) || EMAIL_ATTEMPT_TIMEOUT_MS);
  }

  /**
   * Enviar email con adjuntos (PDF + MP3)
   */
  async sendWithAttachments(options) {
    const { to, from, subject, htmlBody, textBody, attachments = [] } = options;

    if (!to || !from || !subject || !htmlBody) {
      throw new Error('Missing required email fields: to, from, subject, htmlBody');
    }

    if (!Array.isArray(attachments)) {
      throw new Error('Attachments must be an array');
    }

    const preparedAttachments = attachments.map((att) => {
      if (!att.filename || !att.content) {
        throw new Error('Each attachment must have filename and content');
      }
      return {
        filename: att.filename,
        content: att.content, // Buffer
        contentType: att.contentType || 'application/octet-stream'
      };
    });

    console.log(`[EMAIL] Preparing email to: ${Array.isArray(to) ? to.join(', ') : to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Attachments: ${preparedAttachments.map((a) => a.filename).join(', ') || 'ninguno'}`);

    let attempt = 0;
    let lastError;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        console.log(`[EMAIL] Attempt ${attempt}/${this.maxRetries}...`);

        const payload = {
          from,
          to,
          subject,
          html: htmlBody,
          attachments: preparedAttachments
        };
        // El texto plano mejora la entregabilidad y da fallback en clientes sin HTML
        if (textBody) payload.text = textBody;

        const response = await withTimeout(
          this.resend.emails.send(payload),
          this.attemptTimeoutMs,
          'resend.emails.send'
        );

        if (response && response.error) {
          throw new Error(`Resend error: ${response.error.message || response.error}`);
        }

        const messageId = (response && response.data && response.data.id) || null;
        console.log(`[EMAIL] ✓ Email sent successfully. ID: ${messageId || 'sin id'}`);

        return {
          success: true,
          messageId,
          subject,
          attachments: preparedAttachments.map((a) => a.filename),
          timestamp: new Date().toISOString(),
          attempt
        };
      } catch (error) {
        lastError = error;
        console.error(`[EMAIL] Attempt ${attempt} failed:`, error.message);

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Backoff exponencial
          console.log(`[EMAIL] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    console.error(`[EMAIL] All ${this.maxRetries} attempts failed`);
    return {
      success: false,
      error: (lastError && lastError.message) || 'Envío fallido sin detalle',
      attempts: attempt,
      timestamp: new Date().toISOString()
    };
  }

  validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static getEmailHeaders(options) {
    return {
      from: options.from,
      to: options.to,
      subject: options.subject,
      date: new Date().toISOString(),
      attachmentCount: (options.attachments || []).length,
      bodyLength: options.htmlBody ? options.htmlBody.length : 0
    };
  }
}

/**
 * Envío con validación de direcciones. Acepta uno o varios destinatarios.
 */
async function sendEmailWithAttachments(options) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable not set');
  }

  const sender = new EmailSender(apiKey);

  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  for (const addr of recipients) {
    if (!sender.validateEmail(addr)) {
      throw new Error(`Invalid recipient email: ${addr}`);
    }
  }

  // El remitente puede venir como "Nombre <correo@dominio>" — validamos solo el correo
  const fromAddress = extractAddress(options.from);
  if (!sender.validateEmail(fromAddress)) {
    throw new Error(`Invalid sender email: ${options.from}`);
  }

  return sender.sendWithAttachments(options);
}

/** Extrae el correo de un remitente con formato "Nombre <correo@dominio>". */
function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim();
}

/**
 * Construye el paquete completo del correo (asunto + cuerpos + nombres de adjunto).
 * Lo consume el pipeline en api-process-call.js.
 *
 * @param {object} data Datos del reporte ya mapeados
 * @param {Date|string|number} [when] Momento de la sesión
 */
function buildEmailPackage(data, when) {
  const basename = buildAttachmentBasename(data && data.nombre, when);
  return {
    subject: buildEmailSubject(data, when),
    html: buildEmailHTML(data, when),
    text: buildEmailText(data, when),
    basename,
    pdfFilename: `${basename}.pdf`,
    mp3Filename: `${basename}.mp3`,
    fecha_formateada: formatDateLocal(when),
    fecha_email: formatDateLong(when),
    hora_america_cancun: formatTimezoneCancun(when)
  };
}

module.exports = {
  EmailSender,
  sendEmailWithAttachments,
  buildEmailPackage,
  buildEmailSubject,
  buildEmailHTML,
  buildEmailText,
  buildAttachmentBasename,
  formatTimezoneCancun,
  formatDateLocal,
  formatDateLong
};