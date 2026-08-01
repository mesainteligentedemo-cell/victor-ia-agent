# 🎯 Victor IA Agent v3.0 — Capacitación VTC Elite

**Sistema profesional de reportes de entrenamiento para Victorious Travelers Club**

## 📋 Descripción

Sistema end-to-end que captura llamadas de ElevenLabs Agent Victor, procesa data, genera reportes luxury, y envía por email con PDF + audio adjuntos.

## 🏗️ Arquitectura

```
ElevenLabs Agent Victor
    ↓ (webhook: conversation_id + 25 fields)
N8N Workflow (vic-agent-v3)
    ↓ (HMAC validation)
Vercel API (victor-ia-agent.vercel.app)
    ├─ /api/process-call (12-step pipeline)
    ├─ /api/audio/:convId (streaming MP3)
    ├─ /dashboard (histórico)
    ├─ /player (pop-up reproductor)
    └─ /health
         ↓
         Email (info@victor-ia.com.mx → mesainteligentedemo@gmail.com)
         ├─ HTML reporte (18 secciones + gráficos)
         ├─ PDF adjunto
         └─ MP3 adjunto
```

## 🛠️ Stack Técnico

- **Node.js 20+** — Runtime
- **Next.js 14** — API + Frontend
- **Puppeteer Core + @sparticuz/chromium** — PDF generation
- **pdf-lib** — PDF manipulation
- **Resend** — Email service
- **ApexCharts** — Data visualization
- **ElevenLabs API** — Voice agent integration
- **Supabase** — Database (opcional)

## 📦 Instalación

```bash
# 1. Clonar repo
git clone https://github.com/mesainteligentedemo-cell/victor-ia-agent.git
cd victor-ia-agent

# 2. Instalar dependencias
npm install

# 3. Configurar env vars
cp .env.example .env.local

# 4. Deploy a Vercel
vercel deploy
```

## 🔑 Variables de Entorno Requeridas

```
ELEVENLABS_API_KEY=sk_xxx
ELEVENLABS_AGENT_ID=agent_xxx
VTC_SHARED_SECRET=secret_xxx
RESEND_API_KEY=re_xxx
EMAIL_FROM=info@victor-ia.com.mx
EMAIL_TO_PRIMARY=mesainteligentedemo@gmail.com
PUBLIC_BASE_URL=https://victor-ia-agent.vercel.app
ENVIRONMENT=production
```

## 📊 Flujo de Datos — 12 Pasos

1. ✅ ElevenLabs webhook → N8N (HMAC validation)
2. ✅ N8N → POST /api/process-call
3. ✅ Validate conversation_id
4. ✅ Fetch conversation + transcript + audio
5. ✅ Extract 25 data collection fields
6. ✅ IA analyze transcript + emotional arc
7. ✅ Generate charts data (6+ gráficos)
8. ✅ Merge ElevenLabs + analysis data
9. ✅ Generate HTML reporte (18 secciones)
10. ✅ Generate PDF (puppeteer)
11. ✅ Convert audio MP3
12. ✅ Send email (HTML + PDF + MP3)

## 🎨 Reporte Sections

### Siempre incluidas:
1. Header (VTC luxury)
2. Information Card (datos básicos + hora/fecha)
3. Performance Circle (score 0-10)
4. Metrics Grid (duración, módulo, score %, mejora)
5. Gráficos (6 principales: competencias, timeline, emotional, speech, objeciones, multi-speaker)
6. Neurociencia Section (5 principios + compliance %)
7. 3-Column Analysis (fortalezas, mejora, PNL)
8. Session Activity
9. Action Plan (3 pasos)

### Escalables (mostrar si hay data):
10. Session Timeline & Hitos
11. Engagement & Emotional Journey
12. Speech Analysis & Metrics
13. Objeciones Específicas (1-N objeciones)
14. Trigger Words & Anchors
15. Multi-Speaker Analysis (si hay 2+ speakers)
16. Benchmarking (si disponible)
17. Heatmap de Riesgos
18. Transcripción Chat Bubbles (con speaker detection)
19. Recomendaciones Personalizadas

## 🎤 Reproductor Pop-up

- Ubicación: Link desde PDF o Email
- Función: Escuchar + descargar MP3
- Diseño: Luxury dark (navy #0B1429 + gold #C8A96A)
- Responsive: Mobile-first

## 📧 Email Template

```
FROM:    info@victor-ia.com.mx
TO:      mesainteligentedemo@gmail.com
SUBJECT: Info Capacitación: Reporte de [Nombre] [Fecha] [Hora]

BODY:    HTML reporte (inline)
ATTACH:  PDF + MP3
```

## 🔐 Seguridad

- HMAC signature validation (ElevenLabs → N8N)
- Rate limiting (500 calls/day)
- Encryption at rest (Supabase)
- No secrets in logs

## 📈 Analytics

- Histórico de sesiones en /dashboard
- Comparativas asesor vs. promedio VTC
- Progreso certificación
- Recomendaciones personalizadas

## 🚀 Deployment

```bash
# Vercel (recomendado)
npm run deploy

# Checks post-deploy:
curl https://victor-ia-agent.vercel.app/api/health
```

## 📞 Support

- Docs: `/docs`
- API: `/api/docs` (Swagger)
- Status: `/api/health`

---

**Última actualización:** 31/07/2026  
**Versión:** 3.0.0  
**Status:** 🟢 Production Ready