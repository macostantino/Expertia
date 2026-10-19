-- Tests de la agenda. Correr contra una base con las migraciones aplicadas
-- (Supabase: `supabase test db`-style; local: ver README). Todo corre en una transacción con rollback.
\set ON_ERROR_STOP on
begin;
grant usage on schema public to authenticated, anon;
grant select on all tables in schema public to authenticated;

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), true) $$;

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FALLÓ: %', msg; end if; end $$;

-- ── fixtures ──
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),  -- profesional
  ('00000000-0000-0000-0000-0000000000b1'),  -- paciente Ana
  ('00000000-0000-0000-0000-0000000000b2');  -- paciente Beto
insert into patients (id, full_name) values
  ('00000000-0000-0000-0000-0000000000b1', 'Ana Secreta Pérez'),
  ('00000000-0000-0000-0000-0000000000b2', 'Beto Reservado');
insert into professionals (id, user_id, display_name, timezone, buffer_minutes, min_notice_minutes, max_advance_days)
values ('00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-0000000000a1', 'Dra. Test', 'UTC', 10, 120, 60);
insert into consultation_types (id, professional_id, name, duration_minutes, price_cents) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000f', 'Consulta', 60, 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000f', 'Paga', 60, 5000);
insert into availability_rules (professional_id, weekday, start_time, end_time)
select '00000000-0000-0000-0000-00000000000f', d, '09:00', '17:00' from generate_series(0, 6) d;

\set prof '''00000000-0000-0000-0000-00000000000f'''
\set ct   '''00000000-0000-0000-0000-0000000000c1'''
\set ctp  '''00000000-0000-0000-0000-0000000000c2'''
\set pro  '''00000000-0000-0000-0000-0000000000a1'''
\set ana  '''00000000-0000-0000-0000-0000000000b1'''
\set beto '''00000000-0000-0000-0000-0000000000b2'''

-- Día de prueba: dentro de 3 días, 09:00 UTC.
create temp table t as select (date_trunc('day', now() at time zone 'UTC') + interval '3 days 9 hours') at time zone 'UTC' as d9;
grant select on t to authenticated;

-- ── 1. slots disponibles y buffer ──
do $$ declare n int; begin
  select count(*) into n from get_slots('00000000-0000-0000-0000-00000000000f',
    (select d9 from t), (select d9 + interval '8 hours' from t), '00000000-0000-0000-0000-0000000000c1');
  assert n = 8, format('esperaba 8 slots, hubo %s', n);   -- 9..16
  select count(*) into n from get_slots('00000000-0000-0000-0000-00000000000f',
    (select d9 from t), (select d9 + interval '8 hours' from t), '00000000-0000-0000-0000-0000000000c1')
    where status <> 'available';
  assert n = 0;
end $$;

-- ── 2. reserva + doble reserva + buffer ──
select pg_temp.as_user(:ana) as _u \gset
select id from book_appointment(:prof, :ct, (select d9 from t)) \gset ana_
select pg_temp.as_user(:beto) as _u \gset
do $$ begin
  begin
    perform book_appointment('00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000c1',(select d9 from t));
    assert false, 'debió fallar la doble reserva';
  exception when sqlstate 'AG409' then null; end;
end $$;
-- constraint de exclusión directo (simula dos clicks simultáneos que pasan la revalidación)
do $$ begin
  begin
    insert into appointments (professional_id, patient_id, starts_at, ends_at, buffer_minutes, status)
    select professional_id, '00000000-0000-0000-0000-0000000000b2', starts_at + interval '30 min', ends_at + interval '30 min', 10, 'confirmed'
    from appointments limit 1;
    assert false, 'el constraint debió impedir el solapamiento';
  exception when exclusion_violation then null; end;
end $$;
-- el slot siguiente (10:00) choca con el buffer de 10 min del turno de las 9:00-10:00
do $$ declare s text; begin
  select status into s from get_slots('00000000-0000-0000-0000-00000000000f',
    (select d9 + interval '1 hour' from t), (select d9 + interval '2 hours' from t), '00000000-0000-0000-0000-0000000000c1');
  assert s = 'busy', 'el buffer debe volver busy el slot contiguo, fue ' || coalesce(s, 'null');
  select status into s from get_slots('00000000-0000-0000-0000-00000000000f',
    (select d9 + interval '2 hours' from t), (select d9 + interval '3 hours' from t), '00000000-0000-0000-0000-0000000000c1');
  assert s = 'available';
end $$;

-- ── 3. PRIVACIDAD: el paciente solo ve available/busy ──
do $$ declare txt text; cols text; begin
  select string_agg(n, ',' order by o) into cols
  from pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality u(n, m, o)
  where p.proname = 'get_slots' and m = 't';
  assert cols = 'slot_start,slot_end,status', 'get_slots expone columnas inesperadas: ' || cols;

  select string_agg(to_jsonb(s)::text, ' ') into txt
  from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 - interval '1 day' from t),
                 (select d9 + interval '2 days' from t), '00000000-0000-0000-0000-0000000000c1') s;
  assert txt not ilike '%Secreta%' and txt not ilike '%Ana%' and txt not ilike '%b1%' and txt not ilike '%Beto%',
    'get_slots filtró datos de otro paciente';
  assert (select bool_and(status in ('available','busy'))
          from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 - interval '1 day' from t),
                         (select d9 + interval '2 days' from t), '00000000-0000-0000-0000-0000000000c1')),
    'status fuera de available/busy';
end $$;

-- el paciente no puede ver turnos ajenos ni usar la RPC del profesional ni los bloqueos
set local role authenticated;
do $$ begin
  assert (select count(*) from appointments) = 0, 'Beto vio turnos ajenos';
  begin perform * from get_agenda_pro(now(), now() + interval '1 day'); assert false;
  exception when sqlstate 'AG403' then null; end;
end $$;
reset role;

-- ── 4. vista del profesional: motivos detallados ──
select pg_temp.as_user(:pro) as _u \gset
-- pendiente de pago (10:00 queda libre tras el buffer? usamos 12:00) + bloqueo manual 14:00 + gcal 15:00
select pg_temp.as_user(:beto) as _u \gset
select id from book_appointment(:prof, :ctp, (select d9 + interval '3 hours' from t)) \gset pend_
select pg_temp.as_user(:pro) as _u \gset
select id from pro_block((select d9 + interval '5 hours' from t), (select d9 + interval '6 hours' from t), 'privado') \gset blk_
reset role;
insert into gcal_accounts (professional_id, refresh_token_enc, status) values (:prof, 'x', 'active');
insert into gcal_calendars (professional_id, calendar_id, blocks_agenda) values (:prof, 'primary', true);
insert into gcal_busy values (:prof, 'primary', tstzrange((select d9 + interval '6 hours' from t), (select d9 + interval '7 hours' from t)));
select pg_temp.as_user(:pro) as _u \gset
do $$ declare r text; begin
  select string_agg(distinct reason, ',' order by reason) into r
  from get_agenda_pro((select d9 from t), (select d9 + interval '9 hours' from t));
  assert r = 'available,confirmed,gcal_busy,manual_block,pending_payment', 'motivos: ' || r;
  assert (select expires_at is not null from get_agenda_pro((select d9 from t), (select d9 + interval '9 hours' from t))
          where reason = 'pending_payment'), 'pending_payment sin expires_at';
  assert (select patient_name from get_agenda_pro((select d9 from t), (select d9 + interval '9 hours' from t))
          where reason = 'confirmed') = 'Ana Secreta Pérez';
end $$;

-- gcal y bloqueo vuelven busy al paciente (sin motivo)
select pg_temp.as_user(:beto) as _u \gset
do $$ begin
  assert (select status from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 + interval '5 hours' from t),
          (select d9 + interval '6 hours' from t), '00000000-0000-0000-0000-0000000000c1')) = 'busy';
  assert (select status from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 + interval '6 hours' from t),
          (select d9 + interval '7 hours' from t), '00000000-0000-0000-0000-0000000000c1')) = 'busy';
end $$;

-- gcal desmarcado como bloqueante => vuelve a estar libre
reset role;
update gcal_calendars set blocks_agenda = false;
do $$ begin
  assert (select status from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 + interval '6 hours' from t),
          (select d9 + interval '7 hours' from t), '00000000-0000-0000-0000-0000000000c1')) = 'available';
end $$;
update gcal_calendars set blocks_agenda = true;

-- ── 5. pending_payment expirado no bloquea ──
update appointments set expires_at = now() - interval '1 second' where status = 'pending_payment';
do $$ begin
  assert (select status from get_slots('00000000-0000-0000-0000-00000000000f', (select d9 + interval '3 hours' from t),
          (select d9 + interval '4 hours' from t), '00000000-0000-0000-0000-0000000000c1')) = 'available',
    'un pendiente expirado no debe bloquear';
end $$;

-- ── 6. anticipación mínima: slot a 1h es busy (se ve gris), pasado no aparece ──
do $$ begin
  assert not exists (select 1 from get_slots('00000000-0000-0000-0000-00000000000f', now() - interval '3 days', now(),
                     '00000000-0000-0000-0000-0000000000c1')), 'el pasado no se devuelve';
end $$;

-- ── 7. reprogramar y cancelar; late_cancel y no_show visibles al profesional ──
select pg_temp.as_user(:pro) as _u \gset
select id from pro_reschedule(:'ana_id', (select d9 + interval '1 day 2 hours' from t)) \gset resc_
select pg_temp.check(starts_at = (select d9 + interval '1 day 2 hours' from t), 'reprogramar no movió el turno')
  from appointments where id = :'ana_id';
-- cancelación tardía del paciente: turno a < 24h
reset role;
insert into appointments (professional_id, patient_id, starts_at, ends_at, buffer_minutes, status)
values (:prof, :ana, now() + interval '5 hours', now() + interval '6 hours', 10, 'confirmed')
returning id \gset soon_
select pg_temp.as_user(:ana) as _u \gset
select status from cancel_appointment(:'soon_id') \gset c_
select pg_temp.check(:'c_status' = 'late_cancel', 'cancelación tardía debía ser late_cancel') as _c \gset
select pg_temp.as_user(:pro) as _u \gset
do $$ begin
  assert exists (select 1 from get_agenda_pro(now(), now() + interval '2 days') where reason = 'late_cancel');
end $$;

rollback;
\echo 'OK: todos los tests de agenda pasaron'
