/**
 * REBUILD REPORT — Reconstruye los datos de un reporte desde ElevenLabs
 *
 * ¿Por qué existe?
 *   Los CTAs del reporte (/api/pdf/:id, /player, /retrain) se abren horas o
 *   días después de que el pipeline procesó la llamada. Para entonces la caché
 *   en memoria de la lambda ya no existe. En vez de devolver 404, rehacemos el
 *   payload con la misma fuente de verdad que usó el pipeline: la conversación
 *   guardada en ElevenLabs.
 *
 *   Es exactamente el tramo 3→9 de api-process-call.js, sin webhook y sin
 *   correo. Reutiliza las MISMAS funciones para que el PDF regenerado sea
 *   idéntico al que se envió: si divergieran, el gerente vería dos reportes
 *   distintos de la misma sesión.
 */

const { mapElevenLabsData } = require('./n8n-mapper');
const ElevenLabsAPI = require('./elevenlabs-api');
const { extractDataCollection, generateChartsData, validateReportData } = require('./api-process-call');
const { getCachedReport } = require('./report-cache');

/**
 * Construye el payload completo del reporte de una conversación.
 *
 * @param {string} conversationId
 * @param {{useCache?:boolean, timeout?:number}} [options]
 * @returns {Promise<object>} datos listos para generateHTMLReport()
 */
async function buildReportPayload(conversationId, options = {}) {
  if (!conversationId) {
    throw new Error('buildReportPayload: falta conversationId');
  }

  // Si el pipeline dejó los datos en memoria, esos mandan: son los que
  // efectivamente se enviaron por correo.
  if (options.useCache !== false) {
    const cached = getCachedReport(conversationId);
    if (cached && cached.data) {
      console.log(`[REBUILD] Usando datos cacheados de ${conversationId}`);
      return cached.data;
    }
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('Falta ELEVENLABS_API_KEY: no se puede reconstruir el reporte');
  }

  console.log(`[REBUILD] Reconstruyendo ${conversationId} desde ElevenLabs...`);
  const api = new ElevenLabsAPI(process.env.ELEVENLABS_API_KEY, { timeout: options.timeout });

  const conversation = await api.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`ElevenLabs no devolvió la conversación ${conversationId}`);
  }

  const transcript = ElevenLabsAPI.normalizeTranscript(conversation);
  const transcriptTurns = ElevenLabsAPI.extractTurns(conversation);
  const collected = extractDataCollection(conversation);

  const mapped = mapElevenLabsData({
    ...collected,
    conversation_id: conversationId,
    transcript,
    transcript_turns: transcriptTurns,
    metadata: conversation.metadata,
    audio_url: conversation.audio_url
  });

  const data = {
    ...mapped,
    charts: generateChartsData(mapped, transcript, transcriptTurns),
    audio_url: conversation.audio_url,
    // Marca de procedencia: útil al depurar diferencias con el PDF original.
    rebuilt_at: new Date().toISOString(),
    rebuilt_from: 'elevenlabs'
  };

  const validation = validateReportData(data);
  if (!validation.ok) {
    throw new Error(`Datos insuficientes para reconstruir el reporte: ${validation.missing.join(', ')}`);
  }
  for (const aviso of validation.warnings) console.warn(`[REBUILD] ${aviso}`);

  console.log(
    `[REBUILD] ${conversationId} reconstruido: ${transcriptTurns.length} turnos, ` +
    `score ${data.score_overall}/10`
  );
  return data;
}

/**
 * Versión ligera para la UI: solo lo que /player y /retrain necesitan pintar.
 * No incluye el transcript crudo entero ni el contexto de KB — son megabytes
 * que el navegador no usa.
 *
 * @param {string} conversationId
 * @returns {Promise<object>}
 */
async function buildReportSummary(conversationId) {
  const d = await buildReportPayload(conversationId);

  return {
    conversationId: d.conversationId,
    nombre: d.nombre,
    // El correo de reentrenamiento identifica al empleado con nombre completo,
    // ID y departamento: sin los tres, el gerente no sabe a quién agendar.
    nombre_completo: d.nombre_completo || d.nombre,
    apellido: d.apellido,
    empleado_id: d.empleado_id,
    departamento: d.departamento,
    puesto: d.puesto,
    modulo: d.modulo,
    idioma: d.idioma,
    familia_nombre: d.familia_nombre,
    fecha_sesion: d.fecha_sesion,
    fecha_larga: d.fecha_larga,
    fecha_hora_larga: d.fecha_hora_larga,
    hora_cancun: d.hora_cancun,
    duracion_texto: d.duracion_texto,
    duracion_humana: d.duracion_humana,
    duracion_sec: d.duracion_sec,
    session_iso: d.session_iso,
    score_overall: d.score_overall,
    scoreTotal: d.scoreTotal,
    competencias: d.competencias,
    comp_alta: d.comp_alta,
    comp_baja: d.comp_baja,
    resumen: d.resumen,
    fortalezas_list: d.fortalezas_list,
    areas_list: d.areas_list,
    recomendacion_coach: d.recomendacion_coach,
    transcription: d.transcription,
    turnos: (d.transcription || []).length
  };
}

module.exports = { buildReportPayload, buildReportSummary };