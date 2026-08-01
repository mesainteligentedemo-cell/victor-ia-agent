/**
 * RAG QUERY — Recuperación sobre la Knowledge Base del agente ElevenLabs
 *
 * Fuente de verdad: src/server/elevenlabs-agent-config.json
 * (snapshot de agent_4001kyww2ysve4ns6qhajvd6xrc8 — system prompt + KB + RAG config)
 *
 * Implementa un retriever TF-IDF ligero (sin dependencias ni llamadas de red) que
 * respeta la configuración RAG real del agente:
 *   - max_documents_length          -> presupuesto de caracteres del contexto
 *   - max_retrieved_rag_chunks_count-> nº de chunks devueltos por defecto
 *   - query_rewrite_prompt_override -> reglas de prioridad (módulo > objeción > neurociencia)
 *
 * Uso:
 *   const { queryRAG, getSystemPrompt, buildTranscriptContext } = require('./rag-query');
 *   const res = queryRAG('¿cómo maneja la objeción de precio?');
 *   res.context  -> texto listo para inyectar en un prompt
 */

const agentConfig = require('./elevenlabs-agent-config.json');

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════
const RAG = agentConfig.rag || {};
const CHUNKS = (agentConfig.knowledge_base && agentConfig.knowledge_base.chunks) || [];
const MAX_CONTEXT_CHARS = RAG.max_documents_length || 15000;
// El agente usa 1 chunk en vivo (latencia). Para el análisis offline del reporte
// podemos permitirnos más contexto, así que subimos el default a 4.
const DEFAULT_TOP_K = Math.max(RAG.max_retrieved_rag_chunks_count || 1, 4);

// Marcadores que el propio query_rewrite_prompt_override manda ignorar
const IGNORE_MARKERS = /\[(SILENCE|SILENCIO|gesto|Espera|pausa|PAUSA)[^\]]*\]/gi;

const STOPWORDS = new Set([
  // ES
  'a','al','algo','ante','antes','aqui','aquí','asi','así','aun','aún','cada','como','cómo','con','contra',
  'cual','cuál','cuando','cuándo','de','del','desde','donde','dónde','dos','el','él','ella','ellos','en',
  'entre','era','es','esa','ese','eso','esta','está','este','esto','estos','fue','ha','han','hasta','hay',
  'la','las','le','les','lo','los','mas','más','me','mi','mis','mucho','muy','ni','no','nos','o','otra',
  'otro','para','pero','por','porque','que','qué','se','ser','si','sí','sin','sobre','su','sus','tan',
  'te','tiene','todo','todos','tu','un','una','uno','unos','y','ya','sus','sea','son','fueron','les',
  // EN
  'a','about','all','an','and','any','are','as','at','be','been','but','by','can','do','does','for','from',
  'had','has','have','he','her','his','how','i','if','in','into','is','it','its','me','my','no','not','of',
  'on','or','our','out','she','so','some','than','that','the','their','them','then','there','these','they',
  'this','to','up','was','we','were','what','when','where','which','who','why','will','with','you','your'
]);

// Términos que el prompt de reescritura marca como prioritarios
const PRIORITY_TERMS = {
  module: ['modulo', 'módulo', 'module', 'parte', 'part', 'meet', 'greet', 'agenda', 'pitch', 'cierre',
           'closing', 'discovery', 'bienvenida', 'welcome', 'calibration', 'calibracion'],
  objection: ['objecion', 'objeción', 'objection', 'precio', 'price', 'caro', 'expensive', 'duda',
              'rebuttal', 'respuesta', 'interrupcion', 'interrupción', 'interruption'],
  neuro: ['neurociencia', 'neuroscience', 'como', 'cómo', 'porque', 'por qué', 'para que', 'para qué']
};

// ════════════════════════════════════════════
// ÍNDICE (se construye una sola vez por lambda)
// ════════════════════════════════════════════
let _index = null;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')      // quita acentos para casar objecion/objecion
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function buildIndex() {
  if (_index) return _index;

  const docs = CHUNKS.map((c) => {
    const tokens = tokenize(`${c.title} ${c.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return {
      id: c.id,
      title: c.title,
      text: c.text,
      chars: c.chars,
      titleTokens: new Set(tokenize(c.title)),
      tf,
      length: tokens.length || 1
    };
  });

  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);

  const N = docs.length || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / (1 + n)) + 1);

  _index = { docs, idf, N };
  return _index;
}

// ════════════════════════════════════════════
// QUERY
// ════════════════════════════════════════════
/**
 * Busca en la Knowledge Base del agente.
 *
 * @param {string} question              Pregunta / tema a buscar
 * @param {object} [opts]
 * @param {number} [opts.topK]           Nº de chunks a devolver
 * @param {number} [opts.maxChars]       Presupuesto de caracteres del contexto
 * @param {number} [opts.minScore]       Score mínimo para considerar un match
 * @returns {{query:string, matches:Array, context:string, chunksSearched:number, truncated:boolean}}
 */
function queryRAG(question, opts = {}) {
  const topK = opts.topK || DEFAULT_TOP_K;
  const maxChars = opts.maxChars || MAX_CONTEXT_CHARS;
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0.5;

  const empty = { query: question || '', matches: [], context: '', chunksSearched: CHUNKS.length, truncated: false };
  if (!question || !String(question).trim() || !CHUNKS.length) return empty;

  const { docs, idf } = buildIndex();
  const qTokens = tokenize(question);
  if (!qTokens.length) return empty;

  const qSet = new Set(qTokens);
  const flags = detectPriority(qTokens);

  const scored = docs.map((d) => {
    let score = 0;
    for (const t of qSet) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      // TF normalizado por longitud * IDF
      score += (tf / d.length) * (idf.get(t) || 1) * 10;
    }
    // Boost: coincidencia en el título (regla 1 del query_rewrite: empezar por el módulo)
    let titleHits = 0;
    for (const t of qSet) if (d.titleTokens.has(t)) titleHits++;
    if (titleHits) score *= 1 + 0.6 * titleHits;

    // Boost por prioridad declarada en query_rewrite_prompt_override
    if (flags.module && /MODUL|MODULE|PART|MEET|AGENDA|PITCH|CIERRE|CLOSING/i.test(d.title)) score *= 1.35;
    if (flags.objection && /OBJEC|OBJECTION|INTERRUP|PRECIO|PRICE/i.test(d.title + ' ' + d.text.slice(0, 400))) score *= 1.25;
    if (flags.neuro && /NEURO/i.test(d.title)) score *= 1.2;

    return { id: d.id, title: d.title, text: d.text, chars: d.chars, score: Number(score.toFixed(4)) };
  });

  const matches = scored
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Construye el contexto respetando el presupuesto de caracteres
  let used = 0;
  let truncated = false;
  const parts = [];
  for (const m of matches) {
    const clean = m.text.replace(IGNORE_MARKERS, '').trim();
    const header = `### [${m.id}] ${m.title}\n`;
    const remaining = maxChars - used - header.length;
    if (remaining <= 200) { truncated = true; break; }
    const body = clean.length > remaining ? clean.slice(0, remaining) + '…' : clean;
    if (clean.length > remaining) truncated = true;
    parts.push(header + body);
    used += header.length + body.length;
  }

  return {
    query: question,
    matches: matches.map(({ text, ...rest }) => rest), // sin el texto completo para logs ligeros
    context: parts.join('\n\n'),
    chunksSearched: CHUNKS.length,
    truncated
  };
}

function detectPriority(qTokens) {
  const s = new Set(qTokens);
  const has = (list) => list.some((w) => s.has(w.normalize('NFD').replace(/\p{Diacritic}/gu, '')));
  return {
    module: has(PRIORITY_TERMS.module),
    objection: has(PRIORITY_TERMS.objection),
    neuro: has(PRIORITY_TERMS.neuro)
  };
}

// ════════════════════════════════════════════
// HELPERS DE ALTO NIVEL
// ════════════════════════════════════════════

/** System prompt completo del agente (para dar contexto al análisis del transcript). */
function getSystemPrompt() {
  return agentConfig.system_prompt || '';
}

/** Metadatos del agente (id, nombre, modelo, tamaño de KB). */
function getAgentMeta() {
  const kb = agentConfig.knowledge_base || {};
  return {
    agent_id: agentConfig.agent_id,
    agent_name: agentConfig.agent_name,
    llm: (agentConfig.llm && agentConfig.llm.model) || null,
    rag_enabled: !!(agentConfig.rag && agentConfig.rag.enabled),
    embedding_model: agentConfig.rag && agentConfig.rag.embedding_model,
    kb_document: (kb.primary_document && kb.primary_document.name) || null,
    kb_chars: (kb.primary_document && kb.primary_document.chars) || 0,
    kb_chunks: (kb.chunks || []).length,
    system_prompt_chars: (agentConfig.system_prompt || '').length,
    data_collection_fields: (agentConfig.data_collection_fields || []).length
  };
}

/**
 * Deriva los temas relevantes de un transcript y recupera el contexto de KB
 * correspondiente. Se usa en el PASO 7 del pipeline para que el análisis
 * compare lo que el alumno dijo contra lo que la KB dicta literalmente.
 *
 * @param {string} transcript
 * @param {object} [mappedData] datos ya mapeados (modulo, objeciones, etc.)
 * @returns {{topics:string[], context:string, matches:Array, agent:object}}
 */
function buildTranscriptContext(transcript, mappedData = {}) {
  const topics = [];

  if (mappedData.modulo) topics.push(String(mappedData.modulo));

  // Palabras clave del ASR del agente que aparecen en el transcript
  const lower = String(transcript || '').toLowerCase();
  const kw = (agentConfig.asr_keywords || []).filter((k) => lower.includes(String(k).toLowerCase()));
  topics.push(...kw.slice(0, 8));

  // Señales de objeción / neurociencia
  if (/objeci|objection|precio|price|caro|expensive/i.test(lower)) topics.push('manejo de objeciones precio');
  if (/neuro|por qu[eé]|para qu[eé]/i.test(lower)) topics.push('neurociencia como por que para que');

  const query = [...new Set(topics)].join(' ').trim();
  const res = queryRAG(query, { topK: DEFAULT_TOP_K, maxChars: Math.min(MAX_CONTEXT_CHARS, 8000) });

  return {
    topics: [...new Set(topics)],
    query,
    context: res.context,
    matches: res.matches,
    agent: getAgentMeta()
  };
}

module.exports = {
  queryRAG,
  getSystemPrompt,
  getAgentMeta,
  buildTranscriptContext,
  _internals: { tokenize, buildIndex }
};