/*
 * The only bridge between the renderer and Node. Context isolation stays on
 * and nodeIntegration off, so the page sees exactly these five calls and
 * nothing else -- no require, no fs, no child_process.
 */
const { contextBridge, ipcRenderer } = require("electron");

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
});
