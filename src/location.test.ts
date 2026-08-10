// location.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY,
  clearLocation,
  getCurrentPosition,
  loadLocation,
  parsePhotonResponse,
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

describe("parsePhotonResponse", () => {
  const photonFeature = (lon: number, lat: number, props: Record<string, unknown>) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: props,
  });

  it("extracts lat/lon (GeoJSON order is [lon, lat]) and builds a label", () => {
    const json = {
      type: "FeatureCollection",
      features: [photonFeature(139.7539, 35.6938, { name: "Chiyoda", state: "Tokyo", country: "Japan" })],
    };
    const results = parsePhotonResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.lat).toBeCloseTo(35.6938);
    expect(results[0]!.lon).toBeCloseTo(139.7539);
    expect(results[0]!.label).toContain("Chiyoda");
  });

  it("returns empty array for empty feature list", () => {
    expect(parsePhotonResponse({ type: "FeatureCollection", features: [] })).toEqual([]);
  });

  it("returns empty array for malformed payloads instead of throwing", () => {
    expect(parsePhotonResponse(null)).toEqual([]);
    expect(parsePhotonResponse({})).toEqual([]);
    expect(parsePhotonResponse({ features: "nope" })).toEqual([]);
  });

  it("skips features with out-of-range coordinates", () => {
    const json = {
      type: "FeatureCollection",
      features: [
        photonFeature(999, 999, { name: "Broken" }),
        photonFeature(135.0, 34.7, { name: "Osaka" }),
      ],
    };
    const results = parsePhotonResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toContain("Osaka");
  });

  it("skips features without numeric coordinates", () => {
    const json = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: ["x", "y"] }, properties: { name: "Bad" } },
        photonFeature(135.0, 34.7, { name: "Osaka" }),
      ],
    };
    const results = parsePhotonResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toContain("Osaka");
  });
});

describe("searchPlace", () => {
  it("calls Photon with the URL-encoded query and parses the response", async () => {
    const payload = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [139.7539, 35.6938] },
          properties: { name: "Chiyoda" },
        },
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
    const results = await searchPlace("chiyoda ward", fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchFn.mock.calls[0]![0]);
    expect(calledUrl).toContain("photon.komoot.io");
    expect(calledUrl).toContain("chiyoda%20ward");
    // lang=default: OSM のローカル言語名(日本の地名なら日本語)を要求する(D-008)
    expect(calledUrl).toContain("lang=default");
    expect(results).toHaveLength(1);
    expect(results[0]!.lat).toBeCloseTo(35.6938);
  });

  it("throws on non-OK HTTP response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("err", { status: 503 }));
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
