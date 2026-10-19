import { admin, safeRefresh } from "../_shared/google.ts";

// Push notification de Google (watch channel). verify_jwt = false: se valida el token del canal.
// Invalida el cache y refresca en segundo plano; el polling de 15 min cubre notificaciones perdidas.
Deno.serve(async (req) => {
  const channelId = req.headers.get("X-Goog-Channel-ID");
  const token = req.headers.get("X-Goog-Channel-Token");
  const state = req.headers.get("X-Goog-Resource-State");
  if (!channelId || !token) return new Response("bad request", { status: 400 });

  const sb = admin();
  const { data: cal } = await sb.from("gcal_calendars").select("professional_id, watch_token")
    .eq("watch_channel_id", channelId).maybeSingle();
  if (!cal || cal.watch_token !== token) return new Response("unknown channel", { status: 404 });
  if (state === "sync") return new Response("ok"); // handshake inicial

  await sb.rpc("gcal_mark_stale", { p_professional_id: cal.professional_id });
  const work = (async () => {
    const { data: claimed } = await sb.rpc("gcal_claim_refresh", { p_professional_id: cal.professional_id });
    if (claimed) await safeRefresh(sb, cal.professional_id);
  })();
  // @ts-ignore EdgeRuntime existe en Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok");
});
