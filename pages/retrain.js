/**
 * PÁGINA — /retrain?conv=<id>&t=<token>
 *
 * Solicitud de reentrenamiento sobre una sesión ya evaluada.
 * Es el destino del CTA "Solicitar reentrenamiento" del reporte.
 *
 * El formulario recoge qué competencias reforzar y por qué, y lo manda a
 * POST /api/retrain, que notifica al gerente por correo.
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
  bad: '#D55E00',
  border: 'rgba(212,175,55,.22)'
};

const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

const PRIORIDADES = [
  { value: 'alta', label: 'Alta — antes de volver a piso' },
  { value: 'media', label: 'Media — en la sesión semanal' },
  { value: 'baja', label: 'Baja — seguimiento normal' }
];

export default function Retrain() {
  const [conv, setConv] = useState(null);
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);
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
        setData(body.conversation);
        // Preseleccionamos la competencia más débil: es la razón habitual de
        // pedir reentrenamiento y ahorra un clic al gerente.
        if (body.conversation && body.conversation.comp_baja) {
          setCompetencias([body.conversation.comp_baja]);
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

  function toggleCompetencia(name) {
    setCompetencias((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!competencias.length) {
      setResultado({ ok: false, message: 'Elige al menos una competencia a reforzar.' });
      return;
    }

    setEnviando(true);
    setResultado(null);

    try {
      const r = await fetch('/api/retrain', {
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
        message: body.message || 'Solicitud registrada. El gerente recibió la notificación.'
      });
    } catch (err) {
      setResultado({ ok: false, message: err.message });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: FONT, padding: '24px 16px' }}>
      <main style={{ maxWidth: 760, margin: '0 auto' }}>

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
              <p style={{ fontSize: 14, lineHeight: 1.7, color: C.muted, marginTop: 0 }}>
                Marca las competencias a reforzar. La solicitud llega al gerente con el
                contexto de esta sesión: scores, resumen y enlace al reporte.
              </p>

              <fieldset style={{ border: 'none', padding: 0, margin: '22px 0 0' }}>
                <legend style={legendStyle}>Competencias a reforzar</legend>
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
                        <strong style={{ color: C.goldSoft }}>{c.score}/10</strong>
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
                  rows={4}
                  maxLength={2000}
                  placeholder="Qué observaste en la sesión y qué esperas que cambie."
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
                />
              </fieldset>

              {resultado && !resultado.ok && (
                <div role="alert" style={{ ...alertBox(C.bad), marginTop: 20 }}>
                  <p style={{ margin: 0, fontSize: 14, color: C.bad }}>{resultado.message}</p>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 26 }}>
                <button type="submit" disabled={enviando} style={{ ...btnPrimary, opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? 'Enviando…' : 'Enviar solicitud'}
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
              <p style={{ margin: 0, fontWeight: 700, color: C.good }}>Solicitud enviada</p>
              <p style={{ margin: '8px 0 0', fontSize: 14, color: C.muted }}>{resultado.message}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 20 }}>
                <a
                  href={`/player?conv=${encodeURIComponent(conv)}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                  style={btnGhost}
                >
                  Volver al reproductor
                </a>
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
  border: `1px solid ${C.border}`
};

function alertBox(color) {
  return {
    background: 'rgba(255,255,255,.04)',
    border: `1px solid ${color}`,
    borderRadius: 10,
    padding: '18px 20px'
  };
}