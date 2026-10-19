-- Cálculo de slots (única fuente de verdad), reservas y operaciones del profesional.

create function public.current_professional() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from professionals where user_id = auth.uid();
  if v is null then raise exception 'not_professional' using errcode = 'AG403'; end if;
  return v;
end $$;

-- ¿Está libre el rango [lower, upper) para el profesional? Considera turnos activos
-- (pending_payment solo si no expiró), bloqueos manuales y Google Calendar (cache).
create function public._range_free(p_prof uuid, p_range tstzrange, p_exclude uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select
    not exists (
      select 1 from appointments a
      where a.professional_id = p_prof and a.blocked && p_range
        and a.id is distinct from p_exclude
        and (a.status in ('confirmed','in_progress')
             or (a.status = 'pending_payment' and a.expires_at > now())))
    and not exists (
      select 1 from availability_exceptions e
      where e.professional_id = p_prof and tstzrange(e.starts_at, e.ends_at) && p_range)
    and not exists (
      select 1 from gcal_busy b
      join gcal_calendars gc on gc.professional_id = b.professional_id and gc.calendar_id = b.calendar_id
      join gcal_accounts ga on ga.professional_id = b.professional_id
      where b.professional_id = p_prof and gc.blocks_agenda and ga.status = 'active'
        and b.during && p_range)
$$;

-- Slots candidatos según availability_rules + duración. No devuelve pasado, ni fuera de
-- horario, ni más allá de max_advance_days.
create function public._slots(p_prof uuid, p_from timestamptz, p_to timestamptz, p_ct uuid)
returns table (slot_start timestamptz, slot_end timestamptz, is_free boolean, too_soon boolean)
language sql stable security definer set search_path = public as $$
  with p as (select * from professionals where id = p_prof),
  c as (
    select duration_minutes * interval '1 minute' as dur
    from consultation_types where id = p_ct and professional_id = p_prof and active),
  d as (
    select g::date as day
    from p, generate_series(((p_from at time zone p.timezone)::date - 1)::timestamp,
                            (p_to at time zone p.timezone)::date::timestamp, interval '1 day') g),
  cand as (
    select distinct (ls at time zone p.timezone) as s
    from p cross join c cross join d
    join availability_rules r on r.professional_id = p.id and r.weekday = extract(dow from d.day)
    cross join lateral generate_series(d.day + r.start_time, d.day + r.end_time - c.dur,
                                       coalesce(p.slot_step_minutes * interval '1 minute', c.dur)) ls)
  select cand.s,
         cand.s + c.dur,
         public._range_free(p.id, tstzrange(cand.s, cand.s + c.dur + p.buffer_minutes * interval '1 minute')),
         cand.s < now() + p.min_notice_minutes * interval '1 minute'
  from cand cross join c cross join p
  where cand.s >= p_from and cand.s < p_to
    and cand.s > now()
    and cand.s < now() + p.max_advance_days * interval '1 day'
$$;
revoke all on function public._slots(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public._range_free(uuid, tstzrange, uuid) from public, anon, authenticated;

create function public._check_window(p_from timestamptz, p_to timestamptz) returns void
language plpgsql immutable as $$
begin
  if p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'invalid_range' using errcode = 'AG400';
  end if;
end $$;

-- Paciente (y público): SOLO available/busy. Sin motivo, sin datos de terceros.
create function public.get_slots(
  p_professional_id uuid, p_from timestamptz, p_to timestamptz, p_consultation_type_id uuid)
returns table (slot_start timestamptz, slot_end timestamptz, status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._check_window(p_from, p_to);
  return query
    select s.slot_start, s.slot_end,
           case when s.is_free and not s.too_soon then 'available' else 'busy' end
    from public._slots(p_professional_id, p_from, p_to, p_consultation_type_id) s
    order by s.slot_start;
end $$;
grant execute on function public.get_slots(uuid, timestamptz, timestamptz, uuid) to anon, authenticated;

-- Profesional: motivo detallado. kind = 'slot' (libres) | 'event' (ocupado, con motivo).
create function public.get_agenda_pro(
  p_from timestamptz, p_to timestamptz, p_consultation_type_id uuid default null)
returns table (kind text, starts_at timestamptz, ends_at timestamptz, reason text,
               appointment_id uuid, exception_id uuid, patient_name text,
               expires_at timestamptz, note text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_prof uuid := public.current_professional(); v_ct uuid;
begin
  perform public._check_window(p_from, p_to);
  v_ct := coalesce(p_consultation_type_id,
    (select id from consultation_types where professional_id = v_prof and active
     order by duration_minutes limit 1));
  return query
    select 'slot', s.slot_start, s.slot_end, 'available', null::uuid, null::uuid, null::text, null::timestamptz, null::text
    from public._slots(v_prof, p_from, p_to, v_ct) s
    where s.is_free
    union all
    select 'event', a.starts_at, a.ends_at,
           case
             when a.status = 'no_show'    then 'no_show'
             when a.status = 'late_cancel' then 'late_cancel'
             when a.status = 'pending_payment' then 'pending_payment'
             when a.kind = 'recurring' then 'recurring'
             when a.kind = 'package'   then 'package'
             else 'confirmed' end,
           a.id, null::uuid, coalesce(pt.full_name, a.guest_name), a.expires_at, null::text
    from appointments a left join patients pt on pt.id = a.patient_id
    where a.professional_id = v_prof and a.starts_at < p_to and a.ends_at > p_from
      and (a.status in ('confirmed','in_progress','completed','no_show','late_cancel')
           or (a.status = 'pending_payment' and a.expires_at > now()))
    union all
    select 'event', e.starts_at, e.ends_at, 'manual_block', null::uuid, e.id, null::text, null::timestamptz, e.note
    from availability_exceptions e
    where e.professional_id = v_prof and e.starts_at < p_to and e.ends_at > p_from
    union all
    select 'event', lower(b.during), upper(b.during), 'gcal_busy', null::uuid, null::uuid, null::text, null::timestamptz, null::text
    from gcal_busy b
    join gcal_calendars gc on gc.professional_id = b.professional_id and gc.calendar_id = b.calendar_id
    join gcal_accounts ga on ga.professional_id = b.professional_id
    where b.professional_id = v_prof and gc.blocks_agenda and ga.status = 'active'
      and lower(b.during) < p_to and upper(b.during) > p_from
    order by 2;
end $$;
grant execute on function public.get_agenda_pro(timestamptz, timestamptz, uuid) to authenticated;

-- ───────────── Reservas ─────────────
create function public._create_appointment(
  p_prof uuid, p_ct uuid, p_start timestamptz, p_patient uuid, p_guest text, p_manual boolean)
returns public.appointments
language plpgsql security definer set search_path = public as $$
declare
  v_p professionals; v_ct consultation_types; v_row appointments; v_slot record;
  v_status appointment_status := 'confirmed'; v_exp timestamptz;
begin
  -- Serializa reservas del mismo profesional: la revalidación (incluye gcal y bloqueos,
  -- que el constraint no cubre) y el insert ocurren en la misma transacción.
  perform pg_advisory_xact_lock(hashtextextended(p_prof::text, 0));
  select * into v_p from professionals where id = p_prof;
  if not found then raise exception 'professional_not_found' using errcode = 'AG404'; end if;
  select * into v_ct from consultation_types where id = p_ct and professional_id = p_prof and active;
  if not found then raise exception 'invalid_consultation_type' using errcode = 'AG400'; end if;

  update appointments set status = 'expired'
   where professional_id = p_prof and status = 'pending_payment' and expires_at <= now();

  select * into v_slot from public._slots(p_prof, p_start, p_start + interval '1 minute', p_ct) s
   where s.slot_start = p_start;
  if not found or not v_slot.is_free or (v_slot.too_soon and not p_manual) then
    raise exception 'slot_unavailable' using errcode = 'AG409';
  end if;

  if v_ct.price_cents > 0 and not p_manual then
    v_status := 'pending_payment';
    v_exp := now() + v_p.pending_payment_minutes * interval '1 minute';
  end if;

  begin
    insert into appointments (professional_id, patient_id, guest_name, consultation_type_id,
                              starts_at, ends_at, buffer_minutes, status, expires_at)
    values (p_prof, p_patient, p_guest, p_ct, p_start,
            p_start + v_ct.duration_minutes * interval '1 minute', v_p.buffer_minutes, v_status, v_exp)
    returning * into v_row;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'AG409';
  end;
  return v_row;
end $$;
revoke all on function public._create_appointment(uuid, uuid, timestamptz, uuid, text, boolean)
  from public, anon, authenticated;

create function public.book_appointment(
  p_professional_id uuid, p_consultation_type_id uuid, p_starts_at timestamptz)
returns public.appointments
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from patients where id = auth.uid()) then
    raise exception 'patient_profile_required' using errcode = 'AG401';
  end if;
  if (select count(*) from appointments
       where patient_id = auth.uid() and status = 'pending_payment' and expires_at > now()) >= 3 then
    raise exception 'too_many_pending' using errcode = 'AG429';
  end if;
  return public._create_appointment(p_professional_id, p_consultation_type_id, p_starts_at,
                                    auth.uid(), null, false);
end $$;
grant execute on function public.book_appointment(uuid, uuid, timestamptz) to authenticated;

create function public.pro_create_appointment(
  p_consultation_type_id uuid, p_starts_at timestamptz, p_guest_name text,
  p_patient_id uuid default null)
returns public.appointments
language plpgsql security definer set search_path = public as $$
begin
  if p_patient_id is null and coalesce(btrim(p_guest_name), '') = '' then
    raise exception 'patient_or_name_required' using errcode = 'AG400';
  end if;
  return public._create_appointment(public.current_professional(), p_consultation_type_id,
                                    p_starts_at, p_patient_id, nullif(btrim(p_guest_name), ''), true);
end $$;
grant execute on function public.pro_create_appointment(uuid, timestamptz, text, uuid) to authenticated;

create function public.pro_block(p_starts_at timestamptz, p_ends_at timestamptz, p_note text default null)
returns public.availability_exceptions
language plpgsql security definer set search_path = public as $$
declare v_prof uuid := public.current_professional(); v_row availability_exceptions;
begin
  if p_ends_at <= p_starts_at then raise exception 'invalid_range' using errcode = 'AG400'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_prof::text, 0));
  if exists (select 1 from appointments a
             where a.professional_id = v_prof and a.blocked && tstzrange(p_starts_at, p_ends_at)
               and (a.status in ('confirmed','in_progress')
                    or (a.status = 'pending_payment' and a.expires_at > now()))) then
    raise exception 'overlaps_appointment' using errcode = 'AG409';
  end if;
  insert into availability_exceptions (professional_id, starts_at, ends_at, note)
  values (v_prof, p_starts_at, p_ends_at, p_note) returning * into v_row;
  return v_row;
end $$;
grant execute on function public.pro_block(timestamptz, timestamptz, text) to authenticated;

create function public.pro_unblock(p_exception_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from availability_exceptions where id = p_exception_id and professional_id = public.current_professional();
  if not found then raise exception 'not_found' using errcode = 'AG404'; end if;
end $$;
grant execute on function public.pro_unblock(uuid) to authenticated;

create function public.pro_reschedule(p_appointment_id uuid, p_new_start timestamptz)
returns public.appointments
language plpgsql security definer set search_path = public as $$
declare v_prof uuid := public.current_professional(); v_a appointments; v_dur interval;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_prof::text, 0));
  select * into v_a from appointments where id = p_appointment_id and professional_id = v_prof for update;
  if not found or v_a.status not in ('confirmed','pending_payment') then
    raise exception 'not_reschedulable' using errcode = 'AG404';
  end if;
  if p_new_start <= now() then raise exception 'slot_unavailable' using errcode = 'AG409'; end if;
  v_dur := v_a.ends_at - v_a.starts_at;
  if not public._range_free(v_prof,
       tstzrange(p_new_start, p_new_start + v_dur + v_a.buffer_minutes * interval '1 minute'), v_a.id) then
    raise exception 'slot_unavailable' using errcode = 'AG409';
  end if;
  begin
    update appointments set starts_at = p_new_start, ends_at = p_new_start + v_dur
     where id = v_a.id returning * into v_a;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'AG409';
  end;
  return v_a;
end $$;
grant execute on function public.pro_reschedule(uuid, timestamptz) to authenticated;

-- Profesional: cancelled. Paciente: late_cancel si falta menos que late_cancel_hours.
create function public.cancel_appointment(p_appointment_id uuid)
returns public.appointments
language plpgsql security definer set search_path = public as $$
declare v_a appointments; v_p professionals; v_status appointment_status;
begin
  select * into v_a from appointments where id = p_appointment_id for update;
  if not found or v_a.status not in ('confirmed','pending_payment') then
    raise exception 'not_cancellable' using errcode = 'AG404';
  end if;
  select * into v_p from professionals where id = v_a.professional_id;
  if v_p.user_id = auth.uid() then
    v_status := 'cancelled';
  elsif v_a.patient_id = auth.uid() then
    v_status := case when v_a.status = 'confirmed'
                      and v_a.starts_at - v_p.late_cancel_hours * interval '1 hour' < now()
                     then 'late_cancel' else 'cancelled' end;
  else
    raise exception 'forbidden' using errcode = 'AG403';
  end if;
  update appointments set status = v_status, expires_at = null where id = v_a.id returning * into v_a;
  return v_a;
end $$;
grant execute on function public.cancel_appointment(uuid) to authenticated;

create function public.pro_mark_no_show(p_appointment_id uuid)
returns public.appointments
language plpgsql security definer set search_path = public as $$
declare v_a appointments;
begin
  update appointments set status = 'no_show'
   where id = p_appointment_id and professional_id = public.current_professional()
     and status in ('confirmed','in_progress') and starts_at < now()
  returning * into v_a;
  if not found then raise exception 'not_found' using errcode = 'AG404'; end if;
  return v_a;
end $$;
grant execute on function public.pro_mark_no_show(uuid) to authenticated;

-- Solo backend (webhook de pagos / cron).
create function public.confirm_payment(p_appointment_id uuid)
returns public.appointments
language plpgsql security definer set search_path = public as $$
declare v_a appointments;
begin
  update appointments set status = 'confirmed', expires_at = null
   where id = p_appointment_id and status = 'pending_payment' and expires_at > now()
  returning * into v_a;
  if not found then raise exception 'payment_too_late_or_unknown' using errcode = 'AG409'; end if;
  return v_a;
end $$;

create function public.expire_pending() returns int
language sql security definer set search_path = public as $$
  with u as (update appointments set status = 'expired'
              where status = 'pending_payment' and expires_at <= now() returning 1)
  select count(*)::int from u
$$;
revoke all on function public.confirm_payment(uuid), public.expire_pending() from public, anon, authenticated;
grant execute on function public.confirm_payment(uuid), public.expire_pending() to service_role;

-- ───────────── Cache de Google ─────────────
create function public.gcal_needs_refresh(p_professional_id uuid, p_from timestamptz, p_to timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from gcal_accounts ga
    where ga.professional_id = p_professional_id and ga.status = 'active'
      and exists (select 1 from gcal_calendars gc where gc.professional_id = ga.professional_id and gc.blocks_agenda)
      and not exists (
        select 1 from gcal_sync_state s
        where s.professional_id = ga.professional_id and not s.stale
          and s.fetched_at > now() - interval '5 minutes'
          and s.covered @> tstzrange(p_from, p_to)))
$$;
grant execute on function public.gcal_needs_refresh(uuid, timestamptz, timestamptz) to anon, authenticated;

-- ───────────── Triggers ─────────────
create function public.appointments_defaults() returns trigger
language plpgsql as $$
declare v_base text;
begin
  if new.meeting_url is null then
    select meeting_base_url into v_base from professionals where id = new.professional_id;
    if v_base is not null then new.meeting_url := v_base || new.id::text; end if;
  end if;
  return new;
end $$;
create trigger appointments_defaults before insert on public.appointments
  for each row execute function public.appointments_defaults();

-- Cola de escritura hacia Google (la procesa la edge function gcal-cron).
create function public.appointments_gcal_outbox() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cal text; v_live boolean; v_was_live boolean := false; v_dead boolean;
begin
  select gc.calendar_id into v_cal
  from gcal_calendars gc join gcal_accounts ga on ga.professional_id = gc.professional_id
  where gc.professional_id = new.professional_id and gc.is_write_target and ga.status = 'active';
  if v_cal is null then return new; end if;

  v_live := new.status in ('confirmed','in_progress');
  v_dead := new.status in ('cancelled','late_cancel','expired');
  if tg_op = 'UPDATE' then v_was_live := old.status in ('confirmed','in_progress'); end if;

  if v_live and (tg_op = 'INSERT' or not v_was_live
                 or old.starts_at <> new.starts_at or old.ends_at <> new.ends_at) then
    insert into gcal_outbox (professional_id, appointment_id, op, calendar_id)
    values (new.professional_id, new.id, 'upsert', v_cal);
  elsif v_dead and new.gcal_event_id is not null then
    insert into gcal_outbox (professional_id, appointment_id, op, calendar_id, gcal_event_id)
    values (new.professional_id, new.id, 'delete', v_cal, new.gcal_event_id);
  end if;
  return new;
end $$;
create trigger appointments_gcal_outbox after insert or update on public.appointments
  for each row execute function public.appointments_gcal_outbox();

-- Realtime: broadcast público SIN datos (solo "cambió"); cada cliente re-consulta get_slots.
-- No se usa postgres_changes porque el RLS impide que un paciente vea turnos ajenos.
create function public.notify_agenda(p_professional_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(jsonb_build_object('t', extract(epoch from clock_timestamp())),
                          'changed', 'agenda:' || p_professional_id::text, false);
  end if;
end $$;
revoke all on function public.notify_agenda(uuid) from public, anon, authenticated;
grant execute on function public.notify_agenda(uuid) to service_role;

create function public.agenda_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_agenda(coalesce(new.professional_id, old.professional_id));
  return null;
end $$;
create trigger appointments_notify after insert or update or delete on public.appointments
  for each row execute function public.agenda_changed();
create trigger exceptions_notify after insert or update or delete on public.availability_exceptions
  for each row execute function public.agenda_changed();
