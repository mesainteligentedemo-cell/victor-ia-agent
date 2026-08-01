/**
 * API ROUTE — GET /api/conversation/:id?t=<token>
 *
 * Datos de una sesión para las pantallas /player y /retrain.
 * Devuelve el resumen (scores, competencias, transcripción en burbujas);
 * nunca claves, nunca contexto interno de la KB.
 *
 * Acceso: token firmado obligatorio. Fail-closed.
 */

import { verifyReportToken, extractRequestToken } from '../../../src/server/report-links';
import { buildReportSummary } from '../../../src/server/rebuild-report';
import { managerRecipients } from '../../../src/server/retrain-request';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const conversationId = String(req.query.id || '').trim();
  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'Falta el conversation_id' });
  }

  const auth = verifyReportToken(conversationId, extractRequestToken(req));
  if (!auth.ok) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      reason: auth.reason,
      hint: 'Abre el enlace completo del reporte (incluye ?t=...). Los enlaces caducan.'
    });
  }

  res.setHeader('Cache-Control', 'private, max-age=300');

  try {
    const summary = await buildReportSummary(conversationId);
    // /retrain necesita decir a dónde llegará la solicitud ANTES de enviarla:
    // un formulario que no dice a quién notifica no se usa.
    return res.status(200).json({
      success: true,
      conversation: summary,
      retrain_destinatarios: managerRecipients()
    });
  } catch (error) {
    console.error(`[CONV-API] Error con ${conversationId}:`, error.message);
    const notFound = /no devolvió|404|not found/i.test(error.message);
    return res.status(notFound ? 404 : 502).json({
      success: false,
      error: notFound ? 'Conversación no encontrada' : 'No se pudo leer la conversación',
      detail: error.message
    });
  }
}