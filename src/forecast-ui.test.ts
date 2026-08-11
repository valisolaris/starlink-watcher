// forecast-ui.ts DOM tests (jsdom). S1 持ち越し指摘「UI層DOMテスト未導入」をここで解消する。
// Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Brightness } from "./astro.ts";
import type { NightForecast, VisiblePass } from "./passes.ts";
import { azElToPoint } from "./sky-map.ts";
import {
  FORECAST_STRINGS,
  brightnessDots,
  formatJstDate,
  formatJstDateTime,
  formatJstTime,
  renderForecast,
  renderForecastError,
  renderForecastLoading,
  trainBandHtml,
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
    startElDeg: 10,
    endElDeg: 10,
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

// S4: トレインが存在する期間のみバンド2として出現(design-brief §1)
describe("TRAIN band (S4)", () => {
  const day0 = Date.UTC(2026, 7, 10);

  it("renders trainBandHtml with the days-since-detected copy", () => {
    const pass = mkPass({ train: { groupId: "2025-142", daysSinceDetected: 3 } });
    const html = trainBandHtml(pass as VisiblePass & { train: NonNullable<VisiblePass["train"]> });
    expect(html).toContain(FORECAST_STRINGS.trainEyebrow);
    expect(html).toContain("3日目");
  });

  it("renders trainBandHtml with the new-detection copy when days is null", () => {
    const pass = mkPass({ train: { groupId: "2025-142", daysSinceDetected: null } });
    const html = trainBandHtml(pass as VisiblePass & { train: NonNullable<VisiblePass["train"]> });
    expect(html).toContain(FORECAST_STRINGS.trainNewCopy);
  });

  it("returns an empty string for no highlight", () => {
    expect(trainBandHtml(null)).toBe("");
  });

  it("shows the TRAIN band in renderForecast when a trainHighlight is passed", () => {
    const trainPass = mkPass({
      train: { groupId: "2025-142", daysSinceDetected: 3 },
      maxTime: new Date(Date.UTC(2026, 7, 10, 21, 0, 0)),
    });
    const nights = [mkNight(day0, [trainPass])];
    renderForecast(container, nights, { kind: "none" }, {
      trainHighlight: trainPass as VisiblePass & { train: NonNullable<VisiblePass["train"]> },
    });
    expect(container.textContent).toContain(FORECAST_STRINGS.trainEyebrow);
  });

  // UI自己監査(uiux-checklist Q4)指摘: 方位図のドット列はスクリーンリーダーに伝わらないため
  // aria-label にもトレインである旨を含める
  it("mentions the train in the sky chart aria-label for screen readers", () => {
    const trainPass = mkPass({ train: { groupId: "2025-142", daysSinceDetected: 3 } });
    renderForecast(container, [mkNight(day0, [trainPass])], { kind: "none" });
    const svg = container.querySelector(".skychart svg");
    expect(svg?.getAttribute("aria-label")).toContain("トレイン");
  });

  it("does not show the TRAIN band when trainHighlight is absent", () => {
    renderForecast(container, [mkNight(day0, [mkPass()])], { kind: "none" });
    expect(container.textContent).not.toContain(FORECAST_STRINGS.trainEyebrow);
  });
});

// S3: 方位図アコーディオン。mkPass の既定パス(南西→南→南東、最大仰角42.4°)を使う。
describe("sky chart accordion (S3)", () => {
  const day0 = Date.UTC(2026, 7, 10);

  function renderOnePass(): void {
    renderForecast(container, [mkNight(day0, [mkPass()])], { kind: "none" });
  }

  it("renders each pass row as a button with a hidden chart", () => {
    renderOnePass();
    const btn = container.querySelector<HTMLButtonElement>("button.pass-row");
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    const wrap = container.querySelector<HTMLElement>(".skychart-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap!.hidden).toBe(true);
  });

  it("expands on click and collapses on second click", () => {
    renderOnePass();
    const btn = container.querySelector<HTMLButtonElement>("button.pass-row")!;
    const wrap = container.querySelector<HTMLElement>(".skychart-wrap")!;
    btn.click();
    expect(wrap.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    btn.click();
    expect(wrap.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("draws compass labels with East on the LEFT and West on the RIGHT", () => {
    renderOnePass();
    const texts = Array.from(
      container.querySelectorAll<SVGTextElement>(".skychart svg text"),
    );
    const byLabel = (s: string): SVGTextElement => {
      const found = texts.find((t) => t.textContent === s);
      expect(found, `missing compass label ${s}`).toBeDefined();
      return found!;
    };
    expect(Number(byLabel("N").getAttribute("y"))).toBeLessThan(100);
    expect(Number(byLabel("S").getAttribute("y"))).toBeGreaterThan(100);
    expect(Number(byLabel("E").getAttribute("x"))).toBeLessThan(100);
    expect(Number(byLabel("W").getAttribute("x"))).toBeGreaterThan(100);
  });

  it("renders exactly one accent max-elevation marker per chart", () => {
    renderOnePass();
    expect(container.querySelectorAll(".sky-elev-max")).toHaveLength(1);
    expect(container.querySelectorAll(".sky-endpoint")).toHaveLength(2);
  });

  it("shows a caption with max elevation, time and brightness", () => {
    renderOnePass();
    const cap = container.querySelector(".skychart-caption");
    expect(cap).not.toBeNull();
    expect(cap!.textContent).toContain("最大仰角");
    expect(cap!.textContent).toContain("42°");
    expect(cap!.textContent).toContain("●●○");
  });

  it("plays the draw animation only on the first expand", () => {
    renderOnePass();
    const btn = container.querySelector<HTMLButtonElement>("button.pass-row")!;
    const arc = (): Element => container.querySelector(".sky-arc")!;
    btn.click();
    expect(arc().classList.contains("sky-arc-draw")).toBe(true);
    btn.click(); // close
    btn.click(); // reopen
    expect(arc().classList.contains("sky-arc-draw")).toBe(false);
  });

  // S3 codex重大対応: 端点は可視区間の実仰角のリング位置(地平線0°固定は不正確)
  it("places arc endpoints at the pass start/end elevations, not the horizon", () => {
    const pass = mkPass({ startElDeg: 12, endElDeg: 30 });
    renderForecast(container, [mkNight(day0, [pass])], { kind: "none" });
    const endpoints = Array.from(
      container.querySelectorAll<SVGCircleElement>(".sky-endpoint"),
    );
    expect(endpoints).toHaveLength(2);
    const ps = azElToPoint(pass.startAzDeg, 12);
    const pe = azElToPoint(pass.endAzDeg, 30);
    expect(Number(endpoints[0].getAttribute("cx"))).toBeCloseTo(ps.x, 1);
    expect(Number(endpoints[0].getAttribute("cy"))).toBeCloseTo(ps.y, 1);
    expect(Number(endpoints[1].getAttribute("cx"))).toBeCloseTo(pe.x, 1);
    expect(Number(endpoints[1].getAttribute("cy"))).toBeCloseTo(pe.y, 1);
  });

  it("describes the pass without implying a horizon rise/set in the aria-label", () => {
    renderOnePass();
    const svg = container.querySelector(".skychart svg");
    const label = svg?.getAttribute("aria-label") ?? "";
    expect(label).toContain("の空に現れ");
    expect(label).toContain("の空で見えなくなる");
    expect(label).not.toContain("昇り");
    expect(label).not.toContain("沈む");
  });

  it("keeps charts of multiple rows independent", () => {
    renderForecast(
      container,
      [mkNight(day0, [mkPass(), mkPass({ brightness: 3 })])],
      { kind: "none" },
    );
    const btns = container.querySelectorAll<HTMLButtonElement>("button.pass-row");
    const wraps = container.querySelectorAll<HTMLElement>(".skychart-wrap");
    expect(btns).toHaveLength(2);
    expect(wraps).toHaveLength(2);
    btns[1].click();
    expect(wraps[0].hidden).toBe(true);
    expect(wraps[1].hidden).toBe(false);
  });
});

// コンパス画面への引き渡し導線: 方位図内の「コンパスで狙う」ボタン
describe("track pass hand-off (compass view)", () => {
  const day0 = Date.UTC(2026, 7, 10);

  it("renders a track-pass button inside the expanded sky chart", () => {
    const pass = mkPass();
    renderForecast(container, [mkNight(day0, [pass])], { kind: "none" });
    const btn = container.querySelector<HTMLButtonElement>("[data-track-pass]");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain(FORECAST_STRINGS.trackButton);
  });

  it("calls onTrackPass with the matching VisiblePass when clicked", () => {
    const passA = mkPass();
    const passB = mkPass();
    const onTrackPass = vi.fn();
    renderForecast(container, [mkNight(day0, [passA, passB])], { kind: "none" }, { onTrackPass });
    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-track-pass]");
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(onTrackPass).toHaveBeenCalledTimes(1);
    expect(onTrackPass).toHaveBeenCalledWith(passB);
  });

  it("does not throw when clicked without an onTrackPass handler", () => {
    renderForecast(container, [mkNight(day0, [mkPass()])], { kind: "none" });
    const btn = container.querySelector<HTMLButtonElement>("[data-track-pass]")!;
    expect(() => btn.click()).not.toThrow();
  });
});
