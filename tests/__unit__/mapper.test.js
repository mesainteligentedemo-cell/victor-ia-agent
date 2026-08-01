/**
 * TESTS — Mapeo de datos de ElevenLabs (FIX 3 y FIX 8)
 *
 * El bug que se protege aquí: el helper `safe()` usaba `|| def`, así que un
 * score de 0 se convertía en el default (8). Un asesor que reprobó salía en el
 * reporte con notable — y el gerente lo mandaba a piso de ventas.
 */

const { mapElevenLabsData, splitItems, resolveSessionDate } = require('../../src/server/n8n-mapper');
const { validateReportData, extractDataCollection } = require('../../src/server/api-process-call');

const SCORES = [
  'score_rapport', 'score_pnl', 'score_postura',
  'score_objecciones', 'score_lectura_sala', 'score_cierre', 'score_overall'
];

describe('mapElevenLabsData — los ceros son datos, no huecos', () => {
  test('score_overall = 0 se reporta como 0 (antes salía 8)', () => {
    const out = mapElevenLabsData({ conversation_id: 'c1', score_overall: 0 });
    expect(out.score_overall).toBe(0);
    expect(out.scoreTotal).toBe(0);
  });

  test('los 7 scores en 0 se conservan todos', () => {
    const input = { conversation_id: 'c1' };
    for (const s of SCORES) input[s] = 0;

    const out = mapElevenLabsData(input);
    for (const s of SCORES) expect(out[s]).toBe(0);
  });

  test('score 0 en string ("0") también se conserva', () => {
    const out = mapElevenLabsData({ conversation_id: 'c1', score_overall: '0' });
    expect(out.score_overall).toBe(0);
  });

  test('score ausente sí toma el default', () => {
    const out = mapElevenLabsData({ conversation_id: 'c1' });
    expect(out.score_overall).toBe(8);
  });

  test('score null o cadena vacía toman el default', () => {
    expect(mapElevenLabsData({ score_overall: null }).score_overall).toBe(8);
    expect(mapElevenLabsData({ score_overall: '' }).score_overall).toBe(8);
  });

  test('scores fuera de rango se clampan a [0,10]', () => {
    expect(mapElevenLabsData({ score_overall: 42 }).score_overall).toBe(10);
    expect(mapElevenLabsData({ score_overall: -7 }).score_overall).toBe(0);
  });

  test('score no numérico cae al default en vez de propagar NaN', () => {
    const out = mapElevenLabsData({ score_overall: 'excelente' });
    expect(Number.isFinite(out.score_overall)).toBe(true);
    expect(out.score_overall).toBe(8);
  });

  test('score decimal se conserva sin redondear', () => {
    expect(mapElevenLabsData({ score_overall: 7.5 }).score_overall).toBe(7.5);
  });
});

describe('mapElevenLabsData — los 25 campos del agente', () => {
  const payload = {
    conversation_id: 'conv_test_25',
    nombre_asesor: 'Ana Torres',
    empleado_id: 'VTC-042',
    puesto: 'Liner',
    idioma: 'Inglés',
    modulo: 'Manejo de Objeciones',
    familia_nombre: 'Ramírez',
    duracion_segundos: 725,
    score_rapport: 6,
    score_pnl: 5,
    score_postura: 7,
    score_objecciones: 4,
    score_lectura_sala: 8,
    score_cierre: 5,
    score_overall: 6,
    fortalezas: 'Escucha activa\nBuen tono',
    areas_mejora: 'Cerrar antes\nPreguntar más',
    analisis_pnl: 'Anclajes correctos',
    objeciones_trabajadas: 'Precio, Tiempo',
    resumen: 'Sesión de práctica intensiva',
    recomendacion_coach: 'Reforzar objeciones',
    actividad_sesion: 'Simulación completa',
    cumplimiento_neuro: 7,
    principios_neuro: ['Anclaje: se activó', 'Reencuadre: correcto'],
    transcript: 'agent: Hola\nuser: Buenas tardes'
  };

  test('mapea identidad, módulo e idioma sin inventar nada', () => {
    const out = mapElevenLabsData(payload);
    expect(out.nombre).toBe('Ana Torres');
    expect(out.empleado_id).toBe('VTC-042');
    expect(out.puesto).toBe('Liner');
    expect(out.idioma).toBe('Inglés');
    expect(out.modulo).toBe('Manejo de Objeciones');
    expect(out.familia_nombre).toBe('Ramírez');
  });

  test('convierte la duración a texto mm:ss', () => {
    const out = mapElevenLabsData(payload);
    expect(out.duracion_sec).toBe(725);
    expect(out.duracion_minutos).toBe(12);
    expect(out.duracion_texto).toBe('12:05');
  });

  test('construye las 6 competencias con los scores recibidos', () => {
    const out = mapElevenLabsData(payload);
    expect(out.competencias).toHaveLength(6);
    expect(out.comp_baja).toBe('Objeciones'); // el 4, el más bajo
    expect(out.comp_alta).toBe('Lectura Sala'); // el 8, el más alto
  });

  test('respeta los textos del agente en vez de los defaults', () => {
    const out = mapElevenLabsData(payload);
    expect(out.resumen).toBe('Sesión de práctica intensiva');
    expect(out.recomendacion_coach).toBe('Reforzar objeciones');
    expect(out.fortalezas_list).toEqual(['Escucha activa', 'Buen tono']);
    expect(out.areas_list).toEqual(['Cerrar antes', 'Preguntar más']);
    expect(out.objeciones_list).toEqual(['Precio', 'Tiempo']);
  });

  test('normaliza cumplimiento_neuro de escala 0-10 a porcentaje', () => {
    expect(mapElevenLabsData({ cumplimiento_neuro: 7 }).cumplimiento_neuro).toBe(70);
    expect(mapElevenLabsData({ cumplimiento_neuro: 85 }).cumplimiento_neuro).toBe(85);
  });

  test('convierte el transcript en burbujas con lado y tipo', () => {
    const out = mapElevenLabsData(payload);
    expect(out.transcription.length).toBe(2);
    expect(out.transcription[0].type).toBe('agent');
    expect(out.transcription[1].type).toBe('user');
  });

  test('genera los 3 CTAs apuntando a rutas que existen', () => {
    const out = mapElevenLabsData(payload);
    expect(out.pdf_download_url).toContain('/api/pdf/conv_test_25');
    expect(out.pop_up_url).toContain('/player?conv=conv_test_25');
    expect(out.retrain_url).toContain('/retrain?conv=conv_test_25');
  });

  test('los defaults narrativos no inventan hallazgos', () => {
    const out = mapElevenLabsData({ conversation_id: 'c1' });
    expect(out.fortalezas).toBe('Continuar desarrollando fortalezas identificadas');
    expect(out.areas_mejora).toBe('Mantener enfoque en competencias clave');
    // El texto viejo afirmaba observaciones que nadie hizo
    expect(out.fortalezas).not.toMatch(/calibración visual/i);
    expect(out.analisis_pnl).not.toMatch(/anclajes emocionales/i);
  });
});

describe('mapElevenLabsData — payloads anidados', () => {
  test('lee el payload envuelto en `body` (formato N8N)', () => {
    const out = mapElevenLabsData({ body: { conversation_id: 'anidado', nombre_asesor: 'Luis' } });
    expect(out.conversationId).toBe('anidado');
    expect(out.nombre).toBe('Luis');
  });

  test('resolveSessionDate acepta unix en segundos', () => {
    const d = resolveSessionDate({ metadata: { start_time_unix_secs: 1785571737 } });
    expect(d.getFullYear()).toBeGreaterThan(2020);
  });

  test('resolveSessionDate cae a "ahora" con datos basura', () => {
    const d = resolveSessionDate({ start_time: 'no-es-fecha' });
    expect(d instanceof Date).toBe(true);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  test('no revienta con un payload vacío', () => {
    expect(() => mapElevenLabsData({})).not.toThrow();
    const out = mapElevenLabsData({});
    expect(out.conversationId).toMatch(/^CONV-/);
  });
});

describe('extractDataCollection — campos del agente ElevenLabs', () => {
  test('aplana { value, rationale } a valor plano', () => {
    const out = extractDataCollection({
      analysis: {
        data_collection_results: {
          nombre_asesor: { value: 'Ana', rationale: 'lo dijo al inicio' },
          score_overall: { value: '6', rationale: 'promedio' }
        }
      }
    });
    expect(out.nombre_asesor).toBe('Ana');
    expect(out.score_overall).toBe(6); // string -> número
  });

  test('conserva el score 0 del agente', () => {
    const out = extractDataCollection({
      analysis: { data_collection_results: { score_cierre: { value: 0 } } }
    });
    expect(out.score_cierre).toBe(0);
  });

  test('descarta null, undefined y cadena vacía', () => {
    const out = extractDataCollection({
      analysis: {
        data_collection_results: { a: { value: null }, b: { value: '' }, c: { value: 'ok' } }
      }
    });
    expect(out).toEqual({ c: 'ok' });
  });

  test('devuelve {} si no hay analysis', () => {
    expect(extractDataCollection({})).toEqual({});
    expect(extractDataCollection(null)).toEqual({});
  });
});

describe('validateReportData — cero no es "falta el dato"', () => {
  const base = {
    nombre: 'Ana', empleado_id: 'VTC-1', modulo: 'M1',
    fecha_sesion: '01/08/2026', duracion_texto: '10:00',
    score_overall: 8, scoreTotal: 80,
    competencias: [{ name: 'A', score: 8 }, { name: 'B', score: 7 }, { name: 'C', score: 6 }],
    transcription: [{ speaker: 'x', text: 'y' }],
    charts: { competencias: {} },
    resumen: 'r', fortalezas: 'f', areas_mejora: 'a', recomendacion_coach: 'c'
  };

  test('acepta score_overall = 0 y scoreTotal = 0', () => {
    const r = validateReportData({ ...base, score_overall: 0, scoreTotal: 0 });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test('rechaza cuando un campo crítico es null', () => {
    const r = validateReportData({ ...base, nombre: null });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('nombre');
  });

  test('rechaza cuando un campo crítico es cadena vacía', () => {
    expect(validateReportData({ ...base, modulo: '' }).ok).toBe(false);
  });

  test('rechaza un score no numérico', () => {
    const r = validateReportData({ ...base, score_overall: 'ocho' });
    expect(r.ok).toBe(false);
    expect(r.missing.join(' ')).toMatch(/score_overall/);
  });

  test('avisa (sin bloquear) cuando faltan competencias o transcripción', () => {
    const r = validateReportData({ ...base, competencias: [], transcription: [] });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test('no lanza con datos nulos', () => {
    expect(() => validateReportData(null)).not.toThrow();
    expect(validateReportData(null).ok).toBe(false);
  });
});

describe('splitItems — limpieza de listas', () => {
  test('parte por saltos de línea y quita viñetas', () => {
    expect(splitItems('✓ Uno\n• Dos\n- Tres')).toEqual(['Uno', 'Dos', 'Tres']);
  });

  test('parte por comas sin romper paréntesis', () => {
    expect(splitItems('Precio (valor, tiempo), Garantía', true))
      .toEqual(['Precio (valor, tiempo)', 'Garantía']);
  });

  test('devuelve [] con entrada vacía', () => {
    expect(splitItems('')).toEqual([]);
    expect(splitItems(null)).toEqual([]);
  });
});