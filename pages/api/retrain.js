/**
 * API ROUTE — POST /api/retrain
 *
 * Ruta histórica de la solicitud de reentrenamiento. Sigue viva porque el
 * formulario y las integraciones ya publicadas apuntan aquí.
 *
 * Diferencia con /api/retrain-request: esta ruta EXIGE al menos una competencia
 * marcada (es un formulario de coach, que sabe qué quiere reforzar). La otra
 * acepta solo el conversation_id y deduce el foco de los scores.
 *
 * El registro, el correo y los destinatarios son EXACTAMENTE los mismos:
 * ambas delegan en src/server/retrain-request.js. Antes cada ruta armaba su
 * propio correo y bastaba tocar una para que el gerente recibiera dos formatos
 * distintos de la misma solicitud.
 */

import { verifyReportToken, extractRequestToken } from '../../src/server/report-links';
import { buildReportSummary } from '../../src/server/rebuild-report';
import { submitRetrainRequest, managerRecipients, MAX_NOTAS } from '../../src/server/retrain-request';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const conversationId = String(body.conversation_id || body.conversationId || '').trim();

  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'Falta conversation_id' });
  }

  const token = body.token || extractRequestToken(req);
  const auth = verifyReportToken(conversationId, token);
  if (!auth.ok) {
    console.warn(`[RETRAIN] Rechazado ${conversationId}: ${auth.reason}`);
    return res.status(401).json({ success: false, error: 'Unauthorized', reason: auth.reason });
  }

  const competencias = Array.isArray(body.competencias)
    ? body.competencias.map((c) => String(c).slice(0, 60)).filter(Boolean).slice(0, 12)
    : [];

  if (!competencias.length) {
    return res.status(400).json({
      success: false,
      error: 'Elige al menos una competencia a reforzar'
    });
  }

  const notas = String(body.notas || '');
  if (notas.length > MAX_NOTAS) {
    return res.status(400).json({
      success: false,
      error: `Las notas superan el máximo de ${MAX_NOTAS} caracteres`
    });
  }

  try {
    const summary = await buildReportSummary(conversationId);

    const result = await submitRetrainRequest({
      conversationId,
      summary,
      notas,
      competencias,
      prioridad: body.prioridad,
      solicitante: body.solicitante || null
    });

    console.log(
      `[RETRAIN] ${summary.nombre} (${conversationId}) · folio ${result.record.id} · ` +
      `prioridad ${result.record.prioridad} · competencias: ${competencias.join(', ')}`
    );

    return res.status(200).json({
      success: true,
      message: result.message,
      confirmacion: `Solicitud enviada a ${result.recipients.join(', ')}`,
      folio: result.record.id,
      conversation_id: conversationId,
      destinatarios: result.recipients,
      prioridad: result.record.prioridad,
      competencias: result.record.competencias,
      registrado_en: result.record.persisted,
      messageId: result.messageId
    });
  } catch (error) {
    console.error(`[RETRAIN] Error con ${conversationId}:`, error.message);
    return res.status(502).json({
      success: false,
      error: 'No se pudo registrar la solicitud',
      detail: error.message,
      folio: error.record ? error.record.id : null,
      destinatarios: managerRecipients()
    });
  }
}