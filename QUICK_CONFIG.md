# ⚡ QUICK CONFIG — Victor IA Agent v3.0

## ✅ STATUS ACTUAL

```
✓ GitHub:  https://github.com/mesainteligentedemo-cell/victor-ia-agent
✓ Vercel:  https://victor-ia-agent.vercel.app (LIVE)
✓ API:     /api/health (funciona ✓)
✗ N8N:     Pendiente de configurar
✗ ElevenLabs: Pendiente de configurar
```

---

## 🔴 CRÍTICO: CONFIGURAR ENV VARS (5 MINUTOS)

### Paso 1: Ir a Vercel Dashboard

https://vercel.com/projects/victor-ia-agent

### Paso 2: Settings → Environment Variables

Buscar la sección "Environment Variables"

### Paso 3: Agregar 3 variables CRÍTICAS

```
ELEVENLABS_API_KEY
Valor: sk_xxxxxxxxxxxxx (tu API key de ElevenLabs)

VTC_SHARED_SECRET  
Valor: tu_hmac_secret (cadena aleatoria, p.ej: abc123def456)

RESEND_API_KEY
Valor: re_xxxxxxxxxxxxx (tu API key de Resend)
```

### Paso 4: Deploy automático

Vercel redeploy automáticamente en ~2 minutos

---

## 🔧 CONFIGURAR N8N (10 MINUTOS)

### Opción A: Importar Workflow (RECOMENDADO)

1. Ir a https://n8n.srv1013903.hstgr.cloud
2. Dashboard → **Import Workflow**
3. Seleccionar archivo: `n8n-workflow-vic-agent-v3.json`
4. **Importante:** Copiar la **Webhook URL** que aparecerá
5. Activar workflow (toggle ON)

### Opción B: Crear Manualmente

1. New Workflow
2. Agregar nodos:
   - **Webhook** (trigger)
     - Path: `webhook/elevenlabs-vic`
     - Method: POST
   - **HTTP Request** (HTTP POST)
     - URL: `https://victor-ia-agent.vercel.app/api/process-call`
     - Headers: `Content-Type: application/json`
   - **IF** (condicional)
     - Condition: `success == true`
   - **Responder** (success/error)
3. Save y activar

---

## 🎤 CONFIGURAR ELEVENLABS (5 MINUTOS)

### Paso 1: Ir a Agent Victor

https://elevenlabs.io → Agents → Victor

### Paso 2: Configurar Post-call Webhook

1. Advanced Settings
2. **Post-call Webhook**
3. URL: (pegar webhook URL de N8N)
4. **HMAC Signature**
   - Header name: `X-HMAC-Signature`
   - Secret: (pegar VTC_SHARED_SECRET)
5. **Transcript:** ON
6. **Audio:** ON
7. Save

### Paso 3: Verificar

- Allowlist debe incluir: `victor-ia-agent.vercel.app`
- Voice Authentication: ON
- Temperature: 0.35

---

## ✅ TEST FINAL (5 MINUTOS)

### 1. Hacer test call

Hacer una llamada de prueba en Agent Victor (p.ej: "Test", "Hola")

### 2. Esperar webhook

N8N debería recibir datos en ~5 segundos

### 3. Verificar email

Revisar mesainteligentedemo@gmail.com en ~30 segundos

**Esperado:**
- Email con Subject: `Info Capacitación: Reporte de...`
- HTML reporte en body
- PDF adjunto
- MP3 adjunto

### 4. Probar pop-up reproductor

Hacer click en "Escuchar Sesión" desde el email → Pop-up debe abrirse

---

## 🆘 TROUBLESHOOTING RÁPIDO

### "Email no llega"
- [ ] Verificar RESEND_API_KEY en Vercel
- [ ] Verificar que EMAIL_TO_PRIMARY está correcto
- [ ] Revisar logs de Vercel (Deployments → Logs)

### "N8N no recibe webhook"
- [ ] Copiar webhook URL EXACTAMENTE de N8N
- [ ] Pegar en ElevenLabs post-call webhook
- [ ] Verifi car que N8N workflow está ON (toggle)

### "HMAC invalid"
- [ ] Verificar que VTC_SHARED_SECRET es igual en:
  - Vercel env var
  - N8N credentials
  - ElevenLabs webhook

### "PDF no se adjunta"
- [ ] Vercel necesita Pro+ plan
- [ ] Verificar que Puppeteer instalado
- [ ] Revisar logs de Vercel

---

## 📊 CHECKSUM

Después de configurar, verificar:

```
✓ Vercel dashboard muestra env vars
✓ Vercel deployment es exitoso (Build OK)
✓ /api/health responde
✓ N8N workflow importado y ON
✓ N8N webhook URL copiada
✓ ElevenLabs post-call webhook configurada
✓ ElevenLabs HMAC secret igual al de Vercel
✓ Test call recibe email con PDF + MP3
✓ Pop-up reproductor abre
✓ Descargas funcionan
```

---

## 📞 SOPORTE RÁPIDO

| Problema | Comando | Resultado |
|----------|---------|-----------|
| Ver logs Vercel | `vercel logs victor-ia-agent` | Últimos logs |
| Verificar build | `vercel status` | Estado deploy |
| Health check | `curl https://victor-ia-agent.vercel.app/api/health` | JSON status |

---

**Tiempo total de setup:** ~25 minutos

**Una vez configurado:** Sistema 100% automático ✅

---

**Última actualización:** 31/07/2026
**Versión:** 3.0.0