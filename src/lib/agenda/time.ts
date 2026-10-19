// Utilidades de fechas en la zona horaria del profesional (sin dependencias).

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, key: string) {
  const k = `${tz}|${key}`;
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }); fmtCache.set(k, f); }
  return f;
}

/** Componentes de pared de un instante en `tz`. */
export function wallParts(d: Date, tz: string) {
  const parts = fmt(tz, {
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }, "parts").formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute"), s: g("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' del instante en `tz`. */
export function dayKey(d: Date, tz: string): string {
  const p = wallParts(d, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Minutos desde las 00:00 locales. */
export function minutesOfDay(d: Date, tz: string): number {
  const p = wallParts(d, tz);
  return p.h * 60 + p.mi;
}

/** Instante UTC de una hora de pared 'YYYY-MM-DD' + minutos del día en `tz` (respeta DST). */
export function zonedInstant(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(new Date(guess), tz);
    const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess -= wall - asUtc;
  }
  return new Date(guess);
}
export const zonedMidnight = (date: string, tz: string) => zonedInstant(date, 0, tz);

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Lunes de la semana de `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

export function formatTime(d: Date, tz: string): string {
  return fmt(tz, { hour: "2-digit", minute: "2-digit", hour12: false }, "time").format(d);
}
export function formatDayLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}
export function formatDayShort(date: string): { dow: string; day: string } {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return {
    dow: new Intl.DateTimeFormat("es", { weekday: "short", timeZone: "UTC" }).format(t),
    day: String(d),
  };
}
