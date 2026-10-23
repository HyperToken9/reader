/*
 * The Kokoro weights: fetched once, the first time someone presses play.
 *
 * They are ~190 MB, so they are not in the app. Nobody who never uses speech
 * downloads anything, and the app opens and reads normally without them.
 * Both files come from kokoro-onnx's own GitHub releases, pinned by URL and
 * sha256. The fp16 model in model-files-v1.1 already carries the int64
 * `duration` output the word cursor needs -- the same graph as an export from
 * the PyTorch checkpoint, with weights within one fp16 ulp -- so nothing is
 * exported and nothing is self-hosted.
 *
 * On disk, in <userData>/speech/:
 *   <name>.part   a download in progress; resumed with a Range request
 *   <name>        complete, and its sha256 matched the pin
 *   <name>.ok     what the file looked like (size, mtime) when it was checked
 *
 * Hashing 190 MB on every launch would sit between pressing play and hearing
 * anything, so a file is hashed once, when it lands. Later launches compare
 * its size and mtime against the .ok marker: a truncated file, or one written
 * to since, no longer matches, and is fetched again rather than loaded.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FILES = [
  {
    name: "kokoro-v1.0.fp16.onnx",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx",
    sha256: "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
    size: 163527961,
  },
  {
    name: "voices-v1.0.bin",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    size: 28214398,
  },
];

export const TOTAL_BYTES = FILES.reduce((n, f) => n + f.size, 0);

// A stalled connection, not a slow one: no bytes at all for this long.
const STALL_MS = 30_000;

const sizeOf = (path) => stat(path).then((s) => s.size, () => 0);

async function sha256(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

async function marker(path) {
  try {
    const s = await stat(path);
    return `${s.size} ${Math.trunc(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Is this file present, complete, and unchanged since its checksum passed? */
async function verified(dir, f) {
  const now = await marker(join(dir, f.name));
  if (!now) return false;
  const then = await readFile(join(dir, f.name + ".ok"), "utf8").catch(() => null);
  return then?.trim() === `${f.sha256} ${now}`;
}

export async function installed(dir) {
  for (const f of FILES) if (!(await verified(dir, f))) return false;
  return true;
}

/** Forget that the files were checked, so the next ensure() re-hashes them. */
export async function distrust(dir) {
  await Promise.all(FILES.map((f) => rm(join(dir, f.name + ".ok"), { force: true })));
}

/** Download `f` into `<name>.part`, resuming whatever is already there. */
async function download(f, part, onBytes) {
  const have = await sizeOf(part);
  const ctl = new AbortController();
  let stall = setTimeout(() => ctl.abort(), STALL_MS);
  const alive = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(), STALL_MS);
  };
  try {
    const res = await fetch(f.url, {
      headers: have ? { range: `bytes=${have}-` } : {},
      signal: ctl.signal,
    });
    if (res.status === 416 && have === f.size) return; // already whole
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // A server that ignored the Range header sends the whole file again.
    const resumed = res.status === 206;
    onBytes(resumed ? have : 0);
    const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
    try {
      for await (const chunk of res.body) {
        alive();
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        onBytes(chunk.length);
      }
    } finally {
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    }
  } catch (e) {
    if (ctl.signal.aborted) throw new Error("the download stalled");
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

/**
 * Make sure every file is in `dir` and checks out, downloading what is not.
 * onProgress({phase: "download"|"verify", received, total}) is called as it
 * goes. Throws an Error whose message is fit to show the reader.
 */
export async function ensure(dir, onProgress = () => {}) {
  await mkdir(dir, { recursive: true });
  let received = 0;
  let last = 0;
  const report = (phase, force) => {
    const now = Date.now();
    if (force || now - last > 100) {
      last = now;
      onProgress({ phase, received, total: TOTAL_BYTES });
    }
  };
  for (const f of FILES) {
    const path = join(dir, f.name);
    if (await verified(dir, f)) {
      received += f.size;
      continue;
    }
    await rm(path + ".ok", { force: true });
    const part = path + ".part";
    // An unverified file where the finished one belongs is not trusted;
    // it goes back through the checksum like any fresh download.
    if (await sizeOf(path)) await rename(path, part);
    // More bytes than the file has can only be garbage; nothing to resume.
    if ((await sizeOf(part)) > f.size) await rm(part, { force: true });
    const base = received;
    // A resumed download is only as good as the bytes it resumed from, and
    // those may be the damaged ones. If it fails the checksum, start over
    // from nothing once before calling the download broken.
    for (let fresh = (await sizeOf(part)) === 0; ; fresh = true) {
      received = base;
      try {
        await download(f, part, (n) => {
          received += n;
          report("download");
        });
      } catch (e) {
        throw new Error(`Couldn't download the voice model (${e.message}). Check your connection and try again.`);
      }
      received = base + f.size;
      report("verify", true);
      if ((await sha256(part)) === f.sha256) break;
      await rm(part, { force: true });
      if (fresh) throw new Error("The voice model download was damaged (checksum mismatch). Try again.");
    }
    await rename(part, path);
    await writeFile(path + ".ok", `${f.sha256} ${await marker(path)}\n`);
  }
  report("verify", true);
}
