/**
 * N8N MAPPER — Transforma data de ElevenLabs → Variables del reporte
 *
 * Entrada: webhook body de ElevenLabs (o payload plano de N8N)
 * Salida: objeto con 60+ campos para renderizar el reporte HTML y el email
 */

const {
  formatTimezoneCancun,
  formatDateLocal,
  formatDateLong,
  formatDateTimeLong,
  formatDuracion
} = require('./email-sender');
const { buildReportLinks } = require('./report-links');

/**
 * Roster de respaldo — espejo del que valida /api/verify-employee.
 *
 * ¿Por qué duplicarlo aquí? Porque el agente de ElevenLabs devuelve muchas
 * veces SOLO el nombre de pila ("Christian"), y un reporte de RR. HH. sin
 * apellido no identifica a nadie. Con el número de empleado —que sí viaja
 * siempre desde el formulario— completamos el nombre a como está en nómina.
 *
 * Es un respaldo, no la autoridad: si el webhook trae el nombre completo, ese
 * manda. La verificación de acceso sigue viviendo en /api/verify-employee.
 */
const ROSTER = [
  { empleado_id: '1234567', nombre: 'Pablo Solar', departamento: 'Dirección', puesto: 'Master Closer / Trainer' },
  { empleado_id: '123456', nombre: 'Christian Soria', departamento: 'Dirección', puesto: 'Closer' },
  { empleado_id: '12345', nombre: 'Andrés Mateos', departamento: 'Dirección', puesto: 'Senior Closer' }
];

function mapElevenLabsData(webhookBody) {
  const wh = webhookBody.body || webhookBody;

  // Helpers
  const v = (x, def) => (x == null || x === '') ? (def || '-') : String(x).trim();

  /**
   * Valor opcional: devuelve el dato REAL o `null`. Nunca un relleno.
   *
   * Es la pieza central de la regla "no inventar": este reporte lo lee Recursos
   * Humanos y la Dirección para decidir si un colaborador atiende clientes solo.
   * Un módulo que dice "Meet & Greet" porque ese era el default —y no porque el
   * agente lo haya reportado— es una afirmación falsa sobre lo que la persona
   * practicó. Un hueco se ve y se pregunta; un default se cree.
   */
  const opt = (x) => {
    if (x === null || x === undefined) return null;
    const s = String(x).trim();
    return s === '' || s === '-' ? null : s;
  };

  /** Registro de todo lo que el sistema NO recibió, para declararlo sin disimulo. */
  const sinDato = [];
  const exigir = (etiqueta, valor) => {
    if (valor === null || valor === undefined || valor === '') sinDato.push(etiqueta);
    return valor;
  };
  // OJO: `|| def` borraba los valores falsy legítimos — un score_overall de 0
  // se convertía en el default 8 y el reporte mentía. Solo undefined/null/''
  // cuentan como "sin dato".
  const safe = (obj, path, def) => {
    try {
      const val = path.split('.').reduce((acc, p) => (acc == null ? undefined : acc[p]), obj);
      return val === undefined || val === null || val === '' ? def : val;
    } catch {
      return def;
    }
  };

  // ===== DATOS BÁSICOS =====
  const conversationId = v(safe(wh, 'conversation_id', null), 'CONV-' + Date.now());
  // Identidad del asesor. Llega por DOS caminos y hay que aceptar los dos:
  //   1. `nombre`/`empleado_id`/`departamento` — lo que el empleado capturó en
  //      el formulario de /training, ya verificado contra el roster. Manda.
  //   2. `nombre_asesor`/`user_name`/… — lo que el agente recogió en la charla.
  // Antes solo se miraba (2) y por eso el PDF salía siempre con los defaults.
  const primero = (...claves) => {
    for (const k of claves) {
      const val = safe(wh, k, null);
      if (val === null || val === undefined || val === '') continue;
      const s = String(val).trim();
      // Variable dinámica sin resolver: es basura, no un dato.
      if (!s || /^\{\{.*\}\}$/.test(s)) continue;
      return s;
    }
    return null;
  };

  // Sin relleno "VTC-001": ese número no identifica a nadie en nómina y hace
  // que RR. HH. busque a un empleado que no existe.
  const empleado_id = exigir(
    'Número de empleado',
    opt(primero('empleado_id', 'employee_number', 'employee_id', 'numero_empleado'))
  );

  // Identidad completa: nombre de pila + apellido, siempre. Se resuelve contra
  // el roster cuando el agente solo mandó el nombre de pila. Ver resolveIdentity.
  const identidad = resolveIdentity({
    nombre: primero('nombre', 'nombre_completo', 'nombre_asesor', 'user_name', 'employee_name'),
    apellido: primero('apellido', 'apellidos', 'last_name', 'surname', 'apellido_paterno'),
    empleado_id
  });

  const nombre = exigir('Nombre del colaborador', identidad.nombre_completo);
  const nombre_completo = identidad.nombre_completo;
  const nombre_pila = identidad.nombre_pila;
  const apellido = identidad.apellido;

  // Departamento y puesto vienen del formulario o del roster. Si ninguno los
  // trae, quedan vacíos: "Dirección" por defecto asignaba a todo el mundo al
  // área del director general.
  const departamento = exigir(
    'Departamento',
    opt(primero('departamento', 'department', 'depto') || identidad.departamento)
  );
  const puesto = exigir(
    'Puesto',
    opt(primero('puesto', 'role', 'rol', 'position') || identidad.puesto)
  );
  const idioma = exigir('Idioma de la sesión', opt(safe(wh, 'idioma', null)));
  // El módulo es QUÉ se practicó. Suponerlo es describir un entrenamiento que
  // quizá no ocurrió.
  const modulo = exigir('Módulo', opt(safe(wh, 'modulo', null)));
  const familia_nombre = exigir('Escenario practicado', opt(safe(wh, 'familia_nombre', null)));

  // ===== FECHA Y HORA =====
  // Preferimos el inicio real de la conversación; si no viene, el momento de proceso.
  // Todo se expresa en America/Cancun: es el huso operativo del club.
  const sessionDate = resolveSessionDate(wh);
  const fecha_sesion = formatDateLocal(sessionDate);
  const fecha_larga = formatDateLong(sessionDate);
  const fecha_hora_larga = formatDateTimeLong(sessionDate);
  const hora_cancun = formatTimezoneCancun(sessionDate);
  const hora_sesion = hora_cancun;

  // ===== DURACIÓN =====
  // SIEMPRE medida, NUNCA estimada. Ver resolveDuracionSegundos.
  const duracion_sec = exigir('Duración', resolveDuracionSegundos(wh));
  const duracion_minutos = duracion_sec === null ? null : Math.floor(duracion_sec / 60);
  const duracion_seg = duracion_sec === null ? null : duracion_sec % 60;
  // "9:30" para tablas y métricas compactas...
  const duracion_texto = duracion_sec === null
    ? null
    : `${duracion_minutos}:${duracion_seg < 10 ? '0' : ''}${duracion_seg}`;
  // ...y en palabras para el correo y el PDF, donde "9:30" se lee como una hora.
  const duracion_humana = duracion_sec === null ? null : formatDuracion(duracion_sec);

  // ===== SCORES (0-10) =====
  // Siempre número finito dentro de [0,10]; si el agente manda string ("9") se convierte.
  const num = (x, def) => {
    // OJO: Number(null) === 0, así que hay que descartar vacíos ANTES de convertir.
    if (x === null || x === undefined || x === '') return def;
    const n = Number(x);
    if (!Number.isFinite(n)) return def;
    return Math.min(10, Math.max(0, n));
  };

  // Sin calificación del agente NO hay calificación. El 8 por defecto era la
  // mentira más cara del sistema: pintaba "Desempeño sólido · 80%" —con anillo
  // dorado, semáforo verde y certificación sugerida— sobre una sesión que
  // nadie evaluó. El gerente firmaba una autorización basada en un número que
  // el sistema se había inventado.
  const score_rapport = num(safe(wh, 'score_rapport', null), null);
  const score_pnl = num(safe(wh, 'score_pnl', null), null);
  const score_postura = num(safe(wh, 'score_postura', null), null);
  const score_objecciones = num(safe(wh, 'score_objecciones', null), null);
  const score_lectura_sala = num(safe(wh, 'score_lectura_sala', null), null);
  const score_cierre = num(safe(wh, 'score_cierre', null), null);
  const score_overall = exigir('Desempeño general', num(safe(wh, 'score_overall', null), null));

  const scoreTotal = score_overall === null ? null : Math.round((score_overall / 10) * 100);
  const mejora_potencial = scoreTotal === null ? null : `${Math.round(100 - scoreTotal)}%`;

  /** ¿Evaluó el agente esta sesión? De aquí cuelga TODO lo que es numérico. */
  const evaluacion_disponible = score_overall !== null;

  // ===== ANÁLISIS TEXTOS =====
  // Los defaults NO inventan observaciones. Antes decían cosas como
  // "Excelente calibración visual" aunque el agente no hubiera evaluado nada:
  // un reporte de coaching con hallazgos falsos es peor que uno vacío, porque
  // el gerente toma decisiones sobre él. Ahora el respaldo es neutro y se
  // apoya en las competencias reales de la sesión.
  // Ni siquiera un respaldo "neutro": "El cliente no planteó inquietudes" es una
  // AFIRMACIÓN sobre lo que pasó en la llamada. Si el agente no la hizo, el
  // sistema tampoco. Sin dato, el campo queda vacío y su sección desaparece.
  const fortalezas = opt(safe(wh, 'fortalezas', null));
  const areas_mejora = opt(safe(wh, 'areas_mejora', null));
  const analisis_pnl = opt(safe(wh, 'analisis_pnl', null));
  const objeciones_trabajadas = opt(safe(wh, 'objeciones_trabajadas', null));

  // ===== COMPETENCIAS (para gráficos) =====
  // Los nombres son los que LEE un director de hotel, no los del manual de
  // ventas: "Rapport" y "PNL" no significan nada fuera del área de capacitación,
  // y el reporte lo revisa Recursos Humanos, Dirección y el propio colaborador.
  // La equivalencia con el catálogo de entrenamiento vive en action-plan.js.
  //
  // Solo entran las competencias que el agente REALMENTE puntuó. Una barra
  // dibujada es una afirmación: si no hay nota, no hay barra.
  const competencias = [
    { name: 'Conexión', score: score_rapport },
    { name: 'Comunicación', score: score_pnl },
    { name: 'Presencia', score: score_postura },
    { name: 'Inquietudes', score: score_objecciones },
    { name: 'Percepción', score: score_lectura_sala },
    { name: 'Cierre', score: score_cierre }
  ].filter((c) => Number.isFinite(c.score));

  // slice() evita mutar `competencias` (los gráficos mantienen su orden original)
  const comp_baja = competencias.length
    ? competencias.slice().sort((a, b) => a.score - b.score)[0]
    : null;
  const comp_alta = competencias.length
    ? competencias.slice().sort((a, b) => b.score - a.score)[0]
    : null;

  // ===== RESUMEN (sección ANÁLISIS del email) =====
  // Si el agente entrega su propio resumen, ese manda: es análisis real de la
  // llamada. El generado es un respaldo con los datos duros de la sesión.
  //
  // El respaldo SOLO se arma con datos que existen: se enuncia hecho por hecho
  // y se omite lo que falte. Nunca se redacta "Sesión de 9 minutos 30 segundos
  // en el módulo Meet & Greet" cuando ni la duración ni el módulo se recibieron.
  const resumen = opt(
    safe(wh, 'resumen', null) || safe(wh, 'resumen_sesion', null) || safe(wh, 'analisis_general', null)
  ) || buildResumenFactual({
    nombre, duracion_humana, modulo, score_overall, scoreTotal, comp_alta, comp_baja
  });

  // ===== RECOMENDACIÓN DEL COACH =====
  // Dinámica: viene de la llamada cuando el agente la genera; si no, se
  // construye con los datos reales de esta sesión (nunca texto genérico).
  // Sin scores reales NO hay recomendación: aconsejar "está listo para atender
  // clientes de forma autónoma" a partir de un 8 inventado es el peor error
  // posible de este sistema.
  const recomendacion_coach = opt(
    safe(wh, 'recomendacion_coach', null)
      || safe(wh, 'recomendacion', null)
      || safe(wh, 'coach_recommendation', null)
  ) || (comp_alta && comp_baja && evaluacion_disponible
    ? buildRecomendacion(score_overall, comp_alta, comp_baja)
    : null);

  // ===== FUNDAMENTOS DE LA COMUNICACIÓN EFECTIVA =====
  // Los títulos y descripciones están escritos para que los entienda cualquier
  // colaborador del hotel. Los términos técnicos del manual de ventas —"sistema
  // límbico", "submodalidades", "reencuadre"— no aportan nada a quien lee el
  // reporte y sí generan la impresión de un diagnóstico clínico.
  //
  // ⚠️ Aquí vivían CINCO párrafos fijos que narraban una sesión imaginaria:
  // "El colaborador logró que la familia hablara de sus planes de viaje", "se
  // retomaron recuerdos familiares", "el tono se adaptó al del cliente"… Se
  // imprimían idénticos en TODOS los reportes, incluida una llamada de catorce
  // segundos donde nada de eso ocurrió. Era observación de conducta fabricada
  // sobre una persona real, dentro de un documento de RR. HH.
  //
  // Sin datos del agente, la sección 04 del reporte simplemente no existe
  // (el template ya la envuelve en {{#if principios_neuro}}).
  const principios_neuro = normalizePrincipios(safe(wh, 'principios_neuro', null)) || [];

  // El agente manda este valor a veces en escala 0-10 y a veces como porcentaje.
  // El reporte siempre lo pinta como % (ancho de barra), así que normalizamos aquí.
  // Sin dato: null — el 85% fijo era una calificación metodológica inventada.
  const rawCumplimiento = Number(safe(wh, 'cumplimiento_neuro', null));
  const cumplimiento_neuro = Number.isFinite(rawCumplimiento) && rawCumplimiento > 0
    ? Math.round(rawCumplimiento <= 10 ? rawCumplimiento * 10 : Math.min(100, rawCumplimiento))
    : null;

  // ===== PROGRESIÓN Y CONTEXTO DE LA SESIÓN =====
  // Campos que enriquecen el análisis de cómo fue la llamada
  const session_progression = safe(wh, 'session_progression', null);
  const objections_count = num(safe(wh, 'objections_count', null), null);
  const pnl_techniques_used = safe(wh, 'pnl_techniques_used', null);
  const prospect_engagement = safe(wh, 'prospect_engagement', null);
  const next_steps_agreed = safe(wh, 'next_steps_agreed', null);
  const identified_risks = safe(wh, 'identified_risks', null);
  const interaction_quality = safe(wh, 'interaction_quality', null);
  const conversion_potential = safe(wh, 'conversion_potential', null);
  const call_efficiency = safe(wh, 'call_efficiency', null);
  const coach_notes = safe(wh, 'coach_notes', null);

  // ===== PLAN DE DESARROLLO PROFESIONAL =====
  // Un plan de certificación construido sobre notas inventadas certifica a
  // gente que nadie evaluó. Sin scores reales no hay plan.
  const hayPlan = evaluacion_disponible && comp_alta && comp_baja;

  const plan_1 = hayPlan
    ? `Desempeño general: ${score_overall}/10 (${scoreTotal}%). Fortaleza que más destaca: ${comp_alta.name} `
      + `(${comp_alta.score}/10). Competencia con mayor oportunidad de mejora: ${comp_baja.name} (${comp_baja.score}/10).`
    : null;

  const plan_2 = hayPlan
    ? `Acompañamiento dirigido en ${comp_baja.name}: 3 sesiones de 20 minutos cada una, con dos prácticas diarias `
      + `como mínimo. Objetivo: llevar ${comp_baja.name} de ${comp_baja.score}/10 al nivel esperado de 8/10 en 7 días.`
    : null;

  const plan_3 = hayPlan
    ? `Evaluación completa a los 7 días. Si todas las competencias alcanzan 8/10 o más, el colaborador queda `
      + `certificado para atender clientes de forma autónoma. En caso contrario, se extiende el acompañamiento 3 días adicionales.`
    : null;

  // ===== ACTIVIDAD DE LA SESIÓN =====
  // El respaldo describía "las cuatro etapas de la conversación" y "las
  // inquietudes planteadas por el cliente" en sesiones donde no hubo ni una
  // cosa ni la otra. Ahora solo se enuncian los hechos que constan.
  const actividad_sesion = opt(safe(wh, 'actividad_sesion', null))
    || buildActividadFactual({ nombre, modulo, duracion_humana, familia_nombre });

  // ===== TRANSCRIPCIÓN =====
  let transcription = [];
  const turns = safe(wh, 'transcript_turns', null);
  if (Array.isArray(turns) && turns.length) {
    transcription = turnsToBubbles(turns, nombre, familia_nombre);
  } else if (safe(wh, 'transcript', null)) {
    transcription = parseTranscript(safe(wh, 'transcript', ''), nombre, familia_nombre, duracion_sec);
  }

  // ===== URLS (para CTAs) =====
  // Firmadas: atan el enlace a ESTE conversation_id y caducan.
  // Ver src/server/report-links.js.
  const { pop_up_url, pdf_download_url, audio_download_url, retrain_url } =
    buildReportLinks(conversationId);

  // ===== RETORNAR OBJETO COMPLETO =====
  return {
    // IDs
    conversationId,
    // `nombre` ES el nombre completo: todo lo que ya lo consumía (correo, PDF,
    // reentrenamiento) pasa a mostrar nombre y apellido sin tocar nada más.
    nombre,
    nombre_completo,
    nombre_pila,
    apellido,
    empleado_id,
    departamento,
    puesto,
    idioma,
    modulo,
    familia_nombre,

    // Fecha/Hora (todo en America/Cancun)
    fecha_sesion,
    fecha_larga,
    fecha_hora_larga,
    hora_sesion,
    hora_cancun,
    session_iso: sessionDate.toISOString(),
    duracion_texto,
    duracion_humana,
    duracion_minutos,
    duracion_sec,

    // Scores
    score_rapport,
    score_pnl,
    score_postura,
    score_objecciones,
    score_lectura_sala,
    score_cierre,
    score_overall,
    scoreTotal,
    mejora_potencial,

    // Análisis
    resumen,
    recomendacion_coach,
    fortalezas,
    areas_mejora,
    analisis_pnl,
    objeciones_trabajadas,
    actividad_sesion,

    // Listas normalizadas (presentación en el reporte)
    fortalezas_list: splitItems(fortalezas),
    areas_list: splitItems(areas_mejora),
    objeciones_list: splitItems(objeciones_trabajadas, true),

    // Competencias (para gráficos)
    competencias,
    comp_baja: comp_baja ? comp_baja.name : null,
    comp_alta: comp_alta ? comp_alta.name : null,

    // Neurociencia
    principios_neuro,
    cumplimiento_neuro,

    // Plan
    plan_1,
    plan_2,
    plan_3,

    // Transcripción
    transcription,

    // URLs
    pop_up_url,
    pdf_download_url,
    audio_download_url,
    retrain_url,

    // Contexto adicional de la sesión (nuevos campos de ElevenLabs)
    session_progression,
    objections_count,
    pnl_techniques_used,
    prospect_engagement,
    next_steps_agreed,
    identified_risks,
    interaction_quality,
    conversion_potential,
    call_efficiency,
    coach_notes,

    // ===== TRANSPARENCIA DE DATOS =====
    // `evaluacion_disponible` gobierna todo lo numérico del reporte y del
    // correo. `campos_sin_dato` se declara explícitamente: el lector tiene
    // derecho a saber qué NO se midió, en vez de leer un relleno como si fuera
    // un hallazgo.
    evaluacion_disponible,
    campos_sin_dato: sinDato,

    // Metadata
    timestamp: new Date().toISOString(),
    version: 'v3.3',

    // ===== CONTEXTO DEL AGENTE (KB + RAG) =====
    // Enriquecimiento desde el snapshot del agente ElevenLabs.
    // Permite al reporte mostrar contra qué guion se evaluó al asesor.
    agente: agentContext(modulo)
  };
}

/**
 * Resuelve la identidad del asesor a nombre COMPLETO.
 *
 * El problema real: el agente de voz suele devolver "Christian" y el reporte
 * salía a nombre de "Christian" — que en una plantilla de cuarenta personas no
 * identifica a nadie. El correo, el PDF y el archivo adjunto tienen que decir
 * "Christian Soria".
 *
 * Cascada, de más fiable a menos:
 *   1. Nombre + apellido llegan por separado  → se unen.
 *   2. El nombre ya trae apellido             → se respeta tal cual.
 *   3. Solo nombre de pila → se completa desde el roster, casando primero por
 *      número de empleado (dato duro del formulario) y, si no, por nombre.
 *   4. Nada casa → se devuelve lo que haya, sin inventar apellidos.
 *
 * @param {{nombre:?string, apellido:?string, empleado_id:?string}} input
 * @returns {{nombre_completo:string, nombre_pila:string, apellido:string,
 *            departamento:?string, puesto:?string}}
 */
function resolveIdentity(input) {
  const limpio = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  const nombreRaw = limpio(input && input.nombre);
  const apellidoRaw = limpio(input && input.apellido);
  const idRaw = limpio(input && input.empleado_id);

  // 1 + 2: lo que ya viene con apellido no se toca.
  let completo = apellidoRaw && !nombreRaw.toLowerCase().endsWith(apellidoRaw.toLowerCase())
    ? `${nombreRaw} ${apellidoRaw}`.trim()
    : nombreRaw;

  const ficha = matchRoster(idRaw, completo);

  // 3: solo hay nombre de pila y el roster sabe el apellido.
  if (ficha && completo.split(' ').filter(Boolean).length < 2) {
    completo = ficha.nombre;
  }
  // Sin nombre utilizable, el roster manda (el id sí es un dato duro).
  if (!completo && ficha) completo = ficha.nombre;

  const partes = completo.split(' ').filter(Boolean);

  // Sin nombre NO se inventa uno. "Asesor VTC" en la portada de un reporte de
  // RR. HH. parece un colaborador llamado así; el hueco, en cambio, obliga a
  // revisar por qué el formulario no mandó la identidad.
  return {
    nombre_completo: completo || null,
    nombre_pila: partes[0] || null,
    apellido: partes.slice(1).join(' ') || null,
    departamento: ficha ? ficha.departamento : null,
    puesto: ficha ? ficha.puesto : null
  };
}

/** Busca la ficha del roster por número de empleado y, en su defecto, por nombre. */
function matchRoster(empleadoId, nombre) {
  const id = String(empleadoId || '').replace(/\D/g, '');
  if (id) {
    const porId = ROSTER.find((e) => e.empleado_id === id);
    if (porId) return porId;
  }

  const key = normKey(nombre);
  if (!key) return null;

  // Coincidencia exacta antes que por nombre de pila: si algún día entran dos
  // "Christian", el nombre completo desempata y el de pila ya no.
  const exacto = ROSTER.find((e) => normKey(e.nombre) === key);
  if (exacto) return exacto;

  const pila = key.split(' ')[0];
  const candidatos = ROSTER.filter((e) => normKey(e.nombre).split(' ')[0] === pila);
  return candidatos.length === 1 ? candidatos[0] : null;
}

/**
 * Determina el momento real de la sesión.
 * ElevenLabs expone el inicio en varios lugares según la versión del webhook.
 *
 * @param {object} wh
 * @returns {Date}
 */
function resolveSessionDate(wh) {
  const candidates = [
    wh && wh.session_start,
    wh && wh.start_time,
    wh && wh.metadata && wh.metadata.start_time_unix_secs,
    wh && wh.start_time_unix_secs,
    wh && wh.event_timestamp
  ];

  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;

    // Unix en segundos (ElevenLabs) vs milisegundos vs ISO string
    if (typeof c === 'number' || /^\d+$/.test(String(c))) {
      const n = Number(c);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
      continue;
    }

    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return new Date();
}

/**
 * Duración REAL de la sesión, en segundos. Nunca estimada.
 *
 * El fallo que corrige: antes solo se miraban `duracion_segundos` y
 * `call_duration_secs` en la RAÍZ del payload. ElevenLabs no los pone ahí — los
 * entrega dentro de `metadata`. Como nunca casaba ninguno, TODA sesión caía al
 * respaldo de 570 segundos y el reporte declaraba "9 minutos 30 segundos" para
 * una llamada de catorce segundos. Ese número recorría después el correo, el
 * PDF, las métricas por minuto y el plan de acompañamiento.
 *
 * Orden de preferencia, de más fiable a menos:
 *   1. El contador oficial de la llamada (raíz o `metadata`).
 *   2. El segundo del último turno registrado — no es una estimación: es el
 *      momento medido en que se produjo la última intervención.
 *   3. Nada. `null` significa "no se midió", y así se dice.
 *
 * @param {object} wh Payload del webhook ya aplanado
 * @returns {number|null} Segundos, o null si no hay medición
 */
function resolveDuracionSegundos(wh) {
  const meta = (wh && wh.metadata) || {};

  const candidatos = [
    wh && wh.duracion_segundos,
    wh && wh.call_duration_secs,
    wh && wh.call_duration_seconds,
    wh && wh.duration_seconds,
    meta.call_duration_secs,
    meta.call_duration_seconds,
    meta.duration_seconds,
    meta.duracion_segundos
  ];

  for (const c of candidatos) {
    if (c === null || c === undefined || c === '') continue;
    const n = Number(c);
    // > 0 a propósito: un contador en 0 es "no se registró", no una llamada
    // instantánea. Se deja caer al siguiente candidato.
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  // Medición desde los turnos: el instante del último mensaje de la llamada.
  const turns = wh && wh.transcript_turns;
  if (Array.isArray(turns) && turns.length) {
    const marcas = turns
      .map((t) => Number(t && (t.time_in_call_secs ?? t.time_in_call ?? t.start_time)))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (marcas.length) {
      const ultimo = Math.round(Math.max(...marcas));
      if (ultimo > 0) return ultimo;
    }
  }

  console.warn('[MAPPER] Sin duración medible: el reporte la declarará como no disponible');
  return null;
}

/**
 * Resumen de respaldo construido HECHO A HECHO.
 *
 * Solo enuncia lo que consta. Si únicamente se conoce el nombre, la frase habla
 * del nombre y de nada más; si no se conoce nada, devuelve null y la sección
 * queda vacía en lugar de describir una sesión que el sistema no presenció.
 *
 * @returns {string|null}
 */
function buildResumenFactual({ nombre, duracion_humana, modulo, score_overall, scoreTotal, comp_alta, comp_baja }) {
  const frases = [];

  const contexto = [
    nombre ? `con la participación de ${nombre}` : null,
    modulo ? `en el módulo ${modulo}` : null,
    duracion_humana ? `con una duración de ${duracion_humana}` : null
  ].filter(Boolean);

  if (contexto.length) frases.push(`Sesión de práctica ${contexto.join(', ')}.`);

  if (score_overall !== null && score_overall !== undefined) {
    frases.push(`Desempeño general de ${score_overall}/10 (${scoreTotal}%).`);
  }
  if (comp_alta) frases.push(`Fortaleza que más destaca: ${comp_alta.name} (${comp_alta.score}/10).`);
  if (comp_baja) {
    frases.push(`Competencia con mayor oportunidad de mejora: ${comp_baja.name} (${comp_baja.score}/10).`);
  }

  return frases.length ? frases.join(' ') : null;
}

/**
 * Actividad de la sesión, enunciada solo con los hechos recibidos.
 * Sin nombre ni módulo ni duración no hay nada que contar: devuelve null.
 *
 * @returns {string|null}
 */
function buildActividadFactual({ nombre, modulo, duracion_humana, familia_nombre }) {
  const partes = [];
  if (modulo) partes.push(`practicó el módulo ${modulo}`);
  if (duracion_humana) partes.push(`durante ${duracion_humana}`);
  if (familia_nombre) partes.push(`en el escenario de la familia ${familia_nombre}`);

  if (!partes.length) return null;
  return `${nombre || 'El colaborador'} ${partes.join(' ')}.`;
}

/**
 * Recomendación del coach derivada de los datos reales de la sesión.
 * Solo se usa si el agente no envió la suya.
 */
function buildRecomendacion(score, alta, baja) {
  if (score >= 8.5) {
    return `Desempeño general de ${score}/10: el colaborador está listo para atender clientes de forma autónoma. `
      + `Conviene aprovechar su fortaleza en ${alta.name} (${alta.score}/10) compartiendo la grabación como material `
      + `de referencia para el equipo. Único punto por seguir de cerca: ${baja.name} (${baja.score}/10), `
      + `que puede reforzarse durante la sesión semanal.`;
  }
  if (score >= 7) {
    return `Desempeño general de ${score}/10: base sólida con una oportunidad de mejora bien identificada. `
      + `Se recomienda concentrar el acompañamiento de los próximos 7 días en ${baja.name} (${baja.score}/10); `
      + `${alta.name} (${alta.score}/10) ya alcanza el nivel esperado y no requiere ajustes. `
      + `El avance se verifica al séptimo día.`;
  }
  return `Desempeño general de ${score}/10: el colaborador se encuentra en etapa de formación. `
    + `Se recomienda dar prioridad a ${baja.name} (${baja.score}/10) con acompañamiento diario, apoyándose en `
    + `${alta.name} (${alta.score}/10) como base de confianza. El progreso se verifica en 7 días con una práctica completa.`;
}

/**
 * Convierte un bloque de texto en lista de puntos limpios.
 * @param {string} text
 * @param {boolean} commaSplit Permite partir por comas si vino todo en una línea
 */
function splitItems(text, commaSplit = false) {
  if (!text) return [];

  let parts = String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .filter((p) => p && p.trim());

  // Muchos agentes devuelven "A, B, C" en una sola línea.
  // El lookahead evita partir dentro de un paréntesis: "Precio (valor, tiempo)".
  if (parts.length <= 1 && commaSplit) {
    parts = String(text).split(/,(?![^(]*\))/).filter((p) => p && p.trim());
  }

  return parts
    .map((p) => p.replace(/^\s*(?:[✓✔✅×✗•·▪▸►◆●○*\-–—]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean);
}

/**
 * Normaliza los principios neurocientíficos a [{titulo, descripcion}].
 * Acepta array de objetos, array de strings o string con saltos de línea.
 */
function normalizePrincipios(raw) {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    const items = raw
      .map((p) => {
        if (p && typeof p === 'object') {
          return {
            titulo: String(p.titulo || p.title || p.nombre || 'Principio'),
            descripcion: String(p.descripcion || p.description || p.detalle || '')
          };
        }
        const text = String(p || '').trim();
        if (!text) return null;
        const [titulo, ...rest] = text.split(/:\s*/);
        return { titulo, descripcion: rest.join(': ') || text };
      })
      .filter((p) => p && p.titulo);
    return items.length ? items : null;
  }

  if (typeof raw === 'string') {
    const items = splitItems(raw).map((line) => {
      const [titulo, ...rest] = line.split(/:\s*/);
      return { titulo, descripcion: rest.join(': ') || line };
    });
    return items.length ? items : null;
  }

  return null;
}

/**
 * Contexto del agente ElevenLabs para enriquecer el mapeo.
 * Degrada a un objeto vacío si el snapshot de KB no está disponible.
 *
 * @param {string} modulo Módulo detectado en la sesión
 */
function agentContext(modulo) {
  try {
    // require perezoso: si falta el JSON, el mapper sigue funcionando
    const { getAgentMeta, queryRAG } = require('./rag-query');
    const meta = getAgentMeta();
    const rag = modulo ? queryRAG(String(modulo), { topK: 3, maxChars: 3000 }) : { matches: [] };

    return {
      agent_id: meta.agent_id,
      agent_name: meta.agent_name,
      llm: meta.llm,
      rag_enabled: meta.rag_enabled,
      embedding_model: meta.embedding_model,
      kb_document: meta.kb_document,
      kb_chunks: meta.kb_chunks,
      kb_chars: meta.kb_chars,
      // Secciones de KB que corresponden al módulo evaluado
      kb_referencias: (rag.matches || []).map((m) => ({
        id: m.id,
        titulo: m.title,
        relevancia: m.score
      }))
    };
  } catch (error) {
    console.warn('[MAPPER] Contexto de agente no disponible:', error.message);
    return {};
  }
}

// ════════════════════════════════════════════
// TRANSCRIPCIÓN
// ════════════════════════════════════════════
//
// Regla de la transcripción del reporte: SOLO "hablante: lo que dijo".
//
// Lo que llegaba antes y ya no se pinta:
//   <Víctor English>: "Hola, estoy aquí..."   ->  Victor: Hola, estoy aquí...
//   [Usuario] (User): Quiero entrenarme       ->  Ana Torres: Quiero entrenarme
//
// El motivo no es estético. El PDF lo lee un gerente que no sabe qué es un
// "role" ni un tag SSML; cada símbolo de sistema en la página es ruido que le
// hace dudar de si eso lo dijo el asesor o lo escribió la máquina.

// ElevenLabs entrega los turnos con role "agent" / "user"
// Nombres conocidos (español e inglés): Victor, Carlos, Sandra, Carlitos, Jorge, James, Kelly, Tiffany, George
const AGENT_KEYS = ['victor', 'carlos', 'sandra', 'carlitos', 'jorge', 'james', 'kelly', 'tiffany', 'george', 'agent', 'assistant', 'ai', 'ia'];

/**
 * Etiquetas SSML que ElevenLabs deja dentro del mensaje del agente.
 * Se pronuncian, no se dicen: fuera del texto literal.
 */
const SSML_TAGS = /<\/?(?:break|speak|prosody|phoneme|emphasis|say-as|sub|lang|voice|audio|mark|s|p)\b[^>]*\/?>/gi;

/**
 * Sufijo de rol pegado al nombre: "Víctor English (Agent)".
 * El `(\S)` es obligatorio: sin él, "{agent}" (que es el nombre COMPLETO, no un
 * sufijo) se borraba entero y el turno se quedaba sin hablante.
 */
const ROLE_SUFFIX = /(\S)\s*[([{]\s*(?:agent|assistant|ai|bot|user|usuario|cliente|system|sistema|coach|speaker)\s*[)\]}]\s*$/i;

/** Etiqueta de hablante repetida DENTRO del propio mensaje. */
const INLINE_SPEAKER_TAG = /^\s*[<[{]\s*[^<>[\]{}\n]{1,60}\s*[>\]}]\s*:?\s*/;
const INLINE_ROLE_TAG = /^\s*[([{]\s*(?:agent|assistant|ai|ia|bot|user|usuario|cliente|system|sistema|coach|narrador|voz)\s*[)\]}]\s*:?\s*/i;

/** Marcadores de sistema que no son habla. */
const SYSTEM_MARKERS = /\[(?:tool[_ ]?call|tool[_ ]?result|function[_ ]?call|silence|silencio|inaudible|end[_ ]of[_ ]call|interrupted|noise)\]/gi;

/**
 * Todo lo que va entre corchetes.
 *
 * ElevenLabs incrusta ahí las acotaciones de dirección de voz ("[calmado]",
 * "[pausa larga]", "[risas]") y las etiquetas de hablante repetidas
 * ("[Usuario]"). Nada de eso se dijo en voz alta: son instrucciones para el
 * motor de síntesis. En un reporte que lee un director de hotel, "[calmado]
 * Buenas tardes" se interpreta como una anotación de auditoría sobre el
 * colaborador — que no existe.
 */
const BRACKET_BLOCK = /\[[^\]]*\]/g;

/** Bloques entre llaves: variables de plantilla sin resolver, nunca habla. */
const BRACE_BLOCK = /\{\{?[^{}]*\}?\}/g;

/** Pares de comillas que envuelven un turno completo. */
const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['«', '»'], ["'", "'"], ['‘', '’']];

/** Formatea segundos a "mm:ss". */
function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Clave de búsqueda estable: sin acentos, sin mayúsculas, sin espacios sobrantes. */
function normKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Deja el nombre del hablante limpio: sin envoltorios ni sufijos de rol.
 *
 * "<Víctor English>"   -> "Víctor English"
 * "[Usuario]"          -> "Usuario"
 * "Ana Torres (User)"  -> "Ana Torres"
 * "**agent**:"         -> "agent"
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanSpeakerLabel(raw) {
  let s = String(raw == null ? '' : raw).trim();

  // Énfasis de markdown que a veces viene en los transcripts exportados
  s = s.replace(/[*_`]+/g, '');
  // Sufijo de rol ANTES de tocar los envoltorios: si primero quitáramos el
  // paréntesis de cierre, "Ana Torres (User)" quedaría en "Ana Torres (User".
  s = s.replace(ROLE_SUFFIX, '$1');
  // Envoltorios: <>, [], {}, (), comillas
  s = s.replace(/^[<[{("'«“‘\s]+/, '').replace(/[>\]})"'»”’\s]+$/, '');
  // Y otra vez, por si el rol venía dentro del envoltorio: "<Ana (User)>"
  s = s.replace(ROLE_SUFFIX, '$1');
  // Puntuación residual en los extremos
  s = s.replace(/^[\s:;.,–—-]+/, '').replace(/[\s:;.,–—-]+$/, '');

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Quita las comillas que envuelven un turno entero, sin tocar las que forman
 * parte de lo que se dijo.
 *
 * '"Hola"'            -> 'Hola'
 * 'Él dijo "hola"'    -> 'Él dijo "hola"'   (no empieza con comilla: no se toca)
 * '"Él dijo "hola""'  -> se deja igual: el interior tiene comillas sin balancear
 */
function stripWrappingQuotes(text) {
  let t = String(text).trim();

  // Hasta dos capas: '"«texto»"' aparece en algunos exports
  for (let capa = 0; capa < 2; capa++) {
    let cambio = false;

    for (const [abre, cierra] of QUOTE_PAIRS) {
      if (t.length > abre.length + cierra.length && t.startsWith(abre) && t.endsWith(cierra)) {
        const interior = t.slice(abre.length, t.length - cierra.length);
        if (!interior.includes(abre) && !interior.includes(cierra)) {
          t = interior.trim();
          cambio = true;
          break;
        }
      }
    }

    if (!cambio) break;
  }

  return t;
}

/**
 * Texto literal del turno: lo que se dijo en voz alta, nada más.
 *
 * Elimina, en este orden y de forma exhaustiva:
 *   1. Todo lo que va entre `<` y `>`, incluidos los símbolos.
 *   2. Todo lo que va entre `[` y `]`, incluidos los símbolos.
 *   3. Variables de plantilla sin resolver entre llaves.
 *   4. Etiquetas de rol al inicio del mensaje: "(IA):", "(User):", "(Agent):".
 *   5. Las comillas que envuelven la frase completa.
 *
 * La limpieza es iterativa a propósito: un mensaje con anidamiento
 * ("[tono <suave>] Buenas tardes") necesita más de una pasada, y la validación
 * final garantiza que ningún símbolo de sistema llegue al documento impreso.
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanTurnText(raw) {
  let t = String(raw == null ? '' : raw);
  let prevLength;

  // 1 · Todo entre < y >, símbolos incluidos.
  do {
    prevLength = t.length;
    t = t.replace(/<[^>]*>/g, ' ');
  } while (t.length < prevLength && t.includes('<'));

  // 2 · Todo entre [ y ], símbolos incluidos. Acotaciones de voz y etiquetas
  //     de hablante repetidas: "[calmado] Hola" -> "Hola".
  do {
    prevLength = t.length;
    t = t.replace(BRACKET_BLOCK, ' ');
  } while (t.length < prevLength && t.includes('['));

  // 3 · Variables de plantilla sin resolver.
  do {
    prevLength = t.length;
    t = t.replace(BRACE_BLOCK, ' ');
  } while (t.length < prevLength && t.includes('{'));

  t = t.replace(SSML_TAGS, ' ');
  t = t.replace(SYSTEM_MARKERS, ' ');
  t = t.replace(INLINE_SPEAKER_TAG, '');
  t = t.replace(INLINE_ROLE_TAG, '');

  // Resto del separador que unía la etiqueta con la frase.
  //
  // Caso real: `<Víctor English>: "Buenas tardes"`. Los pasos 1 y 2 ya se
  // llevaron el `<…>`, así que INLINE_SPEAKER_TAG —que espera encontrar el
  // envoltorio COMPLETO— ya no reconoce nada y los dos puntos se quedan
  // huérfanos: el reporte imprimía `: "Buenas tardes"`. Se limpia después de
  // borrar las etiquetas y ANTES de las comillas, para que la frase vuelva a
  // empezar por comilla y stripWrappingQuotes pueda hacer su trabajo.
  t = t.replace(/^[\s:;,.–—-]+/, '');

  t = stripWrappingQuotes(t);

  let cleaned = t
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')   // el hueco que dejó la etiqueta borrada
    .replace(/\s*\n\s*/g, '\n')
    .trim();

  // VALIDACIÓN ESTRICTA: ningún símbolo de sistema puede llegar al documento.
  if (/[<>[\]]/.test(cleaned)) {
    console.error('[TRANSCRIPT] Símbolos de sistema residuales, se eliminan:', cleaned.slice(0, 120));
    cleaned = cleaned.replace(/[<>[\]]/g, '').replace(/[ \t]+/g, ' ').trim();
  }

  return cleaned;
}

/**
 * Etiquetas de cada lado de la conversación.
 *
 * En ElevenLabs el rol `user` es quien habla al micrófono — el asesor en
 * entrenamiento — y `agent` es la IA que interpreta al cliente/coach.
 *
 * Caso borde real: el agente se llama "Coach VICTOR" y el asesor evaluado
 * también puede llamarse Victor. Si los nombres chocan, desambiguamos el lado
 * de la IA; si no, el reporte muestra dos "VICTOR" y es ilegible.
 *
 * Todas las claves van normalizadas (sin acentos, en minúsculas) para que
 * "Víctor", "VICTOR" y "victor" resuelvan al mismo lado.
 */
function speakerMap(asesorName, familyName) {
  const asesor = cleanSpeakerLabel(asesorName) || 'Asesor';
  const asesorKey = normKey(asesor);
  const familia = cleanSpeakerLabel(familyName) || 'Familia';

  const agentLabel = (persona) =>
    normKey(persona) === asesorKey ? `${persona} (IA)` : persona;

  return {
    // Nombres conocidos del agente (tanto español como inglés)
    victor: agentLabel('Victor'),
    carlos: agentLabel('Carlos'),
    sandra: agentLabel('Sandra'),
    carlitos: agentLabel('Carlitos'),
    jorge: agentLabel('Jorge'),
    james: agentLabel('James'),
    kelly: agentLabel('Kelly'),
    tiffany: agentLabel('Tiffany'),
    george: agentLabel('George'),
    // Mapeos de rol genéricos. "ia" incluida: el agente a veces se anuncia como
    // "(IA):" y sin esta entrada el reporte imprimía un hablante llamado "IA",
    // que para el lector es un participante más de la conversación.
    agent: agentLabel('Victor'),
    assistant: agentLabel('Victor'),
    ai: agentLabel('Victor'),
    ia: agentLabel('Victor'),
    // Familia/Cliente
    familia,
    [normKey(familia)]: familia,
    usuario: asesor,
    user: asesor,
    // El asesor manda sobre cualquier colisión: es el evaluado.
    [asesorKey]: asesor
  };
}

/**
 * Resuelve un hablante crudo al nombre que se pinta en el reporte.
 *
 * Estrategia en cascada:
 *   1. Nombre completo normalizado  ("víctor english" -> no está en el mapa)
 *   2. Primera palabra               ("victor" -> Victor, el agente)
 *   3. El nombre limpio tal cual     (nunca la etiqueta cruda con símbolos)
 *
 * @returns {{label:string, isAgent:boolean}}
 */
function resolveSpeaker(rawSpeaker, speakers) {
  const limpio = cleanSpeakerLabel(rawSpeaker);
  const key = normKey(limpio);

  if (key && speakers[key]) {
    return { label: speakers[key], isAgent: AGENT_KEYS.includes(key) };
  }

  const primera = key.split(/[\s_.\-/]+/)[0];
  if (primera && speakers[primera]) {
    return { label: speakers[primera], isAgent: AGENT_KEYS.includes(primera) };
  }

  return { label: limpio || 'Participante', isAgent: AGENT_KEYS.includes(primera) };
}

/**
 * Convierte los turnos crudos de ElevenLabs en burbujas de chat.
 * Ventaja sobre parseTranscript: conserva el timestamp real del turno.
 *
 * @param {Array<{role?:string, message?:string, time_in_call_secs?:number}>} turns
 */
function turnsToBubbles(turns, asesorName, familyName) {
  const SPEAKERS = speakerMap(asesorName, familyName);

  return turns
    .map((turn) => {
      const rawSpeaker = turn.role || turn.speaker || turn.source || 'agent';
      const text = cleanTurnText(turn.message || turn.text || turn.content || '');
      if (!text) return null;

      // El rol crudo manda para decidir el lado: es el dato de ElevenLabs, no
      // una inferencia sobre el nombre.
      const rolKey = normKey(cleanSpeakerLabel(rawSpeaker));
      const { label } = resolveSpeaker(rawSpeaker, SPEAKERS);
      const isAgent = AGENT_KEYS.includes(rolKey) || AGENT_KEYS.includes(rolKey.split(/[\s_.\-/]+/)[0]);

      const secs = turn.time_in_call_secs ?? turn.time_in_call ?? turn.start_time ?? null;

      return {
        speaker: label,
        text,
        timestamp: secs != null ? mmss(secs) : '',
        side: isAgent ? 'right' : 'left',
        type: isAgent ? 'agent' : 'user'
      };
    })
    .filter(Boolean);
}

/**
 * Parsear transcript en texto plano ("Speaker: mensaje") y crear burbujas.
 * Los timestamps se estiman repartiendo la duración real entre los turnos —
 * si se conoce la duración; en otro caso quedan vacíos (mejor nada que un dato falso).
 *
 * Una línea sin ":" no se descarta: se anexa al turno anterior. Antes se perdía,
 * y con ella los párrafos largos que el agente parte en varias líneas.
 *
 * @param {string} transcriptText
 * @param {string} asesorName
 * @param {string} familyName
 * @param {number} [duracionSec] Duración real de la llamada en segundos
 */
function parseTranscript(transcriptText, asesorName, familyName, duracionSec) {
  const bubbles = [];
  const lines = String(transcriptText == null ? '' : transcriptText)
    .split('\n')
    .filter((l) => l.trim());
  const SPEAKERS = speakerMap(asesorName, familyName);

  for (const line of lines) {
    // El hablante nunca lleva ":" dentro, así que el primer ":" separa. El
    // límite de 60 caracteres evita que una frase con dos puntos ("Mira: ya
    // lo hablamos") se lea como un hablante nuevo.
    const match = line.match(/^\s*([^:\n]{1,60}?)\s*:\s*(.+)$/);

    if (!match) {
      // Continuación del turno anterior (párrafo partido en varias líneas)
      const previo = bubbles[bubbles.length - 1];
      const extra = cleanTurnText(line);
      if (previo && extra) previo.text = `${previo.text} ${extra}`.trim();
      continue;
    }

    const [, speaker, text] = match;
    const limpio = cleanTurnText(text);
    if (!limpio) continue;

    const { label, isAgent } = resolveSpeaker(speaker, SPEAKERS);

    bubbles.push({
      speaker: label,
      text: limpio,
      timestamp: '',
      side: isAgent ? 'right' : 'left',
      type: isAgent ? 'agent' : 'user'
    });
  }

  // Los timestamps se reparten sobre los turnos REALES (no sobre las líneas
  // crudas): con líneas de continuación, el índice de línea mentía.
  const total = Number(duracionSec);
  if (Number.isFinite(total) && total > 0 && bubbles.length > 1) {
    bubbles.forEach((b, i) => {
      b.timestamp = mmss((i / (bubbles.length - 1)) * total);
    });
  }

  return bubbles;
}

module.exports = {
  mapElevenLabsData,
  parseTranscript,
  turnsToBubbles,
  splitItems,
  resolveSessionDate,
  resolveDuracionSegundos,
  resolveIdentity,
  // Exportados para pruebas y para el reproductor
  cleanSpeakerLabel,
  cleanTurnText,
  stripWrappingQuotes
};