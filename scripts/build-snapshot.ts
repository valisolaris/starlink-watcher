// S5: 日次スナップショット生成スクリプト(GitHub Actions から実行)。
// CelesTrak から取得 → src/gp.ts の parseGpJson でトリム → GpSnapshot 形式で書き出す。
// 1MB 未満に収まらない場合は gzip 圧縮する(handoff.md S5 完了条件)。
import { mkdir, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { GP_MIN_VALID_RATIO, GP_MIN_VALID_RECORDS, GP_URL, parseGpJson } from "../src/gp.ts";

export interface BuildSnapshotOptions {
  fetchFn?: typeof fetch;
  now?: number;
  writeFile?: (path: string, data: string | Uint8Array) => Promise<void>;
  /** 出力形式(plain/gz)切り替え時に、反対形式の古いファイルを消す(存在しなくてもよい) */
  removeFile?: (path: string) => Promise<void>;
  outDir?: string;
  gzipFn?: (data: Uint8Array) => Uint8Array;
}

export interface BuildSnapshotResult {
  path: string;
  byteSize: number;
  recordCount: number;
  compressed: boolean;
}

const DEFAULT_OUT_DIR = "public/data";
const SNAPSHOT_FILENAME = "gp-snapshot.json";
/** これを超えたら gzip 圧縮に切り替える(1MB の完了条件に対して余裕を持たせる) */
const MAX_PLAIN_BYTES = 950_000;
/** gzip後もこれを超えたら失敗させる(完了条件「1MBの未満」を生成時点で保証する) */
const MAX_GZ_BYTES = 1_000_000;
/**
 * カタログ全体に対する最低件数(codex重大指摘対応: GP_MIN_VALID_RECORDS/RATIO は
 * 「受信した中での有効率」しか見ないため、スキーマ的には正常でも件数が激減した
 * 応答(実測約1.1万件に対し例えば150件など)を検出できない。直fetch側は古いキャッシュへ
 * フォールバックできるが、スナップショットは1日単位でcommitされ続けるため、生成時点で
 * より厳しく検査する。3000は実測(約10,910件)の1/3程度で、日々の増減は許容しつつ
 * 明らかな欠落を弾く値)。
 */
const MIN_CATALOG_RECORDS = 3000;

async function defaultWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, data);
}

async function defaultRemoveFile(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function buildSnapshot(
  opts?: BuildSnapshotOptions,
): Promise<BuildSnapshotResult> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const now = opts?.now ?? Date.now();
  const outDir = opts?.outDir ?? DEFAULT_OUT_DIR;
  const writeFile = opts?.writeFile ?? defaultWriteFile;
  const removeFile = opts?.removeFile ?? defaultRemoveFile;
  const gzipFn = opts?.gzipFn ?? gzipSync;

  const res = await fetchFn(GP_URL);
  if (!res.ok) {
    throw new Error(`CelesTrak fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const rawCount = Array.isArray(json) ? json.length : 0;
  const records = parseGpJson(json);
  // codex重大指摘対応: 異常応答(空・スキーマ変化)を正常スナップショットとしてcommitしない
  // (直fetch側の getGpData と同じ検査基準)
  if (records.length < GP_MIN_VALID_RECORDS || records.length < rawCount * GP_MIN_VALID_RATIO) {
    throw new Error(
      `CelesTrak response has too few valid records: ${records.length}/${rawCount}`,
    );
  }
  // codex重大指摘対応(再レビュー): スキーマ的に正常でもカタログ規模から大幅に欠落した
  // 応答は上の検査だけでは検出できないため、スナップショット生成ではさらに絶対件数も見る
  if (records.length < MIN_CATALOG_RECORDS) {
    throw new Error(
      `CelesTrak response is far smaller than the expected catalog size: ${records.length} records (minimum ${MIN_CATALOG_RECORDS})`,
    );
  }

  const data = JSON.stringify({ fetchedAt: now, records });
  const plainBytes = new TextEncoder().encode(data);
  const plainPath = `${outDir}/${SNAPSHOT_FILENAME}`;
  const gzPath = `${plainPath}.gz`;

  if (plainBytes.byteLength <= MAX_PLAIN_BYTES) {
    await writeFile(plainPath, data);
    // codex重大指摘対応: 以前がgzip形式だった場合の残存を防ぐ
    await removeFile(gzPath);
    return {
      path: plainPath,
      byteSize: plainBytes.byteLength,
      recordCount: records.length,
      compressed: false,
    };
  }

  const gz = gzipFn(plainBytes);
  if (gz.byteLength >= MAX_GZ_BYTES) {
    throw new Error(
      `gzip-compressed snapshot still exceeds the 1MB target: ${gz.byteLength} bytes`,
    );
  }
  await writeFile(gzPath, gz);
  // codex重大指摘対応: 以前が平文形式だった場合の残存を防ぐ
  await removeFile(plainPath);
  return { path: gzPath, byteSize: gz.byteLength, recordCount: records.length, compressed: true };
}

// CLI エントリ(このファイルが直接実行された場合のみ)
if (import.meta.url === `file://${process.argv[1]}`) {
  buildSnapshot()
    .then((r) => {
      console.log(
        `wrote ${r.path} (${r.byteSize} bytes, ${r.recordCount} records, compressed=${r.compressed})`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
