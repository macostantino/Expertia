-- Jobs programados (solo en Supabase: requiere pg_cron, pg_net y vault).
-- Antes de aplicar, crear en Vault los secretos `functions_url` (https://<ref>.supabase.co/functions/v1)
-- y `service_role_key`.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name in ('pg_cron')) then
    raise notice 'pg_cron no disponible: se omiten los jobs';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  perform cron.schedule('agenda-expire-pending', '* * * * *', $job$ select public.expire_pending() $job$);

  -- Cola de escritura hacia Google: cada minuto.
  perform cron.schedule('gcal-outbox', '* * * * *', $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/gcal-cron',
      headers := jsonb_build_object('Content-Type', 'application/json',
                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body    := '{"job":"outbox"}'::jsonb) $job$);

  -- Fallback de lectura + renovación de watch channels: cada 15 minutos.
  perform cron.schedule('gcal-poll', '*/15 * * * *', $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/gcal-cron',
      headers := jsonb_build_object('Content-Type', 'application/json',
                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body    := '{"job":"poll"}'::jsonb) $job$);
end $$;
