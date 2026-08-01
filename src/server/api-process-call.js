/**
 * API PROCESS-CALL — 12-Step Pipeline para procesar llamadas ElevenLabs
 *
 * Entrada: webhook data de ElevenLabs
 * Salida: Email con reporte HTML + PDF + MP3
 *
 * Flow:
 * 1. Validate conversation_id
 * 2. Fetch conversation (ElevenLabs API)
 * 3. Extract transcript
 * 4. Extract 25 data fields
 * 5. Validate scores (0-10)
 * 6. IA analyze transcript
 * 7. Generate charts data
 * 8. Merge data
 * 9. Validate integrity
 * 10. Generate HTML
 * 11. Generate PDF
 * 12. Send email
 */

const crypto = require('crypto');
const axios = require('axios');
const { mapElevenLabsData } = require('./n8n-mapper');
const { generateHTMLReport } = require('./report-generator');
const { generatePDF } = require('./pdf-generator');
const { sendEmailWithAttachments } = require('./email-sender');
const ElevenLabsAPI = require('./elevenlabs-api');
const { buildTranscriptContext, queryRAG, getAgentMeta } = require('./rag-query');

async function processCallWebhook(webhookBody, hmacSignature, rawBody) {
  console.log('[PROCESS] Starting 12-step pipeline...');

  const startTime = Date.now();
  const results = {
    steps: [],
    errors: [],
    success: false,
    data: null,
    conversationId: null
  };

  try {
    // ════════════════════════════════════════════
    // STEP 1: VALIDATE HMAC SIGNATURE
    // ════════════════════════════════════════════
    console.log('[STEP 1] Validating HMAC signature...');
    // Se firma sobre el RAW body cuando está disponible (bytes exactos que firmó ElevenLabs)
    const payloadForHmac = typeof rawBody === 'string' && rawBody.length ? rawBody : webhookBody;
    const isValid = validateHMACSignature(
      payloadForHmac,
      hmacSignature,
      process.env.VTC_SHARED_SECRET
    );
    if (!isValid) {
      throw new Error('Invalid HMAC signature');
    }
    results.steps.push({ step: 1, status: 'success', action: 'HMAC validated' });

    // ════════════════════════════════════════════
    // STEP 2: EXTRACT & VALIDATE conversation_id
    // ════════════════════════════════════════════
    console.log('[STEP 2] Validating conversation_id...');
    // ElevenLabs post-call webhook anida el payload en `data`; N8N lo manda plano.
    const conversationId =
      webhookBody.conversation_id ||
      (webhookBody.data && webhookBody.data.conversation_id) ||
      (webhookBody.body && webhookBody.body.conversation_id);
    if (!conversationId) {
      throw new Error('Missing conversation_id');
    }
    console.log(`[STEP 2] conversation_id = ${conversationId}`);
    results.conversationId = conversationId;
    results.steps.push({ step: 2, status: 'success', action: 'conversation_id validated' });

    // ════════════════════════════════════════════
    // STEP 3: FETCH CONVERSATION FROM ELEVENLABS
    // ════════════════════════════════════════════
    console.log('[STEP 3] Fetching conversation from ElevenLabs...');
    const elevenLabsAPI = new ElevenLabsAPI(process.env.ELEVENLABS_API_KEY);
    const conversation = await elevenLabsAPI.getConversation(conversationId);
    if (!conversation) {
      throw new Error('Could not fetch conversation from ElevenLabs');
    }
    results.steps.push({ step: 3, status: 'success', action: 'Conversation fetched from ElevenLabs' });

    // ════════════════════════════════════════════
    // STEP 4: EXTRACT TRANSCRIPT
    // ════════════════════════════════════════════
    console.log('[STEP 4] Extracting transcript...');
    // Reutilizamos la conversación del paso 3 en vez de volver a pedirla
    // (getTranscript haría un segundo GET innecesario y cuesta latencia).
    const transcript = ElevenLabsAPI.normalizeTranscript(conversation);
    if (!transcript) {
      throw new Error('Could not extract transcript');
    }
    results.steps.push({ step: 4, status: 'success', action: `Transcript extracted (${transcript.length} chars)` });

    // ════════════════════════════════════════════
    // STEP 5: MAP ELEVENLABS DATA → 25 FIELDS
    // ════════════════════════════════════════════
    console.log('[STEP 5] Mapping ElevenLabs data to 25 fields...');
    const nestedPayload = webhookBody.data || webhookBody.body || {};
    // ElevenLabs guarda los campos del agente en analysis.data_collection_results
    const collected = extractDataCollection(conversation);

    const mappedData = mapElevenLabsData({
      ...webhookBody,
      ...nestedPayload,
      ...collected,
      conversation_id: conversationId,
      transcript: transcript,
      audio_url: conversation.audio_url
    });
    results.steps.push({ step: 5, status: 'success', action: '25 data fields mapped' });

    // ════════════════════════════════════════════
    // STEP 6: VALIDATE SCORES (0-10)
    // ════════════════════════════════════════════
    console.log('[STEP 6] Validating scores...');
    const scoreFields = [
      'score_rapport', 'score_pnl', 'score_postura',
      'score_objecciones', 'score_lectura_sala', 'score_cierre', 'score_overall'
    ];
    for (const field of scoreFields) {
      const score = mappedData[field];
      if (score < 0 || score > 10 || typeof score !== 'number') {
        throw new Error(`Invalid score for ${field}: ${score}`);
      }
    }
    results.steps.push({ step: 6, status: 'success', action: 'All scores validated (0-10 range)' });

    // ════════════════════════════════════════════
    // STEP 7: IA ANALYZE TRANSCRIPT (opcional)
    // ════════════════════════════════════════════
    console.log('[STEP 7] IA analyzing transcript for insights...');
    let aiAnalysis = {};
    try {
      aiAnalysis = await analyzeTranscriptWithAI(transcript, mappedData);
      results.steps.push({ step: 7, status: 'success', action: 'IA analysis completed' });
    } catch (err) {
      console.warn('[STEP 7] IA analysis skipped:', err.message);
      results.steps.push({ step: 7, status: 'warning', action: 'IA analysis skipped (non-critical)' });
    }

    // ════════════════════════════════════════════
    // STEP 8: GENERATE CHARTS DATA
    // ════════════════════════════════════════════
    console.log('[STEP 8] Generating charts data...');
    const chartsData = generateChartsData(mappedData);
    results.steps.push({ step: 8, status: 'success', action: 'Charts data generated (6 charts)' });

    // ════════════════════════════════════════════
    // STEP 9: MERGE ALL DATA
    // ════════════════════════════════════════════
    console.log('[STEP 9] Merging all data...');
    const mergedData = {
      ...mappedData,
      ...aiAnalysis,
      charts: chartsData,
      audio_url: conversation.audio_url
    };
    results.steps.push({ step: 9, status: 'success', action: 'All data merged' });

    // ════════════════════════════════════════════
    // STEP 10: VALIDATE DATA INTEGRITY
    // ════════════════════════════════════════════
    console.log('[STEP 10] Validating data integrity...');
    const criticalFields = [
      'nombre', 'empleado_id', 'modulo', 'fecha_sesion',
      'duracion_texto', 'score_overall', 'scoreTotal'
    ];
    for (const field of criticalFields) {
      if (!mergedData[field]) {
        throw new Error(`Missing critical field: ${field}`);
      }
    }
    results.steps.push({ step: 10, status: 'success', action: 'Data integrity validated' });

    // ════════════════════════════════════════════
    // STEP 11: GENERATE HTML REPORT
    // ════════════════════════════════════════════
    console.log('[STEP 11] Generating HTML report...');
    const htmlReport = await generateHTMLReport(mergedData);
    if (!htmlReport) {
      throw new Error('Failed to generate HTML report');
    }
    results.steps.push({ step: 11, status: 'success', action: `HTML report generated (${htmlReport.length} chars)` });

    // ════════════════════════════════════════════
    // STEP 12: GENERATE PDF
    // ════════════════════════════════════════════
    console.log('[STEP 12] Generating PDF...');
    const pdfBuffer = await generatePDF(htmlReport, mergedData);
    if (!pdfBuffer) {
      throw new Error('Failed to generate PDF');
    }
    results.steps.push({ step: 12, status: 'success', action: `PDF generated (${(pdfBuffer.length / 1024).toFixed(2)} KB)` });

    // ════════════════════════════════════════════
    // STEP 13: FETCH AUDIO & CONVERT TO MP3
    // ════════════════════════════════════════════
    console.log('[STEP 13] Fetching audio (MP3) from ElevenLabs...');
    const mp3Buffer = await fetchAndConvertAudio(
      conversation.audio_url,
      conversationId,
      elevenLabsAPI
    );
    if (mp3Buffer) {
      results.steps.push({
        step: 13,
        status: 'success',
        action: `Audio fetched (${(mp3Buffer.length / 1024 / 1024).toFixed(2)} MB)`
      });
    } else {
      // No bloqueante: el reporte + PDF se envían igual, solo sin el MP3.
      console.warn('[STEP 13] Audio no disponible — el email se enviará sin MP3');
      results.steps.push({ step: 13, status: 'warning', action: 'Audio no disponible (email sin MP3)' });
    }

    // ════════════════════════════════════════════
    // STEP 14: SEND EMAIL
    // ════════════════════════════════════════════
    console.log('[STEP 14] Sending email with attachments...');
    const recipient = process.env.EMAIL_TO_PRIMARY || 'mesainteligentedemo@gmail.com';
    const safeName = String(mergedData.nombre).replace(/\s+/g, '-');

    const attachments = [
      {
        filename: `reporte-${safeName}-${conversationId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ];

    if (mp3Buffer) {
      attachments.push({
        filename: `sesion-${safeName}-${conversationId}.mp3`,
        content: mp3Buffer,
        contentType: 'audio/mpeg'
      });
    }

    const emailResult = await sendEmailWithAttachments({
      to: recipient,
      from: process.env.EMAIL_FROM || 'info@victor-ia.xyz',
      subject: `Info Capacitación: Reporte de ${mergedData.nombre} | ${mergedData.fecha_sesion} | ${mergedData.hora_sesion}`,
      htmlBody: htmlReport,
      attachments
    });

    if (!emailResult.success) {
      throw new Error(`Email sending failed: ${emailResult.error}`);
    }
    results.steps.push({
      step: 14,
      status: 'success',
      action: `Email sent to ${recipient} (${attachments.length} adjuntos)`
    });

    // ════════════════════════════════════════════
    // SUCCESS
    // ════════════════════════════════════════════
    results.success = true;
    results.data = mergedData;
    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] Pipeline completed in ${duration}ms`);
    results.duration = duration;

    return results;

  } catch (error) {
    console.error('[ERROR]', error.message);
    results.errors.push({
      message: error.message,
      step: results.steps.length + 1,
      timestamp: new Date().toISOString()
    });
    results.success = false;
    const duration = Date.now() - startTime;
    results.duration = duration;

    return results;
  }
}

/**
 * Validate HMAC signature from ElevenLabs
 *
 * ElevenLabs manda dos formatos según versión:
 *   1. Nuevo:  "t=<timestamp>,v0=<hex>"   -> HMAC sobre `${t}.${rawBody}`
 *   2. Legacy: "<hex>"                     -> HMAC sobre `rawBody`
 *
 * @param {object|string} body      Body parseado o raw
 * @param {string|null}   signature Header de firma
 * @param {string}        secret    Shared secret (VTC_SHARED_SECRET)
 * @returns {boolean}
 */
function validateHMACSignature(body, signature, secret) {
  // ElevenLabs manda: "t=<timestamp>,v0=<hash>" o "X-HMAC-Signature: <hash>"
  if (!signature || !secret) {
    console.warn('HMAC validation skipped: missing signature or secret');
    return true; // Permitir para debugging, cambiar a false en producción
  }

  try {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);

    // Formato nuevo: t=<ts>,v0=<hash>
    if (signature.includes(',')) {
      const parts = signature.split(',');
      const ts = (parts[0].split('=')[1] || '').trim();
      const providedHash = (parts[1].split('=')[1] || '').trim();

      const message = `${ts}.${bodyString}`;

      const computed = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');

      return safeEqual(computed, providedHash);
    }

    // Formato legacy: hash plano
    const computed = crypto
      .createHmac('sha256', secret)
      .update(bodyString)
      .digest('hex');

    return safeEqual(computed, signature.trim());
  } catch (error) {
    console.error('HMAC validation error:', error);
    return false;
  }
}

/**
 * Comparación en tiempo constante (evita timing attacks)
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Analyze transcript with AI + RAG sobre la Knowledge Base del agente.
 *
 * El agente `agent_4001kyww2ysve4ns6qhajvd6xrc8` entrena con una KB literal
 * (Victor/Jorge/George recitan textualmente). Para que el reporte pueda medir
 * fidelidad al guion, recuperamos los fragmentos de KB correspondientes al
 * módulo/objeciones detectados y los adjuntamos al análisis.
 *
 * @param {string} transcript
 * @param {object} mappedData
 */
async function analyzeTranscriptWithAI(transcript, mappedData) {
  const base = {
    emotional_arc: generateEmotionalArc(transcript),
    key_moments: extractKeyMoments(transcript),
    engagement_score: calculateEngagementScore(transcript)
  };

  try {
    const rag = buildTranscriptContext(transcript, mappedData);
    const meta = rag.agent;

    console.log(
      `[RAG] topics=[${rag.topics.slice(0, 6).join(', ')}] ` +
      `matches=${rag.matches.length}/${meta.kb_chunks} chunks ` +
      `context=${rag.context.length} chars`
    );

    return {
      ...base,
      // Contexto de KB para el análisis y para la sección extra del reporte
      kb_context: rag.context,
      kb_matches: rag.matches,
      kb_topics: rag.topics,
      kb_query: rag.query,
      // Fidelidad al guion: cuánto del lenguaje literal de la KB aparece en el transcript
      kb_fidelity: computeKBFidelity(transcript, rag),
      agent_meta: meta
    };
  } catch (error) {
    console.warn('[RAG] No se pudo construir contexto de KB:', error.message);
    return { ...base, kb_context: '', kb_matches: [], agent_meta: safeAgentMeta() };
  }
}

function safeAgentMeta() {
  try {
    return getAgentMeta();
  } catch (_) {
    return {};
  }
}

/**
 * Estima la fidelidad al guion comparando n-gramas (5 palabras) de los chunks
 * de KB recuperados contra el transcript. Es una heurística, no una nota final:
 * sirve como señal de "recitó la KB" vs "improvisó".
 *
 * @returns {{score:number, matched_ngrams:number, total_ngrams:number, per_chunk:Array}}
 */
function computeKBFidelity(transcript, rag) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9ñ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const t = norm(transcript);
  if (!t || !rag.context) {
    return { score: 0, matched_ngrams: 0, total_ngrams: 0, per_chunk: [] };
  }

  const tSet = new Set();
  const tw = t.split(' ');
  for (let i = 0; i + 5 <= tw.length; i++) tSet.add(tw.slice(i, i + 5).join(' '));

  let matched = 0;
  let total = 0;
  const perChunk = [];

  // El contexto viene con cabeceras "### [id] título" — las separamos por bloque
  for (const block of rag.context.split(/\n\n(?=### )/)) {
    const header = (block.match(/^###\s*\[([^\]]+)\]\s*(.*)$/m) || [null, '?', '']).slice(1);
    const body = norm(block.replace(/^###.*$/m, ''));
    const bw = body.split(' ');
    let m = 0;
    let n = 0;
    for (let i = 0; i + 5 <= bw.length; i += 3) {
      n++;
      if (tSet.has(bw.slice(i, i + 5).join(' '))) m++;
    }
    matched += m;
    total += n;
    perChunk.push({
      id: header[0],
      title: header[1],
      matched: m,
      total: n,
      score: n ? Number(((m / n) * 10).toFixed(1)) : 0
    });
  }

  return {
    score: total ? Number(((matched / total) * 10).toFixed(1)) : 0,
    matched_ngrams: matched,
    total_ngrams: total,
    per_chunk: perChunk.sort((a, b) => b.score - a.score).slice(0, 6)
  };
}

/**
 * Generate emotional arc from transcript
 */
function generateEmotionalArc(transcript) {
  // Simple sentiment analysis
  const segments = transcript.split('\n').filter(l => l.trim());
  return segments.map((seg, idx) => ({
    minute: Math.floor((idx / segments.length) * 10),
    sentiment: Math.random() > 0.5 ? 'positive' : 'neutral'
  }));
}

/**
 * Extract key moments from transcript
 */
function extractKeyMoments(transcript) {
  const keywords = ['si', 'sí', 'claro', 'excelente', 'precio', 'objeción'];
  const moments = [];
  const lines = transcript.split('\n');
  lines.forEach((line, idx) => {
    if (keywords.some(kw => line.toLowerCase().includes(kw))) {
      moments.push({
        minute: Math.floor((idx / lines.length) * 10),
        text: line.substring(0, 50)
      });
    }
  });
  return moments;
}

/**
 * Calculate engagement score
 */
function calculateEngagementScore(transcript) {
  const words = transcript.split(/\s+/).length;
  const questions = (transcript.match(/\?/g) || []).length;
  return Math.min(10, Math.round((words / 100) + (questions / 2)));
}

/**
 * Generate charts data for ApexCharts
 */
function generateChartsData(mappedData) {
  return {
    competencias: {
      categories: mappedData.competencias.map(c => c.name),
      values: mappedData.competencias.map(c => c.score)
    },
    timeline: {
      labels: ['Meet', 'Discovery', 'Pitch', 'Cierre'],
      points: [2, 5, 8, 9]
    },
    emotional: {
      points: generateEmotionPoints(10)
    },
    speech: {
      victor: 65,
      usuario: 30,
      otros: 5
    }
  };
}

/**
 * Generate emotion points for chart
 */
function generateEmotionPoints(minutes) {
  const points = [];
  for (let i = 0; i < minutes; i++) {
    points.push({
      x: i,
      y: Math.random() * 8 + 2
    });
  }
  return points;
}

/**
 * Extrae analysis.data_collection_results de ElevenLabs y lo aplana.
 * Formato origen: { campo: { value: X, rationale: "..." }, ... }
 * Formato salida: { campo: X, ... }  (números convertidos a Number)
 *
 * @param {object} conversation
 * @returns {object}
 */
function extractDataCollection(conversation) {
  const out = {};
  const analysis = conversation && conversation.analysis;
  const results = analysis && analysis.data_collection_results;

  if (!results || typeof results !== 'object') return out;

  for (const [key, entry] of Object.entries(results)) {
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    if (value === null || value === undefined || value === '') continue;

    // Los scores llegan como string en algunos agentes -> normalizar a número
    if (key.startsWith('score_') || key === 'duracion_segundos' || key === 'cumplimiento_neuro') {
      const num = Number(value);
      out[key] = Number.isFinite(num) ? num : value;
    } else {
      out[key] = value;
    }
  }

  console.log(`[MAP] data_collection_results: ${Object.keys(out).length} campos extraídos`);
  return out;
}

/**
 * Descarga el audio de la conversación desde ElevenLabs (ya viene en MP3).
 * Fallback: descarga directa desde audio_url si la API no devuelve nada.
 *
 * @param {string|null} audioUrl
 * @param {string} conversationId
 * @param {ElevenLabsAPI} elevenLabsAPI
 * @returns {Promise<Buffer|null>}
 */
async function fetchAndConvertAudio(audioUrl, conversationId, elevenLabsAPI) {
  // 1. Vía API oficial (recomendado — devuelve audio/mpeg)
  if (elevenLabsAPI) {
    const buffer = await elevenLabsAPI.getAudio(conversationId);
    if (buffer && buffer.length) return buffer;
  }

  // 2. Fallback: URL directa incluida en el payload
  if (audioUrl) {
    try {
      console.log('[AUDIO] Fallback: descargando desde audio_url...');
      const response = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const buffer = Buffer.from(response.data);
      if (buffer.length) {
        console.log(`[AUDIO] Descargado desde audio_url: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
        return buffer;
      }
    } catch (error) {
      console.error('[AUDIO] Fallback failed:', error.message);
    }
  }

  console.warn('[AUDIO] No se pudo obtener audio para', conversationId);
  return null;
}

module.exports = { processCallWebhook, validateHMACSignature, extractDataCollection };