/**
 * RETRAIN REQUEST — Solicitudes de reentrenamiento
 *
 * ¿Por qué existe este módulo y no vive dentro del endpoint?
 *   La solicitud de reentrenamiento la disparan tres sitios distintos:
 *     · POST /api/retrain-request  — flujo nuevo (solo conversation_id + notas)
 *     · POST /api/retrain          — flujo viejo (con competencias y prioridad)
 *     · el reporte                 — que TIENE que decir a dónde llega la solicitud
 *   Si cada uno arma su correo por su cuenta, tarde o temprano dicen cosas
 *   distintas y el gerente recibe dos formatos de la misma cosa. Aquí está la
 *   única definición: destinatarios, registro y cuerpo del correo.
 *
 * Destino: SIEMPRE los gerentes. Por defecto mesainteligentedemo@gmail.com.
 *   Configurable con RETRAIN_REQUEST_EMAIL (lista separada por comas).
 *
 * Registro: se guarda en Supabase si hay credenciales; si no, en memoria del
 *   proceso. El registro NUNCA bloquea el correo — que la notificación llegue
 *   importa más que dejar la fila escrita.
 */

const {
  sendEmailWithAttachments,
  formatDateLocal,
  formatDateLong,
  formatTimezoneCancun
} = require('./email-sender');
const { buildReportLinks } = require('./report-links');

const DEFAULT_MANAGER = 'mesainteligentedemo@gmail.com';
const MAX_NOTAS = 2000;
const MAX_MEMORIA = 100;

const PRIORIDADES = { alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };

/** Últimas solicitudes vistas por ESTA instancia. Diagnóstico, no fuente de verdad. */
const memoria = [];

// ════════════════════════════════════════════════════════════
// DESTINATARIOS
// ════════════════════════════════════════════════════════════

/**
 * A quién llega una solicitud de reentrenamiento.
 *
 * Orden: RETRAIN_REQUEST_EMAIL → EMAIL_TO_PRIMARY → default de fábrica.
 * Nunca devuelve una lista vacía: una solicitud sin destinatario es una
 * solicitud perdida, y eso es peor que mandarla al buzón por defecto.
 *
 * @returns {string[]}
 */
function managerRecipients() {
  const raw = process.env.RETRAIN_REQUEST_EMAIL || process.env.EMAIL_TO_PRIMARY || DEFAULT_MANAGER;
  const lista = String(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));

  return lista.length ? lista : [DEFAULT_MANAGER];
}

// ════════════════════════════════════════════════════════════
// REGISTRO
// ════════════════════════════════════════════════════════════

/** Identificador legible: ordena por tiempo y no colisiona entre lambdas. */
function nuevoId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RTR-${stamp}-${rand}`;
}

/**
 * Escribe la solicitud en Supabase vía REST.
 * No añade dependencias: usa el fetch nativo de Node 18+.
 *
 * @returns {Promise<boolean>} true si la fila quedó escrita
 */
async function persistirEnSupabase(record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key || typeof fetch !== 'function') return false;

  const tabla = process.env.SUPABASE_RETRAIN_TABLE || 'retrain_requests';
  const endpoint = `${String(url).replace(/\/+$/, '')}/rest/v1/${tabla}`;

  // Techo corto: el registro es secundario, el correo es lo que importa.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify([
        {
          request_id: record.id,
          conversation_id: record.conversation_id,
          asesor: record.asesor,
          empleado_id: record.empleado_id,
          modulo: record.modulo,
          score_overall: record.score_overall,
          competencias: record.competencias,
          prioridad: record.prioridad,
          notas: record.notas,
          solicitante: record.solicitante,
          destinatarios: record.destinatarios,
          created_at: record.created_at
        }
      ]),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      console.warn(`[RETRAIN] Supabase respondió ${response.status}: ${detalle.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[RETRAIN] No se pudo escribir en Supabase:', error.message);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Crea el registro de la solicitud.
 * Devuelve siempre un registro: si la BD falla, queda en memoria y el campo
 * `persisted` lo dice sin disimulo.
 *
 * @returns {Promise<object>}
 */
async function createRetrainRecord(input) {
  const record = {
    id: nuevoId(),
    conversation_id: String(input.conversationId || ''),
    asesor: input.asesor || null,
    empleado_id: input.empleado_id || null,
    modulo: input.modulo || null,
    score_overall: Number.isFinite(Number(input.score_overall)) ? Number(input.score_overall) : null,
    competencias: Array.isArray(input.competencias) ? input.competencias : [],
    prioridad: input.prioridad || 'MEDIA',
    notas: input.notas || '',
    solicitante: input.solicitante || null,
    destinatarios: Array.isArray(input.destinatarios) ? input.destinatarios : managerRecipients(),
    created_at: new Date().toISOString(),
    persisted: 'memoria'
  };

  if (await persistirEnSupabase(record)) {
    record.persisted = 'supabase';
  }

  memoria.push(record);
  if (memoria.length > MAX_MEMORIA) memoria.splice(0, memoria.length - MAX_MEMORIA);

  console.log(
    `[RETRAIN] Registro ${record.id} creado (${record.persisted}) para ${record.conversation_id}`
  );
  return record;
}

/** Últimas solicitudes de esta instancia. Solo diagnóstico. */
function recentRetrainRequests(limit = 20) {
  return memoria.slice(-Math.max(1, limit)).reverse();
}

// ════════════════════════════════════════════════════════════
// NORMALIZACIÓN DE ENTRADA
// ════════════════════════════════════════════════════════════

/** Prioridad canónica; cualquier cosa rara cae a MEDIA. */
function normalizePrioridad(raw) {
  return PRIORIDADES[String(raw || '').toLowerCase()] || 'MEDIA';
}

/** Notas del solicitante: recortadas y sin espacios sobrantes. */
function normalizeNotas(raw) {
  return String(raw == null ? '' : raw).slice(0, MAX_NOTAS).trim();
}

/**
 * Competencias a reforzar.
 * Si el solicitante no eligió ninguna, se deducen de la sesión: las que están
 * por debajo del estándar. Así el flujo corto (solo notas) sigue llegando al
 * gerente con foco concreto en vez de un "reentrenar en general".
 *
 * @param {Array} elegidas Lo que mandó el formulario
 * @param {object} summary Resumen de la sesión
 */
function resolveCompetencias(elegidas, summary) {
  const limpias = (Array.isArray(elegidas) ? elegidas : [])
    .map((c) => String(c).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 12);

  if (limpias.length) return { competencias: limpias, origen: 'seleccion' };

  const bajas = (summary && Array.isArray(summary.competencias) ? summary.competencias : [])
    .filter((c) => c && Number.isFinite(Number(c.score)) && Number(c.score) < 8)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => String(c.name));

  if (bajas.length) return { competencias: bajas, origen: 'automatico' };

  const baja = summary && summary.comp_baja ? [String(summary.comp_baja)] : [];
  return { competencias: baja, origen: baja.length ? 'automatico' : 'ninguno' };
}

// ════════════════════════════════════════════════════════════
// CORREO
// ════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Áreas críticas de la sesión, con su score. Es lo que el gerente necesita ver. */
function areasCriticas(summary) {
  const comps = summary && Array.isArray(summary.competencias) ? summary.competencias : [];
  return comps
    .filter((c) => c && Number.isFinite(Number(c.score)) && Number(c.score) < 8)
    .sort((a, b) => a.score - b.score)
    .map((c) => `${c.name}: ${c.score}/10 (${Math.round((8 - c.score) * 10) / 10} por debajo del estándar)`);
}

/**
 * Construye el correo que recibe el gerente.
 * Lleva TODO el contexto: quién, qué sesión, qué scores, qué falla, qué pidió
 * el solicitante y los enlaces al reporte y al audio.
 *
 * @returns {{subject:string, html:string, text:string}}
 */
function buildRetrainEmail({ summary, record, links, origenCompetencias }) {
  const s = summary || {};
  const ahora = new Date(record.created_at);
  const competencias = record.competencias.length ? record.competencias.join(', ') : 'Sin foco definido';
  const criticas = areasCriticas(s);

  const fortalezas = Array.isArray(s.fortalezas_list) ? s.fortalezas_list : [];
  const areas = Array.isArray(s.areas_list) ? s.areas_list : [];

  const subject =
    `Reentrenamiento ${record.prioridad}: ${s.nombre || 'Asesor VTC'} — ` +
    `${competencias} (${formatDateLocal(ahora)})`;

  const notaOrigen = origenCompetencias === 'automatico'
    ? ' (deducidas de los scores de la sesión — el solicitante no marcó ninguna)'
    : '';

  // ── Texto plano ─────────────────────────────────────────────
  const text = [
    'SOLICITUD DE REENTRENAMIENTO',
    `Folio: ${record.id}`,
    '',
    'RESUMEN DEL ASESOR',
    `Nombre: ${s.nombre || '—'} (${s.empleado_id || '—'})`,
    `Puesto: ${s.puesto || '—'}`,
    `Módulo evaluado: ${s.modulo || '—'}`,
    `Sesión: ${s.fecha_sesion || '—'} ${s.hora_cancun || ''} · ${s.duracion_texto || '—'} min`,
    '',
    'SCORES',
    `Desempeño global: ${s.score_overall != null ? s.score_overall : '—'}/10 (${s.scoreTotal != null ? s.scoreTotal : '—'}%)`,
    ...(Array.isArray(s.competencias) ? s.competencias.map((c) => `  · ${c.name}: ${c.score}/10`) : []),
    '',
    'ÁREAS CRÍTICAS',
    criticas.length ? criticas.map((c) => `  · ${c}`).join('\n') : '  Ninguna competencia por debajo del estándar de 8/10.',
    '',
    `PRIORIDAD: ${record.prioridad}`,
    `COMPETENCIAS A REFORZAR: ${competencias}${notaOrigen}`,
    '',
    'NOTAS DEL SOLICITANTE',
    record.notas || '(sin notas)',
    ...(fortalezas.length ? ['', 'FORTALEZAS DE LA SESIÓN', ...fortalezas.map((f) => `  · ${f}`)] : []),
    ...(areas.length ? ['', 'ÁREAS DE MEJORA DETECTADAS', ...areas.map((a) => `  · ${a}`)] : []),
    '',
    'RECOMENDACIÓN DEL COACH',
    s.recomendacion_coach || '—',
    '',
    'ENLACES',
    `Reporte completo (PDF): ${links.pdf_download_url}`,
    `Escuchar la sesión: ${links.pop_up_url}`,
    '',
    `Solicitado el ${formatDateLong(ahora)} a las ${formatTimezoneCancun(ahora)} (America/Cancún)`,
    `Registro: ${record.persisted === 'supabase' ? 'guardado en base de datos' : 'en memoria del servidor'}`,
    '',
    'Victor IA · Entrenamiento VTC Capacitación · victor-ia.xyz'
  ].join('\n');

  // ── HTML ────────────────────────────────────────────────────
  const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";
  const label = `${font};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4af37;font-weight:700;margin:0 0 8px`;
  const para = `${font};font-size:14px;line-height:1.7;color:#dfe6ed;margin:0 0 18px`;

  const row = (k, v) => `<tr>
      <td style="${font};font-size:13px;color:#9db0c2;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(k)}</td>
      <td style="${font};font-size:14px;color:#fff;font-weight:600;text-align:right;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(v)}</td>
    </tr>`;

  const lista = (items, color) => items.length
    ? `<ul style="${font};font-size:14px;line-height:1.7;color:#dfe6ed;margin:0 0 18px;padding-left:20px">${
      items.map((i) => `<li style="margin-bottom:5px;color:${color}">${escapeHtml(i)}</li>`).join('')
    }</ul>`
    : `<p style="${para}">—</p>`;

  const scoresRows = (Array.isArray(s.competencias) ? s.competencias : [])
    .map((c) => row(c.name, `${c.score}/10`))
    .join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#0a1721;padding:26px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:0 auto;background:#102435;border-radius:14px;overflow:hidden;border:1px solid rgba(212,175,55,.22)">

  <tr><td style="background:#1a3a52;padding:28px 32px;border-bottom:3px solid #d4af37">
    <p style="${font};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#d4af37;font-weight:700;margin:0 0 8px">Victorious Travelers Club · Elite Training</p>
    <h1 style="${font};font-size:22px;color:#fff;margin:0;font-weight:700">Solicitud de reentrenamiento</h1>
    <p style="${font};font-size:14px;color:#9db0c2;margin:6px 0 0">${escapeHtml(s.nombre || 'Asesor VTC')} · ${escapeHtml(s.modulo || '—')} · prioridad ${escapeHtml(record.prioridad)}</p>
    <p style="${font};font-size:11px;color:#6f8298;margin:8px 0 0">Folio ${escapeHtml(record.id)}</p>
  </td></tr>

  <tr><td style="padding:28px 32px">

    <p style="${label}">Resumen del asesor</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      ${row('Asesor', `${s.nombre || '—'} (${s.empleado_id || '—'})`)}
      ${row('Puesto', String(s.puesto || '—'))}
      ${row('Módulo evaluado', String(s.modulo || '—'))}
      ${row('Sesión', `${s.fecha_sesion || '—'} ${s.hora_cancun || ''}`)}
      ${row('Duración', `${s.duracion_texto || '—'} min`)}
    </table>

    <p style="${label}">Scores de la sesión</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      ${row('Desempeño global', `${s.score_overall != null ? s.score_overall : '—'}/10 (${s.scoreTotal != null ? s.scoreTotal : '—'}%)`)}
      ${scoresRows}
    </table>

    <p style="${label}">Áreas críticas</p>
    ${criticas.length
      ? lista(criticas, '#ffc457')
      : `<p style="${para}">Ninguna competencia por debajo del estándar de 8/10.</p>`}

    <p style="${label}">Competencias a reforzar</p>
    <p style="${para}"><strong style="color:#e6c869">${escapeHtml(competencias)}</strong>${escapeHtml(notaOrigen)}</p>

    <p style="${label}">Notas del solicitante</p>
    <p style="${para}">${escapeHtml(record.notas || '(sin notas)').replace(/\n/g, '<br>')}</p>

    ${fortalezas.length ? `<p style="${label}">Fortalezas de la sesión</p>${lista(fortalezas, '#3fd7ae')}` : ''}

    <p style="${label}">Recomendación del coach</p>
    <p style="${para}">${escapeHtml(s.recomendacion_coach || '—')}</p>

    <div style="border-top:1px solid rgba(212,175,55,.22);margin:8px 0 22px"></div>

    <a href="${escapeHtml(links.pdf_download_url)}" style="${font};display:inline-block;background:#d4af37;color:#0d1b26;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin:0 10px 10px 0">Ver el reporte completo</a>
    <a href="${escapeHtml(links.pop_up_url)}" style="${font};display:inline-block;color:#e6c869;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;border:1px solid rgba(212,175,55,.22)">Escuchar la sesión</a>

  </td></tr>

  <tr><td style="background:#0a1721;padding:16px 32px;text-align:center;border-top:1px solid rgba(212,175,55,.18)">
    <p style="${font};font-size:11px;color:#6f8298;margin:0">Solicitado el ${escapeHtml(formatDateLocal(ahora))} ${escapeHtml(formatTimezoneCancun(ahora))} (America/Cancún) · Folio ${escapeHtml(record.id)}</p>
  </td></tr>

</table></body></html>`;

  return { subject, html, text };
}

// ════════════════════════════════════════════════════════════
// ORQUESTACIÓN
// ════════════════════════════════════════════════════════════

/**
 * Registra la solicitud y notifica al gerente.
 *
 * @param {object} options
 * @param {string} options.conversationId
 * @param {object} options.summary       Resumen de la sesión (buildReportSummary)
 * @param {string} [options.notas]
 * @param {Array}  [options.competencias]
 * @param {string} [options.prioridad]
 * @param {string} [options.solicitante]
 * @returns {Promise<{success:boolean, record:object, recipients:string[], messageId:string|null, message:string}>}
 */
async function submitRetrainRequest(options = {}) {
  const conversationId = String(options.conversationId || '').trim();
  if (!conversationId) throw new Error('submitRetrainRequest: falta conversationId');

  const summary = options.summary || {};
  const recipients = managerRecipients();
  const { competencias, origen } = resolveCompetencias(options.competencias, summary);

  const record = await createRetrainRecord({
    conversationId,
    asesor: summary.nombre,
    empleado_id: summary.empleado_id,
    modulo: summary.modulo,
    score_overall: summary.score_overall,
    competencias,
    prioridad: normalizePrioridad(options.prioridad),
    notas: normalizeNotas(options.notas),
    solicitante: options.solicitante || null,
    destinatarios: recipients
  });

  const links = buildReportLinks(conversationId);
  const { subject, html, text } = buildRetrainEmail({
    summary,
    record,
    links,
    origenCompetencias: origen
  });

  const emailResult = await sendEmailWithAttachments({
    to: recipients,
    from: process.env.EMAIL_FROM || 'info@victor-ia.com.mx',
    subject,
    htmlBody: html,
    textBody: text,
    attachments: []
  });

  if (!emailResult.success) {
    // El registro ya existe: se informa para que nadie repita la solicitud a ciegas.
    const err = new Error(emailResult.error || 'El correo de notificación no se envió');
    err.record = record;
    throw err;
  }

  return {
    success: true,
    record,
    recipients,
    messageId: emailResult.messageId || null,
    message: `Solicitud enviada a ${recipients.join(', ')}.`
  };
}

module.exports = {
  managerRecipients,
  submitRetrainRequest,
  createRetrainRecord,
  buildRetrainEmail,
  recentRetrainRequests,
  resolveCompetencias,
  normalizePrioridad,
  normalizeNotas,
  DEFAULT_MANAGER,
  MAX_NOTAS
};