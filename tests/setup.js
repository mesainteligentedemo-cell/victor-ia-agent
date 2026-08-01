/**
 * Setup común de los tests.
 *
 * El código de servidor loguea mucho a propósito (es lo que se lee en Vercel
 * cuando algo falla en producción). En los tests ese ruido tapa los asserts.
 *
 * Se silencia también console.error: buena parte de la suite comprueba
 * justamente los caminos de rechazo (HMAC inválido, token caducado), que
 * loguean error POR DISEÑO. Para verlo todo: TEST_VERBOSE=1 npm test
 */

const silenciar = ['log', 'info', 'warn', 'error'];
const originales = {};

beforeAll(() => {
  if (process.env.TEST_VERBOSE === '1') return;
  for (const nivel of silenciar) {
    originales[nivel] = console[nivel];
    console[nivel] = () => {};
  }
});

afterAll(() => {
  for (const [nivel, fn] of Object.entries(originales)) {
    console[nivel] = fn;
  }
});