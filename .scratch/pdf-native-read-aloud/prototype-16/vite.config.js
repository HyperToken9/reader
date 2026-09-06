// THROWAWAY prototype config, ticket 16/06.
//
// ppu-doclayout is imported only by layout-server.mjs, which runs under Node
// and is never reachable from index.html -- so Vite should not try to
// pre-bundle it (its dependency graph includes ppu-ocv's @napi-rs/canvas
// native .node binary, which esbuild has no loader for).
export default {
  optimizeDeps: {
    exclude: ["ppu-doclayout", "ppu-ocv", "onnxruntime-node"],
  },
};
