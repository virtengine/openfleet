#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const MANIFEST_PATHS = [
  resolve(ROOT_DIR, "native", "bosun-unified-exec", "Cargo.toml"),
  resolve(ROOT_DIR, "native", "bosun-telemetry", "Cargo.toml"),
];

function hasCargo() {
  const probe = spawnSync("cargo", ["--version"], {
    stdio: "pipe",
    windowsHide: true,
  });
  return probe.status === 0;
}

function runCargo(args, options = {}) {
  return spawnSync("cargo", args, {
    cwd: ROOT_DIR,
    stdio: options.silent ? "pipe" : "inherit",
    windowsHide: true,
  });
}

function getMode() {
  const raw = String(process.argv[2] || "build").trim().toLowerCase();
  if (["build", "test", "check"].includes(raw)) return raw;
  return "build";
}

const mode = getMode();
const silent = process.argv.includes("--silent");
const requireNative =
  process.argv.includes("--require")
  || process.env.BOSUN_REQUIRE_NATIVE === "1";

if (!hasCargo()) {
  if (requireNative) {
    console.error("[native-rust] cargo is required but was not found on PATH.");
    process.exit(1);
  }
  if (!silent) {
    console.log("[native-rust] cargo not found on PATH; skipping optional Bosun native build.");
  }
  process.exit(0);
}

const baseArgs = mode === "build"
  ? ["build", "--release"]
  : [mode];

for (const manifestPath of MANIFEST_PATHS) {
  if (!existsSync(manifestPath)) {
    console.error(`[native-rust] Missing Cargo manifest: ${manifestPath}`);
    process.exit(1);
  }
  const result = runCargo([...baseArgs, "--manifest-path", manifestPath], { silent });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!silent) {
  console.log(`[native-rust] cargo ${mode} completed for ${MANIFEST_PATHS.length} native crate(s).`);
}
