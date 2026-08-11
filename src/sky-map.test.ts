// sky-map.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
// The E/W orientation tests encode the S3 completion criterion: the chart is a
// "look-up" (planisphere) view — N up, E LEFT — not a map view.
import { describe, expect, it } from "vitest";
import {
  SKY_CX,
  SKY_CY,
  SKY_HORIZON_R,
  azElToPoint,
  elevationRingRadius,
  passArcPath,
  passArcPoint,
  trainDotPoints,
} from "./sky-map.ts";

describe("elevationRingRadius", () => {
  it("maps the horizon (0 deg) to the outer ring radius", () => {
    expect(elevationRingRadius(0)).toBeCloseTo(SKY_HORIZON_R, 5);
  });

  it("maps 30 deg to 2/3 of the outer radius (review.html: 56.7)", () => {
    expect(elevationRingRadius(30)).toBeCloseTo((SKY_HORIZON_R * 2) / 3, 5);
    expect(elevationRingRadius(30)).toBeCloseTo(56.7, 1);
  });

  it("maps 60 deg to 1/3 of the outer radius (review.html: 28.3)", () => {
    expect(elevationRingRadius(60)).toBeCloseTo(SKY_HORIZON_R / 3, 5);
    expect(elevationRingRadius(60)).toBeCloseTo(28.3, 1);
  });

  it("maps the zenith (90 deg) to the center", () => {
    expect(elevationRingRadius(90)).toBeCloseTo(0, 5);
  });
});

describe("azElToPoint (planisphere orientation: N up, E LEFT)", () => {
  it("puts North (az 0) at the top", () => {
    const p = azElToPoint(0, 0);
    expect(p.x).toBeCloseTo(SKY_CX, 5);
    expect(p.y).toBeCloseTo(SKY_CY - SKY_HORIZON_R, 5);
  });

  it("puts East (az 90) on the LEFT - the sky view, not the map view", () => {
    const p = azElToPoint(90, 0);
    expect(p.x).toBeCloseTo(SKY_CX - SKY_HORIZON_R, 5);
    expect(p.y).toBeCloseTo(SKY_CY, 5);
  });

  it("puts South (az 180) at the bottom", () => {
    const p = azElToPoint(180, 0);
    expect(p.x).toBeCloseTo(SKY_CX, 5);
    expect(p.y).toBeCloseTo(SKY_CY + SKY_HORIZON_R, 5);
  });

  it("puts West (az 270) on the RIGHT", () => {
    const p = azElToPoint(270, 0);
    expect(p.x).toBeCloseTo(SKY_CX + SKY_HORIZON_R, 5);
    expect(p.y).toBeCloseTo(SKY_CY, 5);
  });

  it("maps the zenith to the center regardless of azimuth", () => {
    const p = azElToPoint(123.4, 90);
    expect(p.x).toBeCloseTo(SKY_CX, 5);
    expect(p.y).toBeCloseTo(SKY_CY, 5);
  });

  it("uses the ring scale for intermediate elevations", () => {
    const p = azElToPoint(0, 30);
    expect(p.y).toBeCloseTo(SKY_CY - (SKY_HORIZON_R * 2) / 3, 5);
  });

  it("normalizes azimuths outside 0-360", () => {
    const a = azElToPoint(450, 10);
    const b = azElToPoint(90, 10);
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
    const c = azElToPoint(-90, 10);
    const d = azElToPoint(270, 10);
    expect(c.x).toBeCloseTo(d.x, 5);
    expect(c.y).toBeCloseTo(d.y, 5);
  });
});

describe("passArcPath", () => {
  function parseArc(d: string): {
    x0: number;
    y0: number;
    qx: number;
    qy: number;
    x1: number;
    y1: number;
  } {
    const m = d.match(
      /^M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/,
    );
    expect(m, `unexpected path format: ${d}`).not.toBeNull();
    const n = m!.slice(1).map(Number);
    return { x0: n[0], y0: n[1], qx: n[2], qy: n[3], x1: n[4], y1: n[5] };
  }

  const start = { azDeg: 225, elDeg: 0 };
  const max = { azDeg: 180, elDeg: 42 };
  const end = { azDeg: 135, elDeg: 0 };

  it("starts and ends at the transformed start/end points", () => {
    const a = parseArc(passArcPath(start, max, end));
    const p0 = azElToPoint(start.azDeg, start.elDeg);
    const p1 = azElToPoint(end.azDeg, end.elDeg);
    expect(a.x0).toBeCloseTo(p0.x, 1);
    expect(a.y0).toBeCloseTo(p0.y, 1);
    expect(a.x1).toBeCloseTo(p1.x, 1);
    expect(a.y1).toBeCloseTo(p1.y, 1);
  });

  it("passes through the max-elevation point at t=0.5", () => {
    const a = parseArc(passArcPath(start, max, end));
    // B(0.5) = 0.25*P0 + 0.5*Q + 0.25*P1
    const midX = 0.25 * a.x0 + 0.5 * a.qx + 0.25 * a.x1;
    const midY = 0.25 * a.y0 + 0.5 * a.qy + 0.25 * a.y1;
    const pm = azElToPoint(max.azDeg, max.elDeg);
    expect(midX).toBeCloseTo(pm.x, 1);
    expect(midY).toBeCloseTo(pm.y, 1);
  });

  it("keeps a SW rise on the right half of the chart (no E-W mirror)", () => {
    // 南西から昇り南東へ沈むパス: 見上げ図では南西=右下、南東=左下に出る
    const a = parseArc(passArcPath(start, max, end));
    expect(a.x0).toBeGreaterThan(SKY_CX); // SW start on the right
    expect(a.x1).toBeLessThan(SKY_CX); // SE end on the left
    expect(a.y0).toBeGreaterThan(SKY_CY); // both below center (southern sky)
  });
});

describe("passArcPoint (S4: train dot placement)", () => {
  const start = { azDeg: 225, elDeg: 0 };
  const max = { azDeg: 180, elDeg: 42 };
  const end = { azDeg: 135, elDeg: 0 };

  it("matches the start/end points at t=0 and t=1", () => {
    const p0 = azElToPoint(start.azDeg, start.elDeg);
    const p1 = azElToPoint(end.azDeg, end.elDeg);
    const atStart = passArcPoint(0, start, max, end);
    const atEnd = passArcPoint(1, start, max, end);
    expect(atStart.x).toBeCloseTo(p0.x, 5);
    expect(atStart.y).toBeCloseTo(p0.y, 5);
    expect(atEnd.x).toBeCloseTo(p1.x, 5);
    expect(atEnd.y).toBeCloseTo(p1.y, 5);
  });

  it("matches the max-elevation point at t=0.5 (consistent with passArcPath)", () => {
    const pm = azElToPoint(max.azDeg, max.elDeg);
    const atMid = passArcPoint(0.5, start, max, end);
    expect(atMid.x).toBeCloseTo(pm.x, 1);
    expect(atMid.y).toBeCloseTo(pm.y, 1);
  });
});

describe("trainDotPoints (S4: equally-spaced dot chain)", () => {
  const start = { azDeg: 225, elDeg: 0 };
  const max = { azDeg: 180, elDeg: 42 };
  const end = { azDeg: 135, elDeg: 0 };

  it("returns an empty array for count 0", () => {
    expect(trainDotPoints(start, max, end, 0)).toEqual([]);
  });

  it("returns the max-elevation point for count 1", () => {
    const pts = trainDotPoints(start, max, end, 1);
    const pm = azElToPoint(max.azDeg, max.elDeg);
    expect(pts).toHaveLength(1);
    expect(pts[0].x).toBeCloseTo(pm.x, 1);
    expect(pts[0].y).toBeCloseTo(pm.y, 1);
  });

  it("includes both endpoints and is evenly spaced in t for count >= 2", () => {
    const pts = trainDotPoints(start, max, end, 5);
    expect(pts).toHaveLength(5);
    const p0 = azElToPoint(start.azDeg, start.elDeg);
    const p1 = azElToPoint(end.azDeg, end.elDeg);
    expect(pts[0].x).toBeCloseTo(p0.x, 5);
    expect(pts[0].y).toBeCloseTo(p0.y, 5);
    expect(pts[4].x).toBeCloseTo(p1.x, 5);
    expect(pts[4].y).toBeCloseTo(p1.y, 5);
    // t=0.5 (index 2 of 5) を通過することも確認
    expect(pts[2].x).toBeCloseTo(passArcPoint(0.5, start, max, end).x, 5);
  });
});
