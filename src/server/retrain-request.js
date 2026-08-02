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
 * Destino: el correo que elija quien llena el formulario. Si no manda ninguno,
 *   caen los gerentes de RETRAIN_REQUEST_EMAIL (lista separada por comas) y,
 *   en última instancia, mesainteligentedemo@gmail.com.
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

/**
 * Texto con el que la solicitud DECLARA un dato que no llegó.
 * Misma regla que el reporte y el correo: el hueco se nombra, no se rellena.
 */
const SIN_DATO = 'No disponible';
const MAX_NOTAS = 5000;
const MAX_MEMORIA = 100;

/** Formato de correo aceptado. El mismo regex que valida el formulario. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PRIORIDADES = { alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };

/** Últimas solicitudes vistas por ESTA instancia. Diagnóstico, no fuente de verdad. */
const memoria = [];

// ════════════════════════════════════════════════════════════
// DESTINATARIOS
// ════════════════════════════════════════════════════════════

/** Parte una cadena "a@x.com, b@y.com" en correos válidos. */
function parseEmails(raw) {
  return String(raw == null ? '' : raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
}

/**
 * A quién llega una solicitud de reentrenamiento.
 *
 * Orden: destino elegido en el formulario → RETRAIN_REQUEST_EMAIL →
 * EMAIL_TO_PRIMARY → default de fábrica.
 *
 * El destino del formulario manda porque quien solicita el reentrenamiento
 * sabe mejor que la variable de entorno a qué gerente le toca esta sesión.
 * Nunca devuelve una lista vacía: una solicitud sin destinatario es una
 * solicitud perdida, y eso es peor que mandarla al buzón por defecto.
 *
 * @param {string|string[]} [override] Correo(s) pedidos explícitamente
 * @returns {string[]}
 */
function managerRecipients(override) {
  if (override) {
    const elegidos = Array.isArray(override)
      ? override.flatMap((e) => parseEmails(e))
      : parseEmails(override);
    if (elegidos.length) return [...new Set(elegidos)].slice(0, 5);
  }

  const raw = process.env.RETRAIN_REQUEST_EMAIL || process.env.EMAIL_TO_PRIMARY || DEFAULT_MANAGER;
  const lista = parseEmails(raw);

  return lista.length ? lista : [DEFAULT_MANAGER];
}

/**
 * Copias de la solicitud de reentrenamiento.
 *
 * Lee `RETRAIN_CC` y, si no existe, reutiliza `REPORT_CC`: quien recibe copia
 * del reporte espera recibir tambien la peticion de repetir la practica.
 * Se excluye a quien ya esta en el "para" para no duplicar el mensaje.
 *
 * @param {string[]} destinatarios
 * @returns {string[]}
 */
function retrainCc(destinatarios = []) {
  const raw = process.env.RETRAIN_CC || process.env.REPORT_CC || process.env.EMAIL_CC || '';
  const yaEnviados = new Set(destinatarios.map((d) => String(d).trim().toLowerCase()));

  const lista = parseEmails(raw).filter((e) => !yaEnviados.has(e.toLowerCase()));
  return [...new Map(lista.map((e) => [e.toLowerCase(), e])).values()];
}

/** ¿Es un correo con forma válida? Se usa antes de aceptar el destino del formulario. */
function isValidEmail(value) {
  return EMAIL_RE.test(String(value == null ? '' : value).trim());
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

  // Columnas base (existen desde la primera versión de la tabla) y las nuevas,
  // que van aparte para poder reintentar sin ellas si el esquema aún no las tiene.
  const base = {
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
  };
  const extras = {
    notas_gerente: record.notas_gerente,
    email_destino: record.destinatarios[0] || null
  };

  async function intentar(fila) {
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
        body: JSON.stringify([fila]),
        signal: controller ? controller.signal : undefined
      });

      if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        return { ok: false, status: response.status, detalle };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, status: 0, detalle: error.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const primero = await intentar({ ...base, ...extras });
  if (primero.ok) return true;

  // Columna inexistente (PGRST204 / 42703): la tabla es de antes de las notas
  // del gerente. Se reintenta con el esquema viejo en vez de perder la fila.
  if (/PGRST204|42703|column/i.test(primero.detalle || '')) {
    const segundo = await intentar(base);
    if (segundo.ok) {
      console.warn('[RETRAIN] Supabase sin columnas notas_gerente/email_destino: fila escrita sin ellas');
      return true;
    }
    console.warn(`[RETRAIN] Supabase respondió ${segundo.status}: ${String(segundo.detalle).slice(0, 200)}`);
    return false;
  }

  console.warn(`[RETRAIN] Supabase respondió ${primero.status}: ${String(primero.detalle).slice(0, 200)}`);
  return false;
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
    notas_gerente: input.notasGerente || '',
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

/** Techo del asunto: lo mismo que en el correo del reporte. */
const SUBJECT_MAX = 78;

/** Recorta el nombre para que el asunto quepa entero, sin partir palabras. */
function fitNombre(nombre, resto) {
  const disponible = SUBJECT_MAX - resto;
  if (nombre.length <= disponible) return nombre;
  if (disponible < 8) return nombre.slice(0, Math.max(1, disponible));

  const cortado = nombre.slice(0, disponible - 1);
  const espacio = cortado.lastIndexOf(' ');
  return `${(espacio > 4 ? cortado.slice(0, espacio) : cortado).trim()}…`;
}

/**
 * Notas escritas por quien solicitó el reentrenamiento.
 *
 * El formulario tiene dos campos —uno dirigido al colaborador y otro al
 * gerente— y los dos los escribe la misma persona. Se muestran juntos: perder
 * uno de los dos en el correo sería perder instrucciones de coaching.
 *
 * @returns {Array<[string,string]>} pares [etiqueta, texto]; vacío si no hay nada
 */
function notasDelGerente(record) {
  const gerente = String(record.notas_gerente || '').trim();
  const colaborador = String(record.notas || '').trim();

  const bloques = [];
  if (gerente) bloques.push(['', gerente]);
  if (colaborador && colaborador !== gerente) {
    bloques.push([bloques.length ? 'Para el colaborador' : '', colaborador]);
  }
  return bloques;
}

/**
 * Construye el correo que recibe el gerente.
 * Lleva lo esencial —quién, qué sesión, qué competencias, qué notas— y los
 * enlaces al reporte y al audio, que es donde vive el detalle completo.
 *
 * @returns {{subject:string, html:string, text:string}}
 */
function buildRetrainEmail({ summary, record, links, origenCompetencias }) {
  const s = summary || {};
  const ahora = new Date(record.created_at);
  // Sin identidad NO se inventa una: "Asesor VTC" hacía que el gerente
  // agendara un reentrenamiento sin saber para quién.
  const nombre = String(s.nombre_completo || s.nombre || 'Colaborador sin identificar');

  // Las competencias marcadas viajan CON su score: el gerente no debería tener
  // que abrir el PDF para saber de qué número parte cada una.
  const scorePorNombre = new Map(
    (Array.isArray(s.competencias) ? s.competencias : [])
      .filter((c) => c && c.name != null)
      .map((c) => [String(c.name).toLowerCase(), c.score])
  );
  const marcadas = record.competencias.map((name) => {
    const score = scorePorNombre.get(String(name).toLowerCase());
    return Number.isFinite(Number(score)) ? `${name} (${score}/10)` : String(name);
  });

  const competencias = marcadas.length ? marcadas.join(', ') : 'Sin foco definido';

  const notaOrigen = origenCompetencias === 'automatico'
    ? ' (deducidas de los scores de la sesión)'
    : '';

  // Asunto: "🔄 Solicitud de Reentrenamiento: Christian Soria • 01/08/2026 11:53 a.m."
  const prefijo = '🔄 Solicitud de Reentrenamiento: ';
  const sufijo = ` • ${formatDateLocal(ahora)} ${formatTimezoneCancun(ahora)}`;
  const subject = `${prefijo}${fitNombre(nombre, prefijo.length + sufijo.length)}${sufijo}`;

  const notas = notasDelGerente(record);

  //
  // Cada fila declara su hueco. Antes el correo mostraba "—" para lo que no
  // llegó y, al mismo tiempo, un módulo y un desempeño que el mapeo había
  // rellenado con defaults: unos huecos se veían y otros no.
  const detalles = [
    ['Módulo', String(s.modulo || SIN_DATO)],
    ['Fecha de Sesión Original', String(s.fecha_sesion || SIN_DATO)],
    ['Hora', s.hora_cancun ? `${s.hora_cancun} (America/Cancun)` : SIN_DATO],
    ['Duración', String(s.duracion_humana || SIN_DATO)],
    ['Desempeño General', Number.isFinite(Number(s.score_overall))
      ? `${s.score_overall}/10`
      : 'Pendiente de evaluación'],
    ['Competencias a Mejorar', `${competencias}${notaOrigen}`]
  ];

  // ── Texto plano ─────────────────────────────────────────────
  const text = [
    'Solicitud de Reentrenamiento Registrada',
    '',
    '✅ Hemos registrado tu solicitud de reentrenamiento.',
    '',
    '👤 EMPLEADO:',
    `${nombre} (${s.empleado_id || SIN_DATO})`,
    `Departamento: ${s.departamento || SIN_DATO}`,
    '',
    '📅 DETALLES:',
    ...detalles.map(([k, v]) => `• ${k}: ${v}`),
    '',
    '📝 NOTAS DEL GERENTE:',
    ...(notas.length
      ? notas.map(([etiqueta, texto]) => (etiqueta ? `${etiqueta}: ${texto}` : texto))
      : ['(sin notas)']),
    '',
    '⏳ ESTADO:',
    'Tu sesión de reentrenamiento será programada dentro de los próximos días.',
    '',
    'ENLACES:',
    `• Reporte completo (PDF): ${links.pdf_download_url}`,
    `• Escuchar la sesión: ${links.pop_up_url}`,
    '',
    'Saludos,',
    'Victor IA — Programa de Desarrollo Profesional',
    '',
    `Folio ${record.id} · Prioridad ${record.prioridad} · `
      + `Solicitado el ${formatDateLong(ahora)} a las ${formatTimezoneCancun(ahora)} (America/Cancun)`
  ].join('\n');

  // ── HTML ────────────────────────────────────────────────────
  const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";
  const label = `${font};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#E5B33E;font-weight:700;margin:0 0 12px`;
  const para = `${font};font-size:14px;line-height:1.7;color:#E4E4E4;margin:0 0 14px`;

  const row = ([k, v]) => `<tr>
      <td style="${font};font-size:13px;color:#B8B8B8;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(k)}</td>
      <td style="${font};font-size:14px;color:#fff;font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(v)}</td>
    </tr>`;

  const notasHtml = notas.length
    ? notas.map(([etiqueta, texto]) => `
    <p style="${para}">${
  etiqueta ? `<strong style="color:#F2C766">${escapeHtml(etiqueta)}:</strong> ` : ''
}${escapeHtml(texto).replace(/\n/g, '<br>')}</p>`).join('')
    : `<p style="${para}">(sin notas)</p>`;

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#0D0D0D;padding:26px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:0 auto;background:#1A1A1A;border-radius:14px;overflow:hidden;border:1px solid rgba(229,179,62,.28)">

  <tr><td style="background:#262626;padding:28px 32px;border-bottom:3px solid #E5B33E">
    <p style="${font};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#E5B33E;font-weight:700;margin:0 0 8px">Victorious Travelers Club · Desarrollo Profesional</p>
    <h1 style="${font};font-size:22px;color:#fff;margin:0;font-weight:700">🔄 Solicitud de Reentrenamiento Registrada</h1>
    <p style="${font};font-size:14px;color:#B8B8B8;margin:8px 0 0">${escapeHtml(nombre)} · ${escapeHtml(String(s.modulo || SIN_DATO))} · prioridad ${escapeHtml(record.prioridad)}</p>
    <p style="${font};font-size:11px;color:#B8B8B8;margin:8px 0 0">Folio ${escapeHtml(record.id)}</p>
  </td></tr>

  <tr><td style="padding:28px 32px">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:rgba(16,185,129,.09);border-left:3px solid #10B981;border-radius:6px">
      <tr><td style="${font};font-size:14px;line-height:1.7;color:#E4E4E4;padding:14px 16px">✅ Hemos registrado tu solicitud de reentrenamiento.</td></tr>
    </table>

    <p style="${label}">👤 Empleado</p>
    <p style="${para};margin:0 0 4px"><strong style="color:#fff;font-size:16px">${escapeHtml(nombre)}</strong> <span style="color:#B8B8B8">(${escapeHtml(String(s.empleado_id || SIN_DATO))})</span></p>
    <p style="${para}">Departamento: ${escapeHtml(String(s.departamento || SIN_DATO))}</p>
    <div style="height:14px"></div>

    <p style="${label}">📅 Detalles</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px">
      ${detalles.map(row).join('')}
    </table>

    <p style="${label}">📝 Notas del gerente</p>
    ${notasHtml}
    <div style="height:14px"></div>

    <p style="${label}">⏳ Estado</p>
    <p style="${para}">Tu sesión de reentrenamiento será programada dentro de los próximos días.</p>

    <div style="border-top:1px solid rgba(229,179,62,.28);margin:8px 0 24px"></div>

    <a href="${escapeHtml(links.pdf_download_url)}" style="${font};display:inline-block;background:#E5B33E;color:#0D0D0D;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin:0 10px 10px 0">Ver el reporte completo</a>
    <a href="${escapeHtml(links.pop_up_url)}" style="${font};display:inline-block;color:#F2C766;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;border:1px solid rgba(229,179,62,.28)">Escuchar la sesión</a>

    <div style="border-top:1px solid rgba(229,179,62,.28);margin:24px 0"></div>

    <p style="${para};margin:0 0 4px">Saludos,</p>
    <p style="${para};margin:0"><strong style="color:#fff">Victor IA</strong> <span style="color:#B8B8B8">— Programa de Desarrollo Profesional</span></p>

  </td></tr>

  <tr><td style="background:#0D0D0D;padding:16px 32px;text-align:center;border-top:1px solid rgba(229,179,62,.22)">
    <p style="${font};font-size:11px;color:#B8B8B8;margin:0">Solicitado el ${escapeHtml(formatDateLong(ahora))} ${escapeHtml(formatTimezoneCancun(ahora))} (America/Cancun) · Folio ${escapeHtml(record.id)}</p>
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
 * @param {string} [options.notas]         Notas para el colaborador
 * @param {string} [options.notasGerente]  Notas adicionales para el gerente
 * @param {Array}  [options.competencias]
 * @param {string} [options.prioridad]
 * @param {string} [options.solicitante]
 * @param {string} [options.emailDestino]  A dónde mandar el correo; si no viene,
 *                                         se usan los gerentes de siempre
 * @returns {Promise<{success:boolean, record:object, recipients:string[], messageId:string|null, message:string}>}
 */
async function submitRetrainRequest(options = {}) {
  const conversationId = String(options.conversationId || '').trim();
  if (!conversationId) throw new Error('submitRetrainRequest: falta conversationId');

  const summary = options.summary || {};
  const recipients = managerRecipients(options.emailDestino);
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
    notasGerente: normalizeNotas(options.notasGerente),
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

  // Las mismas copias que el reporte: si Dirección recibe el reporte, tiene que
  // enterarse también de que se pidió repetir la práctica.
  const cc = retrainCc(recipients);

  const emailResult = await sendEmailWithAttachments({
    to: recipients,
    cc,
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
    cc,
    messageId: emailResult.messageId || null,
    message: `Solicitud enviada a ${recipients.join(', ')}.`
  };
}

module.exports = {
  managerRecipients,
  retrainCc,
  isValidEmail,
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