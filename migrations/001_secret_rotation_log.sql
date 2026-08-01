-- ════════════════════════════════════════════════════════════
-- secret_rotation_log — Auditoría de rotación de secretos
-- Proyecto: victor-ia-agent
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════

create table if not exists public.secret_rotation_log (
  id                      uuid primary key default gen_random_uuid(),
  rotated_at              timestamptz not null default now(),
  next_rotation           timestamptz,
  triggered_by            text        not null default 'unknown',
  keys_rotated            jsonb       not null default '[]'::jsonb,
  keys_failed             jsonb       not null default '[]'::jsonb,
  manual_action_required  jsonb       not null default '[]'::jsonb,
  status                  text        not null default 'success'
                            check (status in ('success','partial','failed')),
  duration_ms             integer,
  details                 jsonb       not null default '{}'::jsonb,
  environment             text        not null default 'production',
  created_at              timestamptz not null default now()
);

comment on table  public.secret_rotation_log is 'Historial de rotaciones automáticas de API keys y secretos (cada 90 días).';
comment on column public.secret_rotation_log.keys_rotated is 'Array de nombres de env vars rotadas correctamente.';
comment on column public.secret_rotation_log.manual_action_required is 'Keys que no se pueden rotar por API (p. ej. ELEVENLABS_API_KEY).';
comment on column public.secret_rotation_log.details is 'Metadatos por key. NUNCA debe contener valores de secretos.';

create index if not exists secret_rotation_log_rotated_at_idx
  on public.secret_rotation_log (rotated_at desc);
create index if not exists secret_rotation_log_status_idx
  on public.secret_rotation_log (status);

-- ──────────────────────────────────────────────
-- RLS: solo la service_role puede leer/escribir.
-- El backend usa SUPABASE_SERVICE_KEY, que hace bypass de RLS.
-- Esto impide que una anon key exponga el historial.
-- ──────────────────────────────────────────────
alter table public.secret_rotation_log enable row level security;

drop policy if exists "service_role_full_access" on public.secret_rotation_log;
create policy "service_role_full_access"
  on public.secret_rotation_log
  for all
  to service_role
  using (true)
  with check (true);

-- ──────────────────────────────────────────────
-- Vista de conveniencia: estado actual
-- ──────────────────────────────────────────────
create or replace view public.secret_rotation_status as
select
  rotated_at                                            as last_rotation,
  next_rotation,
  extract(day from (next_rotation - now()))::int        as days_remaining,
  (next_rotation < now())                               as overdue,
  status,
  triggered_by,
  keys_rotated,
  manual_action_required
from public.secret_rotation_log
order by rotated_at desc
limit 1;