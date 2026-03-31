import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessInputQuality,
  detectRepoGuardrails,
  ensureGuardrailsPolicy,
  loadGuardrailsPolicy,
  saveGuardrailsPolicy,
  shouldBlockAgentPushes,
  shouldRequireManagedPrePush,
} from "../infra/guardrails.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("guardrails", () => {
  it("persists a default workspace policy under .bosun", () => {
    const rootDir = makeTempDir("bosun-guardrails-");

    const policy = ensureGuardrailsPolicy(rootDir);
    const policyPath = resolve(rootDir, ".bosun", "guardrails.json");

    expect(policy.INPUT.enabled).toBe(true);
    expect(policy.INPUT.warnThreshold).toBe(60);
    expect(policy.INPUT.blockThreshold).toBe(35);
    expect(policy.push.workflowOnly).toBe(true);
    expect(policy.push.blockAgentPushes).toBe(true);
    expect(policy.push.requireManagedPrePush).toBe(true);
    expect(existsSync(policyPath)).toBe(true);
    expect(loadGuardrailsPolicy(rootDir).INPUT.minCombinedTokens).toBe(10);
    expect(shouldBlockAgentPushes(rootDir)).toBe(true);
    expect(shouldRequireManagedPrePush(rootDir)).toBe(true);
  });

  it("blocks low-signal input", () => {
    const assessment = assessInputQuality({
      title: "fix",
      description: "",
      metadata: {},
    });

    expect(assessment.blocked).toBe(true);
    expect(assessment.status).toBe("block");
    expect(assessment.findings.map((entry) => entry.id)).toContain("missing-description");
    expect(assessment.findings.map((entry) => entry.id)).toContain("short-title");
  });

  it("passes rich input with concrete context", () => {
    const assessment = assessInputQuality({
      title: "Implement guardrails overview endpoint for the admin page",
      description: "Add a server endpoint that returns runtime, hooks, package script, and INPUT policy information for the active workspace.",
      metadata: {
        repository: "virtengine/bosun",
        tags: ["server", "guardrails"],
      },
      formValues: {
        scope: "backend only",
        expectedBehavior: "Return a single guardrails snapshot for the admin UI.",
      },
    });

    expect(assessment.blocked).toBe(false);
    expect(assessment.status).toBe("pass");
    expect(assessment.score).toBeGreaterThanOrEqual(60);
  });

  it("detects repo-level guardrails from package scripts", () => {
    const rootDir = makeTempDir("bosun-guardrails-scripts-");
    writeFileSync(resolve(rootDir, "package.json"), JSON.stringify({
      name: "guardrails-test",
      scripts: {
        prepush: "npm test",
        prepublishOnly: "npm run build",
        ci: "npm run lint && npm test",
      },
    }, null, 2) + "\n", "utf8");

    const overview = detectRepoGuardrails(rootDir);

    expect(overview.hasPackageJson).toBe(true);
    expect(overview.categories.prepush.detected).toBe(true);
    expect(overview.categories.prepublish.detected).toBe(true);
    expect(overview.categories.ci.detected).toBe(true);
    // detectedCount includes new language-aware categories (test, build, lint)
    // derived from stack detection in addition to the original prepush/prepublish/ci
    expect(overview.detectedCount).toBeGreaterThanOrEqual(3);
    // Verify new stack-aware fields are present
    expect(Array.isArray(overview.stacks)).toBe(true);
    expect(Array.isArray(overview.detectedLanguages)).toBe(true);
  });

  it("writes normalized policy values when saving", () => {
    const rootDir = makeTempDir("bosun-guardrails-save-");

    const saved = saveGuardrailsPolicy(rootDir, {
      INPUT: {
        enabled: "true",
        warnThreshold: 72,
        blockThreshold: 41,
        minTitleLength: 12,
      },
      push: {
        workflowOnly: true,
        blockAgentPushes: false,
        requireManagedPrePush: false,
      },
    });

    const persisted = JSON.parse(readFileSync(resolve(rootDir, ".bosun", "guardrails.json"), "utf8"));
    expect(saved.INPUT.warnThreshold).toBe(72);
    expect(saved.INPUT.blockThreshold).toBe(41);
    expect(saved.push.blockAgentPushes).toBe(false);
    expect(saved.push.requireManagedPrePush).toBe(false);
    expect(persisted.INPUT.minTitleLength).toBe(12);
    expect(shouldBlockAgentPushes(rootDir)).toBe(false);
    expect(shouldRequireManagedPrePush(rootDir)).toBe(false);
  });
});