"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import {
  fetchPatientSlots, fetchProAgenda, type PatientSlot, type ProItem,
} from "@/lib/agenda/api";
import { clipToDay, layoutOverlaps, snap, visibleHours } from "@/lib/agenda/layout";
import type { StatusKey } from "@/lib/agenda/palette";
import { LEGEND, LEGEND_LABELS, STATUS } from "@/lib/agenda/status";
import {
  addDays, dayKey, formatDayLong, formatDayShort, formatTime, weekStart, zonedInstant, zonedMidnight,
} from "@/lib/agenda/time";
import { Countdown } from "./Countdown";
import { StatusIcon } from "./StatusIcon";

type Common = { professionalId: string; timezone: string; refreshKey?: number };
export type AgendaProps =
  | (Common & {
      mode: "patient";
      consultationTypeId: string;
      onPickSlot: (slot: PatientSlot) => void;
      /** Se llama cada vez que cambian los slots (p. ej. por tiempo real). */
      onSlots?: (slots: PatientSlot[]) => void;
    })
  | (Common & {
      mode: "professional";
      consultationTypeId: string | null;
      onFreeSlot: (item: ProItem) => void;
      onEvent: (item: ProItem) => void;
      onRange: (start: Date, end: Date) => void;
    });

type View = "week" | "day";
const HOUR_PX = 56;

export function StatusChip({ status, label }: { status: StatusKey; label?: string }) {
  const s = STATUS[status];
  return (
    <span className={`chip st-${status}`} title={s.hint}>
      <StatusIcon name={s.icon} size={13} />
      <span>{label ?? s.label}</span>
    </span>
  );
}

export function AgendaCalendar(props: AgendaProps) {
  const { mode, professionalId, timezone: tz } = props;
  const [view, setView] = useState<View>("day"); // mobile primero; en desktop pasa a "week" al montar
  const [anchor, setAnchor] = useState(() => dayKey(new Date(), tz));
  const [patientSlots, setPatientSlots] = useState<PatientSlot[]>([]);
  const [proItems, setProItems] = useState<ProItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(min-width: 900px)").matches) setView("week");
  }, []);

  const days = useMemo(() => {
    const first = view === "week" ? weekStart(anchor) : anchor;
    return Array.from({ length: view === "week" ? 7 : 1 }, (_, i) => addDays(first, i));
  }, [view, anchor]);
  const from = useMemo(() => zonedMidnight(days[0], tz), [days, tz]);
  const to = useMemo(() => zonedMidnight(addDays(days[days.length - 1], 1), tz), [days, tz]);

  const consultationTypeId = props.consultationTypeId;
  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const sb = getSupabase();
      if (mode === "patient") {
        if (!consultationTypeId) return;
        const r = await fetchPatientSlots(sb, professionalId, consultationTypeId, from, to);
        if (id === reqId.current) setPatientSlots(r);
      } else {
        const r = await fetchProAgenda(sb, professionalId, consultationTypeId, from, to);
        if (id === reqId.current) setProItems(r);
      }
      if (id === reqId.current) setError(null);
    } catch {
      if (id === reqId.current) setError("No se pudo cargar la agenda.");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [mode, professionalId, consultationTypeId, from, to]);

  useEffect(() => { setLoading(true); void load(); }, [load, props.refreshKey]);

  // Tiempo real: el servidor emite "changed" (sin datos) por broadcast; cada cliente re-consulta
  // con sus propios permisos, así un paciente nunca recibe información de otros.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sb = getSupabase();
    const ch = sb.channel(`agenda:${professionalId}`)
      .on("broadcast", { event: "changed" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 250);
      })
      .subscribe();
    return () => { clearTimeout(timer); void sb.removeChannel(ch); };
  }, [professionalId, load]);

  const onSlots = mode === "patient" ? props.onSlots : undefined;
  useEffect(() => { onSlots?.(patientSlots); }, [patientSlots, onSlots]);

  const step = view === "week" ? 7 : 1;
  const title = view === "week"
    ? `${formatDayLong(days[0])} – ${formatDayLong(days[6])}`
    : formatDayLong(days[0]);

  return (
    <section className="agenda" aria-label="Agenda">
      <div className="toolbar">
        <div className="nav" role="group" aria-label="Navegación">
          <button type="button" onClick={() => setAnchor(addDays(anchor, -step))} aria-label="Anterior">‹</button>
          <button type="button" onClick={() => setAnchor(dayKey(new Date(), tz))}>Hoy</button>
          <button type="button" onClick={() => setAnchor(addDays(anchor, step))} aria-label="Siguiente">›</button>
          <label className="datepick">
            <span className="sr-only">Ir a la fecha</span>
            <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} />
          </label>
        </div>
        <h2 className="range-title" aria-live="polite">{title}</h2>
        <div className="seg" role="group" aria-label="Vista">
          <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>Semana</button>
          <button type="button" aria-pressed={view === "day"} onClick={() => setView("day")}>Día</button>
        </div>
      </div>

      {mode === "professional" && <Legend />}
      {error && <p role="alert" className="notice error">{error}</p>}
      {loading && <p className="sr-only" role="status">Cargando…</p>}

      {mode === "patient" ? (
        <PatientView days={days} tz={tz} slots={patientSlots} view={view} onPick={props.onPickSlot} />
      ) : view === "week" ? (
        <ProWeekGrid days={days} tz={tz} items={proItems} onFreeSlot={props.onFreeSlot}
          onEvent={props.onEvent} onRange={props.onRange} onExpired={load} />
      ) : (
        <ProDayList day={days[0]} tz={tz} items={proItems} onFreeSlot={props.onFreeSlot}
          onEvent={props.onEvent} onExpired={load} />
      )}
    </section>
  );
}

function Legend() {
  return (
    <ul className="legend" aria-label="Leyenda de colores">
      {LEGEND.map((k) => (
        <li key={k}><StatusChip status={k} label={LEGEND_LABELS[k]} /></li>
      ))}
    </ul>
  );
}

// ───────────── Paciente: slots verdes clickeables / grises no clickeables ─────────────
function PatientView({ days, tz, slots, view, onPick }: {
  days: string[]; tz: string; slots: PatientSlot[]; view: View; onPick: (s: PatientSlot) => void;
}) {
  const byDay = useMemo(() => {
    const m = new Map<string, PatientSlot[]>();
    for (const s of slots) {
      const k = dayKey(s.start, tz);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  return (
    <div className={`patient-grid ${view}`}>
      {days.map((d) => {
        const list = byDay.get(d) ?? [];
        const h = formatDayShort(d);
        return (
          <div key={d} className="pday">
            <h3><span className="dow">{h.dow}</span> <span className="dnum">{h.day}</span></h3>
            {list.length === 0 && <p className="empty">Sin horarios</p>}
            <ul>
              {list.map((s) => {
                const t = formatTime(s.start, tz);
                const free = s.status === "available";
                return (
                  <li key={s.start.toISOString()}>
                    <button type="button" className={`slot st-${s.status}`} disabled={!free}
                      aria-label={`${formatDayLong(d)}, ${t}, ${free ? "disponible" : "ocupado"}`}
                      title={STATUS[s.status].hint} onClick={() => onPick(s)}>
                      <StatusIcon name={STATUS[s.status].icon} size={14} />
                      <span>{t}</span>
                      <span className="slot-text">{free ? "Disponible" : "Ocupado"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Profesional: vista día / lista ─────────────
function itemLabel(it: ProItem) {
  const base = STATUS[it.reason].label;
  return it.patientName ? `${base} · ${it.patientName}` : base;
}

function ProDayList({ day, tz, items, onFreeSlot, onEvent, onExpired }: {
  day: string; tz: string; items: ProItem[];
  onFreeSlot: (i: ProItem) => void; onEvent: (i: ProItem) => void; onExpired: () => void;
}) {
  const todays = items
    .filter((i) => clipToDay({ start: i.start, end: i.end }, day, tz))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (!todays.length) return <p className="empty">Sin horarios ni turnos este día.</p>;
  return (
    <ul className="daylist">
      {todays.map((it, idx) => (
        <li key={`${it.kind}-${it.start.toISOString()}-${it.reason}-${idx}`}>
          <button type="button" className={`row st-${it.reason}`}
            onClick={() => (it.kind === "slot" ? onFreeSlot(it) : onEvent(it))}
            title={STATUS[it.reason].hint}>
            <span className="time">{formatTime(it.start, tz)}–{formatTime(it.end, tz)}</span>
            <StatusIcon name={STATUS[it.reason].icon} />
            <span className="label">{itemLabel(it)}</span>
            {it.reason === "pending_payment" && it.expiresAt && (
              <span className="count">vence en <Countdown until={it.expiresAt} onDone={onExpired} /></span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ───────────── Profesional: grilla semanal con arrastre ─────────────
type Placed = { item: ProItem; from: number; to: number };

function ProWeekGrid({ days, tz, items, onFreeSlot, onEvent, onRange, onExpired }: {
  days: string[]; tz: string; items: ProItem[];
  onFreeSlot: (i: ProItem) => void; onEvent: (i: ProItem) => void;
  onRange: (s: Date, e: Date) => void; onExpired: () => void;
}) {
  const perDay = useMemo(() => days.map((d) => {
    const placed: Placed[] = [];
    for (const item of items) {
      const c = clipToDay({ start: item.start, end: item.end }, d, tz);
      if (c) placed.push({ item, ...c });
    }
    return placed;
  }), [days, items, tz]);

  const { startHour, endHour } = useMemo(() => visibleHours(perDay.flat()), [perDay]);
  const gridMin = startHour * 60;
  const height = (endHour - startHour) * HOUR_PX;
  const px = (min: number) => ((min - gridMin) / 60) * HOUR_PX;

  const [drag, setDrag] = useState<{ day: string; a: number; b: number } | null>(null);
  const pointerType = useRef<string>("mouse");
  const origin = useRef<{ y: number; startMin: number; moved: boolean } | null>(null);

  const minAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return gridMin + ((e.clientY - r.top) / HOUR_PX) * 60;
  };

  const pick = (p: Placed) => (p.item.kind === "slot" ? onFreeSlot(p.item) : onEvent(p.item));
  const hit = (placed: Placed[], min: number) =>
    placed.filter((p) => p.item.kind === "event" && min >= p.from && min < p.to)[0]
    ?? placed.find((p) => p.item.kind === "slot" && min >= p.from && min < p.to);

  return (
    <div className="weekgrid" style={{ ["--cols" as string]: days.length }}>
      <div className="corner" />
      {days.map((d) => {
        const h = formatDayShort(d);
        return <div key={d} className="colhead"><span className="dow">{h.dow}</span> <span className="dnum">{h.day}</span></div>;
      })}
      <div className="axis" style={{ height }}>
        {Array.from({ length: endHour - startHour }, (_, i) => (
          <div key={i} className="tick" style={{ top: i * HOUR_PX }}>{String(startHour + i).padStart(2, "0")}:00</div>
        ))}
      </div>
      {days.map((d, di) => {
        const placed = perDay[di];
        const events = layoutOverlaps(placed.filter((p) => p.item.kind === "event"));
        const free = placed.filter((p) => p.item.kind === "slot");
        return (
          <div key={d} className="col" style={{ height }}
            onPointerDown={(e) => {
              pointerType.current = e.pointerType;
              if (e.pointerType === "touch" || e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const m = minAt(e);
              origin.current = { y: e.clientY, startMin: m, moved: false };
            }}
            onPointerMove={(e) => {
              const o = origin.current;
              if (!o) return;
              if (!o.moved && Math.abs(e.clientY - o.y) < 6) return;
              o.moved = true;
              setDrag({ day: d, a: snap(o.startMin), b: snap(minAt(e)) });
            }}
            onPointerUp={(e) => {
              const o = origin.current;
              origin.current = null;
              if (!o) return;
              if (o.moved) {
                const a = Math.max(0, Math.min(snap(o.startMin), snap(minAt(e))));
                let b = Math.min(24 * 60, Math.max(snap(o.startMin), snap(minAt(e))));
                if (b - a < 15) b = a + 15;
                setDrag(null);
                onRange(zonedInstant(d, a, tz), zonedInstant(d, b, tz));
              } else {
                const target = hit(placed, minAt(e));
                if (target) pick(target);
              }
            }}
            onPointerCancel={() => { origin.current = null; setDrag(null); }}>
            {free.map((p) => (
              <button key={`s${p.item.start.toISOString()}`} type="button" className="slot st-available abs"
                style={{ top: px(p.from), height: px(p.to) - px(p.from) - 2 }}
                aria-label={`${formatDayLong(d)}, ${formatTime(p.item.start, tz)}, disponible: bloquear o crear turno`}
                title="Disponible · click para bloquear o crear turno"
                onClick={(e) => { if (e.detail === 0 || pointerType.current === "touch") pick(p); }}>
                <StatusIcon name="check" size={13} />
                <span>{formatTime(p.item.start, tz)}</span>
              </button>
            ))}
            {events.map((p, i) => (
              <button key={`e${i}-${p.item.start.toISOString()}`} type="button" className={`ev st-${p.item.reason}`}
                style={{
                  top: px(p.from), height: Math.max(20, px(p.to) - px(p.from) - 2),
                  left: `${(p.col / p.cols) * 100}%`, width: `calc(${100 / p.cols}% - 2px)`,
                }}
                title={`${STATUS[p.item.reason].hint} · ${formatTime(p.item.start, tz)}–${formatTime(p.item.end, tz)}`}
                aria-label={`${itemLabel(p.item)}, ${formatTime(p.item.start, tz)} a ${formatTime(p.item.end, tz)}`}
                onClick={(e) => { if (e.detail === 0 || pointerType.current === "touch") pick(p); }}>
                <span className="ev-head"><StatusIcon name={STATUS[p.item.reason].icon} size={13} />
                  <strong>{STATUS[p.item.reason].label}</strong></span>
                {p.item.patientName && <span className="ev-sub">{p.item.patientName}</span>}
                {p.item.reason === "pending_payment" && p.item.expiresAt && (
                  <span className="ev-sub">vence en <Countdown until={p.item.expiresAt} onDone={onExpired} /></span>
                )}
              </button>
            ))}
            {drag && drag.day === d && (
              <div className="dragsel" aria-hidden="true"
                style={{ top: px(Math.min(drag.a, drag.b)), height: Math.max(8, px(Math.max(drag.a, drag.b)) - px(Math.min(drag.a, drag.b))) }}>
                <StatusIcon name="lock" size={13} /> Bloquear
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
