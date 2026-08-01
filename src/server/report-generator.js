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

// Circunferencia del anillo de score (r = 58 en el viewBox del template)
const RING_CIRCUMFERENCE = 2 * Math.PI * 58;

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
    const score = this.num(data.score_overall, 8);
    const scoreTotal = this.num(data.scoreTotal, Math.round((score / 10) * 100));
    const nivel = this.nivelDesempeno(score);

    // Anillo de progreso: stroke-dasharray precalculado (Handlebars no hace aritmética)
    const dash = (RING_CIRCUMFERENCE * Math.min(100, Math.max(0, scoreTotal))) / 100;

    const competencias = Array.isArray(data.competencias) && data.competencias.length
      ? data.competencias
      : this.competenciasFallback(data);

    // Los gráficos se construyen sobre los datos ya normalizados
    const charts = buildReportCharts({
      competencias,
      charts: data.charts || {},
      nombre: data.nombre
    });

    const transcription = Array.isArray(data.transcription) ? data.transcription : [];

    return {
      // ── Identidad ──────────────────────────────────────────
      nombre: this.v(data.nombre, 'Asesor VTC'),
      empleado_id: this.v(data.empleado_id, 'VTC-001'),
      puesto: this.v(data.puesto, 'Asesor'),
      modulo: this.v(data.modulo, 'Meet & Greet'),
      familia_nombre: this.v(data.familia_nombre, 'Familia simulada'),
      idioma: this.v(data.idioma, 'Español'),
      conversationId: this.v(data.conversationId, '—'),

      // ── Fecha y hora ───────────────────────────────────────
      fecha_sesion: this.v(data.fecha_sesion, new Date().toLocaleDateString('es-MX')),
      hora_sesion: this.v(data.hora_sesion, ''),
      hora_cancun: this.v(data.hora_cancun, data.hora_sesion),
      fecha_larga: this.v(data.fecha_larga, data.fecha_sesion),
      duracion_texto: this.v(data.duracion_texto, '00:00'),
      duracion_minutos: this.num(data.duracion_minutos, 0),

      // ── Scores ─────────────────────────────────────────────
      score_rapport: this.num(data.score_rapport, 8),
      score_pnl: this.num(data.score_pnl, 8),
      score_postura: this.num(data.score_postura, 9),
      score_objecciones: this.num(data.score_objecciones, 7),
      score_lectura_sala: this.num(data.score_lectura_sala, 9),
      score_cierre: this.num(data.score_cierre, 8),
      score_overall: score,
      scoreTotal,
      mejora_potencial: this.v(data.mejora_potencial, `${Math.max(0, 100 - scoreTotal)}%`),

      // Anillo + nivel
      ring_dash: Math.round(dash * 100) / 100,
      ring_gap: Math.round((RING_CIRCUMFERENCE - dash) * 100) / 100,
      ring_color: nivel.color,
      nivel_desempeno: nivel.label,
      nivel_clase: nivel.cls,

      // ── Narrativa ──────────────────────────────────────────
      resumen: this.v(data.resumen, 'Sesión de entrenamiento completada.'),
      actividad_sesion: this.v(data.actividad_sesion, 'Sesión completada.'),
      recomendacion_coach: this.v(
        data.recomendacion_coach,
        this.recomendacionFallback(score, competencias)
      ),
      analisis_pnl: this.v(data.analisis_pnl, 'Sin observaciones de PNL registradas en esta sesión.'),
      objeciones_trabajadas: this.v(data.objeciones_trabajadas, 'No se registraron objeciones.'),

      // Texto plano (fallback) + listas (presentación preferida)
      fortalezas: this.formatText(data.fortalezas),
      areas_mejora: this.formatText(data.areas_mejora),
      fortalezas_list: this.toList(data.fortalezas_list, data.fortalezas),
      areas_list: this.toList(data.areas_list, data.areas_mejora),
      objeciones_list: this.toList(data.objeciones_list, data.objeciones_trabajadas, true),

      // ── Neurociencia ───────────────────────────────────────
      principios_neuro: Array.isArray(data.principios_neuro) ? data.principios_neuro : [],
      cumplimiento_neuro: this.num(data.cumplimiento_neuro, 85),

      // ── Plan de acción ─────────────────────────────────────
      plan_1: this.v(data.plan_1, 'Diagnóstico completado.'),
      plan_2: this.v(data.plan_2, 'Plan de mejora establecido.'),
      plan_3: this.v(data.plan_3, 'Validación en 7 días.'),

      // ── Transcripción ──────────────────────────────────────
      transcription,
      transcript_turnos: transcription.length,

      // ── CTAs ───────────────────────────────────────────────
      pop_up_url: this.v(data.pop_up_url, '#'),
      pdf_download_url: this.v(data.pdf_download_url, '#'),
      retrain_url: this.v(data.retrain_url, '#'),

      // ── Contexto del agente (KB / RAG) ─────────────────────
      agente: data.agente || {},
      kb_fidelity: data.kb_fidelity || null,
      kb_topics: data.kb_topics || [],

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

  /** Clasificación del desempeño (etiqueta + color + clase CSS del badge). */
  nivelDesempeno(score) {
    if (score >= 9) return { label: 'Desempeño élite', cls: 'b-good', color: '#009E73' };
    if (score >= 8) return { label: 'Desempeño sólido', cls: 'b-gold', color: '#d4af37' };
    if (score >= 6.5) return { label: 'En desarrollo', cls: 'b-warn', color: '#E69F00' };
    return { label: 'Requiere refuerzo', cls: 'b-bad', color: '#D55E00' };
  }

  /**
   * Recomendación del coach cuando el agente no la envía.
   * Se construye con los datos reales de la sesión — no es texto genérico.
   */
  recomendacionFallback(score, competencias) {
    const ordenadas = (competencias || []).slice().sort((a, b) => a.score - b.score);
    const baja = ordenadas[0];
    const alta = ordenadas[ordenadas.length - 1];

    if (!baja || !alta) {
      return `Desempeño global de ${score}/10. Mantener el ritmo de práctica y revisar la grabación con el gerente.`;
    }

    if (score >= 8.5) {
      return `Desempeño de ${score}/10: listo para piso de ventas. Capitalizar ${alta.name} `
        + `(${alta.score}/10) usando la grabación como material de referencia para el equipo. `
        + `Único punto de vigilancia: ${baja.name} (${baja.score}/10) — reforzar en la sesión semanal.`;
    }

    if (score >= 7) {
      return `Desempeño de ${score}/10: sólido con una brecha clara. Concentrar el coaching de los `
        + `próximos 7 días en ${baja.name} (${baja.score}/10) sin tocar ${alta.name} (${alta.score}/10), `
        + `que ya está en estándar. Reevaluar con una simulación al séptimo día.`;
    }

    return `Desempeño de ${score}/10: requiere refuerzo antes de piso de ventas. Prioridad absoluta en `
      + `${baja.name} (${baja.score}/10) con acompañamiento diario. Apoyarse en ${alta.name} `
      + `(${alta.score}/10) como base de confianza. Revalidar en 7 días con simulación completa.`;
  }

  /** Competencias mínimas cuando el mapper no las entrega. */
  competenciasFallback(data) {
    return [
      { name: 'Rapport', score: this.num(data.score_rapport, 8) },
      { name: 'PNL', score: this.num(data.score_pnl, 8) },
      { name: 'Postura', score: this.num(data.score_postura, 9) },
      { name: 'Objeciones', score: this.num(data.score_objecciones, 7) },
      { name: 'Lectura Sala', score: this.num(data.score_lectura_sala, 9) },
      { name: 'Cierre', score: this.num(data.score_cierre, 8) }
    ];
  }

  /** Texto multilínea -> HTML con <br> (se inyecta con triple stash). */
  formatText(text) {
    if (!text) return '';
    return Handlebars.escapeExpression(String(text))
      .split('\n')
      .filter((l) => l.trim())
      .join('<br>');
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