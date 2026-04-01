import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

test("self restart watcher includes lib directory", () => {
  assert.match(src, /let selfWatcherLib = null;/);
  assert.match(src, /let selfWatcherMtimes = new Map\(\);/);
  assert.match(src, /const libDir = resolve\(__dirname, "lib"\);/);
  assert.match(src, /selfWatcherLib = watch\(libDir, \{ persistent: true \}, handleSourceChange\);/);
  assert.match(src, /const watchedDirs = \["infra\/", "infra\/lib\/"\];/);
  assert.match(src, /console\.log\(`\[monitor\] watching source files for self-restart: \$\{watchedDirs\.join\(", "\)\}`\);/);
});

test("self restart watcher snapshots mtimes and logs repo-relative changed paths", () => {
  assert.match(src, /function snapshotSelfWatcherDirMtimes\(rootDir\)/);
  assert.match(src, /function resolveSelfWatcherChangedPath\(filename, watchedRoots = \[\]\)/);
  assert.match(src, /function formatSelfWatcherLabel\(filePath\)/);
  assert.match(src, /const prevMtime = Number\(selfWatcherMtimes\.get\(fullPath\) \|\| 0\);/);
  assert.match(src, /if \(newMtime <= prevMtime\) \{/);
  assert.match(src, /const restartLabel = formatSelfWatcherLabel\(fullPath\);/);
  assert.match(src, /queueSelfRestart\(restartLabel\);/);
});
