/**
 * EMAIL SENDER — Envía reportes con Resend
 *
 * Características:
 * - HTML inline (reporte completo)
 * - PDF adjunto
 * - MP3 adjunto
 * - Retry logic
 * - Error tracking
 */

const { Resend } = require('resend');

class EmailSender {
  constructor(apiKey) {
    this.resend = new Resend(apiKey);
    this.maxRetries = 3;
  }

  /**
   * Enviar email con adjuntos (PDF + MP3)
   */
  async sendWithAttachments(options) {
    const {
      to,
      from,
      subject,
      htmlBody,
      attachments = []
    } = options;

    // Validar campos requeridos
    if (!to || !from || !subject || !htmlBody) {
      throw new Error('Missing required email fields: to, from, subject, htmlBody');
    }

    // Validar adjuntos
    if (!Array.isArray(attachments)) {
      throw new Error('Attachments must be an array');
    }

    // Preparar adjuntos para Resend
    const preparedAttachments = attachments.map(att => {
      if (!att.filename || !att.content) {
        throw new Error('Each attachment must have filename and content');
      }
      return {
        filename: att.filename,
        content: att.content, // Buffer
        contentType: att.contentType || 'application/octet-stream'
      };
    });

    console.log(`[EMAIL] Preparing email to: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Attachments: ${preparedAttachments.length}`);

    // Retry logic
    let attempt = 0;
    let lastError;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        console.log(`[EMAIL] Attempt ${attempt}/${this.maxRetries}...`);

        const response = await this.resend.emails.send({
          from: from,
          to: to,
          subject: subject,
          html: htmlBody,
          attachments: preparedAttachments
        });

        if (response.error) {
          throw new Error(`Resend error: ${response.error.message}`);
        }

        console.log(`[EMAIL] ✓ Email sent successfully. ID: ${response.data.id}`);

        return {
          success: true,
          messageId: response.data.id,
          timestamp: new Date().toISOString(),
          attempt: attempt
        };

      } catch (error) {
        lastError = error;
        console.error(`[EMAIL] Attempt ${attempt} failed:`, error.message);

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`[EMAIL] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    console.error(`[EMAIL] All ${this.maxRetries} attempts failed`);
    return {
      success: false,
      error: lastError.message,
      attempts: attempt,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Validar dirección de email
   */
  validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get email headers (para logging)
   */
  static getEmailHeaders(options) {
    return {
      from: options.from,
      to: options.to,
      subject: options.subject,
      date: new Date().toISOString(),
      attachmentCount: (options.attachments || []).length,
      bodyLength: options.htmlBody ? options.htmlBody.length : 0
    };
  }
}

/**
 * Export singleton function
 */
async function sendEmailWithAttachments(options) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable not set');
  }

  const sender = new EmailSender(apiKey);

  // Validar emails
  if (!sender.validateEmail(options.to)) {
    throw new Error(`Invalid recipient email: ${options.to}`);
  }
  if (!sender.validateEmail(options.from)) {
    throw new Error(`Invalid sender email: ${options.from}`);
  }

  return sender.sendWithAttachments(options);
}

module.exports = { EmailSender, sendEmailWithAttachments };