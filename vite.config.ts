/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";

// satellite.js 7.x はメインエントリから WASM 版計算機(dist/wasm/)を無条件に
// re-export するが、その Emscripten 生成コード(top-level await + Node 専用 API)を
// Vite が bundle できない。本アプリは JS 版の関数しか使わないため、
// satellite.js 内部からの ./wasm/index.js import だけを空モジュールへ差し替える。
const STUB_ID = "\0satellite-js-wasm-stub";

function stubSatelliteWasm(): Plugin {
  return {
    name: "stub-satellite-js-wasm",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source.endsWith("/wasm/index.js") &&
        importer !== undefined &&
        importer.includes("satellite.js")
      ) {
        return STUB_ID;
      }
    },
    load(id) {
      if (id === STUB_ID) return "export {};";
    },
  };
}

export default defineConfig({
  plugins: [stubSatelliteWasm()],
  // 予報計算のワーカーも satellite.js を読むため、同じ WASM スタブを worker バンドルにも効かせる。
  // Vite の worker.plugins は「呼ばれるたびに新しいインスタンスを返す関数」でなければならない。
  worker: {
    format: "es",
    plugins: () => [stubSatelliteWasm()],
  },
  test: {
    environment: "jsdom",
  },
});
