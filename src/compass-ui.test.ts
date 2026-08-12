// compass-ui.ts DOM tests (jsdom). Test names are ASCII to avoid cp932 console issues on Windows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPASS_UI_STRINGS, renderCompass, renderCompassEmpty } from "./compass-ui.ts";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

describe("renderCompassEmpty", () => {
  it("shows guidance to pick a pass first, with no compass dial", () => {
    renderCompassEmpty(root);
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.emptyCopy);
    expect(root.querySelector("svg")).toBeNull();
  });
});

describe("renderCompass", () => {
  const target = { satName: "STARLINK-TEST", azDeg: 120, elDeg: 40, live: false };

  it("shows a permission request button when permission is unrequested", () => {
    const onRequest = vi.fn();
    renderCompass(root, target, { permission: "unrequested", device: null }, onRequest);
    const btn = root.querySelector<HTMLButtonElement>("[data-request-permission]");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain(COMPASS_UI_STRINGS.requestPermission);
    btn!.click();
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("shows a denied message when permission was denied", () => {
    renderCompass(root, target, { permission: "denied", device: null }, vi.fn());
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.permissionDenied);
  });

  it("shows an unsupported message when the sensor API is unsupported", () => {
    renderCompass(root, target, { permission: "unsupported", device: null }, vi.fn());
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.permissionUnsupported);
  });

  it("shows a waiting message when permission is granted but no sample has arrived yet", () => {
    renderCompass(root, target, { permission: "granted", device: null }, vi.fn());
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.waitingSensor);
  });

  it("renders the compass dial with target and device markers once a sample arrives", () => {
    renderCompass(
      root,
      target,
      { permission: "granted", device: { headingDeg: 110, elevationDeg: 35 } },
      vi.fn(),
    );
    expect(root.querySelector("svg")).not.toBeNull();
    const marker = root.querySelector("[data-target-marker]");
    expect(marker).not.toBeNull();
    // レティクル(照準)状であること: 端末マーカー(丸のみ)と形状語彙を分けて区別する
    expect(marker?.querySelector(".compass-target-dot")).not.toBeNull();
    expect(marker?.querySelector(".compass-target-ticks")).not.toBeNull();
    expect(root.querySelector("[data-device-marker]")).not.toBeNull();
  });

  it("marks the view as aligned (no new color, a distinct class) when within tolerance", () => {
    renderCompass(
      root,
      target,
      { permission: "granted", device: { headingDeg: 120, elevationDeg: 40 } },
      vi.fn(),
    );
    expect(root.querySelector("[data-aligned]")).not.toBeNull();
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.alignedCopy);
    // is-alignedクラスがリングの塗り/破線→実線というCSS状態を駆動する
    expect(root.querySelector("[data-device-marker]")?.classList.contains("is-aligned")).toBe(true);
  });

  it("does not mark as aligned when the device is far from the target", () => {
    renderCompass(
      root,
      target,
      { permission: "granted", device: { headingDeg: 10, elevationDeg: 5 } },
      vi.fn(),
    );
    expect(root.querySelector("[data-aligned]")).toBeNull();
    expect(root.querySelector("[data-device-marker]")?.classList.contains("is-aligned")).toBe(false);
  });

  it("labels a live target differently from a static target", () => {
    renderCompass(
      root,
      { ...target, live: true },
      { permission: "granted", device: { headingDeg: 120, elevationDeg: 40 } },
      vi.fn(),
    );
    expect(root.textContent).toContain(COMPASS_UI_STRINGS.liveLabel);
  });
});
