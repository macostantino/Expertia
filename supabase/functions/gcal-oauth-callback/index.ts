import { admin, appUrl, encrypt, exchangeCode, startWatch, syncCalendarList, safeRefresh, verifyState } from "../_shared/google.ts";

// Redirect de Google. verify_jwt = false: la autenticidad la da `state` firmado (HMAC + expiración).
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(`${appUrl()}/settings/calendar?${q}`, 302);
  try {
    if (url.searchParams.get("error")) return back(`error=${encodeURIComponent(url.searchParams.get("error")!)}`);
    const professionalId = await verifyState(url.searchParams.get("state") ?? "");
    const tokens = await exchangeCode(url.searchParams.get("code") ?? "");
    if (!tokens.refresh_token) return back("error=no_refresh_token");
    const sb = admin();

    await sb.from("gcal_accounts").upsert({
      professional_id: professionalId,
      refresh_token_enc: await encrypt(tokens.refresh_token),
      access_token_enc: await encrypt(tokens.access_token),
      access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      status: "active", last_error: null, connected_at: new Date().toISOString(),
    });
    const email = await syncCalendarList(sb, professionalId);
    await sb.from("gcal_accounts").update({ google_email: email }).eq("professional_id", professionalId);

    const { data: blocking } = await sb.from("gcal_calendars").select("calendar_id, watch_channel_id")
      .eq("professional_id", professionalId).eq("blocks_agenda", true);
    for (const c of blocking ?? []) if (!c.watch_channel_id) await startWatch(sb, professionalId, c.calendar_id);
    await safeRefresh(sb, professionalId);
    return back("connected=1");
  } catch (e) {
    console.error(e);
    return back("error=oauth_failed");
  }
});
