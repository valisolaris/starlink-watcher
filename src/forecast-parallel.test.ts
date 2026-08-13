// 予報計算の Worker 並列化(forecast-parallel.ts)のテスト。
// jsdom には Worker が存在しないため、実 Worker は通らない。ここでは
// (a) 分割・集約・進捗・ワーカー数決定を純関数として、
// (b) 並列経路そのものを偽 Worker の注入で、
// (c) ペイロードの構造化複製可能性を structuredClone で
// 検証する。バンドル・MIME・Safari 差は実機でしか出ないため実機確認は別途行う。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Brightness } from "./astro.ts";
import { type GpRecord } from "./gp.ts";
import {
  computeForecast,
  planNightScan,
  selectTopPasses,
  shardPasses,
  type NightForecast,
  type TrainInfo,
  type VisiblePass,
} from "./passes.ts";
import {
  computeForecastFast,
  createProgressTracker,
  mergeShardNights,
  planShards,
  resolveWorkerCount,
  MIN_RECORDS_FOR_WORKERS,
  WORKER_COUNT_FALLBACK,
  WORKER_COUNT_MAX,
  type ShardRequest,
  type ShardResponse,
  type WorkerLike,
} from "./forecast-parallel.ts";

const TOKYO = { lat: 35.68, lon: 139.69 };
/** JST 正午。夜窓が now でクランプされない時刻を選ぶ(結果一致の比較を安定させる) */
const NOON_JST = new Date("2026-08-10T03:00:00Z");

/** 軌道面と位相をずらした合成 GP。実計算を通すのでパスが出る程度の規模に留める */
function synthRecords(count: number): GpRecord[] {
  const out: GpRecord[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      OBJECT_NAME: `STARLINK-SYNTH-${i}`,
      OBJECT_ID: `2026-${String(100 + i).padStart(3, "0")}A`,
      NORAD_CAT_ID: 90000 + i,
      EPOCH: "2026-08-09T12:00:00.000000",
      MEAN_MOTION: 15.06,
      ECCENTRICITY: 0.0001,
      INCLINATION: 53.05,
      RA_OF_ASC_NODE: (i * 45) % 360,
      ARG_OF_PERICENTER: 90,
      MEAN_ANOMALY: (i * 37) % 360,
      BSTAR: 0.0003,
    });
  }
  return out;
}

let passSeq = 0;
function mkPass(over: Partial<VisiblePass> = {}): VisiblePass {
  passSeq += 1;
  const base = Date.UTC(2026, 7, 10, 11, 0, 0) + passSeq * 20 * 60 * 1000;
  return {
    satName: `SAT-${passSeq}`,
    objectId: `2026-${String(passSeq).padStart(3, "0")}A`,
    noradId: 90000 + passSeq,
    startTime: new Date(base),
    maxTime: new Date(base + 3 * 60 * 1000),
    endTime: new Date(base + 6 * 60 * 1000),
    startAzDeg: 225,
    maxAzDeg: 180,
    endAzDeg: 135,
    startElDeg: 12,
    endElDeg: 11,
    maxElevationDeg: 42.4,
    rangeAtMaxKm: 700,
    magnitude: 4.0,
    brightness: 2 as Brightness,
    ...over,
  };
}

type FakeMode = "ok" | "error" | "silent" | "messageerror";

/**
 * 偽 Worker。postMessage されたリクエストを structuredClone してから
 * 実際に shardPasses を回すので、SatRec のような複製不可の値が紛れ込めば
 * ここで例外になる(= 実 Worker と同じ制約を課している)。
 */
class FakeWorker implements WorkerLike {
  terminated = false;
  postCount = 0;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(private mode: FakeMode = "ok") {}

  postMessage(message: unknown): void {
    this.postCount += 1;
    if (this.mode === "silent") return;
    const req = structuredClone(message) as ShardRequest;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.mode === "error") {
        this.emit("error", { message: "fake worker failed" });
        return;
      }
      if (this.mode === "messageerror") {
        this.emit("messageerror", { message: "uncloneable" });
        return;
      }
      const gen = shardPasses({
        records: req.records,
        obs: req.obs,
        plan: req.plan,
        trainInfoByObjectId: req.trainInfoByObjectId,
      });
      let step = gen.next();
      while (!step.done) {
        if (this.terminated) return;
        const msg: ShardResponse = {
          type: "progress",
          shardIndex: req.shardIndex,
          done: step.value.done,
          total: step.value.total,
        };
        this.emit("message", { data: msg });
        step = gen.next();
      }
      if (this.terminated) return;
      const done: ShardResponse = {
        type: "result",
        shardIndex: req.shardIndex,
        perNight: structuredClone(step.value),
      };
      this.emit("message", { data: done });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (ev: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (ev: unknown) => void);
    this.listeners.set(type, list);
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

/**
 * 応答を遅延させる偽 Worker。素の FakeWorker は queueMicrotask で同期完走するため
 * 到着順が常にシャード番号順と一致してしまい、「到着順に連結する」退行を検出できない。
 */
class DelayedFakeWorker extends FakeWorker {
  constructor(private readonly delayMs: number) {
    super("ok");
  }

  override postMessage(message: unknown): void {
    setTimeout(() => {
      if (!this.terminated) super.postMessage(message);
    }, this.delayMs);
  }
}

/** 最初の1通だけ返してその後黙り込む偽 Worker(起動は成功するが完走しない) */
class StallingFakeWorker implements WorkerLike {
  terminated = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  postMessage(message: unknown): void {
    const req = structuredClone(message) as ShardRequest;
    queueMicrotask(() => {
      if (this.terminated) return;
      const msg: ShardResponse = {
        type: "progress",
        shardIndex: req.shardIndex,
        done: 0,
        total: req.records.length,
      };
      for (const l of this.listeners.get("message") ?? []) l({ data: msg });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (ev: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (ev: unknown) => void);
    this.listeners.set(type, list);
  }
}

/** 与えた ShardResponse をそのまま返す偽 Worker(error メッセージ経路の検証用) */
class ScriptedFakeWorker implements WorkerLike {
  terminated = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(private readonly reply: (req: ShardRequest) => ShardResponse | "messageerror") {}

  postMessage(message: unknown): void {
    const req = structuredClone(message) as ShardRequest;
    queueMicrotask(() => {
      if (this.terminated) return;
      const out = this.reply(req);
      if (out === "messageerror") {
        for (const l of this.listeners.get("messageerror") ?? []) l({ type: "messageerror" });
        return;
      }
      for (const l of this.listeners.get("message") ?? []) l({ data: out });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (ev: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (ev: unknown) => void);
    this.listeners.set(type, list);
  }
}

beforeEach(() => {
  localStorage.clear();
  passSeq = 0;
});

describe("resolveWorkerCount", () => {
  it("uses hardwareConcurrency when it is available", () => {
    expect(resolveWorkerCount(10000, 8)).toBe(8);
    expect(resolveWorkerCount(10000, 4)).toBe(4);
  });

  it("falls back to a fixed count when hardwareConcurrency is unknown", () => {
    expect(resolveWorkerCount(10000, undefined)).toBe(WORKER_COUNT_FALLBACK);
  });

  it("clamps to WORKER_COUNT_MAX and never returns less than 1", () => {
    expect(resolveWorkerCount(10000, 64)).toBe(WORKER_COUNT_MAX);
    expect(resolveWorkerCount(10000, 1)).toBe(1);
    expect(resolveWorkerCount(10000, 0)).toBe(1);
  });

  it("returns 1 below the parallelization threshold", () => {
    expect(resolveWorkerCount(MIN_RECORDS_FOR_WORKERS - 1, 8)).toBe(1);
    expect(resolveWorkerCount(0, 8)).toBe(1);
  });
});

describe("planShards", () => {
  it("splits into contiguous non-overlapping ranges covering everything", () => {
    const shards = planShards(100, 3);
    expect(shards[0].start).toBe(0);
    expect(shards[shards.length - 1].end).toBe(100);
    for (let i = 1; i < shards.length; i++) {
      expect(shards[i].start).toBe(shards[i - 1].end);
    }
  });

  it("keeps shard sizes within 1 of each other", () => {
    const sizes = planShards(100, 3).map((s) => s.end - s.start);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("never produces empty shards when records are fewer than workers", () => {
    const shards = planShards(3, 8);
    expect(shards).toHaveLength(3);
    for (const s of shards) expect(s.end - s.start).toBeGreaterThan(0);
  });

  it("returns an empty list for zero records", () => {
    expect(planShards(0, 4)).toEqual([]);
  });
});

describe("mergeShardNights", () => {
  it("concatenates per night in shard index order, not arrival order", () => {
    const a = mkPass({ satName: "shard0" });
    const b = mkPass({ satName: "shard1" });
    const c = mkPass({ satName: "shard2" });
    const merged = mergeShardNights(2, [[[a], []], [[b], []], [[c], []]]);
    expect(merged).toHaveLength(2);
    expect(merged[0].map((p) => p.satName)).toEqual(["shard0", "shard1", "shard2"]);
    expect(merged[1]).toEqual([]);
  });

  it("returns an empty array when there are no nights", () => {
    expect(mergeShardNights(0, [[], []])).toEqual([]);
  });

  // 選抜のタイブレークは配列内の先着が勝つ(selectTopPasses が安定ソートに依存)。
  // シャード分割で並び順が変わると選抜結果が静かに変わるため、不変条件として凍結する。
  it("preserves the sequential ordering that selectTopPasses tie-breaks on", () => {
    const tie = { brightness: 3 as Brightness, maxElevationDeg: 80 };
    const seq = [
      mkPass({ satName: "s0-a", ...tie }),
      mkPass({ satName: "s0-b", ...tie }),
      mkPass({ satName: "s1-a", ...tie }),
      mkPass({ satName: "s1-b", ...tie }),
      mkPass({ satName: "s2-a", ...tie }),
    ];
    const sharded = mergeShardNights(1, [
      [[seq[0], seq[1]]],
      [[seq[2], seq[3]]],
      [[seq[4]]],
    ]);
    expect(sharded[0]).toEqual(seq);
    expect(selectTopPasses(sharded[0])).toEqual(selectTopPasses(seq));
  });
});

describe("createProgressTracker", () => {
  it("reports a monotonically non-decreasing done across shards", () => {
    const seen: Array<[number, number]> = [];
    const tracker = createProgressTracker([10, 10, 10], (done, total) => seen.push([done, total]));
    tracker.report(1, 3, 10);
    tracker.report(0, 5, 10);
    tracker.report(2, 2, 10);
    tracker.report(1, 7, 10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
    }
    expect(seen[seen.length - 1][0]).toBe(5 + 7 + 2);
  });

  it("never lets the reported ratio go backwards when real totals arrive", () => {
    const ratios: number[] = [];
    // 割当は 10 件ずつだが、実 satrec 数は 8/9/10 と少ない(gpToSatrec の失敗分)
    const tracker = createProgressTracker([10, 10, 10], (done, total) => {
      ratios.push(total === 0 ? 0 : done / total);
    });
    tracker.report(0, 4, 8);
    tracker.report(1, 4, 9);
    tracker.report(2, 4, 10);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    }
  });

  it("ends at done === total when every shard completes", () => {
    const seen: Array<[number, number]> = [];
    const tracker = createProgressTracker([10, 10], (done, total) => seen.push([done, total]));
    tracker.report(0, 10, 10);
    tracker.report(1, 9, 9);
    const [lastDone, lastTotal] = seen[seen.length - 1];
    expect(lastDone).toBe(lastTotal);
    expect(lastDone).toBe(19);
  });
});

describe("worker payload structured cloning", () => {
  it("clones a ShardRequest without losing Date or Map identity", () => {
    const plan = planNightScan(NOON_JST, TOKYO);
    const trains = new Map<string, TrainInfo>([
      ["2026-100A", { groupId: "2026-142", daysSinceDetected: 3 }],
    ]);
    const req: ShardRequest = {
      shardIndex: 0,
      records: synthRecords(2),
      obs: TOKYO,
      plan,
      trainInfoByObjectId: trains,
    };
    const cloned = structuredClone(req);
    expect(cloned.plan.windows[0].start).toBeInstanceOf(Date);
    expect(cloned.plan.windows[0].start.getTime()).toBe(plan.windows[0].start.getTime());
    expect(cloned.trainInfoByObjectId).toBeInstanceOf(Map);
    expect(cloned.trainInfoByObjectId?.get("2026-100A")?.groupId).toBe("2026-142");
    expect(cloned.records).toHaveLength(2);
  });

  it("clones a ShardResponse result with Date fields intact", () => {
    const res: ShardResponse = {
      type: "result",
      shardIndex: 1,
      perNight: [[mkPass()], []],
    };
    const cloned = structuredClone(res);
    if (cloned.type !== "result") throw new Error("unexpected response type");
    expect(cloned.perNight[0][0].maxTime).toBeInstanceOf(Date);
    expect(cloned.perNight[0][0].maxTime.getTime()).toBe(
      (res as { perNight: VisiblePass[][] }).perNight[0][0].maxTime.getTime(),
    );
  });
});

describe("computeForecastFast with injected fake workers", () => {
  it("produces the same forecast as the main-thread computeForecast", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 3,
      createWorker: () => new FakeWorker("ok"),
    });
    expect(actual).toEqual(expected);
  });

  it("keeps train brightness boosts that are applied before selection", async () => {
    const records = synthRecords(8);
    const trains = new Map<string, TrainInfo>(
      records.map((r) => [r.OBJECT_ID, { groupId: "2026-142", daysSinceDetected: 2 }]),
    );
    const expected = await computeForecast(records, TOKYO, NOON_JST, undefined, trains);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, trains, {
      workerCount: 3,
      createWorker: () => new FakeWorker("ok"),
    });
    expect(actual).toEqual(expected);
  });

  it("reports progress that ends at done === total", async () => {
    const records = synthRecords(8);
    const seen: Array<[number, number]> = [];
    await computeForecastFast(
      records,
      TOKYO,
      NOON_JST,
      (done, total) => seen.push([done, total]),
      undefined,
      { workerCount: 3, createWorker: () => new FakeWorker("ok") },
    );
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
    }
    const [lastDone, lastTotal] = seen[seen.length - 1];
    expect(lastDone).toBe(lastTotal);
  });
});

describe("computeForecastFast fallback paths", () => {
  it("falls back to the main thread when a worker errors, and terminates every worker", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const spawned: FakeWorker[] = [];
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 3,
      createWorker: (i) => {
        const w = new FakeWorker(i === 1 ? "error" : "ok");
        spawned.push(w);
        return w;
      },
    });
    expect(actual).toEqual(expected);
    expect(spawned.length).toBeGreaterThan(0);
    for (const w of spawned) expect(w.terminated).toBe(true);
  });

  it("falls back when worker creation throws", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 3,
      createWorker: () => {
        throw new Error("spawn refused");
      },
    });
    expect(actual).toEqual(expected);
  });

  it("falls back when no worker reports back before the startup timeout", async () => {
    vi.useFakeTimers();
    try {
      const records = synthRecords(8);
      const spawned: FakeWorker[] = [];
      const promise = computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
        workerCount: 2,
        startupTimeoutMs: 1000,
        createWorker: () => {
          const w = new FakeWorker("silent");
          spawned.push(w);
          return w;
        },
      });
      await vi.advanceTimersByTimeAsync(1500);
      const actual = await promise;
      expect(actual).toHaveLength(5);
      for (const w of spawned) expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the main thread when Worker is undefined (the jsdom default path)", async () => {
    expect(typeof Worker).toBe("undefined");
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST);
    expect(actual).toEqual(expected);
  });
});

describe("computeForecastFast cancellation", () => {
  it("terminates workers and rejects when the signal is aborted", async () => {
    const records = synthRecords(8);
    const controller = new AbortController();
    const spawned: FakeWorker[] = [];
    const promise = computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 2,
      signal: controller.signal,
      createWorker: () => {
        const w = new FakeWorker("silent");
        spawned.push(w);
        return w;
      },
    });
    controller.abort();
    // 「未実装の throw」でも reject はするので、abort 由来であることまで確かめる
    await expect(promise).rejects.toThrow(/abort/i);
    expect(spawned.length).toBeGreaterThan(0);
    for (const w of spawned) expect(w.terminated).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const records = synthRecords(8);
    const controller = new AbortController();
    controller.abort();
    const spawned: FakeWorker[] = [];
    await expect(
      computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
        signal: controller.signal,
        workerCount: 2,
        createWorker: () => {
          const w = new FakeWorker("ok");
          spawned.push(w);
          return w;
        },
      }),
    ).rejects.toThrow(/abort/i);
    // 既に中断されているならワーカーを立ち上げてすらいけない
    expect(spawned).toHaveLength(0);
  });
});

describe("shardPasses", () => {
  it("yields progress and returns pre-selection passes per night", () => {
    const plan = planNightScan(NOON_JST, TOKYO);
    const gen = shardPasses({ records: synthRecords(4), obs: TOKYO, plan });
    const progress: Array<[number, number]> = [];
    let step = gen.next();
    while (!step.done) {
      progress.push([step.value.done, step.value.total]);
      step = gen.next();
    }
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0][0]).toBe(0);
    expect(progress[progress.length - 1][0]).toBe(progress[progress.length - 1][1]);
    expect(step.value).toHaveLength(plan.windows.length);
  });

  it("does not apply the top-3 selection (selection happens after merging)", () => {
    const plan = planNightScan(NOON_JST, TOKYO);
    const gen = shardPasses({ records: synthRecords(8), obs: TOKYO, plan });
    let step = gen.next();
    while (!step.done) step = gen.next();
    const perNight = step.value;
    const total = perNight.reduce((a, n) => a + n.length, 0);
    // 選抜済みなら 3 * 夜数 が上限になる。選抜前ならそれを超えるか、
    // 少なくとも selectTopPasses を通した結果と件数が変わりうる
    const selected = perNight.reduce((a, n) => a + selectTopPasses(n).length, 0);
    expect(total).toBeGreaterThanOrEqual(selected);
  });
});

describe("planNightScan", () => {
  it("returns windows with their dark scan segments", () => {
    const plan = planNightScan(NOON_JST, TOKYO);
    expect(plan.windows).toHaveLength(5);
    expect(plan.segmentsPerNight).toHaveLength(5);
    for (let i = 0; i < plan.windows.length; i++) {
      for (const seg of plan.segmentsPerNight[i]) {
        expect(seg.start.getTime()).toBeGreaterThanOrEqual(plan.windows[i].start.getTime());
        expect(seg.end.getTime()).toBeLessThanOrEqual(plan.windows[i].end.getTime());
      }
    }
  });

  it("returns empty plans at the poles where no night window exists", () => {
    const plan = planNightScan(NOON_JST, { lat: 89, lon: 0 });
    expect(plan.windows).toEqual([]);
    expect(plan.segmentsPerNight).toEqual([]);
  });
});

describe("computeForecastFast shard ordering (regression guard)", () => {
  // 設計上いちばん壊れやすい不変条件: 結果は「到着順」ではなく「シャード番号順」に連結する。
  // 素の FakeWorker では到着順とシャード順が一致してしまうため、逆順で返させて固定する。
  it("merges by shard index even when shards finish in reverse order", async () => {
    const records = synthRecords(9);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const order: number[] = [];
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 3,
      createWorker: (i) => {
        order.push(i);
        // shard 0 が最も遅く返る
        return new DelayedFakeWorker((3 - i) * 40);
      },
    });
    expect(order).toEqual([0, 1, 2]);
    expect(actual).toEqual(expected);
  });
});

describe("computeForecastFast worker-reported failures", () => {
  it("falls back when a worker replies with an error message", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const spawned: ScriptedFakeWorker[] = [];
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 2,
      createWorker: (i) => {
        const w = new ScriptedFakeWorker((req) =>
          i === 0
            ? { type: "error", shardIndex: req.shardIndex, message: "sgp4 exploded" }
            : { type: "result", shardIndex: req.shardIndex, perNight: [] },
        );
        spawned.push(w);
        return w;
      },
    });
    expect(actual).toEqual(expected);
    for (const w of spawned) expect(w.terminated).toBe(true);
  });

  it("falls back on a messageerror event", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 2,
      createWorker: () => new ScriptedFakeWorker(() => "messageerror"),
    });
    expect(actual).toEqual(expected);
  });

  // 集約(mergeShardNights/assembleNights)で例外が出ても、Promise を宙吊りにせず退避すること。
  // 宙吊りになるとローディング表示のまま復帰不能になる(エラーUIも再試行も出ない)。
  it("falls back instead of hanging when a worker returns a malformed result", async () => {
    const records = synthRecords(8);
    const expected = await computeForecast(records, TOKYO, NOON_JST);
    const actual = await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
      workerCount: 2,
      createWorker: () =>
        new ScriptedFakeWorker((req) => ({
          type: "result",
          shardIndex: req.shardIndex,
          // 夜配列であるべきところに反復不可能な値を返す(集約の push スプレッドで例外になる)
          perNight: [42 as unknown as VisiblePass[]],
        })),
    });
    expect(actual).toEqual(expected);
  });

  it("falls back when workers start but then go silent", async () => {
    vi.useFakeTimers();
    try {
      const records = synthRecords(8);
      const spawned: StallingFakeWorker[] = [];
      const promise = computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
        workerCount: 2,
        startupTimeoutMs: 1000,
        stallTimeoutMs: 2000,
        createWorker: () => {
          const w = new StallingFakeWorker();
          spawned.push(w);
          return w;
        },
      });
      await vi.advanceTimersByTimeAsync(3000);
      const actual = await promise;
      expect(actual).toHaveLength(5);
      for (const w of spawned) expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the main-thread fallback exactly once", async () => {
    const records = synthRecords(8);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await computeForecastFast(records, TOKYO, NOON_JST, undefined, undefined, {
        workerCount: 3,
        createWorker: () => new FakeWorker("error"),
      });
      const modes = info.mock.calls.map((c) => String(c[1]));
      expect(modes.filter((m) => m.startsWith("main"))).toHaveLength(1);
      expect(modes.filter((m) => m === "worker")).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });
});

describe("progress continuity across the fallback boundary", () => {
  // Worker で 40% まで進んだ後にメインスレッドへ退避すると、退避側は 0% から報告し直す。
  // 生の値をそのまま流すとバーが巻き戻り「やり直した」ように見えるため、比率を単調に保つ。
  it("never reports a ratio lower than one already shown", async () => {
    const records = synthRecords(8);
    const ratios: number[] = [];
    await computeForecastFast(
      records,
      TOKYO,
      NOON_JST,
      (done, total) => {
        if (total > 0) ratios.push(done / total);
      },
      undefined,
      {
        workerCount: 2,
        // 進捗をいくらか流してからエラーにする
        createWorker: (i) =>
          i === 0
            ? new FakeWorker("ok")
            : new ScriptedFakeWorker((req) => ({
                type: "error",
                shardIndex: req.shardIndex,
                message: "died mid-run",
              })),
      },
    );
    expect(ratios.length).toBeGreaterThan(0);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    }
    expect(ratios[ratios.length - 1]).toBe(1);
  });
});

describe("computeForecast abort support", () => {
  // 退避経路(メインスレッド計算)は実測 47 秒かかる。ここで中断できないと、
  // 地点を変えるたびに古い計算が走り続けて CPU を奪い合う。
  it("stops the main-thread computation when the signal is aborted", async () => {
    const controller = new AbortController();
    const records = synthRecords(200);
    let seen = 0;
    const promise = computeForecast(
      records,
      TOKYO,
      NOON_JST,
      () => {
        seen += 1;
        if (seen === 2) controller.abort();
      },
      undefined,
      controller.signal,
    );
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it("completes normally when the signal is never aborted", async () => {
    const controller = new AbortController();
    const records = synthRecords(4);
    const withSignal = await computeForecast(
      records,
      TOKYO,
      NOON_JST,
      undefined,
      undefined,
      controller.signal,
    );
    const withoutSignal = await computeForecast(records, TOKYO, NOON_JST);
    expect(withSignal).toEqual(withoutSignal);
  });
});

// 型だけ使う参照(NightForecast を明示的に扱わないテストでも import を保つ)
void (null as NightForecast[] | null);
