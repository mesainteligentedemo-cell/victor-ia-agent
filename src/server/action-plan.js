/**
 * ACTION PLAN — Plan de acción expandido para el gerente
 *
 * ¿Por qué existe?
 *   El reporte traía tres frases sueltas (plan_1, plan_2, plan_3). Con eso el
 *   gerente sabía QUÉ estaba mal, pero no QUÉ HACER el lunes por la mañana.
 *   Este módulo convierte los mismos datos de la sesión en un plan operable:
 *
 *     A) Diagnóstico completo        — 7 lecturas del desempeño
 *     B) Plan de mejora por competencia — técnica, ejercicios, dosis y meta
 *     C) Hitos y validaciones        — calendario con métrica por hito
 *     D) Criterios de aprobación     — reglas de decisión, no opiniones
 *     E) Próximos pasos del gerente  — hoy, monitoreo, reevaluación, escalado
 *     F) Notas de coaching           — observaciones y patrones detectados
 *
 * Regla dura: NADA se inventa. Cada número sale de las competencias reales de
 * la sesión. Los textos son plantillas que se rellenan con esos números; si no
 * hay dato, la línea no se emite (mejor una sección corta que un dato falso).
 *
 * Handlebars no hace aritmética: todo llega precalculado y listo para pintar.
 */

const { formatDateLocal, formatDateLong } = require('./email-sender');

/** Estándar VTC: por debajo de esto no se autoriza piso de ventas. */
const META = 8;

/** Ganancia media por sesión de coaching de 25 min, medida en el programa. */
const GANANCIA_POR_SESION = 0.4;

const DIA_MS = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════
// CATÁLOGO DE INTERVENCIÓN POR COMPETENCIA
// Cada entrada define CÓMO se entrena esa competencia, no solo que hay que
// entrenarla. Los ejercicios son ejecutables tal cual por el coach.
// ════════════════════════════════════════════════════════════

const CATALOGO = {
  rapport: {
    tecnica: 'Construcción de confianza desde el primer contacto',
    ejercicios: [
      'Sintonía con el interlocutor: durante los primeros 90 segundos, acompasar la postura y el ritmo del habla del cliente, y retomar una palabra que él mismo haya utilizado. Registrar la práctica y contar cuántas veces se logra.',
      'Apertura centrada en la persona: dedicar los primeros cuatro minutos a conocer al cliente sin mencionar el resort. El objetivo es que comparta algo personal de forma espontánea.',
      'Uso del nombre: mencionar el nombre del cliente tres veces durante la bienvenida, distribuidas a lo largo de la conversación y nunca de forma consecutiva.'
    ],
    metrica: 'Minutos transcurridos hasta que el cliente comparte algo personal (objetivo: menos de 4 minutos)',
    senal: 'El cliente formula preguntas que van más allá del precio'
  },
  pnl: {
    tecnica: 'Lenguaje de valor y construcción de imágenes positivas',
    ejercicios: [
      'Repertorio de respuestas de valor: redactar diez inquietudes frecuentes junto con la manera de presentarlas como una inversión en tiempo familiar, y practicarlas hasta expresarlas con naturalidad.',
      'Proyección de la experiencia: invitar al cliente a describir sus vacaciones ideales y devolverle esa misma imagen con mayor detalle, color y cercanía.',
      'Momento memorable: identificar el punto de mayor entusiasmo de la conversación y retomarlo con la misma expresión al momento de concluir.'
    ],
    metrica: 'Respuestas de valor aplicadas por sesión (objetivo: 3 o más)',
    senal: 'El cliente repite con sus propias palabras el beneficio planteado'
  },
  postura: {
    tecnica: 'Presencia, seguridad y manejo de las pausas',
    ejercicios: [
      'Revisión del video sin audio durante cinco minutos: identificar los gestos que restan seguridad, como brazos cruzados, hombros caídos o mirada baja.',
      'Pausa de tres segundos después de cada pregunta importante, sin llenar el silencio con explicaciones adicionales.',
      'Ensayo frente al espejo: presentar el mismo contenido con tres niveles distintos de energía y elegir el más adecuado para cada tipo de cliente.'
    ],
    metrica: 'Gestos que restan seguridad por cada 10 minutos de conversación (objetivo: ninguno)',
    senal: 'El colaborador sostiene la pausa con naturalidad, sin necesidad de justificarse'
  },
  objeciones: {
    tecnica: 'Escuchar, comprender, aportar valor y retomar la conversación',
    ejercicios: [
      'Práctica de respuesta ágil: el facilitador plantea diez inquietudes seguidas y el colaborador responde en menos de cinco segundos aplicando los cuatro pasos de la metodología.',
      'Comprender antes de responder: no abordar el tema del precio hasta haber confirmado con el cliente si ese es realmente el único punto por resolver.',
      'Respuestas modelo: tomar las tres inquietudes que quedaron menos resueltas en esta sesión y redactar la respuesta ideal palabra por palabra.'
    ],
    metrica: 'Inquietudes resueltas manteniendo el valor de la oferta (objetivo: 80% o más)',
    senal: 'La misma inquietud no vuelve a plantearse durante la conversación'
  },
  'lectura sala': {
    tecnica: 'Lectura de las señales del cliente y ajuste en tiempo real',
    ejercicios: [
      'Evaluación por etapas: pausar la grabación cada dos minutos y clasificar la disposición del cliente en alta, media o baja. Contrastar la lectura con el facilitador.',
      'Identificar cinco señales de interés en la grabación de otro colaborador e indicar el momento exacto en que aparecieron.',
      'Confirmar el avance con una pregunta abierta —"¿cómo lo ve hasta aquí?"— en cada cambio de etapa, sin excepción.'
    ],
    metrica: 'Aciertos al evaluar la disposición del cliente (objetivo: 8 de cada 10)',
    senal: 'El colaborador ajusta su enfoque antes de que el cliente pierda interés'
  },
  cierre: {
    tecnica: 'Conclusión natural a partir de acuerdos parciales',
    ejercicios: [
      'Practicar tres formas distintas de concluir con el mismo cliente: por confirmación, por elección entre opciones y por oportunidad real.',
      'Sustituir la pregunta "¿qué le parece?" por una pregunta que invite a tomar una decisión concreta.',
      'Construir el acuerdo por partes: obtener tres confirmaciones parciales del cliente antes de proponer la decisión final.'
    ],
    metrica: 'Propuestas de conclusión por sesión (objetivo: 3 o más, cada una con un enfoque distinto)',
    senal: 'El cliente pregunta por condiciones y formas de pago en lugar de pedir tiempo para pensarlo'
  }
};

/**
 * Equivalencia entre el nombre que LEE el director y la clave del catálogo.
 *
 * El reporte dejó de hablar de "Rapport" y "PNL" — son términos del manual de
 * ventas, no del vocabulario de un hotel de 20,000 colaboradores. El catálogo
 * de entrenamiento sí conserva sus claves internas, así que aquí se traduce.
 *
 * Se aceptan LAS DOS familias de nombres a propósito: los reportes archivados y
 * las integraciones ya en marcha siguen enviando los nombres antiguos, y si
 * dejaran de resolver, el plan caería a la intervención genérica y el gerente
 * perdería los ejercicios concretos sin que nada avisara.
 */
const ALIAS_COMPETENCIA = {
  // Nombres actuales del reporte
  'conexion': 'rapport',
  'comunicacion': 'pnl',
  'presencia': 'postura',
  'inquietudes': 'objeciones',
  'percepcion': 'lectura sala',
  'cierre': 'cierre',
  // Nombres históricos (payloads y reportes anteriores)
  'rapport': 'rapport',
  'pnl': 'pnl',
  'postura': 'postura',
  'objeciones': 'objeciones',
  'lectura sala': 'lectura sala',
  'lectura de sala': 'lectura sala'
};

/** Clave de catálogo de una competencia, sea cual sea el nombre con que llegue. */
function claveCompetencia(nombre) {
  const limpio = String(nombre == null ? '' : nombre)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_COMPETENCIA[limpio] || limpio;
}

/** Recomendación general cuando la competencia no está en el catálogo. */
function intervencionGenerica(nombre) {
  return {
    tecnica: `Práctica dirigida de ${nombre} con grabación y retroalimentación`,
    ejercicios: [
      `Trabajar ${nombre} de forma aislada en prácticas breves de 10 minutos, enfocadas únicamente en esa competencia.`,
      `Revisar junto con el colaborador dos momentos de esta grabación donde ${nombre} puede mejorar, y ensayar en voz alta la versión ideal.`,
      `Cerrar cada sesión con una práctica completa y cronometrada, sin intervenciones del facilitador.`
    ],
    metrica: `Nivel de ${nombre} alcanzado en la práctica de verificación (objetivo: ${META}/10)`,
    senal: 'El colaborador sostiene el desempeño sin necesidad de apoyo del facilitador'
  };
}

// ════════════════════════════════════════════════════════════
// HELPERS NUMÉRICOS
// ════════════════════════════════════════════════════════════

const r1 = (n) => Math.round(Number(n) * 10) / 10;

function promedio(valores) {
  if (!valores.length) return 0;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/** Desviación estándar poblacional: mide qué tan irregular es el perfil. */
function desviacion(valores) {
  if (valores.length < 2) return 0;
  const m = promedio(valores);
  return Math.sqrt(promedio(valores.map((v) => (v - m) ** 2)));
}

/** Suma en español natural: "A, B y C". */
function enumerar(items) {
  const l = items.filter(Boolean);
  if (!l.length) return '';
  if (l.length === 1) return l[0];
  return `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`;
}

/** Fecha base de la sesión; cae a "ahora" si el payload no la trae. */
function fechaBase(data) {
  const raw = data && (data.session_iso || data.session_start);
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function sumarDias(fecha, dias) {
  return new Date(fecha.getTime() + dias * DIA_MS);
}

// ════════════════════════════════════════════════════════════
// A · DOSIS DE COACHING SEGÚN LA BRECHA
// ════════════════════════════════════════════════════════════

/**
 * Cuántas sesiones y de cuántos minutos hace falta para cerrar una brecha.
 * No es una regla arbitraria: parte de GANANCIA_POR_SESION y redondea hacia
 * arriba, porque quedarse corto en coaching es peor que pasarse.
 */
function dosificar(brecha) {
  if (brecha <= 0) return { sesiones: 1, minutos: 15, etiqueta: 'mantenimiento' };

  const sesiones = Math.min(6, Math.max(2, Math.ceil(brecha / GANANCIA_POR_SESION)));
  const minutos = brecha >= 2.5 ? 30 : brecha >= 1.5 ? 25 : 20;
  const etiqueta = brecha >= 2.5 ? 'intensivo' : brecha >= 1 ? 'dirigido' : 'de refinamiento';
  return { sesiones, minutos, etiqueta };
}

/** Prioridad de desarrollo: a mayor margen de crecimiento, mayor prioridad. */
function prioridadPorBrecha(brecha) {
  if (brecha >= 2) return { label: 'Muy alta', cls: 'p-alta' };
  if (brecha >= 1) return { label: 'Alta', cls: 'p-alta' };
  if (brecha > 0) return { label: 'Media', cls: 'p-media' };
  return { label: 'Mantenimiento', cls: 'p-baja' };
}

// ════════════════════════════════════════════════════════════
// SEMÁFORO
// ════════════════════════════════════════════════════════════

/**
 * Recomendación inmediata en rojo/amarillo/verde.
 * El score global solo no basta: un 8.0 con una competencia en 5 es amarillo,
 * no verde. Por eso también mira la peor competencia.
 */
function semaforo(score, competencias) {
  const peor = competencias.length ? Math.min(...competencias.map((c) => c.score)) : score;

  if (score >= 8.5 && peor >= 7.5) {
    return {
      nivel: 'verde',
      cls: 'sem-verde',
      label: 'CERTIFICADO · Listo para atender clientes',
      accion: 'El colaborador puede atender clientes de forma autónoma. Se recomienda mantener la revisión semanal de rutina.'
    };
  }
  if (score >= 7 && peor >= 6) {
    return {
      nivel: 'amarillo',
      cls: 'sem-amarillo',
      label: 'EN DESARROLLO · Atención con acompañamiento',
      accion: 'El colaborador puede atender clientes con el respaldo de un facilitador en sala, hasta consolidar las competencias identificadas.'
    };
  }
  return {
    nivel: 'rojo',
    cls: 'sem-rojo',
    label: 'EN FORMACIÓN · Continuar el entrenamiento',
    accion: 'Se recomienda completar el programa de desarrollo antes de asignar clientes. La inversión en preparación se recupera con el primer cierre bien ejecutado.'
  };
}

/** Interpretación del resultado general en una frase clara y directa. */
function interpretarScore(score) {
  if (score >= 9) return 'nivel de excelencia, referencia para el resto del equipo';
  if (score >= 8) return 'dentro del nivel esperado por la institución y listo para atender clientes';
  if (score >= 7) return 'base sólida, con una competencia identificada por consolidar';
  if (score >= 5.5) return 'en desarrollo: domina la estructura y trabaja ahora en la ejecución';
  return 'en formación: requiere acompañamiento antes de atender clientes de forma autónoma';
}

// ════════════════════════════════════════════════════════════
// CONSTRUCCIÓN DEL PLAN
// ════════════════════════════════════════════════════════════

/**
 * Genera el plan de acción expandido.
 *
 * @param {object} data Payload normalizado del reporte
 * @param {Array<{name:string, score:number}>} competencias
 * @returns {object} Bloques A–F listos para el template
 */
function buildActionPlan(data = {}, competencias = []) {
  const comps = (Array.isArray(competencias) ? competencias : [])
    .filter((c) => c && c.name != null && Number.isFinite(Number(c.score)))
    .map((c) => ({ name: String(c.name), score: Number(c.score) }));

  const scores = comps.map((c) => c.score);
  const score = Number.isFinite(Number(data.score_overall))
    ? Number(data.score_overall)
    : r1(promedio(scores) || 0);
  const scoreTotal = Number.isFinite(Number(data.scoreTotal))
    ? Number(data.scoreTotal)
    : Math.round((score / 10) * 100);

  // ── Campos enriquecedores de ElevenLabs (v3.2) ───────────────
  // Estos campos proporcionan contexto adicional sobre cómo fue la sesión
  // y se integran en el diagnóstico para hacer el plan más específico y accionable.
  const sessionProgression = data.session_progression || null;
  const objectionsCount = Number.isFinite(Number(data.objections_count)) ? Number(data.objections_count) : null;
  const pnlTechniquesUsed = data.pnl_techniques_used || null;
  const prospectEngagement = data.prospect_engagement || null;
  const nextStepsAgreed = data.next_steps_agreed || null;
  const identifiedRisks = data.identified_risks || null;
  const interactionQuality = data.interaction_quality || null;
  const conversionPotential = data.conversion_potential || null;
  const callEfficiency = data.call_efficiency || null;
  const coachNotes = data.coach_notes || null;

  const ordenadas = comps.slice().sort((a, b) => b.score - a.score);
  const fuertes = ordenadas.filter((c) => c.score >= META).slice(0, 3);
  const criticas = ordenadas.filter((c) => c.score < META).sort((a, b) => a.score - b.score);
  const enEstandar = comps.filter((c) => c.score >= META).length;

  const sem = semaforo(score, comps);
  const varianza = r1(desviacion(scores));
  const brechaTotal = r1(criticas.reduce((acc, c) => acc + (META - c.score), 0));

  // ── B · Plan de mejora por competencia ───────────────────────
  // Se trabajan como máximo 3 competencias a la vez: más frentes abiertos
  // diluyen el coaching y ninguno llega a la meta.
  //
  // OJO con las dos formas de "foco":
  //   `foco`      -> {name, score}   — la competencia cruda de la sesión
  //   `planMejora`-> {competencia, tecnica, metrica, …} — ya enriquecida
  // Mezclarlas era un fallo real: leer `foco[0].tecnica` daba undefined y
  // `.toLowerCase()` reventaba la generación del reporte entero.
  const foco = criticas.slice(0, 3);
  const planMejora = foco.map((c, i) => {
    const brecha = r1(META - c.score);
    const dosis = dosificar(brecha);
    const cat = CATALOGO[claveCompetencia(c.name)] || intervencionGenerica(c.name);
    const prio = prioridadPorBrecha(brecha);
    const medio = r1(c.score + brecha / 2);

    return {
      orden: i + 1,
      competencia: c.name,
      score: r1(c.score),
      meta: META,
      brecha,
      brecha_texto: `${brecha} punto${brecha === 1 ? '' : 's'} para alcanzar el nivel esperado`,
      prioridad: prio.label,
      prioridad_cls: prio.cls,
      tecnica: cat.tecnica,
      ejercicios: cat.ejercicios,
      sesiones: dosis.sesiones,
      minutos: dosis.minutos,
      dosis_texto: `${dosis.sesiones} sesiones de ${dosis.minutos} min · acompañamiento ${dosis.etiqueta}`,
      minutos_totales: dosis.sesiones * dosis.minutos,
      metrica: cat.metrica,
      senal_exito: cat.senal,
      timeline: `Día 3: ${medio}/10 · Día 7: ${META}/10 o superior`,
      // Ancho de barra ya calculado (Handlebars no multiplica)
      barra_actual: Math.round((c.score / 10) * 100),
      barra_meta: Math.round((META / 10) * 100)
    };
  });

  const sesionesTotales = planMejora.reduce((a, p) => a + p.sesiones, 0);
  const minutosTotales = planMejora.reduce((a, p) => a + p.minutos_totales, 0);
  const horasCoaching = r1(minutosTotales / 60);

  // Días estimados: el coach no puede dar más de dos sesiones útiles al día.
  const diasEstimados = brechaTotal <= 0
    ? 0
    : Math.min(21, Math.max(3, Math.ceil(sesionesTotales / 2)));

  const base = fechaBase(data);
  const fechaValidacion = sumarDias(base, 7);
  const fechaCheckpoint = sumarDias(base, 3);

  // ── A · Diagnóstico completo ─────────────────────────────────
  const diagnostico = [];

  diagnostico.push({
    titulo: 'Desempeño general de la sesión',
    detalle: `${r1(score)}/10 (${scoreTotal}%) — ${interpretarScore(score)}. `
      + `${enEstandar} de ${comps.length} competencias alcanzan el nivel esperado de ${META}/10.`,
    tono: score >= META ? 'ok' : score >= 7 ? 'warn' : 'bad'
  });

  if (fuertes.length) {
    diagnostico.push({
      titulo: 'Fortalezas que destacan',
      detalle: `${enumerar(fuertes.map((c) => `${c.name} (${r1(c.score)}/10)`))}. `
        + `Son la base sobre la que se construye el plan de desarrollo y la evidencia de que el colaborador `
        + `ya domina el nivel que la institución espera.`,
      tono: 'ok'
    });
  } else {
    diagnostico.push({
      titulo: 'Fortalezas que destacan',
      detalle: `Las competencias se encuentran todavía en desarrollo respecto al nivel esperado de ${META}/10. La más avanzada es `
        + `${ordenadas[0] ? `${ordenadas[0].name} (${r1(ordenadas[0].score)}/10)` : 'no determinada'}, `
        + `y es el mejor punto de partida para el acompañamiento.`,
      tono: 'warn'
    });
  }

  if (criticas.length) {
    diagnostico.push({
      titulo: 'Oportunidades de mejora',
      detalle: `${enumerar(criticas.slice(0, 3).map((c) => `${c.name} (${r1(c.score)}/10)`))}. `
        + `Consolidar estas competencias es lo que llevará el desempeño general al nivel esperado de ${META}/10.`,
      tono: criticas[0].score < 6 ? 'bad' : 'warn'
    });
  } else {
    diagnostico.push({
      titulo: 'Oportunidades de mejora',
      detalle: `Todas las competencias alcanzan el nivel esperado de ${META}/10. No se requieren acciones correctivas: `
        + `el trabajo continúa en modo de mantenimiento.`,
      tono: 'ok'
    });
  }

  // Observación adicional: contexto de la sesión desde ElevenLabs
  if (prospectEngagement || interactionQuality || objectionsCount !== null) {
    const partes = [];
    if (prospectEngagement) partes.push(`Participación del cliente: ${prospectEngagement}`);
    if (interactionQuality) partes.push(`Calidad de la conversación: ${interactionQuality}`);
    if (objectionsCount !== null) partes.push(`${objectionsCount} inquietud${objectionsCount === 1 ? '' : 'es'} planteada${objectionsCount === 1 ? '' : 's'} por el cliente`);
    if (partes.length) {
      diagnostico.push({
        titulo: 'Contexto de la conversación',
        detalle: partes.join(' · '),
        tono: 'ok'
      });
    }
  }

  diagnostico.push({
    titulo: `Camino hacia el nivel esperado de ${META}/10`,
    detalle: brechaTotal > 0
      ? `Restan ${brechaTotal} puntos distribuidos en ${criticas.length} competencia${criticas.length === 1 ? '' : 's'}, `
        + `concentrados principalmente en ${enumerar(foco.map((c) => c.name))}, que representan `
        + `${r1(foco.reduce((a, c) => a + (META - c.score), 0))} de esos puntos. Es un objetivo alcanzable con acompañamiento dirigido.`
      : `Objetivo alcanzado: todas las competencias se encuentran en ${META}/10 o por encima.`,
    tono: brechaTotal > 2 ? 'bad' : brechaTotal > 0 ? 'warn' : 'ok'
  });

  diagnostico.push({
    titulo: 'Progreso esperado',
    detalle: brechaTotal > 0
      ? `Con ${sesionesTotales} sesiones de acompañamiento (${horasCoaching} horas efectivas), se estima alcanzar el nivel esperado en `
        + `aproximadamente ${diasEstimados} días. El avance de referencia del programa es de ${GANANCIA_POR_SESION} puntos `
        + `por sesión de práctica dirigida con grabación y retroalimentación.`
      : `El colaborador ya se encuentra en el nivel esperado. Se recomienda una práctica semanal para sostener el resultado.`,
    tono: diasEstimados > 10 ? 'warn' : 'ok'
  });

  const riesgos = detectarRiesgos(data, comps, varianza, sem);
  const riesgosTexto = riesgos.join(' ');
  const riesgosAgente = identifiedRisks ? `Aspectos señalados durante la evaluación: ${identifiedRisks}. ` : '';
  diagnostico.push({
    titulo: 'Aspectos a considerar',
    detalle: riesgosAgente + (riesgosTexto || 'No se identificaron aspectos que requieran atención especial. El desempeño se mantuvo constante durante toda la sesión.'),
    tono: (riesgos.length || identifiedRisks) ? 'warn' : 'ok'
  });

  diagnostico.push({
    titulo: 'Recomendación institucional',
    detalle: `${sem.label}. ${sem.accion}`,
    tono: sem.nivel === 'verde' ? 'ok' : sem.nivel === 'amarillo' ? 'warn' : 'bad'
  });

  // ── C · Hitos y validaciones ─────────────────────────────────
  const hitos = [];
  const focoNombres = foco.length ? enumerar(foco.map((c) => c.name)) : 'las competencias ya consolidadas';

  hitos.push({
    momento: 'Hoy',
    objetivo: brechaTotal > 0
      ? `Programar las sesiones de acompañamiento en ${focoNombres} y compartir la grabación con el colaborador.`
      : 'Comunicar al colaborador su resultado y confirmar su asignación de clientes.',
    metrica: 'Sesión programada en el calendario, con horario y facilitador asignado',
    verificacion: 'Invitación enviada al colaborador'
  });

  if (planMejora.length) {
    const primera = planMejora[0];
    hitos.push({
      momento: `Día 3 · ${formatDateLocal(fechaCheckpoint)}`,
      objetivo: `Revisión intermedia de ${primera.competencia}: práctica breve de 10 minutos enfocada únicamente en esa competencia.`,
      metrica: `${primera.competencia} en ${r1(primera.score + primera.brecha / 2)}/10 o más`,
      verificacion: 'Práctica grabada y evaluada por el facilitador'
    });
  }

  hitos.push({
    momento: 'Semana 1',
    objetivo: brechaTotal > 0
      ? `Completar ${sesionesTotales} sesiones de acompañamiento (${horasCoaching} horas) enfocadas en ${focoNombres}.`
      : 'Sostener el nivel alcanzado con dos prácticas completas.',
    metrica: brechaTotal > 0
      ? `Todas las competencias en desarrollo alcanzan ${META}/10 o más`
      : `Ninguna competencia por debajo de ${META}/10`,
    verificacion: 'Registro de asistencia a las sesiones'
  });

  hitos.push({
    momento: `Día 7 · ${formatDateLocal(fechaValidacion)}`,
    objetivo: 'Evaluación completa: práctica íntegra con un cliente simulado y valoración de las seis competencias.',
    metrica: `Desempeño general en ${META}/10 o más, sin ninguna competencia por debajo de 7/10`,
    verificacion: 'Nuevo reporte generado y comparado con el actual'
  });

  if (sem.nivel === 'rojo') {
    hitos.push({
      momento: `Semana 2 · ${formatDateLocal(sumarDias(base, 14))}`,
      objetivo: 'Segunda evaluación de seguimiento, aplicable únicamente si la del día 7 no alcanzó el nivel esperado.',
      metrica: `Desempeño general en ${META}/10 o más`,
      verificacion: 'Decisión formal de certificación o revisión con Dirección'
    });
  }

  // ── D · Criterios de certificación ───────────────────────────
  const criterios = [
    {
      condicion: `TODAS las competencias alcanzan ${META}/10 o más`,
      resultado: 'Se certifica al colaborador para atender clientes de forma autónoma.',
      estado: criticas.length === 0
        ? 'Se cumple el día de hoy'
        : `Aún no se cumple: ${criticas.length} competencia${criticas.length === 1 ? '' : 's'} en desarrollo`,
      cls: criticas.length === 0 ? 'ok' : 'bad'
    },
    {
      condicion: `ALGUNA competencia por debajo de ${META}/10`,
      resultado: `Se extiende el acompañamiento ${Math.max(3, diasEstimados)} días y se realiza una nueva evaluación.`,
      estado: criticas.length ? `Aplica: ${criticas.length} competencia${criticas.length === 1 ? '' : 's'} por consolidar` : 'No aplica',
      cls: criticas.length ? 'warn' : 'ok'
    },
    {
      condicion: 'Desempeño general de 7/10 o más, con diferencias superiores a 1.5 puntos entre competencias',
      resultado: 'Se aplica un refuerzo selectivo, únicamente en las competencias por consolidar, sin repetir el programa completo.',
      estado: score >= 7 && varianza > 1.5
        ? `Aplica: ${varianza} puntos de diferencia entre competencias`
        : `No aplica: ${varianza} puntos de diferencia entre competencias`,
      cls: score >= 7 && varianza > 1.5 ? 'warn' : 'ok'
    },
    {
      condicion: 'Alguna competencia por debajo de 6/10',
      resultado: 'Se completa el programa de desarrollo antes de asignar clientes.',
      estado: comps.some((c) => c.score < 6)
        ? `Aplica: ${enumerar(comps.filter((c) => c.score < 6).map((c) => `${c.name} (${r1(c.score)})`))}`
        : 'No aplica: ninguna competencia por debajo de 6/10',
      cls: comps.some((c) => c.score < 6) ? 'bad' : 'ok'
    }
  ];

  // ── E · Próximos pasos del gerente ───────────────────────────
  const hoy = [];
  if (planMejora.length) {
    const primera = planMejora[0];
    hoy.push(`Programar la primera sesión de ${primera.competencia} (${primera.minutos} minutos) antes de que concluya el día.`);
    hoy.push(`Escuchar la grabación completa, identificar los momentos donde ${primera.competencia} puede fortalecerse y compartirlos con el colaborador.`);
    hoy.push(`Comunicar al colaborador ${planMejora.length === 1 ? 'la competencia' : `las ${planMejora.length} competencias`} en las que se concentrará el desarrollo: ${focoNombres}. Enfocar el trabajo en pocos objetivos a la vez produce mejores resultados.`);
  } else {
    hoy.push('Comunicar al colaborador que queda certificado para atender clientes y asignarle su primera atención.');
    hoy.push('Conservar esta grabación como material de referencia y ejemplo para el resto del equipo.');
  }
  if (sem.nivel === 'rojo') {
    hoy.push('Mantener al colaborador en el programa de desarrollo hasta la evaluación del día 7, antes de asignarle clientes.');
  }

  const monitoreo = [
    {
      frecuencia: 'Diario',
      que: planMejora.length
        ? `Una práctica de 10 minutos enfocada en ${planMejora[0].competencia}. Cómo se mide: ${planMejora[0].metrica.toLowerCase()}.`
        : 'Confirmar que el colaborador mantiene su ritmo de práctica de forma autónoma.'
    },
    {
      frecuencia: 'Cada 48 horas',
      que: 'Revisar una grabación real o de práctica y registrar si el comportamiento esperado ya aparece de forma natural.'
    },
    {
      frecuencia: 'Semanal',
      que: `Comparar el resultado de la nueva práctica con el ${r1(score)}/10 de esta sesión. La tendencia de mejora es más relevante que un resultado aislado.`
    }
  ];

  const escalar = [
    `El resultado de la evaluación del día 7 es inferior al ${r1(score)}/10 obtenido en esta sesión.`,
    `Alguna competencia continúa por debajo de 6/10 después de ${Math.max(3, diasEstimados)} días de acompañamiento.`,
    'El colaborador no asiste a dos sesiones de acompañamiento programadas.',
    'La misma inquietud del cliente queda sin resolver en tres prácticas consecutivas.'
  ];

  const proximosPasos = {
    hoy,
    monitoreo,
    reevaluacion: `${formatDateLong(fechaValidacion)} — práctica completa y reporte comparativo con la sesión actual.`,
    reevaluacion_fecha: formatDateLocal(fechaValidacion),
    escalar
  };

  // ── F · Notas de coaching ────────────────────────────────────
  const notas = {
    observaciones: notasObservaciones(data, comps, sem, score),
    reforzar: planMejora.length
      ? planMejora.map((p) => `${p.competencia}: ${p.tecnica.toLowerCase()}. Señal de que ya se logró — ${p.senal_exito.toLowerCase()}.`)
      : comps.slice(0, 2).map((c) => `${c.name} (${r1(c.score)}/10): sostener el nivel con una práctica semanal, sin necesidad de corrección.`),
    patrones: detectarPatrones(data, comps, varianza),
    recomendaciones: recomendacionesPersonales(data, sem, planMejora, score)
  };

  return {
    plan: {
      meta_estandar: META,
      semaforo: sem,
      score: r1(score),
      score_total: scoreTotal,
      varianza,
      competencias_en_estandar: enEstandar,
      competencias_totales: comps.length,
      competencias_criticas: criticas.length,
      brecha_total: brechaTotal,
      sesiones_totales: sesionesTotales,
      minutos_totales: minutosTotales,
      horas_coaching: horasCoaching,
      dias_estimados: diasEstimados,
      fecha_validacion: formatDateLocal(fechaValidacion),
      fecha_validacion_larga: formatDateLong(fechaValidacion),
      fecha_checkpoint: formatDateLocal(fechaCheckpoint),
      foco_nombres: focoNombres,
      diagnostico,
      mejora: planMejora,
      hitos,
      criterios,
      pasos: proximosPasos,
      notas,
      // Contexto adicional de ElevenLabs (para enriquecimiento futuro del template)
      session_context: {
        progression: sessionProgression,
        objections_count: objectionsCount,
        pnl_techniques: pnlTechniquesUsed,
        prospect_engagement: prospectEngagement,
        next_steps: nextStepsAgreed,
        interaction_quality: interactionQuality,
        conversion_potential: conversionPotential,
        call_efficiency: callEfficiency,
        coach_notes: coachNotes
      }
    },
    // PLAN EXPANDIDO 150+ palabras por punto (enriquecido con data real de ElevenLabs)
    plan_1: buildPlanDiagnostico(diagnostico, comps, score, scoreTotal, objectionsCount, prospectEngagement, interactionQuality),
    plan_2: buildPlanMejora(planMejora, score, diasEstimados, sessionProgression, pnlTechniquesUsed, callEfficiency),
    plan_3: buildPlanValidacion(formatDateLocal(fechaValidacion), criterios, hitos, sem, nextStepsAgreed, conversionPotential)
  };
}

// ════════════════════════════════════════════════════════════
// DETECTORES
// ════════════════════════════════════════════════════════════

/** Riesgos operativos deducidos de los datos reales, nunca genéricos. */
function detectarRiesgos(data, comps, varianza, sem) {
  const riesgos = [];
  const get = (clave) => comps.find((c) => claveCompetencia(c.name) === clave);

  const cierre = get('cierre');
  const objeciones = get('objeciones');
  const lectura = get('lectura sala');
  const rapport = get('rapport');

  if (cierre && cierre.score < 7) {
    riesgos.push(`Conclusión de la venta en ${r1(cierre.score)}/10: conviene reforzar el cierre para evitar conversaciones extensas que terminan sin una decisión del cliente.`);
  }
  if (objeciones && objeciones.score < 7) {
    riesgos.push(`Atención de inquietudes en ${r1(objeciones.score)}/10: existe la tendencia a ofrecer descuentos cuando falta un argumento de valor, lo que afecta la rentabilidad.`);
  }
  if (lectura && lectura.score < 7) {
    riesgos.push(`Percepción del cliente en ${r1(lectura.score)}/10: conviene desarrollar la lectura de señales para saber cuándo avanzar y cuándo dar espacio.`);
  }
  if (rapport && rapport.score < 7) {
    riesgos.push(`Conexión con el cliente en ${r1(rapport.score)}/10: sin una relación de confianza el cliente comparte menos información y la presentación pierde precisión.`);
  }
  if (varianza > 1.8) {
    riesgos.push(`Desempeño desigual entre competencias (${varianza} puntos de diferencia): el resultado varía según el tipo de cliente que se atienda.`);
  }

  const min = Number(data.duracion_minutos);
  if (Number.isFinite(min) && min > 0 && min < 5) {
    riesgos.push(`Sesión de ${min} minutos: es una muestra breve, por lo que conviene una segunda práctica antes de tomar decisiones sobre el desarrollo del colaborador.`);
  }
  if (Number.isFinite(min) && min > 35) {
    riesgos.push(`Sesión de ${min} minutos: por encima del tiempo recomendado de atención. Conviene revisar en qué etapa se pierde el ritmo.`);
  }

  const neuro = Number(data.cumplimiento_neuro);
  if (Number.isFinite(neuro) && neuro < 70) {
    riesgos.push(`Aplicación de la metodología en ${Math.round(neuro)}%: el colaborador se apoya más en su intuición que en el método institucional, lo que dificulta replicar sus buenos resultados.`);
  }
  if (sem.nivel === 'rojo') {
    riesgos.push('Recomendación en rojo: asignar clientes reales en esta etapa expondría la experiencia del huésped y los resultados del área.');
  }

  return riesgos;
}

/** Patrones de comportamiento cruzando fases de la venta. */
function detectarPatrones(data, comps, varianza) {
  const patrones = [];
  const get = (clave) => {
    const c = comps.find((x) => claveCompetencia(x.name) === clave);
    return c ? c.score : null;
  };

  const apertura = [get('rapport'), get('lectura sala')].filter((n) => n !== null);
  const cierre = [get('objeciones'), get('cierre')].filter((n) => n !== null);

  if (apertura.length && cierre.length) {
    const dif = r1(promedio(apertura) - promedio(cierre));
    if (dif >= 1) {
      patrones.push(`El desempeño desciende en la segunda mitad de la conversación: inicia en ${r1(promedio(apertura))}/10 y concluye en ${r1(promedio(cierre))}/10. `
        + `El colaborador genera muy buena conexión inicial y la oportunidad de mejora está en la etapa de conclusión.`);
    } else if (dif <= -1) {
      patrones.push(`El desempeño mejora conforme avanza la conversación: inicia en ${r1(promedio(apertura))}/10 y concluye en ${r1(promedio(cierre))}/10. `
        + `Domina la técnica de cierre; reforzar la apertura potenciaría todavía más sus resultados.`);
    } else {
      patrones.push(`Desempeño equilibrado entre la apertura (${r1(promedio(apertura))}/10) y la conclusión (${r1(promedio(cierre))}/10): `
        + `el resultado se mantiene estable durante toda la conversación.`);
    }
  }

  if (varianza <= 0.8) {
    patrones.push(`Perfil homogéneo (${varianza} puntos de diferencia entre competencias): el colaborador avanza de forma pareja, por lo que un ajuste de método beneficia a todas las áreas a la vez.`);
  } else if (varianza > 1.5) {
    patrones.push(`Perfil desigual (${varianza} puntos de diferencia entre competencias): conviven habilidades muy sólidas con otras por desarrollar. `
      + `El acompañamiento debe ser selectivo y enfocado, no general.`);
  }

  const neuro = Number(data.cumplimiento_neuro);
  if (Number.isFinite(neuro)) {
    if (neuro >= 85) {
      patrones.push(`Aplicación de la metodología en ${Math.round(neuro)}%: el colaborador sigue el método institucional de forma consistente, lo que hace su desempeño predecible y replicable.`);
    } else if (neuro < 70) {
      patrones.push(`Aplicación de la metodología en ${Math.round(neuro)}%: aplica los principios de forma intermitente. Conviene reforzar primero la estructura de la conversación y después la técnica.`);
    }
  }

  const turnos = Array.isArray(data.transcription) ? data.transcription.length : 0;
  const min = Number(data.duracion_minutos);
  if (turnos > 0 && Number.isFinite(min) && min > 0) {
    const ritmo = r1(turnos / min);
    if (ritmo < 2) {
      patrones.push(`Ritmo de ${ritmo} intervenciones por minuto: las participaciones son extensas. Conviene verificar que la conversación sea un diálogo y no una exposición.`);
    } else if (ritmo > 8) {
      patrones.push(`Ritmo de ${ritmo} intervenciones por minuto: el intercambio es muy fragmentado y deja poco espacio para desarrollar cada idea con profundidad.`);
    }
  }

  return patrones;
}

/** Observaciones del entrenador, apoyadas en las listas reales del análisis. */
function notasObservaciones(data, comps, sem, score) {
  const obs = [];
  const fort = Array.isArray(data.fortalezas_list) ? data.fortalezas_list : [];
  const areas = Array.isArray(data.areas_list) ? data.areas_list : [];

  obs.push(`Sesión de ${data.duracion_texto || '—'} en el módulo ${data.modulo || '—'}, con un desempeño ${score >= 8 ? 'dentro del nivel esperado' : 'en desarrollo respecto al nivel esperado'}: ${r1(score)}/10.`);

  if (fort.length) obs.push(`Aspectos que funcionaron muy bien: ${fort.slice(0, 2).join(' · ')}`);
  if (areas.length) obs.push(`Aspectos por reforzar: ${areas.slice(0, 2).join(' · ')}`);

  // El respaldo "el cliente no planteó inquietudes" NO es un hallazgo: si se
  // colara aquí, la nota de coaching diría que hubo inquietudes y a continuación
  // que no las hubo. Se descartan las dos redacciones, la actual y la histórica.
  const sinInquietudes = /no (?:se registraron|planteó|plantearon|hubo)/i;
  if (data.objeciones_trabajadas && !sinInquietudes.test(String(data.objeciones_trabajadas))) {
    obs.push(`Inquietudes que planteó el cliente durante la sesión: ${String(data.objeciones_trabajadas).slice(0, 240)}`);
  }

  obs.push(`Valoración del equipo de desarrollo: ${sem.accion}`);
  return obs;
}

/**
 * Sugerencias del equipo de desarrollo para el líder del área.
 * @param {Array<{competencia:string}>} foco Entradas YA enriquecidas (planMejora)
 */
function recomendacionesPersonales(data, sem, foco, score) {
  const recs = [];
  const nombre = data.nombre || 'el colaborador';

  if (sem.nivel === 'verde') {
    recs.push(`Compartir esta grabación de ${nombre} como material de referencia en la reunión de equipo: un ejemplo del propio hotel enseña más que cualquier material externo.`);
    recs.push('Invitarle a apoyar la formación de los colaboradores de nuevo ingreso: enseñar consolida lo que ya domina y fortalece su liderazgo.');
  } else if (sem.nivel === 'amarillo') {
    recs.push(`Acompañar a ${nombre} durante sus primeras dos atenciones tomando notas, sin intervenir. La retroalimentación se comparte después, nunca frente al cliente.`);
    recs.push('Ofrecer la retroalimentación en el formato "un aspecto por mantener y un aspecto por ajustar". Más de dos indicaciones simultáneas dificultan la asimilación.');
  } else {
    recs.push(`Trabajar con ${nombre} en sesiones individuales antes de volver a la atención de clientes: la preparación previa acelera el aprendizaje y protege su confianza.`);
    recs.push('Comenzar por la competencia con mayor oportunidad de mejora y cerrar cada sesión reconociendo algo que ya realiza bien. La confianza es parte del entrenamiento.');
  }

  if (foco.length) {
    recs.push(`Mantener el desarrollo enfocado en ${enumerar(foco.map((f) => f.competencia))} durante los próximos 7 días. Concentrar el esfuerzo en pocos objetivos produce avances más sólidos.`);
  }
  recs.push('Registrar cada sesión de acompañamiento con fecha, duración y competencia trabajada: es la evidencia que permite mostrar la evolución del colaborador.');

  return recs;
}

// ════════════════════════════════════════════════════════════
// GENERADORES DE LOS TRES APARTADOS EXTENSOS
//
// Son la versión narrada del plan, la que se lee de corrido en el correo y en
// el respaldo del reporte. Están escritos para Dirección, Gerencia y Recursos
// Humanos: sin términos de manual de ventas, en positivo y con un siguiente
// paso explícito al final de cada apartado.
// ════════════════════════════════════════════════════════════

/**
 * APARTADO 1: Análisis de Desempeño
 * Incluye: resultado general, interpretación, fortalezas, oportunidades de
 * mejora, contexto de la conversación y el siguiente paso.
 */
function buildPlanDiagnostico(diagnostico, comps, score, scoreTotal, objectionsCount, prospectEngagement, interactionQuality) {
  const fort = comps.slice().sort((a, b) => b.score - a.score).slice(0, 2);
  const criticas = comps.slice().sort((a, b) => a.score - b.score).slice(0, 2);

  let texto = `**Desempeño General:** ${r1(score)}/10 (${scoreTotal}%). `;
  if (score >= 8) {
    texto += `El colaborador se encuentra dentro del nivel esperado por la institución y demuestra un manejo consistente de la conversación con el cliente.`;
  } else if (score >= 7) {
    texto += `El colaborador ha construido una base sólida. Existen competencias específicas que conviene consolidar antes de certificarlo para la atención autónoma de clientes.`;
  } else {
    texto += `El colaborador se encuentra en etapa de formación. Con acompañamiento dirigido durante los próximos días alcanzará el nivel que la institución espera.`;
  }

  texto += ` **Fortalezas que Destacan:** ${fort.map((c) => `${c.name} (${r1(c.score)}/10)`).join(', ')}. `;
  texto += `Son la base sobre la que se construye el plan de desarrollo y la mejor evidencia de que el colaborador puede desempeñarse al nivel requerido.`;

  if (criticas.length) {
    texto += ` **Oportunidades de Mejora:** ${criticas.map((c) => `${c.name} (${r1(c.score)}/10)`).join(', ')}. `;
    texto += `Consolidar estas competencias es lo que llevará el desempeño general al nivel esperado de 8/10 o superior.`;
  }

  if (objectionsCount !== null || prospectEngagement || interactionQuality) {
    texto += ` **Contexto de la Conversación:** `;
    const partes = [];
    if (objectionsCount !== null) partes.push(`${objectionsCount} inquietud${objectionsCount === 1 ? '' : 'es'} planteada${objectionsCount === 1 ? '' : 's'} por el cliente`);
    if (prospectEngagement) partes.push(`Participación del cliente: ${prospectEngagement}`);
    if (interactionQuality) partes.push(`Calidad de la conversación: ${interactionQuality}`);
    if (partes.length) texto += partes.join('. ') + '.';
  }

  texto += ` **Siguiente Paso:** Este análisis es el punto de partida del plan de desarrollo de los próximos 7 días. Se recomienda compartirlo hoy mismo con el colaborador, comenzando siempre por sus fortalezas y presentando las oportunidades de mejora como el camino hacia su certificación.`;

  return texto;
}

/**
 * APARTADO 2: Plan de Mejora
 * Incluye: competencia a desarrollar, enfoque de trabajo, prácticas sugeridas,
 * dedicación estimada, forma de medir el avance y una nota para el facilitador.
 *
 * Los saltos de línea son reales (`\n`). Antes iban escapados (`\\n`) y el
 * lector veía la secuencia "\n" impresa dentro de un documento de dirección.
 */
function buildPlanMejora(planMejora, score, diasEstimados, sessionProgression, pnlTechniquesUsed, callEfficiency) {
  if (!planMejora || !planMejora.length) {
    return `**Todas las Competencias Consolidadas:** El colaborador alcanza el nivel esperado en todas las competencias `
      + `evaluadas y está listo para atender clientes de forma autónoma. `
      + `**Plan de Mantenimiento:** una práctica semanal de 15 minutos, sin corrección, con el único fin de sostener el ${r1(score)}/10 alcanzado. `
      + `**Siguiente Paso:** permitir que el colaborador desarrolle su confianza en la operación diaria, con una revisión de seguimiento cada semana.`;
  }

  const p = planMejora[0];
  let texto = `**Competencia a Desarrollar:** ${p.competencia} (nivel actual ${r1(p.score)}/10, nivel esperado ${p.meta}/10, `
    + `diferencia de ${p.brecha} punto${p.brecha === 1 ? '' : 's'}). `;
  texto += `Es la competencia con mayor margen de crecimiento y, por lo tanto, la de prioridad ${p.prioridad.toLowerCase()} en este plan.\n\n`;

  texto += `**Enfoque de Trabajo:** ${p.tecnica}. Es importante que el colaborador comprenda no solo qué ajustar, `
    + `sino por qué este enfoque da resultado en el tipo de conversaciones que sostiene a diario.\n\n`;

  texto += `**Prácticas Sugeridas (en orden de ejecución):**\n`;
  p.ejercicios.forEach((ej, i) => {
    texto += `${i + 1}. ${ej}\n`;
  });

  texto += `\n**Dedicación y Calendario:** ${p.dosis_texto}. `;
  texto += `En total, ${p.minutos_totales} minutos de acompañamiento efectivo distribuidos a lo largo de ${diasEstimados} días. `;
  texto += `Revisión intermedia el día 3 (objetivo: ${r1(p.score + p.brecha / 2)}/10) y evaluación completa el día 7 (objetivo: ${p.meta}/10 o más).\n\n`;

  texto += `**Cómo se Mide el Avance:** ${p.metrica}. `;
  texto += `Señal observable de que el aprendizaje se consolidó: ${p.senal_exito.toLowerCase()}.\n\n`;

  texto += `**Nota para el Facilitador:** es natural que las primeras prácticas no salgan perfectas; forma parte del proceso de aprendizaje. `;
  texto += `El indicador que realmente importa es que el comportamiento esperado comience a aparecer de forma espontánea, sin necesidad de corrección.`;

  return texto;
}

/**
 * APARTADO 3: Seguimiento y Verificación de Progreso
 * Incluye: calendario, criterios de certificación, recomendación institucional
 * con su justificación, y las acciones inmediatas.
 */
function buildPlanValidacion(fechaValidacionLocal, criterios, hitos, sem, nextStepsAgreed, conversionPotential) {
  let texto = `**Calendario de Seguimiento:** práctica completa el ${fechaValidacionLocal} (día 7). `;
  texto += `La sesión se graba, la evalúa el facilitador de forma independiente y se compara competencia por competencia con la evaluación actual, `;
  texto += `de modo que el progreso quede documentado con datos y no con impresiones.\n\n`;

  texto += `**Criterios de Certificación:**\n`;
  criterios.slice(0, 2).forEach((c) => {
    const estado = c.cls === 'ok' ? '✓' : '○';
    texto += `${estado} ${c.condicion} → ${c.resultado}\n`;
  });

  texto += `\n**Recomendación Actual:** ${sem.label}. ${sem.accion}\n\n`;

  if (sem.nivel === 'rojo') {
    texto += `**Fundamento de la Recomendación:** conviene completar el programa de desarrollo antes de asignar clientes. `;
    texto += `La preparación previa se recupera con creces en la primera atención bien ejecutada. `;
    texto += `Si la evaluación del día 7 aún no alcanza el nivel esperado, se programa una segunda revisión el día 14.\n\n`;
  } else if (sem.nivel === 'amarillo') {
    texto += `**Fundamento de la Recomendación:** el colaborador puede atender clientes con el respaldo de un facilitador en sala, `;
    texto += `hasta consolidar las competencias identificadas. El acompañamiento es una medida de apoyo y aprendizaje: `;
    texto += `beneficia al colaborador, cuida la experiencia del huésped y protege los resultados del área.\n\n`;
  } else {
    texto += `**Fundamento de la Recomendación:** el colaborador alcanza el nivel esperado y puede atender clientes de forma autónoma. `;
    texto += `Se mantiene la revisión semanal de rutina como parte del desarrollo profesional continuo.\n\n`;
  }

  texto += `**Acciones Inmediatas:** programar hoy la sesión de seguimiento con el facilitador asignado. `;
  texto += `Compartir con el colaborador su resultado, las competencias en las que se enfocará el desarrollo y la fecha de la próxima evaluación. `;
  texto += `Conservar la grabación de esta sesión: será material de referencia para futuras capacitaciones del equipo.`;

  if (nextStepsAgreed) {
    texto += ` Acuerdos alcanzados con el cliente durante la sesión: ${nextStepsAgreed}.`;
  }

  return texto;
}

module.exports = {
  buildActionPlan,
  META,
  // Exportados para pruebas
  dosificar,
  semaforo,
  desviacion
};