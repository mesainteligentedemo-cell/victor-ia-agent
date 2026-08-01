/**
 * N8N MAPPER — Transforma data de ElevenLabs → Variables del reporte
 *
 * Entrada: webhook body de ElevenLabs
 * Salida: objeto con 50+ campos para renderizar reporte HTML
 */

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
  const ahora = new Date();
  const fecha_sesion = ahora.toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const hora_sesion = ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  // ===== DURACIÓN =====
  const rawDuracion = safe(wh, 'duracion_segundos', null);
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

  const resumen = `Sesión de ${duracion_texto} con ${nombre} en ${modulo}. Score: ${score_overall}/10 (${scoreTotal}%). Familia: Sentimiento positivo. Recomendación: Refuerzo en fortalezas clave.`;

  // ===== COMPETENCIAS (para gráfico) =====
  const competencias = [
    { name: 'Rapport', score: score_rapport },
    { name: 'PNL', score: score_pnl },
    { name: 'Postura', score: score_postura },
    { name: 'Objeciones', score: score_objecciones },
    { name: 'Lectura Sala', score: score_lectura_sala },
    { name: 'Cierre', score: score_cierre }
  ];

  // ===== PRINCIPIOS NEUROCIENTÍFICOS =====
  const principios_neuro = safe(wh, 'principios_neuro', null) || [
    {
      titulo: 'Activación Límbica',
      descripcion: 'Se activó el sistema límbico mediante calibración visual y validación de sueños familiares.'
    },
    {
      titulo: 'Anclajes Emocionales',
      descripcion: 'Ancla "memoria familiar" se activó. Reacción: asintencia y sonrisa genuina.'
    },
    {
      titulo: 'Reencuadre PNL',
      descripcion: 'Transformación "gasto" → "inversión en tiempo familiar" activó córtex prefrontal.'
    },
    {
      titulo: 'Espejeo de Submodalidades',
      descripcion: 'Sincronización de tono y ritmo generó rapport neuronal. Familia bajó defensas rápidamente.'
    },
    {
      titulo: 'Sincronización Neuronal',
      descripcion: 'Patrones de respiración y ritmo de habla sincronizados. Congruencia detectada.'
    }
  ];

  const cumplimiento_neuro = safe(wh, 'cumplimiento_neuro', 85) || 85;

  // ===== PLAN DE ACCIÓN =====
  // slice() evita mutar `competencias` (el gráfico mantiene su orden original)
  const comp_baja = competencias.slice().sort((a, b) => a.score - b.score)[0];
  const comp_alta = competencias.slice().sort((a, b) => b.score - a.score)[0];

  const plan_1 = `Score actual: ${score_overall}/10 (${scoreTotal}%). Fortaleza: ${comp_alta.name} (${comp_alta.score}/10). Área crítica: ${comp_baja.name} (${comp_baja.score}/10).`;

  const plan_2 = `Coaching intensivo en ${comp_baja.name} (3 sesiones de 20 min c/u). Práctica diaria: 2 simulaciones mínimo. Meta: ${comp_baja.name} de ${comp_baja.score}/10 → 8+/10 en 7 días.`;

  const plan_3 = `Validación completa en 7 días. Si score ≥ 8/10 en todos: autorizar a producción. Si score < 8/10: extender coaching 3 días más.`;

  // ===== ACTIVIDAD SESIÓN =====
  const actividad_sesion = v(safe(wh, 'actividad_sesion', null),
    `${nombre} demostró dominio del módulo ${modulo} en ${duracion_texto}. La familia participó activamente. Se trabajaron objeciones principales. Puntos de quiebre identificados y manejados.`);

  // ===== TRANSCRIPCIÓN (si está disponible) =====
  let transcription = [];
  if (safe(wh, 'transcript', null)) {
    transcription = parseTranscript(safe(wh, 'transcript', ''), nombre, familia_nombre);
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

    // Fecha/Hora
    fecha_sesion,
    hora_sesion,
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
    fortalezas,
    areas_mejora,
    analisis_pnl,
    objeciones_trabajadas,
    actividad_sesion,

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
    version: 'v3.0',

    // ===== CONTEXTO DEL AGENTE (KB + RAG) =====
    // Enriquecimiento desde el snapshot de agent_4001kyww2ysve4ns6qhajvd6xrc8.
    // Permite al reporte mostrar contra qué guion se evaluó al asesor.
    agente: agentContext(modulo)
  };
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

/**
 * Parsear transcript y crear burbujas de chat con speaker detection
 */
function parseTranscript(transcriptText, asesorName, familyName) {
  const bubbles = [];
  const lines = transcriptText.split('\n').filter(l => l.trim());

  // ElevenLabs entrega los turnos con role "agent" / "user"
  const AGENT_KEYS = ['victor', 'carlos', 'george', 'agent', 'assistant', 'ai'];

  const SPEAKERS = {
    'victor': 'Victor',
    'carlos': 'Carlos',
    'george': 'George',
    'agent': 'Victor',
    'assistant': 'Victor',
    [asesorName.toLowerCase()]: asesorName,
    [familyName.toLowerCase()]: familyName,
    'familia': familyName,
    'usuario': familyName,
    'user': familyName
  };

  lines.forEach((line, idx) => {
    const match = line.match(/^(.*?):\s*(.*)$/);
    if (match) {
      const [, speaker, text] = match;
      const cleanSpeaker = speaker.trim().toLowerCase();
      const displaySpeaker = SPEAKERS[cleanSpeaker] || speaker.trim();
      const isAgent = AGENT_KEYS.includes(cleanSpeaker);

      bubbles.push({
        speaker: displaySpeaker,
        text: text.trim(),
        timestamp: `${String(Math.floor(idx / 2)).padStart(2, '0')}:${String((idx % 2) * 30).padStart(2, '0')}`,
        side: isAgent ? 'right' : 'left',
        type: isAgent ? 'agent' : 'user'
      });
    }
  });

  return bubbles;
}

module.exports = { mapElevenLabsData, parseTranscript };