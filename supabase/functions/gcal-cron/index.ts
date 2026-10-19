import {
  admin, gapi, GoogleAuthError, handle, HttpError, json, safeRefresh, startWatch, stopWatch,
} from "../_shared/google.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Jobs de pg_cron (con la service role key): "outbox" escribe turnos en Google, "poll" lee y renueva canales.
Deno.serve(handle(async (req) => {
  if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    throw new HttpError(401, "service_role_required");
  }
  const { job } = await req.json().catch(() => ({}));
  const sb = admin();
  if (job === "outbox") return json(await processOutbox(sb));
  if (job === "poll") return json(await poll(sb));
  throw new HttpError(400, "unknown_job");
}));

// ───────────── Escritura: turnos → eventos ─────────────
async function processOutbox(sb: SupabaseClient) {
  const { data: jobs } = await sb.from("gcal_outbox").select("*").is("processed_at", null).lt("attempts", 5)
    .order("id").limit(50);
  let done = 0;
  for (const j of jobs ?? []) {
    try {
      if (j.op === "delete") await deleteEvent(sb, j);
      else await upsertEvent(sb, j);
      await sb.from("gcal_outbox").update({ processed_at: new Date().toISOString() }).eq("id", j.id);
      done++;
    } catch (e) {
      // Token revocado: gcal_revoke ya cerró la cola; el resto se reintenta (máx. 5 veces).
      await sb.from("gcal_outbox").update({ attempts: j.attempts + 1, last_error: String(e).slice(0, 300) }).eq("id", j.id);
    }
  }
  return { processed: done };
}

const evPath = (cal: string, id?: string) =>
  `/calendars/${encodeURIComponent(cal)}/events${id ? `/${encodeURIComponent(id)}` : ""}`;

async function upsertEvent(sb: SupabaseClient, j: { professional_id: string; appointment_id: string; calendar_id: string }) {
  const { data: a } = await sb.from("appointments")
    .select("id, status, starts_at, ends_at, meeting_url, guest_name, gcal_event_id, patients(full_name), professionals(timezone)")
    .eq("id", j.appointment_id).single();
  if (!a || !["confirmed", "in_progress"].includes(a.status)) return; // ya no corresponde
  const name = (a.patients as { full_name: string } | null)?.full_name ?? a.guest_name ?? "Paciente";
  const tz = (a.professionals as { timezone: string }).timezone;
  const body = {
    summary: `Consulta – ${name}`,
    description: a.meeting_url ? `Sala: ${a.meeting_url}` : undefined,
    location: a.meeting_url ?? undefined,
    start: { dateTime: a.starts_at, timeZone: tz },
    end: { dateTime: a.ends_at, timeZone: tz },
    // Marca de origen: permite que la lectura ignore los eventos de la propia app.
    extendedProperties: { private: { expertia_appointment_id: a.id } },
  };
  let r: Response | undefined;
  if (a.gcal_event_id) {
    r = await gapi(sb, j.professional_id, evPath(j.calendar_id, a.gcal_event_id), { method: "PATCH", body: JSON.stringify(body) });
    if (r.status === 404 || r.status === 410) r = undefined; // evento borrado a mano: se recrea
  }
  if (!r) r = await gapi(sb, j.professional_id, evPath(j.calendar_id), { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`events.write ${r.status}`);
  const ev = await r.json();
  if (ev.id !== a.gcal_event_id) await sb.from("appointments").update({ gcal_event_id: ev.id }).eq("id", a.id);
}

async function deleteEvent(sb: SupabaseClient, j: { professional_id: string; appointment_id: string; calendar_id: string; gcal_event_id: string }) {
  const r = await gapi(sb, j.professional_id, evPath(j.calendar_id, j.gcal_event_id), { method: "DELETE" });
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`events.delete ${r.status}`);
  await sb.from("appointments").update({ gcal_event_id: null }).eq("id", j.appointment_id);
}

// ───────────── Lectura: fallback por polling + renovación de canales ─────────────
async function poll(sb: SupabaseClient) {
  const { data: accounts } = await sb.from("gcal_accounts").select("professional_id").eq("status", "active");
  let refreshed = 0;
  for (const { professional_id } of accounts ?? []) {
    try {
      const { data: cals } = await sb.from("gcal_calendars").select("*").eq("professional_id", professional_id).eq("blocks_agenda", true);
      const soon = Date.now() + 24 * 3600_000;
      for (const c of cals ?? []) {
        if (!c.watch_channel_id || !c.watch_expires_at || new Date(c.watch_expires_at).getTime() < soon) {
          if (c.watch_channel_id) await stopWatch(sb, professional_id, c);
          await startWatch(sb, professional_id, c.calendar_id);
        }
      }
      if (await safeRefresh(sb, professional_id)) refreshed++;
    } catch (e) {
      if (!(e instanceof GoogleAuthError)) console.error("poll", professional_id, e);
    }
  }
  return { refreshed };
}
