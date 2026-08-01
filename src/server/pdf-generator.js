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

/**
 * Presupuesto de tiempo del render.
 *
 * La lambda muere a los 60s y el PDF es solo UNO de los 14 pasos. Con
 * setContent=20s + fuentes=6s + pdf=45s el paso solo ya se comía 71s.
 * Estos techos dejan el render en ~32s en el peor caso.
 */
const SET_CONTENT_TIMEOUT_MS = 10000;
const FONTS_TIMEOUT_MS = 2500;
const PDF_RENDER_TIMEOUT_MS = 20000;

/** Intentos totales de lanzamiento (1 inicial + 2 reintentos). */
const MAX_LAUNCH_ATTEMPTS = 3;
/** Espera entre reintentos: da tiempo a que el fd del binario se libere. */
const RETRY_DELAY_MS = 500;
/** Techo para el health-check del browser cacheado. */
const HEALTHCHECK_TIMEOUT_MS = 2000;
/** Techo para el close() "amable" antes de rendirnos y matar el proceso. */
const CLOSE_TIMEOUT_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Corre una promesa con techo de tiempo y LIMPIA el temporizador al terminar.
 * (Un `Promise.race` con setTimeout suelto deja timers colgando en cada
 * invocación, y en Lambda eso retrasa el freeze del contenedor.)
 */
function withTimeout(promise, ms, etiqueta) {
  let timer = null;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${etiqueta} timeout tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * ¿El fallo es transitorio (vale la pena reintentar) o permanente?
 *
 * ETXTBSY = "text file busy": otro proceso tiene el binario de Chromium abierto
 * para escritura. Pasa cuando el contenedor Lambda se reutiliza y dos
 * invocaciones concurrentes extraen/ejecutan @sparticuz/chromium a la vez.
 * Es transitorio por definición: al liberarse el fd, el siguiente intento pasa.
 *
 * ENOENT (binario inexistente) NO entra aquí: reintentar no lo va a materializar.
 */
function isRetryableBrowserError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'ETXTBSY' || code === 'EBUSY' || code === 'EAGAIN' || code === 'EACCES') {
    return true;
  }
  const msg = String(error.message || '');
  return /ETXTBSY|EBUSY|EAGAIN|spawn\s+\S+\s+ETXTBSY|Failed to launch the browser process|Target closed|Protocol error|Session closed|Connection closed|socket hang up|browser (?:has been )?(?:closed|disconnected)|Navigating frame was detached/i.test(
    msg
  );
}

/** Resumen de un error para logs de Lambda (una línea, sin stack gigante). */
function describeError(error) {
  if (!error) return 'error desconocido';
  const code = error.code ? `[${error.code}] ` : '';
  const syscall = error.syscall ? `(${error.syscall}${error.path ? ' ' + error.path : ''}) ` : '';
  return `${code}${syscall}${error.message || error}`;
}

class PDFGenerator {
  constructor() {
    this.browser = null;
    // Guard de concurrencia: si dos invocaciones caen en el MISMO contenedor
    // Lambda a la vez, ambas lanzarían Chromium en paralelo y una encontraría
    // el binario ocupado (ETXTBSY). Compartimos el lanzamiento en vuelo.
    this.launchPromise = null;
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
   * ¿El browser cacheado está REALMENTE vivo?
   *
   * `browser.connected` puede decir true con el proceso ya muerto (el flag solo
   * refleja el estado del transporte, y en Lambda el contenedor se congela sin
   * emitir el evento de desconexión). Por eso además de los flags:
   *   1. Verificamos que el proceso hijo no haya salido.
   *   2. Hacemos una llamada real al protocolo CDP (`version()`) con timeout.
   * Si algo falla o se cuelga → lo damos por muerto.
   */
  async isBrowserAlive() {
    const browser = this.browser;
    if (!browser) return false;

    try {
      if (browser.connected === false) return false;
      if (typeof browser.isConnected === 'function' && browser.isConnected() === false) {
        return false;
      }

      // Proceso zombie / ya terminado: los flags no siempre se enteran.
      const proc = typeof browser.process === 'function' ? browser.process() : null;
      if (proc && (proc.killed || proc.exitCode !== null || proc.signalCode !== null)) {
        console.warn(
          `[PDF] Proceso de Chromium terminado (pid=${proc.pid} exit=${proc.exitCode} signal=${proc.signalCode})`
        );
        return false;
      }

      // Ping real al protocolo: la única prueba de que responde.
      const pong = await withTimeout(browser.version(), HEALTHCHECK_TIMEOUT_MS, 'health-check');
      return !!pong;
    } catch (error) {
      console.warn(`[PDF] Health-check del browser falló: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Limpieza AGRESIVA: no esperamos a un cierre elegante.
   *
   * Un browser en estado inestable es peor que ninguno: mantiene el binario de
   * Chromium abierto y provoca el siguiente ETXTBSY. Matamos el proceso hijo con
   * SIGKILL y soltamos la referencia pase lo que pase.
   */
  async destroyBrowser(motivo = 'limpieza') {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;

    console.warn(`[PDF] Destruyendo browser (motivo: ${motivo})`);

    let proc = null;
    try {
      proc = typeof browser.process === 'function' ? browser.process() : null;
    } catch (_) { /* sin proceso accesible */ }

    // close() con techo de tiempo: si no cierra rápido, no lo esperamos.
    try {
      await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'browser.close');
      console.log('[PDF] Browser cerrado');
    } catch (error) {
      console.warn(`[PDF] close() no completó (${describeError(error)}) — matando proceso`);
    }

    // SIGKILL incondicional: si ya murió, es un no-op silencioso.
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
        console.warn(`[PDF] SIGKILL enviado a Chromium (pid=${proc.pid})`);
      } catch (error) {
        console.warn(`[PDF] SIGKILL falló: ${describeError(error)}`);
      }
    }
  }

  /** Construye las opciones de launch según el entorno. */
  async buildLaunchOptions() {
    if (this.isLambda) {
      const executablePath = await chromium.executablePath();
      return {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: true
      };
    }

    return {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      // puppeteer-core no trae binario propio. Fuera de Lambda hay que
      // apuntarle a un Chrome instalado o `launch()` falla de inmediato.
      executablePath: resolveLocalChrome()
    };
  }

  /**
   * Lanza Chromium con reintentos.
   *
   * ETXTBSY es transitorio: otro proceso del mismo contenedor tiene el binario
   * abierto. Esperamos y reintentamos en vez de tumbar la petición.
   */
  async launchWithRetries() {
    let lastError = null;

    for (let intento = 1; intento <= MAX_LAUNCH_ATTEMPTS; intento++) {
      try {
        console.log(`[PDF] Lanzando Chromium (intento ${intento}/${MAX_LAUNCH_ATTEMPTS})...`);
        const opciones = await this.buildLaunchOptions();
        const browser = await puppeteer.launch(opciones);

        if (intento > 1) {
          console.log(`[PDF] ✅ Reintento EXITOSO en el intento ${intento}/${MAX_LAUNCH_ATTEMPTS}`);
        }
        console.log('[PDF] Puppeteer initialized');
        return browser;
      } catch (error) {
        lastError = error;
        console.error(
          `[PDF] ❌ Intento ${intento}/${MAX_LAUNCH_ATTEMPTS} falló: ${describeError(error)}`
        );

        // Un launch a medias puede dejar un proceso colgado con el binario abierto.
        await this.destroyBrowser(`launch fallido intento ${intento}`);

        if (!isRetryableBrowserError(error)) {
          console.error('[PDF] Error NO recuperable — no se reintenta');
          break;
        }
        if (intento < MAX_LAUNCH_ATTEMPTS) {
          console.warn(`[PDF] Error transitorio — reintentando en ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    const detalle = describeError(lastError);
    console.error(
      `[PDF] 💀 Chromium no arrancó tras ${MAX_LAUNCH_ATTEMPTS} intentos. Último error: ${detalle}`
    );
    const fatal = new Error(
      `No se pudo lanzar Chromium tras ${MAX_LAUNCH_ATTEMPTS} intentos (entorno: ${
        this.isLambda ? 'lambda/vercel' : 'local'
      }). Último error: ${detalle}`
    );
    fatal.cause = lastError;
    if (lastError && lastError.code) fatal.code = lastError.code;
    // Marca para que el bucle de generateFromHTML NO vuelva a reintentar:
    // aquí ya agotamos los reintentos de lanzamiento.
    fatal.launchExhausted = true;
    throw fatal;
  }

  /**
   * Inicializar Puppeteer
   *
   * @param {boolean} force Descarta el browser cacheado sin preguntar.
   */
  async initBrowser(force = false) {
    // El contenedor Lambda se congela entre invocaciones: el browser cacheado
    // puede estar muerto aunque los flags digan lo contrario.
    if (this.browser) {
      if (!force && (await this.isBrowserAlive())) {
        return this.browser;
      }
      await this.destroyBrowser(force ? 'relanzamiento forzado' : 'browser muerto o no responde');
    }

    // Si ya hay un lanzamiento en vuelo, nos colgamos de él en vez de abrir
    // un segundo Chromium sobre el mismo binario (causa directa de ETXTBSY).
    if (this.launchPromise) {
      console.log('[PDF] Lanzamiento ya en curso — esperando al existente');
      return this.launchPromise;
    }

    this.launchPromise = this.launchWithRetries()
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.launchPromise = null;
      });

    return this.launchPromise;
  }

  /**
   * Generar PDF desde HTML
   *
   * Reintenta con un browser NUEVO si el fallo es transitorio (ETXTBSY, target
   * cerrado, browser desconectado a media faena). Los errores de contenido no
   * se reintentan: fallarían igual.
   */
  async generateFromHTML(htmlContent, metadata = {}) {
    let lastError = null;

    for (let intento = 1; intento <= MAX_LAUNCH_ATTEMPTS; intento++) {
      try {
        // A partir del 2º intento forzamos browser limpio: el anterior quedó sucio.
        const browser = await this.initBrowser(intento > 1);
        const pdfBuffer = await this.renderPDF(browser, htmlContent, metadata);

        if (intento > 1) {
          console.log(`[PDF] ✅ PDF generado tras reintento (intento ${intento})`);
        }
        return pdfBuffer;
      } catch (error) {
        lastError = error;
        console.error(
          `[PDF] Error generando PDF (intento ${intento}/${MAX_LAUNCH_ATTEMPTS}): ${describeError(error)}`
        );

        // El lanzamiento ya agotó SUS reintentos: repetirlos aquí solo suma
        // latencia (3x3 = 9 arranques) antes del mismo fallo.
        if (error && error.launchExhausted) {
          console.error('[PDF] Reintentos de lanzamiento agotados — se propaga');
          throw error;
        }

        if (!isRetryableBrowserError(error)) {
          console.error('[PDF] Error NO recuperable — se propaga sin reintentar');
          throw error;
        }

        // Browser comprometido: fuera. El siguiente intento arranca uno nuevo.
        await this.destroyBrowser(`render fallido intento ${intento}`);

        if (intento < MAX_LAUNCH_ATTEMPTS) {
          console.warn(`[PDF] Reintentando render en ${RETRY_DELAY_MS}ms con browser nuevo...`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    console.error(`[PDF] 💀 PDF no generado tras ${MAX_LAUNCH_ATTEMPTS} intentos`);
    throw lastError;
  }

  /**
   * Render de una sola pasada: página → contenido → PDF.
   * Separado de generateFromHTML para que el bucle de reintentos quede legible.
   */
  async renderPDF(browser, htmlContent, metadata) {
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
        timeout: SET_CONTENT_TIMEOUT_MS
      });

      // Damos a las fuentes web una ventana corta y seguimos pase lo que pase.
      await this.waitForFonts(page, FONTS_TIMEOUT_MS);

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
        timeout: PDF_RENDER_TIMEOUT_MS
      };

      console.log('[PDF] Generating PDF...');
      const pdfBuffer = Buffer.from(await page.pdf(pdfOptions));

      console.log(`[PDF] PDF generated: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

      return pdfBuffer;
    } finally {
      // Cerrar siempre la página, incluso si page.pdf() falló (evita fugas
      // de targets en el contenedor reutilizado por Lambda). Con techo de
      // tiempo: si el browser ya murió, close() se queda colgado para siempre.
      if (page) {
        await withTimeout(page.close(), CLOSE_TIMEOUT_MS, 'page.close').catch((e) =>
          console.warn(`[PDF] page.close falló: ${describeError(e)}`)
        );
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
   * Cerrar navegador.
   * Delega en destroyBrowser: cierre con techo de tiempo + SIGKILL de respaldo,
   * para no dejar nunca el binario de Chromium tomado (origen del ETXTBSY).
   */
  async closeBrowser() {
    await this.destroyBrowser('cierre solicitado');
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
  try {
    const browser = pdfGenerator && pdfGenerator.browser;
    const proc = browser && typeof browser.process === 'function' ? browser.process() : null;
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  } catch (_) { /* saliendo igual: nada que hacer */ }
});

module.exports = { PDFGenerator, generatePDF };