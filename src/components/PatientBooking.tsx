"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { friendlyError, type ConsultationType, type PatientSlot } from "@/lib/agenda/api";
import { formatDayLong, formatTime, dayKey } from "@/lib/agenda/time";
import { AgendaCalendar } from "./AgendaCalendar";
import { Countdown } from "./Countdown";
import { Modal } from "./Modal";
import { SignIn } from "./SignIn";

type Prof = { id: string; display_name: string; timezone: string };
type Booked = { status: string; expires_at: string | null };

export function PatientBooking({ professionalId }: { professionalId: string }) {
  const session = useSession();
  const [prof, setProf] = useState<Prof | null>(null);
  const [types, setTypes] = useState<ConsultationType[]>([]);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [picked, setPicked] = useState<PatientSlot | null>(null);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const sb = getSupabase();
    void sb.from("professionals").select("id, display_name, timezone").eq("id", professionalId).maybeSingle()
      .then(({ data }) => setProf(data));
    void sb.from("consultation_types").select("id, name, duration_minutes, price_cents")
      .eq("professional_id", professionalId).eq("active", true).order("duration_minutes")
      .then(({ data }) => { setTypes(data ?? []); setTypeId((t) => t ?? data?.[0]?.id ?? null); });
  }, [professionalId]);

  useEffect(() => {
    if (!session) { setHasProfile(null); return; }
    void getSupabase().from("patients").select("id").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => setHasProfile(!!data));
  }, [session]);

  // Si el slot elegido se ocupa mientras el diálogo está abierto (tiempo real), se avisa.
  const onSlots = useCallback((slots: PatientSlot[]) => {
    setPicked((p) => {
      if (!p) return p;
      const cur = slots.find((s) => s.start.getTime() === p.start.getTime());
      if (cur && cur.status === "busy") {
        setMsg("Ese horario se acaba de ocupar. Elegí otro.");
        return null;
      }
      return p;
    });
  }, []);

  if (!prof) return <p role="status">Cargando…</p>;
  const ct = types.find((t) => t.id === typeId);

  async function confirm() {
    if (!picked || !ct || !session) return;
    setBusy(true); setMsg(null);
    const sb = getSupabase();
    try {
      if (!hasProfile) {
        const { error } = await sb.from("patients").upsert({ id: session.user.id, full_name: fullName.trim() });
        if (error) throw error;
        setHasProfile(true);
      }
      const { data, error } = await sb.rpc("book_appointment", {
        p_professional_id: professionalId, p_consultation_type_id: ct.id, p_starts_at: picked.start.toISOString(),
      });
      if (error) throw error;
      setBooked({ status: data.status, expires_at: data.expires_at });
      setPicked(null);
    } catch (e) {
      setMsg(friendlyError(e));
      setPicked(null);
    } finally {
      setBusy(false);
      setRefreshKey((k) => k + 1);
    }
  }

  return (
    <>
      <h1>Reservar con {prof.display_name}</h1>
      {types.length > 1 && (
        <div className="field">
          <label htmlFor="ct">Tipo de consulta</label>
          <select id="ct" value={typeId ?? ""} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes} min)</option>)}
          </select>
        </div>
      )}
      {msg && <p role="alert" className="notice warn">{msg}</p>}
      {booked && (
        <p role="status" className="notice">
          {booked.status === "pending_payment" && booked.expires_at
            ? <>Reserva retenida. Pagá antes de que venza: <strong><Countdown until={new Date(booked.expires_at)} /></strong></>
            : "¡Turno confirmado!"}
        </p>
      )}
      <ul className="legend" aria-label="Referencias">
        <li><span className="chip st-available">✓ Disponible</span></li>
        <li><span className="chip st-busy">✕ Ocupado</span></li>
      </ul>
      {typeId && (
        <AgendaCalendar mode="patient" professionalId={professionalId} timezone={prof.timezone}
          consultationTypeId={typeId} refreshKey={refreshKey} onSlots={onSlots}
          onPickSlot={(s) => { setMsg(null); setBooked(null); setPicked(s); }} />
      )}

      <Modal open={!!picked} onClose={() => setPicked(null)} title="Confirmar turno">
        {picked && ct && (
          <>
            <p><strong>{formatDayLong(dayKey(picked.start, prof.timezone))}</strong>, {formatTime(picked.start, prof.timezone)}
              {" "}({ct.duration_minutes} min) — {ct.name}
              {ct.price_cents > 0 && <> · {(ct.price_cents / 100).toLocaleString("es", { style: "currency", currency: "ARS" })}</>}</p>
            {!session ? (
              <SignIn reason="Ingresá para reservar." />
            ) : (
              <>
                {hasProfile === false && (
                  <div className="field">
                    <label htmlFor="name">Tu nombre completo</label>
                    <input id="name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
                  </div>
                )}
                <div className="actions">
                  <button className="btn" type="button" onClick={() => setPicked(null)}>Cancelar</button>
                  <button className="btn primary" type="button" disabled={busy || hasProfile === null || (hasProfile === false && !fullName.trim())}
                    onClick={confirm}>{busy ? "Reservando…" : "Confirmar"}</button>
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
