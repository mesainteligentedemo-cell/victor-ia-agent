/**
 * ROTATION LOG — Auditoría de rotación de secretos
 *
 * Persistencia en dos capas (ambas opcionales, degradan sin romper):
 *
 *  1. Supabase (histórico completo)  -> tabla `secret_rotation_log`
 *     Requiere: SUPABASE_URL + SUPABASE_SERVICE_KEY
 *     Migración: migrations/001_secret_rotation_log.sql
 *
 *  2. Vercel env vars (último estado) -> VTC_ROTATED_AT / VTC_NEXT_ROTATION
 *     Sirve como fuente de verdad mínima cuando Supabase no está configurado,
 *     porque el propio proceso de rotación ya escribe env vars en Vercel.
 *
 * Nunca lanza: un fallo de logging no debe abortar una rotación exitosa.
 */

const axios = require('axios');

const TABLE = 'secret_rotation_log';
const ROTATION_INTERVAL_DAYS = Number(process.env.ROTATION_INTERVAL_DAYS || 90);

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function isConfigured() {
  return !!supabaseConfig();
}

/** Fecha de la próxima rotación a partir de una fecha dada. */
function computeNextRotation(fromISO, days = ROTATION_INTERVAL_DAYS) {
  const from = fromISO ? new Date(fromISO) : new Date();
  const next = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

/**
 * Inserta un registro de rotación.
 * @param {object} entry
 * @returns {Promise<{persisted:boolean, reason?:string, id?:string}>}
 */
async function logRotation(entry) {
  const cfg = supabaseConfig();
  const row = {
    rotated_at: entry.rotated_at || new Date().toISOString(),
    next_rotation: entry.next_rotation || computeNextRotation(entry.rotated_at),
    triggered_by: entry.triggered_by || 'unknown',
    keys_rotated: entry.keys_rotated || [],
    keys_failed: entry.keys_failed || [],
    manual_action_required: entry.manual_action_required || [],
    status: entry.status || 'success',
    duration_ms: entry.duration_ms || null,
    details: entry.details || {},
    environment: process.env.ENVIRONMENT || 'production'
  };

  if (!cfg) {
    console.warn('[ROTATION-LOG] Supabase no configurado — registro solo en stdout');
    console.log('[ROTATION-LOG]', JSON.stringify(row));
    return { persisted: false, reason: 'supabase_not_configured' };
  }

  try {
    const res = await axios.post(`${cfg.url}/rest/v1/${TABLE}`, row, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      timeout: 10000
    });
    const id = Array.isArray(res.data) && res.data[0] ? res.data[0].id : undefined;
    console.log(`[ROTATION-LOG] Registrado en Supabase (id=${id})`);
    return { persisted: true, id };
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
    console.error('[ROTATION-LOG] Supabase insert falló:', detail);
    console.log('[ROTATION-LOG][fallback]', JSON.stringify(row));
    return { persisted: false, reason: detail };
  }
}

/**
 * Historial de rotaciones (más reciente primero).
 * @param {number} limit
 */
async function getRotationHistory(limit = 50) {
  const cfg = supabaseConfig();
  if (!cfg) return { available: false, reason: 'supabase_not_configured', history: [] };

  try {
    const res = await axios.get(`${cfg.url}/rest/v1/${TABLE}`, {
      params: { select: '*', order: 'rotated_at.desc', limit },
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      timeout: 10000
    });
    return { available: true, history: Array.isArray(res.data) ? res.data : [] };
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
    console.error('[ROTATION-LOG] Supabase select falló:', detail);
    return { available: false, reason: detail, history: [] };
  }
}

/**
 * Estado actual de la rotación. Combina Supabase (si existe) con las env vars
 * VTC_ROTATED_AT / VTC_NEXT_ROTATION que escribe el propio proceso de rotación.
 */
async function getRotationStatus() {
  const envRotatedAt = process.env.VTC_ROTATED_AT || null;
  const envNext = process.env.VTC_NEXT_ROTATION || null;

  const { available, history, reason } = await getRotationHistory(50);
  const last = history[0] || null;

  const lastRotation = (last && last.rotated_at) || envRotatedAt;
  const nextRotation =
    (last && last.next_rotation) || envNext || (lastRotation ? computeNextRotation(lastRotation) : null);

  let daysRemaining = null;
  let overdue = false;
  if (nextRotation) {
    const diffMs = new Date(nextRotation).getTime() - Date.now();
    daysRemaining = Math.round(diffMs / (24 * 60 * 60 * 1000));
    overdue = diffMs < 0;
  }

  return {
    last_rotation: lastRotation,
    next_rotation: nextRotation,
    days_remaining: daysRemaining,
    overdue,
    rotation_interval_days: ROTATION_INTERVAL_DAYS,
    source: available ? 'supabase' : envRotatedAt ? 'vercel_env' : 'none',
    supabase: { configured: isConfigured(), available, reason: reason || null },
    total_rotations: available ? history.length : envRotatedAt ? 1 : 0,
    history: available
      ? history.map((h) => ({
          rotated_at: h.rotated_at,
          next_rotation: h.next_rotation,
          triggered_by: h.triggered_by,
          status: h.status,
          keys_rotated: h.keys_rotated,
          keys_failed: h.keys_failed,
          manual_action_required: h.manual_action_required,
          duration_ms: h.duration_ms
        }))
      : []
  };
}

module.exports = {
  logRotation,
  getRotationHistory,
  getRotationStatus,
  computeNextRotation,
  isConfigured,
  ROTATION_INTERVAL_DAYS,
  TABLE
};