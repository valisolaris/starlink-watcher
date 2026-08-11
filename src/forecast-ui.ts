// 予報表示層(S2): verdict バンド・5夜分パスリスト・ローディング・エラーの描画。
// コピーは design-brief §1 の凍結文言。UI 文字列は定数分離(D-008)。
// accent の使用は「verdict の時刻数値」と「今夜、見えます」バッジのみ(D-009)。
// 描画するテキストはすべて内部生成(衛星名等の外部文字列は出力しない)ため innerHTML を使う。
import { azimuthToCompass8, type Brightness } from "./astro.ts";
import type { NightForecast, TrainInfo, Verdict, VisiblePass } from "./passes.ts";
import {
  azElToPoint,
  passArcPath,
  skyDialChromeSvg,
  svgRound,
  trainDotPoints,
} from "./sky-map.ts";

/** トレインの弧上ドット数(実際の衛星数ではなく「真珠の連なり」の様式的表現、design-brief §0) */
const TRAIN_DOT_COUNT = 6;

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
  trainEyebrow: "TRAIN",
  trainNewCopy: "新規検出・まだ明るく見える時期です",
  trackButton: "コンパスで狙う",
} as const;

/** design-brief §1「打ち上げから3日目」相当のコピー。日数は初回検出日からの推定(S4) */
function trainDaysCopy(days: number): string {
  return `(推定)打ち上げから${days}日目・まだ明るく見える時期です`;
}

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

/** TRAINバンド(design-brief §1 バンド2)。トレインパスが無ければ空文字(バンド非表示) */
export function trainBandHtml(
  pass: (VisiblePass & { train: TrainInfo }) | null,
): string {
  if (pass === null) return "";
  const copy =
    pass.train.daysSinceDetected === null
      ? FORECAST_STRINGS.trainNewCopy
      : trainDaysCopy(pass.train.daysSinceDetected);
  return `
    <div class="train-band">
      <div class="eyebrow">${FORECAST_STRINGS.trainEyebrow}</div>
      <p class="train-copy">${copy}</p>
    </div>`;
}

/** 方位図 SVG(S3)。早見盤流儀(北上・東左)。リング・ラベル位置は review.html 準拠(E/W のみ入替)。
 * 端点は可視区間の実仰角(仰角下限・影トリムにより地平線0°ではない。codex重大対応) */
function skyChartHtml(p: VisiblePass): string {
  const start = { azDeg: p.startAzDeg, elDeg: p.startElDeg };
  const max = { azDeg: p.maxAzDeg, elDeg: p.maxElevationDeg };
  const end = { azDeg: p.endAzDeg, elDeg: p.endElDeg };
  const ps = azElToPoint(start.azDeg, start.elDeg);
  const pm = azElToPoint(max.azDeg, max.elDeg);
  const pe = azElToPoint(end.azDeg, end.elDeg);
  const trainNote = p.train ? "打ち上げ直後のトレイン。" : "";
  const label = `${trainNote}${azimuthToCompass8(p.startAzDeg)}の空に現れ、${azimuthToCompass8(p.maxAzDeg)}で最大仰角${Math.round(p.maxElevationDeg)}度に達し、${azimuthToCompass8(p.endAzDeg)}の空で見えなくなる。北が上、東が左の見上げ図。`;
  // S4: トレイン由来のパスは弧上に等間隔ドット列(design-brief「真珠の連なり」)を重ねる
  const trainDots = p.train
    ? trainDotPoints(start, max, end, TRAIN_DOT_COUNT)
        .map(
          (pt) =>
            `<circle class="sky-train-dot" cx="${svgRound(pt.x)}" cy="${svgRound(pt.y)}" r="2.5"/>`,
        )
        .join("")
    : "";
  return `
    <div class="skychart">
      <svg viewBox="0 0 200 200" role="img" aria-label="${label}">
        ${skyDialChromeSvg()}
        <path class="sky-arc" d="${passArcPath(start, max, end)}" pathLength="1"/>
        ${trainDots}
        <circle class="sky-endpoint" cx="${svgRound(ps.x)}" cy="${svgRound(ps.y)}" r="3"/>
        <circle class="sky-endpoint" cx="${svgRound(pe.x)}" cy="${svgRound(pe.y)}" r="3"/>
        <circle class="sky-elev-max" cx="${svgRound(pm.x)}" cy="${svgRound(pm.y)}" r="4.5"/>
      </svg>
      <p class="skychart-caption">最大仰角 <b>${Math.round(p.maxElevationDeg)}°</b>(${azimuthToCompass8(p.maxAzDeg)})/ ${formatJstTime(p.maxTime)} 頃 / 明るさ目安 <b>${brightnessDots(p.brightness)}</b></p>
      <button class="btn btn-ghost" type="button" data-track-pass>${FORECAST_STRINGS.trackButton}</button>
    </div>`;
}

function passRowHtml(p: VisiblePass, chartId: string): string {
  return `
    <button class="pass-row" type="button" data-pass-toggle aria-expanded="false" aria-controls="${chartId}">
      <span class="pass-time din">${formatJstTime(p.maxTime)}</span>
      <span class="pass-dir">${azimuthToCompass8(p.startAzDeg)}→${azimuthToCompass8(p.endAzDeg)}</span>
      <span class="pass-el din">${Math.round(p.maxElevationDeg)}°</span>
      <span class="pass-dots" aria-label="明るさの目安 ${p.brightness}/3">${brightnessDots(p.brightness)}</span>
      <span class="pass-caret" aria-hidden="true">›</span>
    </button>
    <div class="skychart-wrap" id="${chartId}" hidden>${skyChartHtml(p)}</div>`;
}

/** 行タップで方位図を開閉。弧の描画アニメは初回展開のみ(hidden 切替で CSS アニメが
 * 再生し直されるため、初回以降はクラスを外して再生を防ぐ) */
function bindSkyChartToggles(container: HTMLElement): void {
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    "[data-pass-toggle]",
  )) {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("aria-controls");
      const wrap =
        id === null ? null : container.querySelector<HTMLElement>(`#${id}`);
      if (!wrap) return;
      const opening = wrap.hidden;
      wrap.hidden = !opening;
      btn.setAttribute("aria-expanded", String(opening));
      const arc = wrap.querySelector<SVGPathElement>(".sky-arc");
      if (!arc) return;
      if (opening && wrap.dataset.animated === undefined) {
        wrap.dataset.animated = "1";
        arc.classList.add("sky-arc-draw");
      } else {
        arc.classList.remove("sky-arc-draw");
      }
    });
  }
}

/**
 * 「コンパスで狙う」ボタンを、対応する VisiblePass にひもづけてバインドする。
 * ボタンは nights→passes と同じ順序でDOMに現れるため、表示順で単純にzipする
 * (以前はchartId文字列をMapに積んでDOM経由で逆引きしていたが、IDスキームの二重管理になる
 * ためsimplifyレビューで単純化。2026-08-11)。
 */
function bindTrackButtons(
  container: HTMLElement,
  nights: NightForecast[],
  onTrackPass?: (pass: VisiblePass) => void,
): void {
  if (!onTrackPass) return;
  const passesInOrder = nights.flatMap((night) => night.passes);
  const buttons = container.querySelectorAll<HTMLButtonElement>("[data-track-pass]");
  buttons.forEach((btn, i) => {
    const pass = passesInOrder[i];
    if (!pass) return;
    btn.addEventListener("click", () => onTrackPass(pass));
  });
}

export function renderForecast(
  container: HTMLElement,
  nights: NightForecast[],
  verdict: Verdict,
  opts?: {
    stale?: boolean;
    /** S4: TRAINバンド(バンド2)に表示するパス。null/未指定ならバンド非表示 */
    trainHighlight?: (VisiblePass & { train: TrainInfo }) | null;
    /** コンパス画面(新画面)への引き渡し。未指定ならボタンは描画されても無反応 */
    onTrackPass?: (pass: VisiblePass) => void;
  },
): void {
  const stale = opts?.stale
    ? `<p class="stale-note">${FORECAST_STRINGS.staleNote}</p>`
    : "";
  const trainBand = trainBandHtml(opts?.trainHighlight ?? null);
  const nightsHtml = nights
    .map((night, ni) => {
      const rows =
        night.passes.length === 0
          ? `<p class="empty-night">${FORECAST_STRINGS.emptyNight}</p>`
          : night.passes
              .map((p, pi) => passRowHtml(p, `sky-${ni}-${pi}`))
              .join("");
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
    ${trainBand}
    <div class="forecast-list">
      <div class="eyebrow">${FORECAST_STRINGS.forecastEyebrow}</div>
      ${nightsHtml}
    </div>`;
  bindSkyChartToggles(container);
  bindTrackButtons(container, nights, opts?.onTrackPass);
}
