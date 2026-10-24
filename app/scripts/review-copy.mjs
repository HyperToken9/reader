#!/usr/bin/env node
/*
 * Put the AppImage just built where the reviewer clicks it.
 *
 * Builds happen in whichever worktree the change lives in, and a worktree's
 * release/ goes away with it. So after `npm run dist`, this copies the
 * AppImage to one fixed place -- app/release/Blitz.AppImage in the main
 * checkout, found through git from any worktree -- overwriting the last one.
 * BLITZ_REVIEW_DIR overrides the folder.
 *
 *   npm run dist:review
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = readdirSync(join(app, "release"))
  .filter((f) => f.endsWith(".AppImage") && f !== "Blitz.AppImage")
  .map((f) => join(app, "release", f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!built) throw new Error("no AppImage in release/; run npm run dist first");

// --git-common-dir is the main checkout's .git, whichever worktree we are in.
const common = resolve(app, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: app, encoding: "utf8" }).trim());
const dir = process.env.BLITZ_REVIEW_DIR || join(dirname(common), "app/release");
const to = join(dir, "Blitz.AppImage");
mkdirSync(dir, { recursive: true });
// Copy then rename, so a running copy of the old AppImage is never overwritten in place.
copyFileSync(built, to + ".tmp");
renameSync(to + ".tmp", to);
const rev = execFileSync("git", ["log", "-1", "--format=%h %s"], { cwd: app, encoding: "utf8" }).trim();
console.log(`[review] ${to}\n[review] built from ${rev}`);
