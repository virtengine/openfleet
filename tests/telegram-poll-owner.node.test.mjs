import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, afterEach } from "node:test";
import {
  __clearTelegramPollOwnerFilesForTest,
  __resetTelegramPollOwnerPathsForTest,
  __setTelegramPollOwnerPathsForTest,
  claimTelegramPollOwner,
  configureTelegramPollOwnerScope,
  getActiveTelegramPollOwner,
  releaseTelegramPollOwner,
  resolveTelegramPollPaths,
  resolveTelegramPollScopeId,
} from "../telegram/telegram-poll-owner.mjs";

const root = mkdtempSync(resolve(tmpdir(), "bosun-poll-owner-"));
const cacheDir = resolve(root, ".cache");
mkdirSync(cacheDir, { recursive: true });
const ownerStateFile = resolve(cacheDir, "telegram-getupdates-owner.json");
const ownerUpdateLockFile = resolve(cacheDir, "telegram-getupdates-owner.lock");

function setTestPaths() {
  __setTelegramPollOwnerPathsForTest({
    ownerStateFile,
    ownerUpdateLockFile,
  });
}

afterEach(() => {
  __clearTelegramPollOwnerFilesForTest();
  __resetTelegramPollOwnerPathsForTest();
});

describe("telegram poll owner arbitration", () => {
  it("derives stable token-scoped shared lock paths", () => {
    const scopeId = resolveTelegramPollScopeId("123456:token");
    assert.match(scopeId, /^[0-9a-f]{12}$/);

    const paths = resolveTelegramPollPaths({
      token: "123456:token",
      sharedBaseDir: root,
    });
    assert.equal(paths.scopeId, scopeId);
    assert.equal(
      paths.ownerStateFile,
      resolve(cacheDir, `telegram-getupdates-${scopeId}-owner.json`),
    );
    assert.equal(
      paths.pollLockFile,
      resolve(cacheDir, `telegram-getupdates-${scopeId}.lock`),
    );
    assert.equal(
      paths.conflictStateFile,
      resolve(cacheDir, `telegram-getupdates-${scopeId}-conflict.json`),
    );
  });

  it("reconfigures poll owner storage into the shared runtime cache", async () => {
    const scoped = configureTelegramPollOwnerScope({
      token: "654321:token",
      sharedBaseDir: root,
    });

    const claim = await claimTelegramPollOwner("telegram-bot", {
      pid: process.pid,
      ttlMs: 120_000,
    });
    assert.equal(claim.ok, true);
    assert.ok(scoped.ownerStateFile.includes(scopeIdFrom("654321:token")));
    assert.equal(existsSync(scoped.ownerStateFile), true);
  });

  it("allows a single owner and rejects a concurrent owner", async () => {
    setTestPaths();
    const first = await claimTelegramPollOwner("telegram-bot", {
      pid: process.pid,
      ttlMs: 120_000,
    });
    assert.equal(first.ok, true);

    const second = await claimTelegramPollOwner("telegram-sentinel", {
      pid: process.pid + 100_000,
      ttlMs: 120_000,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "owner_conflict");
    assert.equal(second.owner?.owner, "telegram-bot");
  });

  it("allows reclaim when owner file points to dead pid", async () => {
    setTestPaths();
    writeFileSync(
      ownerStateFile,
      JSON.stringify({
        owner: "telegram-bot",
        pid: 999_999,
        expiresAt: Date.now() + 120_000,
        updatedAt: Date.now(),
      }),
      "utf8",
    );

    const claim = await claimTelegramPollOwner("telegram-sentinel", {
      pid: process.pid,
      ttlMs: 120_000,
    });
    assert.equal(claim.ok, true);
    assert.equal(claim.owner?.owner, "telegram-sentinel");
  });

  it("keeps active owner visible and clears on release", async () => {
    setTestPaths();
    const claim = await claimTelegramPollOwner("telegram-bot", {
      pid: process.pid,
      ttlMs: 120_000,
    });
    assert.equal(claim.ok, true);

    const active = await getActiveTelegramPollOwner();
    assert.equal(active?.owner, "telegram-bot");
    assert.equal(active?.pid, process.pid);

    const release = await releaseTelegramPollOwner("telegram-bot", {
      pid: process.pid,
    });
    assert.equal(release.ok, true);

    const after = await getActiveTelegramPollOwner();
    assert.equal(after, null);
  });
});

function scopeIdFrom(token) {
  return resolveTelegramPollScopeId(token);
}

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
