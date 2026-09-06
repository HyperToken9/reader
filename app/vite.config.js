/*
 * The renderer is an ordinary Vite app; Electron just hosts it. base:"./" so
 * the built bundle works from a file:// URL inside the packaged app.
 *
 * ppu-doclayout / onnxruntime-node are imported only by electron/, which runs
 * under Node and is never reachable from index.html -- Vite must not try to
 * pre-bundle them (their dependency graph includes a native .node binary
 * esbuild has no loader for).
 */
export default {
  root: "renderer",
  base: "./",
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    target: "chrome124",
  },
  optimizeDeps: {
    exclude: ["ppu-doclayout", "ppu-ocv", "onnxruntime-node"],
  },
  server: { port: 5173, strictPort: true },
};
