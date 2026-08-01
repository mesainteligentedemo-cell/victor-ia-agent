/**
 * PDF GENERATOR — Convierte HTML a PDF con Puppeteer
 *
 * Utiliza Puppeteer Core + @sparticuz/chromium para funcionar en Vercel
 * Sin dependencias de Chromium local
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

/**
 * Localiza un Chrome/Edge instalado para desarrollo local.
 * En Vercel esto no se usa: ahí manda @sparticuz/chromium.
 *
 * @returns {string|undefined} Ruta al ejecutable, o undefined para dejar que
 *                             puppeteer-core lance su propio error descriptivo.
 */
function resolveLocalChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;

  const fs = require('fs');
  const candidatos = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const ruta of candidatos) {
    try {
      if (fs.existsSync(ruta)) return ruta;
    } catch (_) { /* ruta inaccesible: seguimos */ }
  }

  console.warn('[PDF] No se encontró Chrome local. Define PUPPETEER_EXECUTABLE_PATH.');
  return undefined;
}

/** Escapa texto que se inyecta en las plantillas de header/footer de Chromium. */
function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            // puppeteer-core no trae binario propio. Fuera de Lambda hay que
            // apuntarle a un Chrome instalado o `launch()` falla de inmediato.
            executablePath: resolveLocalChrome()
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

      // El reporte es autocontenido (CSS inline + gráficos SVG). El único
      // recurso externo son las Google Fonts, y son opcionales: hay pila de
      // fallback en el CSS. Por eso NO esperamos 'networkidle2' — si la red
      // de Lambda se atasca, el PDF debe salir igual.
      await page.setContent(htmlContent, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      // Damos a las fuentes web una ventana corta y seguimos pase lo que pase.
      await this.waitForFonts(page, 6000);

      // PDF options
      const pdfOptions = {
        format: 'A4',
        margin: {
          top: '16mm',
          right: '0mm',
          bottom: '16mm',
          left: '0mm'
        },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: this.getHeaderTemplate(metadata),
        footerTemplate: this.getFooterTemplate(metadata),
        timeout: 45000
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
   * Espera a que las fuentes web carguen, con techo de tiempo.
   * Nunca lanza: una fuente que no llega degrada al fallback del CSS.
   */
  async waitForFonts(page, maxMs) {
    try {
      await Promise.race([
        page.evaluate(() => document.fonts && document.fonts.ready),
        new Promise((resolve) => setTimeout(resolve, maxMs))
      ]);
    } catch (error) {
      console.warn('[PDF] document.fonts.ready no disponible:', error.message);
    }
  }

  /**
   * Template del header
   */
  getHeaderTemplate(metadata) {
    return `
      <div style="font-size:8px;width:100%;padding:0 16mm;color:#8FA0B2;
                  font-family:'Segoe UI',Helvetica,Arial,sans-serif;
                  display:flex;justify-content:space-between;align-items:center;">
        <span style="letter-spacing:1.5px;text-transform:uppercase;color:#d4af37;">VTC Elite Training</span>
        <span>${escapeAttr(metadata.nombre || 'Entrenamiento')} · ${escapeAttr(metadata.modulo || '')}</span>
      </div>
    `;
  }

  /**
   * Template del footer
   */
  getFooterTemplate(metadata) {
    const fecha = escapeAttr(metadata.fecha_sesion || new Date().toLocaleDateString('es-MX'));
    const hora = escapeAttr(metadata.hora_cancun || '');
    return `
      <div style="font-size:8px;width:100%;padding:0 16mm;color:#8FA0B2;
                  font-family:'Segoe UI',Helvetica,Arial,sans-serif;
                  display:flex;justify-content:space-between;align-items:center;">
        <span>${fecha}${hora ? ' · ' + hora : ''} · victor-ia.xyz</span>
        <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
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