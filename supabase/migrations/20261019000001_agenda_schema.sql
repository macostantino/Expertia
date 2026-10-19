-- Agenda: esquema base (profesionales, disponibilidad, turnos, Google Calendar).
-- Requiere Postgres 15+ (Supabase). Los turnos solo se escriben vía RPC.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ───────────── Entidades base ─────────────
create table public.patients (
  id        uuid primary key references auth.users(id) on delete cascade,
  full_name text not null
);

create table public.professionals (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null unique references auth.users(id) on delete cascade,
  display_name            text not null,
  timezone                text not null default 'America/Argentina/Buenos_Aires',
  buffer_minutes          int  not null default 0   check (buffer_minutes between 0 and 120),
  min_notice_minutes      int  not null default 120 check (min_notice_minutes >= 0),
  max_advance_days        int  not null default 60  check (max_advance_days between 1 and 365),
  slot_step_minutes       int  check (slot_step_minutes between 5 and 240), -- null = duración de la consulta
  late_cancel_hours       int  not null default 24  check (late_cancel_hours >= 0),
  pending_payment_minutes int  not null default 15  check (pending_payment_minutes between 1 and 120),
  meeting_base_url        text                      -- link a la sala = base || appointment_id
);

create table public.consultation_types (
  id               uuid primary key default gen_random_uuid(),
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  name             text not null,
  duration_minutes int  not null check (duration_minutes between 5 and 480),
  price_cents      int  not null default 0 check (price_cents >= 0),
  active           boolean not null default true
);
create index on public.consultation_types (professional_id);

create table public.availability_rules (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  weekday         smallint not null check (weekday between 0 and 6), -- 0 = domingo (extract(dow))
  start_time      time not null,
  end_time        time not null,
  check (end_time > start_time)
);
create index on public.availability_rules (professional_id, weekday);

-- Bloqueos manuales del profesional (no públicos: la nota es privada).
create table public.availability_exceptions (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  note            text,
  created_at      timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on public.availability_exceptions using gist (professional_id, tstzrange(starts_at, ends_at));

-- ───────────── Turnos ─────────────
create type public.appointment_status as enum
  ('pending_payment','confirmed','in_progress','completed','cancelled','late_cancel','no_show','expired');
create type public.appointment_kind as enum ('single','recurring','package');

create table public.appointments (
  id                   uuid primary key default gen_random_uuid(),
  professional_id      uuid not null references public.professionals(id) on delete cascade,
  patient_id           uuid references public.patients(id) on delete set null,
  guest_name           text,                      -- turnos manuales sin cuenta
  consultation_type_id uuid references public.consultation_types(id) on delete set null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  buffer_minutes       int  not null default 0,
  blocked              tstzrange not null,        -- [starts_at, ends_at + buffer); lo mantiene el trigger
  status               public.appointment_status not null default 'confirmed',
  kind                 public.appointment_kind   not null default 'single',
  expires_at           timestamptz,               -- solo pending_payment
  meeting_url          text,
  gcal_event_id        text,
  created_at           timestamptz not null default now(),
  check (ends_at > starts_at),
  check (status <> 'pending_payment' or expires_at is not null),
  check (patient_id is not null or guest_name is not null),
  -- Garantía final contra doble reserva, aunque dos pacientes clickeen a la vez.
  constraint appointments_no_overlap exclude using gist
    (professional_id with =, blocked with &&)
    where (status in ('pending_payment','confirmed','in_progress'))
);
create index on public.appointments (patient_id);
create index on public.appointments (professional_id, starts_at);

create function public.appointments_set_blocked() returns trigger
language plpgsql as $$
begin
  new.blocked := tstzrange(new.starts_at, new.ends_at + make_interval(mins => new.buffer_minutes));
  return new;
end $$;
create trigger appointments_blocked before insert or update of starts_at, ends_at, buffer_minutes
  on public.appointments for each row execute function public.appointments_set_blocked();

-- ───────────── Google Calendar ─────────────
-- Tokens cifrados (AES-GCM) por la edge function; sin policies => solo service_role.
create table public.gcal_accounts (
  professional_id   uuid primary key references public.professionals(id) on delete cascade,
  google_email      text,
  refresh_token_enc text not null,
  access_token_enc  text,
  access_expires_at timestamptz,
  status            text not null default 'active' check (status in ('active','revoked','error')),
  last_error        text,
  connected_at      timestamptz not null default now()
);

create table public.gcal_calendars (
  id               uuid primary key default gen_random_uuid(),
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  calendar_id      text not null,
  summary          text,                            -- nombre del calendario, no de eventos
  blocks_agenda    boolean not null default false,
  is_write_target  boolean not null default false,
  watch_channel_id text,
  watch_token      text,
  watch_resource_id text,
  watch_expires_at timestamptz,
  unique (professional_id, calendar_id)
);
create unique index gcal_one_write_target on public.gcal_calendars (professional_id) where is_write_target;
create index on public.gcal_calendars (watch_channel_id);

-- Solo rangos ocupados: jamás títulos ni descripciones.
create table public.gcal_busy (
  professional_id uuid not null references public.professionals(id) on delete cascade,
  calendar_id     text not null,
  during          tstzrange not null
);
create index on public.gcal_busy using gist (professional_id, during);

create table public.gcal_sync_state (
  professional_id uuid primary key references public.professionals(id) on delete cascade,
  covered         tstzrange,                 -- ventana cacheada
  fetched_at      timestamptz,
  stale           boolean not null default true
);

create table public.gcal_outbox (
  id             bigserial primary key,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  appointment_id uuid,
  op             text not null check (op in ('upsert','delete')),
  calendar_id    text not null,
  gcal_event_id  text,                        -- para delete
  attempts       int not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);
create index on public.gcal_outbox (created_at) where processed_at is null;

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  kind            text not null,
  message         text not null,
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);

-- ───────────── RLS ─────────────
alter table public.patients                enable row level security;
alter table public.professionals           enable row level security;
alter table public.consultation_types      enable row level security;
alter table public.availability_rules      enable row level security;
alter table public.availability_exceptions enable row level security;
alter table public.appointments            enable row level security;
alter table public.gcal_accounts           enable row level security;
alter table public.gcal_calendars          enable row level security;
alter table public.gcal_busy               enable row level security;
alter table public.gcal_sync_state         enable row level security;
alter table public.gcal_outbox             enable row level security;
alter table public.notifications           enable row level security;

create function public.is_owner(p_professional_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from professionals where id = p_professional_id and user_id = auth.uid())
$$;

create policy patients_self      on public.patients for select using (id = auth.uid());
create policy patients_self_ins  on public.patients for insert with check (id = auth.uid());
create policy patients_self_upd  on public.patients for update using (id = auth.uid());

create policy prof_public_read on public.professionals for select using (true);
create policy prof_owner_write on public.professionals for update using (user_id = auth.uid());

create policy ct_read  on public.consultation_types for select using (active or public.is_owner(professional_id));
create policy ct_write on public.consultation_types for all
  using (public.is_owner(professional_id)) with check (public.is_owner(professional_id));

create policy rules_read  on public.availability_rules for select using (true);
create policy rules_write on public.availability_rules for all
  using (public.is_owner(professional_id)) with check (public.is_owner(professional_id));

create policy exc_owner on public.availability_exceptions for select using (public.is_owner(professional_id));

create policy appt_read on public.appointments for select
  using (patient_id = auth.uid() or public.is_owner(professional_id));

create policy gcal_cal_owner on public.gcal_calendars for select using (public.is_owner(professional_id));
create policy notif_owner on public.notifications for select using (public.is_owner(professional_id));
create policy notif_owner_upd on public.notifications for update using (public.is_owner(professional_id));

-- Estado de la conexión sin exponer tokens.
create view public.gcal_connection with (security_invoker = false) as
  select a.professional_id, a.google_email, a.status, a.last_error, a.connected_at
  from public.gcal_accounts a
  where public.is_owner(a.professional_id);
grant select on public.gcal_connection to authenticated;
