import { defineConfig, defaultClientConditions } from 'vite';
import { readFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Cross-origin isolation → SharedArrayBuffer → multi-threaded WASM inference.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// ONNX Runtime's "extern wasm" build loads its Emscripten glue (.mjs) as a separate file.
// Its pthread workers import that file directly, which is what makes multi-threading work
// — the default bundled build inlines the glue and its thread workers hang.
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
function ortRuntime() {
  return {
    name: 'ort-runtime',
    buildStart() {
      const dst = path.resolve('public/ort');
      mkdirSync(dst, { recursive: true });
      for (const f of ORT_FILES) {
        const out = path.join(dst, f);
        if (!existsSync(out)) cpSync(path.resolve('node_modules/onnxruntime-web/dist', f), out);
      }
    },
  };
}

export default defineConfig(() => ({
  base: './',
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  plugins: [ortRuntime()],
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@shiguredo/rnnoise-wasm'] },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 6000, sourcemap: false },
}));
