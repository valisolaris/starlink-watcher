// astro.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { describe, expect, it } from "vitest";
import {
  degreesToRadians,
  ecfToEci,
  geodeticToEcf,
  gstime,
} from "satellite.js";
import {
  azimuthToCompass8,
  brightnessBucket,
  estimateMagnitude,
  isSunlit,
  lookAnglesDeg,
  sunAltitudeDeg,
  sunEciAU,
  MAG_THREE_DOTS_MAX,
  MAG_TWO_DOTS_MAX,
} from "./astro.ts";

const TOKYO = { lat: 35.68, lon: 139.69 };

function declinationDeg(v: { x: number; y: number; z: number }): number {
  const r = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return (Math.asin(v.z / r) * 180) / Math.PI;
}

describe("sunEciAU", () => {
  it("has near-zero declination at the March 2026 equinox", () => {
    const sun = sunEciAU(new Date("2026-03-20T15:00:00Z"));
    expect(Math.abs(declinationDeg(sun))).toBeLessThan(0.7);
    // 春分点方向 = ECI +x 側
    expect(sun.x).toBeGreaterThan(0);
  });

  it("has declination near +23.4 deg at the June 2026 solstice", () => {
    const sun = sunEciAU(new Date("2026-06-21T08:00:00Z"));
    expect(declinationDeg(sun)).toBeGreaterThan(23.0);
    expect(declinationDeg(sun)).toBeLessThan(23.8);
  });

  it("returns a distance near 1 AU", () => {
    const sun = sunEciAU(new Date("2026-08-10T00:00:00Z"));
    const r = Math.sqrt(sun.x * sun.x + sun.y * sun.y + sun.z * sun.z);
    expect(r).toBeGreaterThan(0.95);
    expect(r).toBeLessThan(1.05);
  });
});

describe("sunAltitudeDeg (Tokyo, 2026-08-10)", () => {
  it("is high at local noon", () => {
    // 12:00 JST = 03:00 UTC
    expect(sunAltitudeDeg(new Date("2026-08-10T03:00:00Z"), TOKYO)).toBeGreaterThan(55);
  });

  it("is deeply negative at local midnight", () => {
    // 00:00 JST = 前日15:00 UTC
    expect(sunAltitudeDeg(new Date("2026-08-09T15:00:00Z"), TOKYO)).toBeLessThan(-30);
  });

  it("is above horizon before sunset and below after dusk", () => {
    // 東京の日没は 18:38 JST ごろ
    expect(sunAltitudeDeg(new Date("2026-08-10T09:00:00Z"), TOKYO)).toBeGreaterThan(0);
    expect(sunAltitudeDeg(new Date("2026-08-10T10:30:00Z"), TOKYO)).toBeLessThan(0);
  });
});

describe("isSunlit", () => {
  const sun = { x: 1, y: 0, z: 0 }; // 太陽が +x 方向 1AU

  it("is true for a satellite on the sun side", () => {
    expect(isSunlit({ x: 7000, y: 0, z: 0 }, sun)).toBe(true);
  });

  it("is false for a satellite behind the Earth on the shadow axis", () => {
    expect(isSunlit({ x: -7000, y: 0, z: 0 }, sun)).toBe(false);
  });

  it("is true for a satellite offset from the shadow cylinder", () => {
    expect(isSunlit({ x: -7000, y: 7000, z: 0 }, sun)).toBe(true);
  });
});

describe("lookAnglesDeg", () => {
  const date = new Date("2026-08-10T12:00:00Z");

  it("reports near-90 elevation for a satellite directly overhead", () => {
    const gmst = gstime(date);
    const obsEcf = geodeticToEcf({
      latitude: 0,
      longitude: degreesToRadians(139.69),
      height: 0,
    });
    // 赤道上では地心方向 = 鉛直方向なので、半径方向へ +550km 伸ばせば真上になる
    const factor = (6378.137 + 550) / 6378.137;
    const satEci = ecfToEci(
      { x: obsEcf.x * factor, y: obsEcf.y * factor, z: obsEcf.z * factor },
      gmst,
    );
    const la = lookAnglesDeg({ lat: 0, lon: 139.69 }, satEci, date);
    expect(la.elevationDeg).toBeGreaterThan(85);
    expect(la.rangeKm).toBeGreaterThan(500);
    expect(la.rangeKm).toBeLessThan(600);
  });

  it("reports north azimuth for a satellite due north of the observer", () => {
    const gmst = gstime(date);
    const satEcf = geodeticToEcf({
      latitude: degreesToRadians(10),
      longitude: degreesToRadians(139.69),
      height: 550,
    });
    const satEci = ecfToEci(satEcf, gmst);
    const la = lookAnglesDeg({ lat: 0, lon: 139.69 }, satEci, date);
    const azDist = Math.min(la.azimuthDeg, 360 - la.azimuthDeg);
    expect(azDist).toBeLessThan(3);
    expect(la.elevationDeg).toBeGreaterThan(15);
    expect(la.elevationDeg).toBeLessThan(25);
  });
});

describe("estimateMagnitude", () => {
  it("matches the calibration point at 550 km", () => {
    expect(estimateMagnitude(550)).toBeCloseTo(5.0, 2);
  });

  it("is about 1.5 mag dimmer at double the range", () => {
    expect(estimateMagnitude(1100)).toBeCloseTo(6.5, 1);
  });

  it("is brighter (smaller) at closer range", () => {
    expect(estimateMagnitude(300)).toBeLessThan(estimateMagnitude(550));
  });
});

describe("brightnessBucket", () => {
  it("maps bright magnitudes to 3 dots", () => {
    expect(brightnessBucket(3.0)).toBe(3);
    expect(brightnessBucket(MAG_THREE_DOTS_MAX)).toBe(3);
  });

  it("maps medium magnitudes to 2 dots", () => {
    expect(brightnessBucket(4.0)).toBe(2);
    expect(brightnessBucket(MAG_TWO_DOTS_MAX)).toBe(2);
  });

  it("maps dim magnitudes to 1 dot", () => {
    expect(brightnessBucket(5.0)).toBe(1);
    expect(brightnessBucket(7.0)).toBe(1);
  });

  it("treats operational-shell zenith passes (mag ~4.7) as dim", () => {
    // 較正の凍結: 高度480〜550kmの運用衛星は天頂パスでも ●○○(spec §3「肉眼困難」)。
    // 実データ検証(2026-08-10)で mag 4.7 のパスが毎晩発生し verdict が常時「見えます」に
    // なったため、閾値を 4.5 に較正した。
    expect(brightnessBucket(4.7)).toBe(1);
    expect(brightnessBucket(4.5)).toBe(2);
  });
});

describe("azimuthToCompass8", () => {
  it("maps cardinal and intercardinal directions", () => {
    expect(azimuthToCompass8(0)).toBe("北");
    expect(azimuthToCompass8(45)).toBe("北東");
    expect(azimuthToCompass8(90)).toBe("東");
    expect(azimuthToCompass8(135)).toBe("南東");
    expect(azimuthToCompass8(180)).toBe("南");
    expect(azimuthToCompass8(225)).toBe("南西");
    expect(azimuthToCompass8(270)).toBe("西");
    expect(azimuthToCompass8(315)).toBe("北西");
  });

  it("uses sector boundaries at +/-22.5 deg", () => {
    expect(azimuthToCompass8(22.4)).toBe("北");
    expect(azimuthToCompass8(22.5)).toBe("北東");
    expect(azimuthToCompass8(337.5)).toBe("北");
    expect(azimuthToCompass8(359.9)).toBe("北");
  });
});
