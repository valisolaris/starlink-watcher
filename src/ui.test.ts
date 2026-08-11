// ui.ts DOM tests (jsdom). 地点変更パネルを開いた時の自動スクロール検証。
// Test names are ASCII-safe wording to avoid cp932 console issues on Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPASS_UI_STRINGS } from "./compass-ui.ts";
import { saveLocation } from "./location.ts";
import { mount, UI_STRINGS } from "./ui.ts";

function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: reduce,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function saveTestLocation(): void {
  saveLocation({ lat: 35.68, lon: 139.75, label: "テスト地点", source: "manual" });
}

function openPanelViaChip(root: HTMLElement): void {
  saveTestLocation();
  mount(root);
  root.querySelector<HTMLButtonElement>("[data-chip]")!.click();
}

let root: HTMLElement;
let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  root = document.createElement("div");
  document.body.appendChild(root);
  scrollSpy = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  setReducedMotion(false);
  // refreshForecast内のfetchがテストへ波及しないよう常に失敗させ、
  // renderForecastError分岐(副作用なし)へ逃がす
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
});

afterEach(() => {
  root.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("location panel auto-scroll", () => {
  it("does not scroll on initial mount even though the panel starts open", () => {
    mount(root);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("scrolls the panel into view with smooth behavior when chip opens it", () => {
    openPanelViaChip(root);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("does not scroll when chip closes an already-open panel", () => {
    mount(root);
    const chip = root.querySelector<HTMLButtonElement>("[data-chip]")!;
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    chip.click();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("uses auto behavior with reduced motion", () => {
    setReducedMotion(true);
    openPanelViaChip(root);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("does not scroll when adopt() closes the panel via manual coords save", () => {
    mount(root);
    const latInput = root.querySelector<HTMLInputElement>("#lat-input")!;
    const lonInput = root.querySelector<HTMLInputElement>("#lon-input")!;
    const form = root.querySelector<HTMLFormElement>("[data-manual-form]")!;
    latInput.value = "35.68";
    lonInput.value = "139.75";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("scrolls the panel into view when a save failure reopens it", () => {
    mount(root);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const latInput = root.querySelector<HTMLInputElement>("#lat-input")!;
    const lonInput = root.querySelector<HTMLInputElement>("#lon-input")!;
    const form = root.querySelector<HTMLFormElement>("[data-manual-form]")!;
    latInput.value = "35.68";
    lonInput.value = "139.75";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });
});

// iOS Safariは、テキスト入力にフォーカス(キーボード表示)が残ったまま別要素をタップすると、
// 1回目のタップはキーボードを閉じるだけでclickが素通りしないことがある。検索実行時に検索欄を
// blur()しておくことで、結果ボタンへの最初のタップが確実に反応するようにする。
describe("search input blur on submit (iOS Safari tap fix)", () => {
  it("blurs the search input as soon as a search is submitted", () => {
    mount(root);
    const searchInput = root.querySelector<HTMLInputElement>('[name="q"]')!;
    const searchForm = root.querySelector<HTMLFormElement>("[data-search-form]")!;
    searchInput.value = "千代田区";
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);
    searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(searchInput);
  });

  it("does not blur and does not call searchPlace when the query is empty", () => {
    mount(root);
    const searchInput = root.querySelector<HTMLInputElement>('[name="q"]')!;
    const searchForm = root.querySelector<HTMLFormElement>("[data-search-form]")!;
    searchInput.value = "";
    searchInput.focus();
    searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(searchInput);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("current-location error messaging by GeolocationPositionError.code", () => {
  function stubGeolocation(errorArg: unknown): void {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      value: {
        getCurrentPosition: (
          _ok: PositionCallback,
          err?: PositionErrorCallback,
        ) => err?.(errorArg as GeolocationPositionError),
      },
      configurable: true,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, "geolocation");
  });

  it("shows the Safari location-settings hint when permission is denied (code 1)", async () => {
    stubGeolocation({ code: 1, message: "denied" });
    mount(root);
    root.querySelector<HTMLButtonElement>("[data-geolocate]")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector("[data-geo-status]")!.textContent).toBe(
        UI_STRINGS.geolocationPermissionDenied,
      );
    });
  });

  // 退行ガード: 権限拒否以外(POSITION_UNAVAILABLE)は従来どおり汎用メッセージのまま。
  it("keeps the existing generic message for non-permission errors (code 2)", async () => {
    stubGeolocation({ code: 2, message: "unavailable" });
    mount(root);
    root.querySelector<HTMLButtonElement>("[data-geolocate]")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector("[data-geo-status]")!.textContent).toBe(
        UI_STRINGS.geolocationDenied,
      );
    });
  });

  // getCurrentPosition()はAPI自体が無い環境ではcodeプロパティを持たないError
  // (location.ts: new Error("geolocation unavailable"))でrejectする。この経路でも
  // 汎用メッセージへ安全にフォールバックすることを確認する。
  it("keeps the existing generic message when the geolocation API itself is unavailable", async () => {
    Reflect.deleteProperty(globalThis.navigator, "geolocation");
    mount(root);
    root.querySelector<HTMLButtonElement>("[data-geolocate]")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector("[data-geo-status]")!.textContent).toBe(
        UI_STRINGS.geolocationDenied,
      );
    });
  });
});

// 新画面: 「予報」/「コンパス」タブ切り替え。フォアキャスト取得の成否とは独立して検証できる
// (このファイルの他テスト同様、fetchは常に失敗させておりフォアキャスト計算経路は通さない)。
describe("view tabs (forecast / compass)", () => {
  it("shows the forecast view and hides the compass view by default", () => {
    mount(root);
    expect(root.querySelector<HTMLElement>("[data-forecast-view]")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-compass-view]")!.hidden).toBe(true);
    expect(root.querySelector('[data-tab="forecast"]')!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(root.querySelector('[data-tab="compass"]')!.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("switches to the compass view when the compass tab is clicked", () => {
    mount(root);
    root.querySelector<HTMLButtonElement>('[data-tab="compass"]')!.click();
    expect(root.querySelector<HTMLElement>("[data-forecast-view]")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-compass-view]")!.hidden).toBe(false);
    expect(root.querySelector('[data-tab="compass"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-tab="forecast"]')!.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("switches back to the forecast view when the forecast tab is clicked again", () => {
    mount(root);
    root.querySelector<HTMLButtonElement>('[data-tab="compass"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-tab="forecast"]')!.click();
    expect(root.querySelector<HTMLElement>("[data-forecast-view]")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-compass-view]")!.hidden).toBe(true);
  });

  it("shows the compass empty-state guidance before any pass has been tracked", () => {
    mount(root);
    root.querySelector<HTMLButtonElement>('[data-tab="compass"]')!.click();
    expect(root.querySelector("[data-compass-view]")!.textContent).toContain(
      COMPASS_UI_STRINGS.emptyCopy,
    );
  });
});
