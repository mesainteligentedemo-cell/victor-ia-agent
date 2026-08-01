/**
 * API ROUTE — POST /api/retrain-request
 *
 * Flujo corto de solicitud de reentrenamiento: basta con el conversation_id.
 * Las notas son opcionales y las competencias también — si no se marcan, se
 * deducen de los scores de la sesión (las que están por debajo del estándar).
 *
 * Qué hace, en orden:
 *   1. Valida el token firmado del reporte (mismo que /player y /api/pdf)
 *   2. Reconstruye el resumen de la sesión desde caché o ElevenLabs
 *   3. Crea el registro de la solicitud (Supabase si hay credenciales)
 *   4. Envía el correo al gerente con TODO el contexto
 *   5. Devuelve la confirmación con el folio y los destinatarios
 *
 * Destino del correo: RETRAIN_REQUEST_EMAIL (por defecto
 * mesainteligentedemo@gmail.com). Ver src/server/retrain-request.js.
 *
 * No re-dispara el pipeline de reportes: reprocesar la misma conversación
 * generaría un PDF idéntico. Lo que falta es que alguien AGENDE el coaching,
 * y eso es exactamente lo que notifica.
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
    return res.status(400).json({
      success: false,
      error: 'Falta conversation_id'
    });
  }

  // El token puede venir en el cuerpo (formulario) o en ?t= / Authorization.
  const token = body.token || extractRequestToken(req);
  const auth = verifyReportToken(conversationId, token);
  if (!auth.ok) {
    console.warn(`[RETRAIN-REQ] Rechazado ${conversationId}: ${auth.reason}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      reason: auth.reason,
      hint: 'Abre el enlace tal cual aparece en el reporte o en el correo (incluye ?t=…).'
    });
  }

  const notas = String(body.notas || body.notes || '');
  if (notas.length > MAX_NOTAS) {
    return res.status(400).json({
      success: false,
      error: `Las notas superan el máximo de ${MAX_NOTAS} caracteres`
    });
  }

  try {
    // Fuente de verdad del contexto: la misma sesión que se evaluó.
    const summary = await buildReportSummary(conversationId);

    const result = await submitRetrainRequest({
      conversationId,
      summary,
      notas,
      competencias: body.competencias,
      prioridad: body.prioridad,
      solicitante: body.solicitante || null
    });

    console.log(
      `[RETRAIN-REQ] ${summary.nombre} (${conversationId}) · folio ${result.record.id} · ` +
      `enviado a ${result.recipients.join(', ')}`
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
      messageId: result.messageId,
      asesor: {
        nombre: summary.nombre,
        empleado_id: summary.empleado_id,
        modulo: summary.modulo,
        score_overall: summary.score_overall,
        scoreTotal: summary.scoreTotal
      }
    });
  } catch (error) {
    console.error(`[RETRAIN-REQ] Error con ${conversationId}:`, error.message);

    // Si el registro llegó a crearse pero el correo falló, se dice: repetir la
    // solicitud a ciegas duplicaría filas sin que nadie se entere.
    const folio = error.record ? error.record.id : null;

    return res.status(502).json({
      success: false,
      error: 'No se pudo completar la solicitud',
      detail: error.message,
      folio,
      destinatarios: managerRecipients()
    });
  }
}