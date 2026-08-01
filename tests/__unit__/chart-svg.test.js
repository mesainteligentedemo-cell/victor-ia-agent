/**
 * TESTS — Gráficos SVG (FIX 9)
 *
 * Lo que se protege: que ningún gráfico imprima `undefined`, `NaN` o `Infinity`
 * — ni en el dibujo ni en la descripción accesible que leen los lectores de
 * pantalla — y que una etiqueta larga no desborde el viewBox.
 */

const {
  buildReportCharts,
  radarChart,
  barChart,
  lineChart,
  areaChart,
  donutChart,
  gapChart,
  clamp,
  safeScore,
  truncateLabel,
  labelFontSize,
  esc
} = require('../../src/server/chart-svg');

/** Todo SVG del reporte debe cumplir esto, pase lo que pase con los datos. */
function expectSvgLimpio(svg) {
  expect(typeof svg).toBe('string');
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/undefined/);
  expect(svg).not.toMatch(/\bNaN\b/);
  expect(svg).not.toMatch(/Infinity/);
  expect(svg).not.toMatch(/null/);
}

const COMPETENCIAS_OK = [
  { name: 'Rapport', score: 8 },
  { name: 'PNL', score: 7 },
  { name: 'Postura', score: 9 },
  { name: 'Objeciones', score: 4 },
  { name: 'Lectura Sala', score: 6 },
  { name: 'Cierre', score: 5 }
];

describe('clamp y safeScore', () => {
  test('clamp acota al rango', () => {
    expect(clamp(5, 0, 10, 0)).toBe(5);
    expect(clamp(-3, 0, 10, 0)).toBe(0);
    expect(clamp(42, 0, 10, 0)).toBe(10);
  });

  test('clamp devuelve el default con valores no finitos', () => {
    expect(clamp(NaN, 0, 10, 0)).toBe(0);
    expect(clamp(Infinity, 0, 10, 0)).toBe(0);
    expect(clamp(-Infinity, 0, 10, 0)).toBe(0);
    expect(clamp(undefined, 0, 10, 0)).toBe(0);
    expect(clamp(null, 0, 10, 3)).toBe(3);
    expect(clamp('hola', 0, 10, 0)).toBe(0);
  });

  test('safeScore siempre entrega un número en [0,10]', () => {
    for (const v of [undefined, null, NaN, Infinity, -Infinity, 'x', {}, [], -5, 99]) {
      const s = safeScore(v);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(10);
    }
  });

  test('safeScore respeta un 0 legítimo', () => {
    expect(safeScore(0)).toBe(0);
    expect(safeScore('0')).toBe(0);
  });
});

describe('truncateLabel y labelFontSize', () => {
  test('deja intactas las etiquetas cortas', () => {
    expect(truncateLabel('Rapport')).toBe('Rapport');
    expect(truncateLabel('Lectura Sala')).toBe('Lectura Sala');
  });

  test('recorta por encima de 25 caracteres', () => {
    const largo = 'Manejo Avanzado de Objeciones Complejas del Cliente';
    const out = truncateLabel(largo);
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.endsWith('…')).toBe(true);
  });

  test('corta por palabra cuando puede', () => {
    expect(truncateLabel('Manejo de Objeciones Complejas')).toBe('Manejo de Objeciones…');
  });

  test('tolera entradas raras', () => {
    expect(truncateLabel(null)).toBe('');
    expect(truncateLabel(undefined)).toBe('');
    expect(truncateLabel(123)).toBe('123');
  });

  test('baja el cuerpo de letra en etiquetas largas', () => {
    expect(labelFontSize('Rapport')).toBe(13);
    expect(labelFontSize('Lectura de Sala Viva')).toBe(12);
    expect(labelFontSize('Manejo de Objeciones Compl')).toBe(11);
  });
});

describe('esc — escape XML', () => {
  test('neutraliza caracteres que romperían el SVG', () => {
    expect(esc('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });

  test('convierte null/undefined en cadena vacía', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('radarChart', () => {
  test('renderiza con datos válidos', () => {
    expectSvgLimpio(radarChart(COMPETENCIAS_OK));
  });

  test('degrada a placeholder con menos de 3 competencias', () => {
    expect(radarChart([{ name: 'A', score: 5 }])).toMatch(/Sin datos suficientes/);
    expect(radarChart([])).toMatch(/Sin datos suficientes/);
    expect(radarChart(null)).toMatch(/Sin datos suficientes/);
  });

  test('scores NaN/undefined/Infinity no ensucian la descripción', () => {
    const svg = radarChart([
      { name: 'A', score: NaN },
      { name: 'B', score: undefined },
      { name: 'C', score: Infinity },
      { name: 'D', score: -50 }
    ]);
    expectSvgLimpio(svg);
    // Un valor no finito NO es "el máximo": es un dato roto, y se reporta como
    // 0 igual que un dato ausente. Solo los números reales fuera de rango se
    // acercan al tope (D: -50 -> 0, y un 99 daría 10).
    expect(svg).toMatch(/A: 0 de 10/);
    expect(svg).toMatch(/C: 0 de 10/);
    expect(svg).toMatch(/D: 0 de 10/);
  });

  test('etiqueta larga no desborda', () => {
    const svg = radarChart([
      { name: 'Competencia Extremadamente Larga Que No Cabe', score: 8 },
      { name: 'B', score: 7 },
      { name: 'C', score: 6 }
    ]);
    expectSvgLimpio(svg);
    expect(svg).toMatch(/…/);
  });
});

describe('barChart', () => {
  test('renderiza y ordena de mayor a menor', () => {
    const svg = barChart(COMPETENCIAS_OK);
    expectSvgLimpio(svg);
    expect(svg.indexOf('Postura')).toBeLessThan(svg.indexOf('Objeciones'));
  });

  test('placeholder con array vacío', () => {
    expect(barChart([])).toMatch(/Sin datos suficientes/);
    expect(barChart(undefined)).toMatch(/Sin datos suficientes/);
  });

  test('score 0 se dibuja y se narra como 0', () => {
    const svg = barChart([{ name: 'Cierre', score: 0 }]);
    expectSvgLimpio(svg);
    expect(svg).toMatch(/Cierre: 0 de 10/);
  });

  test('descarta entradas sin nombre en vez de pintar undefined', () => {
    const svg = barChart([{ score: 5 }, { name: 'Ok', score: 7 }]);
    expectSvgLimpio(svg);
  });
});

describe('lineChart', () => {
  test('renderiza una timeline normal', () => {
    expectSvgLimpio(lineChart(['A', 'B', 'C'], [5, 7, 9]));
  });

  test('placeholder con menos de 2 puntos', () => {
    expect(lineChart(['A'], [5])).toMatch(/Sin datos suficientes/);
    expect(lineChart([], [])).toMatch(/Sin datos suficientes/);
    expect(lineChart(null, null)).toMatch(/Sin datos suficientes/);
  });

  test('valores basura se clampan sin ensuciar el SVG', () => {
    expectSvgLimpio(lineChart(['A', 'B', 'C'], [NaN, Infinity, 'x']));
  });

  test('etiquetas de fase largas se recortan', () => {
    const svg = lineChart(
      ['Apertura y Descubrimiento Inicial', 'Cierre'],
      [7, 8]
    );
    expectSvgLimpio(svg);
    expect(svg).toMatch(/…/);
  });
});

describe('areaChart', () => {
  test('renderiza una curva de engagement', () => {
    const pts = [{ x: 0, y: 3 }, { x: 1, y: 7 }, { x: 2, y: 5 }];
    expectSvgLimpio(areaChart(pts));
  });

  test('placeholder con menos de 2 puntos', () => {
    expect(areaChart([{ x: 0, y: 5 }])).toMatch(/Sin datos suficientes/);
    expect(areaChart([])).toMatch(/Sin datos suficientes/);
    expect(areaChart(null)).toMatch(/Sin datos suficientes/);
  });

  test('descarta puntos con x no finita', () => {
    const svg = areaChart([
      { x: 0, y: 3 }, { x: NaN, y: 9 }, { x: 2, y: 5 }, { x: Infinity, y: 1 }
    ]);
    expectSvgLimpio(svg);
  });

  test('y basura se clampa a 0', () => {
    expectSvgLimpio(areaChart([{ x: 0, y: NaN }, { x: 1, y: undefined }, { x: 2, y: 'x' }]));
  });
});

describe('donutChart', () => {
  test('renderiza el reparto del habla', () => {
    expectSvgLimpio(donutChart([
      { label: 'Asesor', value: 55 },
      { label: 'IA', value: 40 },
      { label: 'Otros', value: 5 }
    ]));
  });

  test('placeholder si todos los valores son 0 o inválidos', () => {
    expect(donutChart([{ label: 'A', value: 0 }])).toMatch(/Sin datos suficientes/);
    expect(donutChart([{ label: 'A', value: NaN }])).toMatch(/Sin datos suficientes/);
    expect(donutChart([])).toMatch(/Sin datos suficientes/);
    expect(donutChart(null)).toMatch(/Sin datos suficientes/);
  });

  test('un único sector se dibuja como anillo completo', () => {
    expectSvgLimpio(donutChart([{ label: 'Solo', value: 100 }]));
  });

  test('etiqueta larga en la leyenda se recorta', () => {
    const svg = donutChart([
      { label: 'Nombre Larguísimo Del Asesor En Entrenamiento (asesor)', value: 60 },
      { label: 'IA', value: 40 }
    ]);
    expectSvgLimpio(svg);
    expect(svg).toMatch(/…/);
  });
});

describe('gapChart', () => {
  test('renderiza la brecha contra el estándar', () => {
    const svg = gapChart(COMPETENCIAS_OK, 8);
    expectSvgLimpio(svg);
    expect(svg).toMatch(/Objeciones: 4 de 10, 4 puntos debajo/);
    expect(svg).toMatch(/Postura: 9 de 10, cumple el estándar/);
  });

  test('placeholder sin competencias', () => {
    expect(gapChart([])).toMatch(/Sin datos suficientes/);
    expect(gapChart(null)).toMatch(/Sin datos suficientes/);
  });

  test('scores inválidos se narran como 0, no como undefined', () => {
    const svg = gapChart([{ name: 'X', score: undefined }], 8);
    expectSvgLimpio(svg);
    expect(svg).toMatch(/X: 0 de 10/);
  });
});

describe('buildReportCharts — orquestador', () => {
  test('devuelve los 6 gráficos con datos completos', () => {
    const charts = buildReportCharts({
      nombre: 'Ana',
      competencias: COMPETENCIAS_OK,
      charts: {
        timeline: { labels: ['A', 'B', 'C'], points: [7, 8, 6] },
        emotional: { points: [{ x: 0, y: 4 }, { x: 1, y: 8 }] },
        speech: { victor: 55, usuario: 40, otros: 5 }
      }
    });

    const esperados = [
      'chart_radar', 'chart_ranking', 'chart_timeline',
      'chart_engagement', 'chart_habla', 'chart_brecha'
    ];
    for (const k of esperados) {
      expect(charts[k]).toBeDefined();
      expectSvgLimpio(charts[k]);
    }
  });

  test('no revienta con un objeto vacío: 6 placeholders', () => {
    const charts = buildReportCharts({});
    expect(Object.keys(charts)).toHaveLength(6);
    for (const svg of Object.values(charts)) {
      expect(typeof svg).toBe('string');
      expect(svg).not.toMatch(/undefined|NaN|Infinity/);
    }
  });

  test('no revienta con null', () => {
    expect(() => buildReportCharts(null)).not.toThrow();
  });

  test('speech incompleto no produce NaN en el centro del donut', () => {
    const charts = buildReportCharts({
      competencias: COMPETENCIAS_OK,
      charts: { speech: { usuario: undefined, victor: null, otros: NaN } }
    });
    expectSvgLimpio(charts.chart_habla);
  });

  test('todos los scores en 0 siguen generando gráficos válidos', () => {
    const cero = COMPETENCIAS_OK.map((c) => ({ ...c, score: 0 }));
    const charts = buildReportCharts({ competencias: cero, charts: {} });
    expectSvgLimpio(charts.chart_radar);
    expectSvgLimpio(charts.chart_ranking);
    expectSvgLimpio(charts.chart_brecha);
    expect(charts.chart_ranking).toMatch(/Rapport: 0 de 10/);
  });
});