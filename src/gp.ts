// 軌道データ層(S2): CelesTrak GP JSON の取得・スナップショットスキーマへのトリム・
// localStorage キャッシュ(2時間ルールをコードで強制)・satrec 生成アダプタ。
// GpRecord は S5 の日次スナップショットと共有する確定スキーマ(handoff §6 S2)。
// MEAN_MOTION_DOT/DDOT は sgp4init が使用しないため省略する(satellite.js 7.1.0 io.js で確認済み)。
import { json2satrec, type OMMJsonObject, type SatRec } from "satellite.js";
import { safeGetItem, safeSetItem } from "./location.ts";

/** スナップショット JSON の1レコード。S5 はこの形式の配列を生成する。 */
export interface GpRecord {
  OBJECT_NAME: string;
  /** COSPAR 識別子(例 "2019-074B")。打ち上げ単位のグループ化(S4)に使う */
  OBJECT_ID: string;
  NORAD_CAT_ID: number;
  /** ISO 8601 UTC(CelesTrak は "Z" なし) */
  EPOCH: string;
  /** rev/day */
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  /** deg */
  INCLINATION: number;
  /** deg */
  RA_OF_ASC_NODE: number;
  /** deg */
  ARG_OF_PERICENTER: number;
  /** deg */
  MEAN_ANOMALY: number;
  BSTAR: number;
}

export interface GpSnapshot {
  /** 取得時刻(epoch ms)。2時間ルールの起点 */
  fetchedAt: number;
  records: GpRecord[];
}

export type GpSource = "cache" | "network" | "stale-cache";

export interface GpResult {
  snapshot: GpSnapshot;
  source: GpSource;
  /** localStorage への保存に成功したか(失敗時はメモリのみ) */
  persisted: boolean;
}

export const GP_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json";
export const GP_STORAGE_KEY = "starlink-watcher:gp:v1";
/** CelesTrak への再取得間隔の下限(運用者への配慮。handoff §2) */
export const GP_MIN_FETCH_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** 正常応答とみなす有効レコードの下限(codex重大3対応: 不完全カタログでの上書き防止。
 * Starlink カタログは約1.1万件のため 100 件未満は明らかに異常) */
export const GP_MIN_VALID_RECORDS = 100;
/** 生レコード数に対する有効率の下限(部分的スキーマ変化の検知) */
export const GP_MIN_VALID_RATIO = 0.5;

const NUMERIC_FIELDS = [
  "NORAD_CAT_ID",
  "MEAN_MOTION",
  "ECCENTRICITY",
  "INCLINATION",
  "RA_OF_ASC_NODE",
  "ARG_OF_PERICENTER",
  "MEAN_ANOMALY",
  "BSTAR",
] as const;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function trimGpRecord(raw: unknown): GpRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.OBJECT_NAME !== "string" || v.OBJECT_NAME === "") return null;
  if (typeof v.OBJECT_ID !== "string" || v.OBJECT_ID === "") return null;
  if (typeof v.EPOCH !== "string") return null;
  const epochMs = Date.parse(v.EPOCH.endsWith("Z") ? v.EPOCH : `${v.EPOCH}Z`);
  if (!Number.isFinite(epochMs)) return null;
  const nums = {} as Record<(typeof NUMERIC_FIELDS)[number], number>;
  for (const field of NUMERIC_FIELDS) {
    const n = toFiniteNumber(v[field]);
    if (n === null) return null;
    nums[field] = n;
  }
  return {
    OBJECT_NAME: v.OBJECT_NAME,
    OBJECT_ID: v.OBJECT_ID,
    EPOCH: v.EPOCH,
    ...nums,
  };
}

export function parseGpJson(json: unknown): GpRecord[] {
  if (!Array.isArray(json)) return [];
  const out: GpRecord[] = [];
  for (const raw of json) {
    const rec = trimGpRecord(raw);
    if (rec !== null) out.push(rec);
  }
  return out;
}

/**
 * GpRecord → SGP4 satrec。スナップショットに無い OMM 簿記フィールドは
 * 伝播計算に影響しない既定値で補完する(sgp4init は軌道6要素+B* のみ使用)。
 * 初期化エラー(satrec.error != 0)は null を返して呼び出し側でスキップさせる。
 */
export function gpToSatrec(rec: GpRecord): SatRec | null {
  try {
    const omm: OMMJsonObject = {
      ...rec,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: "U",
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    };
    const satrec = json2satrec(omm);
    return satrec.error === 0 ? satrec : null;
  } catch {
    return null;
  }
}

export function loadGpCache(): GpSnapshot | null {
  const raw = safeGetItem(GP_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.fetchedAt !== "number" || !Number.isFinite(v.fetchedAt)) return null;
  if (!Array.isArray(v.records)) return null;
  const records: GpRecord[] = [];
  for (const rawRec of v.records) {
    const rec = trimGpRecord(rawRec);
    if (rec === null) return null; // 1件でも壊れていたらキャッシュ全体を不正扱い
    records.push(rec);
  }
  return { fetchedAt: v.fetchedAt, records };
}

export function saveGpCache(snap: GpSnapshot): boolean {
  return safeSetItem(GP_STORAGE_KEY, JSON.stringify(snap));
}

/**
 * 軌道データの取得。前回取得から2時間未満ならキャッシュを使い、ネットワークへ出ない
 * (CelesTrak 運用者への配慮を実装で強制)。取得失敗時は古いキャッシュがあればそれで
 * 継続し(source: "stale-cache")、無ければ元のエラーをそのまま投げる。
 */
export async function getGpData(opts?: {
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<GpResult> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const now = opts?.now ?? Date.now();
  const cache = loadGpCache();
  // 経過時間が負(時計巻き戻り・壊れた未来時刻)のキャッシュは fresh 扱いしない
  const cacheAge = cache ? now - cache.fetchedAt : null;
  if (cache && cacheAge !== null && cacheAge >= 0 && cacheAge < GP_MIN_FETCH_INTERVAL_MS) {
    return { snapshot: cache, source: "cache", persisted: true };
  }
  try {
    const res = await fetchFn(GP_URL);
    if (!res.ok) throw new Error(`GP fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    const rawCount = Array.isArray(json) ? json.length : 0;
    const records = parseGpJson(json);
    // 不完全カタログ(スキーマ変化・異常応答)で正常キャッシュを上書きしない
    if (
      records.length < GP_MIN_VALID_RECORDS ||
      records.length < rawCount * GP_MIN_VALID_RATIO
    ) {
      throw new Error(
        `GP fetch returned too few valid records: ${records.length}/${rawCount}`,
      );
    }
    const snapshot: GpSnapshot = { fetchedAt: now, records };
    const persisted = saveGpCache(snapshot);
    return { snapshot, source: "network", persisted };
  } catch (err) {
    if (cache) return { snapshot: cache, source: "stale-cache", persisted: true };
    throw err;
  }
}
