/**
 * TESTS — Correo de solicitud de reentrenamiento
 *
 * Es el correo que dispara una acción de RR. HH.: alguien tiene que AGENDAR el
 * coaching. Se protege que identifique al empleado sin ambigüedad (nombre
 * completo + ID + departamento), que diga de qué sesión habla y que no pierda
 * las notas que escribió quien lo solicitó.
 */

const { buildRetrainEmail } = require('../../src/server/retrain-request');

const SUMMARY = {
  nombre: 'Christian Soria',
  nombre_completo: 'Christian Soria',
  empleado_id: '123456',
  departamento: 'Dirección',
  puesto: 'Closer',
  modulo: 'Meet & Greet',
  fecha_sesion: '01/08/2026',
  hora_cancun: '11:53 a.m.',
  duracion_texto: '9:30',
  duracion_humana: '9 minutos 30 segundos',
  score_overall: 6.5,
  scoreTotal: 65,
  competencias: [
    { name: 'Rapport', score: 8 },
    { name: 'PNL', score: 6 },
    { name: 'Cierre', score: 5 }
  ]
};

const RECORD = {
  id: 'RTR-20260801175300-A1B2C3',
  prioridad: 'ALTA',
  competencias: ['PNL', 'Cierre'],
  notas: 'Practicar cierre asumido 20 min diarios.',
  notas_gerente: 'Agendar con el coach senior esta semana.',
  created_at: '2026-08-01T16:53:00Z',
  persisted: 'supabase'
};

const LINKS = {
  pdf_download_url: 'https://x.test/api/pdf/c1?t=1.aa',
  pop_up_url: 'https://x.test/player?conv=c1&t=1.aa'
};

const build = (over = {}) => buildRetrainEmail({
  summary: { ...SUMMARY, ...(over.summary || {}) },
  record: { ...RECORD, ...(over.record || {}) },
  links: LINKS,
  origenCompetencias: over.origenCompetencias || 'seleccion'
});

describe('asunto del reentrenamiento', () => {
  test('sigue el formato acordado, con emoji, nombre completo, fecha y hora', () => {
    expect(build().subject)
      .toBe('🔄 Solicitud de Reentrenamiento: Christian Soria • 01/08/2026 11:53 a.m.');
  });

  test('cabe en la línea de asunto de cualquier cliente', () => {
    expect(build().subject.length).toBeLessThanOrEqual(78);
  });

  test('un nombre kilométrico no empuja la fecha fuera de la vista', () => {
    const s = build({
      summary: { nombre_completo: 'María Fernanda de la Concepción Villaseñor Etcheverría' }
    }).subject;
    expect(s.length).toBeLessThanOrEqual(78);
    expect(s).toContain('01/08/2026');
    expect(s).toContain('11:53 a.m.');
  });
});

describe('cuerpo del reentrenamiento', () => {
  const { text, html } = build();

  test('la estructura va en el orden acordado', () => {
    const orden = [
      'Solicitud de Reentrenamiento Registrada',
      '✅ Hemos registrado tu solicitud de reentrenamiento.',
      '👤 EMPLEADO:',
      '📅 DETALLES:',
      '📝 NOTAS DEL GERENTE:',
      '⏳ ESTADO:',
      'Victor IA — Elite Training System'
    ];

    let cursor = -1;
    for (const bloque of orden) {
      const pos = text.indexOf(bloque);
      expect(pos).toBeGreaterThan(cursor);
      cursor = pos;
    }
  });

  test('identifica al empleado con nombre completo, ID y departamento', () => {
    expect(text).toContain('Christian Soria (123456)');
    expect(text).toContain('Departamento: Dirección');
  });

  test('los detalles apuntan a la sesión original, no al momento de la solicitud', () => {
    expect(text).toContain('• Fecha de Sesión Original: 01/08/2026');
    expect(text).toContain('• Hora: 11:53 a.m. (America/Cancun)');
  });

  test('las competencias viajan con su score', () => {
    expect(text).toContain('• Competencias a Mejorar: PNL (6/10), Cierre (5/10)');
  });

  test('avisa cuando las competencias se dedujeron solas', () => {
    expect(build({ origenCompetencias: 'automatico' }).text)
      .toContain('(deducidas de los scores de la sesión)');
  });

  test('no pierde ninguna de las dos notas del formulario', () => {
    expect(text).toContain('Agendar con el coach senior esta semana.');
    expect(text).toContain('Practicar cierre asumido 20 min diarios.');
  });

  test('sin notas lo dice, en vez de dejar el bloque vacío', () => {
    const vacio = build({ record: { notas: '', notas_gerente: '' } });
    expect(vacio.text).toContain('(sin notas)');
    expect(vacio.html).toContain('(sin notas)');
  });

  test('no repite la misma nota dos veces', () => {
    const igual = build({ record: { notas: 'Reforzar cierre.', notas_gerente: 'Reforzar cierre.' } });
    expect(igual.text.match(/Reforzar cierre\./g)).toHaveLength(1);
  });

  test('el HTML dice lo mismo que el texto plano', () => {
    for (const dato of ['Christian Soria', '123456', 'Dirección', '01/08/2026', '11:53 a.m.']) {
      expect(html).toContain(dato);
    }
    expect(html).toContain('Hemos registrado tu solicitud de reentrenamiento');
    expect(html).toContain('será programada dentro de los próximos días');
  });

  test('conserva el folio y los enlaces al reporte y al audio', () => {
    expect(text).toContain('RTR-20260801175300-A1B2C3');
    expect(text).toContain(LINKS.pdf_download_url);
    expect(text).toContain(LINKS.pop_up_url);
    expect(html).toContain('conv=c1&amp;t=1.aa');
    expect(html).not.toContain('&amp;amp;');
  });

  test('escapa el HTML que venga en los datos o en las notas', () => {
    const sucio = build({
      summary: { nombre_completo: '<script>alert(1)</script>' },
      record: { notas_gerente: '<img src=x onerror=alert(1)>' }
    }).html;
    expect(sucio).not.toContain('<script>alert(1)</script>');
    expect(sucio).not.toContain('<img src=x');
    expect(sucio).toContain('&lt;script&gt;');
  });

  test('usa la paleta VTC v4.0', () => {
    for (const color of ['#0D0D0D', '#1A1A1A', '#262626', '#E5B33E', '#B8B8B8']) {
      expect(html).toContain(color);
    }
  });

  test('sin datos de sesión no revienta ni deja huecos crudos', () => {
    const pobre = buildRetrainEmail({
      summary: {},
      record: { ...RECORD, competencias: [] },
      links: LINKS,
      origenCompetencias: 'ninguno'
    });
    expect(pobre.text).toContain('Asesor VTC');
    expect(pobre.text).toContain('Sin foco definido');
    expect(pobre.text).not.toContain('undefined');
    expect(pobre.html).not.toContain('undefined');
  });
});