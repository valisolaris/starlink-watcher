// 方位図の座標変換層(S3): 方位角・仰角→極座標 SVG 座標の純粋関数。DOM 非依存。
// 向きは早見盤流儀(北上・東左・南下・西右)= 空を見上げた向きの図(フェーズ1でユーザー決定)。
// review.html のモックは東右(地図流儀)だが、E/W 配置のみ本流儀を優先する。
// リング半径比率・ベジェ弧の構成(3点を通る2次ベジェ)は review.html の実装値を踏襲する。

/** SVG viewBox は "0 0 200 200"(review.html 準拠) */
export const SKY_CX = 100;
export const SKY_CY = 100;
/** 外周(地平線)の半径 */
export const SKY_HORIZON_R = 85;

export interface SkyPoint {
  x: number;
  y: number;
}

export interface AzEl {
  azDeg: number;
  elDeg: number;
}

/** 仰角(deg)→同心円リング半径。0°=外周 85、90°(天頂)=0 */
export function elevationRingRadius(elDeg: number): number {
  return (SKY_HORIZON_R * (90 - elDeg)) / 90;
}

/** 方位角・仰角(deg)→SVG 座標。北上・東左(早見盤流儀)。方位角は 0-360 外も正規化する */
export function azElToPoint(azDeg: number, elDeg: number): SkyPoint {
  const r = elevationRingRadius(elDeg);
  const azRad = ((((azDeg % 360) + 360) % 360) * Math.PI) / 180;
  // 東左の鏡像: x は - sin(az)。北上: y は - cos(az)
  return {
    x: SKY_CX - r * Math.sin(azRad),
    y: SKY_CY - r * Math.cos(azRad),
  };
}

/** SVG 属性向けの丸め(小数2桁) */
export function svgRound(n: number): number {
  return Math.round(n * 100) / 100;
}

interface BezierControlPoints {
  p0: SkyPoint;
  q: SkyPoint;
  p1: SkyPoint;
}

/** 開始・最大仰角・終了の3点から2次ベジェの制御点を作る(passArcPath/passArcPoint 共用) */
function bezierControlPoints(start: AzEl, max: AzEl, end: AzEl): BezierControlPoints {
  const p0 = azElToPoint(start.azDeg, start.elDeg);
  const pm = azElToPoint(max.azDeg, max.elDeg);
  const p1 = azElToPoint(end.azDeg, end.elDeg);
  // B(0.5) = pm となる制御点: Q = 2M − (P0+P1)/2(review.html と同じ構成)
  const qx = 2 * pm.x - (p0.x + p1.x) / 2;
  const qy = 2 * pm.y - (p0.y + p1.y) / 2;
  return { p0, q: { x: qx, y: qy }, p1 };
}

/** 開始→最大仰角→終了の3点を通る2次ベジェの path d 文字列(t=0.5 で最大点を通過) */
export function passArcPath(start: AzEl, max: AzEl, end: AzEl): string {
  const { p0, q, p1 } = bezierControlPoints(start, max, end);
  return `M ${svgRound(p0.x)} ${svgRound(p0.y)} Q ${svgRound(q.x)} ${svgRound(q.y)} ${svgRound(p1.x)} ${svgRound(p1.y)}`;
}

/** ベジェ曲線上の位置(t: 0=開始, 0.5=最大仰角, 1=終了)。passArcPath と同じ制御点構成 */
export function passArcPoint(t: number, start: AzEl, max: AzEl, end: AzEl): SkyPoint {
  const { p0, q, p1 } = bezierControlPoints(start, max, end);
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * q.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * q.y + t * t * p1.y,
  };
}

/**
 * 弧上のドット列(S4: トレイン表示、design-brief「弧上の等間隔ドット列」の様式的表現)。
 * count>=2 は両端(t=0,1)を含め、ベジェのパラメータ t を等分する(画面上の弧長ではない。
 * 二次ベジェでは t の等分と弧長の等分は一般に一致しないが、装飾目的のため許容する。
 * codex軽微指摘対応)。count===1 は最大仰角点(t=0.5)のみ。
 */
export function trainDotPoints(
  start: AzEl,
  max: AzEl,
  end: AzEl,
  count: number,
): SkyPoint[] {
  if (count <= 0) return [];
  if (count === 1) return [passArcPoint(0.5, start, max, end)];
  const points: SkyPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(passArcPoint(i / (count - 1), start, max, end));
  }
  return points;
}
