-- Helpers atómicos para las edge functions de Google Calendar (solo service_role).

alter table public.gcal_sync_state add column refresh_started_at timestamptz;

-- Evita estampidas: un solo refresh por profesional cada 30 s.
create function public.gcal_claim_refresh(p_professional_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  insert into gcal_sync_state (professional_id) values (p_professional_id) on conflict do nothing;
  update gcal_sync_state set refresh_started_at = now()
   where professional_id = p_professional_id
     and (refresh_started_at is null or refresh_started_at < now() - interval '30 seconds')
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- Reemplaza TODO el cache de ocupados del profesional por los rangos recibidos
-- ([{calendar_id, start, end}]) y marca la ventana como cubierta.
create function public.gcal_replace_busy(
  p_professional_id uuid, p_from timestamptz, p_to timestamptz, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from gcal_busy where professional_id = p_professional_id;
  insert into gcal_busy (professional_id, calendar_id, during)
  select p_professional_id, r->>'calendar_id', tstzrange((r->>'start')::timestamptz, (r->>'end')::timestamptz)
  from jsonb_array_elements(p_rows) r
  where (r->>'end')::timestamptz > (r->>'start')::timestamptz;
  insert into gcal_sync_state (professional_id, covered, fetched_at, stale, refresh_started_at)
  values (p_professional_id, tstzrange(p_from, p_to), now(), false, null)
  on conflict (professional_id) do update
    set covered = excluded.covered, fetched_at = excluded.fetched_at, stale = false, refresh_started_at = null;
  perform public.notify_agenda(p_professional_id);
end $$;

create function public.gcal_mark_stale(p_professional_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into gcal_sync_state (professional_id, stale) values (p_professional_id, true)
  on conflict (professional_id) do update set stale = true, refresh_started_at = null
$$;

-- Token revocado/fallido: se limpia el cache, se avisa al profesional y la agenda sigue solo con datos internos.
create function public.gcal_revoke(p_professional_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update gcal_accounts set status = 'revoked', last_error = p_reason
   where professional_id = p_professional_id and status = 'active';
  if not found then return; end if;
  delete from gcal_busy where professional_id = p_professional_id;
  update gcal_outbox set processed_at = now(), last_error = 'account_revoked'
   where professional_id = p_professional_id and processed_at is null;
  insert into notifications (professional_id, kind, message)
  values (p_professional_id, 'gcal_revoked',
          'Se perdió la conexión con Google Calendar. La agenda funciona solo con tus turnos internos; reconectá tu cuenta para volver a sincronizar.');
  perform public.notify_agenda(p_professional_id);
end $$;

revoke all on function public.gcal_claim_refresh(uuid), public.gcal_mark_stale(uuid),
  public.gcal_replace_busy(uuid, timestamptz, timestamptz, jsonb), public.gcal_revoke(uuid, text)
  from public, anon, authenticated;
grant execute on function public.gcal_claim_refresh(uuid), public.gcal_mark_stale(uuid),
  public.gcal_replace_busy(uuid, timestamptz, timestamptz, jsonb), public.gcal_revoke(uuid, text)
  to service_role;
