/**
 * TESTS — Correo del reporte
 *
 * El correo es lo primero (y a veces lo único) que abre el gerente. Se protege:
 *
 *   1. Que la prosa enumerada del agente se parta igual que en el reporte. Si
 *      los dos formateadores se separan, el mismo resumen sale en lista en el
 *      PDF y apelmazado en el correo.
 *   2. Que la versión de texto plano diga lo mismo que la HTML — es el fallback
 *      de entregabilidad, no un resto.
 *   3. Que no vuelva la paleta vieja: el correo no comparte hoja de estilos con
 *      el reporte, así que nada avisa si se desincronizan.
 */

const {
  buildEmailHTML,
  buildEmailText,
  buildEmailSubject,
  buildAttachmentBasename
} = require('../../src/server/email-sender');

const CUANDO = new Date('2026-08-01T11:26:00Z'); // 06:26 a.m. en Cancún

const BASE = {
  nombre: 'Pablo Martínez',
  modulo: 'Meet & Greet',
  idioma: 'Español',
  duracion_texto: '18:42',
  score_overall: 6.8,
  scoreTotal: 68
};

describe('enumeración del correo', () => {
  test('parte el párrafo aunque venga precedido de una hora ("04:42.")', () => {
    const html = buildEmailHTML({
      ...BASE,
      resumen: 'La sesión comenzó a las 04:42. (1) El usuario solicitó practicar. ' +
        '(2) Nivel de participación: 5/10. (3) Cierre no intentado.'
    }, CUANDO);

    // Los tres puntos salen numerados y con su texto
    expect(html).toContain('1.-');
    expect(html).toContain('2.-');
    expect(html).toContain('3.-');
    expect(html).toContain('El usuario solicitó practicar');
    // Y la intro se queda arriba, sin el "(1)" pegado
    expect(html).toContain('La sesión comenzó a las 04:42.');
    expect(html).not.toContain('(1) El usuario solicitó');
  });

  test('la versión en texto plano queda numerada igual', () => {
    const texto = buildEmailText({
      ...BASE,
      resumen: 'Arranque a las 04:42. (1) Punto uno. (2) Punto dos.'
    }, CUANDO);

    expect(texto).toContain('\n1.- Punto uno');
    expect(texto).toContain('\n2.- Punto dos');
  });

  test('no parte lo que no es una lista', () => {
    const html = buildEmailHTML({
      ...BASE,
      resumen: 'Cerró en (3) minutos y subió (2) puntos.'
    }, CUANDO);

    expect(html).not.toContain('1.-');
    expect(html).toContain('Cerró en (3) minutos');
  });

  test('escapa el HTML que venga en el texto del agente', () => {
    const html = buildEmailHTML({
      ...BASE,
      resumen: '<script>alert(1)</script> resumen normal.'
    }, CUANDO);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('paleta del correo', () => {
  const html = buildEmailHTML(BASE, CUANDO);

  test('usa la paleta VTC v4.0', () => {
    expect(html).toContain('#0D0D0D'); // fondo
    expect(html).toContain('#1A1A1A'); // tarjeta
    expect(html).toContain('#262626'); // cabecera / badges
    expect(html).toContain('#E5B33E'); // oro
    expect(html).toContain('#B8B8B8'); // texto secundario
  });

  test('no queda nada de la paleta azul anterior', () => {
    for (const viejo of ['#0a1721', '#102435', '#1a3a52', '#d4af37', '#009E73', '#E69F00', '#D55E00']) {
      expect(html.toLowerCase()).not.toContain(viejo.toLowerCase());
    }
  });

  test('el desempeño se colorea con los cortes de la meta VTC', () => {
    expect(buildEmailHTML({ ...BASE, score_overall: 9 }, CUANDO)).toContain('#10B981');
    expect(buildEmailHTML({ ...BASE, score_overall: 7 }, CUANDO)).toContain('#F59E0B');
    expect(buildEmailHTML({ ...BASE, score_overall: 4 }, CUANDO)).toContain('#EF4444');
  });
});

describe('CTAs del correo', () => {
  test('pinta los tres botones cuando hay enlaces reales', () => {
    const html = buildEmailHTML({
      ...BASE,
      pop_up_url: 'https://x.test/player?conv=a&t=1.aa',
      pdf_download_url: 'https://x.test/api/pdf/a?t=1.aa',
      retrain_url: 'https://x.test/retrain?conv=a&t=1.aa'
    }, CUANDO);

    expect(html).toContain('Escuchar la sesión');
    expect(html).toContain('Descargar el reporte');
    expect(html).toContain('Repetir el entrenamiento');
    // El ampersand se escapa una sola vez y el `=` sobrevive legible
    expect(html).toContain('conv=a&amp;t=1.aa');
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toContain('&#x3D;');
  });

  test('omite los botones sin destino en vez de dejarlos muertos', () => {
    const html = buildEmailHTML({ ...BASE, pop_up_url: '#', pdf_download_url: '' }, CUANDO);
    expect(html).not.toContain('href="#"');
  });

  test('descarta esquemas que no sean http(s)', () => {
    const html = buildEmailHTML({ ...BASE, pop_up_url: 'javascript:alert(1)' }, CUANDO);
    expect(html).not.toContain('javascript:');
  });
});

describe('asunto y adjuntos', () => {
  test('el asunto lleva nombre, fecha y hora de Cancún', () => {
    const s = buildEmailSubject(BASE, CUANDO);
    expect(s).toContain('Pablo Martínez');
    expect(s).toContain('01/08/2026');
    expect(s).toMatch(/06:26 a\.m\./);
  });

  test('el PDF y el MP3 comparten base de nombre, sin acentos ni espacios', () => {
    const base = buildAttachmentBasename('Pablo Martínez', CUANDO);
    expect(base).toBe('Pablo_Martinez_01_08_2026_06_26_am');
    expect(base).not.toMatch(/[^A-Za-z0-9_]/);
  });
});