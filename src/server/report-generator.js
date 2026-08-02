/**
 * REPORT GENERATOR — Renderiza el HTML del reporte premium
 *
 * Entrada: datos completos del pipeline (mapper + análisis + charts)
 * Salida:  HTML autocontenido, listo para PDF (Puppeteer) y para archivar
 *
 * Cambio v3.1: los gráficos ya no se inyectan como <script> de ApexCharts.
 * Se renderizan como SVG inline en el servidor (src/server/chart-svg.js).
 * Motivo: ni Chromium headless con `networkidle2` ni un cliente de correo
 * garantizan la ejecución de JS de un CDN; el SVG siempre se ve.
 */

const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');
const { buildReportCharts } = require('./chart-svg');
const { buildActionPlan } = require('./action-plan');
const { managerRecipients } = require('./retrain-request');
const { formatDuracion } = require('./email-sender');

// Circunferencia del anillo de score (r = 58 en el viewBox del template)
const RING_CIRCUMFERENCE = 2 * Math.PI * 58;

/**
 * Textos con los que el reporte DECLARA un hueco.
 *
 * Regla del documento: un dato que no llegó se nombra, no se sustituye. Este
 * PDF lo archiva Recursos Humanos y sostiene decisiones sobre personas; un
 * valor de fábrica impreso aquí es indistinguible de un hallazgo real.
 */
const SIN_DATO = 'No disponible';
const SIN_EVALUACION = 'Pendiente de evaluación';
const SIN_IDENTIFICAR = 'Colaborador sin identificar';

class ReportGenerator {
  constructor() {
    // En Lambda, __dirname apunta al bundle; process.cwd() sí resuelve al proyecto.
    this.templatePath = path.join(process.cwd(), 'src/templates/reporte-master.html');
    this.template = null;
    this.loadTemplate();
  }

  loadTemplate() {
    try {
      const templateContent = fs.readFileSync(this.templatePath, 'utf-8');
      this.template = Handlebars.compile(templateContent);
      console.log('[REPORT] Template loaded successfully');
    } catch (error) {
      console.error('[REPORT] Failed to load template:', error.message);
      throw error;
    }
  }

  /**
   * Generar reporte HTML completo
   */
  async generate(data) {
    console.log('[REPORT] Generating report for:', data && data.nombre);

    try {
      const reportData = this.prepareData(data || {});
      const html = this.template(reportData);
      console.log(`[REPORT] HTML generado: ${html.length} chars`);
      return html;
    } catch (error) {
      console.error('[REPORT] Error generating report:', error.message);
      throw error;
    }
  }

  /**
   * Preparar y normalizar datos para el template
   */
  prepareData(data) {
    //
    // ⚠️ Aquí había una SEGUNDA capa de defaults ficticios, independiente de la
    // del mapeador: aunque el mapeo dejara el hueco, esta función volvía a
    // rellenarlo con un 8. Cualquier corrección aguas arriba quedaba anulada
    // justo antes de imprimir el PDF.
    //
    // `score` es ahora `null` cuando nadie evaluó, y de ese null cuelga todo lo
    // numérico del documento.
    const score = this.optNum(data.score_overall);
    const evaluado = score !== null;
    const scoreTotal = this.optNum(data.scoreTotal) ?? (evaluado ? Math.round((score / 10) * 100) : null);
    const nivel = evaluado ? this.nivelDesempeno(score) : this.nivelSinEvaluar();

    // Anillo de progreso: stroke-dasharray precalculado (Handlebars no hace
    // aritmética). Sin evaluación el anillo queda vacío en vez de dibujar un
    // arco que representaría una nota inexistente.
    const dash = evaluado
      ? (RING_CIRCUMFERENCE * Math.min(100, Math.max(0, scoreTotal))) / 100
      : 0;

    // Solo competencias con nota REAL. Si el payload no trae la lista armada
    // (integraciones que mandan los `score_*` sueltos), se reconstruye —pero
    // únicamente con las notas que existen, nunca completando las que faltan.
    const competencias = (Array.isArray(data.competencias) && data.competencias.length
      ? data.competencias
      : this.competenciasDesdeScores(data)
    ).filter((c) => c && c.name && Number.isFinite(Number(c.score)));

    // Los gráficos se construyen sobre los datos ya normalizados
    const charts = buildReportCharts({
      competencias,
      charts: data.charts || {},
      nombre: data.nombre
    });

    const transcription = Array.isArray(data.transcription) ? data.transcription : [];

    // Las listas se normalizan ANTES del plan: las notas de coaching citan
    // fortalezas y áreas de mejora, y si el plan leyera el texto crudo mientras
    // el reporte pinta la lista limpia, ambos dirían lo mismo con distinta cara.
    const fortalezas_list = this.toList(data.fortalezas_list, data.fortalezas);
    const areas_list = this.toList(data.areas_list, data.areas_mejora);
    const objeciones_list = this.toList(data.objeciones_list, data.objeciones_trabajadas, true);

    // Métricas derivadas de la conversación. Ninguna se inventa: si falta el
    // dato base, el campo sale null y el template no lo pinta.
    const metricas = this.metricasConversacion(data, transcription);

    // Plan de acción expandido (bloques A–F). Se construye sobre las mismas
    // competencias que alimentan los gráficos, así que reporte y plan nunca
    // pueden contradecirse.
    //
    // Sin evaluación NO hay plan: el bloque proponía sesiones de refuerzo,
    // plazos y una certificación "para atender clientes de forma autónoma"
    // calculados sobre notas que nadie puso.
    const accion = evaluado && competencias.length
      ? buildActionPlan(
        {
          ...data,
          score_overall: score,
          scoreTotal,
          transcription,
          fortalezas_list,
          areas_list,
          duracion_minutos: metricas.duracion_minutos
        },
        competencias
      )
      : { plan: null, plan_1: null, plan_2: null, plan_3: null };

    // A dónde llega una solicitud de reentrenamiento. El reporte lo dice
    // explícitamente: un CTA sin destino visible no se usa.
    const gerentes = managerRecipients();

    return {
      // ── Identidad ──────────────────────────────────────────
      // `nombre` ya llega como nombre completo desde el mapper (nombre +
      // apellido, completado contra el roster si el agente solo dio el de pila).
      // `nombre_completo` es el que pinta el reporte; el respaldo evita que un
      // payload viejo deje la portada en blanco.
      // Ningún relleno de fábrica: "VTC-001", "Dirección", "Meet & Greet" y
      // "Español" se imprimían como hechos verificados sobre la persona y la
      // sesión. Ahora el hueco se declara.
      nombre: this.v(data.nombre, SIN_IDENTIFICAR),
      nombre_completo: this.v(data.nombre_completo || data.nombre, SIN_IDENTIFICAR),
      apellido: this.v(data.apellido, ''),
      empleado_id: this.v(data.empleado_id, SIN_DATO),
      // Capturado por el empleado en el formulario de /training y verificado
      // contra el roster antes de abrir la sesión.
      departamento: this.v(data.departamento, SIN_DATO),
      puesto: this.v(data.puesto, SIN_DATO),
      modulo: this.v(data.modulo, SIN_DATO),
      familia_nombre: this.v(data.familia_nombre, null),
      idioma: this.v(data.idioma, SIN_DATO),
      conversationId: this.v(data.conversationId, SIN_DATO),

      // ── Transparencia ──────────────────────────────────────
      // Gobierna las secciones numéricas del template y alimenta el aviso de
      // "datos no registrados".
      evaluacion_disponible: evaluado,
      campos_sin_dato: Array.isArray(data.campos_sin_dato) ? data.campos_sin_dato : [],

      // ── Fecha y hora ───────────────────────────────────────
      // Fecha y hora son la ÚNICA excepción con respaldo: siempre viajan en el
      // webhook y, en su defecto, el instante de proceso es un dato real.
      fecha_sesion: this.v(data.fecha_sesion, new Date().toLocaleDateString('es-MX')),
      hora_sesion: this.v(data.hora_sesion, ''),
      hora_cancun: this.v(data.hora_cancun, data.hora_sesion),
      // "01 de Agosto de 2026" — el formato largo del sistema, el mismo que el correo.
      fecha_larga: this.v(data.fecha_larga, data.fecha_sesion),
      fecha_hora_larga: this.v(
        data.fecha_hora_larga,
        `${this.v(data.fecha_larga, data.fecha_sesion)} • ${this.v(data.hora_cancun, data.hora_sesion)}`
      ),
      // "00:00" y `formatDuracion(undefined)` → "0 minutos": el reporte afirmaba
      // que la sesión había durado cero. Ahora dice que no se midió.
      duracion_texto: this.v(data.duracion_texto, SIN_DATO),
      // "9 minutos 30 segundos": en el PDF se lee, no se descifra.
      duracion_humana: this.v(
        data.duracion_humana,
        Number.isFinite(Number(data.duracion_sec)) ? formatDuracion(data.duracion_sec) : SIN_DATO
      ),
      duracion_minutos: this.optNum(data.duracion_minutos),

      // ── Scores ─────────────────────────────────────────────
      // Todos opcionales. El template los pinta solo si `evaluacion_disponible`.
      score_rapport: this.optNum(data.score_rapport),
      score_pnl: this.optNum(data.score_pnl),
      score_postura: this.optNum(data.score_postura),
      score_objecciones: this.optNum(data.score_objecciones),
      score_lectura_sala: this.optNum(data.score_lectura_sala),
      score_cierre: this.optNum(data.score_cierre),
      score_overall: score,
      scoreTotal,
      // Textos listos para imprimir sin que el template tenga que decidir nada.
      score_overall_txt: evaluado ? `${score}/10` : SIN_EVALUACION,
      score_total_txt: evaluado ? `${scoreTotal}%` : SIN_EVALUACION,
      mejora_potencial: this.v(
        data.mejora_potencial,
        evaluado ? `${Math.max(0, 100 - scoreTotal)}%` : SIN_EVALUACION
      ),

      // Anillo + nivel
      ring_dash: Math.round(dash * 100) / 100,
      ring_gap: Math.round((RING_CIRCUMFERENCE - dash) * 100) / 100,
      ring_color: nivel.color,
      nivel_desempeno: nivel.label,
      nivel_clase: nivel.cls,
      // La métrica "Score global" llevaba la clase `good` fija en el template:
      // un 68% salía en verde junto a un anillo ámbar y a un semáforo rojo, y
      // el mismo número decía dos cosas distintas en la misma pantalla.
      score_clase: nivel.metric,

      // ── Narrativa ──────────────────────────────────────────
      // Todo lo que es prosa larga pasa por formatRichText: si el agente
      // devolvió "(1) … (2) … (3) …" en un solo bloque, aquí se convierte en
      // lista numerada con saltos de línea. Se inyecta con triple stash en el
      // template, por eso el escape de HTML ocurre dentro del formateador.
      //
      // Los respaldos afirmaban cosas: "Sesión de práctica completada", "El
      // cliente no planteó inquietudes durante esta sesión". Eso es narrar la
      // llamada sin haberla analizado. Sin texto del análisis, el campo va
      // vacío y su bloque desaparece del documento.
      resumen: this.formatRichText(this.v(data.resumen, '')),
      actividad_sesion: this.formatRichText(this.v(data.actividad_sesion, '')),
      recomendacion_coach: this.formatRichText(this.v(
        data.recomendacion_coach,
        evaluado && competencias.length ? this.recomendacionFallback(score, competencias) : ''
      )),
      analisis_pnl: this.formatRichText(this.v(data.analisis_pnl, '')),
      objeciones_trabajadas: this.formatRichText(this.v(data.objeciones_trabajadas, '')),

      // Texto plano (fallback) + listas (presentación preferida)
      fortalezas: this.formatRichText(data.fortalezas),
      areas_mejora: this.formatRichText(data.areas_mejora),
      fortalezas_list,
      areas_list,
      objeciones_list,

      // ── Neurociencia ───────────────────────────────────────
      principios_neuro: this.formatPrincipios(data.principios_neuro),
      // Sin dato NO hay medidor: el 85% fijo era una calificación inventada de
      // la aplicación de la metodología.
      cumplimiento_neuro: this.optNum(data.cumplimiento_neuro),

      // ── Plan de acción ─────────────────────────────────────
      // Los tres campos históricos siguen existiendo (el correo y N8N los
      // leen), pero ahora se derivan del plan expandido en vez de ser texto
      // suelto. `plan` trae los bloques A–F que pinta la sección 09.
      plan_1: this.formatRichText(this.v(data.plan_1, accion.plan_1 || '')),
      plan_2: this.formatRichText(this.v(data.plan_2, accion.plan_2 || '')),
      plan_3: this.formatRichText(this.v(data.plan_3, accion.plan_3 || '')),
      plan: accion.plan ? this.formatPlan(accion.plan) : null,

      // ── Flujo de reentrenamiento ───────────────────────────
      gerente_email: gerentes.join(', '),
      gerente_email_lista: gerentes,

      // ── Transcripción ──────────────────────────────────────
      transcription,
      transcript_turnos: transcription.length,

      // ── Métricas derivadas de la conversación ──────────────
      ...metricas,

      // ── CTAs ───────────────────────────────────────────────
      // Van por safeUrl y no por `v()`: los tres son enlaces firmados con
      // `?conv=…&t=…` y el escape por defecto de Handlebars los deforma.
      pop_up_url: this.safeUrl(data.pop_up_url),
      pdf_download_url: this.safeUrl(data.pdf_download_url),
      retrain_url: this.safeUrl(data.retrain_url),

      // Aquí viajaban `agente`, `kb_fidelity` y `kb_topics`, que alimentaban la
      // sección "Contexto de evaluación" (modelo, Knowledge Base, fidelidad al
      // guion). Esa sección se retiró del reporte: era telemetría del sistema,
      // no información con la que el gerente pueda decidir algo sobre el asesor,
      // y un "fidelidad 38%" sin escala se leía como una calificación más.
      // El RAG sigue corriendo — alimenta el análisis, ya no la pantalla.

      // ── Competencias + gráficos SVG ────────────────────────
      competencias,
      ...charts
    };
  }

  // ════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════

  /** Valor con default; descarta vacíos y nulos. */
  v(value, def) {
    if (value === null || value === undefined) return def;
    const s = String(value).trim();
    return s === '' || s === '-' ? def : s;
  }

  /** Número finito con default. */
  num(value, def) {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }

  /**
   * Número REAL o `null`. Nunca un relleno.
   *
   * La diferencia con `num()` es toda la auditoría: `Number(null)` es 0 y
   * `Number(undefined)` es NaN, así que cualquier ausencia acababa cayendo en
   * el default que se le pasara —normalmente un 8—. Aquí la ausencia sobrevive
   * como ausencia hasta el template, que decide no pintarla.
   */
  optNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** Estado del badge cuando la sesión no tiene evaluación. */
  nivelSinEvaluar() {
    return {
      label: SIN_EVALUACION,
      cls: 'b-gold',
      metric: 'gold',
      // Gris neutro: el anillo no debe sugerir aprobado ni reprobado.
      color: 'rgba(255,255,255,.18)'
    };
  }

  /**
   * URL de un CTA, lista para ir dentro de un `href`.
   *
   * El problema que resuelve: `Handlebars.escapeExpression` escapa TAMBIÉN el
   * signo igual. Un enlace firmado
   *
   *   /player?conv=abc&t=1793.8340d6
   *
   * salía del template como
   *
   *   /player?conv&#x3D;abc&amp;t&#x3D;1793.8340d6
   *
   * El navegador decodifica esas entidades y el clic funciona, pero el enlace
   * deja de ser legible y todo lo que no sea un parser de HTML completo se lo
   * come mal: copiar la dirección a mano, un cliente de correo que reescribe
   * enlaces, un extractor de anotaciones del PDF. Y los tres CTAs (audio, PDF,
   * reentrenamiento) son justamente lo único accionable del reporte.
   *
   * Qué hace en su lugar: valida el esquema y escapa solo lo que rompería el
   * atributo, dejando `=` intacto. Devuelve SafeString para que Handlebars no
   * vuelva a escapar lo ya escapado (`&amp;` -> `&amp;amp;`).
   *
   * Seguridad: solo pasan `http://` y `https://`. El pipeline construye estas
   * URLs, pero el reporte viaja por correo — un `javascript:` aquí sería XSS
   * servido con la firma de la empresa. Cualquier otra cosa cae a '#'.
   */
  safeUrl(value) {
    const raw = this.v(value, '#');
    if (!/^https?:\/\//i.test(raw)) return new Handlebars.SafeString('#');

    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return new Handlebars.SafeString(escaped);
  }

  /**
   * Convierte un bloque de texto en lista de puntos.
   * Acepta separadores por salto de línea o, si `commaSplit`, por coma.
   * Limpia viñetas heredadas (✓, •, -, *) para que el CSS ponga la suya.
   */
  toList(preferred, rawText, commaSplit = false) {
    if (Array.isArray(preferred) && preferred.length) {
      return preferred.map((x) => this.stripBullet(String(x))).filter(Boolean);
    }
    if (!rawText) return [];

    const text = String(rawText);
    let parts = text.split(/\r?\n|(?:^|\s)[•·]\s+/).filter((p) => p && p.trim());

    // Si vino todo en una línea y se pidió, partimos por comas de nivel superior
    if (parts.length <= 1 && commaSplit) {
      parts = text.split(/,(?![^(]*\))/).filter((p) => p && p.trim());
    }

    const items = parts.map((p) => this.stripBullet(p)).filter(Boolean);
    return items.length > 1 ? items : items.length === 1 ? items : [];
  }

  /** Quita viñetas y numeración inicial. */
  stripBullet(line) {
    return String(line)
      .replace(/^\s*(?:[✓✔✅×✗•·▪▸►◆●○*\-–—]|\d+[.)])\s*/u, '')
      .trim();
  }

  /**
   * Métricas que se calculan a partir de la conversación, no del agente.
   *
   * Alimentan el plan de acción (los detectores de patrones miran el ritmo de
   * intervenciones y la duración) y la cabecera de la sección de resumen.
   *
   * Regla: si el dato base no está, el resultado es null. Un "0%" inventado en
   * un reporte de coaching es peor que un hueco: el gerente lo lee como un
   * hallazgo real.
   *
   * @param {object} data
   * @param {Array} transcription
   */
  metricasConversacion(data, transcription) {
    const turnos = transcription.length;

    // Duración en minutos: preferimos el dato explícito; si no, lo derivamos
    // de los segundos, y en último término del texto "mm:ss".
    let minutos = Number(data.duracion_minutos);
    if (!Number.isFinite(minutos) || minutos <= 0) {
      const segs = Number(data.duracion_sec);
      if (Number.isFinite(segs) && segs > 0) {
        minutos = Math.floor(segs / 60);
      } else {
        const m = String(data.duracion_texto || '').match(/^(\d+):(\d{1,2})$/);
        minutos = m ? Number(m[1]) : 0;
      }
    }

    const turnosAgente = transcription.filter((t) => t && t.type === 'agent').length;
    const turnosAsesor = turnos - turnosAgente;

    // Reparto de la palabra por caracteres pronunciados: se acerca más al
    // tiempo real de habla que contar turnos (un turno puede ser "ajá").
    const chars = transcription.reduce(
      (acc, t) => {
        const n = String((t && t.text) || '').length;
        if (t && t.type === 'agent') acc.agente += n;
        else acc.asesor += n;
        return acc;
      },
      { agente: 0, asesor: 0 }
    );
    const totalChars = chars.agente + chars.asesor;

    return {
      duracion_minutos: minutos,
      turnos_agente: turnosAgente,
      turnos_asesor: turnosAsesor,
      // Intervenciones por minuto: detecta monólogos y conversaciones picadas
      ritmo_turnos: turnos > 0 && minutos > 0
        ? Math.round((turnos / minutos) * 10) / 10
        : null,
      // Cuánto habló el asesor. En venta consultiva debe quedar bajo el 45%.
      habla_asesor_pct: totalChars > 0
        ? Math.round((chars.asesor / totalChars) * 100)
        : null,
      palabras_promedio_turno: turnos > 0
        ? Math.round(totalChars / turnos)
        : null
    };
  }

  /**
   * Clasificación del desempeño (etiqueta + color + clase CSS del badge).
   *
   * Los colores son los de la paleta VTC v4.0 — los mismos que pintan los
   * gráficos, el correo y el formulario. El `color` alimenta `ring_color`, que
   * el template usa en el anillo de la portada y en el score de objeciones: si
   * aquí se quedara la paleta vieja, el anillo saldría verde bosque sobre un
   * reporte cuyo verde es #10B981.
   *
   * Los cortes siguen la meta VTC de 8.0: por debajo de 8 hay brecha.
   */
  nivelDesempeno(score) {
    if (score >= 9) return { label: 'Desempeño excepcional', cls: 'b-good', metric: 'good', color: '#10B981' };
    if (score >= 8) return { label: 'Desempeño sólido', cls: 'b-gold', metric: 'gold', color: '#E5B33E' };
    if (score >= 6) return { label: 'En desarrollo', cls: 'b-warn', metric: 'warn', color: '#F59E0B' };
    return { label: 'En formación', cls: 'b-bad', metric: 'bad', color: '#EF4444' };
  }

  /**
   * Recomendación del equipo de desarrollo cuando el análisis no la envía.
   * Se construye con los datos reales de la sesión — no es texto genérico.
   */
  recomendacionFallback(score, competencias) {
    const ordenadas = (competencias || []).slice().sort((a, b) => a.score - b.score);
    const baja = ordenadas[0];
    const alta = ordenadas[ordenadas.length - 1];

    if (!baja || !alta) {
      return `Desempeño general de ${score}/10. Se recomienda mantener el ritmo de práctica y revisar la grabación `
        + `junto con el líder del área.`;
    }

    if (score >= 8.5) {
      return `Desempeño general de ${score}/10: el colaborador está listo para atender clientes de forma autónoma. `
        + `Conviene aprovechar su fortaleza en ${alta.name} (${alta.score}/10) compartiendo la grabación como material `
        + `de referencia para el equipo. Único punto por seguir de cerca: ${baja.name} (${baja.score}/10), que puede `
        + `reforzarse durante la sesión semanal.`;
    }

    if (score >= 7) {
      return `Desempeño general de ${score}/10: base sólida con una oportunidad de mejora bien identificada. `
        + `Se recomienda concentrar el acompañamiento de los próximos 7 días en ${baja.name} (${baja.score}/10), `
        + `sin modificar ${alta.name} (${alta.score}/10), que ya alcanza el nivel esperado. `
        + `El avance se verifica con una nueva práctica al séptimo día.`;
    }

    return `Desempeño general de ${score}/10: el colaborador se encuentra en etapa de formación. `
      + `Se recomienda dar prioridad a ${baja.name} (${baja.score}/10) con acompañamiento diario, apoyándose en `
      + `${alta.name} (${alta.score}/10) como base de confianza. El progreso se verifica en 7 días con una práctica completa.`;
  }

  /**
   * Competencias reconstruidas desde los `score_*` sueltos del payload.
   *
   * Sustituye a `competenciasFallback()`, que fabricaba las SEIS competencias
   * con las notas 8, 8, 9, 7, 9 y 8 cuando el mapeo no traía ninguna. Con aquel
   * respaldo, una sesión sin evaluar producía un radar completo, un ranking
   * ordenado y un gráfico de brechas: seis afirmaciones gráficas sobre el
   * desempeño de una persona, ninguna de ellas medida.
   *
   * La diferencia está en el `.filter`: aquí solo sobrevive lo que el agente
   * puntuó de verdad. Si no puntuó nada, la lista va vacía y los gráficos se
   * declaran sin datos (ver emptyChart en src/server/chart-svg.js).
   *
   * Los nombres son los que lee un director de hotel, no los del manual de
   * ventas. Ver la nota en src/server/n8n-mapper.js.
   */
  competenciasDesdeScores(data) {
    return [
      { name: 'Conexión', score: this.optNum(data.score_rapport) },
      { name: 'Comunicación', score: this.optNum(data.score_pnl) },
      { name: 'Presencia', score: this.optNum(data.score_postura) },
      { name: 'Inquietudes', score: this.optNum(data.score_objecciones) },
      { name: 'Percepción', score: this.optNum(data.score_lectura_sala) },
      { name: 'Cierre', score: this.optNum(data.score_cierre) }
    ].filter((c) => c.score !== null);
  }

  /** Texto multilínea -> HTML con <br> (se inyecta con triple stash). */
  formatText(text) {
    if (!text) return '';
    return Handlebars.escapeExpression(String(text))
      .split('\n')
      .filter((l) => l.trim())
      .join('<br>');
  }

  /**
   * Prosa larga -> HTML legible.
   *
   * El agente devuelve el resumen y el análisis como una parrafada única con
   * la enumeración embebida:
   *
   *   "La sesión comenzó a las 04:42 … (1) El usuario solicitó … (2) Nivel de
   *    participación: 5/10 … (3) …"
   *
   * Eso nadie lo lee: se escanea y se abandona. Aquí se parte en intro + puntos
   * numerados con salto de línea entre cada uno:
   *
   *   La sesión comenzó a las 04:42 …
   *
   *   1.- El usuario solicitó …
   *   2.- Nivel de participación: 5/10 …
   *
   * Qué se reconoce como marcador de punto:
   *   (1)   1)   1.-   1.   ①…  — al inicio de línea o embebido en el párrafo
   *
   * Reglas de seguridad:
   *   - Se exigen AL MENOS DOS marcadores. Con uno solo casi siempre es una
   *     cita ("el estándar (1 de 10)") o una referencia, no una lista.
   *   - Los marcadores embebidos deben ir en orden ascendente empezando en 1.
   *     Sin esto, "cerró en (3) minutos … subió (2) puntos" se partía en lista.
   *   - Todo se escapa aquí dentro: la salida se inyecta con triple stash.
   *
   * @param {string} text
   * @returns {string} HTML seguro, listo para {{{ }}}
   */
  formatRichText(text) {
    if (text === null || text === undefined) return '';
    const raw = String(text).replace(/<br\s*\/?>/gi, '\n').trim();
    if (!raw) return '';

    const esc = (s) => Handlebars.escapeExpression(s);

    // ── Caso A: la lista ya viene en líneas separadas ────────────────
    // El marcador exige terminador explícito — "(1)", "1)", "1.", "1.-".
    // Sin él, "10 personas asistieron" se leía como el punto número 10.
    const LINEA_NUMERADA = /^(?:\((\d{1,2})\)|(\d{1,2})\s*[.)\-–—]+)\s*(.*)$/;

    const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lineas.length > 1) {
      const numeradas = lineas.filter((l) => LINEA_NUMERADA.test(l));
      if (numeradas.length >= 2) {
        const intro = [];
        const items = [];
        for (const linea of lineas) {
          const m = linea.match(LINEA_NUMERADA);
          if (m) items.push({ n: m[1] || m[2], texto: String(m[3] || '').trim() });
          else if (!items.length) intro.push(linea);
          else items[items.length - 1].texto += ` ${linea}`;
        }
        return this.renderPuntos(intro.join(' '), items);
      }
      // Varias líneas sin numerar: se respetan los saltos, nada más.
      return lineas.map((l) => `<span class="p-line">${esc(l)}</span>`).join('');
    }

    // ── Caso B: un solo párrafo con "(1) … (2) …" embebido ───────────
    //
    // El separador de la izquierda va como lookbehind, NO como grupo que
    // consume. Con un grupo que consume, un texto tan común como
    //
    //   "La sesión comenzó a las 04:42. (1) El usuario solicitó…"
    //
    // se rompía: el "42. " de la hora casaba como marcador y se tragaba el
    // espacio anterior al "(1)", que a partir de ahí ya no encontraba su propio
    // separador y quedaba invisible. La secuencia empezaba en el 2, el filtro
    // "debe arrancar en 1" la descartaba entera y el párrafo se imprimía en un
    // solo bloque — justo el caso que este formateador existe para arreglar.
    // El lookbehind mira el carácter sin consumirlo, así que cada marcador
    // conserva el suyo. Los falsos positivos (el "42") siguen cayendo por el
    // filtro de secuencia de más abajo.
    const marcadores = [];
    const re = /(?<=^|[\s;:,.])\(?(\d{1,2})\)\s*|(?<=^|[\s;:,.])(\d{1,2})[.)]-?\s+/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      marcadores.push({
        n: Number(m[1] || m[2]),
        inicio: m.index,
        fin: m.index + m[0].length
      });
    }

    // Solo aceptamos la secuencia 1,2,3… completa desde el principio.
    const secuencia = [];
    for (const mk of marcadores) {
      if (mk.n === secuencia.length + 1) secuencia.push(mk);
    }
    if (secuencia.length < 2) return esc(raw);

    const intro = raw.slice(0, secuencia[0].inicio).trim();
    const items = secuencia.map((mk, i) => {
      const fin = i + 1 < secuencia.length ? secuencia[i + 1].inicio : raw.length;
      return { n: String(mk.n), texto: raw.slice(mk.fin, fin).trim().replace(/[;,]+$/, '') };
    });

    return this.renderPuntos(intro, items);
  }

  /** Pinta intro + puntos numerados. El CSS del reporte hace la sangría. */
  renderPuntos(intro, items) {
    const esc = (s) => Handlebars.escapeExpression(s);
    const partes = [];

    const introLimpio = String(intro || '').trim();
    if (introLimpio) partes.push(`<span class="p-intro">${esc(introLimpio)}</span>`);

    for (const it of items) {
      if (!it.texto) continue;
      partes.push(
        `<span class="p-item"><b class="p-num">${esc(it.n)}.-</b>${esc(it.texto)}</span>`
      );
    }
    return partes.join('');
  }

  /** Aplica el formateo de listas a las descripciones de neurociencia. */
  formatPrincipios(principios) {
    if (!Array.isArray(principios)) return [];
    return principios.map((p) => ({
      ...p,
      descripcion: this.formatRichText(p && p.descripcion)
    }));
  }

  /**
   * Aplica el formateo de listas a los textos largos del plan de acción.
   * Solo toca los campos que se inyectan con triple stash en el template;
   * el resto del plan sigue escapándose por Handlebars como siempre.
   */
  formatPlan(plan) {
    if (!plan || typeof plan !== 'object') return plan;

    const out = { ...plan };

    if (Array.isArray(plan.diagnostico)) {
      out.diagnostico = plan.diagnostico.map((d) => ({
        ...d,
        detalle: this.formatRichText(d && d.detalle)
      }));
    }

    if (plan.pasos && typeof plan.pasos === 'object') {
      out.pasos = {
        ...plan.pasos,
        reevaluacion: this.formatRichText(plan.pasos.reevaluacion)
      };
    }

    return out;
  }
}

/**
 * Export singleton function
 */
async function generateHTMLReport(data) {
  const generator = new ReportGenerator();
  return generator.generate(data);
}

module.exports = { ReportGenerator, generateHTMLReport };