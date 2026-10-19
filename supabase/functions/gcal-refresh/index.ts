import { admin, handle, HttpError, json, safeRefresh } from "../_shared/google.ts";

// Lo llama la app (paciente o profesional, con la anon key) antes de pedir slots.
// Es seguro exponerlo: solo refresca si el cache de 5 min venció y un único refresh por profesional cada 30 s.
Deno.serve(handle(async (req) => {
  const { professional_id, from, to } = await req.json().catch(() => ({}));
  if (!professional_id || !from || !to) throw new HttpError(400, "bad_request");
  const sb = admin();
  const { data: needs } = await sb.rpc("gcal_needs_refresh", { p_professional_id: professional_id, p_from: from, p_to: to });
  if (!needs) return json({ refreshed: false });
  const { data: claimed } = await sb.rpc("gcal_claim_refresh", { p_professional_id: professional_id });
  if (!claimed) return json({ refreshed: false });
  return json({ refreshed: await safeRefresh(sb, professional_id) });
}));
