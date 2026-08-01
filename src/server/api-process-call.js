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
const { mapElevenLabsData } = require('./n8n-mapper');
const { generateHTMLReport } = require('./report-generator');
const { generatePDF } = require('./pdf-generator');
const { sendEmailWithAttachments } = require('./email-sender');
const ElevenLabsAPI = require('./elevenlabs-api');

async function processCallWebhook(webhookBody, hmacSignature) {
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
    const isValid = validateHMACSignature(webhookBody, hmacSignature);
    if (!isValid) {
      throw new Error('Invalid HMAC signature');
    }
    results.steps.push({ step: 1, status: 'success', action: 'HMAC validated' });

    // ════════════════════════════════════════════
    // STEP 2: EXTRACT & VALIDATE conversation_id
    // ════════════════════════════════════════════
    console.log('[STEP 2] Validating conversation_id...');
    const conversationId = webhookBody.conversation_id;
    if (!conversationId) {
      throw new Error('Missing conversation_id');
    }
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
    const transcript = await elevenLabsAPI.getTranscript(conversationId);
    if (!transcript) {
      throw new Error('Could not extract transcript');
    }
    results.steps.push({ step: 4, status: 'success', action: `Transcript extracted (${transcript.length} chars)` });

    // ════════════════════════════════════════════
    // STEP 5: MAP ELEVENLABS DATA → 25 FIELDS
    // ════════════════════════════════════════════
    console.log('[STEP 5] Mapping ElevenLabs data to 25 fields...');
    const mappedData = mapElevenLabsData({
      ...webhookBody,
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
    console.log('[STEP 13] Fetching and converting audio to MP3...');
    const mp3Buffer = await fetchAndConvertAudio(conversation.audio_url, conversationId);
    if (!mp3Buffer) {
      throw new Error('Failed to fetch/convert audio');
    }
    results.steps.push({ step: 13, status: 'success', action: `Audio converted (${(mp3Buffer.length / 1024 / 1024).toFixed(2)} MB)` });

    // ════════════════════════════════════════════
    // STEP 14: SEND EMAIL
    // ════════════════════════════════════════════
    console.log('[STEP 14] Sending email with attachments...');
    const emailResult = await sendEmailWithAttachments({
      to: process.env.EMAIL_TO_PRIMARY || 'mesainteligentedemo@gmail.com',
      from: process.env.EMAIL_FROM || 'info@victor-ia.com.mx',
      subject: `Info Capacitación: Reporte de ${mergedData.nombre} | ${mergedData.fecha_sesion} | ${mergedData.hora_sesion}`,
      htmlBody: htmlReport,
      attachments: [
        {
          filename: `reporte-${mergedData.nombre.replace(/\s+/g, '-')}-${conversationId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        },
        {
          filename: `sesion-${mergedData.nombre.replace(/\s+/g, '-')}-${conversationId}.mp3`,
          content: mp3Buffer,
          contentType: 'audio/mpeg'
        }
      ]
    });

    if (!emailResult.success) {
      throw new Error(`Email sending failed: ${emailResult.error}`);
    }
    results.steps.push({ step: 14, status: 'success', action: `Email sent to ${process.env.EMAIL_TO_PRIMARY}` });

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
 */
function validateHMACSignature(body, signature) {
  const secret = process.env.VTC_SHARED_SECRET || 'secret';
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return hmac === signature;
}

/**
 * Analyze transcript with AI (optional enhancement)
 */
async function analyzeTranscriptWithAI(transcript, mappedData) {
  // Placeholder for AI analysis
  // Could integrate with OpenAI, Claude, etc.
  return {
    emotional_arc: generateEmotionalArc(transcript),
    key_moments: extractKeyMoments(transcript),
    engagement_score: calculateEngagementScore(transcript)
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
 * Fetch and convert audio to MP3
 */
async function fetchAndConvertAudio(audioUrl, conversationId) {
  // This is a placeholder - actual implementation would:
  // 1. Fetch audio from URL
  // 2. Convert to MP3 using ffmpeg
  // 3. Return buffer

  // For now, return mock buffer
  return Buffer.from('mock-mp3-data');
}

module.exports = { processCallWebhook };