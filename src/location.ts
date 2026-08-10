// 観測地点の状態管理: localStorage 保存・復元、Geolocation、Photon 地名検索、緯度経度検証。
// 位置情報(緯度経度)は端末外へ送信しない(D-002/D-004)。Photon へは地名文字列のみ送る。

export interface ObserverLocation {
  lat: number;
  lon: number;
  /** 表示名(例: "東京都千代田区" / "35.68, 139.75") */
  label: string;
  source: "geolocation" | "search" | "manual";
}

export interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
}

export type CoordsValidation =
  | { ok: true; lat: number; lon: number }
  | { ok: false; reason: "not-a-number" | "lat-out-of-range" | "lon-out-of-range" };

export const STORAGE_KEY = "starlink-watcher:location:v1";

export const PHOTON_ENDPOINT = "https://photon.komoot.io/api/";

// localStorage はストレージ無効化・容量超過で例外を投げうるため、直接触らず必ずここを通す
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 消せない場合は放置(次回 load 時の検証で弾かれる)
  }
}

function coordsInRange(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** @returns 保存に成功したら true(ストレージ無効・容量超過なら false) */
export function saveLocation(loc: ObserverLocation): boolean {
  return safeSetItem(STORAGE_KEY, JSON.stringify(loc));
}

export function loadLocation(): ObserverLocation | null {
  const raw = safeGetItem(STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (
    typeof v.lat === "number" && Number.isFinite(v.lat) &&
    typeof v.lon === "number" && Number.isFinite(v.lon) &&
    coordsInRange(v.lat, v.lon) &&
    typeof v.label === "string" &&
    (v.source === "geolocation" || v.source === "search" || v.source === "manual")
  ) {
    return { lat: v.lat, lon: v.lon, label: v.label, source: v.source };
  }
  return null;
}

export function clearLocation(): void {
  safeRemoveItem(STORAGE_KEY);
}

export function validateCoords(latInput: string, lonInput: string): CoordsValidation {
  const latStr = latInput.trim();
  const lonStr = lonInput.trim();
  // Number("") は 0 になるため、空文字は明示的に弾く
  if (latStr === "" || lonStr === "") return { ok: false, reason: "not-a-number" };
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, reason: "not-a-number" };
  }
  if (lat < -90 || lat > 90) return { ok: false, reason: "lat-out-of-range" };
  if (lon < -180 || lon > 180) return { ok: false, reason: "lon-out-of-range" };
  return { ok: true, lat, lon };
}

export function parsePhotonResponse(json: unknown): GeocodeResult[] {
  if (typeof json !== "object" || json === null) return [];
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const out: GeocodeResult[] = [];
  for (const feature of features) {
    if (typeof feature !== "object" || feature === null) continue;
    const geometry = (feature as { geometry?: unknown }).geometry;
    const coordinates =
      typeof geometry === "object" && geometry !== null
        ? (geometry as { coordinates?: unknown }).coordinates
        : null;
    // GeoJSON の座標順は [lon, lat]
    if (!Array.isArray(coordinates)) continue;
    const [lon, lat] = coordinates;
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!coordsInRange(lat, lon)) continue;
    const props = ((feature as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
    const parts = [props.name, props.city, props.state, props.country].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const label = [...new Set(parts)].join(" ") || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    out.push({ lat, lon, label });
  }
  return out;
}

export async function searchPlace(
  query: string,
  fetchFn: typeof fetch = fetch,
): Promise<GeocodeResult[]> {
  // lang=default: OSM のローカル言語名(日本の地名なら日本語)を返させる(D-008)
  const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(query)}&limit=5&lang=default`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
  return parsePhotonResponse(await res.json());
}

export function getCurrentPosition(
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation,
): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}
