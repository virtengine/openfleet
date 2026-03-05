#!/usr/bin/env node

/**
 * bosun — Desktop API Key Manager
 *
 * Provisions and validates a long-lived, non-expiring API key that the
 * Electron desktop app uses to authenticate against the local Bosun UI
 * server without relying on the TTL-based session-token.
 *
 * Key format : "bosun_desktop_" + 64 hex chars (32 random bytes)
 * Storage    : {configDir}/desktop-api-key.json
 * Env hand-off: BOSUN_DESKTOP_API_KEY — written to process.env by
 *               the Electron main process so ui-server.mjs can read it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

const KEY_FILE = "desktop-api-key.json";
const KEY_PREFIX = "bosun_desktop_";

// ── Internal helpers ──────────────────────────────────────────────────────────

function keyFilePath(configDir) {
  return resolve(configDir, KEY_FILE);
}

function generateRaw() {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/**
 * Read the raw JSON from disk. Returns null on any error.
 */
function readKeyFile(configDir) {
  const filePath = keyFilePath(configDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.key !== "string") return null;
    if (!String(parsed.key).startsWith(KEY_PREFIX)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the key to disk.
 */
function writeKeyFile(configDir, key) {
  mkdirSync(configDir, { recursive: true });
  const filePath = keyFilePath(configDir);
  writeFileSync(
    filePath,
    JSON.stringify({ key, createdAt: Date.now() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current desktop API key.
 * Returns the key string, or `null` if none has been generated yet.
 *
 * @param {string} configDir  Path to the bosun config directory.
 * @returns {string|null}
 */
export function readDesktopApiKey(configDir) {
  const data = readKeyFile(configDir);
  return data ? data.key : null;
}

/**
 * Return the current desktop API key, generating one if it does not exist.
 *
 * @param {string} configDir
 * @returns {string}  The API key.
 */
export function ensureDesktopApiKey(configDir) {
  const existing = readDesktopApiKey(configDir);
  if (existing) return existing;
  return generateDesktopApiKey(configDir);
}

/**
 * Generate (or regenerate) a fresh desktop API key and save it to disk.
 *
 * @param {string} configDir
 * @returns {string}  The newly generated key.
 */
export function generateDesktopApiKey(configDir) {
  const key = generateRaw();
  writeKeyFile(configDir, key);
  return key;
}

/**
 * Rotate the API key — generate a new one, overwriting the old.
 *
 * @param {string} configDir
 * @returns {string}  The new key.
 */
export function rotateDesktopApiKey(configDir) {
  return generateDesktopApiKey(configDir);
}

/**
 * Validate a candidate key against the stored desktop API key.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {string} candidate    Key to validate.
 * @param {string} configDir
 * @returns {boolean}
 */
export function validateDesktopApiKey(candidate, configDir) {
  if (!candidate || typeof candidate !== "string") return false;
  const stored = readDesktopApiKey(configDir);
  if (!stored) return false;
  try {
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Remove the desktop API key file (e.g. on uninstall / reset).
 *
 * @param {string} configDir
 */
export function removeDesktopApiKey(configDir) {
  const filePath = keyFilePath(configDir);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    /* best effort */
  }
}
