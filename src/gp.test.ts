// gp.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propagate } from "satellite.js";
import { gzipSync } from "node:zlib";
import {
  GP_MIN_FETCH_INTERVAL_MS,
  GP_SNAPSHOT_GZ_URL,
  GP_SNAPSHOT_MAX_AGE_MS,
  GP_SNAPSHOT_URL,
  GP_STORAGE_KEY,
  GP_URL,
  getGpData,
  gpToSatrec,
  loadBundledSnapshot,
  loadGpCache,
  parseGpJson,
  parseGpSnapshotJson,
  saveGpCache,
  trimGpRecord,
  type GpRecord,
  type GpSnapshot,
} from "./gp.ts";

// 内部的に整合した円軌道(高度約550km・傾斜53°)の合成レコード
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

const RAW_WITH_EXTRAS = {
  ...SYNTH_GP,
  MEAN_MOTION_DOT: 1.2e-5,
  MEAN_MOTION_DDOT: 0,
  ELEMENT_SET_NO: 999,
  RCS_SIZE: "LARGE",
  CLASSIFICATION_TYPE: "U",
};

beforeEach(() => {
  localStorage.clear();
});

describe("trimGpRecord", () => {
  it("keeps only the snapshot schema fields", () => {
    const rec = trimGpRecord(RAW_WITH_EXTRAS);
    expect(rec).not.toBeNull();
    expect(Object.keys(rec!).sort()).toEqual(Object.keys(SYNTH_GP).sort());
    expect(rec).toEqual(SYNTH_GP);
  });

  it("coerces numeric strings to numbers", () => {
    const rec = trimGpRecord({ ...RAW_WITH_EXTRAS, MEAN_MOTION: "15.06" });
    expect(rec?.MEAN_MOTION).toBe(15.06);
  });

  it("returns null when a required field is missing", () => {
    const { MEAN_MOTION: _drop, ...missing } = RAW_WITH_EXTRAS;
    expect(trimGpRecord(missing)).toBeNull();
  });

  it("returns null on non-finite numeric values", () => {
    expect(trimGpRecord({ ...RAW_WITH_EXTRAS, INCLINATION: "abc" })).toBeNull();
  });

  it("returns null on unparseable EPOCH", () => {
    expect(trimGpRecord({ ...RAW_WITH_EXTRAS, EPOCH: "not-a-date" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(trimGpRecord(null)).toBeNull();
    expect(trimGpRecord("x")).toBeNull();
  });
});

describe("parseGpJson", () => {
  it("returns empty array for non-array input", () => {
    expect(parseGpJson({ error: "x" })).toEqual([]);
    expect(parseGpJson(null)).toEqual([]);
  });

  it("keeps valid records and drops invalid ones", () => {
    const out = parseGpJson([RAW_WITH_EXTRAS, { junk: true }, 42]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(SYNTH_GP);
  });
});

describe("gpToSatrec", () => {
  it("builds a satrec that initializes without error", () => {
    const satrec = gpToSatrec(SYNTH_GP);
    expect(satrec).not.toBeNull();
    expect(satrec!.error).toBe(0);
  });

  it("propagates to a plausible LEO radius near epoch", () => {
    const satrec = gpToSatrec(SYNTH_GP)!;
    const pv = propagate(satrec, new Date(Date.UTC(2026, 7, 9, 12, 10, 0)));
    expect(pv).not.toBeNull();
    const { x, y, z } = pv!.position;
    const r = Math.sqrt(x * x + y * y + z * z);
    // 高度約550km → 地心距離 約6928km
    expect(r).toBeGreaterThan(6800);
    expect(r).toBeLessThan(7050);
  });
});

describe("gp cache", () => {
  const snap: GpSnapshot = { fetchedAt: 1_000_000, records: [SYNTH_GP] };

  it("round-trips a snapshot through localStorage", () => {
    expect(saveGpCache(snap)).toBe(true);
    expect(loadGpCache()).toEqual(snap);
  });

  it("stores under the versioned key", () => {
    saveGpCache(snap);
    expect(localStorage.getItem(GP_STORAGE_KEY)).not.toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadGpCache()).toBeNull();
  });

  it("returns null on corrupted JSON", () => {
    localStorage.setItem(GP_STORAGE_KEY, "{broken");
    expect(loadGpCache()).toBeNull();
  });

  it("returns null on wrong shape", () => {
    localStorage.setItem(
      GP_STORAGE_KEY,
      JSON.stringify({ fetchedAt: "x", records: "y" }),
    );
    expect(loadGpCache()).toBeNull();
  });
});

describe("getGpData 2-hour rule", () => {
  const NOW = 10_000_000_000;

  // S5: getGpData は直fetchの前に GP_SNAPSHOT_URL(・フォールバックの .gz)を確認する。
  // 既存テストの意図(GP_URL への応答をモックする)を保つため、スナップショット問い合わせ
  // (plain/gz とも)には 404(未配置)を返す。
  function okFetch(payload: unknown) {
    return vi.fn(async (url: unknown) => {
      if (String(url).includes("gp-snapshot.json")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, json: async () => payload };
    });
  }

  /** 閾値(GP_MIN_VALID_RECORDS)を満たす有効レコード列 */
  function bigRaw(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      ...RAW_WITH_EXTRAS,
      NORAD_CAT_ID: 90_000 + i,
    }));
  }

  it("uses fresh cache without fetching", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS + 60_000, records: [SYNTH_GP] });
    const fetchFn = okFetch(bigRaw(200));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(res.source).toBe("cache");
    expect(res.snapshot.records).toEqual([SYNTH_GP]);
  });

  it("fetches when cache is older than 2 hours and saves the new snapshot", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const fetchFn = okFetch(bigRaw(200));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    // S5: スナップショット確認(plain 404→gz 404)→直fetch(GP_URL)の3回
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn).toHaveBeenCalledWith(GP_URL);
    expect(res.source).toBe("network");
    expect(res.snapshot.fetchedAt).toBe(NOW);
    expect(res.snapshot.records).toHaveLength(200);
    expect(loadGpCache()?.fetchedAt).toBe(NOW);
  });

  it("fetches when there is no cache", async () => {
    const fetchFn = okFetch(bigRaw(150));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("network");
    expect(res.snapshot.records).toHaveLength(150);
  });

  it("refetches when the cache timestamp is in the future (clock rollback)", async () => {
    saveGpCache({ fetchedAt: NOW + 10 * 60_000, records: [SYNTH_GP] });
    const fetchFn = okFetch(bigRaw(120));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    // S5: スナップショット確認(plain 404→gz 404)→直fetch(GP_URL)の3回
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(res.source).toBe("network");
  });

  it("treats a response with too few valid records as failure", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const fetchFn = okFetch(bigRaw(10));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("stale-cache");
    expect(res.snapshot.records).toEqual([SYNTH_GP]);
  });

  it("treats a mostly-invalid response as failure", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const junk = Array.from({ length: 200 }, () => ({ junk: true }));
    const fetchFn = okFetch([...bigRaw(150), ...junk]);
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("stale-cache");
  });

  it("falls back to stale cache when fetch fails", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("stale-cache");
    expect(res.snapshot.records).toEqual([SYNTH_GP]);
  });

  it("treats HTTP errors as fetch failure", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("stale-cache");
  });

  it("treats a response with zero valid records as failure", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS - 1000, records: [SYNTH_GP] });
    const fetchFn = okFetch({ not: "an array" });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("stale-cache");
  });

  it("rejects with the underlying error when fetch fails and no cache exists", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW }),
    ).rejects.toThrow("network down");
  });
});

describe("parseGpSnapshotJson (S5)", () => {
  it("validates a well-formed snapshot", () => {
    const parsed = parseGpSnapshotJson({ fetchedAt: 123, records: [SYNTH_GP] });
    expect(parsed).toEqual({ fetchedAt: 123, records: [SYNTH_GP] });
  });

  it("trims each record through trimGpRecord", () => {
    const parsed = parseGpSnapshotJson({ fetchedAt: 1, records: [RAW_WITH_EXTRAS] });
    expect(parsed?.records).toEqual([SYNTH_GP]);
  });

  it("returns null when fetchedAt is missing or non-finite", () => {
    expect(parseGpSnapshotJson({ records: [SYNTH_GP] })).toBeNull();
    expect(parseGpSnapshotJson({ fetchedAt: NaN, records: [SYNTH_GP] })).toBeNull();
  });

  it("returns null when records is not an array", () => {
    expect(parseGpSnapshotJson({ fetchedAt: 1, records: "nope" })).toBeNull();
  });

  it("returns null when any record fails validation", () => {
    expect(
      parseGpSnapshotJson({ fetchedAt: 1, records: [SYNTH_GP, { junk: true }] }),
    ).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseGpSnapshotJson(null)).toBeNull();
    expect(parseGpSnapshotJson("nope")).toBeNull();
  });
});

describe("loadBundledSnapshot (S5)", () => {
  it("fetches GP_SNAPSHOT_URL and returns a parsed snapshot", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      expect(url).toBe(GP_SNAPSHOT_URL);
      return { ok: true, json: async () => ({ fetchedAt: 42, records: [SYNTH_GP] }) };
    });
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ fetchedAt: 42, records: [SYNTH_GP] });
  });

  it("returns null on HTTP error (e.g. snapshot file not deployed yet)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null when the response body fails validation", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ not: "a snapshot" }) }));
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  // S5: build-snapshot.ts はトリム後1MB超なら .json.gz を書き出す(実データで実測: 3.01MB→gzip
  // 0.53MB)。plain .json が無い(404)場合、.json.gz を DecompressionStream で展開して読む。
  it("falls back to the gzip variant when the plain snapshot is missing", async () => {
    const body = JSON.stringify({ fetchedAt: 42, records: [SYNTH_GP] });
    const gz = gzipSync(Buffer.from(body));
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url) === GP_SNAPSHOT_URL) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      expect(url).toBe(GP_SNAPSHOT_GZ_URL);
      return new Response(gz, { status: 200 });
    });
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ fetchedAt: 42, records: [SYNTH_GP] });
  });

  it("returns null when both the plain and gzip variants are missing", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const result = await loadBundledSnapshot(fetchFn as unknown as typeof fetch);
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("getGpData snapshot fallback (S5, D-010)", () => {
  const NOW = 10_000_000_000;

  function routedFetch(handlers: Record<string, () => unknown>) {
    return vi.fn(async (url: unknown) => {
      const href = String(url);
      for (const [key, handler] of Object.entries(handlers)) {
        if (href.includes(key)) return handler();
      }
      throw new Error(`unexpected fetch: ${href}`);
    });
  }

  it("prefers a fresh bundled snapshot over a direct CelesTrak fetch when there is no local cache", async () => {
    const snapshotFetchedAt = NOW - 60 * 60 * 1000; // 1h old, within GP_SNAPSHOT_MAX_AGE_MS
    const fetchFn = routedFetch({
      "gp-snapshot.json": () => ({
        ok: true,
        json: async () => ({ fetchedAt: snapshotFetchedAt, records: [SYNTH_GP] }),
      }),
      "celestrak.org": () => {
        throw new Error("must not hit CelesTrak directly when a fresh snapshot exists");
      },
    });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("snapshot");
    expect(res.snapshot.records).toEqual([SYNTH_GP]);
  });

  // codex軽微指摘対応: 「24時間超で古い」の境界はちょうど24hを新鮮側に含める
  it("treats a bundled snapshot exactly 24h old as still fresh", async () => {
    const exactlyMaxAge = NOW - GP_SNAPSHOT_MAX_AGE_MS;
    const fetchFn = routedFetch({
      "gp-snapshot.json": () => ({
        ok: true,
        json: async () => ({ fetchedAt: exactlyMaxAge, records: [SYNTH_GP] }),
      }),
      "celestrak.org": () => {
        throw new Error("must not hit CelesTrak directly at exactly 24h");
      },
    });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("snapshot");
  });

  it("falls back to a direct CelesTrak fetch when the bundled snapshot is older than 24h", async () => {
    const staleFetchedAt = NOW - GP_SNAPSHOT_MAX_AGE_MS - 60 * 60 * 1000;
    const fetchFn = routedFetch({
      "gp-snapshot.json": () => ({
        ok: true,
        json: async () => ({ fetchedAt: staleFetchedAt, records: [SYNTH_GP] }),
      }),
      "celestrak.org": () => ({ ok: true, json: async () => bigRawForSnapshotTest(200) }),
    });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("network");
    expect(res.snapshot.records).toHaveLength(200);
  });

  it("still prefers a fresh local cache over the bundled snapshot", async () => {
    saveGpCache({ fetchedAt: NOW - GP_MIN_FETCH_INTERVAL_MS + 60_000, records: [SYNTH_GP] });
    const fetchFn = routedFetch({
      "gp-snapshot.json": () => {
        throw new Error("must not fetch the snapshot when local cache is fresh");
      },
    });
    const res = await getGpData({ fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    expect(res.source).toBe("cache");
  });
});

function bigRawForSnapshotTest(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    OBJECT_NAME: "STARLINK-TEST",
    OBJECT_ID: "2026-001A",
    NORAD_CAT_ID: 90_000 + i,
    EPOCH: "2026-08-09T12:00:00.000000",
    MEAN_MOTION: 15.06,
    ECCENTRICITY: 0.0001,
    INCLINATION: 53.05,
    RA_OF_ASC_NODE: 120,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: 0,
    BSTAR: 0.0003,
  }));
}
