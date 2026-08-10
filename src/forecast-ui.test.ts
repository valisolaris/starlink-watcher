// forecast-ui.ts DOM tests (jsdom). S1 持ち越し指摘「UI層DOMテスト未導入」をここで解消する。
// Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Brightness } from "./astro.ts";
import type { NightForecast, VisiblePass } from "./passes.ts";
import {
  FORECAST_STRINGS,
  brightnessDots,
  formatJstDate,
  formatJstDateTime,
  formatJstTime,
  renderForecast,
  renderForecastError,
  renderForecastLoading,
} from "./forecast-ui.ts";

let passSeq = 0;
function mkPass(over: Partial<VisiblePass> = {}): VisiblePass {
  passSeq += 1;
  const base = Date.UTC(2026, 7, 10, 12, 0, 0) + passSeq * 20 * 60 * 1000;
  return {
    satName: "STARLINK-TEST",
    objectId: "2026-001A",
    noradId: 99999,
    startTime: new Date(base),
    maxTime: new Date(base + 3 * 60 * 1000),
    endTime: new Date(base + 6 * 60 * 1000),
    startAzDeg: 225,
    maxAzDeg: 180,
    endAzDeg: 135,
    maxElevationDeg: 42.4,
    rangeAtMaxKm: 700,
    magnitude: 4.0,
    brightness: 2 as Brightness,
    ...over,
  };
}

function mkNight(dayUtc: number, passes: VisiblePass[]): NightForecast {
  return {
    date: new Date(dayUtc),
    window: { start: new Date(dayUtc + 10 * 3_600_000), end: new Date(dayUtc + 20 * 3_600_000) },
    passes,
  };
}

let container: HTMLElement;
beforeEach(() => {
  passSeq = 0;
  container = document.createElement("div");
});

describe("JST formatting", () => {
  const d = new Date("2026-08-12T11:15:00Z"); // 20:15 JST, 水曜

  it("formats time as HH:MM in JST", () => {
    expect(formatJstTime(d)).toBe("20:15");
  });

  it("formats date as M/D(weekday) in JST", () => {
    expect(formatJstDate(d)).toBe("8/12(水)");
  });

  it("formats datetime for the next-chance line", () => {
    expect(formatJstDateTime(d)).toBe("8/12(水)20:15");
  });

  it("crosses the JST date boundary correctly", () => {
    expect(formatJstDate(new Date("2026-08-12T16:30:00Z"))).toBe("8/13(木)");
  });
});

describe("brightnessDots", () => {
  it("renders 1..3 dots", () => {
    expect(brightnessDots(1)).toBe("●○○");
    expect(brightnessDots(2)).toBe("●●○");
    expect(brightnessDots(3)).toBe("●●●");
  });
});

describe("renderForecastLoading", () => {
  it("shows the fetch message", () => {
    renderForecastLoading(container, "fetch");
    expect(container.textContent).toContain(FORECAST_STRINGS.loadingFetch);
  });

  it("shows the compute message with percent", () => {
    renderForecastLoading(container, "compute", 42);
    expect(container.textContent).toContain(FORECAST_STRINGS.loadingCompute);
    expect(container.textContent).toContain("42%");
  });
});

describe("renderForecastError", () => {
  it("shows the error message and a retry button that fires the callback", () => {
    const onRetry = vi.fn();
    renderForecastError(container, onRetry);
    expect(container.textContent).toContain(FORECAST_STRINGS.fetchFailed);
    const btn = container.querySelector<HTMLButtonElement>("button");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain(FORECAST_STRINGS.retry);
    btn!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("renderForecast", () => {
  const day0 = Date.UTC(2026, 7, 10);

  it("renders the tonight verdict with badge and accent time", () => {
    const pass = mkPass({ brightness: 2 });
    const nights = [mkNight(day0, [pass])];
    renderForecast(container, nights, { kind: "tonight", pass });
    expect(container.textContent).toContain(FORECAST_STRINGS.verdictYes);
    const time = container.querySelector(".verdict-time");
    expect(time).not.toBeNull();
    expect(time!.textContent).toBe(formatJstTime(pass.maxTime));
    // 一行説明: 方角と継続時間
    expect(container.textContent).toContain("南西");
    expect(container.textContent).toContain("分間");
  });

  it("renders the next-chance line when tonight is a miss", () => {
    const next = mkPass({
      brightness: 2,
      maxTime: new Date("2026-08-12T11:15:00Z"),
    });
    const nights = [mkNight(day0, []), mkNight(day0 + 86_400_000, [next])];
    renderForecast(container, nights, { kind: "later", nextPass: next });
    expect(container.textContent).toContain(FORECAST_STRINGS.verdictNo);
    expect(container.textContent).toContain(
      `${FORECAST_STRINGS.nextChancePrefix}8/12(水)20:15`,
    );
  });

  it("renders a plain miss when there is no chance at all", () => {
    renderForecast(container, [mkNight(day0, [])], { kind: "none" });
    expect(container.textContent).toContain(FORECAST_STRINGS.verdictNo);
    expect(container.textContent).not.toContain(FORECAST_STRINGS.nextChancePrefix);
  });

  it("renders one row per pass with direction, elevation and dots", () => {
    const nights = [mkNight(day0, [mkPass(), mkPass({ brightness: 3 })])];
    renderForecast(container, nights, { kind: "none" });
    const rows = container.querySelectorAll(".pass-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("南西→南東");
    expect(rows[0].textContent).toContain("42°");
    expect(rows[0].textContent).toContain("●●○");
  });

  it("renders a night header per night and an empty note for empty nights", () => {
    const nights = [mkNight(day0, [mkPass()]), mkNight(day0 + 86_400_000, [])];
    renderForecast(container, nights, { kind: "none" });
    expect(container.querySelectorAll(".night-date")).toHaveLength(2);
    expect(container.textContent).toContain(FORECAST_STRINGS.emptyNight);
  });

  it("shows the stale-data note when requested", () => {
    renderForecast(container, [mkNight(day0, [])], { kind: "none" }, { stale: true });
    expect(container.textContent).toContain(FORECAST_STRINGS.staleNote);
  });
});
