// パス探索のワーカー本体。1リクエスト = 1シャードを計算し、進捗と結果を返す。
// 上位3件選抜はここでは行わない(全シャードを集約してからメインスレッドで1回だけ適用する)。
import { shardPasses } from "./passes.ts";
import type { ShardRequest, ShardResponse } from "./forecast-parallel.ts";

// DedicatedWorkerGlobalScope は本プロジェクトの tsconfig(lib: DOM)に存在しないため、
// lib を webworker へ足さず、必要な面だけを構造的に型付けする。
const ctx = self as unknown as {
  postMessage(message: ShardResponse): void;
  addEventListener(type: "message", listener: (ev: { data: ShardRequest }) => void): void;
};

ctx.addEventListener("message", (ev) => {
  const req = ev.data;
  try {
    const scan = shardPasses({
      records: req.records,
      obs: req.obs,
      plan: req.plan,
      trainInfoByObjectId: req.trainInfoByObjectId,
    });
    let step = scan.next();
    while (!step.done) {
      ctx.postMessage({
        type: "progress",
        shardIndex: req.shardIndex,
        done: step.value.done,
        total: step.value.total,
      });
      step = scan.next();
    }
    ctx.postMessage({ type: "result", shardIndex: req.shardIndex, perNight: step.value });
  } catch (err) {
    ctx.postMessage({
      type: "error",
      shardIndex: req.shardIndex,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
