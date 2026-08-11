// passes.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it } from "vitest";
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate } from "satellite.js";
import type { Brightness } from "./astro.ts";
import { gpToSatrec, type GpRecord } from "./gp.ts";
import {
  FORECAST_STORAGE_KEY,
  computeForecast,
  darkScanSegments,
  deriveVerdict,
  findGeometricPasses,
  forecastCacheKey,
  loadForecastCache,
  nightWindows,
  saveForecastCache,
  selectTopPasses,
  splitVisibleRuns,
  type NightForecast,
  type PassSample,
  type VisiblePass,
} from "./passes.ts";
import { sunAltitudeDeg } from "./astro.ts";

const TOKYO = { lat: 35.68, lon: 139.69 };

const SYNTH_GP: GpRecord = {
  OBJECT_NAME: "STARLINK-TEST",
  OBJECT_ID: "2026-001A",
  NORAD_CAT_ID: 99999,
  EPOCH: "2026-08-09T12:00:00.000000",
  MEAN_MOTION: 15.06,
  ECCENTRICITY: 0.0001,
  INCLINATION: 53.05,
  RA_OF_ASC_NODE: 120,
  ARG_OF_PERICENTER: 90,
  MEAN_ANOMALY: 0,
  BSTAR: 0.0003,
};

let passSeq = 0;
function mkPass(over: Partial<VisiblePass> = {}): VisiblePass {
  passSeq += 1;
  const base = Date.UTC(2026, 7, 10, 11, 0, 0) + passSeq * 20 * 60 * 1000;
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
    startElDeg: 12,
    endElDeg: 11,
    maxElevationDeg: 42.4,
    rangeAtMaxKm: 700,
    magnitude: 4.0,
    brightness: 2 as Brightness,
    ...over,
  };
}

function mkNight(startUtc: number, endUtc: number, passes: VisiblePass[]): NightForecast {
  return {
    date: new Date(startUtc),
    window: { start: new Date(startUtc), end: new Date(endUtc) },
    passes,
  };
}

beforeEach(() => {
  localStorage.clear();
  passSeq = 0;
});

describe("nightWindows (Tokyo, from 2026-08-10 noon JST)", () => {
  const noonJst = new Date("2026-08-10T03:00:00Z");

  it("returns 5 ascending non-overlapping windows starting tonight", () => {
    const windows = nightWindows(noonJst, TOKYO);
    expect(windows).toHaveLength(5);
    for (const w of windows) expect(w.start.getTime()).toBeLessThan(w.end.getTime());
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start.getTime()).toBeGreaterThan(windows[i - 1].end.getTime());
    }
    expect(windows[0].start.getTime()).toBeGreaterThan(noonJst.getTime());
  });

  it("starts each window around civil dusk and ends around dawn", () => {
    const windows = nightWindows(noonJst, TOKYO);
    for (const w of windows) {
      // 窓の端の太陽高度は約 -6 deg のはず
      expect(sunAltitudeDeg(w.start, TOKYO)).toBeLessThan(-5);
      expect(sunAltitudeDeg(w.start, TOKYO)).toBeGreaterThan(-8);
      expect(sunAltitudeDeg(w.end, TOKYO)).toBeLessThan(-5);
      expect(sunAltitudeDeg(w.end, TOKYO)).toBeGreaterThan(-8);
      const hours = (w.end.getTime() - w.start.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(6);
      expect(hours).toBeLessThan(14);
    }
  });

  it("clamps the first window to now when already dark (3 AM JST)", () => {
    const threeAmJst = new Date("2026-08-09T18:00:00Z");
    const windows = nightWindows(threeAmJst, TOKYO);
    expect(windows).toHaveLength(5);
    expect(windows[0].start.getTime()).toBeGreaterThanOrEqual(threeAmJst.getTime());
    expect(windows[0].start.getTime() - threeAmJst.getTime()).toBeLessThan(5 * 60 * 1000);
    // 残りの夜明けまで(05:00 JST ごろまで)の短い窓になる
    expect(windows[0].end.getTime() - threeAmJst.getTime()).toBeLessThan(4 * 3_600_000);
  });
});

describe("darkScanSegments", () => {
  it("returns segments inside the window with sun altitude in the scan band", () => {
    const [win] = nightWindows(new Date("2026-08-10T03:00:00Z"), TOKYO);
    const segments = darkScanSegments(win, TOKYO);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const seg of segments) {
      expect(seg.start.getTime()).toBeGreaterThanOrEqual(win.start.getTime());
      expect(seg.end.getTime()).toBeLessThanOrEqual(win.end.getTime());
      const mid = new Date((seg.start.getTime() + seg.end.getTime()) / 2);
      for (const t of [seg.start, mid, seg.end]) {
        const alt = sunAltitudeDeg(t, TOKYO);
        expect(alt).toBeLessThan(-5.4);
        expect(alt).toBeGreaterThan(-35.6);
      }
    }
  });
});

describe("findGeometricPasses", () => {
  it("detects an overhead pass for an observer under the sub-satellite point", () => {
    const satrec = gpToSatrec(SYNTH_GP)!;
    const t0 = new Date(Date.UTC(2026, 7, 9, 12, 30, 0));
    const pv = propagate(satrec, t0)!;
    const gmst = gstime(t0);
    const gd = eciToGeodetic(pv.position, gmst);
    const obs = { lat: degreesLat(gd.latitude), lon: degreesLong(gd.longitude) };
    const segment = {
      start: new Date(t0.getTime() - 20 * 60 * 1000),
      end: new Date(t0.getTime() + 20 * 60 * 1000),
    };
    const passes = findGeometricPasses(satrec, obs, segment);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    const best = passes.reduce((a, b) => (a.maxElevationDeg > b.maxElevationDeg ? a : b));
    expect(best.maxElevationDeg).toBeGreaterThan(60);
    expect(Math.abs(best.maxTime.getTime() - t0.getTime())).toBeLessThan(180_000);
    expect(best.startTime.getTime()).toBeLessThan(best.maxTime.getTime());
    expect(best.maxTime.getTime()).toBeLessThan(best.endTime.getTime());
  });

  it("keeps a pass that is still above the elevation floor at the segment end", () => {
    // codex重大(ラウンド3): 区間終端が細分ステップ(10秒)の倍数に一致しない場合
    // (夜明け側の太陽高度-6度境界は任意ミリ秒)、終端まで仰角条件内の run が
    // flush されず丸ごと破棄されていた。終端の正確な評価と最終 flush を凍結する。
    const satrec = gpToSatrec(SYNTH_GP)!;
    const t0 = Date.UTC(2026, 7, 9, 12, 30, 0);
    const pv = propagate(satrec, new Date(t0))!;
    const gd = eciToGeodetic(pv.position, gstime(new Date(t0)));
    const obs = { lat: degreesLat(gd.latitude), lon: degreesLong(gd.longitude) };
    // 終端 = 天頂通過の瞬間+501ms(10秒刻み非一致)。終端時点で仰角は80度超のまま
    const segment = {
      start: new Date(t0 - 10 * 60 * 1000),
      end: new Date(t0 + 501),
    };
    const passes = findGeometricPasses(satrec, obs, segment);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    const best = passes.reduce((a, b) => (a.maxElevationDeg > b.maxElevationDeg ? a : b));
    expect(best.maxElevationDeg).toBeGreaterThan(60);
    // 走査が区間終端まで届いている(パス終端が区間終端から10秒以内)
    expect(segment.end.getTime() - best.endTime.getTime()).toBeLessThan(10_000);
  });

  it("finds no pass when the satellite stays far from the observer", () => {
    const satrec = gpToSatrec(SYNTH_GP)!;
    const t0 = new Date(Date.UTC(2026, 7, 9, 12, 30, 0));
    const pv = propagate(satrec, t0)!;
    const gd = eciToGeodetic(pv.position, gstime(t0));
    // 対蹠点近くの観測者からは見えない
    const obs = {
      lat: -degreesLat(gd.latitude),
      lon: ((degreesLong(gd.longitude) + 180 + 540) % 360) - 180,
    };
    const segment = {
      start: new Date(t0.getTime() - 5 * 60 * 1000),
      end: new Date(t0.getTime() + 5 * 60 * 1000),
    };
    expect(findGeometricPasses(satrec, obs, segment)).toHaveLength(0);
  });
});

describe("splitVisibleRuns", () => {
  // spec: [仰角, 日照] の列。10秒間隔のサンプル列を作る
  function mkSamples(spec: Array<[number, boolean]>): PassSample[] {
    return spec.map(([el, sunlit], i) => ({
      ms: 1_000_000_000 + i * 10_000,
      azDeg: 100 + i,
      elDeg: el,
      rangeKm: 500 + i,
      sunlit,
    }));
  }

  it("trims the tail when the satellite enters shadow mid-pass", () => {
    const samples = mkSamples([
      [15, true],
      [30, true],
      [45, true],
      [30, false],
      [15, false],
    ]);
    const runs = splitVisibleRuns(samples, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].startTime.getTime()).toBe(samples[0].ms);
    expect(runs[0].endTime.getTime()).toBe(samples[2].ms);
    expect(runs[0].maxElevationDeg).toBe(45);
  });

  it("trims the head when the satellite exits shadow mid-pass", () => {
    const samples = mkSamples([
      [15, false],
      [30, false],
      [45, true],
      [30, true],
      [15, true],
    ]);
    const runs = splitVisibleRuns(samples, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].startTime.getTime()).toBe(samples[2].ms);
    expect(runs[0].endTime.getTime()).toBe(samples[4].ms);
  });

  it("keeps both segments when only the peak is shadowed", () => {
    const samples = mkSamples([
      [20, true],
      [40, true],
      [80, false],
      [40, true],
      [20, true],
    ]);
    const runs = splitVisibleRuns(samples, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0].maxElevationDeg).toBe(40);
    expect(runs[1].maxElevationDeg).toBe(40);
  });

  // S3 codex重大対応: 方位図の端点は可視区間の実仰角(地平線0°ではない)
  it("carries the first/last sample elevations as start/end elevations", () => {
    const samples = mkSamples([
      [15, true],
      [30, true],
      [45, true],
      [30, false],
      [15, false],
    ]);
    const runs = splitVisibleRuns(samples, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].startElDeg).toBe(15);
    expect(runs[0].endElDeg).toBe(45);
  });

  it("drops samples below the elevation floor and fully shadowed passes", () => {
    const lowOnly = mkSamples([
      [5, true],
      [8, true],
    ]);
    expect(splitVisibleRuns(lowOnly, 10)).toHaveLength(0);
    const shadowed = mkSamples([
      [30, false],
      [60, false],
    ]);
    expect(splitVisibleRuns(shadowed, 10)).toHaveLength(0);
  });
});

describe("golden regression (heavens-above cross-check, 2026-08-10)", () => {
  // heavens-above.com 実測: STARLINK-6250 が 2026-08-11 03:33:58 JST に最大高度90度
  // (lat 34.7 / lng 135.5)。当方計算 03:33:57 JST(差1秒)を±60秒で凍結する。
  const GOLDEN_GP: GpRecord = {
    OBJECT_NAME: "STARLINK-6250",
    OBJECT_ID: "2023-094N",
    NORAD_CAT_ID: 57230,
    EPOCH: "2026-08-09T09:04:21.520704",
    MEAN_MOTION: 15.27577356,
    ECCENTRICITY: 0.0001074,
    INCLINATION: 43.0004,
    RA_OF_ASC_NODE: 248.7214,
    ARG_OF_PERICENTER: 274.0116,
    MEAN_ANOMALY: 86.0613,
    BSTAR: -7.0808e-7,
  };

  it("reproduces the verified zenith pass time within 60 seconds", () => {
    const satrec = gpToSatrec(GOLDEN_GP)!;
    const obs = { lat: 34.7, lon: 135.5 };
    const segment = {
      start: new Date("2026-08-10T18:00:00Z"),
      end: new Date("2026-08-10T19:00:00Z"),
    };
    const passes = findGeometricPasses(satrec, obs, segment);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    const best = passes.reduce((a, b) => (a.maxElevationDeg > b.maxElevationDeg ? a : b));
    // 2026-08-11 03:33:57 JST = 2026-08-10T18:33:57Z
    expect(Math.abs(best.maxTime.getTime() - Date.parse("2026-08-10T18:33:57Z"))).toBeLessThan(60_000);
    expect(best.maxElevationDeg).toBeGreaterThan(85);
  });
});

describe("polar regions degrade gracefully (scope: Japan, carried over)", () => {
  it("returns no night windows in polar day and an empty forecast without crashing", async () => {
    const polar = { lat: 89, lon: 0 };
    const now = new Date("2026-08-10T03:00:00Z");
    expect(nightWindows(now, polar)).toHaveLength(0);
    const nights = await computeForecast([SYNTH_GP], polar, now);
    expect(nights).toEqual([]);
  });
});

describe("selectTopPasses", () => {
  it("keeps the best 3 by brightness then max elevation, in chronological order", () => {
    const p1 = mkPass({ brightness: 3, maxElevationDeg: 30 });
    const p2 = mkPass({ brightness: 2, maxElevationDeg: 80 });
    const p3 = mkPass({ brightness: 3, maxElevationDeg: 50 });
    const p4 = mkPass({ brightness: 1, maxElevationDeg: 85 });
    const p5 = mkPass({ brightness: 2, maxElevationDeg: 40 });
    const top = selectTopPasses([p1, p2, p3, p4, p5]);
    expect(top).toHaveLength(3);
    expect(top).toContain(p1);
    expect(top).toContain(p3);
    expect(top).toContain(p2);
    for (let i = 1; i < top.length; i++) {
      expect(top[i].startTime.getTime()).toBeGreaterThan(top[i - 1].startTime.getTime());
    }
  });

  it("returns everything when fewer than the limit", () => {
    const p1 = mkPass();
    expect(selectTopPasses([p1])).toEqual([p1]);
  });

  // S4 codex軽微指摘対応: 「補正が選抜より前に効く」ことをselectTopPasses単体で直接検証する。
  // 3件の明るさ3(非トレイン)+1件の明るさ2→補正後3(トレイン想定)という構成で、
  // 補正を選抜前に適用した場合にのみトレイン候補が上位3件へ入ることを確認する。
  it("includes a boosted candidate only when the boost is applied before selection", () => {
    const bright1 = mkPass({ brightness: 3, maxElevationDeg: 30 });
    const bright2 = mkPass({ brightness: 3, maxElevationDeg: 40 });
    const bright3 = mkPass({ brightness: 3, maxElevationDeg: 50 });
    const trainCandidateUnboosted = mkPass({ brightness: 2, maxElevationDeg: 90 });
    const trainCandidateBoosted = { ...trainCandidateUnboosted, brightness: 3 as Brightness };

    // 誤実装(選抜後に補正)を模擬: 補正前の明るさで選抜すると、候補は仰角トップでも
    // 明るさ2扱いのため明るさ3の3件に負けて落選する
    const selectedBeforeBoost = selectTopPasses([
      bright1,
      bright2,
      bright3,
      trainCandidateUnboosted,
    ]);
    expect(selectedBeforeBoost).not.toContain(trainCandidateUnboosted);

    // 正しい実装(選抜前に補正、S4の修正内容): 明るさ3同士なら仰角で並び、候補が入る
    const selectedAfterBoost = selectTopPasses([
      bright1,
      bright2,
      bright3,
      trainCandidateBoosted,
    ]);
    expect(selectedAfterBoost).toContain(trainCandidateBoosted);
  });
});

describe("deriveVerdict", () => {
  const now = new Date(Date.UTC(2026, 7, 10, 10, 0, 0)); // 19:00 JST
  const tonightStart = Date.UTC(2026, 7, 10, 10, 30, 0);
  const tonightEnd = Date.UTC(2026, 7, 10, 19, 30, 0);
  const night2Start = Date.UTC(2026, 7, 11, 10, 30, 0);
  const night2End = Date.UTC(2026, 7, 11, 19, 30, 0);

  it("says tonight when a bright-enough pass is still ahead tonight", () => {
    const dim = mkPass({ brightness: 1 });
    const good = mkPass({ brightness: 2 });
    const later = mkPass({ brightness: 3 });
    const v = deriveVerdict(
      [mkNight(tonightStart, tonightEnd, [dim, good, later]), mkNight(night2Start, night2End, [])],
      now,
    );
    expect(v.kind).toBe("tonight");
    if (v.kind === "tonight") expect(v.pass).toBe(good); // 最初の条件充足パス
  });

  it("points to a later night when tonight only has dim passes", () => {
    const dim = mkPass({ brightness: 1 });
    const future = mkPass({
      brightness: 2,
      startTime: new Date(night2Start + 3_600_000),
      maxTime: new Date(night2Start + 3_780_000),
      endTime: new Date(night2Start + 3_960_000),
    });
    const v = deriveVerdict(
      [mkNight(tonightStart, tonightEnd, [dim]), mkNight(night2Start, night2End, [future])],
      now,
    );
    expect(v.kind).toBe("later");
    if (v.kind === "later") expect(v.nextPass).toBe(future);
  });

  it("skips tonight passes whose peak already passed", () => {
    const past = mkPass({
      brightness: 3,
      startTime: new Date(Date.UTC(2026, 7, 10, 9, 0, 0)),
      maxTime: new Date(Date.UTC(2026, 7, 10, 9, 3, 0)),
      endTime: new Date(Date.UTC(2026, 7, 10, 9, 6, 0)),
    });
    const future = mkPass({
      brightness: 2,
      startTime: new Date(night2Start + 3_600_000),
      maxTime: new Date(night2Start + 3_780_000),
      endTime: new Date(night2Start + 3_960_000),
    });
    const v = deriveVerdict(
      [mkNight(tonightStart, tonightEnd, [past]), mkNight(night2Start, night2End, [future])],
      now,
    );
    expect(v.kind).toBe("later");
  });

  it("says none when no night has a bright-enough pass", () => {
    const v = deriveVerdict(
      [
        mkNight(tonightStart, tonightEnd, [mkPass({ brightness: 1 })]),
        mkNight(night2Start, night2End, [mkPass({ brightness: 1 })]),
      ],
      now,
    );
    expect(v.kind).toBe("none");
  });
});

describe("forecast cache", () => {
  it("round-trips nights with Date revival", () => {
    const nights = [mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [mkPass()])];
    const key = forecastCacheKey(TOKYO, 123456);
    expect(saveForecastCache(key, nights)).toBe(true);
    const loaded = loadForecastCache(key);
    expect(loaded).not.toBeNull();
    expect(loaded![0].window.start).toBeInstanceOf(Date);
    expect(loaded![0].passes[0].maxTime.getTime()).toBe(nights[0].passes[0].maxTime.getTime());
  });

  it("misses when the key differs", () => {
    const nights = [mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [])];
    saveForecastCache(forecastCacheKey(TOKYO, 1), nights);
    expect(loadForecastCache(forecastCacheKey(TOKYO, 2))).toBeNull();
    expect(loadForecastCache(forecastCacheKey({ lat: 34, lon: 135 }, 1))).toBeNull();
  });

  // S3 codex重大対応: 端点仰角の追加はスキーマ変更なので版上げし、旧形式を拾わない
  it("uses a v4 storage key and rejects passes without endpoint elevations", () => {
    expect(FORECAST_STORAGE_KEY).toBe("starlink-watcher:forecast:v4");
    const nights = [mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [mkPass()])];
    const key = forecastCacheKey(TOKYO, 42);
    saveForecastCache(key, nights);
    // 保存済み JSON から v2 相当(端点仰角なし)のパスを作って書き戻す
    const raw = JSON.parse(localStorage.getItem(FORECAST_STORAGE_KEY)!);
    delete raw.nights[0].passes[0].startElDeg;
    delete raw.nights[0].passes[0].endElDeg;
    localStorage.setItem(FORECAST_STORAGE_KEY, JSON.stringify(raw));
    expect(loadForecastCache(key)).toBeNull();
  });

  // S4: train フィールドはキャッシュ往復で失われてはいけない(revivePass が拾い忘れると壊れる)
  it("round-trips the train field on cached passes", () => {
    const nights = [
      mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [
        mkPass({ train: { groupId: "2025-142", daysSinceDetected: 3 } }),
      ]),
    ];
    const key = forecastCacheKey(TOKYO, 99);
    saveForecastCache(key, nights);
    const loaded = loadForecastCache(key);
    expect(loaded).not.toBeNull();
    expect(loaded![0].passes[0].train).toEqual({ groupId: "2025-142", daysSinceDetected: 3 });
  });

  it("round-trips a pass with no train field as undefined", () => {
    const nights = [mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [mkPass()])];
    const key = forecastCacheKey(TOKYO, 100);
    saveForecastCache(key, nights);
    const loaded = loadForecastCache(key);
    expect(loaded![0].passes[0].train).toBeUndefined();
  });

  // codex軽微指摘対応: train の数値検証を型の意味(0以上の整数・COSPAR形式)まで狭める
  it("rejects cached data with a malformed train field", () => {
    const key = forecastCacheKey(TOKYO, 101);
    const badTrains = [
      { groupId: "not-cospar", daysSinceDetected: 3 },
      { groupId: "2025-142", daysSinceDetected: -1 },
      { groupId: "2025-142", daysSinceDetected: 1.5 },
      { groupId: "", daysSinceDetected: null },
    ];
    for (const train of badTrains) {
      const nights = [
        mkNight(Date.UTC(2026, 7, 10, 10, 30), Date.UTC(2026, 7, 10, 19, 30), [
          mkPass({ train: train as VisiblePass["train"] }),
        ]),
      ];
      saveForecastCache(key, nights);
      // 保存済みJSONのtrainだけを不正値へ書き換える(saveForecastCache自体はvalidな値しか
      // 受け付けないため、キャッシュ破損を模擬するにはストレージへ直接書き戻す必要がある)
      const raw = JSON.parse(localStorage.getItem(FORECAST_STORAGE_KEY)!);
      raw.nights[0].passes[0].train = train;
      localStorage.setItem(FORECAST_STORAGE_KEY, JSON.stringify(raw));
      expect(loadForecastCache(key)).toBeNull();
    }
  });
});

describe("computeForecast", () => {
  it("returns 5 structurally valid nights and reports progress", async () => {
    const progress: Array<[number, number]> = [];
    const now = new Date("2026-08-10T03:00:00Z");
    const nights = await computeForecast([SYNTH_GP], TOKYO, now, (done, total) =>
      progress.push([done, total]),
    );
    expect(nights).toHaveLength(5);
    for (const night of nights) {
      expect(night.window.start.getTime()).toBeLessThan(night.window.end.getTime());
      expect(night.passes.length).toBeLessThanOrEqual(3);
      for (const p of night.passes) {
        expect(p.maxTime.getTime()).toBeGreaterThanOrEqual(night.window.start.getTime() - 900_000);
        expect(p.maxTime.getTime()).toBeLessThanOrEqual(night.window.end.getTime() + 900_000);
        expect(p.maxElevationDeg).toBeGreaterThanOrEqual(10);
        expect(p.maxElevationDeg).toBeLessThanOrEqual(90);
        expect([1, 2, 3]).toContain(p.brightness);
      }
    }
    expect(progress.length).toBeGreaterThan(0);
    const [lastDone, lastTotal] = progress[progress.length - 1];
    expect(lastDone).toBe(lastTotal);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
    }
  });

  // S4 codex重大指摘対応: trainInfoByObjectId は selectTopPasses(上位3件選抜)より前に
  // 適用される必要がある。ここでは実際の SGP4/選抜パイプラインを通しても train フィールドと
  // 明るさ補正が最終出力(選抜後)に残ることを確認する(補正が選抜後に落ちていないことの証跡)。
  it("applies train info before top-N selection so it survives in the final output", async () => {
    const now = new Date("2026-08-10T03:00:00Z");
    const trainInfoByObjectId = new Map([
      [SYNTH_GP.OBJECT_ID, { groupId: "2026-001", daysSinceDetected: 2 }],
    ]);
    const [withTrain, withoutTrain] = await Promise.all([
      computeForecast([SYNTH_GP], TOKYO, now, undefined, trainInfoByObjectId),
      computeForecast([SYNTH_GP], TOKYO, now),
    ]);
    const trainPasses = withTrain.flatMap((n) => n.passes);
    const plainPasses = withoutTrain.flatMap((n) => n.passes);
    expect(trainPasses.length).toBeGreaterThan(0);
    expect(trainPasses.length).toBe(plainPasses.length);
    for (let i = 0; i < trainPasses.length; i++) {
      expect(trainPasses[i].train).toEqual({ groupId: "2026-001", daysSinceDetected: 2 });
      expect(trainPasses[i].brightness).toBeGreaterThanOrEqual(plainPasses[i].brightness);
      expect(trainPasses[i].brightness).toBeLessThanOrEqual(3);
    }
  });
});
