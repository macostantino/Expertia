"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase";

/** Acceso por link mágico al email. */
export function SignIn({ reason }: { reason?: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const { error } = await getSupabase().auth.signInWithOtp({
        email, options: { emailRedirectTo: window.location.href },
      });
      if (error) setErr("No pudimos enviar el link. Revisá el email."); else setSent(true);
    }}>
      {reason && <p>{reason}</p>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {err && <p role="alert" className="notice error">{err}</p>}
      {sent ? <p role="status" className="notice">Te enviamos un link para ingresar.</p>
            : <button className="btn primary" type="submit">Enviarme el link</button>}
    </form>
  );
}
