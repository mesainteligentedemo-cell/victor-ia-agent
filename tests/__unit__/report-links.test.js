/**
 * TESTS — Enlaces firmados de los CTAs (FIX 7)
 *
 * Los CTAs del reporte llevan a endpoints que sirven datos reales de una
 * sesión. La firma es lo único que impide que cualquiera con un
 * conversation_id los lea.
 */

const ENV_ORIGINAL = { ...process.env };

function cargarModulo() {
  jest.resetModules();
  return require('../../src/server/report-links');
}

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

describe('signReportToken / verifyReportToken', () => {
  beforeEach(() => {
    process.env.REPORT_LINK_SECRET = 'secreto_de_enlaces_de_prueba';
  });

  test('un token recién firmado se valida', () => {
    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc');
    expect(token).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(verifyReportToken('conv_abc', token).ok).toBe(true);
  });

  test('el token no sirve para otra conversación', () => {
    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc');
    const r = verifyReportToken('conv_otra', token);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('token_mismatch');
  });

  test('un token caducado se rechaza', () => {
    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc', -10); // ya expirado
    const r = verifyReportToken('conv_abc', token);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('token_expired');
  });

  test('no se puede alargar la caducidad sin el secreto', () => {
    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc');
    const [, hash] = token.split('.');
    const futuro = Math.floor(Date.now() / 1000) + 999999;
    const r = verifyReportToken('conv_abc', `${futuro}.${hash}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('token_mismatch');
  });

  test('tokens ausentes o malformados se rechazan sin lanzar', () => {
    const { verifyReportToken } = cargarModulo();
    for (const t of [null, undefined, '', 'abc', '123', '.', 'x.y', 123]) {
      expect(() => verifyReportToken('conv_abc', t)).not.toThrow();
      expect(verifyReportToken('conv_abc', t).ok).toBe(false);
    }
  });

  test('sin conversation_id se rechaza', () => {
    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc');
    expect(verifyReportToken('', token).ok).toBe(false);
    expect(verifyReportToken(null, token).ok).toBe(false);
  });
});

describe('fail-closed sin secreto en el servidor', () => {
  test('sin ningún secreto no se firma ni se valida', () => {
    delete process.env.REPORT_LINK_SECRET;
    delete process.env.ROTATION_ADMIN_SECRET;
    delete process.env.VTC_SHARED_SECRET;

    const { signReportToken, verifyReportToken } = cargarModulo();
    expect(signReportToken('conv_abc')).toBeNull();

    const r = verifyReportToken('conv_abc', '123.abc');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('server_secret_missing');
  });

  test('cae a ROTATION_ADMIN_SECRET si no hay REPORT_LINK_SECRET', () => {
    delete process.env.REPORT_LINK_SECRET;
    process.env.ROTATION_ADMIN_SECRET = 'admin_secreto_estable';

    const { signReportToken, verifyReportToken } = cargarModulo();
    const token = signReportToken('conv_abc');
    expect(token).not.toBeNull();
    expect(verifyReportToken('conv_abc', token).ok).toBe(true);
  });
});

describe('buildReportLinks', () => {
  beforeEach(() => {
    process.env.REPORT_LINK_SECRET = 'secreto_de_enlaces_de_prueba';
    process.env.PUBLIC_BASE_URL = 'https://victor-ia-agent.vercel.app';
  });

  test('genera los 3 CTAs firmados y sin 404', () => {
    const { buildReportLinks, verifyReportToken } = cargarModulo();
    const links = buildReportLinks('conv_xyz');

    expect(links.pdf_download_url).toMatch(/\/api\/pdf\/conv_xyz\?t=/);
    expect(links.pop_up_url).toMatch(/\/player\?conv=conv_xyz&t=/);
    expect(links.retrain_url).toMatch(/\/retrain\?conv=conv_xyz&t=/);
    expect(verifyReportToken('conv_xyz', links.link_token).ok).toBe(true);
  });

  test('quita la barra final de la base para no generar // en la ruta', () => {
    process.env.PUBLIC_BASE_URL = 'https://victor-ia-agent.vercel.app/';
    const { buildReportLinks } = cargarModulo();
    expect(buildReportLinks('c1').pdf_download_url).not.toMatch(/app\/\/api/);
  });

  test('escapa el conversation_id en la URL', () => {
    const { buildReportLinks } = cargarModulo();
    expect(buildReportLinks('a b/c').pdf_download_url).toMatch(/a%20b%2Fc/);
  });
});

describe('extractRequestToken', () => {
  test('lee el token de la query', () => {
    const { extractRequestToken } = cargarModulo();
    expect(extractRequestToken({ query: { t: 'abc' }, headers: {} })).toBe('abc');
  });

  test('lee el token de Authorization: Bearer', () => {
    const { extractRequestToken } = cargarModulo();
    expect(extractRequestToken({ query: {}, headers: { authorization: 'Bearer xyz' } })).toBe('xyz');
  });

  test('devuelve null cuando no hay token', () => {
    const { extractRequestToken } = cargarModulo();
    expect(extractRequestToken({ query: {}, headers: {} })).toBeNull();
    expect(extractRequestToken(null)).toBeNull();
  });
});