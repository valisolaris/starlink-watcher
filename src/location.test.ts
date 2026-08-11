// location.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY,
  clearLocation,
  getCurrentPosition,
  loadLocation,
  parseGsiResponse,
  saveLocation,
  searchPlace,
  validateCoords,
  type ObserverLocation,
} from "./location.ts";

const tokyo: ObserverLocation = {
  lat: 35.6895,
  lon: 139.6917,
  label: "Tokyo Chiyoda",
  source: "manual",
};

// GSI(国土地理院)住所検索APIの実レスポンス形式: FeatureCollectionではなく素のFeature配列、
// ラベルはproperties.title 1本(Photonのような複数フィールド連結は不要)。実測して確認済み。
const gsiFeature = (lon: number, lat: number, title: string, addressCode = "") => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { title, addressCode },
});

const mockFetchJson = (payload: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));

beforeEach(() => {
  localStorage.clear();
});

describe("saveLocation / loadLocation", () => {
  it("round-trips a location through localStorage", () => {
    saveLocation(tokyo);
    expect(loadLocation()).toEqual(tokyo);
  });

  it("persists under the versioned storage key", () => {
    saveLocation(tokyo);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadLocation()).toBeNull();
  });

  it("returns null on corrupted JSON instead of throwing", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadLocation()).toBeNull();
  });

  it("returns null when stored object misses required fields", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat: 1 }));
    expect(loadLocation()).toBeNull();
  });

  it("clearLocation removes the stored value", () => {
    saveLocation(tokyo);
    clearLocation();
    expect(loadLocation()).toBeNull();
  });

  it("returns null when stored coords are out of range", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lat: 999, lon: 999, label: "bad", source: "manual" }),
    );
    expect(loadLocation()).toBeNull();
  });
});

describe("storage failure resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadLocation returns null instead of throwing when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(loadLocation()).toBeNull();
  });

  it("saveLocation returns false instead of throwing when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => saveLocation(tokyo)).not.toThrow();
    expect(saveLocation(tokyo)).toBe(false);
  });

  it("saveLocation returns true on success", () => {
    expect(saveLocation(tokyo)).toBe(true);
  });

  it("clearLocation does not throw when removeItem throws", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(() => clearLocation()).not.toThrow();
  });
});

describe("validateCoords", () => {
  it("accepts valid decimal degree strings", () => {
    const r = validateCoords("35.6895", "139.6917");
    expect(r).toEqual({ ok: true, lat: 35.6895, lon: 139.6917 });
  });

  it("accepts boundary values -90/90 and -180/180", () => {
    expect(validateCoords("-90", "180").ok).toBe(true);
    expect(validateCoords("90", "-180").ok).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const r = validateCoords(" 35.0 ", " 139.0 ");
    expect(r).toEqual({ ok: true, lat: 35.0, lon: 139.0 });
  });

  it("rejects non-numeric input", () => {
    expect(validateCoords("abc", "139")).toEqual({ ok: false, reason: "not-a-number" });
    expect(validateCoords("", "139")).toEqual({ ok: false, reason: "not-a-number" });
  });

  it("rejects latitude out of range", () => {
    expect(validateCoords("90.1", "0")).toEqual({ ok: false, reason: "lat-out-of-range" });
    expect(validateCoords("-91", "0")).toEqual({ ok: false, reason: "lat-out-of-range" });
  });

  it("rejects longitude out of range", () => {
    expect(validateCoords("0", "180.5")).toEqual({ ok: false, reason: "lon-out-of-range" });
    expect(validateCoords("0", "-181")).toEqual({ ok: false, reason: "lon-out-of-range" });
  });
});

describe("parseGsiResponse", () => {
  it("extracts lat/lon (GeoJSON order is [lon, lat]) and uses properties.title as the label", () => {
    // 実際にGSI APIへ「川崎市麻生区片平3-11-1-4」を投げて得た実データ
    const json = [gsiFeature(139.492935, 35.590492, "神奈川県川崎市麻生区片平三丁目１１番")];
    const results = parseGsiResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.lat).toBeCloseTo(35.590492);
    expect(results[0]!.lon).toBeCloseTo(139.492935);
    expect(results[0]!.label).toBe("神奈川県川崎市麻生区片平三丁目１１番");
  });

  it("returns empty array for an empty array payload", () => {
    expect(parseGsiResponse([])).toEqual([]);
  });

  it("returns empty array for malformed payloads instead of throwing", () => {
    expect(parseGsiResponse(null)).toEqual([]);
    expect(parseGsiResponse({})).toEqual([]);
    expect(parseGsiResponse("nope")).toEqual([]);
    // GSIはFeatureCollectionでラップしないため、その形で来ても配列扱いできず空を返す
    expect(parseGsiResponse({ type: "FeatureCollection", features: [] })).toEqual([]);
  });

  it("skips features with out-of-range coordinates", () => {
    const json = [gsiFeature(999, 999, "Broken"), gsiFeature(135.0, 34.7, "大阪府大阪市")];
    const results = parseGsiResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("大阪府大阪市");
  });

  it("skips features without numeric coordinates", () => {
    const json = [
      { type: "Feature", geometry: { type: "Point", coordinates: ["x", "y"] }, properties: { title: "Bad" } },
      gsiFeature(135.0, 34.7, "大阪府大阪市"),
    ];
    const results = parseGsiResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("大阪府大阪市");
  });

  it("falls back to a coordinate string label when title is missing or empty", () => {
    const json = [gsiFeature(135.0, 34.7, "")];
    const results = parseGsiResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("34.7000, 135.0000");
  });
});

describe("searchPlace", () => {
  it("calls GSI with the URL-encoded query and parses the response", async () => {
    const payload = [gsiFeature(139.7539, 35.6938, "東京都千代田区", "13101")];
    const fetchFn = mockFetchJson(payload);
    const results = await searchPlace("千代田区", fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchFn.mock.calls[0]![0]);
    expect(calledUrl).toContain("msearch.gsi.go.jp");
    expect(calledUrl).toContain(encodeURIComponent("千代田区"));
    expect(results).toHaveLength(1);
    expect(results[0]!.lat).toBeCloseTo(35.6938);
  });

  it("resolves a banchi-level Japanese address using the real GSI response shape", async () => {
    // 実際にGSI APIへ「川崎市麻生区片平3-11-1-4」を投げて得た実データをそのまま使う
    const payload = [gsiFeature(139.492935, 35.590492, "神奈川県川崎市麻生区片平三丁目１１番")];
    const fetchFn = mockFetchJson(payload);
    const results = await searchPlace("川崎市麻生区片平3-11-1-4", fetchFn as unknown as typeof fetch);

    expect(results).toHaveLength(1);
    expect(results[0]!.lat).toBeCloseTo(35.590492);
    expect(results[0]!.lon).toBeCloseTo(139.492935);
    expect(results[0]!.label).toBe("神奈川県川崎市麻生区片平三丁目１１番");
  });

  it("limits results to 5 even if the API returns more", async () => {
    const payload = Array.from({ length: 7 }, (_, i) => gsiFeature(139.0 + i, 35.0 + i, `結果${i}`));
    const fetchFn = mockFetchJson(payload);
    const results = await searchPlace("東京", fetchFn as unknown as typeof fetch);
    expect(results).toHaveLength(5);
  });

  it("throws on non-OK HTTP response", async () => {
    const fetchFn = mockFetchJson("err", 503);
    await expect(searchPlace("tokyo", fetchFn as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("getCurrentPosition", () => {
  it("resolves with lat/lon when geolocation succeeds", async () => {
    const geo = {
      getCurrentPosition: (ok: PositionCallback) =>
        ok({ coords: { latitude: 35.1, longitude: 139.2 } } as GeolocationPosition),
    } as unknown as Geolocation;
    await expect(getCurrentPosition(geo)).resolves.toEqual({ lat: 35.1, lon: 139.2 });
  });

  it("rejects when the user denies permission", async () => {
    const geo = {
      getCurrentPosition: (_ok: PositionCallback, err?: PositionErrorCallback) =>
        err?.({ code: 1, message: "denied" } as GeolocationPositionError),
    } as unknown as Geolocation;
    await expect(getCurrentPosition(geo)).rejects.toBeTruthy();
  });

  it("rejects when geolocation is unavailable", async () => {
    await expect(getCurrentPosition(undefined)).rejects.toBeTruthy();
  });
});
