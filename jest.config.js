/**
 * Configuración de Jest.
 *
 * Solo tests unitarios de la capa de servidor: son los que pueden correr sin
 * red, sin Chromium y sin claves reales. El pipeline completo se valida contra
 * el despliegue, no aquí.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/server/**/*.js',
    '!src/server/pdf-generator.js', // requiere Chromium
    '!src/server/rag-query.js'      // requiere el snapshot de KB
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
  testTimeout: 10000,
  // Silencia el ruido de consola del código bajo prueba sin ocultar los fallos.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};