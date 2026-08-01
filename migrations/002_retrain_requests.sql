-- ════════════════════════════════════════════════════════════
-- retrain_requests — Solicitudes de reentrenamiento
-- Proyecto: victor-ia-agent
-- Ejecutar en: Supabase → SQL Editor
--
-- La escribe POST /api/retrain-request (y /api/retrain) a través de
-- src/server/retrain-request.js, vía la API REST de Supabase.
--
-- La tabla es OPCIONAL: si SUPABASE_URL/SUPABASE_KEY no están definidas, la
-- solicitud se registra en memoria del proceso y el correo al gerente se envía
-- igual. Lo que nunca puede fallar es la notificación; esto es la trazabilidad.
-- ════════════════════════════════════════════════════════════

create table if not exists public.retrain_requests (
  id               uuid primary key default gen_random_uuid(),
  -- Folio legible que se muestra al solicitante y viaja en el correo
  request_id       text        not null unique,
  conversation_id  text        not null,
  asesor           text,
  empleado_id      text,
  modulo           text,
  score_overall    numeric(4,2),
  competencias     jsonb       not null default '[]'::jsonb,
  prioridad        text        not null default 'MEDIA'
                     check (prioridad in ('ALTA','MEDIA','BAJA')),
  notas            text,
  solicitante      text,
  destinatarios    jsonb       not null default '[]'::jsonb,
  estado           text        not null default 'pendiente'
                     check (estado in ('pendiente','agendado','completado','cancelado')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table  public.retrain_requests is 'Solicitudes de reentrenamiento generadas desde el reporte de capacitación.';
comment on column public.retrain_requests.request_id is 'Folio RTR-<timestamp>-<rand> mostrado al solicitante y enviado en el correo.';
comment on column public.retrain_requests.competencias is 'Competencias a reforzar. Si el solicitante no marcó ninguna, son las que estaban por debajo del estándar de 8/10.';
comment on column public.retrain_requests.destinatarios is 'Correos a los que se notificó (RETRAIN_REQUEST_EMAIL).';
comment on column public.retrain_requests.estado is 'Ciclo de vida de la solicitud. Lo actualiza el gerente, no el sistema.';

-- Consulta habitual: "¿qué está pendiente?" y "¿qué se pidió de este asesor?"
create index if not exists retrain_requests_created_at_idx
  on public.retrain_requests (created_at desc);
create index if not exists retrain_requests_conversation_idx
  on public.retrain_requests (conversation_id);
create index if not exists retrain_requests_estado_idx
  on public.retrain_requests (estado)
  where estado = 'pendiente';

-- Mantiene updated_at honesto sin depender de que el cliente lo mande
create or replace function public.touch_retrain_requests()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists retrain_requests_touch on public.retrain_requests;
create trigger retrain_requests_touch
  before update on public.retrain_requests
  for each row execute function public.touch_retrain_requests();

-- RLS activo: el servicio escribe con la service key, nadie más entra.
alter table public.retrain_requests enable row level security;