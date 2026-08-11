// train.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_TRAIN_GROUP_SIZE,
  TRAIN_ALTITUDE_THRESHOLD_KM,
  averageAltitudeKm,
  buildTrainInfoMap,
  daysSinceFirstSeen,
  deriveTrainHighlight,
  detectTrains,
  groupRecordsByLaunch,
  isTrainGroup,
  launchGroupId,
  loadFirstSeenMap,
  meanMotionToAltitudeKm,
  refreshTrainDays,
  saveFirstSeenMap,
  trackFirstSeen,
  type FirstSeenMap,
} from "./train.ts";
import type { GpRecord } from "./gp.ts";
import type { Brightness } from "./astro.ts";
import type { NightForecast, VisiblePass } from "./passes.ts";

function makeRecord(objectId: string, meanMotion: number): GpRecord {
  return {
    OBJECT_NAME: `STARLINK-${objectId}`,
    OBJECT_ID: objectId,
    NORAD_CAT_ID: 90000,
    EPOCH: "2026-08-11T00:00:00.000000",
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: 0.0001,
    INCLINATION: 53.05,
    RA_OF_ASC_NODE: 120,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: 0,
    BSTAR: 0.0003,
  };
}

// meanMotionToAltitudeKm(15.06) ~= 550km, meanMotionToAltitudeKm(15.933) ~= 300km
// (derived analytically from Kepler's third law; used as the reference fixtures below)
const OPS_MEAN_MOTION = 15.06; // ~550km, matches astro.ts OPS_REFERENCE_RANGE_KM
const LOW_MEAN_MOTION = 15.933; // ~300km, freshly-launched parking orbit

beforeEach(() => {
  localStorage.clear();
});

describe("launchGroupId", () => {
  it("extracts the COSPAR launch prefix", () => {
    expect(launchGroupId("2019-074B")).toBe("2019-074");
    expect(launchGroupId("2025-142A")).toBe("2025-142");
  });

  it("returns null for malformed ids", () => {
    expect(launchGroupId("not-an-id")).toBeNull();
    expect(launchGroupId("")).toBeNull();
  });
});

describe("meanMotionToAltitudeKm", () => {
  it("estimates operational altitude (~550km) from mean motion", () => {
    // gp.test.ts の SYNTH_GP コメント通り「高度約550km」の近似値(円軌道近似の誤差込みで556km程度)
    expect(meanMotionToAltitudeKm(OPS_MEAN_MOTION)).toBeCloseTo(556, -1);
  });

  it("estimates low parking-orbit altitude (~300km) from mean motion", () => {
    expect(meanMotionToAltitudeKm(LOW_MEAN_MOTION)).toBeCloseTo(300, -1);
  });
});

describe("groupRecordsByLaunch", () => {
  it("groups records by their launch prefix", () => {
    const records = [
      makeRecord("2025-142A", LOW_MEAN_MOTION),
      makeRecord("2025-142B", LOW_MEAN_MOTION),
      makeRecord("2019-074C", OPS_MEAN_MOTION),
    ];
    const groups = groupRecordsByLaunch(records);
    expect(groups.size).toBe(2);
    expect(groups.get("2025-142")).toHaveLength(2);
    expect(groups.get("2019-074")).toHaveLength(1);
  });

  it("skips records with unparseable object ids", () => {
    const groups = groupRecordsByLaunch([makeRecord("garbage", OPS_MEAN_MOTION)]);
    expect(groups.size).toBe(0);
  });
});

describe("averageAltitudeKm", () => {
  it("averages estimated altitudes across records", () => {
    const records = [
      makeRecord("2025-142A", OPS_MEAN_MOTION),
      makeRecord("2025-142B", LOW_MEAN_MOTION),
    ];
    const avg = averageAltitudeKm(records);
    expect(avg).toBeCloseTo((550 + 300) / 2, -1);
  });
});

describe("isTrainGroup", () => {
  it("flags a group below the altitude threshold as a train", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord(`2025-142${String.fromCharCode(65 + i)}`, LOW_MEAN_MOTION),
    );
    expect(isTrainGroup(records)).toBe(true);
  });

  it("does not flag an operational-altitude group as a train", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord(`2019-074${String.fromCharCode(65 + i)}`, OPS_MEAN_MOTION),
    );
    expect(isTrainGroup(records)).toBe(false);
  });

  it("does not flag a group smaller than MIN_TRAIN_GROUP_SIZE even if low", () => {
    const records = Array.from({ length: MIN_TRAIN_GROUP_SIZE - 1 }, (_, i) =>
      makeRecord(`2025-999${String.fromCharCode(65 + i)}`, LOW_MEAN_MOTION),
    );
    expect(isTrainGroup(records)).toBe(false);
  });

  it("returns false for an empty group", () => {
    expect(isTrainGroup([])).toBe(false);
  });

  it("threshold constant is exported and used at the boundary", () => {
    // 実データ検証(2026-08-11)で 480km は高すぎると判明(恒久稼働シェルが約470kmで
    // 誤検出される)。420km に引き下げた(train.ts 内のコメント参照)
    expect(TRAIN_ALTITUDE_THRESHOLD_KM).toBe(420);
  });
});

describe("detectTrains", () => {
  const lowGroup = Array.from({ length: 6 }, (_, i) =>
    makeRecord(`2025-142${String.fromCharCode(65 + i)}`, LOW_MEAN_MOTION),
  );
  const opsGroup = Array.from({ length: 6 }, (_, i) =>
    makeRecord(`2019-074${String.fromCharCode(65 + i)}`, OPS_MEAN_MOTION),
  );

  it("detects the low-altitude group as a train and excludes the operational group", () => {
    const result = detectTrains([...lowGroup, ...opsGroup]);
    expect(result.trainGroups.size).toBe(1);
    expect(result.trainGroups.has("2025-142")).toBe(true);
    expect(result.trainObjectIds.size).toBe(lowGroup.length);
    for (const rec of lowGroup) {
      expect(result.trainObjectIds.get(rec.OBJECT_ID)).toBe("2025-142");
    }
    for (const rec of opsGroup) {
      expect(result.trainObjectIds.has(rec.OBJECT_ID)).toBe(false);
    }
  });

  it("returns empty results when no train is present (band must not show)", () => {
    const result = detectTrains(opsGroup);
    expect(result.trainGroups.size).toBe(0);
    expect(result.trainObjectIds.size).toBe(0);
  });

  // 実データ検証(2026-08-11)で判明: 恒久的に低い軌道シェルの旧い群(2019〜2020年打ち上げ)が
  // 480km閾値だけでは「トレイン」と誤検出される(実データで衛星の過半数が該当)。
  // 直近打ち上げ(recency)でも絞り込む必要がある。
  it("excludes an old permanently-low-altitude group even though it is below the threshold", () => {
    const oldLowGroup = Array.from({ length: 6 }, (_, i) =>
      makeRecord(`2019-074${String.fromCharCode(65 + i)}`, LOW_MEAN_MOTION),
    );
    // 直近打ち上げ群を大量に用意し、oldLowGroup が recency window の外に出るようにする
    const manyRecentGroups: GpRecord[] = [];
    for (let g = 1; g <= 25; g++) {
      const prefix = `2026-${String(g).padStart(3, "0")}`;
      for (let i = 0; i < 6; i++) {
        manyRecentGroups.push(makeRecord(`${prefix}${String.fromCharCode(65 + i)}`, OPS_MEAN_MOTION));
      }
    }
    const result = detectTrains([...oldLowGroup, ...manyRecentGroups]);
    expect(result.trainGroups.has("2019-074")).toBe(false);
    expect(result.trainObjectIds.size).toBe(0);
  });
});

describe("first-seen storage", () => {
  it("returns an empty map when nothing is stored", () => {
    expect(loadFirstSeenMap()).toEqual({});
  });

  it("round-trips a map through localStorage", () => {
    const map: FirstSeenMap = { "2025-142": 1000 };
    expect(saveFirstSeenMap(map)).toBe(true);
    expect(loadFirstSeenMap()).toEqual(map);
  });

  it("returns empty on corrupted storage", () => {
    localStorage.setItem("starlink-watcher:train-first-seen:v1", "{not json");
    expect(loadFirstSeenMap()).toEqual({});
  });
});

describe("daysSinceFirstSeen", () => {
  const DAY_MS = 86_400_000;

  it("returns null for a group not yet seen", () => {
    expect(daysSinceFirstSeen("2025-142", {}, Date.now())).toBeNull();
  });

  it("returns whole days elapsed since first seen", () => {
    const now = 10 * DAY_MS;
    const map: FirstSeenMap = { "2025-142": 7 * DAY_MS };
    expect(daysSinceFirstSeen("2025-142", map, now)).toBe(3);
  });

  it("clamps to 0 when the stored timestamp is in the future (clock rollback)", () => {
    const now = 5 * DAY_MS;
    const map: FirstSeenMap = { "2025-142": 6 * DAY_MS };
    expect(daysSinceFirstSeen("2025-142", map, now)).toBe(0);
  });
});

describe("trackFirstSeen", () => {
  const DAY_MS = 86_400_000;

  it("marks first-observed groups as new (null days) and persists them", () => {
    const result = trackFirstSeen(["2025-142"], 100 * DAY_MS);
    expect(result.daysById.get("2025-142")).toBeNull();
    expect(loadFirstSeenMap()["2025-142"]).toBe(100 * DAY_MS);
  });

  it("computes elapsed days on a later call without resetting the origin", () => {
    trackFirstSeen(["2025-142"], 100 * DAY_MS);
    const result = trackFirstSeen(["2025-142"], 103 * DAY_MS);
    expect(result.daysById.get("2025-142")).toBe(3);
  });

  it("treats a newly-appearing group as new even when others are already tracked", () => {
    trackFirstSeen(["2025-142"], 100 * DAY_MS);
    const result = trackFirstSeen(["2025-142", "2026-050"], 103 * DAY_MS);
    expect(result.daysById.get("2025-142")).toBe(3);
    expect(result.daysById.get("2026-050")).toBeNull();
  });
});

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

describe("buildTrainInfoMap", () => {
  it("maps objectId to TrainInfo using the group's day count", () => {
    const trainObjectIds = new Map([
      ["2025-142A", "2025-142"],
      ["2025-142B", "2025-142"],
    ]);
    const daysById = new Map<string, number | null>([["2025-142", 3]]);
    const result = buildTrainInfoMap(trainObjectIds, daysById);
    expect(result.get("2025-142A")).toEqual({ groupId: "2025-142", daysSinceDetected: 3 });
    expect(result.get("2025-142B")).toEqual({ groupId: "2025-142", daysSinceDetected: 3 });
  });

  it("defaults daysSinceDetected to null when the group is missing from daysById", () => {
    const trainObjectIds = new Map([["2025-142A", "2025-142"]]);
    const result = buildTrainInfoMap(trainObjectIds, new Map());
    expect(result.get("2025-142A")).toEqual({ groupId: "2025-142", daysSinceDetected: null });
  });

  it("returns an empty map for no trains", () => {
    expect(buildTrainInfoMap(new Map(), new Map()).size).toBe(0);
  });
});

describe("refreshTrainDays", () => {
  beforeEach(() => {
    passSeq = 0;
    localStorage.clear();
  });

  const DAY_MS = 86_400_000;

  it("updates daysSinceDetected using the current first-seen record without touching brightness", () => {
    saveFirstSeenMap({ "2025-142": 100 * DAY_MS });
    const trainPass = mkPass({
      objectId: "2025-142A",
      brightness: 3 as Brightness,
      train: { groupId: "2025-142", daysSinceDetected: 0 },
    });
    const nights = [mkNight(Date.UTC(2026, 7, 10), [trainPass])];
    const result = refreshTrainDays(nights, 103 * DAY_MS);
    expect(result[0].passes[0].train).toEqual({ groupId: "2025-142", daysSinceDetected: 3 });
    expect(result[0].passes[0].brightness).toBe(3);
  });

  it("leaves non-train passes unchanged", () => {
    const nights = [mkNight(Date.UTC(2026, 7, 10), [mkPass({ objectId: "2019-074C" })])];
    const result = refreshTrainDays(nights, Date.now());
    expect(result[0].passes[0].train).toBeUndefined();
  });
});

describe("deriveTrainHighlight", () => {
  beforeEach(() => {
    passSeq = 0;
  });

  it("returns null when no pass has train info", () => {
    const nights = [mkNight(Date.UTC(2026, 7, 10), [mkPass()])];
    expect(deriveTrainHighlight(nights, new Date(Date.UTC(2026, 7, 9)))).toBeNull();
  });

  it("returns the soonest upcoming train pass", () => {
    const now = new Date(Date.UTC(2026, 7, 10, 0, 0, 0));
    const trainPass = mkPass({
      objectId: "2025-142A",
      train: { groupId: "2025-142", daysSinceDetected: 3 },
      maxTime: new Date(Date.UTC(2026, 7, 10, 21, 0, 0)),
    });
    const nights = [mkNight(Date.UTC(2026, 7, 10), [mkPass(), trainPass])];
    const result = deriveTrainHighlight(nights, now);
    expect(result?.objectId).toBe("2025-142A");
  });

  it("skips a train pass that has already occurred and checks later nights", () => {
    const now = new Date(Date.UTC(2026, 7, 11, 0, 0, 0));
    const pastTrainPass = mkPass({
      objectId: "2025-142A",
      train: { groupId: "2025-142", daysSinceDetected: 3 },
      maxTime: new Date(Date.UTC(2026, 7, 10, 21, 0, 0)), // before `now`
    });
    const futureTrainPass = mkPass({
      objectId: "2025-142B",
      train: { groupId: "2025-142", daysSinceDetected: 4 },
      maxTime: new Date(Date.UTC(2026, 7, 12, 21, 0, 0)),
    });
    const nights = [
      mkNight(Date.UTC(2026, 7, 10), [pastTrainPass]),
      mkNight(Date.UTC(2026, 7, 12), [futureTrainPass]),
    ];
    const result = deriveTrainHighlight(nights, now);
    expect(result?.objectId).toBe("2025-142B");
  });
});
