/*
 * Kokoro speech, as seen by the renderer.
 *
 * The renderer only ever calls synthesize()/voices() over IPC, so it does not
 * know or care how speech is produced. Today the engine is a Python child
 * process (tts_server.py, carried over from prototype 16) speaking HTTP on a
 * loopback port that only this process knows about. That is deliberately
 * behind this module: swapping the engine for an in-process onnxruntime-node
 * one -- which is what a shippable download needs, since it drops the Python
 * dependency -- changes this file and nothing else.
 *
 * Engine location comes from BLITZ_TTS_HOME (default ~/.local/share/blitz-tts),
 * which holds venv/ and kokoro/. See app/README.md.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.BLITZ_TTS_HOME || join(homedir(), ".local/share/blitz-tts");
const PYTHON = join(HOME, "venv/bin/python");

/*
 * The engine binds an OS-assigned free port on loopback rather than a fixed
 * one: a fixed port means a second copy of the app collides with the first and
 * the engine dies at startup. The child prints the port it got on its first
 * line of stdout, and only this process ever learns it.
 */
let port = null;
let base = null;
let child = null;
let ready = null;
let lastError = null;

/** Poll /voices until the model is loaded. Cold start is a few seconds. */
async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`speech engine exited with code ${child.exitCode}`);
    }
    if (base) {
      try {
        const res = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("speech engine did not come up in time");
}

export function start(scriptPath) {
  if (ready) return ready;
  if (!existsSync(PYTHON)) {
    lastError = `no speech engine at ${HOME} — see app/README.md`;
    ready = Promise.reject(new Error(lastError));
    ready.catch(() => {});
    return ready;
  }
  child = spawn(PYTHON, [scriptPath], {
    env: { ...process.env, BLITZ_TTS_HOME: HOME, BLITZ_TTS_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    const text = String(d);
    const m = text.match(/^\s*PORT (\d+)/m);
    if (m && port === null) {
      port = Number(m[1]);
      base = `http://127.0.0.1:${port}`;
    }
    process.stdout.write(`[tts] ${text}`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[tts] ${d}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) lastError = `speech engine exited (${code})`;
  });
  ready = waitForServer().catch((e) => {
    lastError = e.message;
    throw e;
  });
  ready.catch(() => {});
  return ready;
}

export function stop() {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  child = null;
  ready = null;
  port = null;
  base = null;
}

export async function status() {
  if (!ready) return { ok: false, error: lastError ?? "not started" };
  try {
    await ready;
    return { ok: true };
  } catch {
    return { ok: false, error: lastError };
  }
}

async function call(path, init) {
  await ready;
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

export const voices = () => call("/voices");

export const synthesize = (payload) =>
  call("/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
