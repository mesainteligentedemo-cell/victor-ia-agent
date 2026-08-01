/**
 * PDF GENERATOR — Convierte HTML a PDF con Puppeteer
 *
 * Utiliza Puppeteer Core + @sparticuz/chromium para funcionar en Vercel
 * Sin dependencias de Chromium local
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

class PDFGenerator {
  constructor() {
    this.browser = null;
    // Vercel corre sobre Lambda, pero LAMBDA_TASK_ROOT no siempre está expuesto.
    // Sin @sparticuz/chromium, puppeteer-core no tiene binario y falla con
    // "Could not find Chrome". Por eso detectamos varias señales de serverless.
    this.isLambda = !!(
      process.env.LAMBDA_TASK_ROOT ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV
    );
  }

  /**
   * Inicializar Puppeteer
   */
  async initBrowser() {
    // El contenedor Lambda se congela entre invocaciones: el browser cacheado
    // puede estar muerto. Reusar solo si sigue conectado.
    if (this.browser) {
      if (this.browser.connected !== false && this.browser.isConnected?.() !== false) {
        return this.browser;
      }
      console.warn('[PDF] Browser desconectado — relanzando');
      this.browser = null;
    }

    try {
      console.log('[PDF] Initializing Puppeteer...');

      const launchArgs = this.isLambda
        ? {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: true
          }
        : {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          };

      this.browser = await puppeteer.launch(launchArgs);
      console.log('[PDF] Puppeteer initialized');

      return this.browser;
    } catch (error) {
      console.error('[PDF] Failed to initialize Puppeteer:', error.message);
      throw error;
    }
  }

  /**
   * Generar PDF desde HTML
   */
  async generateFromHTML(htmlContent, metadata = {}) {
    const browser = await this.initBrowser();
    let page = null;

    try {
      console.log('[PDF] Creating new page...');
      page = await browser.newPage();

      // Set content. Timeout explícito: si el HTML pide recursos externos
      // (ApexCharts por CDN) 'networkidle2' puede colgarse hasta el límite
      // de la función y matar todo el pipeline.
      await page.setContent(htmlContent, {
        waitUntil: 'networkidle2',
        timeout: 20000
      });

      // PDF options
      const pdfOptions = {
        format: 'A4',
        margin: {
          top: '20px',
          right: '20px',
          bottom: '20px',
          left: '20px'
        },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: this.getHeaderTemplate(metadata),
        footerTemplate: this.getFooterTemplate(metadata),
        timeout: 30000
      };

      console.log('[PDF] Generating PDF...');
      const pdfBuffer = Buffer.from(await page.pdf(pdfOptions));

      console.log(`[PDF] PDF generated: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

      return pdfBuffer;
    } catch (error) {
      console.error('[PDF] Error generating PDF:', error.message);
      throw error;
    } finally {
      // Cerrar siempre la página, incluso si page.pdf() falló (evita fugas
      // de targets en el contenedor reutilizado por Lambda).
      if (page) {
        await page.close().catch((e) => console.warn('[PDF] page.close falló:', e.message));
      }
    }
  }

  /**
   * Template del header
   */
  getHeaderTemplate(metadata) {
    return `
      <div style="font-size: 10px; width: 100%; text-align: center; color: #9A9A9F;">
        VTC ELITE TRAINING v3.0 | Reporte de ${metadata.nombre || 'Entrenamiento'}
      </div>
    `;
  }

  /**
   * Template del footer
   */
  getFooterTemplate(metadata) {
    return `
      <div style="font-size: 10px; width: 100%; text-align: center; color: #9A9A9F; display: flex; justify-content: space-between; padding: 0 20px;">
        <span>${metadata.fecha_sesion || new Date().toLocaleDateString('es-MX')}</span>
        <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>
    `;
  }

  /**
   * Cerrar navegador
   */
  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[PDF] Browser closed');
    }
  }
}

/**
 * Singleton instance
 */
let pdfGenerator = null;

async function generatePDF(htmlContent, metadata = {}) {
  if (!pdfGenerator) {
    pdfGenerator = new PDFGenerator();
  }

  try {
    const pdfBuffer = await pdfGenerator.generateFromHTML(htmlContent, metadata);
    return pdfBuffer;
  } catch (error) {
    console.error('[PDF] Fatal error:', error.message);
    throw error;
  }
}

/**
 * Cleanup on exit
 *
 * NOTA: 'exit' es síncrono — un handler async nunca llega a completarse y
 * además puede provocar un assert de libuv al salir. Cerramos el browser
 * en las señales de terminación (donde sí se puede esperar) y, en 'exit',
 * solo matamos el proceso hijo de forma síncrona.
 */
function shutdown(signal) {
  if (!pdfGenerator) process.exit(0);
  pdfGenerator
    .closeBrowser()
    .catch((e) => console.warn('[PDF] closeBrowser falló:', e.message))
    .finally(() => process.exit(0));
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

process.on('exit', () => {
  const proc = pdfGenerator && pdfGenerator.browser && pdfGenerator.browser.process();
  if (proc) proc.kill('SIGKILL');
});

module.exports = { PDFGenerator, generatePDF };