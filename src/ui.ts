// アプリの殻(S1): ヘッダー・地点設定パネル・空状態・減光トグル・非公式フッター。
// UI 文字列は UI_STRINGS に定数分離する(D-008: 将来の英語化に備える)。
import {
  getCurrentPosition,
  loadLocation,
  safeGetItem,
  safeSetItem,
  saveLocation,
  searchPlace,
  validateCoords,
  type GeocodeResult,
  type ObserverLocation,
} from "./location.ts";
import { getGpData } from "./gp.ts";
import {
  computeForecast,
  deriveVerdict,
  forecastCacheKey,
  loadForecastCache,
  saveForecastCache,
} from "./passes.ts";
import {
  renderForecast,
  renderForecastError,
  renderForecastLoading,
} from "./forecast-ui.ts";
import {
  buildTrainInfoMap,
  deriveTrainHighlight,
  detectTrains,
  refreshTrainDays,
  trackFirstSeen,
} from "./train.ts";

export const UI_STRINGS = {
  appName: "STARLINK WATCH",
  chipUnset: "地点を設定",
  emptyCopy: "観測地点を設定すると、5日分の予報を表示します",
  useCurrentLocation: "現在地を使う",
  orSearchPlace: "地名で探す",
  orManualCoords: "緯度・経度を入力する",
  searchPlaceholder: "例: 千代田区",
  searchButton: "検索",
  searchNoResult: "見つかりませんでした。別の地名か、緯度経度の入力をお試しください。",
  searchFailed: "検索できませんでした。時間をおいて再試行するか、緯度経度を入力してください。",
  searching: "検索中…",
  locating: "現在地を取得中…",
  geolocationDenied: "位置情報を取得できませんでした。地名検索か、緯度経度の入力をお使いください。",
  latLabel: "緯度 (-90〜90)",
  lonLabel: "経度 (-180〜180)",
  saveButton: "保存",
  invalidNumber: "緯度・経度は数値で入力してください。",
  latOutOfRange: "緯度は -90〜90 の範囲で入力してください。",
  lonOutOfRange: "経度は -180〜180 の範囲で入力してください。",
  currentLocationLabel: "現在地",
  saveFailed:
    "ブラウザに保存できませんでした(ストレージが無効の可能性)。この地点は再読み込みまで有効です。",
  dimToggle: "減光モード",
  legal:
    "本サイトは SpaceX 社および Starlink とは無関係の非公式ツールです。軌道データ: CelesTrak",
} as const;

export const DIM_STORAGE_KEY = "starlink-watcher:dim:v1";

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <header class="app-header">
      <span class="app-name din">${UI_STRINGS.appName}</span>
      <button class="chip" type="button" data-chip aria-expanded="false"></button>
    </header>
    <main>
      <section class="band" data-main-band>
        <p class="empty-copy" data-empty-copy>${UI_STRINGS.emptyCopy}</p>
        <div class="forecast" data-forecast hidden></div>
      </section>
      <section class="band" data-loc-band>
        <div class="loc-panel">
          <div class="loc-section">
            <button class="btn btn-fill" type="button" data-geolocate>${UI_STRINGS.useCurrentLocation}</button>
            <p class="status" role="status" data-geo-status></p>
          </div>
          <form class="loc-section" data-search-form>
            <p class="loc-section-title">${UI_STRINGS.orSearchPlace}</p>
            <div class="field-row">
              <input class="field" type="text" name="q" placeholder="${UI_STRINGS.searchPlaceholder}" aria-label="${UI_STRINGS.orSearchPlace}" />
              <button class="btn btn-ghost" type="submit">${UI_STRINGS.searchButton}</button>
            </div>
            <p class="status" role="status" data-search-status></p>
            <ul class="result-list" data-search-results></ul>
          </form>
          <form class="loc-section" data-manual-form>
            <p class="loc-section-title">${UI_STRINGS.orManualCoords}</p>
            <div class="coords-grid">
              <div>
                <label class="field-label" for="lat-input">${UI_STRINGS.latLabel}</label>
                <input class="field" id="lat-input" type="text" inputmode="decimal" name="lat" />
              </div>
              <div>
                <label class="field-label" for="lon-input">${UI_STRINGS.lonLabel}</label>
                <input class="field" id="lon-input" type="text" inputmode="decimal" name="lon" />
              </div>
            </div>
            <button class="btn btn-ghost" type="submit">${UI_STRINGS.saveButton}</button>
            <p class="status" role="status" data-manual-status></p>
          </form>
        </div>
      </section>
    </main>
    <footer class="app-footer">
      <label class="dim-toggle"><input type="checkbox" data-dim-toggle /> ${UI_STRINGS.dimToggle}</label>
      <p class="legal">${UI_STRINGS.legal}</p>
    </footer>
  `;

  const chip = el<HTMLButtonElement>(root, "[data-chip]");
  const locBand = el<HTMLElement>(root, "[data-loc-band]");
  const emptyCopy = el<HTMLElement>(root, "[data-empty-copy]");
  const forecastEl = el<HTMLElement>(root, "[data-forecast]");
  const geolocateBtn = el<HTMLButtonElement>(root, "[data-geolocate]");
  const geoStatus = el<HTMLElement>(root, "[data-geo-status]");
  const searchForm = el<HTMLFormElement>(root, "[data-search-form]");
  const searchStatus = el<HTMLElement>(root, "[data-search-status]");
  const searchResults = el<HTMLUListElement>(root, "[data-search-results]");
  const manualForm = el<HTMLFormElement>(root, "[data-manual-form]");
  const manualStatus = el<HTMLElement>(root, "[data-manual-status]");
  const latInput = el<HTMLInputElement>(root, "#lat-input");
  const dimToggle = el<HTMLInputElement>(root, "[data-dim-toggle]");

  // ストレージが使えない環境でもセッション内では動くよう、現在地点はメモリ上でも保持する
  let current: ObserverLocation | null = loadLocation();

  function setPanelOpen(open: boolean): void {
    locBand.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
  }

  function render(): void {
    const loc = current;
    if (loc) {
      chip.textContent = `${loc.label} ▾`;
      emptyCopy.hidden = true;
      forecastEl.hidden = false;
      setPanelOpen(false);
    } else {
      chip.textContent = `${UI_STRINGS.chipUnset} ▾`;
      emptyCopy.hidden = false;
      forecastEl.hidden = true;
      setPanelOpen(true);
    }
  }

  // 予報フロー: 取得(2時間キャッシュ)→計算(チャンク+進捗)→描画。
  // 地点変更・再試行の競合は世代番号で最新だけを反映する(searchSeq と同じパターン)。
  let forecastSeq = 0;

  async function refreshForecast(loc: ObserverLocation): Promise<void> {
    const seq = ++forecastSeq;
    renderForecastLoading(forecastEl, "fetch");
    try {
      const gp = await getGpData();
      if (seq !== forecastSeq) return;
      const obs = { lat: loc.lat, lon: loc.lon };
      const key = forecastCacheKey(obs, gp.snapshot.fetchedAt);
      let nights = loadForecastCache(key);
      // キャッシュされた予報でも、今夜の窓が終わっていたら作り直す
      if (nights && nights[0] && nights[0].window.end.getTime() <= Date.now()) {
        nights = null;
      }
      if (!nights) {
        renderForecastLoading(forecastEl, "compute", 0);
        // S4: 打ち上げ直後トレインを検出し、上位3件選抜(computeForecast内)より前に
        // 明るさ補正・train付与が適用されるよう computeForecast へ渡す(codex重大指摘対応:
        // 選抜後に適用すると、補正前の明るさで落選したトレインが結果から欠落するため)
        const { trainObjectIds } = detectTrains(gp.snapshot.records);
        const { daysById } = trackFirstSeen(
          [...new Set(trainObjectIds.values())],
          Date.now(),
        );
        const trainInfoByObjectId = buildTrainInfoMap(trainObjectIds, daysById);
        nights = await computeForecast(
          gp.snapshot.records,
          obs,
          new Date(),
          (done, total) => {
            if (seq === forecastSeq && total > 0) {
              renderForecastLoading(forecastEl, "compute", (done / total) * 100);
            }
          },
          trainInfoByObjectId,
        );
        if (seq !== forecastSeq) return;
        saveForecastCache(key, nights);
      } else {
        // S4 codex軽微指摘対応: キャッシュ復元時も「打ち上げからN日目」を現在時刻基準に更新する
        // (明るさ・train有無の再計算はしない。二重補正を避けるため)
        nights = refreshTrainDays(nights, Date.now());
      }
      const now = new Date();
      const verdict = deriveVerdict(nights, now);
      const trainHighlight = deriveTrainHighlight(nights, now);
      renderForecast(forecastEl, nights, verdict, {
        stale: gp.source === "stale-cache",
        trainHighlight,
      });
    } catch {
      if (seq !== forecastSeq) return;
      renderForecastError(forecastEl, () => {
        void refreshForecast(loc);
      });
    }
  }

  function adopt(loc: ObserverLocation): void {
    current = loc;
    const persisted = saveLocation(loc);
    geoStatus.textContent = "";
    searchStatus.textContent = "";
    manualStatus.textContent = "";
    searchResults.innerHTML = "";
    render();
    void refreshForecast(loc);
    if (!persisted) {
      // 保存失敗はセッション内動作を止めず、事実だけ伝える(codex指摘: 書き込み失敗の可視化)
      manualStatus.classList.add("is-error");
      manualStatus.textContent = UI_STRINGS.saveFailed;
      setPanelOpen(true);
    }
    // 操作完了位置を明確にする(スクリーンリーダー・キーボード配慮)
    chip.focus();
  }

  chip.addEventListener("click", () => {
    setPanelOpen(chip.getAttribute("aria-expanded") !== "true");
  });

  geolocateBtn.addEventListener("click", async () => {
    geolocateBtn.disabled = true;
    geoStatus.classList.remove("is-error");
    geoStatus.textContent = UI_STRINGS.locating;
    try {
      const pos = await getCurrentPosition();
      adopt({
        lat: pos.lat,
        lon: pos.lon,
        label: `${UI_STRINGS.currentLocationLabel} (${formatCoords(pos.lat, pos.lon)})`,
        source: "geolocation",
      });
    } catch {
      // 拒否・失敗時は無反応にせず、手入力へ誘導する(S1 完了条件)
      geoStatus.classList.add("is-error");
      geoStatus.textContent = UI_STRINGS.geolocationDenied;
      latInput.focus();
    } finally {
      geolocateBtn.disabled = false;
    }
  });

  // 連続検索で古い応答が新しい結果を上書きしないよう、世代番号で最新の検索だけを反映する
  let searchSeq = 0;

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = new FormData(searchForm).get("q");
    if (typeof query !== "string" || query.trim() === "") return;
    const seq = ++searchSeq;
    searchStatus.classList.remove("is-error");
    searchStatus.textContent = UI_STRINGS.searching;
    searchResults.innerHTML = "";
    let results: GeocodeResult[];
    try {
      results = await searchPlace(query.trim());
    } catch {
      if (seq !== searchSeq) return;
      searchStatus.classList.add("is-error");
      searchStatus.textContent = UI_STRINGS.searchFailed;
      return;
    }
    if (seq !== searchSeq) return;
    if (results.length === 0) {
      searchStatus.textContent = UI_STRINGS.searchNoResult;
      return;
    }
    searchStatus.textContent = "";
    for (const r of results) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "result-item";
      btn.textContent = r.label;
      const coords = document.createElement("span");
      coords.className = "coords";
      coords.textContent = formatCoords(r.lat, r.lon);
      btn.appendChild(coords);
      btn.addEventListener("click", () => {
        adopt({ lat: r.lat, lon: r.lon, label: r.label, source: "search" });
      });
      li.appendChild(btn);
      searchResults.appendChild(li);
    }
  });

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(manualForm);
    const v = validateCoords(String(data.get("lat") ?? ""), String(data.get("lon") ?? ""));
    manualStatus.classList.remove("is-error");
    if (!v.ok) {
      manualStatus.classList.add("is-error");
      manualStatus.textContent =
        v.reason === "not-a-number"
          ? UI_STRINGS.invalidNumber
          : v.reason === "lat-out-of-range"
            ? UI_STRINGS.latOutOfRange
            : UI_STRINGS.lonOutOfRange;
      return;
    }
    adopt({
      lat: v.lat,
      lon: v.lon,
      label: formatCoords(v.lat, v.lon),
      source: "manual",
    });
  });

  // 減光モード(design-brief §1 夜間配慮)。設定は localStorage に保持する(失敗時はセッション内のみ有効)。
  const dimSaved = safeGetItem(DIM_STORAGE_KEY) === "1";
  dimToggle.checked = dimSaved;
  document.documentElement.classList.toggle("dim", dimSaved);
  dimToggle.addEventListener("change", () => {
    document.documentElement.classList.toggle("dim", dimToggle.checked);
    safeSetItem(DIM_STORAGE_KEY, dimToggle.checked ? "1" : "0");
  });

  render();
  if (current) void refreshForecast(current);
}
