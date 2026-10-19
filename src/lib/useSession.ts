"use client";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { getSupabase } from "./supabase";

/** undefined = cargando, null = sin sesión. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const sb = getSupabase();
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}
