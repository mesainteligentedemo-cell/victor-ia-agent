/**
 * Health Check Endpoint
 * GET /api/health
 */
export default function handler(req, res) {
  return res.status(200).json({
    status: 'ok',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.ENVIRONMENT || 'development'
  });
}