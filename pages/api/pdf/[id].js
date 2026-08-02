/**
 * API ROUTE — GET /api/pdf/:id?t=<token>
 *
 * Descarga del PDF de un reporte ya generado. Es el destino del CTA
 * "Descargar PDF" que aparece en el correo y en el propio reporte.
 *
 * Estrategia en dos pasos:
 *   1. Caché en memoria (src/server/report-cache.js) — respuesta inmediata.
 *   2. Fallo de caché → se REGENERA desde ElevenLabs. La lambda se recicla y
 *      la caché se pierde; sin este camino, el enlace del PDF caducaría en
 *      minutos y volveríamos al 404 que estamos arreglando.
 *
 * Acceso: token firmado obligatorio (?t= o Authorization: Bearer). Fail-closed.
 */

import { getCachedReport, cacheReport } from '../../../src/server/report-cache';
import { verifyReportToken, extractRequestToken } from '../../../src/server/report-links';
import { generateHTMLReport } from '../../../src/server/report-generator';
import { generatePDF } from '../../../src/server/pdf-generator';
import { buildReportPayload } from '../../../src/server/rebuild-report';
import { buildAttachmentBasename } from '../../../src/server/email-sender';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const conversationId = String(req.query.id || '').trim();
  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'Falta el conversation_id' });
  }

  // ── Autorización ─────────────────────────────────────────────
  const auth = verifyReportToken(conversationId, extractRequestToken(req));
  if (!auth.ok) {
    console.warn(`[PDF-API] Acceso rechazado a ${conversationId}: ${auth.reason}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      reason: auth.reason,
      hint: 'Usa el enlace completo del reporte (incluye ?t=...). Los enlaces caducan.'
    });
  }

  try {
    // ── 1. Caché ───────────────────────────────────────────────
    const cached = getCachedReport(conversationId);
    if (cached && cached.pdf && cached.pdf.length) {
      return sendPdf(res, cached.pdf, cached.pdfFilename || fallbackName(cached.data, conversationId));
    }

    // ── 2. Regenerar ───────────────────────────────────────────
    console.log(`[PDF-API] Sin caché para ${conversationId} — regenerando reporte`);
    const data = await buildReportPayload(conversationId);
    const html = await generateHTMLReport(data);
    const pdf = await generatePDF(html, data);

    if (!pdf || !pdf.length) {
      throw new Error('El generador devolvió un PDF vacío');
    }

    const filename = fallbackName(data, conversationId);
    cacheReport(conversationId, { pdf, html, data, pdfFilename: filename });

    return sendPdf(res, pdf, filename);
  } catch (error) {
    console.error(`[PDF-API] Error generando PDF de ${conversationId}:`, error.message);
    return res.status(502).json({
      success: false,
      error: 'No se pudo generar el PDF del reporte',
      detail: error.message,
      conversation_id: conversationId
    });
  }
}

/**
 * Nombre de archivo coherente con el que viajó por correo.
 * Se pasa el payload entero para que el nombre lleve también el ID de empleado:
 * `Christian_Soria_123456_01082026_1153.pdf`.
 */
function fallbackName(data, conversationId) {
  const d = data || {};
  const base = buildAttachmentBasename(d, d.session_iso);
  return base ? `${base}.pdf` : `reporte_${conversationId}.pdf`;
}

function sendPdf(res, buffer, filename) {
  const safe = String(filename || 'reporte.pdf').replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  // El PDF de una sesión no cambia: se puede cachear en el navegador.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(200).send(buffer);
}