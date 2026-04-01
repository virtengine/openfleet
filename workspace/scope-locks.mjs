import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const REGISTRY_VERSION = "1.0.0";
const DEFAULT_SCOPE_LOCK_TTL_SECONDS = 300;
const MAX_SCOPE_LOCKS_PER_TASK = 128;
const RENAME_RETRY_DELAY_MS = 60;
const RENAME_MAX_RETRIES = 8;
const COPY_MAX_RETRIES = 3;
const WRITE_MAX_RETRIES = 3;

const RETRYABLE_FS_ERRORS = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function isRetryableFsError(error) {
  return RETRYABLE_FS_ERRORS.has(error?.code || "");
}

async function retryFsOperation(fn, { maxRetries, delayMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt === maxRetries) break;
      await delay(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

async function safeUnlink(path) {
  try {
    if (existsSync(path)) await unlink(path);
  } catch {
    // best effort
  }
}

function getWriteFileOptions() {
  if (process.env.VITEST) {
    return { encoding: "utf-8" };
  }
  return { encoding: "utf-8", flush: true };
}

function createEmptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    lastUpdated: new Date().toISOString(),
    locks: {},
  };
}

export function getScopeLockRegistryPath(repoRoot = process.cwd()) {
  return resolve(repoRoot, ".bosun", ".cache", "scope-locks.json");
}

async function ensureRegistryDir(registryPath) {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function loadRegistry(registryPath) {
  try {
    if (!existsSync(registryPath)) {
      return createEmptyRegistry();
    }

    const content = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(content);
    let repaired = false;

    if (!registry.version) {
      registry.version = REGISTRY_VERSION;
      repaired = true;
    }
    if (!registry.locks || typeof registry.locks !== "object" || Array.isArray(registry.locks)) {
      registry.locks = {};
      repaired = true;
    }
    if (!registry.lastUpdated) {
      registry.lastUpdated = new Date().toISOString();
      repaired = true;
    }
    if (repaired) {
      console.warn("[scope-locks] Invalid registry structure repaired.");
    }
    return registry;
  } catch (error) {
    console.error("[scope-locks] Registry corruption detected:", error.message);
    try {
      const backupPath = `${registryPath}.corrupt-${Date.now()}.bak`;
      await rename(registryPath, backupPath);
      console.log(`[scope-locks] Corrupted registry backed up to: ${backupPath}`);
    } catch {
      // best effort
    }
    return createEmptyRegistry();
  }
}

async function saveRegistry(registryPath, registry) {
  await ensureRegistryDir(registryPath);
  registry.lastUpdated = new Date().toISOString();

  const tempPath = `${registryPath}.tmp-${randomUUID()}`;
  const payload = JSON.stringify(registry, null, 2);

  try {
    await writeFile(tempPath, payload, getWriteFileOptions());

    try {
      await retryFsOperation(
        () => rename(tempPath, registryPath),
        { maxRetries: RENAME_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
      );
      return;
    } catch (renameError) {
      try {
        await retryFsOperation(
          () => copyFile(tempPath, registryPath),
          { maxRetries: COPY_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
        );
        await safeUnlink(tempPath);
        console.warn(
          `[scope-locks] Atomic rename failed (${renameError?.code || "unknown"}); copied registry instead.`,
        );
        return;
      } catch (copyError) {
        await retryFsOperation(
          () => writeFile(registryPath, payload, getWriteFileOptions()),
          { maxRetries: WRITE_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
        );
        await safeUnlink(tempPath);
        console.warn(
          `[scope-locks] Atomic rename failed (${renameError?.code || "unknown"}); copy fallback failed (${copyError?.code || "unknown"}); wrote registry directly.`,
        );
      }
    }
  } finally {
    await safeUnlink(tempPath);
  }
}

export function normalizeScopePath(rawPath, repoRoot = process.cwd()) {
  const value = String(rawPath || "").trim();
  if (!value) return null;
  return isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
}

function toRelativeScopePath(absolutePath, repoRoot) {
  const rel = relative(repoRoot, absolutePath).split("\\").join("/");
  if (!rel || rel.startsWith("..")) {
    return absolutePath.split("\\").join("/");
  }
  return rel;
}

export function normalizeScopePaths(rawPaths, repoRoot = process.cwd()) {
  const source = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
  const deduped = [];
  const seen = new Set();
  for (const entry of source) {
    const normalized = normalizeScopePath(entry, repoRoot);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= MAX_SCOPE_LOCKS_PER_TASK) break;
  }
  return deduped;
}

export function inferScopePaths(options = {}, repoRoot = process.cwd()) {
  const metadata = options?.metadata && typeof options.metadata === "object" ? options.metadata : {};
  const rawPaths = [
    ...(Array.isArray(options.scopePaths) ? options.scopePaths : []),
    ...(Array.isArray(metadata.scopePaths) ? metadata.scopePaths : []),
    ...(Array.isArray(metadata.paths) ? metadata.paths : []),
    ...(Array.isArray(metadata.filePaths) ? metadata.filePaths : []),
    ...(Array.isArray(metadata.files) ? metadata.files : []),
  ];
  return normalizeScopePaths(rawPaths, repoRoot);
}

export function isScopeLockExpired(lock, nowMs = Date.now()) {
  if (!lock) return true;
  const expiresAtMs = Date.parse(String(lock.expiresAt || ""));
  if (Number.isFinite(expiresAtMs)) {
    return nowMs >= expiresAtMs;
  }
  const refreshedAtMs = Date.parse(String(lock.refreshedAt || lock.createdAt || ""));
  if (!Number.isFinite(refreshedAtMs)) return true;
  const ttlMs = Math.max(
    0,
    (Number.isFinite(Number(lock.ttlSeconds)) ? Number(lock.ttlSeconds) : DEFAULT_SCOPE_LOCK_TTL_SECONDS) * 1000,
  );
  return nowMs - refreshedAtMs >= ttlMs;
}

function cleanupExpiredLocks(registry, nowMs = Date.now()) {
  const releasedPaths = [];
  for (const [lockPath, lock] of Object.entries(registry.locks || {})) {
    if (!isScopeLockExpired(lock, nowMs)) continue;
    delete registry.locks[lockPath];
    releasedPaths.push(lockPath);
  }
  return releasedPaths;
}

function buildLockEntry({
  taskId,
  ownerId,
  attemptToken,
  absolutePath,
  repoRoot,
  ttlSeconds,
  metadata,
  existingLockId = null,
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  return {
    lockId: existingLockId || randomUUID(),
    taskId,
    ownerId,
    attemptToken,
    path: absolutePath,
    relativePath: toRelativeScopePath(absolutePath, repoRoot),
    ttlSeconds,
    createdAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
  };
}

function isSameScopeOwner(lock, { taskId, ownerId, attemptToken }) {
  return (
    String(lock?.taskId || "") === String(taskId || "") &&
    String(lock?.ownerId || "") === String(ownerId || "") &&
    String(lock?.attemptToken || "") === String(attemptToken || "")
  );
}

function isSameScopeOwnerIgnoringAttemptToken(lock, { taskId, ownerId }) {
  return (
    String(lock?.taskId || "") === String(taskId || "") &&
    String(lock?.ownerId || "") === String(ownerId || "")
  );
}

export async function acquireScopeLocks({
  taskId,
  ownerId,
  attemptToken,
  repoRoot = process.cwd(),
  ttlSeconds = DEFAULT_SCOPE_LOCK_TTL_SECONDS,
  metadata = {},
  scopePaths = [],
} = {}) {
  const normalizedPaths = normalizeScopePaths(scopePaths, repoRoot);
  if (!normalizedPaths.length) {
    return {
      success: true,
      locks: [],
      scopePaths: [],
      acquiredPaths: [],
      reusedPaths: [],
    };
  }

  const registryPath = getScopeLockRegistryPath(repoRoot);
  const registry = await loadRegistry(registryPath);
  cleanupExpiredLocks(registry);

  const conflicts = [];
  const reusedPaths = [];
  const acquiredPaths = [];

  for (const lockPath of normalizedPaths) {
    const existing = registry.locks[lockPath];
    if (!existing) continue;
    if (
      isSameScopeOwner(existing, { taskId, ownerId, attemptToken }) ||
      isSameScopeOwnerIgnoringAttemptToken(existing, { taskId, ownerId })
    ) {
      reusedPaths.push(lockPath);
      continue;
    }
    conflicts.push({
      path: lockPath,
      existing,
    });
  }

  if (conflicts.length) {
    await saveRegistry(registryPath, registry);
    return {
      success: false,
      reason: "scope_lock_conflict",
      conflict: conflicts[0],
      conflicts,
      scopePaths: normalizedPaths,
    };
  }

  for (const lockPath of normalizedPaths) {
    const existing = registry.locks[lockPath];
    const entry = buildLockEntry({
      taskId,
      ownerId,
      attemptToken,
      absolutePath: lockPath,
      repoRoot,
      ttlSeconds,
      metadata,
      existingLockId: existing?.lockId || null,
    });
    if (existing?.createdAt) {
      entry.createdAt = existing.createdAt;
    }
    registry.locks[lockPath] = entry;
    if (!existing) acquiredPaths.push(lockPath);
  }

  await saveRegistry(registryPath, registry);

  return {
    success: true,
    locks: normalizedPaths.map((lockPath) => registry.locks[lockPath]),
    scopePaths: normalizedPaths,
    acquiredPaths,
    reusedPaths,
  };
}

export async function renewScopeLocks({
  taskId,
  ownerId,
  attemptToken,
  repoRoot = process.cwd(),
  ttlSeconds = DEFAULT_SCOPE_LOCK_TTL_SECONDS,
  scopePaths = null,
  metadata = {},
} = {}) {
  const registryPath = getScopeLockRegistryPath(repoRoot);
  const registry = await loadRegistry(registryPath);
  cleanupExpiredLocks(registry);

  const targetPaths = normalizeScopePaths(
    Array.isArray(scopePaths) && scopePaths.length
      ? scopePaths
      : Object.values(registry.locks || {})
        .filter((lock) => String(lock?.taskId || "") === String(taskId || ""))
        .map((lock) => lock.path),
    repoRoot,
  );

  if (!targetPaths.length) {
    return { success: true, renewedCount: 0, scopePaths: [] };
  }

  const refreshedAt = new Date();
  const expiresAt = new Date(refreshedAt.getTime() + ttlSeconds * 1000).toISOString();
  const mismatches = [];
  let renewedCount = 0;

  for (const lockPath of targetPaths) {
    const lock = registry.locks[lockPath];
    if (!lock) {
      mismatches.push({
        path: lockPath,
        existing: null,
        reason: "missing",
      });
      continue;
    }
    if (!isSameScopeOwner(lock, { taskId, ownerId, attemptToken })) {
      mismatches.push({
        path: lockPath,
        existing: lock,
        reason: "owner_mismatch",
      });
      continue;
    }
    lock.refreshedAt = refreshedAt.toISOString();
    lock.expiresAt = expiresAt;
    lock.ttlSeconds = ttlSeconds;
    lock.metadata = metadata && typeof metadata === "object"
      ? { ...lock.metadata, ...metadata }
      : lock.metadata;
    renewedCount += 1;
  }

  if (mismatches.length) {
    await saveRegistry(registryPath, registry);
    return {
      success: false,
      reason: "scope_lock_owner_mismatch",
      mismatch: mismatches[0],
      mismatches,
      renewedCount,
      scopePaths: targetPaths,
    };
  }

  await saveRegistry(registryPath, registry);
  return { success: true, renewedCount, scopePaths: targetPaths };
}

export async function releaseScopeLocks({
  taskId,
  ownerId,
  attemptToken,
  repoRoot = process.cwd(),
} = {}) {
  const registryPath = getScopeLockRegistryPath(repoRoot);
  const registry = await loadRegistry(registryPath);
  cleanupExpiredLocks(registry);

  const releasedPaths = [];
  for (const [lockPath, lock] of Object.entries(registry.locks || {})) {
    if (String(lock?.taskId || "") !== String(taskId || "")) continue;
    const ownerMatches = !ownerId || String(lock?.ownerId || "") === String(ownerId || "");
    const tokenMatches = !attemptToken || String(lock?.attemptToken || "") === String(attemptToken || "");
    if (!ownerMatches || !tokenMatches) continue;
    delete registry.locks[lockPath];
    releasedPaths.push(lockPath);
  }

  await saveRegistry(registryPath, registry);
  return { success: true, releasedPaths };
}

export async function getTaskScopeLocks(taskId, repoRoot = process.cwd()) {
  const registryPath = getScopeLockRegistryPath(repoRoot);
  const registry = await loadRegistry(registryPath);
  const releasedPaths = cleanupExpiredLocks(registry);
  if (releasedPaths.length > 0) {
    await saveRegistry(registryPath, registry);
  }
  return Object.values(registry.locks || {}).filter(
    (lock) => String(lock?.taskId || "") === String(taskId || ""),
  );
}

export async function listScopeLocks(repoRoot = process.cwd()) {
  const registryPath = getScopeLockRegistryPath(repoRoot);
  const registry = await loadRegistry(registryPath);
  cleanupExpiredLocks(registry);
  await saveRegistry(registryPath, registry);
  return Object.values(registry.locks || {});
}

export const _test = {
  cleanupExpiredLocks,
  createEmptyRegistry,
  loadRegistry,
  saveRegistry,
};
