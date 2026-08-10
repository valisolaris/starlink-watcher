// 予報表示層(S2): verdict バンド・5夜分パスリスト・ローディング・エラーの描画。
// コピーは design-brief §1 の凍結文言。UI 文字列は定数分離(D-008)。
// accent の使用は「verdict の時刻数値」と「今夜、見えます」バッジのみ(D-009)。
// 描画するテキストはすべて内部生成(衛星名等の外部文字列は出力しない)ため innerHTML を使う。
import { azimuthToCompass8, type Brightness } from "./astro.ts";
import type { NightForecast, Verdict, VisiblePass } from "./passes.ts";

export const FORECAST_STRINGS = {
  loadingFetch: "軌道データを取得中…",
  loadingCompute: "パスを計算中…",
  fetchFailed:
    "軌道データを取得できませんでした。時間をおいて再試行してください。",
  retry: "再試行",
  verdictYes: "今夜、見えます",
  verdictNo: "今夜は見えません",
  nextChancePrefix: "次のチャンス: ",
  staleNote: "最新データを取得できなかったため、前回取得分で表示しています",
  emptyNight: "条件の良いパスはありません",
  forecastEyebrow: "5日分の予報",
} as const;

const JST = "Asia/Tokyo";

const timeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST,
  month: "numeric",
  day: "numeric",
  weekday: "short",
});

/** "21:43"(JST) */
export function formatJstTime(d: Date): string {
  return timeFmt.format(d);
}

/** "8/12(水)"(JST)。ロケール実装差を避けるため parts から組み立てる */
export function formatJstDate(d: Date): string {
  const parts = dateFmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}(${get("weekday")})`;
}

/** "8/12(水)20:15"(JST) */
export function formatJstDateTime(d: Date): string {
  return `${formatJstDate(d)}${formatJstTime(d)}`;
}

/** 明るさ3段階→ "●○○" 〜 "●●●" */
export function brightnessDots(b: Brightness): string {
  return "●".repeat(b) + "○".repeat(3 - b);
}

/** verdict の一行説明: 「南西の低い空、約4分間」(design-brief §1) */
function verdictSubline(pass: VisiblePass): string {
  const minutes = Math.max(
    1,
    Math.round((pass.endTime.getTime() - pass.startTime.getTime()) / 60_000),
  );
  const direction = azimuthToCompass8(pass.startAzDeg);
  const height = pass.maxElevationDeg < 30 ? "低い" : "高い";
  return `${direction}の${height}空、約${minutes}分間`;
}

export function renderForecastLoading(
  container: HTMLElement,
  phase: "fetch" | "compute",
  percent?: number,
): void {
  const label =
    phase === "fetch"
      ? FORECAST_STRINGS.loadingFetch
      : FORECAST_STRINGS.loadingCompute;
  const pct =
    percent === undefined
      ? null
      : Math.max(0, Math.min(100, Math.round(percent)));
  const meter =
    pct === null
      ? `<div class="scan-pulse" aria-hidden="true"></div>`
      : `<div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  container.innerHTML = `
    <div class="forecast-loading" role="status">
      <p class="loading-text">${label}${pct === null ? "" : ` <span class="loading-pct">${pct}%</span>`}</p>
      ${meter}
    </div>`;
}

export function renderForecastError(
  container: HTMLElement,
  onRetry: () => void,
): void {
  container.innerHTML = `
    <div class="forecast-error">
      <p class="status is-error">${FORECAST_STRINGS.fetchFailed}</p>
      <button class="btn btn-ghost" type="button" data-retry>${FORECAST_STRINGS.retry}</button>
    </div>`;
  container
    .querySelector<HTMLButtonElement>("[data-retry]")
    ?.addEventListener("click", onRetry);
}

function verdictHtml(verdict: Verdict): string {
  if (verdict.kind === "tonight") {
    const p = verdict.pass;
    return `
      <div class="verdict">
        <span class="verdict-badge din">${FORECAST_STRINGS.verdictYes}</span>
        <p class="verdict-main din">今夜 <span class="verdict-time">${formatJstTime(p.maxTime)}</span></p>
        <p class="verdict-sub">${verdictSubline(p)}</p>
      </div>`;
  }
  if (verdict.kind === "later") {
    return `
      <div class="verdict">
        <p class="verdict-main verdict-main-miss din">${FORECAST_STRINGS.verdictNo}</p>
        <p class="verdict-next">${FORECAST_STRINGS.nextChancePrefix}<span class="verdict-time din">${formatJstDateTime(verdict.nextPass.maxTime)}</span></p>
      </div>`;
  }
  return `
    <div class="verdict">
      <p class="verdict-main verdict-main-miss din">${FORECAST_STRINGS.verdictNo}</p>
    </div>`;
}

function passRowHtml(p: VisiblePass): string {
  return `
    <div class="pass-row">
      <span class="pass-time din">${formatJstTime(p.maxTime)}</span>
      <span class="pass-dir">${azimuthToCompass8(p.startAzDeg)}→${azimuthToCompass8(p.endAzDeg)}</span>
      <span class="pass-el din">${Math.round(p.maxElevationDeg)}°</span>
      <span class="pass-dots" aria-label="明るさの目安 ${p.brightness}/3">${brightnessDots(p.brightness)}</span>
    </div>`;
}

export function renderForecast(
  container: HTMLElement,
  nights: NightForecast[],
  verdict: Verdict,
  opts?: { stale?: boolean },
): void {
  const stale = opts?.stale
    ? `<p class="stale-note">${FORECAST_STRINGS.staleNote}</p>`
    : "";
  const nightsHtml = nights
    .map((night) => {
      const rows =
        night.passes.length === 0
          ? `<p class="empty-night">${FORECAST_STRINGS.emptyNight}</p>`
          : night.passes.map(passRowHtml).join("");
      return `
        <section class="night-group">
          <h3 class="night-date din">${formatJstDate(night.date)}</h3>
          ${rows}
        </section>`;
    })
    .join("");
  container.innerHTML = `
    ${stale}
    ${verdictHtml(verdict)}
    <div class="forecast-list">
      <div class="eyebrow">${FORECAST_STRINGS.forecastEyebrow}</div>
      ${nightsHtml}
    </div>`;
}
