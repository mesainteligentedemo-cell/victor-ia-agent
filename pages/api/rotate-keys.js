/**
 * API ROUTE — POST /api/rotate-keys
 *
 * Endpoint de rotación automática de secretos. Lo invoca el workflow de N8N
 * "Victor IA Agent - Auto Key Rotation (90d)" cada 90 días.
 *
 * ════════ AUTENTICACIÓN ════════
 * HMAC-SHA256 sobre `${timestamp}.${rawBody}`, header:
 *     X-Rotation-Signature: t=<unix_seconds>,v0=<hex>
 *
 * Secreto usado (en orden de preferencia):
 *   1. ROTATION_ADMIN_SECRET  <- recomendado
 *   2. VTC_SHARED_SECRET      <- fallback
 *
 * ¿Por qué un secreto dedicado? Porque este endpoint ROTA VTC_SHARED_SECRET.
 * Si se autenticara con él, tras la primera rotación el llamador ya no podría
 * volver a firmar (problema del huevo y la gallina). ROTATION_ADMIN_SECRET es
 * estable y solo se rota con handoff explícito.
 *
 * Ventana anti-replay: 5 minutos.
 *
 * ════════ RESPUESTA ════════
 * { success, rotated_at, next_rotation, days_until_next, keys_rotated,
 *   keys_failed, manual_action_required, log, details }
 */

import crypto from 'crypto';
import { rotateAll } from '../../src/server/key-rotation';
import { logRotation } from '../../src/server/rotation-log';

export const config = {
  api: { bodyParser: false },
  maxDuration: 60
};

const MAX_BODY_BYTES = 256 * 1024;
const REPLAY_WINDOW_SECONDS = 300;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Valida la firma HMAC del disparador de rotación.
 * @returns {{ok:boolean, reason?:string}}
 */
function validateRotationSignature(rawBody, signature, secret) {
  if (!secret) return { ok: false, reason: 'server_secret_missing' };
  if (!signature) return { ok: false, reason: 'signature_missing' };

  try {
    let ts = null;
    let provided = null;

    if (signature.includes(',')) {
      for (const part of signature.split(',')) {
        const [k, v] = part.split('=');
        if (!k || v === undefined) continue;
        if (k.trim() === 't') ts = v.trim();
        if (k.trim() === 'v0') provided = v.trim();
      }
    } else {
      provided = signature.trim();
    }

    if (!provided) return { ok: false, reason: 'signature_malformed' };

    // Anti-replay
    if (ts) {
      const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
      if (!Number.isFinite(age)) return { ok: false, reason: 'timestamp_invalid' };
      if (age > REPLAY_WINDOW_SECONDS) return { ok: false, reason: 'timestamp_expired' };
    }

    const message = ts ? `${ts}.${rawBody}` : rawBody;
    const computed = crypto.createHmac('sha256', secret).update(message).digest('hex');

    return safeEqual(computed, provided) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch (error) {
    return { ok: false, reason: `validation_error: ${error.message}` };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  console.log(`[ROTATE] POST /api/rotate-keys @ ${new Date().toISOString()}`);

  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return res.status(400).json({ success: false, error: `Invalid body: ${error.message}` });
  }

  let body = {};
  try {
    body = rawBody && rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch (error) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  // ── AUTENTICACIÓN
  const secret = process.env.ROTATION_ADMIN_SECRET || process.env.VTC_SHARED_SECRET;
  const signature =
    req.headers['x-rotation-signature'] ||
    req.headers['x-hmac-signature'] ||
    req.headers['x-signature'] ||
    null;

  const auth = validateRotationSignature(rawBody, signature, secret);
  if (!auth.ok) {
    console.warn(`[ROTATE] Rechazado: ${auth.reason}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      reason: auth.reason,
      hint: 'Firma esperada: X-Rotation-Signature: t=<unix>,v0=<hmac_sha256(`${t}.${rawBody}`)>'
    });
  }

  // ── EJECUCIÓN
  try {
    const result = await rotateAll({
      rotateResend: body.rotate_resend !== false,
      pushToVercel: body.push_to_vercel !== false,
      redeploy: body.redeploy !== false,
      dryRun: body.dry_run === true,
      // Solo devolvemos valores nuevos si el orquestador los necesita para
      // propagarlos él mismo (p. ej. cuando el endpoint no tiene VERCEL_TOKEN).
      returnValues: body.return_values === true
    });

    const log = await logRotation({
      rotated_at: result.rotated_at,
      next_rotation: result.next_rotation,
      triggered_by: body.triggered_by || 'n8n-cron',
      keys_rotated: result.keys_rotated,
      keys_failed: result.keys_failed,
      manual_action_required: result.manual_action_required,
      status: result.status,
      duration_ms: result.duration_ms,
      details: result.details
    });

    const daysUntilNext = Math.round(
      (new Date(result.next_rotation).getTime() - Date.now()) / 86400000
    );

    const success = result.status !== 'failed';
    console.log(`[ROTATE] status=${result.status} rotated=${result.keys_rotated.join(',')}`);

    return res.status(success ? 200 : 500).json({
      success,
      status: result.status,
      rotated_at: result.rotated_at,
      next_rotation: result.next_rotation,
      days_until_next: daysUntilNext,
      rotation_interval_days: result.rotation_interval_days,
      keys_rotated: result.keys_rotated,
      keys_failed: result.keys_failed,
      manual_action_required: result.manual_action_required,
      duration_ms: result.duration_ms,
      log,
      details: result.details,
      new_values: result.new_values,
      dry_run: body.dry_run === true
    });
  } catch (error) {
    console.error('[ROTATE] Error no controlado:', error);

    await logRotation({
      triggered_by: body.triggered_by || 'n8n-cron',
      status: 'failed',
      keys_rotated: [],
      keys_failed: [{ key: 'ALL', reason: error.message }],
      details: { error: error.message }
    }).catch(() => {});

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}