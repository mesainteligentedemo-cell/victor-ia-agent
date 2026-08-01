/**
 * TESTS — Validación HMAC del webhook (FIX 1)
 *
 * Lo que se protege aquí: que `validateHMACSignature` NUNCA vuelva a devolver
 * true sin una firma verificada. La versión anterior devolvía true cuando
 * faltaba la firma o el secreto "para depurar", lo que dejaba el endpoint
 * abierto a cualquiera que conociera la URL.
 */

const crypto = require('crypto');
const { validateHMACSignature } = require('../../src/server/api-process-call');

const SECRET = 'secreto_de_prueba_32_bytes_abcdef';
const BODY = JSON.stringify({ conversation_id: 'conv_123', score_overall: 7 });

/** Firma en el formato nuevo de ElevenLabs: t=<unix>,v0=<hex> */
function firmar(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const hash = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v0=${hash}`;
}

/** Firma en el formato legacy: hash plano sobre el body */
function firmarLegacy(body, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('validateHMACSignature — fail-closed', () => {
  test('1. sin firma → rechaza (antes devolvía true)', () => {
    expect(validateHMACSignature(BODY, null, SECRET)).toBe(false);
    expect(validateHMACSignature(BODY, '', SECRET)).toBe(false);
    expect(validateHMACSignature(BODY, undefined, SECRET)).toBe(false);
  });

  test('2. sin secreto en el servidor → rechaza (antes devolvía true)', () => {
    expect(validateHMACSignature(BODY, firmar(BODY), null)).toBe(false);
    expect(validateHMACSignature(BODY, firmar(BODY), '')).toBe(false);
    expect(validateHMACSignature(BODY, firmar(BODY), undefined)).toBe(false);
  });

  test('3. sin firma NI secreto → rechaza', () => {
    expect(validateHMACSignature(BODY, null, null)).toBe(false);
  });

  test('4. firma válida (formato nuevo t=,v0=) → acepta', () => {
    expect(validateHMACSignature(BODY, firmar(BODY), SECRET)).toBe(true);
  });

  test('5. firma válida (formato legacy, hash plano) → acepta', () => {
    expect(validateHMACSignature(BODY, firmarLegacy(BODY), SECRET)).toBe(true);
  });

  test('6. firma calculada con otro secreto → rechaza', () => {
    const ajena = firmar(BODY, 'otro_secreto_completamente_distinto');
    expect(validateHMACSignature(BODY, ajena, SECRET)).toBe(false);
  });

  test('7. body alterado tras firmar (replay/tampering) → rechaza', () => {
    const signature = firmar(BODY);
    const manipulado = JSON.stringify({ conversation_id: 'conv_123', score_overall: 10 });
    expect(validateHMACSignature(manipulado, signature, SECRET)).toBe(false);
  });

  test('8. mismo hash con otro timestamp → rechaza (el ts entra en el mensaje)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex');
    expect(validateHMACSignature(BODY, `t=${ts + 1},v0=${hash}`, SECRET)).toBe(false);
  });

  test('9. firma malformada → rechaza sin lanzar', () => {
    const basura = ['t=,v0=', 'v0=abc', 'no-es-una-firma', 't=abc,v0=', ',', '=,='];
    for (const s of basura) {
      expect(() => validateHMACSignature(BODY, s, SECRET)).not.toThrow();
      expect(validateHMACSignature(BODY, s, SECRET)).toBe(false);
    }
  });

  test('10. hash de longitud distinta → rechaza sin romper timingSafeEqual', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(() => validateHMACSignature(BODY, `t=${ts},v0=abc`, SECRET)).not.toThrow();
    expect(validateHMACSignature(BODY, `t=${ts},v0=abc`, SECRET)).toBe(false);
  });

  test('11. acepta objeto y lo serializa (compatibilidad con N8N sin raw body)', () => {
    const obj = { conversation_id: 'conv_abc' };
    const raw = JSON.stringify(obj);
    expect(validateHMACSignature(obj, firmar(raw), SECRET)).toBe(true);
  });

  test('12. body vacío con firma correcta → acepta', () => {
    expect(validateHMACSignature('', firmar(''), SECRET)).toBe(true);
  });
});

describe('validateHMACSignature — resistencia a timing attacks', () => {
  test('usa comparación de tiempo constante (no corta en el primer byte)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const bueno = crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex');

    // Difieren en el primer carácter vs en el último: ambos deben rechazarse.
    const primerCharDistinto = (bueno[0] === 'a' ? 'b' : 'a') + bueno.slice(1);
    const ultimoCharDistinto = bueno.slice(0, -1) + (bueno.slice(-1) === 'a' ? 'b' : 'a');

    expect(validateHMACSignature(BODY, `t=${ts},v0=${primerCharDistinto}`, SECRET)).toBe(false);
    expect(validateHMACSignature(BODY, `t=${ts},v0=${ultimoCharDistinto}`, SECRET)).toBe(false);
  });
});