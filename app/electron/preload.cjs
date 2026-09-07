/*
 * The only bridge between the renderer and Node. Context isolation stays on
 * and nodeIntegration off, so the page sees exactly these calls and nothing
 * else -- no require, no fs, no child_process.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("blitz", {
  /** {text, voice, speed} -> {sr, audio_b64, words, spans} */
  synthesize: (payload) => ipcRenderer.invoke("tts:synthesize", payload),
  /** -> string[] of voice names */
  voices: () => ipcRenderer.invoke("tts:voices"),
  /** -> {ok, error?} — whether speech is available at all */
  ttsStatus: () => ipcRenderer.invoke("tts:status"),
  /** PNG bytes (ArrayBuffer) -> [{label, score, box:[x1,y1,x2,y2]}] in reading order */
  analyzeLayout: (pngArrayBuffer) => ipcRenderer.invoke("layout:analyze", pngArrayBuffer),
  /** -> boolean */
  layoutReady: () => ipcRenderer.invoke("layout:ready"),

  /*
   * The absolute path behind a picked or dropped File. A renderer only ever
   * sees a File object, which under context isolation carries no path --
   * `File.path` was removed in Electron 32 -- and webUtils is preload-only.
   * So this one call is what makes a library possible at all: without a path
   * there is nothing to reopen a book from on the next launch. Returns ""
   * for a File that has no path behind it (a drag out of a web page).
   */
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ""; } },

  /*
   * Fetch one http(s) resource, in the main process. A documentation site is
   * a book whose pages live on a web server, and this renderer is a file://
   * page that cannot reach one. Returns bytes; parsing them is the renderer's
   * job, in the same DOMParser + sandboxed-iframe path an EPUB chapter takes.
   */
  fetch: (url) => ipcRenderer.invoke("net:fetch", url),

  /** The shelf. See electron/library.js. */
  library: {
    list: () => ipcRenderer.invoke("library:list"),
    remember: (meta) => ipcRenderer.invoke("library:remember", meta),
    position: (pos) => ipcRenderer.invoke("library:position", pos),
    notes: (payload) => ipcRenderer.invoke("library:notes", payload),
    forget: (id) => ipcRenderer.invoke("library:forget", id),
    open: (id) => ipcRenderer.invoke("library:open", id),
    rememberSite: (meta) => ipcRenderer.invoke("library:rememberSite", meta),
  },
});
