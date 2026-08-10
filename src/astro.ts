// 天文計算層(S2): 太陽位置(satellite.js sunPos)・観測地の太陽高度(suncalc)・
// 衛星の地球影判定(satellite.js shadowFraction)・方位仰角変換・明るさ推定。
// 可視3条件(spec §3): 地平線上 / 太陽照射 / 観測地が薄明〜夜、のうち後2つをここで担う。
// suncalc v2 は度単位・北基準方位・UTC 入出力(v1 のラジアン・南基準から変更済み)。
import { getPosition } from "suncalc";
import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  radiansToDegrees,
  shadowFraction,
  sunPos,
  type EciVec3,
  type Kilometer,
} from "satellite.js";

export interface Observer {
  lat: number;
  lon: number;
  /** km。省略時 0(海抜) */
  heightKm?: number;
}

export interface LookAnglesDeg {
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
}

/** 明るさ3段階(D-012): 1 = ●○○(暗い)〜 3 = ●●●(明るい) */
export type Brightness = 1 | 2 | 3;

/** 観測地が「十分に暗い」太陽高度の上限(市民薄明終了、deg) */
export const NIGHT_SUN_ALT_MAX_DEG = -6;
/** shadowFraction がこの値未満なら「太陽光に照らされている」とみなす */
export const SHADOW_LIT_MAX_FRACTION = 0.5;
/** 明るさ較正: 運用高度の Starlink を天頂で見たときの距離と等級(spec §3 の約5等) */
export const OPS_REFERENCE_RANGE_KM = 550;
export const OPS_REFERENCE_MAGNITUDE = 5.0;
/** 等級→3段階の閾値(S4 のトレイン明るさ調整でも使うため定数化)。
 * MAG_TWO_DOTS_MAX は実データ較正済み(2026-08-10): 高度480〜550kmの運用衛星は
 * 天頂パスで mag 4.6〜4.7 になるため、4.5 でそれらを ●○○ 側に置く(spec §3)。 */
export const MAG_THREE_DOTS_MAX = 3.5;
export const MAG_TWO_DOTS_MAX = 4.5;

/** 太陽の ECI 位置(AU)。satellite.js shadowFraction の入力形式に合わせる */
export function sunEciAU(date: Date): EciVec3<number> {
  return sunPos(jday(date)).rsun;
}

/** 観測地から見た太陽高度(deg)。薄明判定に使う */
export function sunAltitudeDeg(date: Date, obs: Observer): number {
  return getPosition(date, obs.lat, obs.lon).altitude;
}

/** 衛星が太陽光に照らされているか(地球影の外か) */
export function isSunlit(
  satEciKm: EciVec3<Kilometer>,
  sunAU: EciVec3<number>,
): boolean {
  return shadowFraction(sunAU, satEciKm) < SHADOW_LIT_MAX_FRACTION;
}

/** 衛星 ECI 位置→観測地から見た方位・仰角・距離(deg / km) */
export function lookAnglesDeg(
  obs: Observer,
  satEciKm: EciVec3<Kilometer>,
  date: Date,
): LookAnglesDeg {
  const gmst = gstime(date);
  const satEcf = eciToEcf(satEciKm, gmst);
  const la = ecfToLookAngles(
    {
      latitude: degreesToRadians(obs.lat),
      longitude: degreesToRadians(obs.lon),
      height: obs.heightKm ?? 0,
    },
    satEcf,
  );
  let az = radiansToDegrees(la.azimuth) % 360;
  if (az < 0) az += 360;
  return {
    azimuthDeg: az,
    elevationDeg: radiansToDegrees(la.elevation),
    rangeKm: la.rangeSat,
  };
}

/** 距離から見かけ等級を概算(運用高度天頂 550km = 5.0 等で較正した目安。D-012) */
export function estimateMagnitude(rangeKm: number): number {
  return (
    OPS_REFERENCE_MAGNITUDE + 5 * Math.log10(rangeKm / OPS_REFERENCE_RANGE_KM)
  );
}

export function brightnessBucket(magnitude: number): Brightness {
  if (magnitude <= MAG_THREE_DOTS_MAX) return 3;
  if (magnitude <= MAG_TWO_DOTS_MAX) return 2;
  return 1;
}

const COMPASS8 = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"] as const;

/** 方位角(deg)→8方位の和名。セクタ境界は各方位の ±22.5deg */
export function azimuthToCompass8(azimuthDeg: number): string {
  const norm = ((azimuthDeg % 360) + 360) % 360;
  return COMPASS8[Math.floor(((norm + 22.5) % 360) / 45)];
}
