import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatusKey } from "./palette";

/** Lo único que ve el paciente: available/busy, sin motivo. */
export type PatientSlot = { start: Date; end: Date; status: "available" | "busy" };

/** Ítem de la agenda del profesional: slot libre o evento con motivo detallado. */
export type ProItem = {
  kind: "slot" | "event";
  start: Date;
  end: Date;
  reason: StatusKey;
  appointmentId: string | null;
  exceptionId: string | null;
  patientName: string | null;
  expiresAt: Date | null;
  note: string | null;
};

export type ConsultationType = { id: string; name: string; duration_minutes: number; price_cents: number };

/** Si el cache de Google venció, lo refresca (máx. 1 vez cada 30 s por profesional) antes de calcular slots. */
async function ensureFreshGcal(sb: SupabaseClient, professionalId: string, from: Date, to: Date) {
  const range = { p_professional_id: professionalId, p_from: from.toISOString(), p_to: to.toISOString() };
  const { data: needs } = await sb.rpc("gcal_needs_refresh", range);
  if (needs) {
    // Si falla, seguimos con lo que haya: la agenda interna siempre funciona.
    await sb.functions.invoke("gcal-refresh", {
      body: { professional_id: professionalId, from: range.p_from, to: range.p_to },
    }).catch(() => undefined);
  }
}

export async function fetchPatientSlots(
  sb: SupabaseClient, professionalId: string, consultationTypeId: string, from: Date, to: Date,
): Promise<PatientSlot[]> {
  await ensureFreshGcal(sb, professionalId, from, to);
  const { data, error } = await sb.rpc("get_slots", {
    p_professional_id: professionalId, p_from: from.toISOString(), p_to: to.toISOString(),
    p_consultation_type_id: consultationTypeId,
  });
  if (error) throw error;
  return (data as { slot_start: string; slot_end: string; status: "available" | "busy" }[]).map((r) => ({
    start: new Date(r.slot_start), end: new Date(r.slot_end), status: r.status,
  }));
}

export async function fetchProAgenda(
  sb: SupabaseClient, professionalId: string, consultationTypeId: string | null, from: Date, to: Date,
): Promise<ProItem[]> {
  await ensureFreshGcal(sb, professionalId, from, to);
  const { data, error } = await sb.rpc("get_agenda_pro", {
    p_from: from.toISOString(), p_to: to.toISOString(), p_consultation_type_id: consultationTypeId,
  });
  if (error) throw error;
  type Row = {
    kind: "slot" | "event"; starts_at: string; ends_at: string; reason: StatusKey; appointment_id: string | null;
    exception_id: string | null; patient_name: string | null; expires_at: string | null; note: string | null;
  };
  return (data as Row[]).map((r) => ({
    kind: r.kind, start: new Date(r.starts_at), end: new Date(r.ends_at), reason: r.reason,
    appointmentId: r.appointment_id, exceptionId: r.exception_id, patientName: r.patient_name,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null, note: r.note,
  }));
}

/** Traduce los errores de las RPC a mensajes para la persona. */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/slot_unavailable|slot_taken/.test(msg)) return "Ese horario acaba de ocuparse. Elegí otro.";
  if (/overlaps_appointment/.test(msg)) return "El rango se superpone con un turno. Reprogramalo o cancelalo primero.";
  if (/too_many_pending/.test(msg)) return "Tenés demasiados turnos pendientes de pago.";
  if (/patient_profile_required/.test(msg)) return "Completá tu nombre para reservar.";
  if (/not_reschedulable|not_cancellable/.test(msg)) return "Este turno ya no se puede modificar.";
  return "No se pudo completar la acción. Probá de nuevo.";
}
