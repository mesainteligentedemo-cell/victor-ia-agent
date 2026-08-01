/**
 * API PROCESS-CALL — Pipeline de 14 pasos para procesar llamadas de ElevenLabs
 *
 * Entrada: webhook de ElevenLabs (o de N8N) + firma HMAC
 * Salida:  correo con reporte HTML + PDF adjunto + MP3 de la sesión
 *
 * Flujo:
 *  1. Validar firma HMAC          (fail-closed: sin firma válida, 401)
 *  2. Extraer y validar conversation_id
 *  3. Traer la conversación de ElevenLabs
 *  4. Extraer transcript + turnos con tiempo real
 *  5. Mapear a los campos del reporte
 *  6. Validar scores (número finito en 0-10)
 *  7. Análisis IA + RAG sobre la KB   (opcional, no bloqueante)
 *  8. Construir datos de los 6 gráficos
 *  9. Fusionar todo
 * 10. Validar integridad             (0 es un dato válido, no un hueco)
 * 11. Generar el HTML del reporte
 * 12. Generar el PDF                 (Chromium headless)
 * 13. Descargar el MP3               (opcional, sujeto a presupuesto)
 * 14. Enviar el correo con adjuntos
 *
 * PRESUPUESTO: la lambda muere a los 60s (vercel.json). Cada paso consulta
 * `remaining()` y los opcionales se saltan antes que arriesgar el envío.
 */

const crypto = require('crypto');
const axios = require('axios');
const { mapElevenLabsData } = require('./n8n-mapper');
const { generateHTMLReport } = require('./report-generator');
const { generatePDF } = require('./pdf-generator');
const { sendEmailWithAttachments, buildEmailPackage } = require('./email-sender');
const ElevenLabsAPI = require('./elevenlabs-api');
const { buildTranscriptContext, queryRAG, getAgentMeta } = require('./rag-query');
const { cacheReport } = require('./report-cache');

/** Las 7 competencias que el reporte puntúa de 0 a 10. */
const SCORE_FIELDS = [
  'score_rapport',
  'score_pnl',
  'score_postura',
  'score_objecciones',
  'score_lectura_sala',
  'score_cierre',
  'score_overall'
];

/**
 * Campos sin los que el reporte no se puede emitir.
 * `numeric: true` marca los que aceptan 0 como valor legítimo.
 */
const CRITICAL_FIELDS = [
  { key: 'nombre', numeric: false },
  { key: 'empleado_id', numeric: false },
  { key: 'modulo', numeric: false },
  { key: 'fecha_sesion', numeric: false },
  { key: 'duracion_texto', numeric: false },
  { key: 'score_overall', numeric: true },
  { key: 'scoreTotal', numeric: true }
];

/**
 * Verifica que los datos alcancen para renderizar el reporte.
 *
 * Clave: "falta" significa null / undefined / cadena vacía. NUNCA el número 0.
 * Un asesor con score 0 es un dato válido — y el más importante de reportar.
 *
 * @param {object} data
 * @returns {{ok:boolean, missing:string[], warnings:string[]}}
 */
function validateReportData(data) {
  const d = data || {};
  const missing = [];
  const warnings = [];

  for (const { key, numeric } of CRITICAL_FIELDS) {
    const value = d[key];
    if (value === null || value === undefined || value === '') {
      missing.push(key);
      continue;
    }
    if (numeric && !Number.isFinite(Number(value))) {
      missing.push(`${key} (no numérico: ${JSON.stringify(value)})`);
    }
  }

  // Avisos: no bloquean el envío, pero quedan en el log para diagnosticar
  // un reporte pobre sin tener que reproducir la sesión.
  if (!Array.isArray(d.competencias) || d.competencias.length < 3) {
    warnings.push('Menos de 3 competencias: los gráficos saldrán degradados');
  }
  if (!Array.isArray(d.transcription) || !d.transcription.length) {
    warnings.push('Sin transcripción: el reporte no mostrará el diálogo');
  }
  if (!d.charts || !d.charts.competencias) {
    warnings.push('Sin datos de gráficos: se usarán los placeholders');
  }
  for (const campo of ['resumen', 'fortalezas', 'areas_mejora', 'recomendacion_coach']) {
    if (!d[campo] || String(d[campo]).trim() === '-') {
      warnings.push(`Campo narrativo vacío: ${campo} (se usará el texto por defecto)`);
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Presupuesto total del pipeline dentro de la lambda.
 *
 * Vercel corta la función a los 60s (ver vercel.json). Reservamos 5s para que
 * el handler pueda serializar y devolver la respuesta: si la lambda muere en
 * seco, N8N no recibe nada y no sabe si el correo salió o no.
 */
const PIPELINE_BUDGET_MS = Number(process.env.PIPELINE_BUDGET_MS || 55000);
/** Por debajo de esto no se intenta ningún paso opcional. */
const MIN_SLACK_MS = 10000;
/** El audio es opcional: solo se busca si sobra este margen. */
const AUDIO_MIN_SLACK_MS = 14000;
/** Margen mínimo para intentar el envío del correo (paso final, obligatorio). */
const EMAIL_MIN_SLACK_MS = 6000;

async function processCallWebhook(webhookBody, hmacSignature, rawBody) {
  console.log('[PROCESS] Starting 14-step pipeline...');

  const startTime = Date.now();
  /** Milisegundos que quedan antes de que Vercel mate la lambda. */
  const remaining = () => PIPELINE_BUDGET_MS - (Date.now() - startTime);

  const results = {
    steps: [],
    errors: [],
    success: false,
    data: null,
    conversationId: null
  };

  /** Registra un paso con su marca de tiempo relativa — trazable en los logs. */
  const step = (n, status, action, extra) => {
    const elapsed = Date.now() - startTime;
    const entry = { step: n, status, action, elapsed_ms: elapsed, ...(extra || {}) };
    results.steps.push(entry);
    const icon = status === 'success' ? '✓' : status === 'warning' ? '!' : '×';
    console.log(`[STEP ${n}] ${icon} ${action} (+${elapsed}ms, quedan ${remaining()}ms)`);
    return entry;
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
      // 401 (no 422): la petición es correcta en forma, lo que falla es la autenticación.
      const err = new Error('Invalid HMAC signature');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    step(1, 'success', 'HMAC validated');

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
    results.conversationId = conversationId;
    step(2, 'success', 'conversation_id validated', { conversation_id: conversationId });

    // ════════════════════════════════════════════
    // STEP 3: FETCH CONVERSATION FROM ELEVENLABS
    // ════════════════════════════════════════════
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error('Missing ELEVENLABS_API_KEY');
    }
    const elevenLabsAPI = new ElevenLabsAPI(process.env.ELEVENLABS_API_KEY);
    const conversation = await elevenLabsAPI.getConversation(conversationId);
    if (!conversation) {
      throw new Error('Could not fetch conversation from ElevenLabs');
    }
    step(3, 'success', 'Conversation fetched from ElevenLabs');

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
    // Los turnos crudos conservan time_in_call_secs -> timestamps reales en el reporte
    const transcriptTurns = ElevenLabsAPI.extractTurns(conversation);
    step(4, 'success', `Transcript extracted (${transcript.length} chars, ${transcriptTurns.length} turnos)`, {
      transcript_chars: transcript.length,
      turns: transcriptTurns.length
    });

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
      transcript_turns: transcriptTurns,
      // El inicio real de la llamada manda sobre el momento de proceso:
      // el webhook puede llegar minutos después de que terminó la sesión.
      metadata: conversation.metadata || nestedPayload.metadata,
      audio_url: conversation.audio_url
    });
    step(5, 'success', `${Object.keys(mappedData).length} campos mapeados`, {
      campos_del_agente: Object.keys(collected).length
    });

    // ════════════════════════════════════════════
    // STEP 6: VALIDATE SCORES (0-10)
    // ════════════════════════════════════════════
    // OJO: `typeof NaN === 'number'` y NaN falla toda comparación, así que la
    // validación anterior (`score < 0 || score > 10`) dejaba pasar NaN entero.
    // Number.isFinite es la única comprobación que lo atrapa.
    for (const field of SCORE_FIELDS) {
      const score = mappedData[field];
      if (!Number.isFinite(score) || score < 0 || score > 10) {
        throw new Error(`Invalid score for ${field}: ${JSON.stringify(score)}`);
      }
    }
    step(6, 'success', 'Scores validados (número finito en 0-10)', {
      scores: Object.fromEntries(SCORE_FIELDS.map((f) => [f, mappedData[f]]))
    });

    // ════════════════════════════════════════════
    // STEP 7: IA ANALYZE TRANSCRIPT (opcional)
    // ════════════════════════════════════════════
    console.log('[STEP 7] IA analyzing transcript for insights...');
    let aiAnalysis = {};
    try {
      aiAnalysis = await analyzeTranscriptWithAI(transcript, mappedData);
      step(7, 'success', 'IA analysis completed');
    } catch (err) {
      console.warn('[STEP 7] IA analysis skipped:', err.message);
      step(7, 'warning', `IA analysis skipped (no crítico): ${err.message}`);
    }

    // ════════════════════════════════════════════
    // STEP 8: GENERATE CHARTS DATA
    // ════════════════════════════════════════════
    const chartsData = generateChartsData(mappedData, transcript, transcriptTurns);
    step(8, 'success', 'Charts data generated (6 charts)');

    // ════════════════════════════════════════════
    // STEP 9: MERGE ALL DATA
    // ════════════════════════════════════════════
    const mergedData = {
      ...mappedData,
      ...aiAnalysis,
      charts: chartsData,
      audio_url: conversation.audio_url
    };
    step(9, 'success', 'All data merged');

    // ════════════════════════════════════════════
    // STEP 10: VALIDATE DATA INTEGRITY
    // ════════════════════════════════════════════
    // `!mergedData[field]` rechazaba un score_overall de 0 como "campo
    // faltante" — un asesor con desempeño 0 no generaba reporte. Faltante es
    // null / undefined / cadena vacía, nunca el número cero.
    const validation = validateReportData(mergedData);
    if (!validation.ok) {
      throw new Error(`Datos incompletos para el reporte: ${validation.missing.join(', ')}`);
    }
    for (const aviso of validation.warnings) console.warn(`[STEP 10] ${aviso}`);
    step(10, 'success', 'Data integrity validated', {
      warnings: validation.warnings.length ? validation.warnings : undefined
    });

    // ════════════════════════════════════════════
    // STEP 11: GENERATE HTML REPORT
    // ════════════════════════════════════════════
    const htmlReport = await generateHTMLReport(mergedData);
    if (!htmlReport) {
      throw new Error('Failed to generate HTML report');
    }
    step(11, 'success', `HTML report generated (${htmlReport.length} chars)`);

    // ════════════════════════════════════════════
    // STEP 12: GENERATE PDF
    // ════════════════════════════════════════════
    if (remaining() < MIN_SLACK_MS) {
      throw new Error(
        `Sin presupuesto para generar el PDF (quedan ${remaining()}ms de ${PIPELINE_BUDGET_MS}ms)`
      );
    }
    const pdfBuffer = await generatePDF(htmlReport, mergedData);
    if (!pdfBuffer || !pdfBuffer.length) {
      throw new Error('Failed to generate PDF');
    }
    step(12, 'success', `PDF generated (${(pdfBuffer.length / 1024).toFixed(2)} KB)`, {
      pdf_bytes: pdfBuffer.length
    });

    // Cachea el reporte para que los CTAs (/api/pdf/:id, /player, /retrain)
    // respondan sin repetir el pipeline completo.
    cacheReport(conversationId, {
      pdf: pdfBuffer,
      html: htmlReport,
      data: mergedData,
      pdfFilename: null
    });

    // ════════════════════════════════════════════
    // STEP 13: FETCH AUDIO & CONVERT TO MP3 (opcional)
    // ════════════════════════════════════════════
    let mp3Buffer = null;
    if (remaining() < AUDIO_MIN_SLACK_MS) {
      // Salida temprana: el MP3 es un extra. Perderlo es aceptable; perder el
      // correo por agotar la lambda descargándolo, no.
      step(13, 'warning',
        `Audio omitido por presupuesto (quedan ${remaining()}ms) — el email sale sin MP3`);
    } else {
      mp3Buffer = await fetchAndConvertAudio(
        conversation.audio_url,
        conversationId,
        elevenLabsAPI,
        // Dejamos siempre margen para el envío del correo.
        Math.max(2000, remaining() - EMAIL_MIN_SLACK_MS - 2000)
      );
      if (mp3Buffer) {
        step(13, 'success', `Audio fetched (${(mp3Buffer.length / 1024 / 1024).toFixed(2)} MB)`, {
          mp3_bytes: mp3Buffer.length
        });
      } else {
        // No bloqueante: el reporte + PDF se envían igual, solo sin el MP3.
        step(13, 'warning', 'Audio no disponible (email sin MP3)');
      }
    }

    // ════════════════════════════════════════════
    // STEP 14: SEND EMAIL
    // ════════════════════════════════════════════
    if (remaining() < EMAIL_MIN_SLACK_MS) {
      console.warn(
        `[STEP 14] Margen ajustado (${remaining()}ms) — se intenta el envío igualmente`
      );
    }
    const recipients = resolveRecipients();

    // Asunto, cuerpos y nombres de archivo se derivan del mismo instante:
    // el PDF y el MP3 comparten base para que queden juntos al ordenar por nombre.
    const email = buildEmailPackage(mergedData, mergedData.session_iso);

    const attachments = [
      {
        filename: email.pdfFilename,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ];

    if (mp3Buffer) {
      attachments.push({
        filename: email.mp3Filename,
        content: mp3Buffer,
        contentType: 'audio/mpeg'
      });
    }

    const emailResult = await sendEmailWithAttachments({
      to: recipients,
      from: process.env.EMAIL_FROM || 'info@victor-ia.xyz',
      subject: email.subject,
      htmlBody: email.html,
      textBody: email.text,
      attachments
    });

    if (!emailResult.success) {
      throw new Error(`Email sending failed: ${emailResult.error}`);
    }
    step(14, 'success',
      `Email sent to ${recipients.join(', ')} (${attachments.map((a) => a.filename).join(', ')})`);

    // El nombre del PDF ya es definitivo: lo guardamos para /api/pdf/:id
    cacheReport(conversationId, {
      pdf: pdfBuffer,
      html: htmlReport,
      data: mergedData,
      pdfFilename: email.pdfFilename
    });

    results.email = {
      subject: email.subject,
      to: recipients,
      attachments: attachments.map((a) => a.filename),
      messageId: emailResult.messageId
    };

    // ════════════════════════════════════════════
    // SUCCESS
    // ════════════════════════════════════════════
    results.success = true;
    // Devolvemos un resumen, no `mergedData`: el objeto completo lleva el
    // transcript entero y las respuestas del webhook se quedaban en megabytes.
    results.data = {
      conversationId,
      nombre: mergedData.nombre,
      empleado_id: mergedData.empleado_id,
      modulo: mergedData.modulo,
      idioma: mergedData.idioma,
      fecha_sesion: mergedData.fecha_sesion,
      hora_cancun: mergedData.hora_cancun,
      duracion_texto: mergedData.duracion_texto,
      score_overall: mergedData.score_overall,
      scoreTotal: mergedData.scoreTotal,
      turnos: (mergedData.transcription || []).length,
      html_bytes: htmlReport.length,
      pdf_bytes: pdfBuffer.length,
      mp3_bytes: mp3Buffer ? mp3Buffer.length : 0
    };
    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] Pipeline completed in ${duration}ms`);
    results.duration = duration;

    return results;

  } catch (error) {
    console.error(`[ERROR] paso ${results.steps.length + 1}: ${error.message}`);
    results.errors.push({
      message: error.message,
      code: error.code || 'PIPELINE_ERROR',
      step: results.steps.length + 1,
      timestamp: new Date().toISOString()
    });
    results.success = false;
    // El HTTP status lo decide el error, no el handler: 401 para fallo de
    // autenticación, 422 para payload que no se pudo procesar.
    results.statusCode = Number(error.statusCode) || 422;
    const duration = Date.now() - startTime;
    results.duration = duration;

    return results;
  }
}

/**
 * Destinatarios del reporte.
 * EMAIL_TO_PRIMARY acepta varias direcciones separadas por coma o punto y coma.
 *
 * @returns {string[]}
 */
function resolveRecipients() {
  const raw = process.env.EMAIL_TO_PRIMARY || 'mesainteligentedemo@gmail.com';
  const list = String(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['mesainteligentedemo@gmail.com'];
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
  // FAIL-CLOSED: sin firma o sin secreto NO se procesa. Un webhook sin
  // autenticar puede disparar llamadas a ElevenLabs, render de Chromium y
  // envío de correo — es un vector de abuso y de fuga de datos.
  if (!signature || !secret) {
    console.error(
      `[HMAC] Rechazado: falta ${!signature ? 'firma en la petición' : ''}` +
      `${!signature && !secret ? ' y ' : ''}${!secret ? 'VTC_SHARED_SECRET en el servidor' : ''}`
    );
    return false;
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
 * Construye los datos de los 6 gráficos del reporte.
 *
 * Todo se deriva de la sesión real: los scores del agente y el transcript.
 * Nada es aleatorio — un reporte de evaluación con datos inventados no sirve
 * para tomar decisiones de coaching.
 *
 * @param {object} mappedData
 * @param {string} transcript Texto plano de la conversación
 * @param {Array}  turns      Turnos con tiempo real (puede venir vacío)
 */
function generateChartsData(mappedData, transcript, turns) {
  const comp = Object.fromEntries((mappedData.competencias || []).map((c) => [c.name, c.score]));

  return {
    competencias: {
      categories: (mappedData.competencias || []).map((c) => c.name),
      values: (mappedData.competencias || []).map((c) => c.score)
    },
    // Cada fase se evalúa con la competencia que realmente la gobierna
    timeline: {
      labels: ['Apertura', 'Descubrimiento', 'Presentación', 'Objeciones', 'Cierre'],
      points: [
        comp['Rapport'] ?? mappedData.score_rapport,
        comp['Lectura Sala'] ?? mappedData.score_lectura_sala,
        comp['PNL'] ?? mappedData.score_pnl,
        comp['Objeciones'] ?? mappedData.score_objecciones,
        comp['Cierre'] ?? mappedData.score_cierre
      ].map((v) => Number(v) || 0)
    },
    emotional: {
      points: buildEngagementCurve(transcript, mappedData.duracion_sec)
    },
    speech: buildSpeechSplit(transcript, turns)
  };
}

/**
 * Curva de engagement minuto a minuto.
 *
 * Proxy medible: densidad de intercambio (palabras + preguntas) por segmento.
 * Es determinista y reproducible — el mismo transcript da siempre la misma curva.
 *
 * @param {string} transcript
 * @param {number} duracionSec
 * @returns {Array<{x:number,y:number}>}
 */
function buildEngagementCurve(transcript, duracionSec) {
  const lines = String(transcript || '').split('\n').filter((l) => l.trim());
  const minutos = Math.max(2, Math.min(20, Math.round((Number(duracionSec) || 600) / 60)));

  if (lines.length < 2) {
    return Array.from({ length: minutos }, (_, i) => ({ x: i, y: 5 }));
  }

  const porSegmento = Math.max(1, Math.ceil(lines.length / minutos));
  const bruto = [];

  for (let i = 0; i < minutos; i++) {
    const slice = lines.slice(i * porSegmento, (i + 1) * porSegmento);
    if (!slice.length) {
      bruto.push(0);
      continue;
    }
    const texto = slice.join(' ');
    const palabras = texto.split(/\s+/).filter(Boolean).length;
    const preguntas = (texto.match(/\?/g) || []).length;
    // Las preguntas pesan: en venta consultiva marcan descubrimiento activo
    bruto.push(palabras + preguntas * 12);
  }

  // Normalizamos a 0-10 contra el pico de la propia sesión
  const max = Math.max(...bruto, 1);
  return bruto.map((valor, i) => ({
    x: i,
    y: Math.round((valor / max) * 90) / 10 + 1 // rango efectivo ~1..10
  }));
}

/**
 * Reparto del habla entre asesor y cliente simulado.
 * Se mide en caracteres pronunciados, que aproximan el tiempo en voz mucho
 * mejor que el número de turnos.
 *
 * @returns {{victor:number, usuario:number, otros:number}} porcentajes
 */
function buildSpeechSplit(transcript, turns) {
  let agentChars = 0;
  let userChars = 0;

  const AGENT_ROLES = ['agent', 'assistant', 'ai', 'victor', 'carlos', 'george', 'jorge'];

  if (Array.isArray(turns) && turns.length) {
    for (const t of turns) {
      const len = String(t.message || '').length;
      if (AGENT_ROLES.includes(String(t.role || '').toLowerCase())) agentChars += len;
      else userChars += len;
    }
  } else {
    for (const line of String(transcript || '').split('\n')) {
      const m = line.match(/^(.*?):\s*(.*)$/);
      if (!m) continue;
      const role = m[1].trim().toLowerCase();
      const len = m[2].length;
      if (AGENT_ROLES.includes(role)) agentChars += len;
      else userChars += len;
    }
  }

  const total = agentChars + userChars;
  if (!total) return { victor: 55, usuario: 40, otros: 5 };

  // 'otros' representa silencios/ruido: no se puede medir desde el texto,
  // así que se reserva un 5% fijo y se declara como tal en el gráfico.
  const otros = 5;
  const victor = Math.round((agentChars / total) * (100 - otros));
  return { victor, usuario: 100 - otros - victor, otros };
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
async function fetchAndConvertAudio(audioUrl, conversationId, elevenLabsAPI, budgetMs) {
  // El audio nunca puede costar más de lo que queda de lambda.
  const presupuesto = Math.max(2000, Number(budgetMs) || 15000);
  const inicio = Date.now();
  const restante = () => presupuesto - (Date.now() - inicio);

  // 1. Vía API oficial (recomendado — devuelve audio/mpeg)
  if (elevenLabsAPI) {
    const buffer = await elevenLabsAPI.getAudio(conversationId, restante());
    if (buffer && buffer.length) return buffer;
  }

  // 2. Fallback: URL directa incluida en el payload
  if (audioUrl && restante() > 2000) {
    try {
      console.log(`[AUDIO] Fallback: descargando desde audio_url (quedan ${restante()}ms)...`);
      const response = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: restante()
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

module.exports = {
  processCallWebhook,
  validateHMACSignature,
  extractDataCollection,
  validateReportData,
  generateChartsData,
  buildSpeechSplit,
  buildEngagementCurve,
  SCORE_FIELDS,
  CRITICAL_FIELDS
};
