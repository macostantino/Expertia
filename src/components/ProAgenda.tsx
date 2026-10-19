"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { friendlyError, type ConsultationType, type ProItem } from "@/lib/agenda/api";
import { dayKey, formatDayLong, formatTime, minutesOfDay, zonedInstant } from "@/lib/agenda/time";
import { AgendaCalendar, StatusChip } from "./AgendaCalendar";
import { Countdown } from "./Countdown";
import { Modal } from "./Modal";
import { SignIn } from "./SignIn";

type Prof = { id: string; display_name: string; timezone: string };
type Dialog =
  | { type: "slot"; item: ProItem }
  | { type: "manual"; item: ProItem }
  | { type: "block"; start: Date; end: Date }
  | { type: "event"; item: ProItem }
  | null;

const pad = (n: number) => String(n).padStart(2, "0");
/** Date → valor de <input type=datetime-local> en la zona del profesional. */
const toLocalInput = (d: Date, tz: string) => {
  const m = minutesOfDay(d, tz);
  return `${dayKey(d, tz)}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const fromLocalInput = (v: string, tz: string) => {
  const [date, time] = v.split("T");
  const [h, mi] = time.split(":").map(Number);
  return zonedInstant(date, h * 60 + mi, tz);
};

export function ProAgenda() {
  const session = useSession();
  const [prof, setProf] = useState<Prof | null | undefined>(undefined);
  const [types, setTypes] = useState<ConsultationType[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [gcalAlert, setGcalAlert] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (!session) return;
    const sb = getSupabase();
    void sb.from("professionals").select("id, display_name, timezone").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setProf(data));
  }, [session]);

  useEffect(() => {
    if (!prof) return;
    const sb = getSupabase();
    void sb.from("consultation_types").select("id, name, duration_minutes, price_cents")
      .eq("professional_id", prof.id).eq("active", true).order("duration_minutes").then(({ data }) => setTypes(data ?? []));
    void sb.from("notifications").select("id, message").eq("professional_id", prof.id).eq("kind", "gcal_revoked")
      .is("read_at", null).order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => setGcalAlert(data?.[0] ?? null));
  }, [prof]);

  if (session === undefined) return <p role="status">Cargando…</p>;
  if (!session) return <SignIn reason="Ingresá para ver tu agenda." />;
  if (prof === undefined) return <p role="status">Cargando…</p>;
  if (!prof) return <p role="alert" className="notice error">Tu usuario no tiene un perfil profesional.</p>;

  const tz = prof.timezone;
  const close = () => setDialog(null);
  const done = () => { close(); setRefreshKey((k) => k + 1); };
  const run = async (fn: () => PromiseLike<{ error: unknown }>) => {
    setMsg(null);
    const { error } = await fn();
    if (error) { setMsg(friendlyError(error)); setRefreshKey((k) => k + 1); close(); return false; }
    done();
    return true;
  };

  return (
    <>
      <h1>Agenda · {prof.display_name}</h1>
      {gcalAlert && (
        <p role="alert" className="notice warn">
          {gcalAlert.message}{" "}
          <Link href="/settings/calendar">Reconectar Google Calendar</Link>{" "}
          <button className="btn" type="button" onClick={() => {
            void getSupabase().from("notifications").update({ read_at: new Date().toISOString() }).eq("id", gcalAlert.id);
            setGcalAlert(null);
          }}>Entendido</button>
        </p>
      )}
      {msg && <p role="alert" className="notice error">{msg}</p>}
      <p>
        <button className="btn" type="button" onClick={() => {
          const s = new Date(Date.now() + 3600_000); s.setMinutes(0, 0, 0);
          setDialog({ type: "block", start: s, end: new Date(s.getTime() + 3600_000) });
        }}>Bloquear horario…</button>{" "}
        <Link href="/settings/calendar">Google Calendar</Link>
      </p>
      <AgendaCalendar mode="professional" professionalId={prof.id} timezone={tz} consultationTypeId={null}
        refreshKey={refreshKey}
        onFreeSlot={(item) => setDialog({ type: "slot", item })}
        onEvent={(item) => setDialog({ type: "event", item })}
        onRange={(start, end) => setDialog({ type: "block", start, end })} />

      {/* Click en un slot verde: bloquear o crear turno manual */}
      <Modal open={dialog?.type === "slot"} onClose={close} title="Horario disponible">
        {dialog?.type === "slot" && (
          <>
            <p>{formatDayLong(dayKey(dialog.item.start, tz))}, {formatTime(dialog.item.start, tz)}–{formatTime(dialog.item.end, tz)}</p>
            <div className="actions">
              <button className="btn" type="button" onClick={close}>Cerrar</button>
              <button className="btn" type="button"
                onClick={() => setDialog({ type: "block", start: dialog.item.start, end: dialog.item.end })}>Bloquear</button>
              <button className="btn primary" type="button"
                onClick={() => setDialog({ type: "manual", item: dialog.item })}>Crear turno manual</button>
            </div>
          </>
        )}
      </Modal>

      <ManualDialog dialog={dialog?.type === "manual" ? dialog : null} types={types} tz={tz} onClose={close}
        onSubmit={(ctId, start, name) => run(() =>
          getSupabase().rpc("pro_create_appointment", { p_consultation_type_id: ctId, p_starts_at: start.toISOString(), p_guest_name: name }))} />

      <BlockDialog dialog={dialog?.type === "block" ? dialog : null} tz={tz} onClose={close}
        onSubmit={(s, e, note) => run(() =>
          getSupabase().rpc("pro_block", { p_starts_at: s.toISOString(), p_ends_at: e.toISOString(), p_note: note || null }))} />

      <EventDialog dialog={dialog?.type === "event" ? dialog : null} tz={tz} onClose={close}
        onReschedule={(id, start) => run(() => getSupabase().rpc("pro_reschedule", { p_appointment_id: id, p_new_start: start.toISOString() }))}
        onCancel={(id) => run(() => getSupabase().rpc("cancel_appointment", { p_appointment_id: id }))}
        onNoShow={(id) => run(() => getSupabase().rpc("pro_mark_no_show", { p_appointment_id: id }))}
        onUnblock={(id) => run(() => getSupabase().rpc("pro_unblock", { p_exception_id: id }))} />
    </>
  );
}

function ManualDialog({ dialog, types, tz, onClose, onSubmit }: {
  dialog: { item: ProItem } | null; types: ConsultationType[]; tz: string; onClose: () => void;
  onSubmit: (ctId: string, start: Date, name: string) => Promise<boolean>;
}) {
  const [ct, setCt] = useState("");
  const [name, setName] = useState("");
  useEffect(() => { if (dialog) { setCt(types[0]?.id ?? ""); setName(""); } }, [dialog, types]);
  return (
    <Modal open={!!dialog} onClose={onClose} title="Turno manual">
      {dialog && (
        <form onSubmit={(e) => { e.preventDefault(); void onSubmit(ct, dialog.item.start, name.trim()); }}>
          <p>{formatDayLong(dayKey(dialog.item.start, tz))}, {formatTime(dialog.item.start, tz)}</p>
          <div className="field"><label htmlFor="mct">Tipo de consulta</label>
            <select id="mct" value={ct} onChange={(e) => setCt(e.target.value)}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes} min)</option>)}
            </select></div>
          <div className="field"><label htmlFor="mname">Paciente</label>
            <input id="mname" type="text" required value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="actions">
            <button className="btn" type="button" onClick={onClose}>Cancelar</button>
            <button className="btn primary" type="submit" disabled={!ct || !name.trim()}>Crear turno</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function BlockDialog({ dialog, tz, onClose, onSubmit }: {
  dialog: { start: Date; end: Date } | null; tz: string; onClose: () => void;
  onSubmit: (s: Date, e: Date, note: string) => Promise<boolean>;
}) {
  const [s, setS] = useState(""); const [e, setE] = useState(""); const [note, setNote] = useState("");
  useEffect(() => {
    if (dialog) { setS(toLocalInput(dialog.start, tz)); setE(toLocalInput(dialog.end, tz)); setNote(""); }
  }, [dialog, tz]);
  const valid = s && e && fromLocalInput(e, tz) > fromLocalInput(s, tz);
  return (
    <Modal open={!!dialog} onClose={onClose} title="Bloquear horario">
      {dialog && (
        <form onSubmit={(ev) => { ev.preventDefault(); void onSubmit(fromLocalInput(s, tz), fromLocalInput(e, tz), note.trim()); }}>
          <div className="field"><label htmlFor="bs">Desde</label>
            <input id="bs" type="datetime-local" step={900} value={s} onChange={(ev) => setS(ev.target.value)} /></div>
          <div className="field"><label htmlFor="be">Hasta</label>
            <input id="be" type="datetime-local" step={900} value={e} onChange={(ev) => setE(ev.target.value)} /></div>
          <div className="field"><label htmlFor="bn">Nota privada (opcional)</label>
            <input id="bn" type="text" value={note} onChange={(ev) => setNote(ev.target.value)} /></div>
          <div className="actions">
            <button className="btn" type="button" onClick={onClose}>Cancelar</button>
            <button className="btn primary" type="submit" disabled={!valid}>Bloquear</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EventDialog({ dialog, tz, onClose, onReschedule, onCancel, onNoShow, onUnblock }: {
  dialog: { item: ProItem } | null; tz: string; onClose: () => void;
  onReschedule: (id: string, start: Date) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onNoShow: (id: string) => Promise<boolean>;
  onUnblock: (id: string) => Promise<boolean>;
}) {
  const [resched, setResched] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<string | null>(null);
  const it = dialog?.item;
  useEffect(() => {
    setResched(null); setMeeting(null);
    if (it?.appointmentId) {
      void getSupabase().from("appointments").select("meeting_url").eq("id", it.appointmentId).maybeSingle()
        .then(({ data }) => setMeeting(data?.meeting_url ?? null));
    }
  }, [it]);

  const isAppt = !!it?.appointmentId && ["confirmed", "pending_payment", "recurring", "package"].includes(it.reason);
  const past = !!it && it.start.getTime() < Date.now();
  return (
    <Modal open={!!dialog} onClose={onClose} title="Detalle">
      {it && (
        <>
          <p><StatusChip status={it.reason} /></p>
          <p>{formatDayLong(dayKey(it.start, tz))}, {formatTime(it.start, tz)}–{formatTime(it.end, tz)}</p>
          {it.patientName && <p>Paciente: <strong>{it.patientName}</strong></p>}
          {it.note && <p>Nota: {it.note}</p>}
          {it.reason === "pending_payment" && it.expiresAt && <p>Se libera en <Countdown until={it.expiresAt} /></p>}
          {meeting && <p><a href={meeting} target="_blank" rel="noreferrer">Link a la sala</a></p>}
          {it.reason === "gcal_busy" && <p>Ocupado según Google Calendar. No se guardan detalles del evento.</p>}

          {resched !== null && (
            <div className="field">
              <label htmlFor="rs">Nuevo horario</label>
              <input id="rs" type="datetime-local" step={900} value={resched} onChange={(e) => setResched(e.target.value)} />
            </div>
          )}
          <div className="actions">
            <button className="btn" type="button" onClick={onClose}>Cerrar</button>
            {it.exceptionId && <button className="btn danger" type="button" onClick={() => void onUnblock(it.exceptionId!)}>Quitar bloqueo</button>}
            {isAppt && resched === null && (
              <>
                {past && it.reason === "confirmed" && (
                  <button className="btn" type="button" onClick={() => void onNoShow(it.appointmentId!)}>Marcar ausente</button>
                )}
                <button className="btn" type="button" onClick={() => setResched(toLocalInput(it.start, tz))}>Reprogramar</button>
                <button className="btn danger" type="button" onClick={() => {
                  if (window.confirm("¿Cancelar este turno?")) void onCancel(it.appointmentId!);
                }}>Cancelar turno</button>
              </>
            )}
            {isAppt && resched !== null && (
              <>
                <button className="btn" type="button" onClick={() => setResched(null)}>Volver</button>
                <button className="btn primary" type="button" disabled={!resched}
                  onClick={() => void onReschedule(it.appointmentId!, fromLocalInput(resched, tz))}>Guardar</button>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
