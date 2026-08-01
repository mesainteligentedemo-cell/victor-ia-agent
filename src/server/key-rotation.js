/**
 * KEY ROTATION — Motor de rotación automática de secretos (cada 90 días)
 *
 * Qué se puede rotar de forma 100% automática:
 *   ✅ VTC_SHARED_SECRET  -> crypto.randomBytes(32).toString('hex')
 *   ✅ RESEND_API_KEY     -> Resend expone API de gestión de keys (POST/DELETE /api-keys)
 *   ❌ ELEVENLABS_API_KEY -> ElevenLabs NO expone creación de API keys (401 en
 *                            /v1/workspace/api-keys). Requiere acción manual en
 *                            el dashboard -> se reporta como manual_action_required.
 *
 * Propagación a Vercel: requiere VERCEL_TOKEN (+ VERCEL_PROJECT_ID / VERCEL_TEAM_ID).
 * Si no está presente, la rotación NO falla: devuelve los valores nuevos para que
 * el orquestador (N8N) los propague, y marca vercel.updated = false.
 *
 * IMPORTANTE: los valores nuevos solo toman efecto tras un redeploy.
 */

const crypto = require('crypto');
const axios = require('axios');

const VERCEL_API = 'https://api.vercel.com';

// ════════════════════════════════════════════
// GENERADORES
// ════════════════════════════════════════════

/** Nuevo shared secret HMAC (256 bits, hex). */
function generateSharedSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// ════════════════════════════════════════════
// VERCEL ENV VARS
// ════════════════════════════════════════════

function vercelConfig() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return null;
  return {
    token,
    projectId: process.env.VERCEL_PROJECT_ID || 'prj_d3sZH2XWVBRevDDkPRrfVAZegQSl',
    teamId: process.env.VERCEL_TEAM_ID || 'team_W8ML29QI3hNNEdQi5dZVQ771'
  };
}

function vercelHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
}

/** Lista las env vars del proyecto (sin descifrar valores). */
async function listVercelEnv(cfg) {
  const res = await axios.get(`${VERCEL_API}/v9/projects/${cfg.projectId}/env`, {
    params: { teamId: cfg.teamId },
    headers: vercelHeaders(cfg),
    timeout: 15000
  });
  return (res.data && res.data.envs) || [];
}

/**
 * Crea o actualiza una env var de producción (upsert).
 * @returns {Promise<{key:string, action:'created'|'updated'}>}
 */
async function upsertVercelEnv(cfg, key, value, existing) {
  const found = existing.find((e) => e.key === key && (e.target || []).includes('production'));

  if (found) {
    await axios.patch(
      `${VERCEL_API}/v9/projects/${cfg.projectId}/env/${found.id}`,
      { value, target: ['production'], type: 'encrypted' },
      { params: { teamId: cfg.teamId }, headers: vercelHeaders(cfg), timeout: 15000 }
    );
    return { key, action: 'updated' };
  }

  await axios.post(
    `${VERCEL_API}/v10/projects/${cfg.projectId}/env`,
    { key, value, type: 'encrypted', target: ['production'] },
    { params: { teamId: cfg.teamId, upsert: 'true' }, headers: vercelHeaders(cfg), timeout: 15000 }
  );
  return { key, action: 'created' };
}

/**
 * Propaga un mapa de env vars a Vercel.
 * @param {Record<string,string>} vars
 */
async function pushEnvToVercel(vars) {
  const cfg = vercelConfig();
  if (!cfg) {
    return { updated: false, reason: 'VERCEL_TOKEN no configurado', keys: Object.keys(vars) };
  }
  try {
    const existing = await listVercelEnv(cfg);
    const results = [];
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined || value === null || value === '') continue;
      results.push(await upsertVercelEnv(cfg, key, String(value), existing));
    }
    return { updated: true, results };
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
    return { updated: false, reason: detail, keys: Object.keys(vars) };
  }
}

/** Dispara un redeploy para que las env vars nuevas tomen efecto. */
async function triggerRedeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) return { triggered: false, reason: 'VERCEL_DEPLOY_HOOK_URL no configurado' };
  try {
    const res = await axios.post(hook, {}, { timeout: 15000 });
    return { triggered: true, job: res.data && res.data.job ? res.data.job.id : null };
  } catch (error) {
    return { triggered: false, reason: error.message };
  }
}

// ════════════════════════════════════════════
// RESEND API KEY
// ════════════════════════════════════════════

const RESEND_AUTO_PREFIX = 'victor-ia-agent-auto';

/**
 * Crea una API key nueva en Resend.
 *
 * NO borra las keys antiguas: el borrado se hace en `cleanupOldResendKeys()`
 * y SOLO después de confirmar que la key nueva quedó propagada a Vercel.
 *
 * Motivo (bug real evitado): si borráramos la key vieja aquí y la propagación
 * a Vercel fallara (p. ej. falta VERCEL_TOKEN), producción se quedaría con una
 * key ya eliminada -> el envío de reportes por email dejaría de funcionar.
 *
 * @returns {Promise<object>}
 */
async function rotateResendKey() {
  const current = process.env.RESEND_API_KEY;
  if (!current) return { rotated: false, reason: 'RESEND_API_KEY no configurada' };

  const name = `${RESEND_AUTO_PREFIX}-${new Date().toISOString().slice(0, 10)}`;
  const headers = { Authorization: `Bearer ${current}`, 'Content-Type': 'application/json' };

  try {
    // permission full_access para que la key nueva pueda rotar la siguiente vez
    const created = await axios.post(
      'https://api.resend.com/api-keys',
      { name, permission: 'full_access' },
      { headers, timeout: 15000 }
    );

    const newKey = created.data && created.data.token;
    const newId = created.data && created.data.id;
    if (!newKey) return { rotated: false, reason: 'Resend no devolvió token' };

    return { rotated: true, key: newKey, id: newId, name, cleanup_pending: true };
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
    return { rotated: false, reason: detail };
  }
}

/**
 * Borra las keys automáticas anteriores de Resend, conservando `keepId`.
 * Solo debe llamarse cuando la key nueva ya está activa en producción.
 *
 * Nunca toca keys creadas a mano (solo las que empiezan por el prefijo auto).
 *
 * @param {string} authKey Key con permisos para listar/borrar (la NUEVA)
 * @param {string} keepId  Id de la key que se conserva
 */
async function cleanupOldResendKeys(authKey, keepId) {
  const headers = { Authorization: `Bearer ${authKey}`, 'Content-Type': 'application/json' };
  const deleted = [];
  try {
    const list = await axios.get('https://api.resend.com/api-keys', { headers, timeout: 15000 });
    const olds = ((list.data && list.data.data) || []).filter(
      (k) => k.id !== keepId && String(k.name || '').startsWith(RESEND_AUTO_PREFIX)
    );
    for (const k of olds) {
      try {
        await axios.delete(`https://api.resend.com/api-keys/${k.id}`, { headers, timeout: 15000 });
        deleted.push(k.name);
      } catch (e) {
        console.warn(`[ROTATE] No se pudo borrar Resend key ${k.id}: ${e.message}`);
      }
    }
    return { cleaned: true, deleted };
  } catch (e) {
    console.warn('[ROTATE] Listado de Resend keys falló:', e.message);
    return { cleaned: false, reason: e.message, deleted };
  }
}

// ════════════════════════════════════════════
// ELEVENLABS (verificación, no rotación)
// ════════════════════════════════════════════

/**
 * ElevenLabs no permite crear API keys por API. Lo único que podemos hacer
 * automáticamente es VERIFICAR que la key actual sigue viva y avisar de que la
 * rotación es manual.
 */
async function checkElevenLabsKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { valid: false, reason: 'ELEVENLABS_API_KEY no configurada', manual: true };
  try {
    const res = await axios.get('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key },
      timeout: 15000
    });
    return {
      valid: true,
      manual: true,
      subscription: res.data && res.data.subscription ? res.data.subscription.tier : null,
      note: 'ElevenLabs no expone creación de API keys por API — rotar manualmente en el dashboard.'
    };
  } catch (error) {
    const status = error.response ? error.response.status : null;
    return { valid: false, manual: true, status, reason: error.message };
  }
}

// ════════════════════════════════════════════
// ORQUESTACIÓN
// ════════════════════════════════════════════

/**
 * Ejecuta la rotación completa.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.rotateResend=true]
 * @param {boolean} [opts.pushToVercel=true]
 * @param {boolean} [opts.redeploy=true]
 * @param {string}  [opts.triggeredBy='manual']
 * @param {boolean} [opts.dryRun=false]
 */
async function rotateAll(opts = {}) {
  const startedAt = Date.now();
  const rotatedAt = new Date().toISOString();
  const intervalDays = Number(process.env.ROTATION_INTERVAL_DAYS || 90);
  const nextRotation = new Date(startedAt + intervalDays * 86400000).toISOString();

  const rotated = [];
  const failed = [];
  const manual = [];
  const details = {};
  const newEnv = {};

  // ── 1. VTC_SHARED_SECRET (siempre, 100% automático)
  const newSecret = generateSharedSecret();
  newEnv.VTC_SHARED_SECRET = newSecret;
  rotated.push('VTC_SHARED_SECRET');
  details.vtc_shared_secret = { rotated: true, length: newSecret.length, algorithm: 'randomBytes(32).hex' };

  // ── 2. RESEND_API_KEY (automático vía API de Resend)
  // Solo se CREA aquí. El borrado de las keys viejas se difiere hasta confirmar
  // que la nueva quedó propagada (ver paso 7).
  let resend = null;
  if (opts.rotateResend !== false && !opts.dryRun) {
    resend = await rotateResendKey();
    details.resend = { rotated: resend.rotated, id: resend.id, name: resend.name, reason: resend.reason };
    if (resend.rotated) {
      newEnv.RESEND_API_KEY = resend.key;
      rotated.push('RESEND_API_KEY');
    } else {
      failed.push({ key: 'RESEND_API_KEY', reason: resend.reason });
    }
  } else {
    details.resend = { skipped: true, reason: opts.dryRun ? 'dry_run' : 'disabled' };
  }

  // ── 3. ELEVENLABS_API_KEY (manual — solo verificamos)
  const el = await checkElevenLabsKey();
  details.elevenlabs = el;
  manual.push({
    key: 'ELEVENLABS_API_KEY',
    reason: 'ElevenLabs no permite crear API keys por API',
    current_key_valid: el.valid,
    action: 'Rotar manualmente en https://elevenlabs.io/app/settings/api-keys y actualizar la env var en Vercel'
  });

  // ── 4. Marcadores de auditoría (persistencia mínima sin Supabase)
  newEnv.VTC_ROTATED_AT = rotatedAt;
  newEnv.VTC_NEXT_ROTATION = nextRotation;

  // ── 5. Propagar a Vercel
  let vercel = { updated: false, reason: 'deshabilitado' };
  if (opts.pushToVercel !== false && !opts.dryRun) {
    vercel = await pushEnvToVercel(newEnv);
    if (!vercel.updated) failed.push({ key: 'VERCEL_ENV_PUSH', reason: vercel.reason });
  }
  details.vercel = vercel;

  // ── 6. Redeploy para activar los valores nuevos
  let redeploy = { triggered: false, reason: 'deshabilitado' };
  if (opts.redeploy !== false && !opts.dryRun && vercel.updated) {
    redeploy = await triggerRedeploy();
  }
  details.redeploy = redeploy;

  // ── 7. Limpieza diferida de las keys viejas de Resend
  // SOLO si la key nueva ya quedó en producción. Si la propagación falló, las
  // conservamos: producción sigue usando la vieja y debe seguir funcionando.
  if (resend && resend.rotated) {
    if (vercel.updated) {
      const cleanup = await cleanupOldResendKeys(resend.key, resend.id);
      details.resend.cleanup = cleanup;
    } else {
      details.resend.cleanup = {
        cleaned: false,
        skipped: true,
        reason:
          'Propagación a Vercel no confirmada — se conservan las keys anteriores ' +
          'para no dejar producción sin una key válida. Propaga RESEND_API_KEY y ' +
          'vuelve a ejecutar la limpieza.'
      };
    }
  }

  const status = failed.length === 0 ? 'success' : rotated.length ? 'partial' : 'failed';

  return {
    status,
    rotated_at: rotatedAt,
    next_rotation: nextRotation,
    rotation_interval_days: intervalDays,
    keys_rotated: rotated,
    keys_failed: failed,
    manual_action_required: manual,
    duration_ms: Date.now() - startedAt,
    details,
    // Los valores nuevos solo se devuelven si el llamador los necesita para propagarlos.
    // NUNCA se loguean.
    new_values: opts.returnValues ? newEnv : undefined
  };
}

module.exports = {
  rotateAll,
  generateSharedSecret,
  rotateResendKey,
  cleanupOldResendKeys,
  checkElevenLabsKey,
  pushEnvToVercel,
  triggerRedeploy,
  listVercelEnv,
  vercelConfig
};