// Worker の生成だけを持つモジュール。forecast-parallel.ts からは動的 import され、
// vitest(jsdom には Worker が無い)がこの new Worker(new URL(...)) 変換を踏まないよう分離している。
import type { WorkerLike } from "./forecast-parallel.ts";

export function createForecastWorker(): WorkerLike {
  const worker = new Worker(new URL("./forecast.worker.ts", import.meta.url), {
    type: "module",
  });
  // Worker の addEventListener はイベント型が広く WorkerLike と直接は噛み合わないため、
  // 必要な面だけを持つ型として扱う(実体はそのままの Worker)。
  return worker as unknown as WorkerLike;
}
