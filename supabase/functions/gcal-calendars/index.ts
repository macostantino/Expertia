import {
  admin, handle, HttpError, json, requireProfessional, safeRefresh, startWatch, stopWatch, syncCalendarList,
} from "../_shared/google.ts";

// Gestión de calendarios del profesional: list | resync | save | disconnect.
Deno.serve(handle(async (req) => {
  const prof = await requireProfessional(req);
  const sb = admin();
  const { action, blocking, write_target } = await req.json().catch(() => ({}));

  const list = async () => {
    const { data: calendars } = await sb.from("gcal_calendars")
      .select("calendar_id, summary, blocks_agenda, is_write_target").eq("professional_id", prof.id).order("summary");
    const { data: conn } = await sb.from("gcal_accounts").select("google_email, status, last_error")
      .eq("professional_id", prof.id).maybeSingle();
    return json({ connection: conn, calendars: calendars ?? [] });
  };

  switch (action) {
    case "list": return list();

    case "resync": {
      await syncCalendarList(sb, prof.id);
      return list();
    }

    case "save": {
      const block: string[] = Array.isArray(blocking) ? blocking : [];
      const target: string | null = write_target ?? null;
      const { data: cals } = await sb.from("gcal_calendars").select("*").eq("professional_id", prof.id);
      const ids = new Set((cals ?? []).map((c) => c.calendar_id));
      if (block.some((id) => !ids.has(id)) || (target && !ids.has(target))) throw new HttpError(400, "unknown_calendar");

      // El índice único admite un solo write target: se limpia antes de asignar.
      await sb.from("gcal_calendars").update({ is_write_target: false }).eq("professional_id", prof.id);
      for (const c of cals ?? []) {
        const blocks = block.includes(c.calendar_id);
        await sb.from("gcal_calendars").update({ blocks_agenda: blocks, is_write_target: c.calendar_id === target })
          .eq("professional_id", prof.id).eq("calendar_id", c.calendar_id);
        if (blocks && !c.watch_channel_id) await startWatch(sb, prof.id, c.calendar_id);
        if (!blocks && c.watch_channel_id) await stopWatch(sb, prof.id, c);
      }
      await sb.rpc("gcal_mark_stale", { p_professional_id: prof.id });
      await safeRefresh(sb, prof.id);
      return list();
    }

    case "disconnect": {
      const { data: cals } = await sb.from("gcal_calendars").select("*").eq("professional_id", prof.id);
      for (const c of cals ?? []) await stopWatch(sb, prof.id, c);
      await sb.from("gcal_accounts").delete().eq("professional_id", prof.id);
      await sb.from("gcal_calendars").delete().eq("professional_id", prof.id);
      await sb.from("gcal_busy").delete().eq("professional_id", prof.id);
      await sb.from("gcal_sync_state").delete().eq("professional_id", prof.id);
      await sb.rpc("notify_agenda", { p_professional_id: prof.id });
      return list();
    }
    default: throw new HttpError(400, "unknown_action");
  }
}));
