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
 * al correo que se haya elegido en el formulario. Se exige al menos una
 * competencia marcada y un correo válido: una solicitud sin foco ni destino no
 * le sirve a nadie, y es mejor detenerla aquí que descubrirlo en el buzón.
 */

import React, { useEffect, useMemo, useState } from 'react';

/**
 * Paleta VTC v4.0 — la misma del reporte y de los correos.
 * Negro puro + oro cálido; sin azules. Si el formulario se ve distinto del
 * reporte del que viene, el gerente duda de que sea el mismo sistema.
 */
const C = {
  bg: '#0D0D0D',        // fondo principal — negro puro
  panel: '#1A1A1A',     // tarjetas y contenedores
  navy: '#262626',      // badges, cabecera y campos (gris grafito)
  gold: '#E5B33E',      // acento único
  goldSoft: '#F2C766',
  text: '#FFFFFF',
  muted: '#B8B8B8',
  good: '#10B981',      // score ≥ 8 — cumple la meta VTC
  goodLit: '#34D399',
  warn: '#F59E0B',      // score 6 – 7.99
  warnLit: '#FBBF24',
  bad: '#EF4444',       // score < 6
  badLit: '#F87171',
  prose: '#E4E4E4',     // cuerpo de texto largo
  border: 'rgba(229,179,62,.28)'
};

const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Estándar VTC: por debajo de esto la competencia es área crítica. */
const META = 8;

/** Tope de cada campo de notas. El servidor recorta al mismo número. */
const MAX_NOTAS = 5000;

/** Buzón que se propone por defecto; el gerente puede cambiarlo por cualquiera. */
const EMAIL_DEFAULT = 'mesainteligentedemo@gmail.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Las seis competencias del modelo VTC.
 * Sirven de respaldo cuando la sesión no trae el desglose: el gerente igual
 * tiene que poder pedir el reentrenamiento, aunque falte el score.
 */
const COMPETENCIAS_VTC = [
  'Rapport',
  'PNL',
  'Postura',
  'Objeciones',
  'Lectura de Sala',
  'Cierre'
];

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
  const [notasCoach, setNotasCoach] = useState('');
  const [notasGerente, setNotasGerente] = useState('');
  const [emailDestino, setEmailDestino] = useState(EMAIL_DEFAULT);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [tocoEmail, setTocoEmail] = useState(false);

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

        const gerentes = Array.isArray(body.retrain_destinatarios) ? body.retrain_destinatarios : [];
        setDestinatarios(gerentes);

        // Proponemos el buzón configurado en el servidor en vez del literal de
        // fábrica: si alguien ya cambió RETRAIN_REQUEST_EMAIL, ese es el destino
        // correcto. Sigue siendo editable.
        if (gerentes.length && EMAIL_RE.test(gerentes[0])) setEmailDestino(gerentes[0]);

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

  /**
   * Las seis competencias, siempre las seis.
   * Las evaluadas van con su score; si la sesión no trajo alguna, aparece igual
   * pero sin número — que falte el dato no es motivo para no poder pedir que se
   * refuerce.
   */
  const listaCompetencias = useMemo(() => {
    const evaluadas = data && Array.isArray(data.competencias) ? data.competencias : [];
    const vistos = new Set(evaluadas.map((c) => String(c.name).toLowerCase()));

    const faltantes = COMPETENCIAS_VTC
      .filter((name) => !vistos.has(name.toLowerCase()))
      .map((name) => ({ name, score: null }));

    return [...evaluadas, ...faltantes];
  }, [data]);

  const criticas = useMemo(
    () => listaCompetencias
      .filter((c) => Number.isFinite(Number(c.score)) && Number(c.score) < META)
      .sort((a, b) => a.score - b.score),
    [listaCompetencias]
  );

  const emailValido = EMAIL_RE.test(emailDestino.trim());
  const puedeEnviar = competencias.length > 0 && emailValido && !enviando;

  const destinoTexto = emailValido
    ? emailDestino.trim()
    : (destinatarios.join(', ') || 'los gerentes de VTC Elite Training');

  function toggleCompetencia(name) {
    setCompetencias((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }

  async function onSubmit(e) {
    e.preventDefault();

    // Se valida aquí además de deshabilitar el botón: el submit también entra
    // por Enter en el input de correo, y ahí el botón deshabilitado no protege.
    if (!competencias.length) {
      setResultado({ ok: false, message: 'Marca al menos una competencia a reforzar.' });
      return;
    }
    if (!emailValido) {
      setTocoEmail(true);
      setResultado({ ok: false, message: 'Escribe un correo de destino válido.' });
      return;
    }

    setEnviando(true);
    setResultado(null);

    const destino = emailDestino.trim();

    try {
      const r = await fetch('/api/retrain-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conv,
          token,
          emailDestino: destino,
          competencias,
          competenciasMarcadas: competencias,
          prioridad,
          notas: notasCoach.trim(),
          notasCoach: notasCoach.trim(),
          notasGerente: notasGerente.trim()
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
        destinatarios: Array.isArray(body.destinatarios) && body.destinatarios.length
          ? body.destinatarios
          : [destino],
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
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.75, color: C.prose }}>
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
                  <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.75, color: C.prose }}>
                    {data.recomendacion_coach}
                  </p>
                </div>
              )}

              {/* ── Formulario ─────────────────────────────────── */}
              <fieldset style={{ border: 'none', padding: 0, margin: '26px 0 0' }}>
                <legend style={legendStyle}>Competencias a reforzar</legend>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
                  Vienen preseleccionadas las que están por debajo de {META}/10. Puedes marcar o
                  desmarcar las que quieras — al menos una.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
                  {listaCompetencias.map((c) => {
                    const activo = competencias.includes(c.name);
                    const score = Number(c.score);
                    const tieneScore = Number.isFinite(score);
                    const critica = tieneScore && score < META;
                    return (
                      <label
                        key={c.name}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                          background: activo ? 'rgba(229,179,62,.16)' : 'rgba(255,255,255,.04)',
                          border: `1px solid ${activo ? C.gold : 'rgba(255,255,255,.08)'}`,
                          borderLeft: critica ? `3px solid ${C.warn}` : undefined,
                          borderRadius: 9, padding: '12px 14px', fontSize: 14
                        }}
                      >
                        <input
                          type="checkbox"
                          name="competency"
                          value={c.name}
                          checked={activo}
                          onChange={() => toggleCompetencia(c.name)}
                          style={{ accentColor: C.gold, width: 17, height: 17, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1, color: critica ? C.warnLit : C.text }}>{c.name}</span>
                        <strong style={{ color: scoreColor(c.score), whiteSpace: 'nowrap' }}>
                          {tieneScore ? `${c.score}/10` : 'sin score'}
                        </strong>
                      </label>
                    );
                  })}
                </div>
                {!competencias.length && (
                  <p style={{ margin: '10px 0 0', fontSize: 12.5, color: C.warnLit }}>
                    Marca al menos una competencia para poder enviar la solicitud.
                  </p>
                )}
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

              {/* El nombre del campo dice a quién le llega lo que se escribe.
                  "Notas para el coach" hacía que el gerente escribiera sobre el
                  asesor en tercera persona; el texto se le entrega al propio
                  colaborador, así que se redacta dirigiéndose a él. */}
              <fieldset style={{ border: 'none', padding: 0, margin: '24px 0 0' }}>
                <legend style={legendStyle}>Notas para el colaborador (opcional)</legend>
                <p style={{ margin: '0 0 10px', fontSize: 13, color: C.goldSoft, lineHeight: 1.6, fontWeight: 600 }}>
                  Estas notas se enviarán directamente al colaborador.
                </p>
                <textarea
                  value={notasCoach}
                  onChange={(e) => setNotasCoach(e.target.value.slice(0, MAX_NOTAS))}
                  maxLength={MAX_NOTAS}
                  placeholder="Qué observaste en la sesión y qué esperas que cambie. Esta nota se envía tal cual al colaborador."
                  style={textareaStyle}
                />
                <Contador n={notasCoach.length} />
              </fieldset>

              <fieldset style={{ border: 'none', padding: 0, margin: '24px 0 0' }}>
                <legend style={legendStyle}>Notas adicionales para el gerente (opcional)</legend>
                <textarea
                  value={notasGerente}
                  onChange={(e) => setNotasGerente(e.target.value.slice(0, MAX_NOTAS))}
                  maxLength={MAX_NOTAS}
                  placeholder="Contexto adicional, recomendaciones, etc"
                  style={textareaStyle}
                />
                <Contador n={notasGerente.length} />
              </fieldset>

              <fieldset style={{ border: 'none', padding: 0, margin: '24px 0 0' }}>
                <legend style={legendStyle}>Enviar reporte a</legend>
                <input
                  type="email"
                  required
                  value={emailDestino}
                  onChange={(e) => setEmailDestino(e.target.value)}
                  onBlur={() => setTocoEmail(true)}
                  placeholder="correo@ejemplo.com"
                  aria-invalid={tocoEmail && !emailValido ? 'true' : 'false'}
                  aria-describedby="email-destino-ayuda"
                  style={{
                    ...inputStyle,
                    borderColor: tocoEmail && !emailValido ? C.bad : 'rgba(255,255,255,.12)'
                  }}
                />
                <p
                  id="email-destino-ayuda"
                  style={{
                    margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.6,
                    color: tocoEmail && !emailValido ? C.bad : C.muted
                  }}
                >
                  {tocoEmail && !emailValido
                    ? 'Escribe un correo con formato válido (nombre@dominio.com).'
                    : 'La solicitud llega a este buzón. Cámbialo si le toca a otro gerente.'}
                </p>
              </fieldset>

              {resultado && !resultado.ok && (
                <div role="alert" style={{ ...alertBox(C.bad), marginTop: 20 }}>
                  <p style={{ margin: 0, fontWeight: 700, color: C.bad }}>No se pudo enviar</p>
                  <p style={{ margin: '8px 0 0', fontSize: 14, color: C.muted }}>{resultado.message}</p>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 24 }}>
                <button
                  type="submit"
                  className="vtc-btn vtc-btn-primary"
                  disabled={!puedeEnviar}
                  title={
                    competencias.length === 0 ? 'Marca al menos una competencia'
                      : !emailValido ? 'Escribe un correo de destino válido'
                        : undefined
                  }
                  style={{
                    ...btnPrimary,
                    opacity: puedeEnviar ? 1 : 0.45,
                    cursor: puedeEnviar ? 'pointer' : 'not-allowed'
                  }}
                >
                  {enviando ? 'Enviando…' : 'Solicitar reentrenamiento'}
                </button>
                <a
                  className="vtc-btn vtc-btn-ghost"
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
                ✓ Solicitud enviada a {(resultado.destinatarios || []).join(', ') || destinoTexto}
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
                Recibió el resumen del asesor, los scores de la sesión, las competencias marcadas con
                su score, las áreas críticas, tus notas para el colaborador, las notas para el gerente y el
                enlace al reporte completo.
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 20 }}>
                <a
                  className="vtc-btn vtc-btn-ghost"
                  href={`/player?conv=${encodeURIComponent(conv)}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                  style={btnGhost}
                >
                  Volver al reproductor
                </a>
                <button type="button" className="vtc-btn vtc-btn-ghost" onClick={() => setResultado(null)} style={btnGhost}>
                  Enviar otra solicitud
                </button>
              </div>
            </div>
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

/**
 * Contador de caracteres de un campo de notas.
 * Se pone rojo al tocar el tope para que se note por qué dejó de escribir:
 * el `maxLength` corta en silencio y sin aviso parece que el teclado falla.
 */
function Contador({ n, max = MAX_NOTAS }) {
  const lleno = n >= max;
  return (
    <p
      aria-live="polite"
      style={{
        margin: '6px 0 0', fontSize: 12, textAlign: 'right',
        color: lleno ? C.bad : C.muted, fontWeight: lleno ? 700 : 400
      }}
    >
      {n} / {max}{lleno ? ' — límite alcanzado' : ''}
    </p>
  );
}

/**
 * Color del score con los mismos cortes que el reporte, los gráficos y el
 * correo: verde ≥ 8 (meta VTC), naranja 6–7.99, rojo < 6. Un corte distinto
 * aquí haría que la misma competencia se leyera verde en un sitio y ámbar en
 * el otro.
 */
function scoreColor(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return C.goldSoft;
  if (n >= META) return C.goodLit;
  if (n >= 6) return C.warnLit;
  return C.badLit;
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

/** Campo de notas: arranca cómodo y crece hasta un techo, no hasta el infinito. */
const textareaStyle = {
  ...inputStyle,
  minHeight: 150,
  maxHeight: 400,
  resize: 'vertical',
  lineHeight: 1.6
};

const btnPrimary = {
  background: C.gold, color: C.bg, fontWeight: 700, fontSize: 14,
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