import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("monitor exception resilience guards", () => {
  const monitorPath = resolve(process.cwd(), "monitor.mjs");
  const source = readFileSync(monitorPath, "utf8");

  it("does not terminate process inside handleMonitorFailure", () => {
    const match = source.match(
      /async function handleMonitorFailure\([\s\S]*?\n\}\n\nfunction reportGuardedFailure/,
    );
    expect(match, "handleMonitorFailure block should be present").toBeTruthy();
    const body = match ? match[0] : "";
    expect(body).not.toMatch(/process\.exit\(/);
  });

  it("uses guarded scheduler wrappers for monitor-level periodic tasks", () => {
    expect(source).toContain('safeSetInterval("flush-error-queue"');
    expect(source).toContain('safeSetInterval("maintenance-sweep"');
    expect(source).toContain('safeSetInterval("merged-pr-check"');
    expect(source).toContain('safeSetInterval("epic-merge-check"');
    expect(source).toContain('safeSetInterval("fleet-sync"');
  });

  it("contains top-level startProcess exception containment", () => {
    const startProcessMatch = source.match(
      /async function startProcess\(\) \{[\s\S]*?\n\}\n\nfunction requestRestart/,
    );
    expect(startProcessMatch, "startProcess function should be present").toBeTruthy();
    const block = startProcessMatch ? startProcessMatch[0] : "";
    expect(block).toContain("try {");
    expect(block).toContain('reportGuardedFailure("startProcess", err);');
    expect(block).toContain('safeSetTimeout("startProcess-retry"');
  });
});