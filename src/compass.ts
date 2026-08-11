// コンパス連動層(新画面): 方位センサーの許可・購読(DOM配線)と、方位・仰角の
// 正規化/目標とのズレ計算/整合判定(純粋関数)を分離する。
// iOS Safari は DeviceOrientationEvent.requestPermission() のユーザー操作起点の許可が必要。
// 方位は webkitCompassHeading(iOS, 磁北基準)を優先し、無ければ absolute な alpha から概算する。
// 磁北→真北の偏角補正は行わない(既知の制約、work-kickoff フェーズ1で承認済み)。
// 仰角は縦持ち・上端を空に向ける持ち方を前提に beta から概算する(実機未検証)。

export type OrientationPermission = "granted" | "denied" | "unsupported";

export interface OrientationSample {
  headingDeg: number | null;
  elevationDeg: number | null;
}

export interface AimTarget {
  azDeg: number;
  elDeg: number;
}

export interface AimDevice {
  headingDeg: number;
  elevationDeg: number;
}

export interface AimState {
  /** target - device の符号付き最短差分(-180, 180]。正=右に回す、負=左に回す */
  headingDeltaDeg: number;
  /** target - device(deg)。正=もっと上を向く、負=もっと下を向く */
  elevationDeltaDeg: number;
}

/** 整合(狙えている)とみなす許容誤差(度)。方位・仰角の両方がこの範囲内なら整合とする */
export const ALIGN_TOLERANCE_DEG = 10;

/** 任意の角度を [0, 360) に正規化する */
export function normalizeHeadingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** target - current の符号付き最短差分(-180, 180]。正=時計回り(右)、負=反時計回り(左) */
export function headingDeltaDeg(targetDeg: number, currentDeg: number): number {
  const raw = targetDeg - currentDeg;
  return (((raw % 360) + 540) % 360) - 180;
}

/**
 * 端末の傾き(beta, -180〜180)から見上げ角(仰角相当)を概算する。
 * 縦持ち・上端を空に向ける持ち方を前提(beta=90で地平線=0°、beta=0で天頂=90°)。
 * 実機での式の妥当性は未検証(work-kickoff フェーズ3のリスクとして明記済み)。
 */
export function pitchToElevationDeg(betaDeg: number): number {
  return Math.max(-90, Math.min(90, 90 - betaDeg));
}

/** 目標(衛星)と端末の向きの差分をまとめる */
export function computeAim(target: AimTarget, device: AimDevice): AimState {
  return {
    headingDeltaDeg: headingDeltaDeg(target.azDeg, device.headingDeg),
    elevationDeltaDeg: target.elDeg - device.elevationDeg,
  };
}

/** 方位・仰角のズレが両方とも許容誤差内なら整合(狙えている)とみなす */
export function isAligned(aim: AimState, toleranceDeg: number = ALIGN_TOLERANCE_DEG): boolean {
  return Math.abs(aim.headingDeltaDeg) <= toleranceDeg && Math.abs(aim.elevationDeltaDeg) <= toleranceDeg;
}

/**
 * DeviceOrientationEvent から方位(deg)を取り出す。
 * iOS の webkitCompassHeading(磁北基準、較正済み)を優先し、無ければ absolute な alpha
 * (360-alphaで時計回りの方位相当に変換)にフォールバックする。どちらも無ければ null。
 */
export function extractHeadingDeg(event: {
  webkitCompassHeading?: number;
  alpha?: number | null;
  absolute?: boolean;
}): number | null {
  const w = event.webkitCompassHeading;
  if (typeof w === "number" && Number.isFinite(w)) return w;
  if (event.absolute === true && typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
    return normalizeHeadingDeg(360 - event.alpha);
  }
  return null;
}

/** DeviceOrientationEvent から仰角相当(deg)を取り出す(beta が無ければ null) */
export function extractElevationDeg(event: { beta?: number | null }): number | null {
  const b = event.beta;
  if (typeof b !== "number" || !Number.isFinite(b)) return null;
  return pitchToElevationDeg(b);
}

interface RequestPermissionCapable {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/**
 * iOSのDeviceOrientationEvent.requestPermission()を呼ぶ(ユーザー操作起点で呼ぶ必要がある)。
 * requestPermission自体が無い環境(Android等)は許可ゲートが無いものとして"granted"扱いにする。
 * APIが存在しない環境(非対応ブラウザ・非HTTPS等)は"unsupported"を返す。
 */
export async function requestOrientationPermission(
  DOE: RequestPermissionCapable | undefined = (
    globalThis as { DeviceOrientationEvent?: RequestPermissionCapable }
  ).DeviceOrientationEvent,
): Promise<OrientationPermission> {
  if (!DOE) return "unsupported";
  if (typeof DOE.requestPermission !== "function") return "granted";
  try {
    const result = await DOE.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/** "deviceorientation" イベントを購読し、方位・仰角を onSample へ通知する。戻り値で購読解除できる */
export function subscribeOrientation(
  onSample: (sample: OrientationSample) => void,
  target: EventTarget | undefined = globalThis.window,
): () => void {
  const handler = (event: Event): void => {
    const e = event as unknown as {
      webkitCompassHeading?: number;
      alpha?: number | null;
      absolute?: boolean;
      beta?: number | null;
    };
    onSample({
      headingDeg: extractHeadingDeg(e),
      elevationDeg: extractElevationDeg(e),
    });
  };
  target?.addEventListener("deviceorientation", handler);
  return () => target?.removeEventListener("deviceorientation", handler);
}
