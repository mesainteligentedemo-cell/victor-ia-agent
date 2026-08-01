/**
 * REPORT LINKS — URLs firmadas para los CTAs del reporte
 *
 * El reporte (PDF y correo) lleva tres enlaces:
 *   /api/pdf/:id     descarga del PDF
 *   /player?conv=:id reproductor con audio + transcripción
 *   /retrain?conv=:id solicitud de reentrenamiento
 *
 * Esos endpoints sirven datos de una sesión real (nombre del asesor, scores,
 * transcripción, audio). Sin firma, cualquiera con un conversation_id los
 * leería. Por eso cada enlace lleva `?t=<exp>.<hmac>`:
 *   - Ata el token a ESE conversation_id (no vale para otro).
 *   - Caduca (por defecto 90 días).
 *   - No se puede fabricar sin el secreto del servidor.
 *
 * Secreto (en orden de preferencia):
 *   1. REPORT_LINK_SECRET     <- recomendado: estable, dedicado a esto
 *   2. ROTATION_ADMIN_SECRET  <- estable
 *   3. VTC_SHARED_SECRET      <- funciona, pero rota cada 90 días: los enlaces
 *                                emitidos antes de una rotación dejan de valer
 *
 * Si no hay NINGÚN secreto, firmar falla y validar rechaza: fail-closed.
 */

const crypto = require('crypto');

/** Vigencia por defecto de un enlace de reporte. */
const DEFAULT_TTL_SECONDS = Number(process.env.REPORT_LINK_TTL_SECONDS || 90 * 24 * 3600);

/** @returns {string|null} */
function linkSecret() {
  return (
    process.env.REPORT_LINK_SECRET ||
    process.env.ROTATION_ADMIN_SECRET ||
    process.env.VTC_SHARED_SECRET ||
    null
  );
}

/** Comparación en tiempo constante. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeHash(conversationId, exp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${conversationId}.${exp}`)
    .digest('hex')
    .slice(0, 32); // 128 bits: de sobra para un enlace y mantiene la URL legible
}

/**
 * Firma un token para un conversation_id.
 * @param {string} conversationId
 * @param {number} [ttlSeconds]
 * @returns {string|null} `<exp>.<hmac>` o null si no hay secreto
 */
function signReportToken(conversationId, ttlSeconds) {
  const secret = linkSecret();
  if (!secret || !conversationId) return null;

  // Se acepta cualquier TTL numérico, incluido 0 o negativo: los tests y las
  // revocaciones necesitan poder emitir un token ya caducado. Solo un valor
  // no numérico cae al default.
  const ttl = Number.isFinite(Number(ttlSeconds)) ? Number(ttlSeconds) : DEFAULT_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `${exp}.${computeHash(conversationId, exp, secret)}`;
}

/**
 * Valida un token contra un conversation_id.
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyReportToken(conversationId, token) {
  const secret = linkSecret();
  if (!secret) return { ok: false, reason: 'server_secret_missing' };
  if (!conversationId) return { ok: false, reason: 'conversation_id_missing' };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'token_missing' };

  const [expRaw, provided] = token.split('.');
  if (!expRaw || !provided) return { ok: false, reason: 'token_malformed' };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'token_malformed' };
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'token_expired' };

  const expected = computeHash(conversationId, expRaw, secret);
  return safeEqual(expected, provided) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
}

/** Base pública del despliegue, sin barra final. */
function baseUrl() {
  const raw =
    process.env.PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'https://victor-ia-agent.vercel.app';
  return String(raw).replace(/\/+$/, '');
}

/**
 * Construye los tres CTAs firmados de un reporte.
 *
 * Si no hay secreto configurado los enlaces salen SIN token: seguirán llevando
 * a la página correcta, que responderá 401 y explicará qué falta. Es preferible
 * a un enlace roto (404) o a uno que exponga la sesión sin autenticar.
 *
 * @param {string} conversationId
 * @returns {{pop_up_url:string, pdf_download_url:string, retrain_url:string, link_token:string|null}}
 */
function buildReportLinks(conversationId) {
  const base = baseUrl();
  const id = encodeURIComponent(String(conversationId || ''));
  const token = signReportToken(conversationId);
  const q = token ? `&t=${encodeURIComponent(token)}` : '';
  const qFirst = token ? `?t=${encodeURIComponent(token)}` : '';

  return {
    pop_up_url: `${base}/player?conv=${id}${q}`,
    pdf_download_url: `${base}/api/pdf/${id}${qFirst}`,
    retrain_url: `${base}/retrain?conv=${id}${q}`,
    link_token: token
  };
}

/**
 * Extrae el token de una petición (query `?t=` o header Authorization).
 * @param {import('http').IncomingMessage & {query?:object}} req
 * @returns {string|null}
 */
function extractRequestToken(req) {
  if (!req) return null;
  const fromQuery = req.query && (req.query.t || req.query.token);
  if (fromQuery) return String(Array.isArray(fromQuery) ? fromQuery[0] : fromQuery);

  const auth = (req.headers && req.headers.authorization) || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

module.exports = {
  signReportToken,
  verifyReportToken,
  buildReportLinks,
  extractRequestToken,
  baseUrl,
  DEFAULT_TTL_SECONDS
};