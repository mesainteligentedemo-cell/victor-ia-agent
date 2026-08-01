/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  // API Routes
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
    responseLimit: '50mb',
  },

  // Build
  build: {
    // Crear estructura de build
  },

  // Environment
  env: {
    NEXT_PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'https://victor-ia-agent.vercel.app',
  },

  // Vercel specific
  productionBrowserSourceMaps: false,
};

module.exports = nextConfig;