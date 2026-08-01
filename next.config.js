/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  // Environment expuesto al cliente
  env: {
    NEXT_PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'https://victor-ia-agent.vercel.app',
  },

  // Puppeteer/Chromium son binarios pesados: no empaquetarlos con el bundler.
  // NOTA: la config de bodyParser vive en cada API route (`export const config`),
  // no aquí — `api` no es una clave válida de next.config.js.
  experimental: {
    serverComponentsExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],

    // El template Handlebars se lee en runtime con fs.readFileSync.
    // Sin esto, Vercel puede no incluirlo en el bundle de la lambda.
    outputFileTracingIncludes: {
      '/api/process-call': ['./src/templates/**'],
    },
  },

  productionBrowserSourceMaps: false,
};

module.exports = nextConfig;