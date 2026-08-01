/**
 * REPORT GENERATOR — Renderiza HTML del reporte
 *
 * Entrada: datos completos del reporte
 * Salida: HTML renderizado (listo para email + PDF)
 */

const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

class ReportGenerator {
  constructor() {
    // En Lambda, __dirname no funciona. Usar process.cwd() + ruta relativa.
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
    console.log('[REPORT] Generating report for:', data.nombre);

    try {
      // Preparar datos
      const reportData = this.prepareData(data);

      // Renderizar
      const html = this.template(reportData);

      // Inyectar scripts de gráficos
      const finalHTML = this.injectChartsScripts(html, reportData.charts);

      return finalHTML;
    } catch (error) {
      console.error('[REPORT] Error generating report:', error.message);
      throw error;
    }
  }

  /**
   * Preparar datos para renderizado
   */
  prepareData(data) {
    return {
      // Información básica
      nombre: data.nombre || 'N/A',
      empleado_id: data.empleado_id || 'N/A',
      puesto: data.puesto || 'N/A',
      modulo: data.modulo || 'N/A',
      familia_nombre: data.familia_nombre || 'N/A',
      idioma: data.idioma || 'Español',

      // Fecha y hora
      fecha_sesion: data.fecha_sesion || new Date().toLocaleDateString('es-MX'),
      hora_sesion: data.hora_sesion || new Date().toLocaleTimeString('es-MX'),
      duracion_texto: data.duracion_texto || '00:00',
      duracion_minutos: data.duracion_minutos || 0,

      // Scores
      score_rapport: data.score_rapport || 8,
      score_pnl: data.score_pnl || 8,
      score_postura: data.score_postura || 9,
      score_objecciones: data.score_objecciones || 7,
      score_lectura_sala: data.score_lectura_sala || 9,
      score_cierre: data.score_cierre || 8,
      score_overall: data.score_overall || 8,
      scoreTotal: data.scoreTotal || 80,
      mejora_potencial: data.mejora_potencial || '20%',

      // Resumen y análisis
      resumen: data.resumen || 'Sesión de entrenamiento completada',
      fortalezas: this.formatText(data.fortalezas),
      areas_mejora: this.formatText(data.areas_mejora),
      analisis_pnl: data.analisis_pnl || 'N/A',
      objeciones_trabajadas: data.objeciones_trabajadas || 'N/A',
      actividad_sesion: data.actividad_sesion || 'Sesión completada',

      // Neurociencia
      principios_neuro: data.principios_neuro || [],
      cumplimiento_neuro: data.cumplimiento_neuro || 85,

      // Plan de acción
      plan_1: data.plan_1 || 'Diagnóstico completado',
      plan_2: data.plan_2 || 'Plan de mejora establecido',
      plan_3: data.plan_3 || 'Validación en 7 días',

      // Transcripción
      transcription: data.transcription || [],

      // URLs (CTAs)
      pop_up_url: data.pop_up_url || '#',
      pdf_download_url: data.pdf_download_url || '#',
      retrain_url: data.retrain_url || '#',

      // Competencias
      competencias: data.competencias || [],

      // Charts (para inyectar en scripts)
      charts: data.charts || {}
    };
  }

  /**
   * Inyectar scripts de gráficos
   */
  injectChartsScripts(html, chartsData) {
    const chartScripts = `
    <script>
      // ApexCharts initialization
      const options = {
        chart: { type: 'bar', toolbar: { show: false } },
        colors: ['#C8A96A', '#4CAF50', '#0066CC'],
        theme: { mode: 'dark' }
      };

      // Competencias Chart
      if (document.getElementById('competenciasChart')) {
        new ApexCharts(document.getElementById('competenciasChart'), {
          ...options,
          series: [{
            name: 'Score',
            data: ${JSON.stringify(chartsData.competencias?.values || [])}
          }],
          xaxis: { categories: ${JSON.stringify(chartsData.competencias?.categories || [])} }
        }).render();
      }

      // Timeline Chart
      if (document.getElementById('timelineChart')) {
        new ApexCharts(document.getElementById('timelineChart'), {
          ...options,
          chart: { type: 'line' },
          series: [{
            name: 'Score',
            data: ${JSON.stringify(chartsData.timeline?.points || [])}
          }],
          xaxis: { categories: ${JSON.stringify(chartsData.timeline?.labels || [])} }
        }).render();
      }

      // Emotional Chart
      if (document.getElementById('emotionalChart')) {
        new ApexCharts(document.getElementById('emotionalChart'), {
          ...options,
          chart: { type: 'area' },
          series: [{
            name: 'Engagement',
            data: ${JSON.stringify(chartsData.emotional?.points || [])}
          }]
        }).render();
      }

      // Speech Chart
      if (document.getElementById('speechChart')) {
        new ApexCharts(document.getElementById('speechChart'), {
          ...options,
          chart: { type: 'pie' },
          series: [${chartsData.speech?.victor || 65}, ${chartsData.speech?.usuario || 30}, ${chartsData.speech?.otros || 5}],
          labels: ['Victor', 'Usuario', 'Otros']
        }).render();
      }

      // Objeciones Chart (placeholder)
      if (document.getElementById('objecionesChart')) {
        new ApexCharts(document.getElementById('objecionesChart'), {
          ...options,
          chart: { type: 'donut' },
          series: [70, 30],
          labels: ['Manejadas', 'Pendientes']
        }).render();
      }

      // Multi-Speaker Chart
      if (document.getElementById('multiSpeakerChart')) {
        new ApexCharts(document.getElementById('multiSpeakerChart'), {
          ...options,
          chart: { type: 'radar' },
          series: [{
            name: 'Victor',
            data: [90, 85, 88, 90, 87]
          }],
          xaxis: { categories: ['Rapport', 'PNL', 'Postura', 'Cierre', 'Lectura'] }
        }).render();
      }
    </script>
    `;

    return html.replace('</body>', chartScripts + '</body>');
  }

  /**
   * Formatear texto multilinea
   */
  formatText(text) {
    if (!text) return '';
    return text.split('\n').filter(l => l.trim()).join('<br>');
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