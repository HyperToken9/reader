/*
 * One command for development: Vite serves the renderer with hot reload,
 * Electron points at it instead of the built bundle. Killing either kills both.
 */
import { spawn } from "node:child_process";

const URL = "http://localhost:5173";
const kids = [];
const bye = (code) => {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGTERM");
  process.exit(code);
};

const vite = spawn("npx", ["vite"], { stdio: "inherit" });
kids.push(vite);
vite.on("exit", bye);

async function waitForVite() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(URL, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("vite did not start");
}

await waitForVite();
const electron = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: URL },
});
kids.push(electron);
electron.on("exit", bye);

process.on("SIGINT", () => bye(0));
process.on("SIGTERM", () => bye(0));
