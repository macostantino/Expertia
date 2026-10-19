import { authUrl, handle, json, requireProfessional, signState } from "../_shared/google.ts";

// El navegador del profesional pide la URL de consentimiento de Google (scopes: calendar.events + freebusy).
Deno.serve(handle(async (req) => {
  const prof = await requireProfessional(req);
  return json({ url: authUrl(await signState(prof.id)) });
}));
