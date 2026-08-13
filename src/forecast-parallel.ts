// 予報計算の Web Worker 並列化(オーケストレーション層)。
// 計算そのものは passes.ts の shardPasses が持ち、本モジュールは
// 「衛星をどう分けて配り、どう集約し、失敗したらどう退避するか」だけを受け持つ。
import type { Observer } from "./astro.ts";
import type { GpRecord } from "./gp.ts";
import {
  assembleNights,
  computeForecast,
  forecastAbortError,
  planNightScan,
  type NightForecast,
  type NightScanPlan,
  type TrainInfo,
  type VisiblePass,
} from "./passes.ts";

/** 1シャードが担当する records の範囲 [start, end)。連続スライスであることが結果一致の前提 */
export interface ShardRange {
  start: number;
  end: number;
}

/** メイン → Worker。すべて構造化複製可能でなければならない */
export interface ShardRequest {
  shardIndex: number;
  records: GpRecord[];
  obs: Observer;
  plan: NightScanPlan;
  trainInfoByObjectId?: Map<string, TrainInfo>;
}

/** Worker → メイン */
export type ShardResponse =
  | { type: "progress"; shardIndex: number; done: number; total: number }
  | { type: "result"; shardIndex: number; perNight: VisiblePass[][] }
  | { type: "error"; shardIndex: number; message: string };

/** テストから偽 Worker を注入できるよう、実 Worker の必要最小面だけを型にする */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (ev: { data: ShardResponse }) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (ev: unknown) => void): void;
}

/** Worker を使わずメインスレッドで計算した理由 */
export type FallbackReason =
  | "no-worker"
  | "spawn-failed"
  | "worker-error"
  | "timeout"
  | "below-threshold";

export interface ComputeForecastFastOptions {
  workerCount?: number;
  createWorker?: (index: number) => WorkerLike;
  /** 全 Worker が最初の1通を返すまでの猶予(ms) */
  startupTimeoutMs?: number;
  /** 最後のメッセージから次が来るまでの猶予(ms)。黙って死んだ Worker を検出する */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
}

/** 既定のワーカー数(navigator.hardwareConcurrency が読めないとき) */
export const WORKER_COUNT_FALLBACK = 4;
/** ワーカー数の上限。クローン量とメモリのため頭打ちにする */
export const WORKER_COUNT_MAX = 8;
/** これ未満の衛星数では並列化のオーバーヘッドが上回るためメインスレッドで計算する */
export const MIN_RECORDS_FOR_WORKERS = 200;
/** 起動ウォッチドッグの既定値(ms) */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
/**
 * 無音ウォッチドッグの既定値(ms)。shardPasses は 50 機ごとに進捗を返すため、
 * 正常時にこれほど間隔が開くことはない。OS にメモリ圧で回収された Worker は
 * error イベントを出さずに黙って消えるので、これが唯一の検出手段になる。
 */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;

export function resolveWorkerCount(
  recordCount: number,
  hardwareConcurrency?: number,
): number {
  if (recordCount < MIN_RECORDS_FOR_WORKERS) return 1;
  const hc =
    typeof hardwareConcurrency === "number" && Number.isFinite(hardwareConcurrency)
      ? Math.floor(hardwareConcurrency)
      : WORKER_COUNT_FALLBACK;
  return Math.max(1, Math.min(WORKER_COUNT_MAX, hc));
}

/** records を連続スライスへ分割する。空シャードは作らない */
export function planShards(recordCount: number, shardCount: number): ShardRange[] {
  if (recordCount <= 0) return [];
  const n = Math.max(1, Math.min(Math.floor(shardCount), recordCount));
  const base = Math.floor(recordCount / n);
  const remainder = recordCount % n;
  const ranges: ShardRange[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + base + (i < remainder ? 1 : 0);
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

/**
 * シャードごとの「選抜前」夜別パスを、シャード番号順に連結する。
 * selectTopPasses が安定ソートのタイブレーク(配列内の先着が勝つ)に依存しているため、
 * 到着順ではなくシャード番号順で連結しなければ逐次実行と結果が一致しない。
 */
export function mergeShardNights(
  nightCount: number,
  perShard: Array<VisiblePass[][] | null>,
): VisiblePass[][] {
  const merged: VisiblePass[][] = [];
  for (let wi = 0; wi < nightCount; wi++) {
    const night: VisiblePass[] = [];
    for (const shard of perShard) {
      const passes = shard?.[wi];
      if (passes) night.push(...passes);
    }
    merged.push(night);
  }
  return merged;
}

export interface ProgressTracker {
  /** シャードからの進捗を取り込み、集計値を onProgress へ流す */
  report(shardIndex: number, done: number, total: number): void;
}

/**
 * 各シャードの done/total を合算する。total の初期値は「割当レコード数」(上限値)で、
 * 実 satrec 数が届くと減る方向にしか動かないため、パーセントが逆行しない。
 */
export function createProgressTracker(
  assignedCounts: number[],
  onProgress?: (done: number, total: number) => void,
): ProgressTracker {
  const doneByShard = assignedCounts.map(() => 0);
  const totalByShard = [...assignedCounts];
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    report(shardIndex, done, total) {
      if (shardIndex < 0 || shardIndex >= doneByShard.length) return;
      doneByShard[shardIndex] = done;
      totalByShard[shardIndex] = total;
      onProgress?.(sum(doneByShard), sum(totalByShard));
    },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Worker 経路の失敗。理由を持ち回してメインスレッドへ退避する */
class WorkerFallback extends Error {
  constructor(readonly reason: FallbackReason) {
    super(`worker fallback: ${reason}`);
    this.name = "WorkerFallback";
  }
}

function readHardwareConcurrency(): number | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
}

/** 実測用の恒久ログ。cp932 を壊さないため ASCII のみで出す */
function logMode(mode: string, workers: number, sats: number, ms: number): void {
  console.info("[forecast] mode=%s workers=%d sats=%d ms=%d", mode, workers, sats, ms);
}

/**
 * computeForecast と同じ結果を、Web Worker へ分散して計算する。
 * Worker が使えない・起動に失敗した場合はメインスレッド版(computeForecast)へ退避する。
 */
export async function computeForecastFast(
  records: GpRecord[],
  obs: Observer,
  now: Date,
  onProgress?: (done: number, total: number) => void,
  trainInfoByObjectId?: Map<string, TrainInfo>,
  opts?: ComputeForecastFastOptions,
): Promise<NightForecast[]> {
  const signal = opts?.signal;
  if (signal?.aborted) throw forecastAbortError();
  const startedAt = Date.now();

  // 経路が Worker からメインへ切り替わると、退避側は進捗を 0 から報告し直す。
  // 生の値をそのまま流すとバーが巻き戻って「やり直した」ように見えるため、
  // 表示済みの位置を下限にし、残りを新しい経路の進捗で埋める形に写像する。
  let reportedRatio = 0;
  let segmentBase = 0;
  const report = onProgress
    ? (done: number, total: number): void => {
        if (total <= 0) {
          onProgress(done, total);
          return;
        }
        const scaled = segmentBase + (1 - segmentBase) * (done / total);
        reportedRatio = Math.max(reportedRatio, scaled);
        onProgress(Math.round(reportedRatio * total), total);
      }
    : undefined;

  const runOnMainThread = async (reason: FallbackReason): Promise<NightForecast[]> => {
    segmentBase = reportedRatio;
    const nights = await computeForecast(records, obs, now, report, trainInfoByObjectId, signal);
    logMode(`main reason=${reason}`, 0, records.length, Date.now() - startedAt);
    return nights;
  };

  const workerCount =
    opts?.workerCount ?? resolveWorkerCount(records.length, readHardwareConcurrency());
  if (workerCount <= 1) return runOnMainThread("below-threshold");

  let spawn = opts?.createWorker;
  if (!spawn) {
    if (typeof Worker === "undefined") return runOnMainThread("no-worker");
    try {
      const mod = await import("./forecast-worker-spawn.ts");
      spawn = mod.createForecastWorker;
    } catch {
      return runOnMainThread("spawn-failed");
    }
    // 動的 import の間に地点が変わっている可能性がある
    if (signal?.aborted) throw forecastAbortError();
  }

  try {
    const nights = await runWorkerPool({
      records,
      obs,
      now,
      onProgress: report,
      trainInfoByObjectId,
      spawn,
      workerCount,
      startupTimeoutMs: opts?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      stallTimeoutMs: opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      signal,
    });
    logMode("worker", workerCount, records.length, Date.now() - startedAt);
    return nights;
  } catch (err) {
    if (isAbortError(err)) throw err;
    const reason = err instanceof WorkerFallback ? err.reason : "worker-error";
    return runOnMainThread(reason);
  }
}

interface WorkerPoolInput {
  records: GpRecord[];
  obs: Observer;
  now: Date;
  onProgress?: (done: number, total: number) => void;
  trainInfoByObjectId?: Map<string, TrainInfo>;
  spawn: (index: number) => WorkerLike;
  workerCount: number;
  startupTimeoutMs: number;
  stallTimeoutMs: number;
  signal?: AbortSignal;
}

function runWorkerPool(input: WorkerPoolInput): Promise<NightForecast[]> {
  const { records, obs, now, onProgress, trainInfoByObjectId, spawn, signal } = input;
  return new Promise<NightForecast[]>((resolve, reject) => {
    // now 依存の窓算出はここで1回だけ。各 Worker が計算し直すと窓境界がズレて結果が変わる
    const plan = planNightScan(now, obs);
    const shards = planShards(records.length, input.workerCount);
    if (shards.length === 0) {
      resolve(assembleNights(plan.windows, mergeShardNights(plan.windows.length, [])));
      return;
    }

    const workers: WorkerLike[] = [];
    const results: Array<VisiblePass[][] | null> = shards.map(() => null);
    const responded = shards.map(() => false);
    const tracker = createProgressTracker(
      shards.map((s) => s.end - s.start),
      onProgress,
    );
    let remaining = shards.length;
    let settled = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      signal?.removeEventListener("abort", onAbort);
      for (const w of workers) w.terminate();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (nights: NightForecast[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(nights);
    };
    function onAbort(): void {
      fail(forecastAbortError());
    }
    signal?.addEventListener("abort", onAbort);

    // 最後のメッセージから間が開きすぎたら失敗扱いにする。error イベントを伴わずに
    // Worker が消えるケース(OS によるメモリ回収など)は、これでしか検出できない。
    const touchStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail(new WorkerFallback("timeout")), input.stallTimeoutMs);
    };

    const handleMessage = (ev: { data: ShardResponse }): void => {
      if (settled) return;
      const msg = ev.data;
      if (msg.type === "progress") {
        responded[msg.shardIndex] = true;
        touchStall();
        tracker.report(msg.shardIndex, msg.done, msg.total);
        return;
      }
      if (msg.type === "result") {
        responded[msg.shardIndex] = true;
        touchStall();
        if (results[msg.shardIndex] === null) {
          results[msg.shardIndex] = msg.perNight;
          remaining -= 1;
        }
        if (remaining === 0) {
          // 集約は succeed の「引数」ではなくここで評価する。引数側で例外が出ると
          // settled も cleanup も走らないまま Promise が宙吊りになり、
          // ローディング表示のまま復帰不能になる(エラーUIも再試行も出ない)。
          let nights: NightForecast[];
          try {
            nights = assembleNights(
              plan.windows,
              mergeShardNights(plan.windows.length, results),
            );
          } catch {
            fail(new WorkerFallback("worker-error"));
            return;
          }
          succeed(nights);
        }
        return;
      }
      fail(new WorkerFallback("worker-error"));
    };

    try {
      for (let i = 0; i < shards.length; i++) {
        const worker = spawn(i);
        workers.push(worker);
        worker.addEventListener("message", handleMessage);
        worker.addEventListener("error", () => fail(new WorkerFallback("worker-error")));
        worker.addEventListener("messageerror", () => fail(new WorkerFallback("worker-error")));
        const request: ShardRequest = {
          shardIndex: i,
          records: records.slice(shards[i].start, shards[i].end),
          obs,
          plan,
          trainInfoByObjectId,
        };
        worker.postMessage(request);
      }
    } catch {
      fail(new WorkerFallback("spawn-failed"));
      return;
    }

    // 起動ウォッチドッグ。スクリプトのロード失敗が error で拾えない黙り込みに効く。
    // 計算途中の遅延では発火させないため、判定は「最初の1通が来たか」だけに限る。
    startupTimer = setTimeout(() => {
      if (!responded.every(Boolean)) fail(new WorkerFallback("timeout"));
    }, input.startupTimeoutMs);
  });
}
