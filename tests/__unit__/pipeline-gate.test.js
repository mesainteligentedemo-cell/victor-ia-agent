/**
 * PIPELINE — la puerta de sesión, cableada de extremo a extremo.
 *
 * Los tests de session-validation.test.js comprueban la DECISIÓN. Estos
 * comprueban las CONSECUENCIAS, que es lo que de verdad importa: que una
 * sesión sin contenido no gaste render de Chromium ni, sobre todo, mande un
 * correo con el nombre de un colaborador y un PDF que nadie evaluó.
 */

const crypto = require('crypto');

// ── Dobles de las dependencias caras ────────────────────────────
jest.mock('../../src/server/elevenlabs-api');
jest.mock('../../src/server/pdf-generator', () => ({
  generatePDF: jest.fn(async () => Buffer.from('%PDF-1.4 fake'))
}));
jest.mock('../../src/server/report-generator', () => ({
  generateHTMLReport: jest.fn(async () => '<html>reporte</html>')
}));
// Parcial: n8n-mapper usa los formateadores de fecha de este mismo módulo, así
// que solo se sustituye el envío real.
jest.mock('../../src/server/email-sender', () => ({
  ...jest.requireActual('../../src/server/email-sender'),
  sendEmailWithAttachments: jest.fn(async () => ({ success: true, messageId: 'msg_test' }))
}));

const ElevenLabsAPI = require('../../src/server/elevenlabs-api');
const { generatePDF } = require('../../src/server/pdf-generator');
const { sendEmailWithAttachments } = require('../../src/server/email-sender');
const { processCallWebhook } = require('../../src/server/api-process-call');

const SECRET = 'secreto-de-prueba';
const CONV_ID = 'conv_prueba_123';

/** Diálogo con holgura sobre el mínimo de palabras. */
function transcriptLargo() {
  return Array.from({ length: 24 }, (_, i) =>
    `Victor: Cuénteme qué los trae por aquí el día de hoy, con calma, turno ${i}\n`
    + `Christian Soria: Venimos de vacaciones con la familia y nos interesa conocer más ${i}`
  ).join('\n');
}

function turnos(n, base = 0) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'user' : 'agent',
    message: `Intervención de prueba número ${i} con suficiente texto para contar palabras`,
    time_in_call_secs: base + i
  }));
}

/**
 * Monta la conversación que devolvería ElevenLabs.
 * `dataCollection` es lo que el agente evaluó; vacío = no evaluó nada.
 */
function conversacion({ duracion, dataCollection, transcript, turns }) {
  return {
    conversation_id: CONV_ID,
    metadata: { call_duration_secs: duracion, start_time_unix_secs: 1785650000 },
    analysis: { data_collection_results: dataCollection },
    conversation_initiation_client_data: {
      dynamic_variables: { nombre: 'Christian Soria', empleado_id: '123456', departamento: 'Dirección' }
    },
    audio_url: null,
    __transcript: transcript,
    __turns: turns
  };
}

/** Firma legacy: HMAC sha256 del cuerpo crudo. */
function firmar(raw) {
  return crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

/**
 * Corre el pipeline y devuelve el resultado JUNTO CON una foto de los efectos.
 *
 * La foto no es un lujo: `clearMocks` está activo en jest.config.js y limpia el
 * historial antes de CADA test. Si las aserciones miraran los mocks
 * directamente, un `expect(sendEmail).not.toHaveBeenCalled()` pasaría siempre
 * —incluso si el correo se hubiera enviado— porque el historial ya estaría
 * borrado. Una prueba que no puede fallar no prueba nada.
 */
async function correr(conv) {
  jest.clearAllMocks();
  process.env.VTC_SHARED_SECRET = SECRET;
  process.env.ELEVENLABS_API_KEY = 'sk_test';
  process.env.REPORT_LINK_SECRET = 'link-secreto';

  ElevenLabsAPI.mockImplementation(() => ({
    getConversation: jest.fn(async () => conv),
    getAudio: jest.fn(async () => null)
  }));
  ElevenLabsAPI.normalizeTranscript = jest.fn(() => conv.__transcript);
  ElevenLabsAPI.extractTurns = jest.fn(() => conv.__turns || []);

  const body = { conversation_id: CONV_ID };
  const raw = JSON.stringify(body);
  const resultado = await processCallWebhook(body, firmar(raw), raw);

  return {
    resultado,
    pdfs: generatePDF.mock.calls.length,
    correos: sendEmailWithAttachments.mock.calls.length,
    correo: sendEmailWithAttachments.mock.calls.length
      ? sendEmailWithAttachments.mock.calls[0][0]
      : null
  };
}

// ════════════════════════════════════════════════════════════
describe('sesión de 14 segundos', () => {
  let run;

  beforeAll(async () => {
    run = await correr(conversacion({
      duracion: 14,
      dataCollection: { score_overall: { value: 8 } },
      transcript: transcriptLargo(),
      turns: turnos(6)
    }));
  });

  test('no se emite reporte y se dice por qué, en claro', () => {
    expect(run.resultado.success).toBe(false);
    expect(run.resultado.skipped).toBe(true);
    expect(run.resultado.motivo).toBe('SESION_MUY_CORTA');
    expect(run.resultado.error).toBe('Sesión muy corta');
    expect(run.resultado.message).toMatch(/al menos 30 segundos/);
  });

  test('NO se manda correo: nadie recibe un reporte de una sesión que no existió', () => {
    expect(run.correos).toBe(0);
  });

  test('NO se genera el PDF: la puerta va antes de gastar Chromium', () => {
    expect(run.pdfs).toBe(0);
  });

  /**
   * 200 y no 4xx: el webhook se recibió y se entendió. Un 4xx haría que N8N y
   * ElevenLabs reintentaran en bucle una sesión que nunca va a mejorar.
   */
  test('responde 200 para que nadie reintente en bucle', () => {
    expect(run.resultado.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
describe('sesión sin calificaciones del agente', () => {
  test('sin data_collection_results no hay reporte, aunque la sesión sea larga', async () => {
    const run = await correr(conversacion({
      duracion: 600,
      dataCollection: {},
      transcript: transcriptLargo(),
      turns: turnos(40)
    }));

    expect(run.resultado.skipped).toBe(true);
    expect(run.resultado.motivo).toBe('SIN_DATOS_DE_ANALISIS');
    expect(run.correos).toBe(0);
    expect(run.pdfs).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
describe('sesión sin conversación medible', () => {
  test('una transcripción de dos frases no genera reporte', async () => {
    const run = await correr(conversacion({
      duracion: 600,
      dataCollection: { score_overall: { value: 8 } },
      transcript: 'Victor: Hola\nChristian Soria: Adiós',
      turns: turnos(2)
    }));

    expect(run.resultado.skipped).toBe(true);
    expect(run.resultado.motivo).toBe('TRANSCRIPCION_INSUFICIENTE');
    expect(run.correos).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
describe('sesión de 2 minutos con evaluación real', () => {
  let run;

  beforeAll(async () => {
    run = await correr(conversacion({
      duracion: 120,
      dataCollection: {
        score_overall: { value: 8 },
        score_rapport: { value: 7 },
        score_pnl: { value: 8 },
        modulo: { value: 'Meet & Greet' }
      },
      transcript: transcriptLargo(),
      turns: turnos(120)
    }));
  });

  test('el pipeline llega hasta el final', () => {
    expect(run.resultado.skipped).toBeUndefined();
    expect(run.resultado.success).toBe(true);
  });

  test('se genera el PDF y sale el correo', () => {
    expect(run.pdfs).toBe(1);
    expect(run.correos).toBe(1);
  });

  test('la identidad del formulario manda sobre lo que dedujo el agente', () => {
    expect(run.resultado.data.nombre).toBe('Christian Soria');
    expect(run.resultado.data.empleado_id).toBe('123456');
  });

  /**
   * El requisito es explícito: con más de 100 turnos la transcripción NO se
   * recorta, ni en el correo ni en el PDF.
   */
  test('los 120 turnos viajan enteros en el correo', () => {
    expect(run.resultado.data.turnos).toBe(120);
    expect(run.correo.htmlBody).toContain('Intervención de prueba número 0 ');
    expect(run.correo.htmlBody).toContain('Intervención de prueba número 119 ');
    expect(run.correo.htmlBody).not.toContain('Se muestran las primeras');
  });

  test('el correo lleva los cuatro CTAs, incluida la descarga del MP3', () => {
    for (const destino of ['/player?conv=', '/api/pdf/', '/api/audio/', '/retrain?conv=']) {
      expect(run.correo.htmlBody).toContain(destino);
      expect(run.correo.textBody).toContain(destino);
    }
    expect(run.correo.htmlBody).toContain('Descargar la grabación');
  });
});