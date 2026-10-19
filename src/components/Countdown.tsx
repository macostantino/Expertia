"use client";
import { useEffect, useState } from "react";

/** Cuenta regresiva mm:ss hasta `until`; al llegar a 0 avisa para refrescar la agenda. */
export function Countdown({ until, onDone }: { until: Date; onDone?: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, until.getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const l = Math.max(0, until.getTime() - Date.now());
      setLeft(l);
      if (l === 0) { clearInterval(id); onDone?.(); }
    }, 1000);
    return () => clearInterval(id);
  }, [until, onDone]);
  const s = Math.ceil(left / 1000);
  return <time aria-label={`vence en ${Math.floor(s / 60)} minutos ${s % 60} segundos`}>
    {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
  </time>;
}
