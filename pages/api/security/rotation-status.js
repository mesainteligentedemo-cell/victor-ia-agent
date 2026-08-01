/**
 * API ROUTE — GET /api/security/rotation-status
 *
 * Dashboard de auditoría de rotación de secretos.
 *
 * Devuelve:
 *   - last_rotation / next_rotation / days_remaining / overdue
 *   - historial completo (Supabase, si está configurado)
 *   - salud de la configuración (qué secretos existen, qué falta)
 *
 * Nunca devuelve valores de secretos NI material derivado de ellos:
 * solo presencia (configured) y longitud. Sin prefijo y sin fingerprint —
 * ambos permiten confirmar un secreto candidato sin conocerlo.
 *
 * Acceso: SIEMPRE autenticado. Exige `Authorization: Bearer <ROTATION_STATUS_TOKEN>`.
 * Si ROTATION_STATUS_TOKEN no está configurado, el endpoint responde 503:
 * fail-closed, nunca público.
 */

import crypto from 'crypto';
import { getRotationStatus } from '../../../src/server/rotation-log';

export const config = { api: { bodyParser: true } };

/**
 * Describe un secreto sin exponerlo ni permitir verificarlo.
 * `length` es metadato operativo (detecta una key truncada); no reduce
 * el espacio de búsqueda de forma útil.
 */
function describeSecret(name) {
  const v = process.env[name];
  if (!v) return { name, configured: false };
  return { name, configured: true, length: v.length };
}

/** Comparación en tiempo constante entre dos strings. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Extrae el token de Authorization: Bearer o del header X-Rotation-Token. */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-rotation-token'];
  return header ? String(header).trim() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Nunca cachear: la respuesta describe el estado de los secretos.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // ── Autenticación obligatoria (fail-closed) ──────────────────
  const gate = process.env.ROTATION_STATUS_TOKEN;
  if (!gate) {
    console.error('[ROTATION-STATUS] ROTATION_STATUS_TOKEN no configurado — endpoint deshabilitado');
    return res.status(503).json({
      success: false,
      error: 'Endpoint deshabilitado: falta ROTATION_STATUS_TOKEN en el servidor'
    });
  }

  const provided = extractToken(req);
  if (!provided || !safeEqual(provided, gate)) {
    console.warn('[ROTATION-STATUS] Acceso rechazado: token ausente o inválido');
    res.setHeader('WWW-Authenticate', 'Bearer realm="rotation-status"');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const status = await getRotationStatus();

    const secrets = [
      'VTC_SHARED_SECRET',
      'ROTATION_ADMIN_SECRET',
      'ELEVENLABS_API_KEY',
      'RESEND_API_KEY',
      'VERCEL_TOKEN',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_KEY'
    ].map(describeSecret);

    const missing = secrets.filter((s) => !s.configured).map((s) => s.name);

    // Capacidad real de automatización de cada key
    const automation = {
      VTC_SHARED_SECRET: { automatic: true, method: 'crypto.randomBytes(32)' },
      RESEND_API_KEY: { automatic: true, method: 'Resend API /api-keys' },
      ELEVENLABS_API_KEY: {
        automatic: false,
        method: 'manual',
        reason: 'ElevenLabs no expone creación de API keys por API',
        dashboard: 'https://elevenlabs.io/app/settings/api-keys'
      },
      VERCEL_ENV_PROPAGATION: {
        automatic: !!process.env.VERCEL_TOKEN,
        method: 'Vercel REST API v9/v10',
        reason: process.env.VERCEL_TOKEN ? undefined : 'Falta VERCEL_TOKEN'
      }
    };

    const warnings = [];
    if (status.overdue) warnings.push('Rotación VENCIDA — ejecutar cuanto antes');
    if (!status.last_rotation) warnings.push('Nunca se ha registrado una rotación');
    if (!process.env.ROTATION_ADMIN_SECRET) {
      warnings.push('ROTATION_ADMIN_SECRET no configurado — /api/rotate-keys usa VTC_SHARED_SECRET como fallback');
    }
    if (!status.supabase.configured) warnings.push('Supabase no configurado — sin histórico persistente');
    if (!process.env.VERCEL_TOKEN) warnings.push('VERCEL_TOKEN ausente — N8N debe propagar las env vars');

    return res.status(200).json({
      success: true,
      service: 'victor-ia-agent',
      environment: process.env.ENVIRONMENT || 'production',
      generated_at: new Date().toISOString(),

      rotation: {
        last_rotation: status.last_rotation,
        next_rotation: status.next_rotation,
        days_remaining: status.days_remaining,
        overdue: status.overdue,
        rotation_interval_days: status.rotation_interval_days,
        total_rotations: status.total_rotations,
        source: status.source
      },

      secrets,
      missing,
      automation,
      warnings,

      storage: {
        supabase_configured: status.supabase.configured,
        supabase_available: status.supabase.available,
        supabase_reason: status.supabase.reason,
        table: 'secret_rotation_log'
      },

      history: status.history
    });
  } catch (error) {
    console.error('[ROTATION-STATUS] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}