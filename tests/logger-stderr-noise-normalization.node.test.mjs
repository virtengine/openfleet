import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "lib/logger.mjs"), "utf8");

test("logger defines stderr noise suppression helpers and patterns", () => {
  assert.match(source, /const STDERR_NOISE_PATTERNS = \[/);
  assert.match(source, /function normalizeStderrNoiseLine\(line\)/);
  assert.match(source, /function shouldSuppressStderrNoise\(text\)/);
  assert.match(source, /function stripKnownStderrNoiseLines\(text\)/);
  assert.match(source, /ExperimentalWarning:\\s\+SQLite is an experimental feature/i);
  assert.match(source, /node --trace-warnings/);
});

test("logger suppresses known noise in error sink and stderr interception", () => {
  assert.match(source, /if \(shouldSuppressStderrNoise\(msg\)\) return;/);
  assert.match(source, /if \(shouldSuppressStderrNoise\(text\)\) \{/);
  assert.match(source, /const filtered = stripKnownStderrNoiseLines\(text\);/);
});
