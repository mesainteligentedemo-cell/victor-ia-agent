/**
 * TESTS — Correo del reporte
 *
 * El correo es lo primero (y a veces lo único) que abre el gerente. Se protege:
 *
 *   1. La ESTRUCTURA acordada del cuerpo: saludo → confirmación → detalles →
 *      adjuntos → próximos pasos. El análisis largo vive en el PDF; si algún día
 *      vuelve al correo, estos tests lo detectan.
 *   2. Que la versión de texto plano diga lo mismo que la HTML — es el fallback
 *      de entregabilidad, no un resto.
 *   3. El nombre de los adjuntos: `Nombre_Apellido_ID_DDMMAAAA_HHMM`. Es lo que
 *      archiva el gerente; cambiarlo sin querer le rompe el orden de la carpeta.
 *   4. Que no vuelva la paleta vieja: el correo no comparte hoja de estilos con
 *      el reporte, así que nada avisa si se desincronizan.
 */

const {
  buildEmailHTML,
  buildEmailText,
  buildEmailSubject,
  buildEmailPackage,
  buildAttachmentBasename,
  formatDateLong,
  formatDateTimeLong,
  formatDuracion
} = require('../../src/server/email-sender');

const CUANDO = new Date('2026-08-01T11:26:00Z'); // 06:26 a.m. en Cancún
const MEDIODIA = new Date('2026-08-01T17:53:00Z'); // 12:53 p.m. en Cancún

const BASE = {
  nombre: 'Pablo Martínez',
  nombre_completo: 'Pablo Martínez',
  empleado_id: '1234567',
  departamento: 'Dirección',
  modulo: 'Meet & Greet',
  idioma: 'Español',
  duracion_texto: '18:42',
  duracion_sec: 1122,
  score_overall: 6.8,
  scoreTotal: 68
};

describe('formato de fecha, hora y duración', () => {
  test('la fecha larga va con día de dos dígitos y mes capitalizado', () => {
    expect(formatDateLong(CUANDO)).toBe('01 de Agosto de 2026');
  });

  test('la fecha y hora larga usan el separador del sistema', () => {
    expect(formatDateTimeLong(CUANDO)).toBe('01 de Agosto de 2026 • 06:26 a.m.');
  });

  test('la duración se dice en palabras, no en "mm:ss"', () => {
    expect(formatDuracion(570)).toBe('9 minutos 30 segundos');
    expect(formatDuracion(60)).toBe('1 minuto');
    expect(formatDuracion(45)).toBe('45 segundos');
    expect(formatDuracion(600)).toBe('10 minutos');
    expect(formatDuracion(0)).toBe('0 minutos');
  });
});

describe('asunto del reporte', () => {
  test('sigue el formato acordado, con emoji, nombre completo, fecha y hora', () => {
    expect(buildEmailSubject(BASE, CUANDO))
      .toBe('📊 Reporte de Capacitación: Pablo Martínez • 01/08/2026 06:26 a.m.');
  });

  test('cabe en la línea de asunto de cualquier cliente', () => {
    expect(buildEmailSubject(BASE, CUANDO).length).toBeLessThanOrEqual(78);
  });

  test('un nombre kilométrico se recorta sin arrastrar la fecha fuera de la vista', () => {
    const largo = buildEmailSubject(
      { ...BASE, nombre_completo: 'María Fernanda de la Concepción Villaseñor Etcheverría' },
      CUANDO
    );
    expect(largo.length).toBeLessThanOrEqual(78);
    expect(largo).toContain('01/08/2026');
    expect(largo).toContain('06:26 a.m.');
    expect(largo).toContain('María');
  });
});

describe('cuerpo del reporte', () => {
  const texto = buildEmailText(BASE, CUANDO);
  const html = buildEmailHTML(BASE, CUANDO);

  test('la estructura va en el orden acordado', () => {
    const orden = [
      'Estimado Pablo Martínez,',
      '✅ Tu sesión de entrenamiento ha finalizado correctamente.',
      '📋 DETALLES DE LA SESIÓN:',
      '📎 ADJUNTOS:',
      '🎯 PRÓXIMOS PASOS:',
      'Victor IA — Elite Training System'
    ];

    let cursor = -1;
    for (const bloque of orden) {
      const pos = texto.indexOf(bloque);
      expect(pos).toBeGreaterThan(cursor);
      cursor = pos;
    }
  });

  test('los detalles llevan empleado con ID, departamento, fecha, hora, duración y score', () => {
    expect(texto).toContain('• Empleado: Pablo Martínez (1234567)');
    expect(texto).toContain('• Departamento: Dirección');
    expect(texto).toContain('• Fecha: 01 de Agosto de 2026');
    expect(texto).toContain('• Hora: 06:26 a.m. (America/Cancun)');
    expect(texto).toContain('• Duración: 18 minutos 42 segundos');
    expect(texto).toContain('• Desempeño Global: 68%');
  });

  test('el HTML dice exactamente lo mismo que el texto plano', () => {
    for (const dato of [
      'Pablo Martínez', '1234567', 'Dirección',
      '01 de Agosto de 2026', '06:26 a.m.', '18 minutos 42 segundos', '68%'
    ]) {
      expect(html).toContain(dato);
    }
    expect(html).toContain('Tu sesión de entrenamiento ha finalizado correctamente');
    expect(html).toContain('Revisa el reporte adjunto para identificar áreas de mejora');
  });

  test('el análisis largo NO viaja en el correo: vive en el PDF', () => {
    const conProsa = buildEmailText(
      { ...BASE, resumen: 'Arranque a las 04:42. (1) Punto uno. (2) Punto dos.' },
      CUANDO
    );
    expect(conProsa).not.toContain('Punto uno');
    expect(conProsa).not.toContain('RECOMENDACIÓN DEL COACH');
  });

  test('sin MP3, el correo no promete un adjunto que no viaja', () => {
    const sinAudio = buildEmailText(BASE, CUANDO, { hasAudio: false });
    expect(sinAudio).toContain('• PDF: Reporte completo de capacitación');
    expect(sinAudio).not.toContain('MP3');

    expect(buildEmailHTML(BASE, CUANDO, { hasAudio: false })).not.toContain('Grabación de la sesión');
  });

  test('escapa el HTML que venga en los datos del asesor', () => {
    const sucio = buildEmailHTML(
      { ...BASE, nombre_completo: '<script>alert(1)</script>', departamento: '<b>X</b>' },
      CUANDO
    );
    expect(sucio).not.toContain('<script>alert(1)</script>');
    expect(sucio).toContain('&lt;script&gt;');
    expect(sucio).not.toContain('<b>X</b>');
  });

  test('sin nombre mapeado no se queda en blanco', () => {
    expect(buildEmailText({}, CUANDO)).toContain('Estimado Asesor VTC,');
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

describe('nombre de los adjuntos', () => {
  test('sigue el formato Nombre_Apellido_ID_DDMMAAAA_HHMM', () => {
    const base = buildAttachmentBasename(
      { nombre_completo: 'Christian Soria', empleado_id: '123456' },
      new Date('2026-08-01T16:53:00Z')
    );
    expect(base).toBe('Christian_Soria_123456_01082026_1153');
  });

  test('sin acentos ni caracteres reservados de Windows', () => {
    const base = buildAttachmentBasename(BASE, CUANDO);
    expect(base).toBe('Pablo_Martinez_1234567_01082026_0626');
    expect(base).not.toMatch(/[^A-Za-z0-9_]/);
  });

  test('la hora va en 24 h: dos sesiones del mismo día no se pisan', () => {
    const manana = buildAttachmentBasename(BASE, CUANDO);
    const tarde = buildAttachmentBasename(BASE, MEDIODIA);
    expect(tarde).toContain('_1253');
    expect(manana).not.toBe(tarde);
  });

  test('el PDF y el MP3 comparten base', () => {
    const pkg = buildEmailPackage(BASE, CUANDO);
    expect(pkg.pdfFilename).toBe(`${pkg.basename}.pdf`);
    expect(pkg.mp3Filename).toBe(`${pkg.basename}.mp3`);
  });

  test('acepta la forma antigua (nombre suelto) sin dejar guiones colgando', () => {
    const base = buildAttachmentBasename('Pablo Martínez', CUANDO);
    expect(base).toBe('Pablo_Martinez_01082026_0626');
    expect(base).not.toMatch(/__/);
  });
});