import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, afterEach } from "node:test";
import {
  __clearTelegramPollOwnerFilesForTest,
  __resetTelegramPollOwnerPathsForTest,
  __setTelegramPollOwnerPathsForTest,
  claimTelegramPollOwner,
  getActiveTelegramPollOwner,
  releaseTelegramPollOwner,
} from "../telegram-poll-owner.mjs";

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

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
