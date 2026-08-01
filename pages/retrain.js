/**
 * PÁGINA — /retrain?conv=<id>&t=<token>
 *
 * Solicitud de reentrenamiento sobre una sesión ya evaluada.
 * Es el destino del CTA "Solicitar reentrenamiento" del reporte.
 *
 * Qué muestra antes de pedir nada: quién es el asesor, cómo le fue y qué está
 * por debajo del estándar. Un formulario que arranca en blanco obliga al
 * gerente a abrir el PDF en otra pestaña para acordarse de los números.
 *
 * Al enviar: POST /api/retrain-request, que registra la solicitud y notifica
 * a los gerentes. Las competencias son opcionales — si no se marca ninguna,
 * el servidor toma las que están por debajo del estándar.
 */

import React, { useEffect, useMemo, useState } from 'react';

const C = {
  bg: '#0a1721',
  panel: '#102435',
  navy: '#1a3a52',
  gold: '#d4af37',
  goldSoft: '#e6c869',
  text: '#eef2f6',
  muted: '#9db0c2',
  good: '#009E73',
  goodLit: '#3fd7ae',
  warn: '#E69F00',
  warnLit: '#ffc457',
  bad: '#D55E00',
  border: 'rgba(212,175,55,.22)'
};

const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Estándar VTC: por debajo de esto la competencia es área crítica. */
const META = 8;

const PRIORIDADES = [
  { value: 'alta', label: 'Alta — antes de volver a piso' },
  { value: 'media', label: 'Media — en la sesión semanal' },
  { value: 'baja', label: 'Baja — seguimiento normal' }
];

export default function Retrain() {
  const [conv, setConv] = useState(null);
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);
  const [destinatarios, setDestinatarios] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [competencias, setCompetencias] = useState([]);
  const [prioridad, setPrioridad] = useState('media');
  const [notas, setNotas] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setConv(params.get('conv'));
    setToken(params.get('t'));
  }, []);

  useEffect(() => {
    if (conv === null) return;

    if (!conv) {
      setError('Falta el parámetro ?conv= en la URL.');
      setLoading(false);
      return;
    }

    const url = `/api/conversation/${encodeURIComponent(conv)}` +
      (token ? `?t=${encodeURIComponent(token)}` : '');

    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.hint || body.error || `HTTP ${r.status}`);
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        const conversation = body.conversation || null;
        setData(conversation);
        setDestinatarios(Array.isArray(body.retrain_destinatarios) ? body.retrain_destinatarios : []);

        // Preseleccionamos TODO lo que está por debajo del estándar: es lo que
        // el gerente marcaría a mano después de mirar los scores.
        const bajas = (conversation && Array.isArray(conversation.competencias)
          ? conversation.competencias
          : []
        )
          .filter((c) => Number(c.score) < META)
          .sort((a, b) => a.score - b.score)
          .map((c) => c.name);

        if (bajas.length) setCompetencias(bajas);
        else if (conversation && conversation.comp_baja) setCompetencias([conversation.comp_baja]);

        // Prioridad sugerida por el resultado, no fija en "media".
        if (conversation && Number.isFinite(Number(conversation.score_overall))) {
          const s = Number(conversation.score_overall);
          setPrioridad(s < 7 ? 'alta' : s < 8.5 ? 'media' : 'baja');
        }

        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [conv, token]);

  const listaCompetencias = useMemo(
    () => (data && Array.isArray(data.competencias) ? data.competencias : []),
    [data]
  );

  const criticas = useMemo(
    () => listaCompetencias.filter((c) => Number(c.score) < META).sort((a, b) => a.score - b.score),
    [listaCompetencias]
  );

  const destinoTexto = destinatarios.length
    ? destinatarios.join(', ')
    : 'los gerentes de VTC Elite Training';

  function toggleCompetencia(name) {
    setCompetencias((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }

  async function onSubmit(e) {
    e.preventDefault();
    setEnviando(true);
    setResultado(null);

    try {
      const r = await fetch('/api/retrain-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conv,
          token,
          competencias,
          prioridad,
          notas: notas.trim()
        })
      });
      const body = await r.json().catch(() => ({}));

      if (!r.ok || !body.success) {
        throw new Error(body.error || body.detail || `HTTP ${r.status}`);
      }

      setResultado({
        ok: true,
        message: body.confirmacion || body.message,
        folio: body.folio || null,
        destinatarios: Array.isArray(body.destinatarios) ? body.destinatarios : destinatarios,
        competencias: Array.isArray(body.competencias) ? body.competencias : competencias,
        prioridad: body.prioridad || prioridad
      });
    } catch (err) {
      setResultado({ ok: false, message: err.message });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: FONT, padding: '24px 16px' }}>
      <main style={{ maxWidth: 780, margin: '0 auto' }}>

        <header style={{
          background: C.navy, border: `1px solid ${C.border}`, borderBottom: `3px solid ${C.gold}`,
          borderRadius: '14px 14px 0 0', padding: '26px 28px'
        }}>
          <p style={{ margin: 0, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: C.gold, fontWeight: 700 }}>
            Victorious Travelers Club · Elite Training
          </p>
          <h1 style={{ margin: '10px 0 0', fontSize: 26, fontWeight: 700 }}>Solicitar reentrenamiento</h1>
          {data && (
            <p style={{ margin: '6px 0 0', fontSize: 14, color: C.muted }}>
              {data.nombre} · {data.modulo} · {data.fecha_sesion} · {data.score_overall}/10
            </p>
          )}
        </header>

        <section style={{
          background: C.panel, border: `1px solid ${C.border}`, borderTop: 'none',
          borderRadius: '0 0 14px 14px', padding: '28px'
        }}>

          {loading && <p style={{ color: C.muted }}>Cargando la sesión…</p>}

          {error && (
            <div role="alert" style={alertBox(C.bad)}>
              <p style={{ margin: 0, fontWeight: 700, color: C.bad }}>No se pudo abrir la sesión</p>
              <p style={{ margin: '8px 0 0', fontSize: 14, color: C.muted }}>{error}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: C.muted }}>
                Abre el enlace tal cual aparece en el correo del reporte (incluye ?t=…).
              </p>
            </div>
          )}

          {data && !resultado?.ok && (
            <form onSubmit={onSubmit}>

              {/* ── Ficha del asesor ───────────────────────────── */}
              <div style={cardBox}>
                <p style={cardTitle}>Asesor evaluado</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14 }}>
                  <Dato k="Nombre" v={data.nombre} />
                  <Dato k="ID de empleado" v={data.empleado_id} />
                  <Dato k="Puesto" v={data.puesto} />
                  <Dato k="Módulo evaluado" v={data.modulo} />
                  <Dato k="Sesión" v={`${data.fecha_sesion} ${data.hora_cancun || ''}`} />
                  <Dato k="Duración" v={`${data.duracion_texto} min`} />
                </div>

                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline',
                  marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,.08)'
                }}>
                  <span style={{ fontSize: 12, color: C.muted }}>Desempeño global</span>
                  <strong style={{ fontSize: 22, color: scoreColor(data.score_overall) }}>
                    {data.score_overall}/10
                  </strong>
                  <span style={{ fontSize: 13, color: C.muted }}>({data.scoreTotal}%)</span>
                </div>
              </div>

              {/* ── Áreas críticas ─────────────────────────────── */}
              {criticas.length > 0 && (
                <div style={{ ...cardBox, borderLeft: `3px solid ${C.warn}` }}>
                  <p style={cardTitle}>Áreas críticas de esta sesión</p>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.75, color: '#dbe4ec' }}>
                    {criticas.map((c) => (
                      <li key={c.name}>
                        <strong style={{ color: C.warnLit }}>{c.name}</strong>: {c.score}/10
                        {' '}— {Math.round((META - c.score) * 10) / 10} por debajo del estándar
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.recomendacion_coach && (
                <div style={cardBox}>
                  <p style={cardTitle}>Recomendación del coach</p>
                  <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.75, color: '#dbe4ec' }}>
                    {data.recomendacion_coach}
                  </p>
                </div>
              )}

              {/* ── Formulario ─────────────────────────────────── */}
              <fieldset style={{ border: 'none', padding: 0, margin: '26px 0 0' }}>
                <legend style={legendStyle}>Competencias a reforzar</legend>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
                  Vienen preseleccionadas las que están por debajo de {META}/10. Si no marcas ninguna,
                  el sistema toma esas mismas.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
                  {listaCompetencias.map((c) => {
                    const activo = competencias.includes(c.name);
                    return (
                      <label
                        key={c.name}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                          background: activo ? 'rgba(212,175,55,.14)' : 'rgba(255,255,255,.04)',
                          border: `1px solid ${activo ? C.gold : 'rgba(255,255,255,.08)'}`,
                          borderRadius: 9, padding: '12px 14px', fontSize: 14
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={activo}
                          onChange={() => toggleCompetencia(c.name)}
                          style={{ accentColor: C.gold, width: 17, height: 17 }}
                        />
                        <span style={{ flex: 1 }}>{c.name}</span>
                        <strong style={{ color: scoreColor(c.score) }}>{c.score}/10</strong>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset style={{ border: 'none', padding: 0, margin: '24px 0 0' }}>
                <legend style={legendStyle}>Prioridad</legend>
                <select
                  value={prioridad}
                  onChange={(e) => setPrioridad(e.target.value)}
                  style={inputStyle}
                >
                  {PRIORIDADES.map((p) => (
                    <option key={p.value} value={p.value} style={{ background: C.navy }}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </fieldset>

              <fieldset style={{ border: 'none', padding: 0, margin: '24px 0 0' }}>
                <legend style={legendStyle}>Notas para el coach (opcional)</legend>
                <textarea
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  rows={5}
                  maxLength={2000}
                  placeholder="Qué observaste en la sesión y qué esperas que cambie. Se envía tal cual al gerente."
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
                />
                <p style={{ margin: '6px 0 0', fontSize: 12, color: C.muted, textAlign: 'right' }}>
                  {notas.length}/2000
                </p>
              </fieldset>

              {/* ── A dónde llega ──────────────────────────────── */}
              <div style={{
                marginTop: 24, padding: '14px 16px', borderRadius: 10,
                background: 'linear-gradient(120deg, rgba(212,175,55,.14), rgba(212,175,55,.04))',
                border: `1px solid ${C.border}`
              }}>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: '#dbe4ec' }}>
                  La solicitud se registra y llega por correo a{' '}
                  <strong style={{ color: C.goldSoft }}>{destinoTexto}</strong> con el resumen del
                  asesor, los scores, las áreas críticas, tus notas y el enlace a este reporte.
                </p>
              </div>

              {resultado && !resultado.ok && (
                <div role="alert" style={{ ...alertBox(C.bad), marginTop: 20 }}>
                  <p style={{ margin: 0, fontWeight: 700, color: C.bad }}>No se pudo enviar</p>
                  <p style={{ margin: '8px 0 0', fontSize: 14, color: C.muted }}>{resultado.message}</p>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 24 }}>
                <button type="submit" disabled={enviando} style={{ ...btnPrimary, opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? 'Enviando…' : 'Solicitar reentrenamiento'}
                </button>
                <a
                  href={`/player?conv=${encodeURIComponent(conv)}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                  style={btnGhost}
                >
                  Volver al reproductor
                </a>
              </div>
            </form>
          )}

          {resultado?.ok && (
            <div role="status" style={alertBox(C.good)}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 17, color: C.goodLit }}>
                Solicitud enviada
              </p>
              <p style={{ margin: '10px 0 0', fontSize: 14.5, lineHeight: 1.7, color: C.text }}>
                {resultado.message}
              </p>

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,.1)' }}>
                {resultado.folio && <Dato k="Folio de la solicitud" v={resultado.folio} />}
                <div style={{ height: 12 }} />
                <Dato k="Enviada a" v={(resultado.destinatarios || []).join(', ') || destinoTexto} />
                <div style={{ height: 12 }} />
                <Dato k="Prioridad" v={resultado.prioridad} />
                <div style={{ height: 12 }} />
                <Dato
                  k="Competencias a reforzar"
                  v={(resultado.competencias || []).join(', ') || 'Definidas por el sistema según los scores'}
                />
              </div>

              <p style={{ margin: '18px 0 0', fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
                El gerente recibió el resumen del asesor, los scores de la sesión, las áreas críticas,
                tus notas y el enlace al reporte completo.
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 20 }}>
                <a
                  href={`/player?conv=${encodeURIComponent(conv)}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                  style={btnGhost}
                >
                  Volver al reproductor
                </a>
                <button type="button" onClick={() => setResultado(null)} style={btnGhost}>
                  Enviar otra solicitud
                </button>
              </div>
            </div>
          )}
        </section>

        <footer style={{ textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 22 }}>
          Victor IA · Entrenamiento VTC Capacitación · victor-ia.xyz
        </footer>
      </main>
    </div>
  );
}

/** Par etiqueta/valor con el mismo aspecto en toda la página. */
function Dato({ k, v }) {
  return (
    <div>
      <p style={{
        margin: 0, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
        color: C.gold, fontWeight: 700
      }}>{k}</p>
      <p style={{ margin: '3px 0 0', fontSize: 14, color: C.text, fontWeight: 600, wordBreak: 'break-word' }}>
        {v || '—'}
      </p>
    </div>
  );
}

/** Color del score con la misma escala que el reporte. */
function scoreColor(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return C.goldSoft;
  if (n >= 9) return C.goodLit;
  if (n >= 8) return C.goldSoft;
  if (n >= 6.5) return C.warnLit;
  return '#ff9257';
}

const cardBox = {
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.08)',
  borderRadius: 11,
  padding: '18px 20px',
  marginBottom: 14
};

const cardTitle = {
  margin: '0 0 14px', fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase',
  color: C.gold, fontWeight: 700
};

const legendStyle = {
  fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
  color: C.gold, fontWeight: 700, padding: 0, marginBottom: 12
};

const inputStyle = {
  width: '100%', background: 'rgba(255,255,255,.05)', color: C.text,
  border: '1px solid rgba(255,255,255,.12)', borderRadius: 9,
  padding: '12px 14px', fontSize: 14, fontFamily: FONT
};

const btnPrimary = {
  background: C.gold, color: '#0d1b26', fontWeight: 700, fontSize: 14,
  padding: '13px 24px', borderRadius: 8, border: 'none', cursor: 'pointer'
};

const btnGhost = {
  display: 'inline-block', background: 'transparent', color: C.goldSoft, fontWeight: 600,
  fontSize: 14, padding: '12px 22px', borderRadius: 8, textDecoration: 'none',
  border: `1px solid ${C.border}`, cursor: 'pointer', fontFamily: FONT
};

function alertBox(color) {
  return {
    background: 'rgba(255,255,255,.04)',
    border: `1px solid ${color}`,
    borderRadius: 10,
    padding: '18px 20px'
  };
}