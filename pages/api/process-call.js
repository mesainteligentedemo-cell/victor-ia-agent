/**
 * API ROUTE — POST /api/process-call
 *
 * Webhook receiver para ElevenLabs (post-call) y/o N8N.
 * Ejecuta el pipeline completo (transcript -> reporte -> PDF -> MP3 -> email).
 *
 * IMPORTANTE: bodyParser está desactivado a propósito.
 * El HMAC de ElevenLabs se firma sobre el RAW body; re-serializar el JSON
 * (JSON.stringify(req.body)) cambia los bytes y la firma nunca coincidiría.
 */

import { processCallWebhook } from '../../src/server/api-process-call';

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false
  }
};

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Lee el body crudo del request como string UTF-8.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Extrae la firma HMAC de los headers (ElevenLabs usa varios nombres según versión).
 * @param {object} headers
 * @returns {string|null}
 */
function extractSignature(headers) {
  return (
    headers['elevenlabs-signature'] ||
    headers['x-elevenlabs-signature'] ||
    headers['x-hmac-signature'] ||
    headers['x-signature'] ||
    null
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const receivedAt = new Date().toISOString();
  console.log(`[API] POST /api/process-call @ ${receivedAt}`);

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error('[API] Failed to read body:', error.message);
    return res.status(400).json({ success: false, error: `Invalid request body: ${error.message}` });
  }

  let body;
  try {
    body = rawBody && rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch (error) {
    console.error('[API] Invalid JSON payload:', error.message);
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  try {
    const signature = extractSignature(req.headers);
    const result = await processCallWebhook(body, signature, rawBody);

    return res.status(result && result.success ? 200 : 422).json(result);
  } catch (error) {
    console.error('[API] Unhandled error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}