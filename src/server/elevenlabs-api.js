/**
 * ELEVENLABS API CLIENT
 *
 * Wrapper sobre la API ConvAI de ElevenLabs.
 * - getConversation(id) -> objeto conversación completo
 * - getTranscript(id)   -> transcript normalizado a texto plano
 * - getAudio(id)        -> Buffer con el audio (mp3) de la conversación
 *
 * Todos los métodos manejan errores explícitamente y loguean con prefijo [ELEVENLABS].
 */

const axios = require('axios');

class ElevenLabsAPI {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('ElevenLabsAPI: missing API key (set ELEVENLABS_API_KEY)');
    }

    this.apiKey = apiKey;
    this.baseUrl = 'https://api.elevenlabs.io/v1';
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 60000,
      headers: {
        'xi-api-key': this.apiKey,
        Accept: 'application/json'
      }
    });
  }

  /**
   * Obtener conversación completa
   * @param {string} conversationId
   * @returns {Promise<object>}
   */
  async getConversation(conversationId) {
    if (!conversationId) {
      throw new Error('ElevenLabsAPI.getConversation: conversationId is required');
    }

    try {
      console.log(`[ELEVENLABS] GET /convai/conversations/${conversationId}`);
      const response = await this.client.get(`/convai/conversations/${conversationId}`);
      return response.data;
    } catch (error) {
      const detail = error.response
        ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data || {}).slice(0, 300)}`
        : error.message;
      console.error(`[ELEVENLABS] Error fetching conversation ${conversationId}: ${detail}`);
      throw new Error(`ElevenLabs getConversation failed: ${detail}`);
    }
  }

  /**
   * Obtener transcript como texto plano ("Speaker: texto" por línea)
   * Nunca lanza: devuelve '' si falla, para que el pipeline decida.
   * @param {string} conversationId
   * @returns {Promise<string>}
   */
  async getTranscript(conversationId) {
    try {
      const conv = await this.getConversation(conversationId);
      return ElevenLabsAPI.normalizeTranscript(conv);
    } catch (error) {
      console.error(`[ELEVENLABS] Error fetching transcript: ${error.message}`);
      return '';
    }
  }

  /**
   * Obtener audio de la conversación (mp3)
   * Nunca lanza: devuelve null si falla, para que el pipeline decida.
   * @param {string} conversationId
   * @returns {Promise<Buffer|null>}
   */
  async getAudio(conversationId) {
    if (!conversationId) {
      console.error('[ELEVENLABS] getAudio: conversationId is required');
      return null;
    }

    try {
      console.log(`[ELEVENLABS] GET /convai/conversations/${conversationId}/audio`);
      const response = await this.client.get(
        `/convai/conversations/${conversationId}/audio`,
        { responseType: 'arraybuffer', headers: { Accept: 'audio/mpeg' } }
      );

      const buffer = Buffer.from(response.data);
      if (!buffer.length) {
        console.warn('[ELEVENLABS] getAudio returned empty payload');
        return null;
      }

      console.log(`[ELEVENLABS] Audio fetched: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
      return buffer;
    } catch (error) {
      const detail = error.response ? `HTTP ${error.response.status}` : error.message;
      console.error(`[ELEVENLABS] Error fetching audio: ${detail}`);
      return null;
    }
  }

  /**
   * Normaliza el transcript de ElevenLabs a texto plano.
   * Soporta: string, array de turnos {role,message}, {transcript}, {messages}.
   * @param {object|string} conv
   * @returns {string}
   */
  static normalizeTranscript(conv) {
    if (!conv) return '';
    if (typeof conv === 'string') return conv;

    const raw = conv.transcript || conv.messages || conv.turns || '';

    if (typeof raw === 'string') return raw;

    if (Array.isArray(raw)) {
      return raw
        .map((turn) => {
          if (typeof turn === 'string') return turn;
          const speaker = turn.role || turn.speaker || turn.source || 'agent';
          const text = turn.message || turn.text || turn.content || '';
          if (!text) return '';
          return `${speaker}: ${text}`;
        })
        .filter(Boolean)
        .join('\n');
    }

    return '';
  }
}

module.exports = ElevenLabsAPI;
module.exports.ElevenLabsAPI = ElevenLabsAPI;