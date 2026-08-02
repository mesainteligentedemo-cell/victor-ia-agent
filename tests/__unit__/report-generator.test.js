/**
 * TESTS — Generador del reporte
 *
 * Lo que se protege aquí es lo que se rompe en silencio: nada de esto lanza una
 * excepción cuando falla, simplemente el reporte sale mal y nadie se entera
 * hasta que un gerente abre el correo.
 *
 *   1. Los CTAs. Son lo único accionable del documento y viajan por correo.
 *      Un `href` deformado o un `javascript:` colado ahí no dan error: dan un
 *      botón muerto o un XSS firmado por la empresa.
 *   2. El formateo de la prosa enumerada. El agente devuelve "(1)… (2)… (3)…"
 *      en una sola parrafada; si el partidor deja de reconocerla, el reporte
 *      sigue generándose, solo que ilegible.
 *   3. La paleta. El color del anillo se calcula en JS, no en el CSS, así que
 *      es el único punto por donde puede volver a colarse la paleta vieja.
 */

const { ReportGenerator } = require('../../src/server/report-generator');

/** Instancia nueva por test: compila el template desde disco. */
const gen = () => new ReportGenerator();

// ════════════════════════════════════════════
// CTAs — enlaces firmados dentro de un href
// ════════════════════════════════════════════
describe('safeUrl — los tres CTAs del reporte', () => {
  const FIRMADA = 'https://victor-ia-agent.vercel.app/player?conv=abc123&t=1793405768.d261c258';

  test('conserva el signo igual: Handlebars lo escapaba a &#x3D;', () => {
    const out = String(gen().safeUrl(FIRMADA));
    expect(out).toContain('conv=abc123');
    expect(out).toContain('t=1793405768.d261c258');
    expect(out).not.toContain('&#x3D;');
  });

  test('escapa el ampersand una sola vez', () => {
    const out = String(gen().safeUrl(FIRMADA));
    expect(out).toContain('&amp;t=');
    expect(out).not.toContain('&amp;amp;');
  });

  test('es SafeString: el template no vuelve a escaparlo', () => {
    const out = gen().safeUrl(FIRMADA);
    expect(typeof out.toHTML).toBe('function');
  });

  test('cierra el atributo: comillas y ángulos no pueden escapar del href', () => {
    const out = String(gen().safeUrl('https://x.test/a?q="><script>alert(1)</script>'));
    expect(out).not.toMatch(/["<>]/);
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;');
  });

  test('rechaza esquemas peligrosos y cae a "#"', () => {
    const g = gen();
    for (const malicioso of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
      '//evil.test/phishing'
    ]) {
      expect(String(g.safeUrl(malicioso))).toBe('#');
    }
  });

  test('un CTA sin destino queda en "#", no en "undefined"', () => {
    const g = gen();
    expect(String(g.safeUrl(undefined))).toBe('#');
    expect(String(g.safeUrl(null))).toBe('#');
    expect(String(g.safeUrl(''))).toBe('#');
  });

  test('http y https pasan; el resto no', () => {
    const g = gen();
    expect(String(g.safeUrl('http://x.test/a'))).toBe('http://x.test/a');
    expect(String(g.safeUrl('https://x.test/a'))).toBe('https://x.test/a');
    expect(String(g.safeUrl('ftp://x.test/a'))).toBe('#');
  });

  test('el reporte renderizado deja los tres enlaces usables', async () => {
    const html = await gen().generate({
      nombre: 'Asesor',
      conversationId: 'abc123',
      pop_up_url: 'https://x.test/player?conv=abc123&t=1.aa',
      pdf_download_url: 'https://x.test/api/pdf/abc123?t=1.aa',
      retrain_url: 'https://x.test/retrain?conv=abc123&t=1.aa'
    });

    expect(html).toContain('href="https://x.test/player?conv=abc123&amp;t=1.aa"');
    expect(html).toContain('href="https://x.test/api/pdf/abc123?t=1.aa"');
    expect(html).toContain('href="https://x.test/retrain?conv=abc123&amp;t=1.aa"');
    // Ningún CTA puede quedarse sin destino ni con el igual deformado
    expect(html).not.toMatch(/class="cta" href="#"/);
    expect(html).not.toMatch(/class="cta" href="[^"]*&#x3D;/);
  });
});

// ════════════════════════════════════════════
// Prosa enumerada -> lista numerada
// ════════════════════════════════════════════
describe('formatRichText — "(1)… (2)…" se convierte en lista', () => {
  test('parte un párrafo con la enumeración embebida', () => {
    const out = gen().formatRichText(
      'La sesión comenzó a las 04:42. (1) El usuario solicitó practicar. ' +
      '(2) Nivel de participación: 5/10. (3) Cierre no intentado.'
    );

    expect(out).toContain('<span class="p-intro">La sesión comenzó a las 04:42.</span>');
    expect((out.match(/class="p-item"/g) || []).length).toBe(3);
    expect(out).toContain('<b class="p-num">1.-</b>');
    expect(out).toContain('<b class="p-num">3.-</b>');
  });

  test('acepta la lista ya partida en líneas', () => {
    const out = gen().formatRichText('Resumen:\n1) Primero\n2) Segundo\n3) Tercero');
    expect((out.match(/class="p-item"/g) || []).length).toBe(3);
    expect(out).toContain('Primero');
  });

  test('NO parte una cita suelta: un solo marcador no es una lista', () => {
    const out = gen().formatRichText('El estándar de la casa (1 de cada 10) no se alcanzó.');
    expect(out).not.toContain('p-item');
  });

  test('NO parte números fuera de secuencia', () => {
    const out = gen().formatRichText('Cerró en (3) minutos y subió (2) puntos.');
    expect(out).not.toContain('p-item');
  });

  test('escapa el HTML del texto original', () => {
    const out = gen().formatRichText('Intro <img src=x onerror=alert(1)>. (1) Uno. (2) Dos.');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('un texto vacío no produce marcado fantasma', () => {
    const g = gen();
    expect(g.formatRichText('')).toBe('');
    expect(g.formatRichText(null)).toBe('');
    expect(g.formatRichText(undefined)).toBe('');
  });

  test('el reporte aplica el formateo al resumen y al análisis de PNL', async () => {
    const html = await gen().generate({
      nombre: 'Asesor',
      resumen: 'Arranque correcto. (1) Punto uno del resumen. (2) Punto dos del resumen.',
      analisis_pnl: 'Observaciones. (1) Anclaje parcial. (2) Reencuadre ausente.'
    });

    expect(html).toContain('Punto uno del resumen');
    expect(html).toContain('Anclaje parcial');
    // Y ya no queda el "(1)" crudo pegado al texto
    expect(html).not.toContain('(1) Punto uno del resumen');
    expect(html).not.toContain('(1) Anclaje parcial');
  });
});

// ════════════════════════════════════════════
// Paleta y umbrales
// ════════════════════════════════════════════
describe('nivelDesempeno — paleta VTC v4.0 y cortes de la meta', () => {
  test('los colores son los de la paleta nueva', () => {
    const g = gen();
    expect(g.nivelDesempeno(9.5).color).toBe('#10B981');
    expect(g.nivelDesempeno(8.2).color).toBe('#E5B33E');
    expect(g.nivelDesempeno(6.5).color).toBe('#F59E0B');
    expect(g.nivelDesempeno(3).color).toBe('#EF4444');
  });

  test('ningún nivel devuelve un color de la paleta vieja', () => {
    const g = gen();
    const viejos = ['#009E73', '#d4af37', '#E69F00', '#D55E00'];
    for (const score of [0, 3, 5.9, 6, 7.9, 8, 8.9, 9, 10]) {
      expect(viejos).not.toContain(g.nivelDesempeno(score).color);
    }
  });

  test('el corte de "en desarrollo" está en 6, alineado con los gráficos', () => {
    const g = gen();
    expect(g.nivelDesempeno(6).cls).toBe('b-warn');
    expect(g.nivelDesempeno(5.9).cls).toBe('b-bad');
    expect(g.nivelDesempeno(8).cls).toBe('b-gold');
  });
});

// ════════════════════════════════════════════
// Secciones retiradas y salida general
// ════════════════════════════════════════════
describe('reporte renderizado — estructura', () => {
  let html;

  beforeAll(async () => {
    html = await gen().generate({
      nombre: 'Asesor',
      conversationId: 'abc',
      // Se mandan a propósito los campos de la sección retirada: aunque el
      // pipeline los siga calculando, no pueden reaparecer en pantalla.
      agente: { modelo: 'gpt-x', kb_chunks: 42 },
      kb_fidelity: { score: 38 },
      kb_topics: ['objeciones', 'cierre'],
      competencias: [
        { name: 'Rapport', score: 8.5 },
        { name: 'PNL', score: 6 },
        { name: 'Cierre', score: 2 }
      ]
    });
  });

  test('no reaparece la sección "Contexto de evaluación"', () => {
    const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, '');
    expect(sinComentarios).not.toMatch(/Contexto de evaluaci/i);
    expect(sinComentarios).not.toMatch(/Knowledge Base/i);
    expect(sinComentarios).not.toMatch(/Fidelidad al gui/i);
    expect(sinComentarios).not.toContain('gpt-x');
  });

  test('no quedan etiquetas "GRÁFICO N" sobre los gráficos', () => {
    expect(html).not.toMatch(/GR[ÁA]FICO\s*\d/i);
    expect(html).not.toContain('chart-kicker');
  });

  test('el ranking se titula por la brecha contra la meta VTC', () => {
    expect(html).toContain('brecha contra la meta VTC');
    expect(html).toContain('Meta VTC 8.0');
  });

  test('no queda ningún marcador de Handlebars sin resolver', () => {
    expect(html).not.toContain('{{');
  });

  test('no se imprime undefined ni NaN', () => {
    expect(html).not.toMatch(/>undefined</);
    expect(html).not.toMatch(/>NaN</);
  });
});
// ════════════════════════════════════════════
// Coherencia de color dentro de la misma pantalla
// ════════════════════════════════════════════
describe('score global — mismo color que el anillo', () => {
  test('la métrica sigue la escala, no un verde fijo', () => {
    const g = gen();
    expect(g.nivelDesempeno(9.5).metric).toBe('good');
    expect(g.nivelDesempeno(8.2).metric).toBe('gold');
    expect(g.nivelDesempeno(6.8).metric).toBe('warn');
    expect(g.nivelDesempeno(4).metric).toBe('bad');
  });

  test('un 68% no se pinta de verde junto a un anillo ámbar', async () => {
    const html = await gen().generate({ nombre: 'Asesor', score_overall: 6.8, scoreTotal: 68 });
    expect(html).toContain('<div class="metric-value warn">68%</div>');
    expect(html).not.toContain('<div class="metric-value good">68%</div>');
  });

  test('un desempeño élite sí llega en verde', async () => {
    const html = await gen().generate({ nombre: 'Asesor', score_overall: 9.4, scoreTotal: 94 });
    expect(html).toContain('<div class="metric-value good">94%</div>');
  });
});
