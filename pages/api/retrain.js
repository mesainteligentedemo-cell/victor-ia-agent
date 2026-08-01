/**
 * API ROUTE — POST /api/retrain
 *
 * Registra una solicitud de reentrenamiento y avisa al gerente por correo.
 *
 * No re-dispara el pipeline: reprocesar la misma conversación generaría un
 * reporte idéntico y otro correo con los mismos adjuntos. Lo que hace falta es
 * que alguien AGENDE la sesión de coaching, así que eso es lo que notifica.
 *
 * Acceso: token firmado del reporte (el mismo de /player y /api/pdf).
 */

import { verifyReportToken } from '../../src/server/report-links';
import { buildReportSummary } from '../../src/server/rebuild-report';
import { sendEmailWithAttachments, formatDateLocal, formatTimezoneCancun } from '../../src/server/email-sender';
import { buildReportLinks } from '../../src/server/report-links';

export const config = { maxDuration: 30 };

const PRIORIDADES = { alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };
const MAX_NOTAS = 2000;

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveRecipients() {
  const raw = process.env.EMAIL_TO_PRIMARY || 'mesainteligentedemo@gmail.com';
  const list = String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['mesainteligentedemo@gmail.com'];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const conversationId = String(body.conversation_id || '').trim();

  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'Falta conversation_id' });
  }

  const auth = verifyReportToken(conversationId, body.token);
  if (!auth.ok) {
    console.warn(`[RETRAIN] Rechazado ${conversationId}: ${auth.reason}`);
    return res.status(401).json({ success: false, error: 'Unauthorized', reason: auth.reason });
  }

  // ── Validación de entrada ────────────────────────────────────
  const competencias = Array.isArray(body.competencias)
    ? body.competencias.map((c) => String(c).slice(0, 60)).filter(Boolean).slice(0, 12)
    : [];

  if (!competencias.length) {
    return res.status(400).json({
      success: false,
      error: 'Elige al menos una competencia a reforzar'
    });
  }

  const prioridad = PRIORIDADES[String(body.prioridad || '').toLowerCase()] || 'MEDIA';
  const notas = String(body.notas || '').slice(0, MAX_NOTAS).trim();

  try {
    const s = await buildReportSummary(conversationId);
    const links = buildReportLinks(conversationId);
    const ahora = new Date();

    console.log(
      `[RETRAIN] ${s.nombre} (${conversationId}) · prioridad ${prioridad} · ` +
      `competencias: ${competencias.join(', ')}`
    );

    const recipients = resolveRecipients();
    const subject =
      `Reentrenamiento ${prioridad}: ${s.nombre} — ${competencias.join(', ')} ` +
      `(${formatDateLocal(ahora)})`;

    const text = [
      'Solicitud de reentrenamiento',
      '',
      `Asesor: ${s.nombre} (${s.empleado_id})`,
      `Módulo: ${s.modulo}`,
      `Sesión evaluada: ${s.fecha_sesion} ${s.hora_cancun} · ${s.duracion_texto} min`,
      `Desempeño: ${s.score_overall}/10 (${s.scoreTotal}%)`,
      '',
      `PRIORIDAD: ${prioridad}`,
      `COMPETENCIAS A REFORZAR: ${competencias.join(', ')}`,
      '',
      'NOTAS DEL SOLICITANTE:',
      notas || '(sin notas)',
      '',
      'RECOMENDACIÓN DEL COACH (de la sesión evaluada):',
      s.recomendacion_coach || '—',
      '',
      `Reporte PDF: ${links.pdf_download_url}`,
      `Reproductor:  ${links.pop_up_url}`,
      '',
      `Solicitado el ${formatDateLocal(ahora)} a las ${formatTimezoneCancun(ahora)} (America/Cancún)`,
      '',
      'Victor IA · Entrenamiento VTC Capacitación'
    ].join('\n');

    const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;background:#0a1721;padding:26px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:0 auto;background:#102435;border-radius:14px;overflow:hidden;border:1px solid rgba(212,175,55,.22)">
  <tr><td style="background:#1a3a52;padding:28px 32px;border-bottom:3px solid #d4af37">
    <p style="${font};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#d4af37;font-weight:700;margin:0 0 8px">Victorious Travelers Club · Elite Training</p>
    <h1 style="${font};font-size:22px;color:#fff;margin:0;font-weight:700">Solicitud de reentrenamiento</h1>
    <p style="${font};font-size:14px;color:#9db0c2;margin:6px 0 0">${escapeHtml(s.nombre)} · ${escapeHtml(s.modulo)} · prioridad ${escapeHtml(prioridad)}</p>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      ${[
        ['Asesor', `${s.nombre} (${s.empleado_id})`],
        ['Sesión evaluada', `${s.fecha_sesion} ${s.hora_cancun}`],
        ['Duración', `${s.duracion_texto} min`],
        ['Desempeño', `${s.score_overall}/10 (${s.scoreTotal}%)`],
        ['Prioridad', prioridad],
        ['Competencias', competencias.join(', ')]
      ].map(([k, v]) => `<tr>
        <td style="${font};font-size:13px;color:#9db0c2;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(k)}</td>
        <td style="${font};font-size:14px;color:#fff;font-weight:600;text-align:right;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)">${escapeHtml(v)}</td>
      </tr>`).join('')}
    </table>

    <p style="${font};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4af37;font-weight:700;margin:0 0 8px">Notas del solicitante</p>
    <p style="${font};font-size:14px;line-height:1.7;color:#dfe6ed;margin:0 0 22px">${escapeHtml(notas || '(sin notas)').replace(/\n/g, '<br>')}</p>

    <p style="${font};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4af37;font-weight:700;margin:0 0 8px">Recomendación del coach</p>
    <p style="${font};font-size:14px;line-height:1.7;color:#dfe6ed;margin:0 0 26px">${escapeHtml(s.recomendacion_coach || '—')}</p>

    <a href="${escapeHtml(links.pdf_download_url)}" style="${font};display:inline-block;background:#d4af37;color:#0d1b26;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;margin-right:10px">Ver el reporte</a>
    <a href="${escapeHtml(links.pop_up_url)}" style="${font};display:inline-block;color:#e6c869;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;border:1px solid rgba(212,175,55,.22)">Escuchar la sesión</a>
  </td></tr>
  <tr><td style="background:#0a1721;padding:16px 32px;text-align:center;border-top:1px solid rgba(212,175,55,.18)">
    <p style="${font};font-size:11px;color:#6f8298;margin:0">Solicitado el ${escapeHtml(formatDateLocal(ahora))} ${escapeHtml(formatTimezoneCancun(ahora))} (America/Cancún)</p>
  </td></tr>
</table></body></html>`;

    const emailResult = await sendEmailWithAttachments({
      to: recipients,
      from: process.env.EMAIL_FROM || 'info@victor-ia.com.mx',
      subject,
      htmlBody: html,
      textBody: text,
      attachments: []
    });

    if (!emailResult.success) {
      throw new Error(emailResult.error || 'El correo de notificación no se envió');
    }

    return res.status(200).json({
      success: true,
      message: `Solicitud registrada y enviada a ${recipients.join(', ')}.`,
      conversation_id: conversationId,
      prioridad,
      competencias,
      messageId: emailResult.messageId
    });
  } catch (error) {
    console.error(`[RETRAIN] Error con ${conversationId}:`, error.message);
    return res.status(502).json({
      success: false,
      error: 'No se pudo registrar la solicitud',
      detail: error.message
    });
  }
}