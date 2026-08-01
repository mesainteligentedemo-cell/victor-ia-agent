/**
 * REPORT CACHE — Memoria de corta duración para los reportes ya generados
 *
 * ¿Para qué?
 *   Los CTAs del reporte (/api/pdf/:id, /player, /retrain) necesitan volver a
 *   servir el PDF y los datos de una sesión que ya se procesó. Sin caché, cada
 *   clic re-ejecutaría el pipeline completo: otra llamada a ElevenLabs y otro
 *   arranque de Chromium (~20s y coste real).
 *
 * Límites honestos:
 *   Es memoria del proceso. En Vercel cada instancia de la lambda tiene la suya
 *   y se pierde cuando el contenedor se recicla. Por eso NO es la fuente de
 *   verdad: /api/pdf/:id sabe regenerar el PDF desde cero si hay fallo de caché.
 *   Es un acelerador, no un almacén.
 *
 * Se acota por tiempo Y por bytes: un PDF ronda 1-3 MB y la lambda tiene
 * memoria finita — sin tope, unas pocas sesiones la tumbarían.
 */

const TTL_MS = Number(process.env.REPORT_CACHE_TTL_MS || 30 * 60 * 1000); // 30 min
const MAX_ENTRIES = Number(process.env.REPORT_CACHE_MAX_ENTRIES || 12);
const MAX_BYTES = Number(process.env.REPORT_CACHE_MAX_BYTES || 48 * 1024 * 1024); // 48 MB

/** @type {Map<string, {pdf:Buffer|null, html:string|null, data:object, pdfFilename:string|null, storedAt:number, bytes:number}>} */
const store = new Map();

/** Bytes aproximados que ocupa una entrada. */
function sizeOf(entry) {
  const pdf = entry.pdf ? entry.pdf.length : 0;
  const html = entry.html ? Buffer.byteLength(entry.html, 'utf8') : 0;
  return pdf + html;
}

/** Total de bytes retenidos ahora mismo. */
function totalBytes() {
  let total = 0;
  for (const entry of store.values()) total += entry.bytes;
  return total;
}

/** Elimina entradas caducadas. */
function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.storedAt > TTL_MS) store.delete(key);
  }
}

/**
 * Desaloja las entradas más antiguas hasta respetar los topes.
 * Map conserva el orden de inserción, así que la primera clave es la más vieja.
 */
function evictToFit() {
  while (store.size > MAX_ENTRIES || totalBytes() > MAX_BYTES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Guarda (o refresca) el reporte de una conversación.
 *
 * @param {string} conversationId
 * @param {{pdf?:Buffer|null, html?:string|null, data?:object, pdfFilename?:string|null}} payload
 * @returns {boolean} true si se guardó
 */
function cacheReport(conversationId, payload) {
  if (!conversationId || !payload) return false;

  try {
    evictExpired();

    const previo = store.get(String(conversationId));
    const entry = {
      // Un guardado parcial no debe borrar lo que ya teníamos (el pipeline
      // cachea dos veces: tras generar el PDF y tras conocer su nombre final).
      pdf: payload.pdf || (previo && previo.pdf) || null,
      html: payload.html || (previo && previo.html) || null,
      data: payload.data || (previo && previo.data) || null,
      pdfFilename: payload.pdfFilename || (previo && previo.pdfFilename) || null,
      storedAt: Date.now(),
      bytes: 0
    };
    entry.bytes = sizeOf(entry);

    // Re-insertar al final marca la entrada como la más reciente.
    store.delete(String(conversationId));
    store.set(String(conversationId), entry);
    evictToFit();

    console.log(
      `[CACHE] Reporte ${conversationId} guardado ` +
      `(${(entry.bytes / 1024).toFixed(0)} KB · ${store.size} en caché)`
    );
    return true;
  } catch (error) {
    // Nunca romper el pipeline por un fallo de caché.
    console.warn('[CACHE] No se pudo guardar el reporte:', error.message);
    return false;
  }
}

/**
 * Recupera el reporte de una conversación.
 * @param {string} conversationId
 * @returns {object|null} null si no está o si caducó
 */
function getCachedReport(conversationId) {
  if (!conversationId) return null;
  evictExpired();

  const entry = store.get(String(conversationId));
  if (!entry) {
    console.log(`[CACHE] MISS ${conversationId}`);
    return null;
  }

  console.log(`[CACHE] HIT ${conversationId} (edad ${Date.now() - entry.storedAt}ms)`);
  return entry;
}

/** Vacía la caché (tests y rotaciones). */
function clearReportCache() {
  store.clear();
}

/** Métricas de la caché, para /api/health y depuración. */
function cacheStats() {
  evictExpired();
  return {
    entries: store.size,
    bytes: totalBytes(),
    max_entries: MAX_ENTRIES,
    max_bytes: MAX_BYTES,
    ttl_ms: TTL_MS
  };
}

module.exports = { cacheReport, getCachedReport, clearReportCache, cacheStats };