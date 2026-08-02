/**
 * EMAIL SENDER — Envía los reportes de capacitación con Resend
 *
 * Responsabilidades:
 * - Formatear fecha/hora en America/Cancun (UTC-5, sin horario de verano)
 * - Construir el asunto y el cuerpo del correo
 * - Nombrar los adjuntos (PDF + MP3) con la misma base: Nombre_dd_mm_aaaa_hh_mm_am
 * - Enviar con reintentos y backoff exponencial
 *
 * Nota de diseño: el cuerpo del correo NO es el reporte completo. El reporte
 * viaja como PDF adjunto; el correo es el resumen ejecutivo que se lee en el
 * teléfono en 20 segundos.
 */

const { Resend } = require('resend');

const TZ = 'America/Cancun';

/**
 * Meses con inicial mayúscula: el formato acordado para TODO el sistema es
 * "01 de Agosto de 2026" — día con cero a la izquierda y mes capitalizado.
 * Se usa igual en el correo, en el PDF y en la solicitud de reentrenamiento,
 * para que las tres piezas de la misma sesión digan la fecha de una sola forma.
 */
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

// ════════════════════════════════════════════════════════════
// FORMATO DE FECHA Y HORA
// ════════════════════════════════════════════════════════════

/**
 * Descompone una fecha en sus partes según el huso de Cancún.
 *
 * Se usa `Intl` con locale en-US a propósito: el dayPeriod de es-MX varía
 * entre versiones de ICU ("a.m.", "a. m." con espacio fino, "AM"), y aquí
 * necesitamos una salida estable para nombres de archivo.
 *
 * `hour` va en formato 12 h (lo que lee una persona) y `hour24` en 24 h (lo que
 * ordena bien un gestor de archivos). Los nombres de adjunto usan `hour24`: sin
 * el sufijo am/pm, "1153" de la mañana y "1153" de la tarde serían el MISMO
 * archivo y el segundo pisaría al primero.
 *
 * @param {Date|string|number} input
 * @returns {{year:string, month:string, day:string, hour:string, hour24:string, minute:string, ampm:string}}
 */
function cancunParts(input) {
  const date = toDate(input);

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;

    // hour12 + 2-digit devuelve "12" para medianoche/mediodía; nunca "00".
    const esPM = String(p.dayPeriod || '').toUpperCase() === 'PM';
    const h12 = Number(p.hour);

    return {
      year: p.year,
      month: p.month,
      day: p.day,
      hour: String(p.hour).padStart(2, '0'),
      hour24: String(to24h(h12, esPM)).padStart(2, '0'),
      minute: p.minute,
      ampm: esPM ? 'p.m.' : 'a.m.'
    };
  } catch (error) {
    // Fallback sin Intl/tzdata: Cancún es UTC-5 fijo desde 2015 (sin DST)
    console.warn('[EMAIL] Intl con timeZone no disponible, usando offset fijo UTC-5:', error.message);
    const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    const h24 = shifted.getUTCHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return {
      year: String(shifted.getUTCFullYear()),
      month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
      day: String(shifted.getUTCDate()).padStart(2, '0'),
      hour: String(h12).padStart(2, '0'),
      hour24: String(h24).padStart(2, '0'),
      minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
      ampm: h24 >= 12 ? 'p.m.' : 'a.m.'
    };
  }
}

/** Convierte una hora de 12 h + periodo a 24 h (12 a.m. → 0, 12 p.m. → 12). */
function to24h(h12, esPM) {
  const h = Number(h12);
  if (!Number.isFinite(h)) return 0;
  if (esPM) return h === 12 ? 12 : h + 12;
  return h === 12 ? 0 : h;
}

/** Normaliza cualquier entrada a Date válida (fallback: ahora). */
function toDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (input === null || input === undefined || input === '') return new Date();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Hora en America/Cancun, formato 12 horas.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "06:26 a.m."
 */
function formatTimezoneCancun(input) {
  const p = cancunParts(input);
  return `${p.hour}:${p.minute} ${p.ampm}`;
}

/**
 * Fecha local (Cancún) en formato dd/mm/aaaa.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "01/08/2026"
 */
function formatDateLocal(input) {
  const p = cancunParts(input);
  return `${p.day}/${p.month}/${p.year}`;
}

/**
 * Fecha larga en español, con día de dos dígitos y mes capitalizado.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "01 de Agosto de 2026"
 */
function formatDateLong(input) {
  const p = cancunParts(input);
  const mes = MESES[Number(p.month) - 1] || p.month;
  return `${p.day} de ${mes} de ${p.year}`;
}

/**
 * Fecha y hora larga, el formato de cabecera del sistema.
 * @param {Date|string|number} [input]
 * @returns {string} p. ej. "01 de Agosto de 2026 • 11:53 a.m."
 */
function formatDateTimeLong(input) {
  return `${formatDateLong(input)} • ${formatTimezoneCancun(input)}`;
}

/**
 * Duración en palabras, que es como la lee un gerente.
 *
 * "9:30" no dice nada en un correo: parece una hora. "9 minutos 30 segundos"
 * se entiende sin pensar. Los segundos solo aparecen cuando existen.
 *
 * @param {number} segundos Duración real de la sesión
 * @returns {string} p. ej. "9 minutos 30 segundos" · "1 minuto" · "45 segundos"
 */
function formatDuracion(segundos) {
  const total = Math.max(0, Math.round(Number(segundos) || 0));
  if (!total) return '0 minutos';

  const min = Math.floor(total / 60);
  const seg = total % 60;

  const partes = [];
  if (min) partes.push(`${min} ${min === 1 ? 'minuto' : 'minutos'}`);
  if (seg) partes.push(`${seg} ${seg === 1 ? 'segundo' : 'segundos'}`);
  return partes.join(' ');
}

/**
 * Nombre limpio para un archivo: sin acentos, sin espacios, sin reservados de
 * Windows. "Christian Soria" -> "Christian_Soria".
 */
function slugFilePart(value, fallback) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')   // acentos fuera: sobreviven a cualquier cliente de correo
    .replace(/[^A-Za-z0-9]+/g, '_')   // sin espacios ni caracteres reservados en Windows
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || fallback;
}

/**
 * Base compartida por el PDF y el MP3 — así ambos adjuntos se ordenan juntos
 * en el gestor de archivos del gerente.
 *
 * Formato: `Nombre_Apellido_ID_DDMMAAAA_HHMM`
 *   -> "Christian_Soria_123456_01082026_1153"
 *
 * La hora va en 24 h: es lo único que ordena bien y lo único que no colisiona
 * (sin am/pm, dos sesiones a las 11:53 se pisarían).
 *
 * Acepta el objeto de datos completo o, por compatibilidad con las llamadas
 * antiguas, el nombre suelto más el id como tercer argumento.
 *
 * @param {object|string} input Datos del reporte, o el nombre del asesor
 * @param {Date|string|number} [when] Momento de la sesión
 * @param {string} [idFallback] ID de empleado, si `input` fue un string
 * @returns {string} p. ej. "Christian_Soria_123456_01082026_1153"
 */
function buildAttachmentBasename(input, when, idFallback) {
  const p = cancunParts(when);

  const esObjeto = input !== null && typeof input === 'object';
  // Prioridad: nombre_completo > nombre (siempre el nombre COMPLETO del roster)
  const nombreCompleto = esObjeto ? (input.nombre_completo || input.nombre) : input;
  const id = esObjeto ? (input.empleado_id || idFallback) : idFallback;

  // Convertir nombre completo a formato seguro para archivo:
  // "Andrés Mateos" → "Andres_Mateos"
  // "Christian Soria" → "Christian_Soria"
  // Elimina acentos y reemplaza espacios por guiones bajos.
  //
  // Sin identidad el archivo se llama "Sin_Identificar_…" y no "Asesor_…": el
  // segundo parece el reporte de alguien; el primero avisa de que la sesión
  // llegó sin datos del colaborador y hay que revisar el formulario.
  const safeName = String(nombreCompleto || 'Sin Identificar')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')      // Quitar acentos
    .replace(/\s+/g, '_')                // Espacios → guiones bajos
    .replace(/[^A-Za-z0-9_]/g, '')       // Eliminar otros caracteres especiales
    .replace(/^_+|_+$/g, '');            // Quitar guiones al inicio/final

  const safeId = String(id || '').trim();

  const fecha = `${p.day}${p.month}${p.year}`;   // DDMMAAAA
  const hora = `${p.hour24}${p.minute}`;         // HHMM en 24 h

  // Siempre incluir nombre_completo + ID + fecha + hora
  // Nunca dejar nombres de archivo genéricos como "Asesor"
  return [safeName, safeId, fecha, hora].filter(Boolean).join('_');
}

// ════════════════════════════════════════════════════════════
// ASUNTO Y CUERPO
// ════════════════════════════════════════════════════════════

/**
 * Techo del asunto.
 *
 * Gmail corta alrededor de los 70 caracteres en escritorio y bastante antes en
 * móvil. El asunto se arma para que lo importante — de QUIÉN es el reporte —
 * quepa siempre: si el nombre es largo, se recorta el nombre, nunca la fecha.
 */
const SUBJECT_MAX = 78;

/**
 * Texto que se muestra cuando un dato NO llegó.
 *
 * Es la contraparte de la regla "no inventar": el hueco se declara, no se
 * rellena. Quien lee sabe que el sistema no lo recibió, en vez de creerse un
 * valor de fábrica.
 */
const SIN_DATO = 'No disponible';
const SIN_EVALUACION = 'Pendiente de evaluación';

/** Nombre completo del asesor, o la declaración de que no se identificó. */
function nombreCompleto(d) {
  const data = d || {};
  const n = String(data.nombre_completo || data.nombre || '').trim();
  return n || 'Colaborador sin identificar';
}

/**
 * Identidad en corto, para el asunto y los nombres de archivo.
 *
 * "Colaborador sin identificar" son 27 caracteres: en el asunto se comía el
 * espacio de la fecha y quedaba recortado en "Colaborador sin…", que no
 * comunica nada. Aquí se dice lo mismo en la mitad de espacio.
 */
function nombreCorto(d) {
  const data = d || {};
  const n = String(data.nombre_completo || data.nombre || '').trim();
  return n || 'Sin identificar';
}

/**
 * Recorta un nombre para que el asunto entero quepa, sin cortar a media palabra
 * si se puede evitar.
 */
function fitNombre(nombre, resto) {
  const disponible = SUBJECT_MAX - resto;
  if (nombre.length <= disponible) return nombre;
  if (disponible < 8) return nombre.slice(0, Math.max(1, disponible));

  const cortado = nombre.slice(0, disponible - 1);
  const espacio = cortado.lastIndexOf(' ');
  return `${(espacio > 4 ? cortado.slice(0, espacio) : cortado).trim()}…`;
}

/**
 * Asunto del correo del reporte.
 * Formato: "Reporte de Desarrollo Profesional: Christian Soria • 01/08/2026 11:53 a.m."
 *
 * @param {object} data Datos del reporte
 * @param {Date|string|number} [when] Momento de la sesión
 */
function buildEmailSubject(data, when) {
  const prefijo = 'Reporte de Desarrollo Profesional: ';
  const sufijo = ` • ${formatDateLocal(when)} ${formatTimezoneCancun(when)}`;
  return `${prefijo}${fitNombre(nombreCorto(data), prefijo.length + sufijo.length)}${sufijo}`;
}

/** ¿El correo lleva el MP3 de la sesión? Por defecto sí; el pipeline lo confirma. */
function tieneAudio(options) {
  return !options || options.hasAudio !== false;
}

/**
 * Duración de la sesión en palabras, con los datos que traiga el mapeo.
 * Prefiere los segundos exactos; si no vienen, reconstruye desde "mm:ss".
 */
function duracionTexto(d) {
  const data = d || {};
  if (data.duracion_humana) return String(data.duracion_humana);

  const segs = Number(data.duracion_sec);
  if (Number.isFinite(segs) && segs > 0) return formatDuracion(segs);

  const m = String(data.duracion_texto || '').match(/^(\d+):(\d{1,2})$/);
  if (m) return formatDuracion(Number(m[1]) * 60 + Number(m[2]));

  const mins = Number(data.duracion_minutos);
  if (Number.isFinite(mins) && mins > 0) return formatDuracion(mins * 60);

  return SIN_DATO;
}

/**
 * Desempeño global tal como se muestra en el correo.
 *
 * `Number(undefined) || 0` devolvía 0 y el correo anunciaba "Desempeño General:
 * 0%" —en rojo— para sesiones que nadie había evaluado. Un 0% acusa a la
 * persona de haberlo hecho mal; lo cierto es que no hay calificación.
 *
 * @returns {string} El porcentaje, o "Pendiente de evaluación"
 */
function scorePctTexto(d) {
  const data = d || {};

  if (data.scoreTotal !== null && data.scoreTotal !== undefined
      && Number.isFinite(Number(data.scoreTotal))) {
    return `${Number(data.scoreTotal)}%`;
  }

  if (data.score_overall !== null && data.score_overall !== undefined
      && Number.isFinite(Number(data.score_overall))) {
    return `${Math.round((Number(data.score_overall) / 10) * 100)}%`;
  }

  return SIN_EVALUACION;
}

/**
 * Las filas de "DETALLES DE LA SESIÓN". Una sola definición para el texto plano
 * y para el HTML: si vivieran por separado, tarde o temprano dirían cosas
 * distintas del mismo dato.
 *
 * @returns {Array<[string,string]>}
 */
/**
 * Etiqueta de la fila del desempeño. Vive en una constante porque la usan DOS
 * sitios: la tabla de detalles y el coloreado de esa misma fila en el HTML.
 */
const ETIQUETA_DESEMPENO = 'Desempeño General';

function detallesSesion(d, when) {
  const data = d || {};
  const nombre = nombreCompleto(data);
  const id = data.empleado_id ? ` (${data.empleado_id})` : '';

  return [
    ['Colaborador', `${nombre}${id}`],
    ['Departamento', String(data.departamento || SIN_DATO)],
    ['Módulo', String(data.modulo || SIN_DATO)],
    // Fecha y hora SIEMPRE vienen del webhook: son la única excepción con
    // respaldo garantizado (el instante de proceso, en el huso de Cancún).
    ['Fecha', formatDateLong(when)],
    ['Hora', `${formatTimezoneCancun(when)} (America/Cancun)`],
    ['Duración', duracionTexto(data)],
    [ETIQUETA_DESEMPENO, scorePctTexto(data)]
  ];
}

// ════════════════════════════════════════════════════════════
// TRANSCRIPCIÓN DEL CORREO
// ════════════════════════════════════════════════════════════

/**
 * Cuántas intervenciones caben en el correo.
 *
 * Una sesión de treinta minutos son ~260 turnos: pegarlos íntegros deja un
 * correo que Gmail recorta con un "ver mensaje completo" y que nadie despliega.
 * El registro completo viaja siempre en el PDF; aquí van las primeras
 * intervenciones y una línea que dice dónde está el resto.
 */
const TRANSCRIPT_EMAIL_MAX = 40;

/**
 * Normaliza la transcripción a bloques listos para imprimir.
 *
 * Cada elemento es una intervención independiente: quién habla, en qué minuto y
 * qué dijo. La limpieza de símbolos de sistema ocurre aguas arriba, en
 * `cleanTurnText` (src/server/n8n-mapper.js); aquí se vuelve a barrer por
 * seguridad, porque el correo puede recibir datos de integraciones antiguas que
 * no pasaron por el mapeo actual.
 *
 * @param {object} d Datos del reporte
 * @returns {{bloques:Array<{speaker:string,timestamp:string,text:string}>, total:number, omitidos:number}}
 */
function transcripcionBloques(d) {
  const turnos = Array.isArray(d && d.transcription) ? d.transcription : [];

  const limpio = (valor) => String(valor == null ? '' : valor)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[<>[\]]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const bloques = turnos
    .map((t) => ({
      speaker: limpio(t && t.speaker) || 'Participante',
      timestamp: limpio(t && t.timestamp),
      text: limpio(t && t.text)
    }))
    .filter((t) => t.text);

  return {
    bloques: bloques.slice(0, TRANSCRIPT_EMAIL_MAX),
    total: bloques.length,
    omitidos: Math.max(0, bloques.length - TRANSCRIPT_EMAIL_MAX)
  };
}

/**
 * La transcripción en texto plano, un bloque por intervención:
 *
 *   VICTOR (00:03)
 *   Buenas tardes, bienvenidos.
 *
 *   CHRISTIAN SORIA (00:11)
 *   Muchas gracias.
 *
 * @returns {string[]} Líneas listas para unir con '\n'
 */
function transcripcionTexto(d) {
  const { bloques, total, omitidos } = transcripcionBloques(d);
  if (!bloques.length) return [];

  const lineas = ['', '💬 TRANSCRIPCIÓN DE LA SESIÓN:'];

  bloques.forEach((t) => {
    lineas.push('');
    lineas.push(t.timestamp ? `${t.speaker.toUpperCase()} (${t.timestamp})` : t.speaker.toUpperCase());
    lineas.push(t.text);
  });

  if (omitidos) {
    lineas.push('');
    lineas.push(`(Se muestran las primeras ${bloques.length} de ${total} intervenciones. `
      + 'La conversación completa está en el reporte adjunto.)');
  }

  return lineas;
}

/**
 * Datos que el sistema de evaluación NO entregó para esta sesión.
 *
 * Antes cada uno de estos huecos se tapaba con un valor de fábrica —un 8 de
 * desempeño, nueve minutos y medio de duración, el módulo "Meet & Greet"— y el
 * correo se leía como un reporte completo. Declararlos es lo que separa un
 * reporte honesto de uno que parece bueno.
 *
 * @param {object} d
 * @returns {string[]} Etiquetas de lo que falta (vacío si llegó todo)
 */
function datosFaltantes(d) {
  const data = d || {};
  if (Array.isArray(data.campos_sin_dato)) return data.campos_sin_dato.filter(Boolean);

  // Respaldo para payloads que no pasaron por el mapeo actual.
  const faltan = [];
  if (!data.nombre_completo && !data.nombre) faltan.push('Nombre del colaborador');
  if (!data.empleado_id) faltan.push('Número de empleado');
  if (!data.departamento) faltan.push('Departamento');
  if (!data.modulo) faltan.push('Módulo');
  if (!Number.isFinite(Number(data.duracion_sec))) faltan.push('Duración');
  if (data.score_overall === null || data.score_overall === undefined) faltan.push('Desempeño general');
  return faltan;
}

/** ¿Trae el reporte una evaluación real del desempeño? */
function hayEvaluacion(d) {
  const data = d || {};
  if (typeof data.evaluacion_disponible === 'boolean') return data.evaluacion_disponible;
  return data.score_overall !== null
    && data.score_overall !== undefined
    && Number.isFinite(Number(data.score_overall));
}

/**
 * Frase de apertura del correo.
 *
 * "Ha concluido satisfactoriamente" es un juicio sobre cómo salió la sesión.
 * Cuando nadie la evaluó, el correo no está en posición de emitirlo — y menos
 * en el mismo mensaje donde acaba de declarar que no hay calificación.
 */
function fraseApertura(d) {
  return hayEvaluacion(d)
    ? 'Su sesión de práctica ha concluido satisfactoriamente. A continuación encontrará el resumen de la sesión.'
    : 'Su sesión de práctica ha finalizado. A continuación encontrará el registro de la sesión.';
}

/**
 * Próximos pasos.
 *
 * El texto fijo prometía fortalezas, oportunidades de mejora y un plan de
 * desarrollo dentro del PDF adjunto. Sin evaluación el PDF no lleva ninguna de
 * las tres cosas: quien lo abriera buscándolas encontraría un documento vacío
 * y pensaría que el sistema falló.
 */
function fraseProximosPasos(d) {
  if (hayEvaluacion(d)) {
    return 'Le invitamos a revisar el reporte adjunto, donde encontrará sus fortalezas, '
      + 'las oportunidades de mejora identificadas y el plan de desarrollo sugerido. '
      + 'Si desea programar una nueva sesión de práctica, quedamos a sus órdenes.';
  }
  return 'El reporte adjunto contiene el registro completo de la sesión y su transcripción. '
    + 'La evaluación de competencias y el plan de desarrollo no se incluyen porque el sistema '
    + 'no registró calificaciones para esta práctica. Si desea programar una nueva sesión, '
    + 'quedamos a sus órdenes.';
}

/** El aviso de datos faltantes, en texto plano. Vacío si no falta nada. */
function avisoDatosTexto(d) {
  const faltan = datosFaltantes(d);
  if (!faltan.length) return [];

  return [
    '',
    'ℹ️ DATOS NO REGISTRADOS EN ESTA SESIÓN:',
    ...faltan.map((c) => `• ${c}`),
    'Estos campos aparecen vacíos porque el sistema de evaluación no los reportó. '
      + 'No se han sustituido por valores estimados.'
  ];
}

/**
 * Cuerpo del correo en texto plano.
 * Es la fuente de verdad: la versión HTML se construye a partir de esta misma
 * estructura para que ambos digan exactamente lo mismo.
 *
 * El análisis detallado NO va aquí a propósito: viaja completo en el reporte
 * adjunto. El correo es lo que se lee en el teléfono en veinte segundos, más la
 * transcripción de la conversación, que es lo que el colaborador y su líder
 * consultan de inmediato sin abrir el documento.
 *
 * @param {object} data
 * @param {Date|string|number} [when]
 * @param {{hasAudio?:boolean}} [options]
 * @returns {string}
 */
function buildEmailText(data, when, options) {
  const d = data || {};
  const adjuntos = ['• PDF: Reporte completo de desarrollo profesional'];
  if (tieneAudio(options)) adjuntos.push('• MP3: Grabación de la sesión');

  return [
    `Estimado ${nombreCompleto(d)},`,
    '',
    fraseApertura(d),
    '',
    '📋 DATOS DE LA SESIÓN:',
    ...detallesSesion(d, when).map(([k, v]) => `• ${k}: ${v}`),
    '',
    ...avisoDatosTexto(d),
    '',
    '📎 DOCUMENTOS ADJUNTOS:',
    ...adjuntos,
    ...transcripcionTexto(d),
    '',
    '🎯 PRÓXIMOS PASOS:',
    fraseProximosPasos(d),
    '',
    'Cordialmente,',
    'Victor IA — Programa de Desarrollo Profesional',
    'Victorious Travelers Club'
  ].join('\n');
}

// ════════════════════════════════════════════════════════════
// PALETA — la misma del reporte (negro + oro, sin azules)
// ════════════════════════════════════════════════════════════
const COLOR = {
  bg: '#0D0D0D',        // fondo principal
  surface: '#1A1A1A',   // tarjeta del correo
  surface2: '#262626',  // badges y botones
  gold: '#E5B33E',      // acento
  goldSoft: '#F2C766',
  text: '#FFFFFF',
  muted: '#B8B8B8',
  good: '#10B981',      // score ≥ 8
  warn: '#F59E0B',      // score 6 – 7.99
  bad: '#EF4444'        // score < 6
};

/** Meta VTC: mismo umbral que el reporte y que los gráficos. */
const META_VTC = 8;

/** Color de estado de un score, con los cortes de la meta VTC. */
function scoreColor(score) {
  // `Number(null)` es 0, que es finito: sin este descarte, una sesión SIN
  // evaluar se pintaba en rojo de reprobado. Ausencia de nota no es una nota
  // baja — va en el dorado neutro de la marca.
  if (score === null || score === undefined || score === '') return COLOR.gold;

  const n = Number(score);
  if (!Number.isFinite(n)) return COLOR.gold;
  if (n >= META_VTC) return COLOR.good;
  if (n >= 6) return COLOR.warn;
  return COLOR.bad;
}

/** Tipografía base del correo: pila del sistema, sin fuentes remotas. */
const FONT = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * Cuerpo del correo en HTML.
 * Layout de tabla y estilos inline: es lo único que Outlook y Gmail renderizan
 * igual. Paleta VTC v4.0 (negro #0D0D0D / oro #E5B33E), la misma del reporte y
 * del formulario, sin depender de imágenes ni de fuentes externas.
 *
 * Dice EXACTAMENTE lo mismo que `buildEmailText`, con la misma estructura y en
 * el mismo orden: saludo → confirmación → detalles → adjuntos → próximos pasos.
 *
 * @param {object} data
 * @param {Date|string|number} [when]
 * @param {{hasAudio?:boolean}} [options]
 * @returns {string}
 */
function buildEmailHTML(data, when, options) {
  const d = data || {};
  const nombre = escapeHtml(nombreCompleto(d));
  const hora = formatTimezoneCancun(when);

  const label = `${FONT};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${COLOR.gold};font-weight:700;margin:0 0 12px`;
  const para = `${FONT};font-size:14px;line-height:1.7;color:#E4E4E4;margin:0 0 14px`;

  // El desempeño se colorea con el mismo criterio que el reporte: si el gerente
  // ve verde en el correo y rojo en el PDF deja de confiar en los dos.
  const colorScore = scoreColor(d.score_overall);

  // La fila del desempeño se colorea con el mismo criterio que el reporte. La
  // comparación va contra la etiqueta que produce detallesSesion(): si ambas se
  // desincronizan, el porcentaje sale en blanco y el correo pierde su única
  // señal de color — que es justo lo que el gerente mira primero.
  const row = ([k, v]) => `
        <tr>
          <td style="${FONT};font-size:13px;color:${COLOR.muted};padding:9px 0;border-bottom:1px solid rgba(255,255,255,.09)">${escapeHtml(k)}</td>
          <td style="${FONT};font-size:14px;color:${
  k === ETIQUETA_DESEMPENO ? colorScore : COLOR.text
};font-weight:600;text-align:right;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.09)">${escapeHtml(v)}</td>
        </tr>`;

  const adjuntos = [
    ['PDF', 'Reporte completo de desarrollo profesional'],
    ...(tieneAudio(options) ? [['MP3', 'Grabación de la sesión']] : [])
  ];

  const adjuntoLi = ([tipo, desc]) => `
        <tr>
          <td valign="top" style="${FONT};font-size:13px;font-weight:800;color:${COLOR.gold};padding:4px 12px 4px 0;white-space:nowrap">${escapeHtml(tipo)}</td>
          <td valign="top" style="${FONT};font-size:14px;line-height:1.7;color:#E4E4E4;padding:4px 0">${escapeHtml(desc)}</td>
        </tr>`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reporte de Desarrollo Profesional — ${nombre}</title></head>
<body style="margin:0;padding:0;background:${COLOR.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.bg};padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${COLOR.surface};border-radius:14px;overflow:hidden;border:1px solid rgba(229,179,62,.28)">

  <tr><td style="background:${COLOR.surface2};padding:32px 34px;border-bottom:3px solid ${COLOR.gold}">
    <p style="${FONT};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${COLOR.gold};font-weight:700;margin:0 0 10px">Victorious Travelers Club · Desarrollo Profesional</p>
    <h1 style="${FONT};font-size:24px;color:${COLOR.text};margin:0;font-weight:700">Reporte de Desarrollo Profesional</h1>
    <p style="${FONT};font-size:14px;color:${COLOR.muted};margin:8px 0 0">${nombre} · ${escapeHtml(formatDateLocal(when))} · ${escapeHtml(hora)}</p>
  </td></tr>

  <tr><td style="padding:32px 34px">

    <p style="${para}">Estimado <strong style="color:${COLOR.goldSoft}">${nombre}</strong>,</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:rgba(16,185,129,.09);border-left:3px solid ${COLOR.good};border-radius:6px">
      <tr><td style="${FONT};font-size:14px;line-height:1.7;color:#E4E4E4;padding:14px 16px">${escapeHtml(fraseApertura(d))}</td></tr>
    </table>

    <p style="${label}">Datos de la sesión</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px">
      ${detallesSesion(d, when).map(row).join('')}
    </table>

    ${buildAvisoDatosHTML(d, { font: FONT })}

    <p style="${label}">Documentos adjuntos</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px">
      ${adjuntos.map(adjuntoLi).join('')}
    </table>

    ${buildEmailTranscript(d, { font: FONT, label })}

    <p style="${label}">Próximos pasos</p>
    <p style="${para}">${escapeHtml(fraseProximosPasos(d))}</p>
    ${buildEmailCtas(d, { font: FONT })}

    <div style="border-top:1px solid rgba(229,179,62,.28);margin:28px 0"></div>

    <p style="${para};margin:0 0 4px">Cordialmente,</p>
    <p style="${para};margin:0"><strong style="color:${COLOR.text}">Victor IA</strong> <span style="color:${COLOR.muted}">— Programa de Desarrollo Profesional</span></p>

  </td></tr>

  <tr><td style="background:${COLOR.bg};padding:18px 34px;text-align:center;border-top:1px solid rgba(229,179,62,.22)">
    <p style="${FONT};font-size:11px;color:${COLOR.muted};margin:0">Documento generado por Victor IA · ${escapeHtml(formatDateLocal(when))} ${escapeHtml(hora)} (America/Cancun)</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/**
 * El aviso de datos faltantes, en HTML.
 *
 * Va en ámbar y con borde lateral, como una nota al margen: informa sin gritar.
 * Si la sesión llegó completa, el bloque no existe — un aviso permanente se
 * vuelve invisible y deja de cumplir su función.
 */
function buildAvisoDatosHTML(d, { font }) {
  const faltan = datosFaltantes(d);
  if (!faltan.length) return '';

  const items = faltan
    .map((c) => `<li style="margin:0 0 4px">${escapeHtml(c)}</li>`)
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px;background:rgba(245,158,11,.09);border-left:3px solid ${COLOR.warn};border-radius:6px">
      <tr><td style="padding:14px 16px">
        <p style="${font};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:${COLOR.warn};font-weight:700;margin:0 0 8px">Datos no registrados en esta sesión</p>
        <ul style="${font};font-size:13px;line-height:1.6;color:#E4E4E4;margin:0 0 8px;padding-left:18px">${items}</ul>
        <p style="${font};font-size:12px;line-height:1.6;color:${COLOR.muted};margin:0">Estos campos aparecen vacíos porque el sistema de evaluación no los reportó. No se han sustituido por valores estimados.</p>
      </td></tr>
    </table>`;
}

/**
 * La transcripción dentro del correo, un bloque por intervención.
 *
 * Cada bloque es una tabla independiente: nombre y minuto en su propio renglón,
 * y debajo lo que se dijo. Sin globos de chat alineados a izquierda y derecha —
 * Outlook no los renderiza igual que Gmail y el resultado se descuadra.
 *
 * Si la sesión no trae transcripción, el bloque entero desaparece: un
 * encabezado vacío en un correo se lee como un fallo del sistema.
 */
function buildEmailTranscript(d, { font, label }) {
  const { bloques, total, omitidos } = transcripcionBloques(d);
  if (!bloques.length) return '';

  const esAgente = (t) => /victor|carlos|sandra|carlitos|jorge|james|kelly|tiffany|george/i.test(t.speaker);

  const bloque = (t) => {
    const acento = esAgente(t) ? COLOR.gold : COLOR.muted;
    const fondo = esAgente(t) ? 'rgba(229,179,62,.07)' : 'rgba(255,255,255,.035)';
    const hora = t.timestamp
      ? `<span style="${font};font-size:11px;color:${COLOR.muted};font-weight:400;letter-spacing:.4px"> · ${escapeHtml(t.timestamp)}</span>`
      : '';

    return `
        <tr><td style="padding:0 0 9px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${fondo};border-left:3px solid ${acento};border-radius:0 8px 8px 0">
            <tr><td style="padding:11px 14px">
              <p style="${font};font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${acento};font-weight:700;margin:0 0 5px">${escapeHtml(t.speaker)}${hora}</p>
              <p style="${font};font-size:14px;line-height:1.65;color:#E4E4E4;margin:0">${escapeHtml(t.text)}</p>
            </td></tr>
          </table>
        </td></tr>`;
  };

  const nota = omitidos
    ? `<p style="${font};font-size:12px;line-height:1.6;color:${COLOR.muted};margin:0 0 30px">`
      + `Se muestran las primeras ${bloques.length} de ${total} intervenciones. `
      + `La conversación completa está en el reporte adjunto.</p>`
    : '';

  return `<p style="${label}">Transcripción de la sesión</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 ${omitidos ? '10px' : '30px'}">
      ${bloques.map(bloque).join('')}
    </table>
    ${nota}`;
}

/**
 * Los tres CTAs del correo, en dorado sólido.
 *
 * Solo se pintan los que tienen destino real: un botón que lleva a "#" desde
 * el buzón del gerente es peor que no tenerlo. Si el pipeline no pudo firmar
 * los enlaces (falta el secreto), el bloque entero desaparece y quedan los
 * adjuntos, que siempre viajan.
 */
function buildEmailCtas(d, { font }) {
  // Los rótulos son EXACTAMENTE los del reporte: el gerente salta del correo al
  // PDF y de vuelta, y un botón que cambia de nombre entre los dos parece otro
  // destino.
  const acciones = [
    { url: d.pop_up_url, texto: 'Escuchar la sesión', principal: true },
    { url: d.pdf_download_url, texto: 'Descargar el reporte', principal: false },
    { url: d.retrain_url, texto: 'Solicitar nueva práctica', principal: false }
  ].filter((a) => typeof a.url === 'string' && /^https?:\/\//i.test(a.url));

  if (!acciones.length) return '';

  const botones = acciones
    .map((a) => {
      const estilo = a.principal
        ? `background:${COLOR.gold};color:${COLOR.bg};border:1px solid ${COLOR.gold}`
        : `background:${COLOR.surface2};color:${COLOR.gold};border:1px solid ${COLOR.gold}`;
      return `<a href="${escapeHtml(a.url)}" style="${font};display:inline-block;${estilo};`
        + `font-weight:700;font-size:14px;padding:12px 20px;border-radius:8px;`
        + `text-decoration:none;margin:0 8px 10px 0">${escapeHtml(a.texto)}</a>`;
    })
    .join('');

  return `<div style="margin-top:20px">${botones}</div>`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════
// ENVÍO
// ════════════════════════════════════════════════════════════

/**
 * Presupuesto de tiempo del envío.
 *
 * El correo es el ÚLTIMO paso de una lambda de 60s: cuando se ejecuta ya se
 * consumieron ~40s en fetch + render. Con 3 intentos y backoff exponencial
 * (2s + 4s de espera, más 3 llamadas sin techo) el paso podía tardar más que
 * toda la lambda y morir SIN enviar nada. Un intento acotado a 8s siempre cabe.
 * Resend además reintenta por su cuenta del lado del proveedor.
 */
const EMAIL_MAX_RETRIES = Number(process.env.EMAIL_MAX_RETRIES || 1);
const EMAIL_ATTEMPT_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 8000);

/**
 * Normaliza destinatarios a una lista limpia de direcciones.
 *
 * Acepta un string ("a@x.com, b@y.com"), un array, o nada. Devuelve siempre un
 * array sin vacíos ni duplicados. Es lo que permite pasar `cc` desde cualquier
 * origen —variable de entorno, formulario, llamada interna— sin que un formato
 * inesperado tumbe el envío.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function normalizeAddressList(value) {
  if (!value) return [];

  const bruto = Array.isArray(value) ? value : [value];
  const planos = bruto.flatMap((v) => String(v == null ? '' : v).split(/[,;]/));
  const limpios = planos.map((s) => s.trim()).filter(Boolean);

  const vistos = new Set();
  return limpios.filter((addr) => {
    const key = addr.toLowerCase();
    if (vistos.has(key)) return false;
    vistos.add(key);
    return true;
  });
}

/** Corre una promesa con techo de tiempo, limpiando el temporizador siempre. */
function withTimeout(promise, ms, etiqueta) {
  let timer = null;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${etiqueta} timeout tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class EmailSender {
  constructor(apiKey, options = {}) {
    this.resend = new Resend(apiKey);
    this.maxRetries = Math.max(1, Number(options.maxRetries) || EMAIL_MAX_RETRIES);
    this.attemptTimeoutMs = Math.max(1000, Number(options.timeout) || EMAIL_ATTEMPT_TIMEOUT_MS);
  }

  /**
   * Enviar email con adjuntos (PDF + MP3)
   */
  async sendWithAttachments(options) {
    const { to, cc, bcc, from, subject, htmlBody, textBody, attachments = [] } = options;

    if (!to || !from || !subject || !htmlBody) {
      throw new Error('Missing required email fields: to, from, subject, htmlBody');
    }

    if (!Array.isArray(attachments)) {
      throw new Error('Attachments must be an array');
    }

    const preparedAttachments = attachments.map((att) => {
      if (!att.filename || !att.content) {
        throw new Error('Each attachment must have filename and content');
      }
      return {
        filename: att.filename,
        content: att.content, // Buffer
        contentType: att.contentType || 'application/octet-stream'
      };
    });

    // Copias. Se normalizan a array y se descartan vacíos: Resend rechaza el
    // envío entero si `cc` llega como `[]`, `''` o con un hueco dentro, y ese
    // fallo se comía el correo completo, no solo la copia.
    const ccList = normalizeAddressList(cc);
    const bccList = normalizeAddressList(bcc);

    console.log(`[EMAIL] Preparing email to: ${Array.isArray(to) ? to.join(', ') : to}`);
    if (ccList.length) console.log(`[EMAIL] CC: ${ccList.join(', ')}`);
    if (bccList.length) console.log(`[EMAIL] BCC: ${bccList.join(', ')}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Attachments: ${preparedAttachments.map((a) => a.filename).join(', ') || 'ninguno'}`);

    let attempt = 0;
    let lastError;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        console.log(`[EMAIL] Attempt ${attempt}/${this.maxRetries}...`);

        const payload = {
          from,
          to,
          subject,
          html: htmlBody,
          attachments: preparedAttachments
        };
        // Solo se envían si tienen contenido: una clave `cc` vacía hace que
        // Resend rechace la petición.
        if (ccList.length) payload.cc = ccList;
        if (bccList.length) payload.bcc = bccList;
        // El texto plano mejora la entregabilidad y da fallback en clientes sin HTML
        if (textBody) payload.text = textBody;

        const response = await withTimeout(
          this.resend.emails.send(payload),
          this.attemptTimeoutMs,
          'resend.emails.send'
        );

        if (response && response.error) {
          throw new Error(`Resend error: ${response.error.message || response.error}`);
        }

        const messageId = (response && response.data && response.data.id) || null;
        console.log(`[EMAIL] ✓ Email sent successfully. ID: ${messageId || 'sin id'}`);

        return {
          success: true,
          messageId,
          subject,
          cc: ccList,
          bcc: bccList,
          attachments: preparedAttachments.map((a) => a.filename),
          timestamp: new Date().toISOString(),
          attempt
        };
      } catch (error) {
        lastError = error;
        console.error(`[EMAIL] Attempt ${attempt} failed:`, error.message);

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Backoff exponencial
          console.log(`[EMAIL] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    console.error(`[EMAIL] All ${this.maxRetries} attempts failed`);
    return {
      success: false,
      error: (lastError && lastError.message) || 'Envío fallido sin detalle',
      attempts: attempt,
      timestamp: new Date().toISOString()
    };
  }

  validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static getEmailHeaders(options) {
    return {
      from: options.from,
      to: options.to,
      subject: options.subject,
      date: new Date().toISOString(),
      attachmentCount: (options.attachments || []).length,
      bodyLength: options.htmlBody ? options.htmlBody.length : 0
    };
  }
}

/**
 * Envío con validación de direcciones. Acepta uno o varios destinatarios.
 */
async function sendEmailWithAttachments(options) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable not set');
  }

  const sender = new EmailSender(apiKey);

  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  for (const addr of recipients) {
    if (!sender.validateEmail(addr)) {
      throw new Error(`Invalid recipient email: ${addr}`);
    }
  }

  // Las copias se DEPURAN, no tumban el envío: si alguien escribió mal una
  // dirección en REPORT_CC, el reporte tiene que salir igual hacia el
  // destinatario principal. Se avisa en el log para poder corregirla.
  const cc = normalizeAddressList(options.cc).filter((addr) => {
    if (sender.validateEmail(addr)) return true;
    console.warn(`[EMAIL] CC inválido, se omite: ${addr}`);
    return false;
  });
  const bcc = normalizeAddressList(options.bcc).filter((addr) => {
    if (sender.validateEmail(addr)) return true;
    console.warn(`[EMAIL] BCC inválido, se omite: ${addr}`);
    return false;
  });

  // El remitente puede venir como "Nombre <correo@dominio>" — validamos solo el correo
  const fromAddress = extractAddress(options.from);
  if (!sender.validateEmail(fromAddress)) {
    throw new Error(`Invalid sender email: ${options.from}`);
  }

  return sender.sendWithAttachments({ ...options, cc, bcc });
}

/** Extrae el correo de un remitente con formato "Nombre <correo@dominio>". */
function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim();
}

/**
 * Construye el paquete completo del correo (asunto + cuerpos + nombres de adjunto).
 * Lo consume el pipeline en api-process-call.js.
 *
 * @param {object} data Datos del reporte ya mapeados
 * @param {Date|string|number} [when] Momento de la sesión
 * @param {{hasAudio?:boolean}} [options] `hasAudio:false` cuando el MP3 no viaja —
 *        así el correo no promete un adjunto que no está.
 */
function buildEmailPackage(data, when, options) {
  const basename = buildAttachmentBasename(data, when);
  return {
    subject: buildEmailSubject(data, when),
    html: buildEmailHTML(data, when, options),
    text: buildEmailText(data, when, options),
    basename,
    pdfFilename: `${basename}.pdf`,
    mp3Filename: `${basename}.mp3`,
    fecha_formateada: formatDateLocal(when),
    fecha_email: formatDateLong(when),
    fecha_hora_larga: formatDateTimeLong(when),
    hora_america_cancun: formatTimezoneCancun(when)
  };
}

module.exports = {
  EmailSender,
  sendEmailWithAttachments,
  buildEmailPackage,
  buildEmailSubject,
  buildEmailHTML,
  buildEmailText,
  buildAttachmentBasename,
  formatTimezoneCancun,
  formatDateLocal,
  formatDateLong,
  formatDateTimeLong,
  formatDuracion,
  nombreCompleto,
  // Exportados para las pruebas de "no inventar datos"
  normalizeAddressList,
  datosFaltantes,
  scorePctTexto,
  SIN_DATO,
  SIN_EVALUACION
};