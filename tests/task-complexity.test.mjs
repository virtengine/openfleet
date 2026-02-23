import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyComplexity,
  getModelForComplexity,
  resolveExecutorForTask,
  formatComplexityDecision,
  getComplexityMatrix,
  assessCompletionConfidence,
  COMPLEXITY_TIERS,
  SIZE_TO_COMPLEXITY,
  DEFAULT_MODEL_PROFILES,
  COMPLETION_CONFIDENCE,
  MODEL_ALIASES,
} from "../task-complexity.mjs";

// ── classifyComplexity ───────────────────────────────────────────────────────

describe("classifyComplexity", () => {
  it("maps xs to LOW", () => {
    const result = classifyComplexity({ sizeLabel: "xs" });
    expect(result.tier).toBe("low");
    expect(result.sizeLabel).toBe("xs");
    expect(result.adjusted).toBe(false);
  });

  it("maps s to LOW", () => {
    const result = classifyComplexity({ sizeLabel: "s" });
    expect(result.tier).toBe("low");
  });

  it("maps m to MEDIUM", () => {
    const result = classifyComplexity({ sizeLabel: "m" });
    expect(result.tier).toBe("medium");
  });

  it("maps l to HIGH", () => {
    const result = classifyComplexity({ sizeLabel: "l" });
    expect(result.tier).toBe("high");
  });

  it("maps xl to HIGH", () => {
    const result = classifyComplexity({ sizeLabel: "xl" });
    expect(result.tier).toBe("high");
  });

  it("maps xxl to HIGH", () => {
    const result = classifyComplexity({ sizeLabel: "xxl" });
    expect(result.tier).toBe("high");
  });

  it("defaults to MEDIUM when no sizeLabel or points", () => {
    const result = classifyComplexity({});
    expect(result.tier).toBe("medium");
    expect(result.sizeLabel).toBe("m");
  });

  it("resolves size from points when no sizeLabel", () => {
    expect(classifyComplexity({ points: 1 }).sizeLabel).toBe("xs");
    expect(classifyComplexity({ points: 2 }).sizeLabel).toBe("s");
    expect(classifyComplexity({ points: 3 }).sizeLabel).toBe("m");
    expect(classifyComplexity({ points: 8 }).sizeLabel).toBe("l");
    expect(classifyComplexity({ points: 13 }).sizeLabel).toBe("xl");
    expect(classifyComplexity({ points: 21 }).sizeLabel).toBe("xxl");
  });

  describe("keyword escalation", () => {
    it("escalates LOW to MEDIUM on architecture keywords", () => {
      const result = classifyComplexity({
        sizeLabel: "s",
        title: "refactor entire auth module",
      });
      expect(result.tier).toBe("medium");
      expect(result.adjusted).toBe(true);
    });

    it("escalates MEDIUM to HIGH on security keywords", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "security audit for encryption scheme",
      });
      expect(result.tier).toBe("high");
      expect(result.adjusted).toBe(true);
    });

    it("escalates on consensus keywords", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "implement determinism controls for state machine",
      });
      expect(result.tier).toBe("high");
      expect(result.adjusted).toBe(true);
    });

    it("does NOT escalate HIGH (already max)", () => {
      const result = classifyComplexity({
        sizeLabel: "xl",
        title: "overhaul security audit",
      });
      expect(result.tier).toBe("high");
      expect(result.adjusted).toBe(false);
    });
  });

  describe("keyword simplification", () => {
    it("simplifies HIGH to MEDIUM on typo fix", () => {
      const result = classifyComplexity({
        sizeLabel: "l",
        title: "fix typos in readme",
      });
      expect(result.tier).toBe("medium");
      expect(result.adjusted).toBe(true);
    });

    it("simplifies MEDIUM to LOW on docs-only", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "docs only: update changelog",
      });
      expect(result.tier).toBe("low");
      expect(result.adjusted).toBe(true);
    });

    it("simplifies on bump version", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "bump version dependency",
      });
      expect(result.tier).toBe("low");
      expect(result.adjusted).toBe(true);
    });

    it("simplifies on lint fix", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "eslint fix in provider module",
      });
      expect(result.tier).toBe("low");
      expect(result.adjusted).toBe(true);
    });

    it("does NOT simplify LOW (already min)", () => {
      const result = classifyComplexity({
        sizeLabel: "xs",
        title: "fix typos in docs",
      });
      expect(result.tier).toBe("low");
      expect(result.adjusted).toBe(false);
    });
  });

  describe("conflicting signals cancel out", () => {
    it("keeps base tier when both escalators and simplifiers match", () => {
      const result = classifyComplexity({
        sizeLabel: "m",
        title: "overhaul readme docs only update",
      });
      expect(result.tier).toBe("medium");
      expect(result.adjusted).toBe(false);
    });
  });

  it("uses description in addition to title", () => {
    const result = classifyComplexity({
      sizeLabel: "s",
      title: "update module",
      description: "This requires a multi-module cross-cutting refactor",
    });
    expect(result.tier).toBe("medium");
    expect(result.adjusted).toBe(true);
  });
});

// ── getModelForComplexity ────────────────────────────────────────────────────

describe("getModelForComplexity", () => {
  it("returns correct CODEX model for LOW", () => {
    const result = getModelForComplexity("low", "CODEX");
    expect(result.model).toBe("gpt-5.1-codex-mini");
    expect(result.variant).toBe("GPT51_CODEX_MINI");
    expect(result.reasoningEffort).toBe("low");
  });

  it("returns correct CODEX model for MEDIUM", () => {
    const result = getModelForComplexity("medium", "CODEX");
    expect(result.model).toBe("gpt-5.2-codex");
    expect(result.variant).toBe("DEFAULT");
    expect(result.reasoningEffort).toBe("medium");
  });

  it("returns correct CODEX model for HIGH", () => {
    const result = getModelForComplexity("high", "CODEX");
    expect(result.model).toBe("gpt-5.1-codex-max");
    expect(result.variant).toBe("GPT51_CODEX_MAX");
    expect(result.reasoningEffort).toBe("high");
  });

  it("returns correct COPILOT model for LOW", () => {
    const result = getModelForComplexity("low", "COPILOT");
    expect(result.model).toBe("haiku-4.5");
    expect(result.variant).toBe("CLAUDE_HAIKU_4_5");
    expect(result.reasoningEffort).toBe("low");
  });

  it("returns correct COPILOT model for MEDIUM", () => {
    const result = getModelForComplexity("medium", "COPILOT");
    expect(result.model).toBe("sonnet-4.5");
    expect(result.variant).toBe("CLAUDE_SONNET_4_5");
    expect(result.reasoningEffort).toBe("medium");
  });

  it("returns correct COPILOT model for HIGH", () => {
    const result = getModelForComplexity("high", "COPILOT");
    expect(result.model).toBe("opus-4.6");
    expect(result.variant).toBe("CLAUDE_OPUS_4_6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("respects user config overrides", () => {
    const overrides = {
      models: {
        CODEX: {
          low: {
            model: "custom-mini",
            variant: "CUSTOM",
            reasoningEffort: "minimal",
          },
        },
      },
    };
    const result = getModelForComplexity("low", "CODEX", overrides);
    expect(result.model).toBe("custom-mini");
    expect(result.variant).toBe("CUSTOM");
    expect(result.reasoningEffort).toBe("minimal");
  });

  it("falls back to defaults for unknown executor type", () => {
    const result = getModelForComplexity("high", "UNKNOWN_TYPE");
    expect(result.model).toBeNull();
    expect(result.reasoningEffort).toBe("high");
  });

  it("handles case-insensitive executor type", () => {
    const result = getModelForComplexity("medium", "copilot");
    expect(result.model).toBe("sonnet-4.5");
  });

  it("falls back to MEDIUM for unknown tier", () => {
    const result = getModelForComplexity("ultra", "CODEX");
    expect(result.model).toBe("gpt-5.2-codex");
  });
});

// ── resolveExecutorForTask ───────────────────────────────────────────────────

describe("resolveExecutorForTask", () => {
  const baseCodexProfile = {
    name: "codex-default",
    executor: "CODEX",
    variant: "DEFAULT",
    weight: 100,
    role: "primary",
    enabled: true,
  };

  const baseCopilotProfile = {
    name: "copilot-claude",
    executor: "COPILOT",
    variant: "CLAUDE_OPUS_4_6",
    weight: 50,
    role: "backup",
    enabled: true,
  };

  it("routes small task to CODEX mini model", () => {
    const task = { title: "fix typo", size: "xs" };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.model).toBe("gpt-5.1-codex-mini");
    expect(result.variant).toBe("GPT51_CODEX_MINI");
    expect(result.reasoningEffort).toBe("low");
    expect(result.complexity.tier).toBe("low");
  });

  it("routes medium task to CODEX default model", () => {
    const task = { title: "implement feature", size: "m" };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.model).toBe("gpt-5.2-codex");
    expect(result.variant).toBe("DEFAULT");
    expect(result.reasoningEffort).toBe("medium");
    expect(result.complexity.tier).toBe("medium");
  });

  it("routes large task to CODEX top model", () => {
    const task = { title: "architect new module", size: "xl" };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.model).toBe("gpt-5.1-codex-max");
    expect(result.variant).toBe("GPT51_CODEX_MAX");
    expect(result.reasoningEffort).toBe("high");
    expect(result.complexity.tier).toBe("high");
  });

  it("routes small task to COPILOT haiku", () => {
    const task = { title: "update readme", size: "s" };
    const result = resolveExecutorForTask(task, baseCopilotProfile);
    expect(result.model).toBe("haiku-4.5");
    expect(result.variant).toBe("CLAUDE_HAIKU_4_5");
    expect(result.complexity.tier).toBe("low");
  });

  it("routes large COPILOT task to opus", () => {
    const task = { title: "overhaul provider daemon", size: "xxl" };
    const result = resolveExecutorForTask(task, baseCopilotProfile);
    expect(result.model).toBe("opus-4.6");
    expect(result.variant).toBe("CLAUDE_OPUS_4_6");
    expect(result.complexity.tier).toBe("high");
  });

  it("preserves original profile reference", () => {
    const task = { title: "test task", size: "m" };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.original).toBe(baseCodexProfile);
    expect(result.executor).toBe("CODEX");
  });

  it("returns disabled complexity info when routing is off", () => {
    const task = { title: "test task", size: "xl" };
    const result = resolveExecutorForTask(task, baseCodexProfile, {
      enabled: false,
    });
    expect(result.complexity).toBeNull();
    expect(result.model).toBeNull();
    expect(result.executor).toBe("CODEX");
  });

  it("extracts size from task metadata", () => {
    const task = { title: "work", metadata: { size: "l" } };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.complexity.tier).toBe("high");
  });

  it("extracts size from title bracket pattern", () => {
    const task = { title: "[xl] complex refactor" };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.complexity.tier).toBe("high");
  });

  it("handles null task gracefully", () => {
    const result = resolveExecutorForTask(null, baseCodexProfile);
    expect(result.executor).toBe("CODEX");
    expect(result.complexity.tier).toBe("medium"); // default
  });

  it("handles null profiles gracefully", () => {
    const task = { title: "test", size: "m" };
    const result = resolveExecutorForTask(task, null);
    expect(result.executor).toBe("CODEX");
    expect(result.complexity.tier).toBe("medium");
  });

  it("applies config model overrides", () => {
    const task = { title: "test", size: "m" };
    const config = {
      models: {
        CODEX: {
          medium: {
            model: "custom-model",
            variant: "CUSTOM_V",
            reasoningEffort: "high",
          },
        },
      },
    };
    const result = resolveExecutorForTask(task, baseCodexProfile, config);
    expect(result.model).toBe("custom-model");
    expect(result.variant).toBe("CUSTOM_V");
    expect(result.reasoningEffort).toBe("high");
  });

  it("extracts numeric points from task", () => {
    const task = { title: "work", points: 13 };
    const result = resolveExecutorForTask(task, baseCodexProfile);
    expect(result.complexity.sizeLabel).toBe("xl");
    expect(result.complexity.tier).toBe("high");
  });
});

// ── formatComplexityDecision ─────────────────────────────────────────────────

describe("formatComplexityDecision", () => {
  it("formats a full decision string", () => {
    const resolved = {
      complexity: { tier: "high", sizeLabel: "xl", adjusted: false },
      model: "gpt-5.1-codex-max",
      reasoningEffort: "high",
      executor: "CODEX",
    };
    const str = formatComplexityDecision(resolved);
    expect(str).toContain("complexity=high");
    expect(str).toContain("size=xl");
    expect(str).toContain("model=gpt-5.1-codex-max");
    expect(str).toContain("reasoning=high");
    expect(str).toContain("executor=CODEX");
    expect(str).not.toContain("adjusted=true");
  });

  it("includes adjusted flag when true", () => {
    const resolved = {
      complexity: { tier: "medium", sizeLabel: "s", adjusted: true },
      model: "gpt-5.2-codex",
      reasoningEffort: "medium",
      executor: "CODEX",
    };
    const str = formatComplexityDecision(resolved);
    expect(str).toContain("adjusted=true");
  });

  it("returns disabled string when no complexity", () => {
    expect(formatComplexityDecision({})).toBe("complexity=disabled");
    expect(formatComplexityDecision({ complexity: null })).toBe(
      "complexity=disabled",
    );
  });
});

// ── getComplexityMatrix ──────────────────────────────────────────────────────

describe("getComplexityMatrix", () => {
  it("returns full matrix of all tiers × executor types", () => {
    const matrix = getComplexityMatrix();
    expect(matrix.CODEX).toBeDefined();
    expect(matrix.COPILOT).toBeDefined();
    expect(Object.keys(matrix.CODEX)).toEqual(["low", "medium", "high"]);
    expect(Object.keys(matrix.COPILOT)).toEqual(["low", "medium", "high"]);
    expect(matrix.CODEX.low.model).toBe("gpt-5.1-codex-mini");
    expect(matrix.COPILOT.high.model).toBe("opus-4.6");
  });

  it("applies config overrides to the matrix", () => {
    const overrides = {
      models: {
        CODEX: {
          low: { model: "custom", variant: "X", reasoningEffort: "none" },
        },
      },
    };
    const matrix = getComplexityMatrix(overrides);
    expect(matrix.CODEX.low.model).toBe("custom");
    expect(matrix.CODEX.medium.model).toBe("gpt-5.2-codex"); // unchanged
  });
});

// ── assessCompletionConfidence ────────────────────────────────────────────────

describe("assessCompletionConfidence", () => {
  it("returns CONFIDENT when all checks pass", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: true,
      filesChanged: 3,
      attemptCount: 1,
      complexityTier: "medium",
    });
    expect(result.confidence).toBe("confident");
    expect(result.shouldAutoMerge).toBe(true);
  });

  it("returns FAILED when tests fail", () => {
    const result = assessCompletionConfidence({
      testsPass: false,
      buildClean: true,
      lintClean: true,
    });
    expect(result.confidence).toBe("failed");
    expect(result.shouldAutoMerge).toBe(false);
  });

  it("returns FAILED when build has errors", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: false,
      lintClean: true,
    });
    expect(result.confidence).toBe("failed");
    expect(result.shouldAutoMerge).toBe(false);
  });

  it("returns NEEDS_REVIEW for high complexity with many files and no test coverage", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: true,
      filesChanged: 15,
      complexityTier: "high",
      hasTestCoverage: false,
    });
    expect(result.confidence).toBe("needs-review");
    expect(result.shouldAutoMerge).toBe(false);
  });

  it("returns NEEDS_REVIEW after 3+ attempts", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: true,
      attemptCount: 3,
    });
    expect(result.confidence).toBe("needs-review");
  });

  it("returns NEEDS_REVIEW when warnings present", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: true,
      warnings: ["deprecated API usage"],
    });
    expect(result.confidence).toBe("needs-review");
  });

  it("returns NEEDS_REVIEW when lint fails", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: false,
    });
    expect(result.confidence).toBe("needs-review");
    expect(result.shouldAutoMerge).toBe(false);
  });

  it("returns CONFIDENT for high complexity with test coverage", () => {
    const result = assessCompletionConfidence({
      testsPass: true,
      buildClean: true,
      lintClean: true,
      filesChanged: 15,
      complexityTier: "high",
      hasTestCoverage: true,
    });
    expect(result.confidence).toBe("confident");
    expect(result.shouldAutoMerge).toBe(true);
  });
});

// ── Constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("SIZE_TO_COMPLEXITY covers all standard sizes", () => {
    expect(SIZE_TO_COMPLEXITY.xs).toBe("low");
    expect(SIZE_TO_COMPLEXITY.s).toBe("low");
    expect(SIZE_TO_COMPLEXITY.m).toBe("medium");
    expect(SIZE_TO_COMPLEXITY.l).toBe("high");
    expect(SIZE_TO_COMPLEXITY.xl).toBe("high");
    expect(SIZE_TO_COMPLEXITY.xxl).toBe("high");
  });

  it("COMPLEXITY_TIERS has exactly 3 values", () => {
    expect(Object.values(COMPLEXITY_TIERS)).toEqual(["low", "medium", "high"]);
  });

  it("DEFAULT_MODEL_PROFILES covers CODEX and COPILOT", () => {
    expect(DEFAULT_MODEL_PROFILES.CODEX).toBeDefined();
    expect(DEFAULT_MODEL_PROFILES.COPILOT).toBeDefined();
  });

  it("COMPLETION_CONFIDENCE has expected values", () => {
    expect(COMPLETION_CONFIDENCE.CONFIDENT).toBe("confident");
    expect(COMPLETION_CONFIDENCE.NEEDS_REVIEW).toBe("needs-review");
    expect(COMPLETION_CONFIDENCE.PARTIAL).toBe("partial");
    expect(COMPLETION_CONFIDENCE.FAILED).toBe("failed");
  });

  it("MODEL_ALIASES contains all available models", () => {
    expect(MODEL_ALIASES).toBeDefined();
    expect(MODEL_ALIASES["gpt-5.1-codex-mini"]).toEqual({
      executor: "CODEX",
      variant: "GPT51_CODEX_MINI",
    });
    expect(MODEL_ALIASES["gpt-5.2-codex"]).toEqual({
      executor: "CODEX",
      variant: "DEFAULT",
    });
    expect(MODEL_ALIASES["gpt-5.1-codex-max"]).toEqual({
      executor: "CODEX",
      variant: "GPT51_CODEX_MAX",
    });
    expect(MODEL_ALIASES["claude-opus-4.6"]).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
    });
    expect(MODEL_ALIASES["opus-4.6"]).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
    });
    expect(MODEL_ALIASES["sonnet-4.5"]).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_SONNET_4_5",
    });
    expect(MODEL_ALIASES["haiku-4.5"]).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_HAIKU_4_5",
    });
    expect(MODEL_ALIASES["claude-code"]).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_CODE",
    });
    expect(Object.keys(MODEL_ALIASES)).toHaveLength(8);
  });
});

// ── New complexity signal patterns ───────────────────────────────────────────

describe("new escalator signal patterns", () => {
  it("escalates on load test / stress test keywords", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "Load Testing 1M Nodes",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on stress test keyword", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "run stress test on provider endpoints",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on service mesh keyword", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "implement service mesh with mTLS",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on circuit breaker keyword", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "add circuit breaker to provider gateway",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on Est. LOC > 3000 in description", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "build new module",
      description: "Est. LOC: 5,000–8,000 lines of infrastructure code",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on multi-file failures (10+ files)", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "Fix 78 tests failing across modules",
      description: "15 files fail with import errors",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on disaster recovery keywords", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "Disaster Recovery & Failover Testing",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });

  it("escalates on CRITICAL keyword", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "CRITICAL: fix consensus bug",
    });
    expect(result.tier).toBe("high");
    expect(result.adjusted).toBe(true);
  });
});

describe("new simplifier signal patterns", () => {
  it("simplifies on 'Plan next tasks' title", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "Plan next tasks for sprint",
    });
    expect(result.tier).toBe("low");
    expect(result.adjusted).toBe(true);
  });

  it("simplifies on manual-telegram/triage keyword", () => {
    const result = classifyComplexity({
      sizeLabel: "m",
      title: "manual-telegram triage of incoming requests",
    });
    expect(result.tier).toBe("low");
    expect(result.adjusted).toBe(true);
  });
});
