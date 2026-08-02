/**
 * SESSION VALIDATION — ¿Hay sesión suficiente para emitir un reporte?
 *
 * Este módulo existe por una razón concreta: una llamada de catorce segundos
 * en la que nadie dijo nada producía un reporte de Desarrollo Profesional
 * completo — con anillo de desempeño, seis competencias, plan de certificación
 * a 7 días y recomendación de "está listo para atender clientes de forma
 * autónoma". Ese documento lo archiva Recursos Humanos y lo firma un gerente.
 *
 * El mapeo (n8n-mapper.js) ya no INVENTA valores: los huecos se declaran. Pero
 * declarar huecos no alcanza cuando NO HAY SESIÓN. Un reporte cuyo contenido
 * real es "no se midió nada" no debe existir: ocupa un folio, llega por correo
 * con el nombre del colaborador y parece una evaluación.
 *
 * Las tres puertas, y por qué cada una:
 *
 *   1. DURACIÓN < 30 s      No hay práctica que evaluar. Es un clic accidental,
 *                           un micrófono que no abrió o una llamada que se cayó.
 *   2. SIN data_collection   El agente no devolvió NADA que evaluar. Sin sus
 *                           campos no hay competencias, ni scores, ni plan: el
 *                           reporte sería un cascarón con el nombre de alguien.
 *   3. TRANSCRIPCIÓN < 50    Sin conversación medible no hay nada que analizar
 *      palabras              ni que transcribir.
 *
 * Qué NO hace: no marca la petición como error del emisor. Una sesión corta es
 * un hecho legítimo, no un fallo de integración. Devolver 4xx haría que N8N y
 * ElevenLabs reintentaran en bucle una sesión que jamás va a mejorar. Por eso
 * el resultado sale con `statusCode: 200` y `skipped: true`: el webhook se dio
 * por recibido y se explica, en claro, por qué no hay reporte.
 *
 * Todos los umbrales son configurables por variable de entorno: el mínimo
 * razonable de una práctica de ventas no es el mismo en todos los módulos.
 */

/** Duración mínima, en segundos, para que una sesión se considere practicada. */
const MIN_DURACION_SEC = Number(process.env.MIN_SESSION_SECONDS || 30);

/** Palabras mínimas de transcripción para que haya algo que analizar. */
const MIN_TRANSCRIPT_WORDS = Number(process.env.MIN_TRANSCRIPT_WORDS || 50);

/**
 * Códigos de rechazo. Se exportan para que las pruebas y los consumidores
 * (N8N, el panel) puedan distinguir el motivo sin leer el texto en español.
 */
const MOTIVOS = {
  SESION_MUY_CORTA: 'SESION_MUY_CORTA',
  SIN_DATOS_DE_ANALISIS: 'SIN_DATOS_DE_ANALISIS',
  TRANSCRIPCION_INSUFICIENTE: 'TRANSCRIPCION_INSUFICIENTE'
};

/**
 * Cuenta palabras reales de un transcript.
 *
 * Se descartan las etiquetas de hablante ("Victor:", "Christian Soria:") porque
 * son del formato, no de lo que se habló: sin quitarlas, veinte turnos vacíos
 * sumarían cuarenta "palabras" y una sesión muda pasaría la puerta.
 *
 * @param {string} transcript
 * @returns {number}
 */
function countTranscriptWords(transcript) {
  const texto = String(transcript == null ? '' : transcript)
    // Etiqueta de hablante al inicio de cada línea
    .replace(/^\s*[^:\n]{1,60}:\s*/gm, ' ')
    // Marcadores de sistema y acotaciones de voz
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{\{?[^{}]*\}?\}/g, ' ');

  return texto
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean).length;
}

/**
 * ¿Trae el agente algo que evaluar?
 *
 * `data_collection_results` llega ya aplanado por extractDataCollection(), que
 * descarta los campos vacíos. Un objeto sin claves significa, literalmente, que
 * el agente no reportó ni un dato de la sesión.
 *
 * @param {object|null|undefined} dataCollection
 * @returns {boolean}
 */
function hasDataCollection(dataCollection) {
  if (!dataCollection || typeof dataCollection !== 'object') return false;
  return Object.keys(dataCollection).length > 0;
}

/**
 * Decide si la sesión da para emitir un reporte.
 *
 * El orden de las puertas no es casual: se comprueba primero lo más barato y
 * lo más determinante. Si la llamada duró catorce segundos, da igual lo que
 * haya mandado el agente.
 *
 * @param {object} input
 * @param {number|null} input.duracionSec    Duración MEDIDA (nunca estimada)
 * @param {object|null}  input.dataCollection Campos que devolvió el agente
 * @param {string}       [input.transcript]   Texto plano de la conversación
 * @returns {{ok:boolean, motivo?:string, error?:string, message?:string, detalle?:object}}
 */
function validateSessionForReport(input = {}) {
  const { duracionSec, dataCollection, transcript } = input;

  // ── 1 · Duración ────────────────────────────────────────────
  // `null` es "no se midió" y NO se rechaza aquí: el reporte sabe declararlo
  // como dato ausente, y bloquear por ello dejaría sin registro a sesiones
  // reales cuyo contador no llegó. Se rechaza lo que SÍ se midió y es corto.
  //
  // OJO: `Number(null)` es 0 —y 0 es finito—, así que los vacíos hay que
  // descartarlos ANTES de convertir. Sin este guardia, toda sesión sin
  // contador se leía como una llamada de cero segundos y quedaba rechazada
  // por "muy corta": exactamente el dato inventado que este módulo evita.
  const medida = duracionSec !== null && duracionSec !== undefined && duracionSec !== '';
  const segundos = medida ? Number(duracionSec) : NaN;
  if (Number.isFinite(segundos) && segundos < MIN_DURACION_SEC) {
    return {
      ok: false,
      motivo: MOTIVOS.SESION_MUY_CORTA,
      error: 'Sesión muy corta',
      message: `Sesión muy corta para análisis (${Math.round(segundos)} s). `
        + `Intenta una sesión de al menos ${MIN_DURACION_SEC} segundos.`,
      detalle: { duracion_sec: Math.round(segundos), minimo_sec: MIN_DURACION_SEC }
    };
  }

  // ── 2 · Datos del agente ────────────────────────────────────
  if (!hasDataCollection(dataCollection)) {
    return {
      ok: false,
      motivo: MOTIVOS.SIN_DATOS_DE_ANALISIS,
      error: 'Sin datos de análisis',
      message: 'El agente aún no envió calificaciones para esta sesión. '
        + 'No se emite reporte sin evaluación real.',
      detalle: { campos_recibidos: 0 }
    };
  }

  // ── 3 · Transcripción ───────────────────────────────────────
  const palabras = countTranscriptWords(transcript);
  if (palabras < MIN_TRANSCRIPT_WORDS) {
    return {
      ok: false,
      motivo: MOTIVOS.TRANSCRIPCION_INSUFICIENTE,
      error: 'Conversación insuficiente',
      message: `La conversación registrada es demasiado breve para analizarla `
        + `(${palabras} palabras). Intenta una sesión de práctica completa.`,
      detalle: { palabras, minimo_palabras: MIN_TRANSCRIPT_WORDS }
    };
  }

  return { ok: true };
}

module.exports = {
  validateSessionForReport,
  countTranscriptWords,
  hasDataCollection,
  MOTIVOS,
  MIN_DURACION_SEC,
  MIN_TRANSCRIPT_WORDS
};