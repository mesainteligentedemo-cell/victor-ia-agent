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
    tecnica: 'Espejeo progresivo y apertura sin producto',
    ejercicios: [
      'Espejo de tres capas: replicar postura, ritmo de habla y una palabra clave del cliente dentro de los primeros 90 segundos. Grabar y contar cuántas veces se logra.',
      'Apertura sin producto: cuatro minutos de conversación con prohibición de mencionar el resort. Objetivo: que el cliente cuente algo personal sin que se lo pidan.',
      'Regla del nombre: usar el nombre del cliente tres veces en la fase de apertura, nunca dos veces seguidas.'
    ],
    metrica: 'Minutos hasta la primera confidencia personal del cliente (meta: menos de 4 minutos)',
    senal: 'El cliente hace preguntas que no son sobre precio'
  },
  pnl: {
    tecnica: 'Reencuadre semántico y cambio de submodalidades',
    ejercicios: [
      'Banco de reencuadres: escribir diez objeciones frecuentes con su reencuadre "gasto → inversión" y recitarlas sin leer.',
      'Cambio de submodalidad: pedir al cliente que describa sus vacaciones ideales y devolverle la imagen con más brillo, más sonido y más cercanía.',
      'Anclaje kinestésico: fijar un gesto durante el pico emocional de la sesión y reactivarlo en el momento del cierre.'
    ],
    metrica: 'Reencuadres aplicados por sesión (meta: 3 o más)',
    senal: 'El cliente repite el reencuadre con sus propias palabras'
  },
  postura: {
    tecnica: 'Congruencia corporal y control del silencio',
    ejercicios: [
      'Revisión de video sin audio, cinco minutos: contar gestos de retroceso (brazos cruzados, hombros caídos, mirada al piso).',
      'Silencio de tres segundos cronometrados después de cada pregunta de cierre, sin rellenar el hueco.',
      'Ensayo de pie frente al espejo: la misma presentación con tres niveles de energía distintos.'
    ],
    metrica: 'Gestos de retroceso por cada 10 minutos de sesión (meta: 0)',
    senal: 'El asesor sostiene el silencio sin justificarse'
  },
  objeciones: {
    tecnica: 'Amortiguar, aislar, reencuadrar y volver a cerrar',
    ejercicios: [
      'Rueda de diez objeciones: el coach dispara objeciones sin pausa y el asesor responde en menos de cinco segundos con la estructura de cuatro pasos.',
      'Aislar antes de responder: prohibido tocar el precio hasta haber preguntado "¿es lo único que lo detiene?".',
      'Reescritura: tomar las tres objeciones peor resueltas de esta sesión y escribir la respuesta ideal palabra por palabra.'
    ],
    metrica: 'Objeciones resueltas sin ceder precio (meta: 80% o más)',
    senal: 'La objeción no vuelve a aparecer más adelante en la sesión'
  },
  'lectura sala': {
    tecnica: 'Calibración continua y detección de señales de compra',
    ejercicios: [
      'Semáforo: pausar la grabación cada dos minutos y clasificar al cliente en verde, amarillo o rojo. Contrastar la lectura con el coach.',
      'Detectar cinco señales de compra en una grabación ajena y decir en qué segundo exacto aparecieron.',
      'Preguntar "¿cómo lo ve hasta aquí?" en cada transición de fase, sin excepción.'
    ],
    metrica: 'Aciertos en la clasificación del semáforo (meta: 8 de 10)',
    senal: 'El asesor cambia de rumbo antes de que el cliente se cierre'
  },
  cierre: {
    tecnica: 'Cierre asumido sobre escalera de microcompromisos',
    ejercicios: [
      'Tres cierres distintos sobre el mismo cliente simulado: asumido, por alternativa y por urgencia real.',
      'Prohibido preguntar "¿qué le parece?": sustituirlo siempre por una pregunta de decisión.',
      'Escalera: obtener tres microcompromisos verbales antes de intentar el cierre final.'
    ],
    metrica: 'Intentos de cierre por sesión (meta: 3 o más, sin repetir técnica)',
    senal: 'El cliente pide condiciones en vez de tiempo para pensarlo'
  }
};

/** Intervención genérica cuando la competencia no está en el catálogo. */
function intervencionGenerica(nombre) {
  return {
    tecnica: `Práctica dirigida de ${nombre} con grabación y revisión`,
    ejercicios: [
      `Aislar ${nombre} en simulaciones cortas de 10 minutos: se trabaja solo esa competencia, el resto se da por bueno.`,
      `Revisar con el asesor dos fragmentos de esta grabación donde ${nombre} falló y reescribir en voz alta la ejecución correcta.`,
      `Cerrar cada sesión con una repetición completa cronometrada, sin interrupciones del coach.`
    ],
    metrica: `Puntuación de ${nombre} en la simulación de validación (meta: ${META}/10)`,
    senal: 'La ejecución se sostiene sin que el coach tenga que intervenir'
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
  const etiqueta = brecha >= 2.5 ? 'intensivo' : brecha >= 1 ? 'dirigido' : 'de ajuste';
  return { sesiones, minutos, etiqueta };
}

/** Prioridad de intervención: cuanto más lejos del estándar, más arriba. */
function prioridadPorBrecha(brecha) {
  if (brecha >= 2) return { label: 'Crítica', cls: 'p-alta' };
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
      label: 'VERDE · Autorizar piso de ventas',
      accion: 'El asesor puede operar sin acompañamiento. Mantener la revisión semanal de rutina.'
    };
  }
  if (score >= 7 && peor >= 6) {
    return {
      nivel: 'amarillo',
      cls: 'sem-amarillo',
      label: 'AMARILLO · Piso con acompañamiento',
      accion: 'El asesor puede recibir familias, pero con un coach presente hasta cerrar la brecha detectada.'
    };
  }
  return {
    nivel: 'rojo',
    cls: 'sem-rojo',
    label: 'ROJO · Retener en entrenamiento',
    accion: 'No asignar familias reales hasta superar la validación de día 7. El costo de un cierre perdido supera el del coaching.'
  };
}

/** Interpretación del score global en una frase, sin eufemismos. */
function interpretarScore(score) {
  if (score >= 9) return 'nivel élite: ejecución de referencia para el resto del equipo';
  if (score >= 8) return 'dentro del estándar VTC, listo para operar';
  if (score >= 7) return 'base sólida con una brecha identificada, aún por debajo del estándar';
  if (score >= 5.5) return 'en desarrollo: la estructura está, la ejecución todavía no';
  return 'por debajo del umbral operativo: requiere refuerzo antes de cualquier contacto real';
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
    const cat = CATALOGO[c.name.toLowerCase()] || intervencionGenerica(c.name);
    const prio = prioridadPorBrecha(brecha);
    const medio = r1(c.score + brecha / 2);

    return {
      orden: i + 1,
      competencia: c.name,
      score: r1(c.score),
      meta: META,
      brecha,
      brecha_texto: `${brecha} punto${brecha === 1 ? '' : 's'} por debajo del estándar`,
      prioridad: prio.label,
      prioridad_cls: prio.cls,
      tecnica: cat.tecnica,
      ejercicios: cat.ejercicios,
      sesiones: dosis.sesiones,
      minutos: dosis.minutos,
      dosis_texto: `${dosis.sesiones} sesiones de ${dosis.minutos} min · coaching ${dosis.etiqueta}`,
      minutos_totales: dosis.sesiones * dosis.minutos,
      metrica: cat.metrica,
      senal_exito: cat.senal,
      timeline: `Día 3: ${medio}/10 · Día 7: ${META}/10 o más`,
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
    titulo: 'Score actual e interpretación',
    detalle: `${r1(score)}/10 (${scoreTotal}%) — ${interpretarScore(score)}. `
      + `${enEstandar} de ${comps.length} competencias alcanzan el estándar VTC de ${META}/10.`,
    tono: score >= META ? 'ok' : score >= 7 ? 'warn' : 'bad'
  });

  if (fuertes.length) {
    diagnostico.push({
      titulo: 'Fortalezas a capitalizar',
      detalle: `${enumerar(fuertes.map((c) => `${c.name} (${r1(c.score)}/10)`))}. `
        + `Son la base sobre la que se apoya el coaching: no se tocan, se usan como prueba de que el asesor sí puede ejecutar.`,
      tono: 'ok'
    });
  } else {
    diagnostico.push({
      titulo: 'Fortalezas a capitalizar',
      detalle: `Ninguna competencia alcanza todavía el estándar de ${META}/10. La más avanzada es `
        + `${ordenadas[0] ? `${ordenadas[0].name} (${r1(ordenadas[0].score)}/10)` : 'no determinada'}: `
        + `usarla como punto de partida del entrenamiento.`,
      tono: 'warn'
    });
  }

  if (criticas.length) {
    diagnostico.push({
      titulo: 'Áreas críticas',
      detalle: `${enumerar(criticas.slice(0, 3).map((c) => `${c.name} (${r1(c.score)}/10)`))}. `
        + `Están por debajo del estándar y son las que explican la diferencia entre este resultado y un ${META}/10 global.`,
      tono: criticas[0].score < 6 ? 'bad' : 'warn'
    });
  } else {
    diagnostico.push({
      titulo: 'Áreas críticas',
      detalle: `Ninguna competencia queda por debajo de ${META}/10. No hay foco correctivo: el trabajo pasa a modo mantenimiento.`,
      tono: 'ok'
    });
  }

  diagnostico.push({
    titulo: `Brecha para llegar a ${META}+/10`,
    detalle: brechaTotal > 0
      ? `Faltan ${brechaTotal} puntos repartidos en ${criticas.length} competencia${criticas.length === 1 ? '' : 's'}. `
        + `Concentrados en ${enumerar(foco.map((c) => c.name))}, que absorben `
        + `${r1(foco.reduce((a, c) => a + (META - c.score), 0))} de esos puntos.`
      : `Sin brecha pendiente: todas las competencias están en ${META}/10 o por encima.`,
    tono: brechaTotal > 2 ? 'bad' : brechaTotal > 0 ? 'warn' : 'ok'
  });

  diagnostico.push({
    titulo: 'Velocidad de mejora esperada',
    detalle: brechaTotal > 0
      ? `Con ${sesionesTotales} sesiones (${horasCoaching} h de coaching efectivo) la brecha se cierra en `
        + `aproximadamente ${diasEstimados} días. Ritmo de referencia del programa: ${GANANCIA_POR_SESION} puntos `
        + `por sesión de práctica dirigida con grabación.`
      : `No aplica: el asesor ya está en estándar. Mantener una simulación semanal para no perder nivel.`,
    tono: diasEstimados > 10 ? 'warn' : 'ok'
  });

  const riesgos = detectarRiesgos(data, comps, varianza, sem);
  diagnostico.push({
    titulo: 'Riesgos de desempeño',
    detalle: riesgos.length
      ? riesgos.join(' ')
      : 'Sin riesgos operativos detectados en esta sesión. El perfil es parejo y sostenido de principio a fin.',
    tono: riesgos.length ? 'warn' : 'ok'
  });

  diagnostico.push({
    titulo: 'Recomendación inmediata',
    detalle: `${sem.label}. ${sem.accion}`,
    tono: sem.nivel === 'verde' ? 'ok' : sem.nivel === 'amarillo' ? 'warn' : 'bad'
  });

  // ── C · Hitos y validaciones ─────────────────────────────────
  const hitos = [];
  const focoNombres = foco.length ? enumerar(foco.map((c) => c.name)) : 'las competencias en estándar';

  hitos.push({
    momento: 'Hoy',
    objetivo: brechaTotal > 0
      ? `Agendar el bloque de coaching de ${focoNombres} y compartir la grabación con el asesor.`
      : 'Confirmar al asesor el resultado y su asignación en piso.',
    metrica: 'Sesión agendada en calendario con hora y coach asignado',
    verificacion: 'Invitación enviada'
  });

  if (planMejora.length) {
    const primera = planMejora[0];
    hitos.push({
      momento: `Día 3 · ${formatDateLocal(fechaCheckpoint)}`,
      objetivo: `Checkpoint intermedio de ${primera.competencia}: simulación corta de 10 minutos centrada solo en esa competencia.`,
      metrica: `${primera.competencia} en ${r1(primera.score + primera.brecha / 2)}/10 o más`,
      verificacion: 'Simulación grabada y calificada por el coach'
    });
  }

  hitos.push({
    momento: 'Semana 1',
    objetivo: brechaTotal > 0
      ? `Completar ${sesionesTotales} sesiones de coaching (${horasCoaching} h) sobre ${focoNombres}.`
      : 'Sostener el nivel con dos simulaciones completas de práctica.',
    metrica: brechaTotal > 0
      ? `Todas las competencias del foco en ${META}/10 o más`
      : `Ninguna competencia por debajo de ${META}/10`,
    verificacion: 'Registro de asistencia a las sesiones'
  });

  hitos.push({
    momento: `Día 7 · ${formatDateLocal(fechaValidacion)}`,
    objetivo: 'Validación completa: simulación íntegra con familia simulada y evaluación de las seis competencias.',
    metrica: `Score global en ${META}/10 o más, sin ninguna competencia por debajo de 7/10`,
    verificacion: 'Nuevo reporte generado y comparado contra este'
  });

  if (sem.nivel === 'rojo') {
    hitos.push({
      momento: `Semana 2 · ${formatDateLocal(sumarDias(base, 14))}`,
      objetivo: 'Segunda validación obligatoria por semáforo rojo. Solo si la de día 7 no alcanzó el estándar.',
      metrica: `Score global en ${META}/10 o más`,
      verificacion: 'Decisión formal de autorización o escalado a dirección'
    });
  }

  // ── D · Criterios de aprobación ──────────────────────────────
  const criterios = [
    {
      condicion: `TODOS los scores en ${META}/10 o más`,
      resultado: 'Autorizar piso de ventas sin acompañamiento.',
      estado: criticas.length === 0 ? 'Se cumple hoy' : `No se cumple: faltan ${criticas.length}`,
      cls: criticas.length === 0 ? 'ok' : 'bad'
    },
    {
      condicion: `ALGUNO por debajo de ${META}/10`,
      resultado: `Extender el coaching ${Math.max(3, diasEstimados)} días y revalidar.`,
      estado: criticas.length ? `Se aplica: ${criticas.length} competencia${criticas.length === 1 ? '' : 's'} pendiente${criticas.length === 1 ? '' : 's'}` : 'No aplica',
      cls: criticas.length ? 'warn' : 'ok'
    },
    {
      condicion: `Score global 7/10 o más, pero con varianza superior a 1.5`,
      resultado: 'Refuerzo selectivo: solo las competencias por debajo, sin repetir el programa completo.',
      estado: score >= 7 && varianza > 1.5
        ? `Se aplica: varianza de ${varianza} puntos entre competencias`
        : `No aplica: varianza de ${varianza} puntos`,
      cls: score >= 7 && varianza > 1.5 ? 'warn' : 'ok'
    },
    {
      condicion: 'Cualquier competencia por debajo de 6/10',
      resultado: 'No autorizar contacto con familias reales bajo ninguna circunstancia.',
      estado: comps.some((c) => c.score < 6)
        ? `Se aplica: ${enumerar(comps.filter((c) => c.score < 6).map((c) => `${c.name} (${r1(c.score)})`))}`
        : 'No aplica: ninguna competencia por debajo de 6/10',
      cls: comps.some((c) => c.score < 6) ? 'bad' : 'ok'
    }
  ];

  // ── E · Próximos pasos del gerente ───────────────────────────
  const hoy = [];
  if (planMejora.length) {
    const primera = planMejora[0];
    hoy.push(`Agendar la primera sesión de ${primera.competencia} (${primera.minutos} min) antes de que termine el día.`);
    hoy.push(`Escuchar la grabación completa marcando los momentos donde ${primera.competencia} se rompe, y compartirlos con el asesor.`);
    hoy.push(`Comunicar al asesor las ${planMejora.length} competencia${planMejora.length === 1 ? '' : 's'} del foco: ${focoNombres}. Nada más — abrir más frentes diluye el resultado.`);
  } else {
    hoy.push('Confirmar al asesor que queda autorizado para piso y asignarle su primera familia real.');
    hoy.push('Guardar esta grabación como material de referencia para el resto del equipo.');
  }
  if (sem.nivel === 'rojo') {
    hoy.push('Bloquear la asignación de familias reales en el sistema hasta la validación de día 7.');
  }

  const monitoreo = [
    {
      frecuencia: 'Diario',
      que: planMejora.length
        ? `Una simulación de 10 minutos centrada en ${planMejora[0].competencia}, con la métrica: ${planMejora[0].metrica.toLowerCase()}.`
        : 'Confirmar que el asesor mantiene su ritmo de práctica sin supervisión.'
    },
    {
      frecuencia: 'Cada 48 horas',
      que: 'Revisar una grabación real o simulada y anotar si la señal de éxito ya aparece de forma espontánea.'
    },
    {
      frecuencia: 'Semanal',
      que: `Comparar el score de la nueva simulación contra el ${r1(score)}/10 de esta sesión. La tendencia importa más que el número suelto.`
    }
  ];

  const escalar = [
    `El score baja respecto al ${r1(score)}/10 de esta sesión en la validación de día 7.`,
    `Alguna competencia sigue por debajo de 6/10 tras ${Math.max(3, diasEstimados)} días de coaching.`,
    'El asesor falta a dos sesiones de coaching agendadas.',
    'La misma objeción se resuelve mal en tres simulaciones seguidas.'
  ];

  const proximosPasos = {
    hoy,
    monitoreo,
    reevaluacion: `${formatDateLong(fechaValidacion)} — simulación completa y reporte comparativo contra esta sesión.`,
    reevaluacion_fecha: formatDateLocal(fechaValidacion),
    escalar
  };

  // ── F · Notas de coaching ────────────────────────────────────
  const notas = {
    observaciones: notasObservaciones(data, comps, sem, score),
    reforzar: planMejora.length
      ? planMejora.map((p) => `${p.competencia}: ${p.tecnica.toLowerCase()}. Señal de que ya prendió — ${p.senal_exito.toLowerCase()}.`)
      : comps.slice(0, 2).map((c) => `${c.name} (${r1(c.score)}/10): mantener con una repetición semanal, sin corrección.`),
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
      notas
    },
    // Compatibilidad hacia atrás: el email y las integraciones viejas leen
    // plan_1/2/3. Se mantienen, ahora derivados del plan expandido.
    plan_1: diagnostico[0].detalle,
    plan_2: planMejora.length
      ? `${planMejora[0].competencia}: ${planMejora[0].dosis_texto}. ${planMejora[0].tecnica}. ${planMejora[0].timeline}.`
      : `Sin brecha pendiente. Mantener una simulación semanal para sostener el ${r1(score)}/10.`,
    plan_3: `Validación completa el ${formatDateLocal(fechaValidacion)}. `
      + `${criterios[0].condicion} → ${criterios[0].resultado}`
  };
}

// ════════════════════════════════════════════════════════════
// DETECTORES
// ════════════════════════════════════════════════════════════

/** Riesgos operativos deducidos de los datos reales, nunca genéricos. */
function detectarRiesgos(data, comps, varianza, sem) {
  const riesgos = [];
  const get = (nombre) => comps.find((c) => c.name.toLowerCase() === nombre);

  const cierre = get('cierre');
  const objeciones = get('objeciones');
  const lectura = get('lectura sala');
  const rapport = get('rapport');

  if (cierre && cierre.score < 7) {
    riesgos.push(`Cierre en ${r1(cierre.score)}/10: riesgo de sesiones largas que terminan sin decisión, con el costo de sala ya incurrido.`);
  }
  if (objeciones && objeciones.score < 7) {
    riesgos.push(`Objeciones en ${r1(objeciones.score)}/10: riesgo de ceder descuento para compensar la falta de respuesta, erosionando el margen.`);
  }
  if (lectura && lectura.score < 7) {
    riesgos.push(`Lectura de sala en ${r1(lectura.score)}/10: riesgo de insistir con un cliente ya cerrado y quemar la referencia.`);
  }
  if (rapport && rapport.score < 7) {
    riesgos.push(`Rapport en ${r1(rapport.score)}/10: riesgo de que la familia no comparta información real y toda la presentación apunte al lugar equivocado.`);
  }
  if (varianza > 1.8) {
    riesgos.push(`Perfil irregular (varianza de ${varianza} puntos): el resultado depende de qué tipo de familia le toque, no de su ejecución.`);
  }

  const min = Number(data.duracion_minutos);
  if (Number.isFinite(min) && min > 0 && min < 5) {
    riesgos.push(`Sesión de ${min} min: la muestra es corta y la evaluación tiene menor confianza. Conviene una segunda simulación antes de decidir.`);
  }
  if (Number.isFinite(min) && min > 35) {
    riesgos.push(`Sesión de ${min} min: por encima del tiempo objetivo de sala. Revisar dónde se pierde el ritmo.`);
  }

  const neuro = Number(data.cumplimiento_neuro);
  if (Number.isFinite(neuro) && neuro < 70) {
    riesgos.push(`Cumplimiento neurocientífico de ${Math.round(neuro)}%: el asesor está vendiendo por instinto, no por método — no es replicable ni enseñable.`);
  }
  if (sem.nivel === 'rojo') {
    riesgos.push('Semáforo en rojo: asignar familias reales ahora expone ingresos y la reputación del club.');
  }

  return riesgos;
}

/** Patrones de comportamiento cruzando fases de la venta. */
function detectarPatrones(data, comps, varianza) {
  const patrones = [];
  const get = (nombre) => {
    const c = comps.find((x) => x.name.toLowerCase() === nombre);
    return c ? c.score : null;
  };

  const apertura = [get('rapport'), get('lectura sala')].filter((n) => n !== null);
  const cierre = [get('objeciones'), get('cierre')].filter((n) => n !== null);

  if (apertura.length && cierre.length) {
    const dif = r1(promedio(apertura) - promedio(cierre));
    if (dif >= 1) {
      patrones.push(`Caída en la segunda mitad: abre en ${r1(promedio(apertura))}/10 y cierra en ${r1(promedio(cierre))}/10. `
        + `Conecta bien y pierde la venta en el tramo final — el trabajo está en el cierre, no en la apertura.`);
    } else if (dif <= -1) {
      patrones.push(`Patrón inverso: cierra en ${r1(promedio(cierre))}/10 pero abre en ${r1(promedio(apertura))}/10. `
        + `Entra en frío y recupera con técnica; con una apertura decente su cierre sería más fácil.`);
    } else {
      patrones.push(`Ejecución pareja entre apertura (${r1(promedio(apertura))}/10) y cierre (${r1(promedio(cierre))}/10): `
        + `el desempeño no depende de la fase, sino del nivel general.`);
    }
  }

  if (varianza <= 0.8) {
    patrones.push(`Perfil homogéneo (varianza de ${varianza} puntos): sube o baja en bloque. Un ajuste de método impacta todas las competencias a la vez.`);
  } else if (varianza > 1.5) {
    patrones.push(`Perfil disparejo (varianza de ${varianza} puntos): conviven competencias fuertes y débiles en la misma sesión. `
      + `El coaching debe ser selectivo, no general.`);
  }

  const neuro = Number(data.cumplimiento_neuro);
  if (Number.isFinite(neuro)) {
    if (neuro >= 85) {
      patrones.push(`Cumplimiento neurocientífico de ${Math.round(neuro)}%: aplica el marco de forma consistente, no por accidente.`);
    } else if (neuro < 70) {
      patrones.push(`Cumplimiento neurocientífico de ${Math.round(neuro)}%: usa los principios de forma intermitente. Reforzar el guion antes que la técnica.`);
    }
  }

  const turnos = Array.isArray(data.transcription) ? data.transcription.length : 0;
  const min = Number(data.duracion_minutos);
  if (turnos > 0 && Number.isFinite(min) && min > 0) {
    const ritmo = r1(turnos / min);
    if (ritmo < 2) {
      patrones.push(`Ritmo de ${ritmo} intervenciones por minuto: turnos largos. Verificar que no sea monólogo del asesor.`);
    } else if (ritmo > 8) {
      patrones.push(`Ritmo de ${ritmo} intervenciones por minuto: intercambio muy fragmentado, poco espacio para desarrollar una idea.`);
    }
  }

  return patrones;
}

/** Observaciones del entrenador, apoyadas en las listas reales del análisis. */
function notasObservaciones(data, comps, sem, score) {
  const obs = [];
  const fort = Array.isArray(data.fortalezas_list) ? data.fortalezas_list : [];
  const areas = Array.isArray(data.areas_list) ? data.areas_list : [];

  obs.push(`Sesión de ${data.duracion_texto || '—'} en el módulo ${data.modulo || '—'} con ${score >= 8 ? 'ejecución dentro del estándar' : 'ejecución por debajo del estándar'}: ${r1(score)}/10.`);

  if (fort.length) obs.push(`Lo que sí funcionó, en palabras del análisis: ${fort.slice(0, 2).join(' · ')}`);
  if (areas.length) obs.push(`Lo que hay que corregir: ${areas.slice(0, 2).join(' · ')}`);

  if (data.objeciones_trabajadas && !/no se registraron/i.test(String(data.objeciones_trabajadas))) {
    obs.push(`Objeciones que aparecieron en la sesión: ${String(data.objeciones_trabajadas).slice(0, 240)}`);
  }

  obs.push(`Lectura del entrenador: ${sem.accion}`);
  return obs;
}

/**
 * Recomendaciones personales del coach al gerente.
 * @param {Array<{competencia:string}>} foco Entradas YA enriquecidas (planMejora)
 */
function recomendacionesPersonales(data, sem, foco, score) {
  const recs = [];
  const nombre = data.nombre || 'el asesor';

  if (sem.nivel === 'verde') {
    recs.push(`Usar esta grabación de ${nombre} como material de referencia en la junta de equipo: es más útil un ejemplo propio que un video de manual.`);
    recs.push('Ofrecerle un rol de apoyo con los asesores nuevos: enseñar consolida lo que ya domina.');
  } else if (sem.nivel === 'amarillo') {
    recs.push(`Acompañar a ${nombre} en sus primeras dos familias reales sin intervenir, solo tomando notas. Corregir después, nunca delante del cliente.`);
    recs.push('Dar feedback en formato "una cosa que mantener, una cosa que cambiar". Más de dos correcciones simultáneas no se retienen.');
  } else {
    recs.push(`Trabajar con ${nombre} en privado antes de volver a piso: un fracaso público en sala retrasa la curva más que una semana de coaching.`);
    recs.push('Empezar por la competencia con mayor brecha, pero cerrar cada sesión con algo que ya hace bien: la confianza es parte del entrenamiento.');
  }

  if (foco.length) {
    recs.push(`Mantener el foco en ${enumerar(foco.map((f) => f.competencia))} durante los próximos 7 días. Todo lo demás se deja pasar aunque salte a la vista.`);
  }
  recs.push('Registrar cada sesión de coaching en el tracker con fecha, duración y competencia trabajada: sin registro no hay curva de aprendizaje que mostrar.');

  return recs;
}

module.exports = {
  buildActionPlan,
  META,
  // Exportados para pruebas
  dosificar,
  semaforo,
  desviacion
};