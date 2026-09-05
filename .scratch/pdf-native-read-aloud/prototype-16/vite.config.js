// THROWAWAY prototype config, ticket 16/06.
//
// ppu-doclayout's package graph includes a Node-only "core" path (ppu-ocv's
// @napi-rs/canvas, a native .node binary) that Vite's dependency optimizer
// tries to pre-bundle even though we only ever import "ppu-doclayout/web"
// and pass it an existing <canvas>, never a Buffer -- the Node codepath is
// never reached at runtime. Excluding it from pre-bundling is enough; it
// still works fine served as-is over the dev server.
export default {
  optimizeDeps: {
    exclude: ["ppu-doclayout", "ppu-ocv", "onnxruntime-web"],
  },
};
