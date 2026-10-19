import { describe, expect, it } from "vitest";
import { addDays, dayKey, minutesOfDay, weekStart, zonedInstant, zonedMidnight } from "./time";
import { clipToDay, layoutOverlaps, snap, visibleHours } from "./layout";
import { contrast, PALETTE } from "./palette";
import { LEGEND, STATUS } from "./status";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3 sin DST
const NY = "America/New_York";

describe("zonas horarias", () => {
  it("medianoche local en Buenos Aires = 03:00Z", () => {
    expect(zonedMidnight("2026-10-19", BA).toISOString()).toBe("2026-10-19T03:00:00.000Z");
  });
  it("respeta el cambio de DST (New York, marzo 2026)", () => {
    expect(zonedMidnight("2026-03-08", NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnight("2026-03-09", NY).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(zonedInstant("2026-03-09", 9 * 60, NY).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });
  it("dayKey y minutesOfDay usan la zona del profesional", () => {
    const d = new Date("2026-10-19T02:30:00Z"); // 23:30 del 18 en BA
    expect(dayKey(d, BA)).toBe("2026-10-18");
    expect(minutesOfDay(d, BA)).toBe(23 * 60 + 30);
  });
  it("semana empieza el lunes", () => {
    expect(weekStart("2026-10-19")).toBe("2026-10-19"); // lunes
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // domingo
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("layout", () => {
  it("recorta eventos que cruzan la medianoche", () => {
    const s = { start: new Date("2026-10-19T05:00:00Z"), end: new Date("2026-10-19T08:00:00Z") }; // 02:00–05:00 BA
    expect(clipToDay(s, "2026-10-19", BA)).toEqual({ from: 120, to: 300 });
    const night = { start: new Date("2026-10-19T23:00:00Z"), end: new Date("2026-10-20T05:00:00Z") }; // 20:00–02:00 BA
    expect(clipToDay(night, "2026-10-19", BA)).toEqual({ from: 1200, to: 1440 });
    expect(clipToDay(night, "2026-10-20", BA)).toEqual({ from: 0, to: 120 });
    expect(clipToDay(night, "2026-10-21", BA)).toBeNull();
  });
  it("ubica eventos solapados en columnas", () => {
    const r = layoutOverlaps([{ from: 540, to: 600 }, { from: 560, to: 620 }, { from: 700, to: 720 }]);
    expect(r.map((x) => [x.col, x.cols])).toEqual([[0, 2], [1, 2], [0, 1]]);
  });
  it("snap y rango visible", () => {
    expect(snap(547)).toBe(540);
    expect(snap(553)).toBe(555);
    expect(visibleHours([{ from: 6 * 60 + 30, to: 22 * 60 }])).toEqual({ startHour: 6, endHour: 22 });
    expect(visibleHours([])).toEqual({ startHour: 8, endHour: 20 });
  });
});

describe("accesibilidad", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`contraste AA (≥4.5:1) texto/fondo en ${theme}`, () => {
      for (const [k, p] of Object.entries(PALETTE[theme])) {
        expect(contrast(p.bg, p.fg), `${theme}/${k}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`el borde distingue el estado del fondo de página (≥3:1) en ${theme}`, () => {
      const page = theme === "light" ? "#ffffff" : "#0b0f14";
      for (const [k, p] of Object.entries(PALETTE[theme])) {
        expect(contrast(p.border, page), `${theme}/${k}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it("cada estado tiene icono y texto (el color no es la única señal)", () => {
    for (const info of Object.values(STATUS)) {
      expect(info.icon).toBeTruthy();
      expect(info.label.length).toBeGreaterThan(2);
    }
    for (const k of LEGEND) expect(STATUS[k]).toBeDefined();
  });
});
