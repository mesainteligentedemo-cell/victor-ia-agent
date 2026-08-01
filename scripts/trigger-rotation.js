#!/usr/bin/env node
/**
 * TRIGGER ROTATION — Dispara manualmente POST /api/rotate-keys
 *
 * Firma la petición igual que lo hace el workflow de N8N, por lo que también
 * sirve de referencia para reproducir la firma en cualquier otro cliente.
 *
 * Uso:
 *   ROTATION_ADMIN_SECRET=xxx node scripts/trigger-rotation.js [--dry-run] [--url ...]
 *
 * Flags:
 *   --dry-run        No ejecuta efectos secundarios (ni Resend ni Vercel)
 *   --no-resend      No rota la key de Resend
 *   --no-vercel      No propaga env vars a Vercel
 *   --no-redeploy    No dispara redeploy
 *   --return-values  Devuelve los valores nuevos (para propagarlos desde N8N)
 *   --url <base>     Base URL (default: https://victor-ia-agent.vercel.app)
 */

const crypto = require('crypto');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = val('--url', process.env.PUBLIC_BASE_URL || 'https://victor-ia-agent.vercel.app');
const SECRET = process.env.ROTATION_ADMIN_SECRET || process.env.VTC_SHARED_SECRET;

if (!SECRET) {
  console.error('ERROR: define ROTATION_ADMIN_SECRET (o VTC_SHARED_SECRET) en el entorno.');
  process.exit(1);
}

const payload = {
  triggered_by: process.env.TRIGGERED_BY || 'manual-cli',
  dry_run: has('--dry-run'),
  rotate_resend: !has('--no-resend'),
  push_to_vercel: !has('--no-vercel'),
  redeploy: !has('--no-redeploy'),
  return_values: has('--return-values')
};

const rawBody = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');

(async () => {
  const url = `${BASE.replace(/\/+$/, '')}/api/rotate-keys`;
  console.log(`POST ${url}`);
  console.log(`payload: ${rawBody}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rotation-Signature': `t=${ts},v0=${sig}`
    },
    body: rawBody
  });

  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
  process.exit(res.ok ? 0 : 1);
})().catch((e) => {
  console.error('FALLO:', e.message);
  process.exit(1);
});