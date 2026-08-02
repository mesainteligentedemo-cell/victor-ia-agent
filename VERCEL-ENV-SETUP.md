# ⚙️ CONFIGURACIÓN VERCEL — EMAIL REPORTS CON CC

## 🎯 OBJETIVO
Los reportes deben llegar a:
- **TO (Principal):** mesainteligentedemo@gmail.com
- **CC (Copias):** info@victor-ia.com.mx, chrisoria16@gmail.com, eldudemateos@gmail.com

---

## 🚀 PASOS (5 minutos)

### 1. Ve a Vercel Dashboard
```
https://vercel.com/mesainteligentedemo/victor-ia-training/settings/environment-variables
```

### 2. Busca estas variables (o créalas si no existen)

#### Variable 1: `REPORT_TO`
```
Name:  REPORT_TO
Value: mesainteligentedemo@gmail.com
Environments: Production, Preview, Development
```

#### Variable 2: `REPORT_CC` ← **ESTA ES LA CRÍTICA**
```
Name:  REPORT_CC
Value: info@victor-ia.com.mx, chrisoria16@gmail.com, eldudemateos@gmail.com
Environments: Production, Preview, Development
```

#### Variable 3: `EMAIL_FROM`
```
Name:  EMAIL_FROM
Value: Victor IA <info@victor-ia.xyz>
Environments: Production, Preview, Development
```

#### Variable 4: `RESEND_API_KEY`
```
Name:  RESEND_API_KEY
Value: [tu API key de Resend]
Environments: Production (SOLO)
```

---

## ✅ VERIFICACIÓN

Después de guardar, ejecuta un test:

```bash
# 1. Trigger una sesión en /training
curl -X POST https://www.victor-ia.com.mx/training \
  -H "Content-Type: application/json" \
  -d '{"empleado_id":"123456", "nombre":"Christian Soria"}'

# 2. Revisa el log de Vercel
# Debe mostrar: "CC: info@victor-ia.com.mx, chrisoria16@gmail.com, eldudemateos@gmail.com"
```

---

## 🔍 SI NO FUNCIONA

1. **"sin CC (REPORT_CC no configurado)"** en logs
   → `REPORT_CC` no está en Vercel. Agrégalo ahora.

2. **Email llega sin CC**
   → Verifica que `REPORT_CC` tenga formato correcto (emails separados por comas)

3. **Resend rechaza el email (403)**
   → `RESEND_API_KEY` inválido. Reemplaza en Vercel.

4. **Email llega a TO pero no a CC**
   → Los emails en CC pueden estar mal. Valida en Resend dashboard → Logs.

---

## 📝 NOTAS TÉCNICAS

- **Dónde se lee:** `src/server/api-process-call.js` línea 588
- **Cómo se valida:** `src/server/email-sender.js` línea 1095-1104
- **Log en webhook:** `pages/api/process-call.js` línea 76-85

**Formato aceptado:** `email1@domain.com, email2@domain.com; email3@domain.com`
(Cualquier separador: coma, punto y coma)

---

## 🎉 RESULTADO FINAL

Cuando está configurado correctamente, el email llega así:

```
TO:   mesainteligentedemo@gmail.com
CC:   info@victor-ia.com.mx
      chrisoria16@gmail.com
      eldudemateos@gmail.com
BCC:  (none)
Subject: Reporte de Desarrollo Profesional: Christian Soria • 02/08/2026 11:53 a.m.
Attachments: PDF + MP3
```

✅ **TODO FUNCIONAL**