// コンパス画面の描画層(新画面): 方位図(sky-map.ts を流用)に目標(衛星)と端末の向きを重ねる。
// 整合(狙えている)状態の強調は新しい色を使わず、モノクロ内(枠→塗りつぶし)で表現する
// (decisions.md D-009: --accent の用途は verdict時刻・可視バッジ・方位図最大仰角の3箇所に限定済み。
// この新画面ではそれを増やさない)。
import { azimuthToCompass8 } from "./astro.ts";
import {
  computeAim,
  isAligned,
  type AimDevice,
  type AimState,
  type AimTarget,
  type OrientationPermission,
} from "./compass.ts";
import { azElToPoint, skyDialChromeSvg, svgRound } from "./sky-map.ts";

export interface CompassTarget extends AimTarget {
  satName: string;
  /** true = 現在時刻でのライブ位置(可視時間帯中)、false = 静的な目標(最大仰角点等) */
  live: boolean;
}

export interface CompassDeviceState {
  permission: OrientationPermission | "unrequested";
  device: AimDevice | null;
}

export const COMPASS_UI_STRINGS = {
  emptyCopy: "予報リストからパスを選ぶと、ここにコンパスが表示されます",
  requestPermission: "方位センサーへのアクセスを許可",
  permissionDenied: "方位センサーへのアクセスが許可されていません",
  permissionUnsupported: "この端末・ブラウザは方位センサーに対応していません",
  waitingSensor: "端末の向きを取得中…",
  liveLabel: "現在位置(ライブ)",
  targetLabel: "目標(最大仰角時)",
  alignedCopy: "この向きで合っています",
  headingReadoutLabel: "今向いている方位",
  elevationReadoutLabel: "見上げている高さ",
} as const;

export function renderCompassEmpty(container: HTMLElement): void {
  container.innerHTML = `<p class="empty-copy" data-compass-empty>${COMPASS_UI_STRINGS.emptyCopy}</p>`;
}

/** マーカー表示用に仰角を可視範囲へ丸める(数値表示は生の値、マーカー位置のみ丸める) */
function clampElForMarker(elDeg: number): number {
  return Math.max(0, Math.min(90, elDeg));
}

function targetCaptionHtml(target: CompassTarget): string {
  const label = target.live ? COMPASS_UI_STRINGS.liveLabel : COMPASS_UI_STRINGS.targetLabel;
  return `
    <p class="skychart-caption compass-target-caption">
      ${target.satName} / ${label}<br/>
      ${azimuthToCompass8(target.azDeg)}(${Math.round(target.azDeg)}°) / 仰角 <b>${Math.round(target.elDeg)}°</b>
    </p>`;
}

function dialHtml(target: CompassTarget, device: AimDevice | null, aligned: boolean): string {
  const tp = azElToPoint(target.azDeg, clampElForMarker(target.elDeg));
  const deviceMarker = device
    ? (() => {
        const dp = azElToPoint(device.headingDeg, clampElForMarker(device.elevationDeg));
        return `<circle data-device-marker class="compass-device-marker${aligned ? " is-aligned" : ""}" cx="${svgRound(dp.x)}" cy="${svgRound(dp.y)}" r="7"/>`;
      })()
    : "";
  return `
    <svg class="compass-svg" viewBox="0 0 200 200" role="img" aria-label="コンパス盤。北が上、東が左の見上げ図。">
      ${skyDialChromeSvg()}
      <circle data-target-marker class="compass-target-marker" cx="${svgRound(tp.x)}" cy="${svgRound(tp.y)}" r="5"/>
      ${deviceMarker}
    </svg>`;
}

/** aim(computeAimの結果)は呼び出し側(renderCompass)で1回だけ計算したものを受け取る */
function readoutHtml(device: AimDevice, aim: AimState, aligned: boolean): string {
  const alignedNote = aligned
    ? `<p class="compass-aligned" data-aligned>${COMPASS_UI_STRINGS.alignedCopy}</p>`
    : `<p class="compass-delta">${COMPASS_UI_STRINGS.headingReadoutLabel} <b>${Math.round(device.headingDeg)}°</b>(ズレ ${Math.round(aim.headingDeltaDeg)}°) / ${COMPASS_UI_STRINGS.elevationReadoutLabel} <b>${Math.round(device.elevationDeg)}°</b>(ズレ ${Math.round(aim.elevationDeltaDeg)}°)</p>`;
  return `<div class="compass-readout">${alignedNote}</div>`;
}

/** permission/device の状態ごとに本文(compass-view-innerの中身)だけを組み立てる */
function bodyHtml(target: CompassTarget, deviceState: CompassDeviceState): string {
  const { permission, device } = deviceState;

  if (permission === "unrequested") {
    return `<div class="compass-permission"><button class="btn btn-fill" type="button" data-request-permission>${COMPASS_UI_STRINGS.requestPermission}</button></div>`;
  }
  if (permission === "denied") {
    return `<p class="status is-error">${COMPASS_UI_STRINGS.permissionDenied}</p>`;
  }
  if (permission === "unsupported") {
    return `<p class="status is-error">${COMPASS_UI_STRINGS.permissionUnsupported}</p>`;
  }
  // permission === "granted"
  if (device === null) {
    return `<p class="status">${COMPASS_UI_STRINGS.waitingSensor}</p>`;
  }
  const aim = computeAim(target, device);
  const aligned = isAligned(aim);
  return `${dialHtml(target, device, aligned)}${readoutHtml(device, aim, aligned)}`;
}

export function renderCompass(
  container: HTMLElement,
  target: CompassTarget,
  deviceState: CompassDeviceState,
  onRequestPermission: () => void,
): void {
  container.innerHTML = `
    <div class="compass-view-inner">
      ${targetCaptionHtml(target)}
      ${bodyHtml(target, deviceState)}
    </div>`;
  container
    .querySelector<HTMLButtonElement>("[data-request-permission]")
    ?.addEventListener("click", onRequestPermission);
}
