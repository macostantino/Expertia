"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { SignIn } from "./SignIn";

type Cal = { calendar_id: string; summary: string | null; blocks_agenda: boolean; is_write_target: boolean };
type State = { connection: { google_email: string | null; status: string; last_error: string | null } | null; calendars: Cal[] };

export function CalendarSettings() {
  const session = useSession();
  const [state, setState] = useState<State | null>(null);
  const [blocking, setBlocking] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (s: State) => {
    setState(s);
    setBlocking(new Set(s.calendars.filter((c) => c.blocks_agenda).map((c) => c.calendar_id)));
    setTarget(s.calendars.find((c) => c.is_write_target)?.calendar_id ?? null);
  };
  const call = useCallback(async (action: string, extra: object = {}) => {
    setBusy(true); setMsg(null);
    const { data, error } = await getSupabase().functions.invoke("gcal-calendars", { body: { action, ...extra } });
    setBusy(false);
    if (error) { setMsg("No se pudo completar la acción."); return; }
    apply(data as State);
  }, []);

  useEffect(() => {
    if (!session) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setMsg("Google Calendar conectado.");
    if (q.get("error")) setMsg("No se pudo conectar con Google. Probá de nuevo.");
    void call("list");
  }, [session, call]);

  if (session === undefined) return <p role="status">Cargando…</p>;
  if (!session) return <SignIn reason="Ingresá para configurar Google Calendar." />;

  const connectedActive = state?.connection?.status === "active";
  return (
    <>
      <h1>Google Calendar</h1>
      {msg && <p role="status" className="notice">{msg}</p>}
      {state?.connection?.status === "revoked" && (
        <p role="alert" className="notice warn">
          Se perdió la conexión con Google. Tu agenda sigue funcionando con los turnos internos; reconectá para volver a sincronizar.
        </p>
      )}

      {!connectedActive && (
        <button className="btn primary" type="button" disabled={busy} onClick={async () => {
          const { data, error } = await getSupabase().functions.invoke("gcal-oauth-start");
          if (error || !data?.url) setMsg("No se pudo iniciar la conexión."); else window.location.href = data.url;
        }}>{state?.connection ? "Reconectar con Google" : "Conectar con Google"}</button>
      )}

      {connectedActive && state && (
        <>
          <p>Cuenta: <strong>{state.connection?.google_email ?? "—"}</strong></p>
          <fieldset>
            <legend>Calendarios que bloquean tu agenda</legend>
            {state.calendars.map((c) => (
              <label key={c.calendar_id} style={{ display: "block", margin: "6px 0" }}>
                <input type="checkbox" checked={blocking.has(c.calendar_id)} onChange={(e) => {
                  const n = new Set(blocking); e.target.checked ? n.add(c.calendar_id) : n.delete(c.calendar_id); setBlocking(n);
                }} /> {c.summary ?? c.calendar_id}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="wt">Calendario donde se escriben los turnos</label>
            <select id="wt" value={target ?? ""} onChange={(e) => setTarget(e.target.value || null)}>
              <option value="">No escribir turnos en Google</option>
              {state.calendars.map((c) => <option key={c.calendar_id} value={c.calendar_id}>{c.summary ?? c.calendar_id}</option>)}
            </select>
          </div>
          <p className="empty">Solo se leen los rangos ocupados; nunca se guardan títulos ni descripciones de tus eventos.</p>
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" type="button" disabled={busy}
              onClick={() => call("save", { blocking: [...blocking], write_target: target })}>Guardar</button>
            <button className="btn" type="button" disabled={busy} onClick={() => call("resync")}>Actualizar lista</button>
            <button className="btn danger" type="button" disabled={busy} onClick={() => {
              if (window.confirm("¿Desconectar Google Calendar?")) void call("disconnect");
            }}>Desconectar</button>
          </div>
        </>
      )}
    </>
  );
}
