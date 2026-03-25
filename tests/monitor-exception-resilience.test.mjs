import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("monitor exception resilience guards", () => {
  const monitorPath = resolve(process.cwd(), "infra/monitor.mjs");
  const source = readFileSync(monitorPath, "utf8");

  it("does not terminate process inside handleMonitorFailure", () => {
    const match = source.match(
      /async function handleMonitorFailure\([\s\S]*?\r?\n\}\r?\n\r?\nfunction reportGuardedFailure/,
    );
    expect(match, "handleMonitorFailure block should be present").toBeTruthy();
    const body = match ? match[0] : "";
    expect(body).not.toMatch(/process\.exit\(/);
  });

  it("uses guarded scheduler wrappers for monitor-level periodic tasks", () => {
    expect(source).toContain('safeSetInterval("flush-error-queue"');
    expect(source).not.toContain('safeSetInterval("maintenance-sweep"');
    expect(source).not.toContain('safeSetInterval("merged-pr-check"');
    expect(source).toContain('safeSetInterval("epic-merge-check"');
    expect(source).toContain('safeSetInterval("fleet-sync"');
  });

  it("guards telegram bot startup fire-and-forget paths with detached error handling", () => {
    expect(source).toContain('runDetached("primary-agent:init-startup"');
    expect(source).toContain(
      'runDetached("primary-agent:init-config-reload"',
    );
    expect(source).toContain(
      'runDetached("telegram-notifier:restart-config-reload"',
    );
    expect(source).toContain('runDetached("telegram-bot:start-config-reload"');
    expect(source).toContain('runDetached("telegram-bot:start-startup"');
    expect(source).toContain(
      'runDetached("telegram-bootstrap:restore-digest-notifier-status"',
    );
    expect(source).toContain('runDetached("workspace-monitor:stuck-notify"');
  });

  it("contains top-level startProcess exception containment", () => {
    const startProcessMatch = source.match(
      /async function startProcess\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction requestRestart/,
    );
    expect(startProcessMatch, "startProcess function should be present").toBeTruthy();
    const block = startProcessMatch ? startProcessMatch[0] : "";
    expect(block).toContain("try {");
    expect(block).toContain('reportGuardedFailure("startProcess", err);');
    expect(block).toContain('safeSetTimeout("startProcess-retry"');
  });

  it("routes deferred startProcess retries through guarded scheduling", () => {
    expect(source).toContain("function scheduleStartProcess(reason, delayMs)");
    expect(source).toContain(
      "runDetached(`start-process:${reason}`, startProcess);",
    );
    expect(source).not.toMatch(/setTimeout\(startProcess,/);
  });

  it("guards startup fire-and-forget promise chains with catch handlers", () => {
    expect(source).toMatch(
      /void ensureCodexSdkReady\(\)\.then\(\(\) => \{[\s\S]*?\}\)\.catch\(\(err\) => \{/,
    );
    expect(source).toContain("void ensureCodexSdkReady().catch((err) => {");
  });

  it("guards shutdown fire-and-forget paths even when shuttingDown=true", () => {
    expect(source).toContain("function runDetachedDuringShutdown");
    expect(source).toContain(
      'runDetachedDuringShutdown("poll-lock-release:sigint", () =>',
    );
    expect(source).toContain(
      'runDetachedDuringShutdown("poll-lock-release:sigterm", () =>',
    );
    expect(source).toContain(
      'runDetachedDuringShutdown("workspace-monitor-shutdown:exit", () =>',
    );
    expect(source).toContain(
      'runDetachedDuringShutdown("containers-stop:restart-self", () =>',
    );
  });

  it("suppresses broken-pipe EOF writes as benign stream noise", () => {
    expect(source).toContain('msg.includes("write EOF")');
    expect(source).toContain("appendMonitorCrashBreadcrumb(");
    expect(source).not.toContain(
      '"[monitor] suppressed stream noise (uncaughtException): " + msg',
    );
    expect(source).not.toContain(
      '"[monitor] suppressed stream noise (unhandledRejection): " + msg',
    );
  });

  it("routes monitor diagnostic stream writes through guarded helpers", () => {
    expect(source).toContain("function writeMonitorStreamSafely(");
    expect(source).not.toContain('process.stdout.write("[monitor] uncaughtException: " + detail + "\n");');
    expect(source).not.toContain(
      'process.stdout.write("[monitor] " + line + "\n");',
    );
  });
});
