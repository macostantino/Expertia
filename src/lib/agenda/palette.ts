// Paleta única: de acá salen los CSS vars y el test de contraste AA.
// El color nunca es la única señal: cada estado lleva además icono + texto (ver status.ts).

export type StatusKey =
  | "available" | "busy" | "confirmed" | "pending_payment" | "recurring" | "package"
  | "gcal_busy" | "manual_block" | "no_show" | "late_cancel";

type Pair = { bg: string; fg: string; border: string };
export const PALETTE: Record<"light" | "dark", Record<StatusKey, Pair>> = {
  light: {
    available:       { bg: "#dcfce7", fg: "#14532d", border: "#15803d" },
    busy:            { bg: "#e5e7eb", fg: "#374151", border: "#6b7280" },
    confirmed:       { bg: "#dbeafe", fg: "#1e3a8a", border: "#1d4ed8" },
    pending_payment: { bg: "#fef3c7", fg: "#78350f", border: "#b45309" },
    recurring:       { bg: "#ede9fe", fg: "#4c1d95", border: "#6d28d9" },
    package:         { bg: "#ede9fe", fg: "#4c1d95", border: "#6d28d9" },
    gcal_busy:       { bg: "#e5e7eb", fg: "#1f2937", border: "#4b5563" },
    manual_block:    { bg: "#d1d5db", fg: "#111827", border: "#374151" },
    no_show:         { bg: "#fee2e2", fg: "#7f1d1d", border: "#b91c1c" },
    late_cancel:     { bg: "#fee2e2", fg: "#7f1d1d", border: "#b91c1c" },
  },
  dark: {
    available:       { bg: "#14532d", fg: "#dcfce7", border: "#4ade80" },
    busy:            { bg: "#374151", fg: "#e5e7eb", border: "#9ca3af" },
    confirmed:       { bg: "#1e3a8a", fg: "#dbeafe", border: "#60a5fa" },
    pending_payment: { bg: "#78350f", fg: "#fef3c7", border: "#fbbf24" },
    recurring:       { bg: "#4c1d95", fg: "#ede9fe", border: "#a78bfa" },
    package:         { bg: "#4c1d95", fg: "#ede9fe", border: "#a78bfa" },
    gcal_busy:       { bg: "#374151", fg: "#f3f4f6", border: "#9ca3af" },
    manual_block:    { bg: "#4b5563", fg: "#f9fafb", border: "#d1d5db" },
    no_show:         { bg: "#7f1d1d", fg: "#fee2e2", border: "#f87171" },
    late_cancel:     { bg: "#7f1d1d", fg: "#fee2e2", border: "#f87171" },
  },
};

export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CSS vars `--st-<estado>-{bg,fg,border}` para light y dark (respeta data-theme y prefers-color-scheme). */
export function paletteCss(): string {
  const vars = (t: "light" | "dark") =>
    Object.entries(PALETTE[t]).map(([k, v]) =>
      `--st-${k}-bg:${v.bg};--st-${k}-fg:${v.fg};--st-${k}-border:${v.border};`).join("");
  return `:root{${vars("light")}color-scheme:light dark}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars("dark")}}}` +
    `:root[data-theme="dark"]{${vars("dark")}}`;
}
