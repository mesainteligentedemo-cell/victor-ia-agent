/**
 * API ROUTE — GET /api/audio/:id?t=<token>
 *
 * Sirve el MP3 de una conversación al reproductor de /player.
 * Actúa de proxy sobre ElevenLabs: así la ELEVENLABS_API_KEY nunca sale del
 * servidor (el navegador no puede pedirle el audio directamente sin ella).
 *
 * Acceso: token firmado obligatorio. Fail-closed.
 */

import { verifyReportToken, extractRequestToken } from '../../../src/server/report-links';
import ElevenLabsAPI from '../../../src/server/elevenlabs-api';

export const config = { maxDuration: 30, api: { responseLimit: false } };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const conversationId = String(req.query.id || '').trim();
  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'Falta el conversation_id' });
  }

  const auth = verifyReportToken(conversationId, extractRequestToken(req));
  if (!auth.ok) {
    return res.status(401).json({ success: false, error: 'Unauthorized', reason: auth.reason });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ success: false, error: 'Falta ELEVENLABS_API_KEY en el servidor' });
  }

  try {
    const api = new ElevenLabsAPI(process.env.ELEVENLABS_API_KEY);
    const buffer = await api.getAudio(conversationId, 20000);

    if (!buffer || !buffer.length) {
      return res.status(404).json({
        success: false,
        error: 'ElevenLabs no tiene audio para esta conversación'
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(buffer);
  } catch (error) {
    console.error(`[AUDIO-API] Error con ${conversationId}:`, error.message);
    return res.status(502).json({
      success: false,
      error: 'No se pudo obtener el audio',
      detail: error.message
    });
  }
}