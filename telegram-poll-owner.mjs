import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveRepoRoot } from "./repo-root.mjs";

const repoRoot = resolveRepoRoot();
const defaultCacheDir = resolve(repoRoot, ".cache");
const DEFAULT_OWNER_TTL_MS = Math.max(
  30_000,
  Number(process.env.TELEGRAM_POLL_OWNER_TTL_MS || "120000") || 120_000,
);
const OWNER_LOCK_STALE_MS = 30_000;
const OWNER_LOCK_RETRY_MS = 40;
const OWNER_LOCK_MAX_ATTEMPTS = 12;

let ownerStateFile = resolve(defaultCacheDir, "telegram-getupdates-owner.json");
let ownerUpdateLockFile = resolve(
  defaultCacheDir,
  "telegram-getupdates-owner.lock",
);

function canSignalProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseOwnerState(raw) {
  if (!raw || !String(raw).trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    const owner = String(parsed?.owner || "").trim();
    const pid = Number(parsed?.pid);
    const expiresAt = Number(parsed?.expiresAt);
    const updatedAt = Number(parsed?.updatedAt) || Date.now();
    if (!owner || !Number.isFinite(pid) || !Number.isFinite(expiresAt)) {
      return null;
    }
    return {
      owner,
      pid,
      expiresAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function readOwnerStateSync() {
  try {
    if (!existsSync(ownerStateFile)) return null;
    return parseOwnerState(readFileSync(ownerStateFile, "utf8"));
  } catch {
    return null;
  }
}

function getActiveOwnerSync(nowMs = Date.now()) {
  const state = readOwnerStateSync();
  if (!state) return null;
  if (state.expiresAt <= nowMs) return null;
  if (!canSignalProcess(state.pid)) return null;
  return state;
}

function parseUpdateLock(raw) {
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return {
      pid: Number(parsed?.pid),
      acquiredAt: Number(parsed?.acquiredAt),
    };
  } catch {
    return null;
  }
}

async function acquireUpdateLock() {
  mkdirSync(dirname(ownerUpdateLockFile), { recursive: true });
  const lockPayload = JSON.stringify(
    { pid: process.pid, acquiredAt: Date.now() },
    null,
    2,
  );

  for (let attempt = 0; attempt < OWNER_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(ownerUpdateLockFile, lockPayload, { flag: "wx" });
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") return false;
      try {
        const raw = await readFile(ownerUpdateLockFile, "utf8");
        const lock = parseUpdateLock(raw);
        const stale =
          !lock ||
          !Number.isFinite(lock.pid) ||
          !canSignalProcess(lock.pid) ||
          !Number.isFinite(lock.acquiredAt) ||
          Date.now() - lock.acquiredAt > OWNER_LOCK_STALE_MS;
        if (stale) {
          await unlink(ownerUpdateLockFile).catch(() => {});
          continue;
        }
      } catch {
        await unlink(ownerUpdateLockFile).catch(() => {});
        continue;
      }
      await sleep(OWNER_LOCK_RETRY_MS);
    }
  }
  return false;
}

async function releaseUpdateLock() {
  try {
    await unlink(ownerUpdateLockFile);
  } catch {
    /* best effort */
  }
}

async function withUpdateLock(task) {
  const locked = await acquireUpdateLock();
  if (!locked) return null;
  try {
    return await task();
  } finally {
    await releaseUpdateLock();
  }
}

export async function getActiveTelegramPollOwner() {
  return getActiveOwnerSync(Date.now());
}

export async function claimTelegramPollOwner(owner, options = {}) {
  const normalizedOwner = String(owner || "").trim();
  const pid = Number(options.pid || process.pid);
  const ttlMs = Math.max(
    30_000,
    Number(options.ttlMs || DEFAULT_OWNER_TTL_MS) || DEFAULT_OWNER_TTL_MS,
  );
  if (!normalizedOwner || !Number.isFinite(pid) || pid <= 0) {
    return { ok: false, reason: "invalid_owner_claim" };
  }

  const result = await withUpdateLock(async () => {
    const active = getActiveOwnerSync(Date.now());
    if (
      active &&
      !(active.owner === normalizedOwner && active.pid === pid)
    ) {
      return { ok: false, reason: "owner_conflict", owner: active };
    }

    const payload = {
      owner: normalizedOwner,
      pid,
      expiresAt: Date.now() + ttlMs,
      updatedAt: Date.now(),
    };
    mkdirSync(dirname(ownerStateFile), { recursive: true });
    await writeFile(ownerStateFile, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, owner: payload };
  });

  return result || { ok: false, reason: "owner_lock_unavailable" };
}

export async function releaseTelegramPollOwner(owner, options = {}) {
  const normalizedOwner = String(owner || "").trim();
  const pid = Number(options.pid || process.pid);

  const result = await withUpdateLock(async () => {
    if (!existsSync(ownerStateFile)) {
      return { ok: true, released: false };
    }

    const current = readOwnerStateSync();
    if (!current) {
      try {
        await unlink(ownerStateFile);
      } catch {
        /* best effort */
      }
      return { ok: true, released: true };
    }

    const active = getActiveOwnerSync(Date.now());
    const ownerMatches =
      current.owner === normalizedOwner &&
      Number.isFinite(pid) &&
      current.pid === pid;

    if (active && !ownerMatches) {
      return { ok: false, reason: "owner_mismatch", owner: active };
    }

    try {
      await unlink(ownerStateFile);
    } catch {
      /* best effort */
    }
    return { ok: true, released: true };
  });

  return result || { ok: false, reason: "owner_lock_unavailable" };
}

export function __setTelegramPollOwnerPathsForTest(paths = {}) {
  const nextOwner = String(paths.ownerStateFile || "").trim();
  const nextLock = String(paths.ownerUpdateLockFile || "").trim();
  if (nextOwner) ownerStateFile = resolve(nextOwner);
  if (nextLock) ownerUpdateLockFile = resolve(nextLock);
}

export function __resetTelegramPollOwnerPathsForTest() {
  ownerStateFile = resolve(defaultCacheDir, "telegram-getupdates-owner.json");
  ownerUpdateLockFile = resolve(defaultCacheDir, "telegram-getupdates-owner.lock");
}

export function __clearTelegramPollOwnerFilesForTest() {
  try {
    unlinkSync(ownerStateFile);
  } catch {
    /* best effort */
  }
  try {
    unlinkSync(ownerUpdateLockFile);
  } catch {
    /* best effort */
  }
}
