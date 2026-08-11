// build-snapshot.ts unit tests. Test names are ASCII to avoid cp932 console issues on Windows.
import { describe, expect, it, vi } from "vitest";
import { buildSnapshot } from "./build-snapshot.ts";

const RAW_RECORD = {
  OBJECT_NAME: "STARLINK-TEST",
  OBJECT_ID: "2026-001A",
  NORAD_CAT_ID: 99999,
  EPOCH: "2026-08-09T12:00:00.000000",
  MEAN_MOTION: 15.06,
  ECCENTRICITY: 0.0001,
  INCLINATION: 53.05,
  RA_OF_ASC_NODE: 120,
  ARG_OF_PERICENTER: 90,
  MEAN_ANOMALY: 0,
  BSTAR: 0.0003,
};

/** MIN_CATALOG_RECORDS(3000件)を満たす有効レコード列。3200件は plain のまま MAX_PLAIN_BYTES
 * (950KB)にも収まる(実測約252バイト/件 × 3200 ≈ 806KB)。 */
function bigRaw(n: number) {
  return Array.from({ length: n }, (_, i) => ({ ...RAW_RECORD, NORAD_CAT_ID: 90_000 + i }));
}

const HAPPY_PATH_COUNT = 3200;

function okFetch(payload: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => payload }));
}

function noopWriteFile() {
  const writes: Array<{ path: string; data: string | Uint8Array }> = [];
  const writeFile = async (path: string, data: string | Uint8Array) => {
    writes.push({ path, data });
  };
  return { writes, writeFile };
}

describe("buildSnapshot", () => {
  it("fetches CelesTrak, trims via parseGpJson, and writes a GpSnapshot-shaped file", async () => {
    const { writes, writeFile } = noopWriteFile();
    const result = await buildSnapshot({
      fetchFn: okFetch(bigRaw(HAPPY_PATH_COUNT)) as unknown as typeof fetch,
      now: 12345,
      writeFile,
      removeFile: async () => {},
      outDir: "public/data",
    });
    expect(writes).toHaveLength(1);
    expect(result.recordCount).toBe(HAPPY_PATH_COUNT);
    expect(result.compressed).toBe(false);
    expect(result.path).toBe("public/data/gp-snapshot.json");
    const written = JSON.parse(String(writes[0].data));
    expect(written.fetchedAt).toBe(12345);
    expect(written.records).toHaveLength(HAPPY_PATH_COUNT);
    expect(written.records[0].OBJECT_ID).toBe("2026-001A");
  });

  it("drops invalid records the same way parseGpJson does", async () => {
    const { writeFile } = noopWriteFile();
    const junk = Array.from({ length: 5 }, () => ({ junk: true }));
    const result = await buildSnapshot({
      fetchFn: okFetch([...bigRaw(HAPPY_PATH_COUNT), ...junk]) as unknown as typeof fetch,
      now: 1,
      writeFile,
      removeFile: async () => {},
      outDir: "public/data",
    });
    expect(result.recordCount).toBe(HAPPY_PATH_COUNT);
  });

  it("throws when the CelesTrak fetch fails (no fallback in CI)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(
      buildSnapshot({
        fetchFn: fetchFn as unknown as typeof fetch,
        now: 1,
        writeFile: async () => {},
        removeFile: async () => {},
        outDir: "public/data",
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("reports the actual byte size written", async () => {
    const { writes, writeFile } = noopWriteFile();
    const result = await buildSnapshot({
      fetchFn: okFetch(bigRaw(HAPPY_PATH_COUNT)) as unknown as typeof fetch,
      now: 1,
      writeFile,
      removeFile: async () => {},
      outDir: "public/data",
    });
    const expectedSize =
      typeof writes[0].data === "string"
        ? new TextEncoder().encode(writes[0].data).byteLength
        : writes[0].data.byteLength;
    expect(result.byteSize).toBe(expectedSize);
  });

  // codex重大指摘対応: 異常な200応答(空・不完全・スキーマ変化・カタログ規模からの大幅欠落)を
  // 正常スナップショットとしてcommitしない
  describe("response validation (codex critical)", () => {
    it("throws when the response has too few valid records (below GP_MIN_VALID_RECORDS)", async () => {
      await expect(
        buildSnapshot({
          fetchFn: okFetch(bigRaw(10)) as unknown as typeof fetch, // < GP_MIN_VALID_RECORDS(100)
          now: 1,
          writeFile: async () => {},
          removeFile: async () => {},
          outDir: "public/data",
        }),
      ).rejects.toThrow(/too few valid records/);
    });

    it("throws when most records fail validation (schema drift)", async () => {
      const junk = Array.from({ length: 200 }, () => ({ junk: true }));
      await expect(
        buildSnapshot({
          fetchFn: okFetch([...bigRaw(150), ...junk]) as unknown as typeof fetch,
          now: 1,
          writeFile: async () => {},
          removeFile: async () => {},
          outDir: "public/data",
        }),
      ).rejects.toThrow(/too few valid records/);
    });

    // codex重大指摘対応(再レビュー): スキーマ的には正常でも、実カタログ規模(実測約1.1万件)
    // から大幅に欠落した応答(有効率100%でも件数が激減)は別基準で弾く必要がある
    it("throws when the response is well-formed but far smaller than the real catalog", async () => {
      await expect(
        buildSnapshot({
          fetchFn: okFetch(bigRaw(500)) as unknown as typeof fetch, // 有効率100%だがMIN_CATALOG_RECORDS(3000)未満
          now: 1,
          writeFile: async () => {},
          removeFile: async () => {},
          outDir: "public/data",
        }),
      ).rejects.toThrow(/expected catalog size/);
    });

    it("does not call writeFile when validation fails", async () => {
      const { writes, writeFile } = noopWriteFile();
      await expect(
        buildSnapshot({
          fetchFn: okFetch([]) as unknown as typeof fetch,
          now: 1,
          writeFile,
          removeFile: async () => {},
          outDir: "public/data",
        }),
      ).rejects.toThrow();
      expect(writes).toHaveLength(0);
    });
  });

  // codex重大指摘対応: 出力形式(plain/gz)の切り替え時、旧形式のファイルが残らないようにする
  describe("stale-format cleanup (codex critical)", () => {
    it("removes the .gz sibling when writing the plain format", async () => {
      const { writeFile } = noopWriteFile();
      const removed: string[] = [];
      await buildSnapshot({
        fetchFn: okFetch(bigRaw(HAPPY_PATH_COUNT)) as unknown as typeof fetch,
        now: 1,
        writeFile,
        removeFile: async (path) => {
          removed.push(path);
        },
        outDir: "public/data",
      });
      expect(removed).toEqual(["public/data/gp-snapshot.json.gz"]);
    });

    it("removes the plain sibling when writing the gzip format", async () => {
      const { writeFile } = noopWriteFile();
      const removed: string[] = [];
      // MAX_PLAIN_BYTES(950KB)を実際に超える件数にして、gzip分岐へ自然に入らせる
      const result = await buildSnapshot({
        fetchFn: okFetch(bigRaw(5000)) as unknown as typeof fetch,
        now: 1,
        writeFile,
        removeFile: async (path) => {
          removed.push(path);
        },
        outDir: "public/data",
        gzipFn: () => new Uint8Array(2_000),
      });
      expect(result.compressed).toBe(true);
      expect(result.path).toBe("public/data/gp-snapshot.json.gz");
      expect(removed).toEqual(["public/data/gp-snapshot.json"]);
    });
  });

  // codex軽微指摘対応: gzip後も1MB目標を超えたら気づけるようにする
  it("throws when the gzip-compressed result still exceeds the 1MB target", async () => {
    await expect(
      buildSnapshot({
        fetchFn: okFetch(bigRaw(5000)) as unknown as typeof fetch,
        now: 1,
        writeFile: async () => {},
        removeFile: async () => {},
        outDir: "public/data",
        gzipFn: () => new Uint8Array(1_500_000),
      }),
    ).rejects.toThrow(/1MB/);
  });
});
