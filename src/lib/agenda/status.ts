import type { StatusKey } from "./palette";

export type StatusInfo = { key: StatusKey; label: string; hint: string; icon: IconName };
export type IconName = "check" | "person" | "clock" | "repeat" | "package" | "calendar" | "lock" | "alert" | "x";

export const STATUS: Record<StatusKey, StatusInfo> = {
  available:       { key: "available",       label: "Disponible",        hint: "Horario libre", icon: "check" },
  busy:            { key: "busy",            label: "Ocupado",           hint: "Horario no disponible", icon: "x" },
  confirmed:       { key: "confirmed",       label: "Confirmado",        hint: "Turno confirmado", icon: "person" },
  pending_payment: { key: "pending_payment", label: "Pendiente de pago", hint: "Se libera si no se paga a tiempo", icon: "clock" },
  recurring:       { key: "recurring",       label: "Recurrente",        hint: "Turno recurrente", icon: "repeat" },
  package:         { key: "package",         label: "Paquete",           hint: "Turno de un paquete de sesiones", icon: "package" },
  gcal_busy:       { key: "gcal_busy",       label: "Google Calendar",   hint: "Ocupado según Google Calendar", icon: "calendar" },
  manual_block:    { key: "manual_block",    label: "Bloqueo manual",    hint: "Bloqueado por el profesional", icon: "lock" },
  no_show:         { key: "no_show",         label: "Ausente",           hint: "El paciente no asistió", icon: "alert" },
  late_cancel:     { key: "late_cancel",     label: "Cancelado tarde",   hint: "Cancelación fuera de plazo", icon: "alert" },
};

/** Orden y contenido de la leyenda fija del profesional. */
export const LEGEND: StatusKey[] = [
  "available", "confirmed", "pending_payment", "recurring", "gcal_busy", "manual_block", "no_show",
];
// recurring y package comparten color (violeta); late_cancel comparte con no_show (rojo).
export const LEGEND_LABELS: Partial<Record<StatusKey, string>> = {
  recurring: "Recurrente / paquete",
  no_show: "Ausente / cancelado tarde",
};
