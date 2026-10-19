// Utilidades compartidas de Google Calendar. Corre en Deno (Supabase Edge Functions).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  // Necesario solo para listar los calendarios del profesional (nombre + id).
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Falta la variable ${k}`);
  return v;
};

export const functionsUrl = () => `${env("SUPABASE_URL")}/functions/v1`;
export const appUrl = () => env("APP_URL").replace(/\/$/, "");

export function admin(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

/** Usuario autenticado de la request (JWT del cliente). */
export async function requireUser(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "unauthorized");
  return data.user;
}

export async function requireProfessional(req: Request) {
  const user = await requireUser(req);
  const { data } = await admin().from("professionals").select("id, timezone, max_advance_days")
    .eq("user_id", user.id).maybeSingle();
  if (!data) throw new HttpError(403, "not_professional");
  return data as { id: string; timezone: string; max_advance_days: number };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class GoogleAuthError extends Error {}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try { return await fn(req); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal_error" }, 500);
    }
  };
}

// ───────────── Cifrado de tokens (AES-GCM 256) ─────────────
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key(): Promise<CryptoKey> {
  const raw = unb64(env("GCAL_TOKEN_KEY")); // 32 bytes en base64: `openssl rand -base64 32`
  if (raw.length !== 32) throw new Error("GCAL_TOKEN_KEY debe tener 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decrypt(enc: string): Promise<string> {
  const [iv, ct] = enc.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ───────────── state firmado (OAuth) ─────────────
async function hmac(data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("GCAL_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
export async function signState(professionalId: string): Promise<string> {
  const body = btoa(JSON.stringify({ p: professionalId, exp: Date.now() + 10 * 60_000 }));
  return `${body}.${await hmac(body)}`;
}
export async function verifyState(state: string): Promise<string> {
  const [body, sig] = state.split(".");
  if (!body || !sig || (await hmac(body)) !== sig) throw new HttpError(400, "bad_state");
  const { p, exp } = JSON.parse(atob(body));
  if (Date.now() > exp) throw new HttpError(400, "state_expired");
  return p as string;
}

// ───────────── OAuth / tokens ─────────────
export const redirectUri = () => `${functionsUrl()}/gcal-oauth-callback`;

export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    scope: SCOPES.join(" "), state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), ...params }),
  });
  const body = await r.json();
  if (!r.ok) {
    if (body.error === "invalid_grant") throw new GoogleAuthError(body.error_description ?? "invalid_grant");
    throw new Error(`token endpoint: ${body.error ?? r.status}`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}
export const exchangeCode = (code: string) =>
  tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });

/** Access token vigente o null si la cuenta no está activa. Si Google revocó el acceso, avisa y desactiva. */
export async function accessToken(sb: SupabaseClient, professionalId: string): Promise<string | null> {
  const { data: acc } = await sb.from("gcal_accounts").select("*").eq("professional_id", professionalId).maybeSingle();
  if (!acc || acc.status !== "active") return null;
  if (acc.access_token_enc && acc.access_expires_at && new Date(acc.access_expires_at).getTime() > Date.now() + 60_000) {
    return await decrypt(acc.access_token_enc);
  }
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: await decrypt(acc.refresh_token_enc) });
    await sb.from("gcal_accounts").update({
      access_token_enc: await encrypt(t.access_token),
      access_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    }).eq("professional_id", professionalId);
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      await sb.rpc("gcal_revoke", { p_professional_id: professionalId, p_reason: e.message });
      return null;
    }
    throw e;
  }
}

/** Llamada a la API de Google. 401 tras refrescar => acceso revocado. */
export async function gapi(sb: SupabaseClient, professionalId: string, path: string, init: RequestInit = {}) {
  const token = await accessToken(sb, professionalId);
  if (!token) throw new GoogleAuthError("no_active_account");
  const r = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (r.status === 401) {
    await sb.rpc("gcal_revoke", { p_professional_id: professionalId, p_reason: "unauthorized" });
    throw new GoogleAuthError("unauthorized");
  }
  return r;
}

// ───────────── Zonas horarias ─────────────
/** Instante UTC de las 00:00 de `date` (YYYY-MM-DD) en la zona `tz`. */
export function zonedMidnight(date: string, tz: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(guess);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

// ───────────── Lectura: ocupados → cache ─────────────
type Busy = { calendar_id: string; start: string; end: string };

/** Descarga los rangos ocupados de los calendarios que bloquean y reemplaza el cache.
 *  Se guardan SOLO rangos: ni títulos ni descripciones (el `fields` ni siquiera los pide). */
export async function refreshBusy(sb: SupabaseClient, professionalId: string): Promise<void> {
  const { data: prof } = await sb.from("professionals").select("timezone, max_advance_days").eq("id", professionalId).single();
  const { data: cals } = await sb.from("gcal_calendars").select("calendar_id, blocks_agenda, is_write_target")
    .eq("professional_id", professionalId);
  const blocking = (cals ?? []).filter((c) => c.blocks_agenda);
  const from = new Date(Date.now() - 24 * 3600_000);
  const to = new Date(Date.now() + (prof!.max_advance_days + 1) * 24 * 3600_000);
  const rows: Busy[] = [];

  // Calendarios donde la app no escribe: freebusy es exacto y no expone nada.
  const plain = blocking.filter((c) => !c.is_write_target).map((c) => c.calendar_id);
  if (plain.length) {
    const r = await gapi(sb, professionalId, "/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: plain.map((id) => ({ id })) }),
    });
    if (!r.ok) throw new Error(`freebusy ${r.status}`);
    const body = await r.json();
    for (const id of plain) {
      for (const b of body.calendars?.[id]?.busy ?? []) rows.push({ calendar_id: id, start: b.start, end: b.end });
    }
  }

  // Calendario donde la app escribe: hay que descartar los eventos propios, y freebusy no devuelve ids.
  const writeCal = blocking.find((c) => c.is_write_target);
  if (writeCal) {
    const { data: own } = await sb.from("appointments").select("gcal_event_id")
      .eq("professional_id", professionalId).not("gcal_event_id", "is", null);
    const ownIds = new Set((own ?? []).map((a) => a.gcal_event_id));
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        singleEvents: "true", maxResults: "2500", timeMin: from.toISOString(), timeMax: to.toISOString(),
        fields: "nextPageToken,items(id,status,transparency,start,end,extendedProperties/private)",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await gapi(sb, professionalId, `/calendars/${encodeURIComponent(writeCal.calendar_id)}/events?${q}`);
      if (!r.ok) throw new Error(`events.list ${r.status}`);
      const body = await r.json();
      for (const ev of body.items ?? []) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (ev.extendedProperties?.private?.expertia_appointment_id || ownIds.has(ev.id)) continue;
        const start = ev.start?.dateTime ?? (ev.start?.date && zonedMidnight(ev.start.date, prof!.timezone).toISOString());
        const end = ev.end?.dateTime ?? (ev.end?.date && zonedMidnight(ev.end.date, prof!.timezone).toISOString());
        if (start && end) rows.push({ calendar_id: writeCal.calendar_id, start, end });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
  }

  await sb.rpc("gcal_replace_busy", {
    p_professional_id: professionalId, p_from: from.toISOString(), p_to: to.toISOString(), p_rows: rows,
  });
}

/** refreshBusy con manejo de revocación (no propaga GoogleAuthError: la agenda sigue interna). */
export async function safeRefresh(sb: SupabaseClient, professionalId: string): Promise<boolean> {
  try { await refreshBusy(sb, professionalId); return true; }
  catch (e) {
    if (e instanceof GoogleAuthError) return false;
    throw e;
  }
}

// ───────────── Watch channels (push notifications) ─────────────
export async function startWatch(sb: SupabaseClient, professionalId: string, calendarId: string) {
  const channelId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const r = await gapi(sb, professionalId, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    body: JSON.stringify({
      id: channelId, type: "web_hook", token, address: `${functionsUrl()}/gcal-webhook`,
      expiration: Date.now() + 6 * 24 * 3600_000, // Google limita a ~7 días
    }),
  });
  if (!r.ok) { console.warn("watch falló", r.status); return; } // el polling cubre el fallback
  const body = await r.json();
  await sb.from("gcal_calendars").update({
    watch_channel_id: channelId, watch_token: token, watch_resource_id: body.resourceId,
    watch_expires_at: new Date(Number(body.expiration)).toISOString(),
  }).eq("professional_id", professionalId).eq("calendar_id", calendarId);
}

export async function stopWatch(sb: SupabaseClient, professionalId: string, cal: { calendar_id: string; watch_channel_id: string | null; watch_resource_id: string | null }) {
  if (cal.watch_channel_id && cal.watch_resource_id) {
    try {
      await gapi(sb, professionalId, "/channels/stop", {
        method: "POST", body: JSON.stringify({ id: cal.watch_channel_id, resourceId: cal.watch_resource_id }),
      });
    } catch { /* ignorar: el canal expira solo */ }
  }
  await sb.from("gcal_calendars").update({ watch_channel_id: null, watch_token: null, watch_resource_id: null, watch_expires_at: null })
    .eq("professional_id", professionalId).eq("calendar_id", cal.calendar_id);
}

/** Importa/actualiza la lista de calendarios del profesional sin pisar su selección. */
export async function syncCalendarList(sb: SupabaseClient, professionalId: string): Promise<string | null> {
  const r = await gapi(sb, professionalId, "/users/me/calendarList?minAccessRole=writer&fields=items(id,summary,primary)");
  if (!r.ok) throw new Error(`calendarList ${r.status}`);
  const items: { id: string; summary?: string; primary?: boolean }[] = (await r.json()).items ?? [];
  const { data: existing } = await sb.from("gcal_calendars").select("calendar_id").eq("professional_id", professionalId);
  const known = new Set((existing ?? []).map((c) => c.calendar_id));
  const primary = items.find((i) => i.primary);
  for (const it of items) {
    if (known.has(it.id)) {
      await sb.from("gcal_calendars").update({ summary: it.summary }).eq("professional_id", professionalId).eq("calendar_id", it.id);
    } else {
      await sb.from("gcal_calendars").insert({
        professional_id: professionalId, calendar_id: it.id, summary: it.summary,
        blocks_agenda: !!it.primary && known.size === 0, is_write_target: !!it.primary && known.size === 0,
      });
    }
  }
  return primary?.id ?? null;
}
