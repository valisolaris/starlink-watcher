// パス探索層(S2): 夜窓の算出→粗ステップ走査→細分化でパス検出→スコアリング→
// 各夜上位3件→verdict 導出。計算はチャンク分割で yield し UI を止めない。
// ホットループは sgp4() 直接呼び出し+時刻グリッド(jday/gmst)の全衛星共有で高速化している
// (propagate() は呼び出しごとに Date→jday 変換と gstime 計算を行うため、
//  1.1万機×数百ステップでは支配的コストになる。2026-08-10 実測で約2倍差)。
import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  radiansToDegrees,
  sgp4,
  type EciVec3,
  type GeodeticLocation,
  type Kilometer,
  type SatRec,
} from "satellite.js";
import {
  brightnessBucket,
  estimateMagnitude,
  isSunlit,
  sunAltitudeDeg,
  sunEciAU,
  NIGHT_SUN_ALT_MAX_DEG,
  type Brightness,
  type Observer,
} from "./astro.ts";
import { gpToSatrec, type GpRecord } from "./gp.ts";
import { safeGetItem, safeSetItem } from "./location.ts";

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** S4: トレイン検出結果(train.ts の detectTrains/trackFirstSeen が算出)。VisiblePass に付与する */
export interface TrainInfo {
  groupId: string;
  /** 初回検出日からの経過日数(推定)。今回のロードで初めて検出した群は null */
  daysSinceDetected: number | null;
}

export interface VisiblePass {
  satName: string;
  objectId: string;
  noradId: number;
  startTime: Date;
  maxTime: Date;
  endTime: Date;
  startAzDeg: number;
  maxAzDeg: number;
  endAzDeg: number;
  /** 可視区間端点の仰角(deg)。仰角下限や影トリムにより 0 ではない(方位図の端点描画に使う) */
  startElDeg: number;
  endElDeg: number;
  maxElevationDeg: number;
  rangeAtMaxKm: number;
  magnitude: number;
  brightness: Brightness;
  /** S4: トレイン由来のパスにのみ付与(train.ts の applyTrainInfo が設定) */
  train?: TrainInfo;
}

export interface NightForecast {
  /** その夜の「夕方側」の日付(JST 表示に使う) */
  date: Date;
  window: TimeWindow;
  /** スコア上位のみ(最大 TOP_PASSES_PER_NIGHT 件)、時刻昇順 */
  passes: VisiblePass[];
}

export type Verdict =
  | { kind: "tonight"; pass: VisiblePass }
  | { kind: "later"; nextPass: VisiblePass }
  | { kind: "none" };

/** 走査の刈り込み下限: これより太陽が深く沈むと運用高度の衛星はほぼ地球影内(deg) */
export const SCAN_SUN_ALT_MIN_DEG = -35;
/** パスとして数える最低仰角(deg) */
export const MIN_PASS_ELEVATION_DEG = 10;
/** 粗走査ステップ(s)。550km 高度のパスは地平線上に10分前後とどまるため取りこぼさない */
export const COARSE_STEP_S = 120;
/** 細分化ステップ(s) */
export const FINE_STEP_S = 10;
export const TOP_PASSES_PER_NIGHT = 3;
export const FORECAST_NIGHTS = 5;
/** verdict「見えます」に必要な最低明るさ(フェーズ1でユーザー決定: ●●○以上) */
export const VERDICT_MIN_BRIGHTNESS: Brightness = 2;

// v2: 明るさ較正(MAG_TWO_DOTS_MAX 4.8→4.5)で保存データの意味が変わったため版上げ
// v3: 可視区間端点の仰角(startElDeg/endElDeg)を追加(S3 codex重大対応)したため版上げ
// v4: トレイン情報(train フィールド)を追加(S4)したため版上げ
export const FORECAST_STORAGE_KEY = "starlink-watcher:forecast:v4";

/** 太陽高度が threshold を跨ぐ時刻を二分法で約15秒精度まで詰める */
function refineSunCrossing(
  beforeMs: number,
  afterMs: number,
  obs: Observer,
  thresholdDeg: number,
): number {
  let lo = beforeMs;
  let hi = afterMs;
  const loBelow = sunAltitudeDeg(new Date(lo), obs) <= thresholdDeg;
  while (hi - lo > 15_000) {
    const mid = (lo + hi) / 2;
    const midBelow = sunAltitudeDeg(new Date(mid), obs) <= thresholdDeg;
    if (midBelow === loBelow) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 太陽高度が [minDeg, maxDeg] の帯に入る区間を [fromMs, toMs] から列挙する。
 * nightWindows(帯 = [-90, -6])と darkScanSegments(帯 = [-35, -6])で共用。
 */
function sunAltitudeBandSegments(
  fromMs: number,
  toMs: number,
  obs: Observer,
  minDeg: number,
  maxDeg: number,
  stepMs: number,
): TimeWindow[] {
  const inBand = (ms: number): boolean => {
    const alt = sunAltitudeDeg(new Date(ms), obs);
    return alt <= maxDeg && alt >= minDeg;
  };
  const segments: TimeWindow[] = [];
  let cursor = fromMs;
  let inside = inBand(cursor);
  let segStart = inside ? cursor : null;
  while (cursor < toMs) {
    const next = Math.min(cursor + stepMs, toMs);
    const nextInside = inBand(next);
    if (!inside && nextInside) {
      // 帯へ入った側の境界(-6 か minDeg か)は二分法で判別せず、両閾値で詰めて近い方を取る
      segStart = refineBandCrossing(cursor, next, obs, minDeg, maxDeg);
    } else if (inside && !nextInside && segStart !== null) {
      segments.push({
        start: new Date(segStart),
        end: new Date(refineBandCrossing(cursor, next, obs, minDeg, maxDeg)),
      });
      segStart = null;
    }
    inside = nextInside;
    cursor = next;
  }
  if (inside && segStart !== null) {
    segments.push({ start: new Date(segStart), end: new Date(toMs) });
  }
  return segments;
}

/** 帯境界の横断時刻: どちらの閾値を跨いだかを端点の高度から判定して詰める */
function refineBandCrossing(
  beforeMs: number,
  afterMs: number,
  obs: Observer,
  minDeg: number,
  maxDeg: number,
): number {
  const altBefore = sunAltitudeDeg(new Date(beforeMs), obs);
  const altAfter = sunAltitudeDeg(new Date(afterMs), obs);
  // maxDeg(-6)を跨いだのか minDeg(-35 など)を跨いだのかを判別する
  const crossedMax =
    altBefore > maxDeg !== altAfter > maxDeg ? maxDeg : minDeg;
  return refineSunCrossing(beforeMs, afterMs, obs, crossedMax);
}

/** 今夜を含む5夜分の夜窓(観測地の太陽高度が NIGHT_SUN_ALT_MAX_DEG 以下の区間) */
export function nightWindows(
  now: Date,
  obs: Observer,
  nights: number = FORECAST_NIGHTS,
): TimeWindow[] {
  const horizonMs = now.getTime() + (nights + 2) * 86_400_000;
  const segments = sunAltitudeBandSegments(
    now.getTime(),
    horizonMs,
    obs,
    -90,
    NIGHT_SUN_ALT_MAX_DEG,
    10 * 60 * 1000,
  );
  return segments.slice(0, nights);
}

/** 夜窓のうち走査対象の区間(太陽高度 [SCAN_SUN_ALT_MIN_DEG, NIGHT_SUN_ALT_MAX_DEG]) */
export function darkScanSegments(
  window: TimeWindow,
  obs: Observer,
): TimeWindow[] {
  return sunAltitudeBandSegments(
    window.start.getTime(),
    window.end.getTime(),
    obs,
    SCAN_SUN_ALT_MIN_DEG,
    NIGHT_SUN_ALT_MAX_DEG,
    5 * 60 * 1000,
  );
}

/** 幾何パス(仰角のみ、可視条件は未適用)。テスト可能にするため公開 */
export interface GeometricPass {
  startTime: Date;
  maxTime: Date;
  endTime: Date;
  startAzDeg: number;
  maxAzDeg: number;
  endAzDeg: number;
  /** 区間端点の仰角(deg)。run の最初/最後のサンプル値 */
  startElDeg: number;
  endElDeg: number;
  maxElevationDeg: number;
  rangeAtMaxKm: number;
}

const MS_PER_DAY = 86_400_000;
/** Unix epoch のユリウス日 */
const JDAY_UNIX_EPOCH = 2440587.5;

function msToJday(ms: number): number {
  return ms / MS_PER_DAY + JDAY_UNIX_EPOCH;
}

/** 走査時刻グリッド。jday と gmst は衛星に依存しないため全衛星で共有できる */
interface ScanGrid {
  timesMs: number[];
  jd: number[];
  gmst: number[];
}

function buildScanGrid(segment: TimeWindow, stepMs: number): ScanGrid {
  const timesMs: number[] = [];
  const jd: number[] = [];
  const gmst: number[] = [];
  for (let t = segment.start.getTime(); t <= segment.end.getTime(); t += stepMs) {
    const j = msToJday(t);
    timesMs.push(t);
    jd.push(j);
    gmst.push(gstime(j));
  }
  return { timesMs, jd, gmst };
}

function obsToGd(obs: Observer): GeodeticLocation {
  return {
    latitude: degreesToRadians(obs.lat),
    longitude: degreesToRadians(obs.lon),
    height: obs.heightKm ?? 0,
  };
}

interface FastLook {
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  /** 衛星の ECI 位置(km)。日照判定に再伝播せず使い回す */
  eci: EciVec3<Kilometer>;
}

/** ホットパス用: sgp4 直接呼び出し(propagate() の Date/jday/gstime 再計算を回避)。
 * propagate() 同様、伝播エラーは null。NaN 位置(古い要素の発散)もスキップする。 */
function lookAt(
  satrec: SatRec,
  gd: GeodeticLocation,
  jd: number,
  gmstVal: number,
): FastLook | null {
  const pv = sgp4(satrec, (jd - satrec.jdsatepoch) * 1440);
  if (!pv) return null;
  const pos = pv.position;
  if (!Number.isFinite(pos.x)) return null;
  const la = ecfToLookAngles(gd, eciToEcf(pos, gmstVal));
  let az = radiansToDegrees(la.azimuth) % 360;
  if (az < 0) az += 360;
  return {
    azDeg: az,
    elDeg: radiansToDegrees(la.elevation),
    rangeKm: la.rangeSat,
    eci: pos,
  };
}

function lookAtMs(
  satrec: SatRec,
  gd: GeodeticLocation,
  ms: number,
): FastLook | null {
  const jd = msToJday(ms);
  return lookAt(satrec, gd, jd, gstime(jd));
}

export interface LiveLookAngles {
  azDeg: number;
  elDeg: number;
  rangeKm: number;
}

/**
 * 任意時刻での方位角・仰角・距離(コンパス画面のライブ追跡用)。lookAtMs の薄いラッパーで、
 * 内部最適化用の ECI 座標(FastLook.eci)は外部に晒さない。
 */
export function liveLookAngles(
  satrec: SatRec,
  obs: Observer,
  date: Date,
): LiveLookAngles | null {
  const look = lookAtMs(satrec, obsToGd(obs), date.getTime());
  if (look === null) return null;
  return { azDeg: look.azDeg, elDeg: look.elDeg, rangeKm: look.rangeKm };
}

export interface CompassTargetLook {
  azDeg: number;
  elDeg: number;
  /** true = 現在時刻でのライブ位置、false = 静的な目標(最大仰角点) */
  live: boolean;
}

/**
 * コンパス画面(新画面)が追跡中パスに対して示すべき目標の方位角・仰角。
 * 可視時間帯中かつsatrecが渡されていればライブ計算、それ以外(時間帯外・satrec無し・
 * 伝播失敗)は最大仰角点(静的)にフォールバックする。
 * UIの薄い配線層(ui.ts)から分離し単体テスト可能にする(simplifyレビューのaltitude指摘対応。
 * 2026-08-11)。
 */
export function resolveCompassTarget(
  pass: VisiblePass,
  satrec: SatRec | null,
  obs: Observer,
  now: Date,
): CompassTargetLook {
  const withinWindow =
    now.getTime() >= pass.startTime.getTime() && now.getTime() <= pass.endTime.getTime();
  if (withinWindow && satrec) {
    const look = liveLookAngles(satrec, obs, now);
    if (look) return { azDeg: look.azDeg, elDeg: look.elDeg, live: true };
  }
  return { azDeg: pass.maxAzDeg, elDeg: pass.maxElevationDeg, live: false };
}

/** 細分走査の1サンプル(ECI 付き。日照判定の再伝播を避ける) */
interface FineSample {
  ms: number;
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  eci: EciVec3<Kilometer>;
}

/** 仰角 >= MIN_PASS_ELEVATION_DEG の連続サンプル列(=幾何パスの素材)を列挙する */
function scanElevationRuns(
  satrec: SatRec,
  gd: GeodeticLocation,
  segment: TimeWindow,
  grid?: ScanGrid,
): FineSample[][] {
  const startMs = segment.start.getTime();
  const endMs = segment.end.getTime();
  const coarseMs = COARSE_STEP_S * 1000;
  const g = grid ?? buildScanGrid(segment, coarseMs);
  // 粗走査: 地平線上(el > 0)のサンプルを候補区間に統合
  const candidates: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < g.timesMs.length; i++) {
    const la = lookAt(satrec, gd, g.jd[i], g.gmst[i]);
    if (la === null || la.elDeg <= 0) continue;
    const from = Math.max(startMs, g.timesMs[i] - coarseMs);
    const to = Math.min(endMs, g.timesMs[i] + coarseMs);
    const last = candidates[candidates.length - 1];
    if (last && from <= last.to) last.to = to;
    else candidates.push({ from, to });
  }
  // 細分化: 仰角 >= MIN_PASS_ELEVATION_DEG の連続区間を run として抽出。
  // 終端 cand.to は刻みに一致しなくても必ず1回評価し、ループ後に残 run を flush する
  // (これを怠ると、夜明け境界など任意ミリ秒の区間端まで続くパスが丸ごと欠落する)。
  const runs: FineSample[][] = [];
  const fineMs = FINE_STEP_S * 1000;
  for (const cand of candidates) {
    let run: FineSample[] = [];
    for (let t = cand.from; ; t += fineMs) {
      const ms = Math.min(t, cand.to);
      const la = lookAtMs(satrec, gd, ms);
      const aboveMin = la !== null && la.elDeg >= MIN_PASS_ELEVATION_DEG;
      if (aboveMin && la) {
        run.push({
          ms,
          azDeg: la.azDeg,
          elDeg: la.elDeg,
          rangeKm: la.rangeKm,
          eci: la.eci,
        });
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      if (ms >= cand.to) break;
    }
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  return runs;
}

/** サンプル連続列 → パス(開始/最大/終了)。最大は仰角最大点(同値なら先勝ち) */
function samplesToPass(
  run: Array<{ ms: number; azDeg: number; elDeg: number; rangeKm: number }>,
): GeometricPass {
  const max = run.reduce((a, b) => (a.elDeg >= b.elDeg ? a : b));
  const first = run[0];
  const last = run[run.length - 1];
  return {
    startTime: new Date(first.ms),
    maxTime: new Date(max.ms),
    endTime: new Date(last.ms),
    startAzDeg: first.azDeg,
    maxAzDeg: max.azDeg,
    endAzDeg: last.azDeg,
    startElDeg: first.elDeg,
    endElDeg: last.elDeg,
    maxElevationDeg: max.elDeg,
    rangeAtMaxKm: max.rangeKm,
  };
}

export function findGeometricPasses(
  satrec: SatRec,
  obs: Observer,
  segment: TimeWindow,
  grid?: ScanGrid,
): GeometricPass[] {
  return scanElevationRuns(satrec, obsToGd(obs), segment, grid).map(samplesToPass);
}

/** 可視区間分割の入力サンプル(細分走査1点分+日照評価) */
export interface PassSample {
  ms: number;
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  sunlit: boolean;
}

/**
 * 仰角 >= minElDeg かつ日照の連続区間ごとにパスへ分割する(codex重大1対応)。
 * パス途中の影出入りで前後だけ可視のケースを落とさず、影区間を表示時間に含めない。
 */
export function splitVisibleRuns(
  samples: PassSample[],
  minElDeg: number,
): GeometricPass[] {
  const passes: GeometricPass[] = [];
  let run: PassSample[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      passes.push(samplesToPass(run));
      run = [];
    }
  };
  for (const s of samples) {
    if (s.elDeg >= minElDeg && s.sunlit) run.push(s);
    else flush();
  }
  flush();
  return passes;
}

/** スコア: 明るさ優先、同点は最大仰角。選抜後は時刻昇順に並べ直す */
export function selectTopPasses(
  passes: VisiblePass[],
  n: number = TOP_PASSES_PER_NIGHT,
): VisiblePass[] {
  const ranked = [...passes].sort(
    (a, b) => b.brightness - a.brightness || b.maxElevationDeg - a.maxElevationDeg,
  );
  return ranked
    .slice(0, n)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

export function deriveVerdict(nights: NightForecast[], now: Date): Verdict {
  const qualifies = (p: VisiblePass): boolean =>
    p.brightness >= VERDICT_MIN_BRIGHTNESS && p.maxTime.getTime() > now.getTime();
  const byMaxTime = (a: VisiblePass, b: VisiblePass): number =>
    a.maxTime.getTime() - b.maxTime.getTime();
  if (nights.length > 0) {
    const tonight = nights[0].passes.filter(qualifies).sort(byMaxTime)[0];
    if (tonight) return { kind: "tonight", pass: tonight };
  }
  for (const night of nights.slice(1)) {
    const next = night.passes.filter(qualifies).sort(byMaxTime)[0];
    if (next) return { kind: "later", nextPass: next };
  }
  return { kind: "none" };
}

/** その夜の「夕方側」の日付: 窓の終端(夜明け)から12時間引いた時点の属する日 */
function nightDate(window: TimeWindow): Date {
  return new Date(window.end.getTime() - 12 * 3_600_000);
}

/** チャンクサイズ(衛星数)。1チャンクごとにイベントループへ制御を返す */
const COMPUTE_CHUNK_SIZE = 50;

/** setTimeout はバックグラウンドタブで強くスロットリングされるため、
 * タイマー扱いにならない MessageChannel で制御を返す(2026-08-10 実機で確認)。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** brightness を1段階上げる(上限3)。S4: トレインの明るさ補正 */
function boostBrightness(b: Brightness): Brightness {
  return b >= 3 ? 3 : ((b + 1) as Brightness);
}

/**
 * 全衛星×5夜のパス探索。チャンクごとに yield し onProgress で進捗を通知する。
 * trainInfoByObjectId(S4)を渡すと、該当衛星のパスへ train フィールドを付与し明るさを
 * 1段階上げる。この補正は selectTopPasses(上位3件選抜)より前に適用する必要がある
 * (選抜後に補正すると、補正前の明るさで落選したトレインが結果から欠落するため。
 * codex重大指摘対応)。
 */
export async function computeForecast(
  records: GpRecord[],
  obs: Observer,
  now: Date,
  onProgress?: (done: number, total: number) => void,
  trainInfoByObjectId?: Map<string, TrainInfo>,
): Promise<NightForecast[]> {
  const windows = nightWindows(now, obs);
  const segmentsPerNight = windows.map((w) => darkScanSegments(w, obs));
  // 時刻グリッドは衛星に依存しないため、夜×セグメントごとに1回だけ作り全衛星で共有する
  const gridsPerNight = segmentsPerNight.map((segs) =>
    segs.map((seg) => buildScanGrid(seg, COARSE_STEP_S * 1000)),
  );
  const sats: Array<{ rec: GpRecord; satrec: SatRec }> = [];
  for (const rec of records) {
    const satrec = gpToSatrec(rec);
    if (satrec !== null) sats.push({ rec, satrec });
  }
  const total = sats.length;
  const perNight: VisiblePass[][] = windows.map(() => []);
  const gd = obsToGd(obs);
  let done = 0;
  onProgress?.(0, total);
  for (let i = 0; i < sats.length; i += COMPUTE_CHUNK_SIZE) {
    const chunk = sats.slice(i, i + COMPUTE_CHUNK_SIZE);
    for (const { rec, satrec } of chunk) {
      for (let wi = 0; wi < windows.length; wi++) {
        for (let si = 0; si < segmentsPerNight[wi].length; si++) {
          const seg = segmentsPerNight[wi][si];
          // 可視3条件: 地平線上は仰角 run で、観測地の暗さは走査区間で担保済み。
          // 太陽照射はサンプル単位で評価し、影の出入りで可視区間をトリム・分割する。
          for (const run of scanElevationRuns(satrec, gd, seg, gridsPerNight[wi][si])) {
            const samples: PassSample[] = run.map((s) => ({
              ms: s.ms,
              azDeg: s.azDeg,
              elDeg: s.elDeg,
              rangeKm: s.rangeKm,
              sunlit: isSunlit(s.eci, sunEciAU(new Date(s.ms))),
            }));
            for (const gp of splitVisibleRuns(samples, MIN_PASS_ELEVATION_DEG)) {
              const magnitude = estimateMagnitude(gp.rangeAtMaxKm);
              const train = trainInfoByObjectId?.get(rec.OBJECT_ID);
              const baseBrightness = brightnessBucket(magnitude);
              perNight[wi].push({
                ...gp,
                satName: rec.OBJECT_NAME,
                objectId: rec.OBJECT_ID,
                noradId: rec.NORAD_CAT_ID,
                magnitude,
                brightness: train ? boostBrightness(baseBrightness) : baseBrightness,
                ...(train ? { train } : {}),
              });
            }
          }
        }
      }
      done += 1;
    }
    onProgress?.(done, total);
    // UI スレッドに制御を返す(メインスレッド実行のための刻み)
    await yieldToEventLoop();
  }
  return windows.map((window, wi) => ({
    date: nightDate(window),
    window,
    passes: selectTopPasses(perNight[wi]),
  }));
}

/** 予報キャッシュ(地点+データ取得時刻でキー化。再計算の回避のみが目的) */
export function forecastCacheKey(obs: Observer, fetchedAt: number): string {
  return `${obs.lat.toFixed(4)},${obs.lon.toFixed(4)}:${fetchedAt}`;
}

export function saveForecastCache(
  key: string,
  nights: NightForecast[],
): boolean {
  return safeSetItem(FORECAST_STORAGE_KEY, JSON.stringify({ key, nights }));
}

function reviveDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** groupId は launchGroupId(train.ts)が返す "YYYY-NNN" 形式そのもの */
const GROUP_ID_RE = /^\d{4}-\d{3}$/;

/** train フィールドの復元。無ければ undefined(トレインでないパス)、壊れていれば「不正」を示す symbol */
const TRAIN_INVALID = Symbol("train-invalid");
function reviveTrain(v: unknown): TrainInfo | undefined | typeof TRAIN_INVALID {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) return TRAIN_INVALID;
  const t = v as Record<string, unknown>;
  if (typeof t.groupId !== "string" || !GROUP_ID_RE.test(t.groupId)) return TRAIN_INVALID;
  const days = t.daysSinceDetected;
  if (days !== null && !(typeof days === "number" && Number.isInteger(days) && days >= 0)) {
    return TRAIN_INVALID;
  }
  return { groupId: t.groupId, daysSinceDetected: days };
}

function revivePass(raw: unknown): VisiblePass | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const startTime = reviveDate(v.startTime);
  const maxTime = reviveDate(v.maxTime);
  const endTime = reviveDate(v.endTime);
  if (!startTime || !maxTime || !endTime) return null;
  if (typeof v.satName !== "string" || typeof v.objectId !== "string") return null;
  const nums = [
    v.noradId,
    v.startAzDeg,
    v.maxAzDeg,
    v.endAzDeg,
    v.startElDeg,
    v.endElDeg,
    v.maxElevationDeg,
    v.rangeAtMaxKm,
    v.magnitude,
  ];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (v.brightness !== 1 && v.brightness !== 2 && v.brightness !== 3) return null;
  const train = reviveTrain(v.train);
  if (train === TRAIN_INVALID) return null;
  return {
    satName: v.satName,
    objectId: v.objectId,
    noradId: v.noradId as number,
    startTime,
    maxTime,
    endTime,
    startAzDeg: v.startAzDeg as number,
    maxAzDeg: v.maxAzDeg as number,
    endAzDeg: v.endAzDeg as number,
    startElDeg: v.startElDeg as number,
    endElDeg: v.endElDeg as number,
    maxElevationDeg: v.maxElevationDeg as number,
    rangeAtMaxKm: v.rangeAtMaxKm as number,
    magnitude: v.magnitude as number,
    brightness: v.brightness,
    ...(train !== undefined ? { train } : {}),
  };
}

export function loadForecastCache(key: string): NightForecast[] | null {
  const raw = safeGetItem(FORECAST_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (v.key !== key) return null;
  if (!Array.isArray(v.nights)) return null;
  const nights: NightForecast[] = [];
  for (const rawNight of v.nights) {
    if (typeof rawNight !== "object" || rawNight === null) return null;
    const n = rawNight as Record<string, unknown>;
    const date = reviveDate(n.date);
    const win = n.window as Record<string, unknown> | null;
    const start = win ? reviveDate(win.start) : null;
    const end = win ? reviveDate(win.end) : null;
    if (!date || !start || !end || !Array.isArray(n.passes)) return null;
    const passes: VisiblePass[] = [];
    for (const rawPass of n.passes) {
      const pass = revivePass(rawPass);
      if (pass === null) return null;
      passes.push(pass);
    }
    nights.push({ date, window: { start, end }, passes });
  }
  return nights;
}
