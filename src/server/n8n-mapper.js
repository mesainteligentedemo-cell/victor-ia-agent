/**
 * N8N MAPPER — Transforma data de ElevenLabs → Variables del reporte
 *
 * Entrada: webhook body de ElevenLabs (o payload plano de N8N)
 * Salida: objeto con 60+ campos para renderizar el reporte HTML y el email
 */

const {
  formatTimezoneCancun,
  formatDateLocal,
  formatDateLong
} = require('./email-sender');

function mapElevenLabsData(webhookBody) {
  const wh = webhookBody.body || webhookBody;

  // Helpers
  const v = (x, def) => (x == null || x === '') ? (def || '-') : String(x).trim();
  const safe = (obj, path, def) => {
    try {
      return path.split('.').reduce((acc, p) => acc[p], obj) || def;
    } catch {
      return def;
    }
  };

  // ===== DATOS BÁSICOS =====
  const conversationId = v(safe(wh, 'conversation_id', null), 'CONV-' + Date.now());
  const nombre = v(safe(wh, 'nombre_asesor', null), 'Asesor VTC');
  const empleado_id = v(safe(wh, 'empleado_id', null), 'VTC-001');
  const puesto = v(safe(wh, 'puesto', null), 'Asesor');
  const idioma = v(safe(wh, 'idioma', 'Español'), 'Español');
  const modulo = v(safe(wh, 'modulo', null), 'Meet & Greet');
  const familia_nombre = v(safe(wh, 'familia_nombre', null), 'López');

  // ===== FECHA Y HORA =====
  // Preferimos el inicio real de la conversación; si no viene, el momento de proceso.
  // Todo se expresa en America/Cancun: es el huso operativo del club.
  const sessionDate = resolveSessionDate(wh);
  const fecha_sesion = formatDateLocal(sessionDate);
  const fecha_larga = formatDateLong(sessionDate);
  const hora_cancun = formatTimezoneCancun(sessionDate);
  const hora_sesion = hora_cancun;

  // ===== DURACIÓN =====
  const rawDuracion = safe(wh, 'duracion_segundos', null) ?? safe(wh, 'call_duration_secs', null);
  const parsedDuracion = rawDuracion === null || rawDuracion === '' ? NaN : Number(rawDuracion);
  const duracion_sec = Number.isFinite(parsedDuracion) && parsedDuracion > 0 ? Math.round(parsedDuracion) : 570;
  const duracion_minutos = Math.floor(duracion_sec / 60);
  const duracion_seg = duracion_sec % 60;
  const duracion_texto = `${duracion_minutos}:${duracion_seg < 10 ? '0' : ''}${duracion_seg}`;

  // ===== SCORES (0-10) =====
  // Siempre número finito dentro de [0,10]; si el agente manda string ("9") se convierte.
  const num = (x, def) => {
    // OJO: Number(null) === 0, así que hay que descartar vacíos ANTES de convertir.
    if (x === null || x === undefined || x === '') return def;
    const n = Number(x);
    if (!Number.isFinite(n)) return def;
    return Math.min(10, Math.max(0, n));
  };

  const score_rapport = num(safe(wh, 'score_rapport', null), 8);
  const score_pnl = num(safe(wh, 'score_pnl', null), 8);
  const score_postura = num(safe(wh, 'score_postura', null), 9);
  const score_objecciones = num(safe(wh, 'score_objecciones', null), 7);
  const score_lectura_sala = num(safe(wh, 'score_lectura_sala', null), 9);
  const score_cierre = num(safe(wh, 'score_cierre', null), 8);
  const score_overall = num(safe(wh, 'score_overall', null), 8);

  const scoreTotal = Math.round((score_overall / 10) * 100);
  const mejora_potencial = Math.round(100 - scoreTotal) + '%';

  // ===== ANÁLISIS TEXTOS =====
  const fortalezas = v(safe(wh, 'fortalezas', null),
    '✓ Excelente calibración visual\n✓ Empatía genuina con la familia\n✓ Manejo natural de pausas');

  const areas_mejora = v(safe(wh, 'areas_mejora', null),
    '• Mejorar cierre de objeciones sobre precio\n• Aumentar velocidad en lectura de sala\n• Profundizar en técnicas de reencuadre');

  const analisis_pnl = v(safe(wh, 'analisis_pnl', null),
    'Uso efectivo de anclajes emocionales. Reencuadres de valor bien ejecutados. Necesita mejorar submodalidades auditivas.');

  const objeciones_trabajadas = v(safe(wh, 'objeciones_trabajadas', null),
    'Precio (respondió con valor-tiempo), Garantía (explicó bien), Seguridad (faltó dato neurocientífico)');

  // ===== COMPETENCIAS (para gráficos) =====
  const competencias = [
    { name: 'Rapport', score: score_rapport },
    { name: 'PNL', score: score_pnl },
    { name: 'Postura', score: score_postura },
    { name: 'Objeciones', score: score_objecciones },
    { name: 'Lectura Sala', score: score_lectura_sala },
    { name: 'Cierre', score: score_cierre }
  ];

  // slice() evita mutar `competencias` (los gráficos mantienen su orden original)
  const comp_baja = competencias.slice().sort((a, b) => a.score - b.score)[0];
  const comp_alta = competencias.slice().sort((a, b) => b.score - a.score)[0];

  // ===== RESUMEN (sección ANÁLISIS del email) =====
  // Si el agente entrega su propio resumen, ese manda: es análisis real de la
  // llamada. El generado es un respaldo con los datos duros de la sesión.
  const resumen = v(
    safe(wh, 'resumen', null) || safe(wh, 'resumen_sesion', null) || safe(wh, 'analisis_general', null),
    `Sesión de ${duracion_texto} en el módulo ${modulo} con ${nombre}. Desempeño global de `
      + `${score_overall}/10 (${scoreTotal}%). Competencia más fuerte: ${comp_alta.name} `
      + `(${comp_alta.score}/10). Competencia a reforzar: ${comp_baja.name} (${comp_baja.score}/10).`
  );

  // ===== RECOMENDACIÓN DEL COACH =====
  // Dinámica: viene de la llamada cuando el agente la genera; si no, se
  // construye con los datos reales de esta sesión (nunca texto genérico).
  const recomendacion_coach = v(
    safe(wh, 'recomendacion_coach', null)
      || safe(wh, 'recomendacion', null)
      || safe(wh, 'coach_recommendation', null),
    buildRecomendacion(score_overall, comp_alta, comp_baja)
  );

  // ===== PRINCIPIOS NEUROCIENTÍFICOS =====
  const principios_neuro = normalizePrincipios(safe(wh, 'principios_neuro', null)) || [
    {
      titulo: 'Activación Límbica',
      descripcion: 'Se activó el sistema límbico mediante calibración visual y validación de sueños familiares.'
    },
    {
      titulo: 'Anclajes Emocionales',
      descripcion: 'Ancla "memoria familiar" se activó. Reacción: asentimiento y sonrisa genuina.'
    },
    {
      titulo: 'Reencuadre PNL',
      descripcion: 'Transformación "gasto" → "inversión en tiempo familiar" activó córtex prefrontal.'
    },
    {
      titulo: 'Espejeo de Submodalidades',
      descripcion: 'Sincronización de tono y ritmo generó rapport neuronal. La familia bajó defensas rápidamente.'
    },
    {
      titulo: 'Sincronización Neuronal',
      descripcion: 'Patrones de respiración y ritmo de habla sincronizados. Congruencia detectada.'
    }
  ];

  // El agente manda este valor a veces en escala 0-10 y a veces como porcentaje.
  // El reporte siempre lo pinta como % (ancho de barra), así que normalizamos aquí.
  const rawCumplimiento = Number(safe(wh, 'cumplimiento_neuro', null));
  const cumplimiento_neuro = Number.isFinite(rawCumplimiento) && rawCumplimiento > 0
    ? Math.round(rawCumplimiento <= 10 ? rawCumplimiento * 10 : Math.min(100, rawCumplimiento))
    : 85;

  // ===== PLAN DE ACCIÓN =====
  const plan_1 = `Score actual: ${score_overall}/10 (${scoreTotal}%). Fortaleza: ${comp_alta.name} (${comp_alta.score}/10). Área crítica: ${comp_baja.name} (${comp_baja.score}/10).`;

  const plan_2 = `Coaching intensivo en ${comp_baja.name} (3 sesiones de 20 min c/u). Práctica diaria: 2 simulaciones mínimo. Meta: ${comp_baja.name} de ${comp_baja.score}/10 → 8+/10 en 7 días.`;

  const plan_3 = `Validación completa en 7 días. Si score ≥ 8/10 en todos: autorizar a producción. Si score < 8/10: extender coaching 3 días más.`;

  // ===== ACTIVIDAD SESIÓN =====
  const actividad_sesion = v(safe(wh, 'actividad_sesion', null),
    `${nombre} trabajó el módulo ${modulo} durante ${duracion_texto} minutos frente a la familia ${familia_nombre}. `
      + `Se cubrieron las fases de apertura, descubrimiento, presentación y cierre, con manejo de objeciones en tiempo real.`);

  // ===== TRANSCRIPCIÓN =====
  let transcription = [];
  const turns = safe(wh, 'transcript_turns', null);
  if (Array.isArray(turns) && turns.length) {
    transcription = turnsToBubbles(turns, nombre, familia_nombre);
  } else if (safe(wh, 'transcript', null)) {
    transcription = parseTranscript(safe(wh, 'transcript', ''), nombre, familia_nombre, duracion_sec);
  }

  // ===== URLS (para CTAs) =====
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://victor-ia-agent.vercel.app';
  const pop_up_url = `${baseUrl}/player?conv=${conversationId}`;
  const pdf_download_url = `${baseUrl}/api/pdf/${conversationId}`;
  const retrain_url = `${baseUrl}/retrain?conv=${conversationId}`;

  // ===== RETORNAR OBJETO COMPLETO =====
  return {
    // IDs
    conversationId,
    nombre,
    empleado_id,
    puesto,
    idioma,
    modulo,
    familia_nombre,

    // Fecha/Hora (todo en America/Cancun)
    fecha_sesion,
    fecha_larga,
    hora_sesion,
    hora_cancun,
    session_iso: sessionDate.toISOString(),
    duracion_texto,
    duracion_minutos,
    duracion_sec,

    // Scores
    score_rapport,
    score_pnl,
    score_postura,
    score_objecciones,
    score_lectura_sala,
    score_cierre,
    score_overall,
    scoreTotal,
    mejora_potencial,

    // Análisis
    resumen,
    recomendacion_coach,
    fortalezas,
    areas_mejora,
    analisis_pnl,
    objeciones_trabajadas,
    actividad_sesion,

    // Listas normalizadas (presentación en el reporte)
    fortalezas_list: splitItems(fortalezas),
    areas_list: splitItems(areas_mejora),
    objeciones_list: splitItems(objeciones_trabajadas, true),

    // Competencias (para gráficos)
    competencias,
    comp_baja: comp_baja.name,
    comp_alta: comp_alta.name,

    // Neurociencia
    principios_neuro,
    cumplimiento_neuro,

    // Plan
    plan_1,
    plan_2,
    plan_3,

    // Transcripción
    transcription,

    // URLs
    pop_up_url,
    pdf_download_url,
    retrain_url,

    // Metadata
    timestamp: new Date().toISOString(),
    version: 'v3.1',

    // ===== CONTEXTO DEL AGENTE (KB + RAG) =====
    // Enriquecimiento desde el snapshot del agente ElevenLabs.
    // Permite al reporte mostrar contra qué guion se evaluó al asesor.
    agente: agentContext(modulo)
  };
}

/**
 * Determina el momento real de la sesión.
 * ElevenLabs expone el inicio en varios lugares según la versión del webhook.
 *
 * @param {object} wh
 * @returns {Date}
 */
function resolveSessionDate(wh) {
  const candidates = [
    wh && wh.session_start,
    wh && wh.start_time,
    wh && wh.metadata && wh.metadata.start_time_unix_secs,
    wh && wh.start_time_unix_secs,
    wh && wh.event_timestamp
  ];

  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;

    // Unix en segundos (ElevenLabs) vs milisegundos vs ISO string
    if (typeof c === 'number' || /^\d+$/.test(String(c))) {
      const n = Number(c);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
      continue;
    }

    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return new Date();
}

/**
 * Recomendación del coach derivada de los datos reales de la sesión.
 * Solo se usa si el agente no envió la suya.
 */
function buildRecomendacion(score, alta, baja) {
  if (score >= 8.5) {
    return `Desempeño de ${score}/10: el asesor está listo para piso de ventas. Capitalizar `
      + `${alta.name} (${alta.score}/10) usando la grabación como referencia para el equipo. `
      + `Punto único de vigilancia: ${baja.name} (${baja.score}/10), a reforzar en la sesión semanal.`;
  }
  if (score >= 7) {
    return `Desempeño de ${score}/10: base sólida con una brecha clara. Concentrar el coaching de los `
      + `próximos 7 días exclusivamente en ${baja.name} (${baja.score}/10); ${alta.name} `
      + `(${alta.score}/10) ya está en estándar y no requiere intervención. Revalidar al séptimo día.`;
  }
  return `Desempeño de ${score}/10: requiere refuerzo antes de piso de ventas. Prioridad absoluta en `
    + `${baja.name} (${baja.score}/10) con acompañamiento diario. Usar ${alta.name} `
    + `(${alta.score}/10) como base de confianza. Revalidar en 7 días con simulación completa.`;
}

/**
 * Convierte un bloque de texto en lista de puntos limpios.
 * @param {string} text
 * @param {boolean} commaSplit Permite partir por comas si vino todo en una línea
 */
function splitItems(text, commaSplit = false) {
  if (!text) return [];

  let parts = String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .filter((p) => p && p.trim());

  // Muchos agentes devuelven "A, B, C" en una sola línea.
  // El lookahead evita partir dentro de un paréntesis: "Precio (valor, tiempo)".
  if (parts.length <= 1 && commaSplit) {
    parts = String(text).split(/,(?![^(]*\))/).filter((p) => p && p.trim());
  }

  return parts
    .map((p) => p.replace(/^\s*(?:[✓✔✅×✗•·▪▸►◆●○*\-–—]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean);
}

/**
 * Normaliza los principios neurocientíficos a [{titulo, descripcion}].
 * Acepta array de objetos, array de strings o string con saltos de línea.
 */
function normalizePrincipios(raw) {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    const items = raw
      .map((p) => {
        if (p && typeof p === 'object') {
          return {
            titulo: String(p.titulo || p.title || p.nombre || 'Principio'),
            descripcion: String(p.descripcion || p.description || p.detalle || '')
          };
        }
        const text = String(p || '').trim();
        if (!text) return null;
        const [titulo, ...rest] = text.split(/:\s*/);
        return { titulo, descripcion: rest.join(': ') || text };
      })
      .filter((p) => p && p.titulo);
    return items.length ? items : null;
  }

  if (typeof raw === 'string') {
    const items = splitItems(raw).map((line) => {
      const [titulo, ...rest] = line.split(/:\s*/);
      return { titulo, descripcion: rest.join(': ') || line };
    });
    return items.length ? items : null;
  }

  return null;
}

/**
 * Contexto del agente ElevenLabs para enriquecer el mapeo.
 * Degrada a un objeto vacío si el snapshot de KB no está disponible.
 *
 * @param {string} modulo Módulo detectado en la sesión
 */
function agentContext(modulo) {
  try {
    // require perezoso: si falta el JSON, el mapper sigue funcionando
    const { getAgentMeta, queryRAG } = require('./rag-query');
    const meta = getAgentMeta();
    const rag = modulo ? queryRAG(String(modulo), { topK: 3, maxChars: 3000 }) : { matches: [] };

    return {
      agent_id: meta.agent_id,
      agent_name: meta.agent_name,
      llm: meta.llm,
      rag_enabled: meta.rag_enabled,
      embedding_model: meta.embedding_model,
      kb_document: meta.kb_document,
      kb_chunks: meta.kb_chunks,
      kb_chars: meta.kb_chars,
      // Secciones de KB que corresponden al módulo evaluado
      kb_referencias: (rag.matches || []).map((m) => ({
        id: m.id,
        titulo: m.title,
        relevancia: m.score
      }))
    };
  } catch (error) {
    console.warn('[MAPPER] Contexto de agente no disponible:', error.message);
    return {};
  }
}

// ════════════════════════════════════════════
// TRANSCRIPCIÓN
// ════════════════════════════════════════════

// ElevenLabs entrega los turnos con role "agent" / "user"
const AGENT_KEYS = ['victor', 'carlos', 'george', 'jorge', 'agent', 'assistant', 'ai'];

/** Formatea segundos a "mm:ss". */
function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Etiquetas de cada lado de la conversación.
 *
 * En ElevenLabs el rol `user` es quien habla al micrófono — el asesor en
 * entrenamiento — y `agent` es la IA que interpreta al cliente/coach.
 *
 * Caso borde real: el agente se llama "Coach VICTOR" y el asesor evaluado
 * también puede llamarse Victor. Si los nombres chocan, desambiguamos el lado
 * de la IA; si no, el reporte muestra dos "VICTOR" y es ilegible.
 */
function speakerMap(asesorName, familyName) {
  const asesor = String(asesorName || 'Asesor').trim();
  const asesorKey = asesor.toLowerCase();

  const agentLabel = (persona) =>
    persona.toLowerCase() === asesorKey ? `${persona} (IA)` : persona;

  return {
    victor: agentLabel('Victor'),
    carlos: agentLabel('Carlos'),
    george: agentLabel('George'),
    jorge: agentLabel('Jorge'),
    agent: agentLabel('Victor'),
    assistant: agentLabel('Victor'),
    ai: agentLabel('Victor'),
    [asesorKey]: asesor,
    [String(familyName).toLowerCase()]: familyName,
    familia: familyName,
    usuario: asesor,
    user: asesor
  };
}

/**
 * Convierte los turnos crudos de ElevenLabs en burbujas de chat.
 * Ventaja sobre parseTranscript: conserva el timestamp real del turno.
 *
 * @param {Array<{role?:string, message?:string, time_in_call_secs?:number}>} turns
 */
function turnsToBubbles(turns, asesorName, familyName) {
  const SPEAKERS = speakerMap(asesorName, familyName);

  return turns
    .map((turn) => {
      const rawSpeaker = String(turn.role || turn.speaker || turn.source || 'agent').toLowerCase().trim();
      const text = String(turn.message || turn.text || turn.content || '').trim();
      if (!text) return null;

      const isAgent = AGENT_KEYS.includes(rawSpeaker);
      const secs = turn.time_in_call_secs ?? turn.time_in_call ?? turn.start_time ?? null;

      return {
        speaker: SPEAKERS[rawSpeaker] || rawSpeaker,
        text,
        timestamp: secs != null ? mmss(secs) : '',
        side: isAgent ? 'right' : 'left',
        type: isAgent ? 'agent' : 'user'
      };
    })
    .filter(Boolean);
}

/**
 * Parsear transcript en texto plano ("Speaker: mensaje") y crear burbujas.
 * Los timestamps se estiman repartiendo la duración real entre los turnos —
 * si se conoce la duración; en otro caso quedan vacíos (mejor nada que un dato falso).
 *
 * @param {string} transcriptText
 * @param {string} asesorName
 * @param {string} familyName
 * @param {number} [duracionSec] Duración real de la llamada en segundos
 */
function parseTranscript(transcriptText, asesorName, familyName, duracionSec) {
  const bubbles = [];
  const lines = String(transcriptText).split('\n').filter((l) => l.trim());
  const SPEAKERS = speakerMap(asesorName, familyName);
  const total = Number(duracionSec);
  const hasDuration = Number.isFinite(total) && total > 0 && lines.length > 1;

  lines.forEach((line, idx) => {
    const match = line.match(/^(.*?):\s*(.*)$/);
    if (!match) return;

    const [, speaker, text] = match;
    if (!text.trim()) return;

    const cleanSpeaker = speaker.trim().toLowerCase();
    const displaySpeaker = SPEAKERS[cleanSpeaker] || speaker.trim();
    const isAgent = AGENT_KEYS.includes(cleanSpeaker);

    bubbles.push({
      speaker: displaySpeaker,
      text: text.trim(),
      timestamp: hasDuration ? mmss((idx / (lines.length - 1)) * total) : '',
      side: isAgent ? 'right' : 'left',
      type: isAgent ? 'agent' : 'user'
    });
  });

  return bubbles;
}

module.exports = {
  mapElevenLabsData,
  parseTranscript,
  turnsToBubbles,
  splitItems,
  resolveSessionDate
};