// compass.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { describe, expect, it, vi } from "vitest";
import {
  ALIGN_TOLERANCE_DEG,
  computeAim,
  extractElevationDeg,
  extractHeadingDeg,
  headingDeltaDeg,
  isAligned,
  normalizeHeadingDeg,
  pitchToElevationDeg,
  requestOrientationPermission,
  subscribeOrientation,
} from "./compass.ts";

describe("normalizeHeadingDeg", () => {
  it("wraps values above 360 back into [0, 360)", () => {
    expect(normalizeHeadingDeg(370)).toBeCloseTo(10);
  });
  it("wraps negative values into [0, 360)", () => {
    expect(normalizeHeadingDeg(-10)).toBeCloseTo(350);
  });
  it("leaves in-range values unchanged", () => {
    expect(normalizeHeadingDeg(180)).toBeCloseTo(180);
  });
});

describe("headingDeltaDeg", () => {
  it("returns a small positive delta when target is clockwise of current", () => {
    expect(headingDeltaDeg(90, 80)).toBeCloseTo(10);
  });
  it("returns a small negative delta when target is counter-clockwise of current", () => {
    expect(headingDeltaDeg(80, 90)).toBeCloseTo(-10);
  });
  it("wraps around 0/360 correctly (target just past north, current just before)", () => {
    expect(headingDeltaDeg(10, 350)).toBeCloseTo(20);
  });
  it("wraps around 0/360 correctly the other direction", () => {
    expect(headingDeltaDeg(350, 10)).toBeCloseTo(-20);
  });
  it("returns ~0 when target and current match", () => {
    expect(headingDeltaDeg(123, 123)).toBeCloseTo(0);
  });
});

describe("pitchToElevationDeg", () => {
  it("maps a vertical device (beta=90) to the horizon (0 deg)", () => {
    expect(pitchToElevationDeg(90)).toBeCloseTo(0);
  });
  it("maps beta=0 to straight up, clamped to 90 deg", () => {
    expect(pitchToElevationDeg(0)).toBeCloseTo(90);
  });
  it("clamps values beyond the valid range to -90", () => {
    expect(pitchToElevationDeg(200)).toBeCloseTo(-90);
  });
});

describe("computeAim", () => {
  it("combines heading and elevation deltas", () => {
    const aim = computeAim({ azDeg: 100, elDeg: 40 }, { headingDeg: 90, elevationDeg: 30 });
    expect(aim.headingDeltaDeg).toBeCloseTo(10);
    expect(aim.elevationDeltaDeg).toBeCloseTo(10);
  });
});

describe("isAligned", () => {
  it("is true when both deltas are within tolerance", () => {
    expect(isAligned({ headingDeltaDeg: 5, elevationDeltaDeg: -5 })).toBe(true);
  });
  it("is false when heading delta exceeds tolerance", () => {
    expect(isAligned({ headingDeltaDeg: ALIGN_TOLERANCE_DEG + 1, elevationDeltaDeg: 0 })).toBe(
      false,
    );
  });
  it("is false when elevation delta exceeds tolerance", () => {
    expect(isAligned({ headingDeltaDeg: 0, elevationDeltaDeg: ALIGN_TOLERANCE_DEG + 1 })).toBe(
      false,
    );
  });
  it("respects a custom tolerance", () => {
    expect(isAligned({ headingDeltaDeg: 15, elevationDeltaDeg: 15 }, 20)).toBe(true);
  });
});

describe("extractHeadingDeg", () => {
  it("prefers webkitCompassHeading (iOS, magnetic-north based) when present", () => {
    expect(extractHeadingDeg({ webkitCompassHeading: 42 })).toBeCloseTo(42);
  });
  it("falls back to absolute alpha when webkitCompassHeading is absent", () => {
    // alpha=100, absolute=true -> heading = normalize(360 - 100) = 260
    expect(extractHeadingDeg({ alpha: 100, absolute: true })).toBeCloseTo(260);
  });
  it("returns null when alpha is not absolute and no webkitCompassHeading", () => {
    expect(extractHeadingDeg({ alpha: 100, absolute: false })).toBeNull();
  });
  it("returns null when no usable field is present", () => {
    expect(extractHeadingDeg({})).toBeNull();
  });
});

describe("extractElevationDeg", () => {
  it("derives elevation from beta via pitchToElevationDeg", () => {
    expect(extractElevationDeg({ beta: 90 })).toBeCloseTo(0);
  });
  it("returns null when beta is missing", () => {
    expect(extractElevationDeg({})).toBeNull();
  });
  it("returns null when beta is null", () => {
    expect(extractElevationDeg({ beta: null })).toBeNull();
  });
});

describe("requestOrientationPermission", () => {
  it("returns unsupported when DeviceOrientationEvent is unavailable", async () => {
    // jsdomはrequestPermission無しのDeviceOrientationEventを実在させるため、
    // 明示的なundefined渡し(デフォルト引数では回避できない)ではなくグローバル自体を不在にして検証する
    vi.stubGlobal("DeviceOrientationEvent", undefined);
    expect(await requestOrientationPermission()).toBe("unsupported");
    vi.unstubAllGlobals();
  });
  it("returns granted when the environment has no requestPermission gate (e.g. Android)", async () => {
    expect(await requestOrientationPermission({})).toBe("granted");
  });
  it("returns granted when requestPermission resolves granted (iOS, user allowed)", async () => {
    expect(
      await requestOrientationPermission({ requestPermission: async () => "granted" }),
    ).toBe("granted");
  });
  it("returns denied when requestPermission resolves denied (iOS, user declined)", async () => {
    expect(await requestOrientationPermission({ requestPermission: async () => "denied" })).toBe(
      "denied",
    );
  });
  it("returns denied when requestPermission rejects", async () => {
    expect(
      await requestOrientationPermission({
        requestPermission: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe("denied");
  });
});

describe("subscribeOrientation", () => {
  function makeFakeTarget() {
    const listeners = new Map<string, EventListener>();
    return {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
      dispatchEvent: vi.fn(),
      emit(type: string, event: unknown) {
        listeners.get(type)?.(event as Event);
      },
    };
  }

  it("invokes onSample with heading/elevation extracted from deviceorientation events", () => {
    const target = makeFakeTarget();
    const samples: Array<{ headingDeg: number | null; elevationDeg: number | null }> = [];
    subscribeOrientation((s) => samples.push(s), target as unknown as EventTarget);
    expect(target.addEventListener).toHaveBeenCalledWith(
      "deviceorientation",
      expect.any(Function),
    );
    target.emit("deviceorientation", { webkitCompassHeading: 42, beta: 90 });
    expect(samples).toHaveLength(1);
    expect(samples[0].headingDeg).toBeCloseTo(42);
    expect(samples[0].elevationDeg).toBeCloseTo(0);
  });

  it("returns an unsubscribe function that removes the listener", () => {
    const target = makeFakeTarget();
    const unsubscribe = subscribeOrientation(() => {}, target as unknown as EventTarget);
    unsubscribe();
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "deviceorientation",
      expect.any(Function),
    );
  });
});
