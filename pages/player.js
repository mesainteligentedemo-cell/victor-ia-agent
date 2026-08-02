/**
 * PÁGINA — /player?conv=<id>&t=<token>
 *
 * Reproductor de la sesión: audio de la llamada + transcripción sincronizada.
 * Es el destino del CTA "Escuchar la sesión" del reporte.
 *
 * Todo se pide al servidor con el token del enlace; la página no conoce
 * ninguna credencial.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Paleta VTC v4.0 — idéntica a la del reporte, el correo y el formulario.
 * El reproductor se abre desde el CTA "Escuchar la sesión"; si cambia de color
 * al saltar, parece otro sistema.
 */
const C = {
  bg: '#0D0D0D',        // fondo principal — negro puro
  panel: '#1A1A1A',     // tarjetas
  navy: '#262626',      // cabecera y controles (gris grafito)
  gold: '#E5B33E',      // acento único
  goldSoft: '#F2C766',
  text: '#FFFFFF',
  muted: '#B8B8B8',
  good: '#10B981',      // score ≥ 8 — cumple la meta VTC
  warn: '#F59E0B',      // score 6 – 7.99
  bad: '#EF4444',       // score < 6
  border: 'rgba(229,179,62,.28)'
};

const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Color semáforo del score, con los cortes de la meta VTC (8.0) —
 * los mismos que usan el reporte, los gráficos, el correo y el formulario.
 */
function scoreColor(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return C.muted;
  if (n >= 8) return C.good;
  if (n >= 6) return C.warn;
  return C.bad;
}

/** "mm:ss" -> segundos. Devuelve null si no hay marca de tiempo. */
function toSeconds(stamp) {
  if (!stamp || typeof stamp !== 'string') return null;
  const m = stamp.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function Player() {
  const [conv, setConv] = useState(null);
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioError, setAudioError] = useState(false);

  const audioRef = useRef(null);

  // Los parámetros se leen en el cliente: la página es estática y así evitamos
  // que el token viaje en el HTML renderizado en el servidor.
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
        if (!cancelled) {
          setData(body.conversation);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [conv, token]);

  const audioSrc = useMemo(() => {
    if (!conv) return null;
    return `/api/audio/${encodeURIComponent(conv)}` + (token ? `?t=${encodeURIComponent(token)}` : '');
  }, [conv, token]);

  const pdfHref = useMemo(() => {
    if (!conv) return null;
    return `/api/pdf/${encodeURIComponent(conv)}` + (token ? `?t=${encodeURIComponent(token)}` : '');
  }, [conv, token]);

  /** Salta el audio al momento de un turno. */
  const seekTo = useCallback((seconds) => {
    const el = audioRef.current;
    if (!el || seconds === null) return;
    el.currentTime = seconds;
    el.play().catch(() => { /* el navegador puede exigir gesto del usuario */ });
  }, []);

  // Turno que suena ahora: el último cuya marca ya pasó.
  const activeIndex = useMemo(() => {
    if (!data || !Array.isArray(data.transcription)) return -1;
    let idx = -1;
    data.transcription.forEach((t, i) => {
      const s = toSeconds(t.timestamp);
      if (s !== null && s <= currentTime) idx = i;
    });
    return idx;
  }, [data, currentTime]);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: FONT, padding: '24px 16px' }}>
      <main style={{ maxWidth: 900, margin: '0 auto' }}>

        <header style={{
          background: C.navy, border: `1px solid ${C.border}`, borderBottom: `3px solid ${C.gold}`,
          borderRadius: '14px 14px 0 0', padding: '26px 28px'
        }}>
          <p style={{ margin: 0, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: C.gold, fontWeight: 700 }}>
            Victorious Travelers Club · Elite Training
          </p>
          <h1 style={{ margin: '10px 0 0', fontSize: 26, fontWeight: 700 }}>Reproductor de sesión</h1>
          {data && (
            <p style={{ margin: '6px 0 0', fontSize: 14, color: C.muted }}>
              {data.nombre} · {data.modulo} · {data.fecha_sesion} {data.hora_cancun}
            </p>
          )}
        </header>

        <section style={{
          background: C.panel, border: `1px solid ${C.border}`, borderTop: 'none',
          borderRadius: '0 0 14px 14px', padding: '28px'
        }}>

          {loading && <p style={{ color: C.muted }}>Cargando la sesión…</p>}

          {error && (
            <div role="alert" style={{
              background: 'rgba(239,68,68,.12)', border: `1px solid ${C.bad}`,
              borderRadius: 10, padding: '18px 20px'
            }}>
              <p style={{ margin: 0, fontWeight: 700, color: C.bad }}>No se pudo abrir la sesión</p>
              <p style={{ margin: '8px 0 0', fontSize: 14, color: C.muted }}>{error}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: C.muted }}>
                Abre el enlace tal cual aparece en el correo del reporte. Los enlaces caducan
                a los 90 días por seguridad.
              </p>
            </div>
          )}

          {data && (
            <>
              {/* ── Resumen ───────────────────────────────── */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
                gap: 14, marginBottom: 26
              }}>
                <Stat label="Desempeño" value={`${data.score_overall}/10`} color={scoreColor(data.score_overall)} />
                <Stat label="Equivalente" value={`${data.scoreTotal}%`} color={scoreColor(data.score_overall)} />
                <Stat label="Duración" value={`${data.duracion_texto} min`} color={C.text} />
                <Stat label="Turnos" value={String(data.turnos)} color={C.text} />
              </div>

              {/* ── Audio ─────────────────────────────────── */}
              <h2 style={sectionTitle}>Audio de la sesión</h2>
              {audioError ? (
                <p style={{ color: C.muted, fontSize: 14 }}>
                  ElevenLabs no conserva audio para esta conversación. La transcripción
                  completa sigue disponible abajo.
                </p>
              ) : (
                <audio
                  ref={audioRef}
                  src={audioSrc}
                  controls
                  preload="metadata"
                  onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                  onError={() => setAudioError(true)}
                  style={{ width: '100%', marginBottom: 8 }}
                >
                  Tu navegador no puede reproducir audio.
                </audio>
              )}

              {/* ── Acciones ──────────────────────────────── */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '20px 0 30px' }}>
                <a href={pdfHref} className="vtc-btn vtc-btn-primary" style={btnPrimary}>Descargar el PDF</a>
                <a
                  className="vtc-btn vtc-btn-ghost"
                  href={`/retrain?conv=${encodeURIComponent(conv)}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                  style={btnGhost}
                >
                  Solicitar reentrenamiento
                </a>
              </div>

              {/* ── Transcripción ─────────────────────────── */}
              <h2 style={sectionTitle}>Transcripción</h2>
              {!data.transcription || !data.transcription.length ? (
                <p style={{ color: C.muted, fontSize: 14 }}>
                  Esta sesión no tiene transcripción registrada.
                </p>
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {data.transcription.map((turn, i) => {
                    const secs = toSeconds(turn.timestamp);
                    const activo = i === activeIndex;
                    const esAgente = turn.type === 'agent';
                    return (
                      <li key={i} style={{ marginBottom: 10, display: 'flex', justifyContent: esAgente ? 'flex-end' : 'flex-start' }}>
                        <button
                          type="button"
                          onClick={() => seekTo(secs)}
                          disabled={secs === null || audioError}
                          title={secs === null ? 'Sin marca de tiempo' : `Ir a ${turn.timestamp}`}
                          style={{
                            maxWidth: '78%', textAlign: 'left', cursor: secs === null || audioError ? 'default' : 'pointer',
                            background: activo
                              ? 'rgba(229,179,62,.20)'
                              : esAgente ? 'rgba(255,255,255,.05)' : 'rgba(86,180,233,.10)',
                            border: `1px solid ${activo ? C.gold : 'rgba(255,255,255,.08)'}`,
                            borderRadius: 12, padding: '11px 14px', color: C.text,
                            font: 'inherit', fontSize: 14, lineHeight: 1.6
                          }}
                        >
                          <span style={{
                            display: 'block', fontSize: 11, letterSpacing: 1,
                            textTransform: 'uppercase', color: esAgente ? C.goldSoft : '#8fc6ea',
                            fontWeight: 700, marginBottom: 4
                          }}>
                            {turn.speaker}{turn.timestamp ? ` · ${turn.timestamp}` : ''}
                          </span>
                          {turn.text}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}

              {!audioError && (
                <p style={{ color: C.muted, fontSize: 12, marginTop: 16 }}>
                  Reproduciendo {formatClock(currentTime)} · toca cualquier turno para saltar a ese momento.
                </p>
              )}
            </>
          )}
        </section>

        <footer style={{ textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 22 }}>
          Victor IA · Entrenamiento VTC Capacitación · victor-ia.xyz
        </footer>

        {/* Los estados del cursor no caben en un `style` inline. Sin ellos un
            botón se lee como texto: no se sabe que se puede pulsar, ni queda
            constancia de que el clic entró. Mismos tiempos y mismo oro que los
            CTAs del reporte. */}
        <style jsx global>{`
          .vtc-btn { transition: background .18s ease, border-color .18s ease,
                                 color .18s ease, transform .12s ease, box-shadow .18s ease; }
          .vtc-btn:focus-visible { outline: 2px solid #F2C766; outline-offset: 3px; }

          .vtc-btn-primary:hover:not(:disabled) {
            background: #F2C766;
            box-shadow: 0 10px 26px rgba(229,179,62,.32);
            transform: translateY(-1px);
          }
          .vtc-btn-primary:active:not(:disabled) {
            background: #B8862A;
            transform: translateY(1px) scale(.985);
            box-shadow: 0 2px 8px rgba(229,179,62,.28);
          }

          .vtc-btn-ghost:hover {
            background: rgba(229,179,62,.14);
            border-color: #E5B33E;
            color: #FFFFFF;
          }
          .vtc-btn-ghost:active {
            background: rgba(229,179,62,.24);
            transform: translateY(1px) scale(.985);
          }
        `}</style>
      </main>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)',
      borderRadius: 10, padding: '14px 16px'
    }}>
      <p style={{
        margin: 0, fontSize: 10, letterSpacing: 2, textTransform: 'uppercase',
        color: C.muted, fontWeight: 700
      }}>{label}</p>
      <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800, color }}>{value}</p>
    </div>
  );
}

const sectionTitle = {
  fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
  color: C.gold, fontWeight: 700, margin: '0 0 12px'
};

const btnPrimary = {
  display: 'inline-block', background: C.gold, color: C.bg, fontWeight: 700,
  fontSize: 14, padding: '12px 22px', borderRadius: 8, textDecoration: 'none'
};

const btnGhost = {
  display: 'inline-block', background: 'transparent', color: C.goldSoft, fontWeight: 600,
  fontSize: 14, padding: '12px 22px', borderRadius: 8, textDecoration: 'none',
  border: `1px solid ${C.border}`
};