// Geometría de la grilla semanal del profesional (pura y testeable).
import { addDays, dayKey, minutesOfDay, zonedMidnight } from "./time";

export type Span = { start: Date; end: Date };

/** Parte de `s` que cae en el día `date` (en minutos locales) o null. */
export function clipToDay(s: Span, date: string, tz: string): { from: number; to: number } | null {
  const dayStart = zonedMidnight(date, tz);
  const dayEnd = zonedMidnight(addDays(date, 1), tz);
  const a = s.start < dayStart ? dayStart : s.start;
  const b = s.end > dayEnd ? dayEnd : s.end;
  if (b <= a) return null;
  const from = dayKey(a, tz) === date ? minutesOfDay(a, tz) : 0;
  const to = b.getTime() === dayEnd.getTime() ? 24 * 60 : minutesOfDay(b, tz);
  return { from, to };
}

/** Asigna columna a eventos que se solapan para dibujarlos lado a lado. */
export function layoutOverlaps<T extends { from: number; to: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
  const out: (T & { col: number; cols: number })[] = [];
  let group: (T & { col: number; cols: number })[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(0, ...group.map((g) => g.col + 1));
    group.forEach((g) => (g.cols = cols));
    out.push(...group);
    group = [];
  };
  for (const it of sorted) {
    if (group.length && it.from >= groupEnd) flush();
    const used = new Set(group.filter((g) => g.to > it.from).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ ...it, col, cols: 1 });
    groupEnd = Math.max(groupEnd, it.to);
  }
  flush();
  return out;
}

export const snap = (minutes: number, step = 15) => Math.round(minutes / step) * step;

/** Rango horario visible: cubre los datos y por defecto 8–20. */
export function visibleHours(spans: { from: number; to: number }[], dflt = [8, 20] as const) {
  let lo: number = dflt[0], hi: number = dflt[1];
  for (const s of spans) {
    lo = Math.min(lo, Math.floor(s.from / 60));
    hi = Math.max(hi, Math.ceil(s.to / 60));
  }
  return { startHour: Math.max(0, lo), endHour: Math.min(24, hi) };
}
