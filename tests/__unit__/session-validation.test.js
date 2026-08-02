/**
 * SESSION VALIDATION — la puerta que impide emitir un reporte sin sesión.
 *
 * Lo que se protege aquí no es un formato: es que un documento de Recursos
 * Humanos con el nombre de una persona no se emita cuando el sistema no midió
 * nada. Ver src/server/session-validation.js.
 */

const {
  validateSessionForReport,
  countTranscriptWords,
  hasDataCollection,
  MOTIVOS,
  MIN_DURACION_SEC,
  MIN_TRANSCRIPT_WORDS
} = require('../../src/server/session-validation');

/** Transcript con holgura por encima del mínimo de palabras. */
const TRANSCRIPT_LARGO = Array.from({ length: 30 }, (_, i) =>
  `Victor: Buenas tardes, cuénteme qué los trae por aquí el día de hoy número ${i}`
).join('\n');

/** Lo que devuelve el agente cuando SÍ evaluó la sesión. */
const DATOS_AGENTE = { score_overall: 8, score_rapport: 7, modulo: 'Meet & Greet' };

describe('duración mínima', () => {
  test('14 segundos NO generan reporte: es el caso que motivó esta puerta', () => {
    const r = validateSessionForReport({
      duracionSec: 14,
      dataCollection: DATOS_AGENTE,
      transcript: TRANSCRIPT_LARGO
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.SESION_MUY_CORTA);
    expect(r.error).toBe('Sesión muy corta');
    expect(r.message).toMatch(/14 s/);
    expect(r.message).toMatch(/al menos 30 segundos/);
    expect(r.detalle).toEqual({ duracion_sec: 14, minimo_sec: 30 });
  });

  test('justo por debajo del umbral se rechaza; justo en el umbral pasa', () => {
    const corta = validateSessionForReport({
      duracionSec: MIN_DURACION_SEC - 1,
      dataCollection: DATOS_AGENTE,
      transcript: TRANSCRIPT_LARGO
    });
    expect(corta.ok).toBe(false);
    expect(corta.motivo).toBe(MOTIVOS.SESION_MUY_CORTA);

    const justa = validateSessionForReport({
      duracionSec: MIN_DURACION_SEC,
      dataCollection: DATOS_AGENTE,
      transcript: TRANSCRIPT_LARGO
    });
    expect(justa.ok).toBe(true);
  });

  test('una sesión de 2 minutos con datos del agente pasa entera', () => {
    const r = validateSessionForReport({
      duracionSec: 120,
      dataCollection: DATOS_AGENTE,
      transcript: TRANSCRIPT_LARGO
    });
    expect(r).toEqual({ ok: true });
  });

  /**
   * `null` es "no se midió", que NO es lo mismo que "duró poco". El reporte
   * sabe declarar una duración ausente; bloquear por ella dejaría sin registro
   * a sesiones reales cuyo contador no llegó.
   */
  test('duración ausente no bloquea: el reporte la declara como no disponible', () => {
    const r = validateSessionForReport({
      duracionSec: null,
      dataCollection: DATOS_AGENTE,
      transcript: TRANSCRIPT_LARGO
    });
    expect(r.ok).toBe(true);
  });

  test('una duración corrupta no se interpreta como sesión corta', () => {
    for (const basura of [undefined, '', NaN, 'nueve minutos']) {
      const r = validateSessionForReport({
        duracionSec: basura,
        dataCollection: DATOS_AGENTE,
        transcript: TRANSCRIPT_LARGO
      });
      expect(r.ok).toBe(true);
    }
  });
});

describe('datos de análisis del agente', () => {
  test('sin data_collection_results NO hay competencias, scores ni plan', () => {
    for (const vacio of [null, undefined, {}]) {
      const r = validateSessionForReport({
        duracionSec: 300,
        dataCollection: vacio,
        transcript: TRANSCRIPT_LARGO
      });

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe(MOTIVOS.SIN_DATOS_DE_ANALISIS);
      expect(r.error).toBe('Sin datos de análisis');
      expect(r.message).toMatch(/no envió calificaciones/i);
    }
  });

  test('hasDataCollection distingue objeto con datos de objeto vacío', () => {
    expect(hasDataCollection({ score_overall: 0 })).toBe(true);
    expect(hasDataCollection({})).toBe(false);
    expect(hasDataCollection(null)).toBe(false);
    expect(hasDataCollection('texto')).toBe(false);
  });

  /** Un score de 0 es un dato válido — y el más importante de reportar. */
  test('un score de 0 cuenta como dato: no se confunde con ausencia', () => {
    const r = validateSessionForReport({
      duracionSec: 300,
      dataCollection: { score_overall: 0 },
      transcript: TRANSCRIPT_LARGO
    });
    expect(r.ok).toBe(true);
  });
});

describe('transcripción mínima', () => {
  test('una conversación de tres palabras no da para analizar nada', () => {
    const r = validateSessionForReport({
      duracionSec: 300,
      dataCollection: DATOS_AGENTE,
      transcript: 'Victor: Hola\nChristian Soria: Adiós'
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.TRANSCRIPCION_INSUFICIENTE);
    expect(r.detalle.minimo_palabras).toBe(MIN_TRANSCRIPT_WORDS);
  });

  test('las etiquetas de hablante no cuentan como palabras habladas', () => {
    // 30 turnos vacíos: sin descontar las etiquetas, "Victor:" y el nombre del
    // asesor sumarían de sobra para colar una sesión muda.
    const mudo = Array.from({ length: 30 }, () => 'Victor:\nChristian Soria:').join('\n');
    expect(countTranscriptWords(mudo)).toBe(0);

    const r = validateSessionForReport({
      duracionSec: 300,
      dataCollection: DATOS_AGENTE,
      transcript: mudo
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.TRANSCRIPCION_INSUFICIENTE);
  });

  test('las acotaciones de voz y las etiquetas de sistema tampoco cuentan', () => {
    expect(countTranscriptWords('Victor: [calmado] <break time="1s"/> {{user_name}}')).toBe(0);
  });

  test('sin transcripción se rechaza en vez de emitir un reporte vacío', () => {
    for (const vacio of [null, undefined, '']) {
      const r = validateSessionForReport({
        duracionSec: 300,
        dataCollection: DATOS_AGENTE,
        transcript: vacio
      });
      expect(r.ok).toBe(false);
      expect(r.motivo).toBe(MOTIVOS.TRANSCRIPCION_INSUFICIENTE);
    }
  });
});

describe('orden de las puertas', () => {
  /**
   * La duración manda: si la llamada duró catorce segundos, da igual lo que
   * haya mandado el agente. Importa para que el mensaje que llega a N8N sea el
   * accionable ("haz una sesión más larga") y no uno secundario.
   */
  test('una sesión corta reporta "muy corta" aunque falte todo lo demás', () => {
    const r = validateSessionForReport({
      duracionSec: 5,
      dataCollection: null,
      transcript: ''
    });
    expect(r.motivo).toBe(MOTIVOS.SESION_MUY_CORTA);
  });
});

describe('contrato del rechazo', () => {
  test('todo rechazo trae motivo, error y mensaje accionable en claro', () => {
    const casos = [
      { duracionSec: 10, dataCollection: DATOS_AGENTE, transcript: TRANSCRIPT_LARGO },
      { duracionSec: 300, dataCollection: {}, transcript: TRANSCRIPT_LARGO },
      { duracionSec: 300, dataCollection: DATOS_AGENTE, transcript: 'Victor: Hola' }
    ];

    for (const caso of casos) {
      const r = validateSessionForReport(caso);
      expect(r.ok).toBe(false);
      expect(Object.values(MOTIVOS)).toContain(r.motivo);
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(20);
      // El mensaje lo lee una persona: nada de códigos ni jerga de sistema
      expect(r.message).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });

  test('una entrada vacía no revienta: se rechaza con motivo', () => {
    const r = validateSessionForReport();
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.SIN_DATOS_DE_ANALISIS);
  });
});