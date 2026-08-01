# 🚀 SETUP GUIDE — Victor IA Agent v3.0

**Sistema profesional de reportes de entrenamiento VTC Elite**

---

## 📋 Tabla de Contenidos

1. [Requisitos](#requisitos)
2. [Instalación Local](#instalación-local)
3. [Configuración de Credenciales](#configuración-de-credenciales)
4. [Setup ElevenLabs](#setup-elevenlabs)
5. [Setup N8N](#setup-n8n)
6. [Deploy a Vercel](#deploy-a-vercel)
7. [Testing](#testing)
8. [Troubleshooting](#troubleshooting)

---

## Requisitos

- **Node.js** 20+ ([descargar](https://nodejs.org))
- **npm** 10+
- **Git** ([descargar](https://git-scm.com))
- **Cuenta Vercel** ([crear](https://vercel.com))
- **Cuenta N8N** ([crear](https://n8n.io))
- **Credenciales:**
  - ElevenLabs API Key
  - Resend API Key (o Gmail SMTP)
  - VTC Shared Secret (HMAC)

---

## Instalación Local

### 1️⃣ Clonar repositorio

```bash
git clone https://github.com/mesainteligentedemo-cell/victor-ia-agent.git
cd victor-ia-agent
```

### 2️⃣ Instalar dependencias

```bash
npm install
```

### 3️⃣ Configurar variables de entorno

```bash
cp .env.example .env.local
```

**Editar `.env.local` con tus credenciales:**

```bash
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxx
ELEVENLABS_AGENT_ID=agent_5701kr0h5gg6eetb69tv6c5hwfj1
VTC_SHARED_SECRET=tu_hmac_secret_aqui
RESEND_API_KEY=re_xxxxxxxxxxxxx
EMAIL_FROM=info@victor-ia.com.mx
EMAIL_TO_PRIMARY=mesainteligentedemo@gmail.com
PUBLIC_BASE_URL=http://localhost:3000
ENVIRONMENT=development
```

### 4️⃣ Iniciar servidor local

```bash
npm run dev
```

**Salida esperada:**
```
> next dev
ready - started server on 0.0.0.0:3000, url: http://localhost:3000
```

---

## Configuración de Credenciales

### ElevenLabs API Key

1. Ir a https://elevenlabs.io
2. Login → Settings → API Key
3. Copiar API key (empieza con `sk_`)
4. Guardar en `.env.local`:
   ```
   ELEVENLABS_API_KEY=sk_tu_key
   ```

### Resend API Key

1. Ir a https://resend.com
2. Crear cuenta → Dashboard → Crear API key
3. Copiar key
4. Guardar en `.env.local`:
   ```
   RESEND_API_KEY=re_tu_key
   ```

### VTC Shared Secret (HMAC)

Generar una cadena aleatoria de 32 caracteres:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Usar en `.env.local`:
```
VTC_SHARED_SECRET=tu_codigo_aleatorio_aqui
```

**Usar el MISMO secret en N8N** (paso siguiente).

---

## Setup ElevenLabs

### Verificar Agent Victor

1. Ir a https://elevenlabs.io → Agents
2. Buscar "Victor" (Agent ID: `agent_5701kr0h5gg6eetb69tv6c5hwfj1`)
3. Verificar que esté configurado con:
   - ✅ Allowlist: `victor-ia-agent.vercel.app`
   - ✅ Webhook: `https://n8n.srv1013903.hstgr.cloud/webhook/elevenlabs-vic`
   - ✅ Voice Authentication: Enabled
   - ✅ Temperature: 0.35

### Configurar Webhook en ElevenLabs

1. En Agent Victor → Advanced → Post-call Webhook
2. URL: `https://n8n.srv1013903.hstgr.cloud/webhook/elevenlabs-vic`
3. Auth: HMAC signature (usar `VTC_SHARED_SECRET`)
4. Transcript: ON
5. Audio: ON
6. Save

---

## Setup N8N

### 1️⃣ Crear Workflow en N8N

1. Ir a https://n8n.srv1013903.hstgr.cloud
2. Crear nuevo Workflow (o importar `n8n-workflow-vic-agent-v3.json`)
3. Nodos:
   - **Webhook** (trigger desde ElevenLabs)
   - **HTTP Request** (POST a `/api/process-call`)
   - **IF** (validar si success)
   - **Responder** (éxito o error)

### 2️⃣ Configurar Webhook N8N

1. Nodo "Webhook — ElevenLabs"
2. Method: POST
3. Path: `webhook/elevenlabs-vic`
4. Save y copiar **Webhook URL** completa

### 3️⃣ Actualizar Webhook en ElevenLabs

1. Volver a ElevenLabs Agent Victor
2. Post-call Webhook URL: (pegr URL de N8N)
3. Save

### 4️⃣ Agregar credenciales a N8N

1. Credentials → HTTP Header Auth
2. Header name: `X-HMAC-Signature`
3. Header value: (el HMAC que calcula N8N)
4. Save

---

## Deploy a Vercel

### 1️⃣ Crear proyecto en Vercel

```bash
vercel login
vercel create victor-ia-agent
```

### 2️⃣ Conectar a GitHub

1. Ir a https://vercel.com → Import Project
2. GitHub: `mesainteligentedemo-cell/victor-ia-agent`
3. Authorize Vercel
4. Import

### 3️⃣ Configurar variables de entorno en Vercel

1. En Vercel dashboard → Proyecto → Settings → Environment Variables
2. Agregar:
   ```
   ELEVENLABS_API_KEY=sk_xxxxx
   ELEVENLABS_AGENT_ID=agent_5701kr0h5gg6eetb69tv6c5hwfj1
   VTC_SHARED_SECRET=tu_secret_aqui
   RESEND_API_KEY=re_xxxxx
   EMAIL_FROM=info@victor-ia.com.mx
   EMAIL_TO_PRIMARY=mesainteligentedemo@gmail.com
   ENVIRONMENT=production
   ```

### 4️⃣ Deploy

```bash
git push origin main
# O usar: vercel deploy --prod
```

### 5️⃣ Verificar URL

```bash
curl https://victor-ia-agent.vercel.app/api/health
```

**Respuesta esperada:**
```json
{
  "status": "ok",
  "version": "3.0.0"
}
```

---

## Testing

### 1️⃣ Test local

```bash
# Terminal 1: Servidor
npm run dev

# Terminal 2: Hacer test
curl -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d @test-payload.json
```

### 2️⃣ Test con N8N

1. En N8N Workflow → Test (play button)
2. Webhook debería recibir payload de prueba
3. Verificar que `/api/process-call` responde correctamente

### 3️⃣ Test end-to-end

1. Hacer una llamada en ElevenLabs Agent Victor (o simular)
2. Verificar que:
   - N8N recibe webhook ✅
   - Vercel procesa en 12 pasos ✅
   - Email se envía ✅
   - PDF + MP3 se adjuntan ✅

### Archivo test-payload.json

```json
{
  "conversation_id": "conv_test_123",
  "nombre_asesor": "Juan López",
  "empleado_id": "VTC-001",
  "puesto": "Liner",
  "modulo": "Meet & Greet",
  "familia_nombre": "López",
  "idioma": "Español",
  "duracion_segundos": 593,
  "score_rapport": 9,
  "score_pnl": 8,
  "score_postura": 9,
  "score_objecciones": 9,
  "score_lectura_sala": 9,
  "score_cierre": 8,
  "score_overall": 8
}
```

---

## Troubleshooting

### Error: "ELEVENLABS_API_KEY not found"

✅ Verificar que `.env.local` existe y tiene la key  
✅ Reiniciar servidor: `npm run dev`

### Error: "HMAC signature invalid"

✅ Verificar que `VTC_SHARED_SECRET` es el MISMO en:
   - `.env.local`
   - N8N credentials
   - ElevenLabs webhook config

### Error: "Email not sent"

✅ Verificar `RESEND_API_KEY`  
✅ Verificar `EMAIL_FROM` y `EMAIL_TO_PRIMARY`  
✅ Revisar logs de Resend

### Error: "PDF generation failed"

✅ Puppeteer necesita ~300MB RAM  
✅ En Vercel, función debe tener `memory: 2048` (Pro+)  
✅ Verificar que `@sparticuz/chromium` está instalado

### N8N webhook no recibe data

✅ Copiar webhook URL de N8N exactamente  
✅ Verificar que ElevenLabs post-call webhook URL está actualizada  
✅ Probar manualmente: `curl -X POST <n8n-webhook-url> -d "test=1"`

---

## 🎯 Verificación Final

Checklist antes de producción:

- [ ] ✅ Servidor local funciona: `npm run dev`
- [ ] ✅ .env.local tiene todas las variables
- [ ] ✅ ElevenLabs Agent Victor está activo
- [ ] ✅ N8N workflow importado y activo
- [ ] ✅ Webhook URL de N8N configurada en ElevenLabs
- [ ] ✅ HMAC secret es igual en todos lados
- [ ] ✅ Proyecto creado en Vercel
- [ ] ✅ Env vars en Vercel dashboard
- [ ] ✅ Deploy exitoso: `https://victor-ia-agent.vercel.app`
- [ ] ✅ `/api/health` responde
- [ ] ✅ Test email recibido con PDF + MP3
- [ ] ✅ Pop-up reproductor funciona desde email/PDF

---

## 📞 Support

- **Docs:** `/docs`
- **API Status:** `/api/health`
- **N8N Dashboard:** https://n8n.srv1013903.hstgr.cloud
- **ElevenLabs Console:** https://elevenlabs.io
- **Vercel Dashboard:** https://vercel.com

---

**Última actualización:** 31/07/2026  
**Versión:** 3.0.0  
**Status:** 🟢 Production Ready