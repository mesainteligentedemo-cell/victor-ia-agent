/**
 * REGLA BLOQUEADA — El sistema NO inventa datos.
 *
 * Origen: un reporte emitido sobre una llamada real de catorce segundos que
 * declaraba nueve minutos y medio de duración, 8/10 de desempeño, cinco
 * observaciones de conducta y un plan de certificación. Ninguno de esos datos
 * existió: todos eran valores por defecto del código.
 *
 * Estas pruebas fijan la regla para que no vuelva a ocurrir:
 *
 *   Si el dato no llegó → el campo va vacío o dice "No disponible".
 *   NUNCA un valor de fábrica que se lea como un hallazgo real.
 *
 * Única excepción: fecha y hora, que siempre viajan en el webhook y, en su
 * defecto, se toman del instante de proceso — que también es un dato real.
 */

const { mapElevenLabsData, resolveDuracionSegundos } = require('../../src/server/n8n-mapper');
const {
  generateChartsData,
  buildSpeechSplit,
  buildEngagementCurve,
  buildTimelineSeries,
  resolveCc
} = require('../../src/server/api-process-call');
const {
  buildEmailText,
  buildEmailHTML,
  normalizeAddressList,
  datosFaltantes,
  scorePctTexto
} = require('../../src/server/email-sender');

// ════════════════════════════════════════════════════════════
// DURACIÓN — el fallo que originó la auditoría
// ════════════════════════════════════════════════════════════

describe('Duración: medida, nunca estimada', () => {
  test('lee call_duration_secs desde metadata (donde ElevenLabs lo pone)', () => {
    // Éste es EL bug: el mapeador solo miraba la raíz del payload, y como
    // ElevenLabs entrega el contador dentro de `metadata`, toda sesión caía al
    // respaldo de 570 s. Una llamada de 14 segundos se reportaba como 9:30.
    const out = mapElevenLabsData({
      conversation_id: 'c1',
      metadata: { call_duration_secs: 14 }
    });

    expect(out.duracion_sec).toBe(14);
    expect(out.duracion_texto).toBe('0:14');
    expect(out.duracion_humana).toBe('14 segundos');
  });

  test('NUNCA devuelve los 570 segundos de respaldo', () => {
    const out = mapElevenLabsData({ conversation_id: 'c1' });
    expect(out.duracion_sec).not.toBe(570);
    expect(out.duracion_sec).toBeNull();
    expect(out.duracion_texto).toBeNull();
    expect(out.duracion_humana).toBeNull();
  });

  test('acepta el contador en la raíz del payload (integraciones N8N)', () => {
    expect(resolveDuracionSegundos({ duracion_segundos: 725 })).toBe(725);
    expect(resolveDuracionSegundos({ call_duration_secs: 42 })).toBe(42);
  });

  test('mide desde el último turno cuando no hay contador', () => {
    // No es una estimación: es el segundo en que se registró la última
    // intervención de la llamada.
    const secs = resolveDuracionSegundos({
      transcript_turns: [
        { time_in_call_secs: 0 },
        { time_in_call_secs: 7 },
        { time_in_call_secs: 13 }
      ]
    });
    expect(secs).toBe(13);
  });

  test('sin ninguna fuente medible devuelve null', () => {
    expect(resolveDuracionSegundos({})).toBeNull();
    expect(resolveDuracionSegundos({ metadata: {} })).toBeNull();
    expect(resolveDuracionSegundos({ duracion_segundos: 0 })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// CAMPOS DE IDENTIDAD Y CONTEXTO
// ════════════════════════════════════════════════════════════

describe('Identidad y contexto: sin rellenos de fábrica', () => {
  const vacio = mapElevenLabsData({ conversation_id: 'c1' });

  test('no inventa el número de empleado VTC-001', () => {
    expect(vacio.empleado_id).toBeNull();
  });

  test('no asigna a todos al departamento "Dirección"', () => {
    expect(vacio.departamento).toBeNull();
    expect(vacio.puesto).toBeNull();
  });

  test('no supone el módulo "Meet & Greet" ni la familia "López"', () => {
    expect(vacio.modulo).toBeNull();
    expect(vacio.familia_nombre).toBeNull();
  });

  test('no supone el idioma de la sesión', () => {
    expect(vacio.idioma).toBeNull();
  });

  test('no inventa un colaborador llamado "Asesor VTC"', () => {
    expect(vacio.nombre).toBeNull();
    expect(vacio.nombre_completo).toBeNull();
  });

  test('declara TODO lo que faltó en campos_sin_dato', () => {
    expect(vacio.campos_sin_dato).toEqual(
      expect.arrayContaining([
        'Nombre del colaborador',
        'Número de empleado',
        'Módulo',
        'Duración',
        'Desempeño general'
      ])
    );
  });

  test('el roster sigue completando el apellido cuando hay número de empleado', () => {
    // Lo que SÍ es legítimo: resolver "Christian" → "Christian Soria" contra
    // nómina. No se inventa nada; se completa un dato verificado.
    const out = mapElevenLabsData({ conversation_id: 'c1', nombre: 'Christian', empleado_id: '123456' });
    expect(out.nombre_completo).toBe('Christian Soria');
  });
});

// ════════════════════════════════════════════════════════════
// NARRATIVA — lo más grave: afirmaciones sobre la conducta
// ════════════════════════════════════════════════════════════

describe('Narrativa: ninguna afirmación sin análisis que la respalde', () => {
  const vacio = mapElevenLabsData({ conversation_id: 'c1' });

  test('no narra los 5 "principios" de una sesión imaginaria', () => {
    expect(vacio.principios_neuro).toEqual([]);
  });

  test('no afirma que el cliente no planteó inquietudes', () => {
    expect(vacio.objeciones_trabajadas).toBeNull();
    expect(vacio.analisis_pnl).toBeNull();
  });

  test('no genera fortalezas ni áreas de mejora genéricas', () => {
    expect(vacio.fortalezas).toBeNull();
    expect(vacio.areas_mejora).toBeNull();
  });

  test('no describe "las cuatro etapas de la conversación"', () => {
    expect(vacio.actividad_sesion).toBeNull();
  });

  test('el resumen de respaldo solo enuncia lo que consta', () => {
    const out = mapElevenLabsData({
      conversation_id: 'c1',
      nombre: 'Ana Torres',
      empleado_id: '123456',
      metadata: { call_duration_secs: 14 }
    });

    // Menciona lo que sí llegó...
    expect(out.resumen).toContain('Ana Torres');
    expect(out.resumen).toContain('14 segundos');
    // ...y NO menciona lo que no.
    expect(out.resumen).not.toMatch(/módulo undefined|módulo null|Meet & Greet/);
    expect(out.resumen).not.toMatch(/Desempeño general/);
  });

  test('no recomienda certificar a quien nadie evaluó', () => {
    expect(vacio.recomendacion_coach).toBeNull();
    expect(vacio.plan_1).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// GRÁFICOS — un trazo dibujado es una afirmación
// ════════════════════════════════════════════════════════════

describe('Gráficos: sin datos reales no se dibuja nada', () => {
  test('el reparto del habla no se inventa como 55/40/5', () => {
    const split = buildSpeechSplit('', []);
    expect(split.victor).toBeNull();
    expect(split.usuario).toBeNull();
  });

  test('la curva de engagement no devuelve una línea plana en 5/10', () => {
    expect(buildEngagementCurve('', 600)).toEqual([]);
    expect(buildEngagementCurve('una sola línea', null)).toEqual([]);
  });

  test('las fases sin calificar no se pintan como ceros', () => {
    // Un cero pintado se lee como "lo hizo pésimo", que es lo contrario de
    // "no se midió".
    const serie = buildTimelineSeries({}, { score_rapport: 8 });
    expect(serie.points).toEqual([]);
    expect(serie.labels).toEqual([]);
  });

  test('con todas las fases puntuadas sí se dibuja la línea', () => {
    const mapped = mapElevenLabsData({
      conversation_id: 'c1',
      score_rapport: 7, score_lectura_sala: 8, score_pnl: 6,
      score_objecciones: 5, score_cierre: 9, score_overall: 7
    });
    const charts = generateChartsData(mapped, 'agent: hola\nuser: qué tal', []);
    expect(charts.timeline.points).toEqual([7, 8, 6, 5, 9]);
  });
});

// ════════════════════════════════════════════════════════════
// CORREO — CC y declaración de huecos
// ════════════════════════════════════════════════════════════

describe('CC del reporte: REPORT_CC llega de verdad al correo', () => {
  const envOriginal = { ...process.env };
  afterEach(() => { process.env = { ...envOriginal }; });

  test('lee REPORT_CC y devuelve la lista', () => {
    process.env.REPORT_CC = 'chrisoria16@gmail.com, eldudemateos@gmail.com';
    expect(resolveCc(['mesainteligentedemo@gmail.com']))
      .toEqual(['chrisoria16@gmail.com', 'eldudemateos@gmail.com']);
  });

  test('no duplica a quien ya está en el "para"', () => {
    process.env.REPORT_CC = 'jefe@vtc.com, mesainteligentedemo@gmail.com';
    expect(resolveCc(['mesainteligentedemo@gmail.com'])).toEqual(['jefe@vtc.com']);
  });

  test('descarta direcciones con forma inválida', () => {
    process.env.REPORT_CC = 'no-es-un-correo, ok@vtc.com';
    expect(resolveCc([])).toEqual(['ok@vtc.com']);
  });

  test('sin REPORT_CC devuelve lista vacía (no rompe el envío)', () => {
    delete process.env.REPORT_CC;
    delete process.env.EMAIL_CC;
    expect(resolveCc(['a@b.com'])).toEqual([]);
  });

  test('normalizeAddressList acepta string, array y separadores mixtos', () => {
    expect(normalizeAddressList('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
    expect(normalizeAddressList(['a@x.com; b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
    expect(normalizeAddressList('')).toEqual([]);
    expect(normalizeAddressList(null)).toEqual([]);
    // Duplicados fuera: Resend enviaría el mismo correo dos veces
    expect(normalizeAddressList('a@x.com, A@X.COM')).toEqual(['a@x.com']);
  });
});

describe('Correo: declara los huecos en vez de rellenarlos', () => {
  const sesionVacia = mapElevenLabsData({ conversation_id: 'c1' });

  test('el desempeño sin evaluar NO se muestra como 0%', () => {
    // 0% acusa a la persona de haberlo hecho mal; la verdad es que no hay nota.
    expect(scorePctTexto(sesionVacia)).toBe('Pendiente de evaluación');
    expect(scorePctTexto({ scoreTotal: 80 })).toBe('80%');
    expect(scorePctTexto({ score_overall: 0, scoreTotal: 0 })).toBe('0%');
  });

  test('datosFaltantes enumera lo que no llegó', () => {
    expect(datosFaltantes(sesionVacia)).toEqual(expect.arrayContaining(['Duración']));
    expect(datosFaltantes({ campos_sin_dato: [] })).toEqual([]);
  });

  test('el cuerpo de texto avisa y no promete datos que no existen', () => {
    const texto = buildEmailText(sesionVacia, '2026-08-01T17:00:00Z', { hasAudio: false });
    expect(texto).toContain('DATOS NO REGISTRADOS EN ESTA SESIÓN');
    expect(texto).toContain('No se han sustituido por valores estimados');
    expect(texto).toContain('Pendiente de evaluación');
    // Los rellenos viejos no pueden aparecer por ningún lado
    expect(texto).not.toContain('9 minutos 30 segundos');
    expect(texto).not.toContain('Meet & Greet');
    expect(texto).not.toContain('VTC-001');
  });

  test('el HTML incluye el mismo aviso que el texto plano', () => {
    const html = buildEmailHTML(sesionVacia, '2026-08-01T17:00:00Z', { hasAudio: false });
    expect(html).toContain('Datos no registrados en esta sesión');
    expect(html).toContain('Pendiente de evaluación');
    expect(html).not.toContain('VTC-001');
  });

  test('una sesión completa NO muestra el aviso', () => {
    const completa = mapElevenLabsData({
      conversation_id: 'c1',
      nombre: 'Ana Torres', empleado_id: '123456', departamento: 'Ventas',
      modulo: 'Manejo de Objeciones', idioma: 'Español', familia_nombre: 'Ramírez',
      metadata: { call_duration_secs: 725 },
      score_overall: 8
    });
    const texto = buildEmailText(completa, '2026-08-01T17:00:00Z', { hasAudio: true });
    expect(texto).not.toContain('DATOS NO REGISTRADOS');
    expect(texto).toContain('12 minutos 5 segundos');
    expect(texto).toContain('80%');
  });
});