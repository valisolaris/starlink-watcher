// トレイン検出層(S4): OBJECT_ID の打ち上げ単位グループ化・平均高度推定・
// トレイン判定(D-011: TLE のみ、追加 API なし)・初回検出日の localStorage 記録。
import { safeGetItem, safeSetItem } from "./location.ts";
import type { GpRecord } from "./gp.ts";
import type { NightForecast, TrainInfo, VisiblePass } from "./passes.ts";

/** 地球平均半径(km) */
const EARTH_RADIUS_KM = 6371.0;
/** 地心重力定数(km^3/s^2) */
const EARTH_MU_KM3_S2 = 398600.4418;

/**
 * 群の平均高度がこれ未満ならトレイン候補とする(handoff §6 S4 の目安480kmを実データで
 * 検証した結果、下方修正)。実データ(2026-08-11、CelesTrak実測)では多くの運用シェルが
 * 恒久的に約465〜473kmで安定しており、480km では衛星の過半数が誤検出された。
 * 420km は「明らかにまだ上昇中(打ち上げ後 概ね3週間以内)」の群のみを捉える値。
 */
export const TRAIN_ALTITUDE_THRESHOLD_KM = 420;
/** これ未満の群サイズは、単独の減衰・機動中衛星による誤検出を避けるためトレイン扱いしない */
export const MIN_TRAIN_GROUP_SIZE = 4;
/**
 * トレイン候補とする「直近の打ち上げ」の範囲(OBJECT_ID の年-通番で降順ソートした上位N群)。
 * 高度閾値だけでは恒久的に低いシェル(旧い打ち上げ)を除外できないため(実データで判明)、
 * 直近性でも絞り込む。COSPAR通番は全世界の打ち上げ通しのため、20群は実測ベースで
 * おおよそ直近3〜4週間相当(D-011: 追加APIなしで得られる唯一の直近性シグナル)。
 */
export const TRAIN_RECENCY_WINDOW = 20;

const LAUNCH_PREFIX_RE = /^(\d{4}-\d{3})/;

/** COSPAR ID(例 "2019-074B")から打ち上げ単位のプレフィックス("2019-074")を取り出す */
export function launchGroupId(objectId: string): string | null {
  const m = LAUNCH_PREFIX_RE.exec(objectId);
  return m ? m[1] : null;
}

/** 平均運動(rev/day)→高度(km)の概算。円軌道近似(Kepler の第3法則) */
export function meanMotionToAltitudeKm(meanMotionRevPerDay: number): number {
  const nRadPerSec = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  const semiMajorAxisKm = Math.cbrt(EARTH_MU_KM3_S2 / (nRadPerSec * nRadPerSec));
  return semiMajorAxisKm - EARTH_RADIUS_KM;
}

/** OBJECT_ID の打ち上げプレフィックスでレコードを群化する。不正な ID は無視する */
export function groupRecordsByLaunch(records: GpRecord[]): Map<string, GpRecord[]> {
  const groups = new Map<string, GpRecord[]>();
  for (const rec of records) {
    const id = launchGroupId(rec.OBJECT_ID);
    if (id === null) continue;
    const arr = groups.get(id);
    if (arr) arr.push(rec);
    else groups.set(id, [rec]);
  }
  return groups;
}

/** 群の平均高度(km) */
export function averageAltitudeKm(records: GpRecord[]): number {
  const sum = records.reduce((s, r) => s + meanMotionToAltitudeKm(r.MEAN_MOTION), 0);
  return sum / records.length;
}

/** 群がトレインか(平均高度が閾値未満、かつ十分な群サイズ) */
export function isTrainGroup(records: GpRecord[]): boolean {
  if (records.length < MIN_TRAIN_GROUP_SIZE) return false;
  return averageAltitudeKm(records) < TRAIN_ALTITUDE_THRESHOLD_KM;
}

export interface TrainDetectionResult {
  /** objectId → groupId(トレイン群のみ) */
  trainObjectIds: Map<string, string>;
  /** groupId → 群のレコード(トレイン群のみ) */
  trainGroups: Map<string, GpRecord[]>;
}

/**
 * 全レコードから打ち上げ単位で群化し、トレインと推定される群だけを返す。
 * 「直近の打ち上げ(TRAIN_RECENCY_WINDOW)」かつ「低高度(isTrainGroup)」の両方を満たす
 * 群のみをトレインとする(高度だけでは恒久的に低いシェルを誤検出するため)。
 */
export function detectTrains(records: GpRecord[]): TrainDetectionResult {
  const groups = groupRecordsByLaunch(records);
  // OBJECT_ID の "YYYY-NNN" はゼロ埋めなので文字列降順 = 打ち上げ降順(新しい順)
  const recentGroupIds = new Set(
    [...groups.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, TRAIN_RECENCY_WINDOW),
  );
  const trainObjectIds = new Map<string, string>();
  const trainGroups = new Map<string, GpRecord[]>();
  for (const [groupId, groupRecords] of groups) {
    if (!recentGroupIds.has(groupId)) continue;
    if (!isTrainGroup(groupRecords)) continue;
    trainGroups.set(groupId, groupRecords);
    for (const rec of groupRecords) trainObjectIds.set(rec.OBJECT_ID, groupId);
  }
  return { trainObjectIds, trainGroups };
}

export type FirstSeenMap = Record<string, number>;

export const TRAIN_FIRST_SEEN_KEY = "starlink-watcher:train-first-seen:v1";

export function loadFirstSeenMap(): FirstSeenMap {
  const raw = safeGetItem(TRAIN_FIRST_SEEN_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: FirstSeenMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function saveFirstSeenMap(map: FirstSeenMap): boolean {
  return safeSetItem(TRAIN_FIRST_SEEN_KEY, JSON.stringify(map));
}

/** 経過日数(整数、切り捨て)。未検出なら null。時計巻き戻りは 0 に丸める */
export function daysSinceFirstSeen(
  groupId: string,
  firstSeenMap: FirstSeenMap,
  now: number,
): number | null {
  const seenAt = firstSeenMap[groupId];
  if (seenAt === undefined) return null;
  if (seenAt >= now) return 0;
  return Math.floor((now - seenAt) / 86_400_000);
}

export interface TrackFirstSeenResult {
  map: FirstSeenMap;
  /** 呼び出し時点(更新前)の状態を基準にした groupId ごとの経過日数。新規検出は null */
  daysById: Map<string, number | null>;
}

/**
 * groupIds の初回検出を記録する。経過日数は「この呼び出し前」の記録を基準に算出し
 * (今回新たに検出した群は null = 新規検出)、その後で今回分を永続化する。
 */
export function trackFirstSeen(groupIds: string[], now: number): TrackFirstSeenResult {
  const before = loadFirstSeenMap();
  const daysById = new Map<string, number | null>();
  for (const id of groupIds) {
    daysById.set(id, daysSinceFirstSeen(id, before, now));
  }
  const after: FirstSeenMap = { ...before };
  let changed = false;
  for (const id of groupIds) {
    if (!(id in after)) {
      after[id] = now;
      changed = true;
    }
  }
  if (changed) saveFirstSeenMap(after);
  return { map: after, daysById };
}

/**
 * detectTrains/trackFirstSeen の結果を objectId → TrainInfo のルックアップに変換する。
 * computeForecast に渡し、上位3件選抜(selectTopPasses)より前に明るさ補正・train付与を
 * 適用させる(選抜後に適用すると、補正前の明るさで落選したトレインが結果から欠落するため。
 * codex重大指摘対応)。
 */
export function buildTrainInfoMap(
  trainObjectIds: Map<string, string>,
  daysById: Map<string, number | null>,
): Map<string, TrainInfo> {
  const out = new Map<string, TrainInfo>();
  for (const [objectId, groupId] of trainObjectIds) {
    out.set(objectId, { groupId, daysSinceDetected: daysById.get(groupId) ?? null });
  }
  return out;
}

/**
 * キャッシュから復元した NightForecast[] の train.daysSinceDetected を現在時刻基準で
 * 更新する(明るさ・train有無は再計算しない。codex軽微指摘対応: キャッシュヒット時に
 * 「打ち上げからN日目」表示が保存時刻のまま古くなるのを防ぐ)。
 */
export function refreshTrainDays(nights: NightForecast[], now: number): NightForecast[] {
  const firstSeenMap = loadFirstSeenMap();
  return nights.map((night) => ({
    ...night,
    passes: night.passes.map((pass): VisiblePass => {
      if (!pass.train) return pass;
      const days = daysSinceFirstSeen(pass.train.groupId, firstSeenMap, now);
      if (days === pass.train.daysSinceDetected) return pass;
      return { ...pass, train: { ...pass.train, daysSinceDetected: days } };
    }),
  }));
}

/** TRAINバンドに表示する、最も早く訪れる今後のトレインパスを選ぶ(見つからなければ null) */
export function deriveTrainHighlight(
  nights: NightForecast[],
  now: Date,
): (VisiblePass & { train: TrainInfo }) | null {
  const nowMs = now.getTime();
  for (const night of nights) {
    const candidates = night.passes
      .filter(
        (p): p is VisiblePass & { train: TrainInfo } =>
          p.train !== undefined && p.maxTime.getTime() > nowMs,
      )
      .sort((a, b) => a.maxTime.getTime() - b.maxTime.getTime());
    if (candidates[0]) return candidates[0];
  }
  return null;
}
