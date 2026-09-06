/*
 * Blitz — Electron main process.
 *
 * Why Electron: the whole premise of this app is that the page you look at is
 * the real PDF, rendered by PDF.js at native fidelity with an overlay on top.
 * That is a browser-engine job, and Electron is the browser engine we already
 * validated against. It also gives the two models a native Node process to
 * run in (onnxruntime-node, not WASM), which is what made layout analysis
 * usable at all -- see electron/layout.js.
 *
 * Both models run here, in this process. The renderer talks to them over IPC
 * (see preload.cjs); nothing listens on a public port.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as layout from "./layout.js";
import * as tts from "./tts.js";

const here = dirname(fileURLToPath(import.meta.url));
const TTS_SCRIPT = join(here, "tts_server.py");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: "#1a1a1e",
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(); nothing else crosses the bridge
    },
  });
  win.once("ready-to-show", () => win.show());
  // `npm run dev` points at the Vite dev server for hot reload; a packaged app
  // loads the bundle Vite built (see scripts/dev.mjs and vite.config.js).
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(here, "../dist/renderer/index.html"));
  }

  // External links open in the user's browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("tts:synthesize", (_e, payload) => tts.synthesize(payload));
ipcMain.handle("tts:voices", () => tts.voices());
ipcMain.handle("tts:status", () => tts.status());
ipcMain.handle("layout:analyze", (_e, png) => layout.analyze(Buffer.from(png)));
ipcMain.handle("layout:ready", () => layout.isReady());

app.whenReady().then(() => {
  createWindow();
  // Both models load in the background; the UI is usable before either is up.
  tts.start(TTS_SCRIPT).catch((e) => console.error("[tts]", e.message));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  tts.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => tts.stop());

process.on("uncaughtException", (e) => {
  console.error("[main] uncaught:", e);
  if (win) dialog.showErrorBox("Blitz", String(e?.stack ?? e));
});
