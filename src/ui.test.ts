// ui.ts DOM tests (jsdom). 地点変更パネルを開いた時の自動スクロール検証。
// Test names are ASCII-safe wording to avoid cp932 console issues on Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveLocation } from "./location.ts";
import { mount } from "./ui.ts";

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
