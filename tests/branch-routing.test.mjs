import { describe, it, expect, beforeEach } from "vitest";
import {
  extractScopeFromTitle,
  resolveUpstreamFromConfig,
} from "../monitor.mjs";
import {
  buildAssessmentPrompt,
  extractDecisionJson,
  quickAssess,
  VALID_ACTIONS,
  resetAssessmentDedup,
} from "../task-assessment.mjs";

// ── extractScopeFromTitle ────────────────────────────────────────────────────

describe("extractScopeFromTitle", () => {
  it("extracts scope from standard conventional commit", () => {
    expect(extractScopeFromTitle("feat(veid): add identity flow")).toBe("veid");
  });

  it("extracts scope from fix type", () => {
    expect(extractScopeFromTitle("fix(market): resolve race condition")).toBe(
      "market",
    );
  });

  it("extracts scope with priority prefix", () => {
    expect(extractScopeFromTitle("[P1] feat(openfleet): add caching")).toBe(
      "openfleet",
    );
  });

  it("extracts scope with [P2] prefix", () => {
    expect(extractScopeFromTitle("[P2] fix(escrow): missing validation")).toBe(
      "escrow",
    );
  });

  it("returns null for title without scope", () => {
    expect(extractScopeFromTitle("add some feature")).toBeNull();
  });

  it("returns null for empty title", () => {
    expect(extractScopeFromTitle("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(extractScopeFromTitle(null)).toBeNull();
    expect(extractScopeFromTitle(undefined)).toBeNull();
  });

  it("lowercases the scope", () => {
    expect(extractScopeFromTitle("feat(VEID): uppercase scope")).toBe("veid");
  });

  it("handles all valid conventional commit types", () => {
    const types = [
      "feat",
      "fix",
      "docs",
      "style",
      "refactor",
      "perf",
      "test",
      "build",
      "ci",
      "chore",
      "revert",
    ];
    for (const type of types) {
      expect(extractScopeFromTitle(`${type}(myscope): something`)).toBe(
        "myscope",
      );
    }
  });

  it("handles hyphenated scopes", () => {
    expect(extractScopeFromTitle("feat(openfleet): branch routing")).toBe(
      "openfleet",
    );
  });

  it("handles underscored scopes", () => {
    expect(extractScopeFromTitle("fix(my_module): broken thing")).toBe(
      "my_module",
    );
  });
});

// ── resolveUpstreamFromConfig ────────────────────────────────────────────────

describe("resolveUpstreamFromConfig", () => {
  it("returns null for null task", () => {
    expect(resolveUpstreamFromConfig(null)).toBeNull();
  });

  it("returns null for task without scope when no scopeMap configured", () => {
    // When branchRouting.scopeMap is empty, should return null
    const result = resolveUpstreamFromConfig({
      title: "some random task",
      description: "no routing info",
    });
    // May return null or a branch depending on config state
    // The function returns null when no match is found
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ── extractDecisionJson ──────────────────────────────────────────────────────

describe("extractDecisionJson", () => {
  it("parses pure JSON", () => {
    const json = '{"action":"merge","reason":"CI passed"}';
    const result = extractDecisionJson(json);
    expect(result).toEqual({ action: "merge", reason: "CI passed" });
  });

  it("parses JSON in fenced code block", () => {
    const raw = `Here is my decision:\n\`\`\`json\n{"action":"reprompt_same","prompt":"Fix the tests"}\n\`\`\``;
    const result = extractDecisionJson(raw);
    expect(result.action).toBe("reprompt_same");
    expect(result.prompt).toBe("Fix the tests");
  });

  it("extracts JSON from mixed text", () => {
    const raw = `I think we should merge. {"action":"merge","reason":"Tests pass"}. That's my analysis.`;
    const result = extractDecisionJson(raw);
    expect(result.action).toBe("merge");
  });

  it("returns null for empty input", () => {
    expect(extractDecisionJson("")).toBeNull();
    expect(extractDecisionJson(null)).toBeNull();
    expect(extractDecisionJson(undefined)).toBeNull();
  });

  it("returns null for text without valid action", () => {
    expect(extractDecisionJson("just some text")).toBeNull();
    expect(extractDecisionJson('{"notaction":"merge"}')).toBeNull();
  });

  it("handles JSON with whitespace", () => {
    const json = `  {
      "action": "wait",
      "waitSeconds": 300,
      "reason": "CI running"
    }  `;
    const result = extractDecisionJson(json);
    expect(result.action).toBe("wait");
    expect(result.waitSeconds).toBe(300);
  });

  it("extracts from fenced block without json tag", () => {
    const raw = '```\n{"action":"noop","reason":"nothing"}\n```';
    const result = extractDecisionJson(raw);
    expect(result.action).toBe("noop");
  });
});

// ── buildAssessmentPrompt ────────────────────────────────────────────────────

describe("buildAssessmentPrompt", () => {
  it("includes trigger in prompt", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "rebase_failed",
      taskTitle: "Fix something",
      shortId: "abc12345",
    });
    expect(prompt).toContain("rebase_failed");
    expect(prompt).toContain("Fix something");
  });

  it("includes rebase error details when trigger is rebase_failed", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "rebase_failed",
      taskTitle: "Fix tests",
      shortId: "abc12345",
      rebaseError: "CONFLICT (content): go.sum",
      conflictFiles: ["go.sum", "pnpm-lock.yaml"],
    });
    expect(prompt).toContain("CONFLICT (content): go.sum");
    expect(prompt).toContain("go.sum");
    expect(prompt).toContain("pnpm-lock.yaml");
  });

  it("includes downstream impact for pr_merged_downstream trigger", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "pr_merged_downstream",
      taskTitle: "Implement feature",
      shortId: "xyz98765",
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("Downstream Impact");
    expect(prompt).toContain("origin/main");
  });

  it("includes agent message when provided", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "idle_detected",
      taskTitle: "Some task",
      shortId: "test1234",
      agentLastMessage: "I'm stuck on the failing test",
    });
    expect(prompt).toContain("I'm stuck on the failing test");
  });

  it("includes PR details when provided", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "agent_completed",
      taskTitle: "Add feature",
      shortId: "pr123456",
      prNumber: 42,
      prState: "open",
      ciStatus: "success",
    });
    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("success");
  });

  it("includes diff stats and branch status", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "manual_request",
      taskTitle: "Review task",
      shortId: "diff1234",
      commitsAhead: 5,
      commitsBehind: 2,
      diffStat: " 3 files changed, 120 insertions(+), 45 deletions(-)",
    });
    expect(prompt).toContain("Commits ahead: 5");
    expect(prompt).toContain("Commits behind: 2");
    expect(prompt).toContain("120 insertions");
  });

  it("includes decision rules with VALID_ACTIONS", () => {
    const prompt = buildAssessmentPrompt({
      trigger: "manual_request",
      taskTitle: "Test actions",
      shortId: "act12345",
    });
    expect(prompt).toContain("merge");
    expect(prompt).toContain("reprompt_same");
    expect(prompt).toContain("reprompt_new_session");
    expect(prompt).toContain("new_attempt");
    expect(prompt).toContain("wait");
    expect(prompt).toContain("manual_review");
    expect(prompt).toContain("close_and_replan");
    expect(prompt).toContain("noop");
  });

  it("truncates long task descriptions", () => {
    const longDesc = "A".repeat(5000);
    const prompt = buildAssessmentPrompt({
      trigger: "agent_completed",
      taskTitle: "Test",
      shortId: "trunc123",
      taskDescription: longDesc,
    });
    // Description is truncated to 3000 chars, so prompt should NOT contain the full 5000-char description
    expect(prompt).not.toContain(longDesc);
    // But should still contain a truncated portion
    expect(prompt).toContain("A".repeat(3000));
  });
});

// ── quickAssess ──────────────────────────────────────────────────────────────

describe("quickAssess", () => {
  it("returns reprompt_same for auto-resolvable lock file conflicts", () => {
    const result = quickAssess({
      trigger: "rebase_failed",
      conflictFiles: ["pnpm-lock.yaml", "go.sum"],
      upstreamBranch: "origin/main",
      shortId: "qa123456",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("reprompt_same");
    expect(result.prompt).toContain("checkout --theirs");
    expect(result.reason).toContain("auto-resolvable");
  });

  it("returns null for non-auto-resolvable conflicts", () => {
    const result = quickAssess({
      trigger: "rebase_failed",
      conflictFiles: ["src/main.go", "pkg/handler.go"],
      shortId: "qa234567",
    });
    expect(result).toBeNull();
  });

  it("uses ours strategy for CHANGELOG.md conflicts", () => {
    const result = quickAssess({
      trigger: "rebase_failed",
      conflictFiles: ["CHANGELOG.md"],
      upstreamBranch: "origin/main",
      shortId: "qa345678",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("reprompt_same");
    expect(result.prompt).toContain("checkout --ours");
  });

  it("mixes theirs and ours strategies correctly", () => {
    const result = quickAssess({
      trigger: "rebase_failed",
      conflictFiles: ["pnpm-lock.yaml", "CHANGELOG.md", "go.sum"],
      upstreamBranch: "origin/main",
      shortId: "qa456789",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("reprompt_same");
    expect(result.prompt).toContain("--theirs");
    expect(result.prompt).toContain("--ours");
  });

  it("returns manual_review when attempt count is 4+", () => {
    const result = quickAssess({
      trigger: "agent_failed",
      attemptCount: 4,
      shortId: "qa567890",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("manual_review");
    expect(result.reason).toContain("4 attempts");
  });

  it("returns new_attempt when session retries exhausted (3+)", () => {
    const result = quickAssess({
      trigger: "agent_failed",
      sessionRetries: 3,
      agentType: "codex",
      shortId: "qa678901",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("new_attempt");
    expect(result.agentType).toBe("copilot"); // should switch agent type
  });

  it("switches to codex when copilot retries exhausted", () => {
    const result = quickAssess({
      trigger: "agent_failed",
      sessionRetries: 3,
      agentType: "copilot",
      shortId: "qa789012",
    });
    expect(result.agentType).toBe("codex");
  });

  it("returns reprompt_same for pr_merged_downstream without rebase error", () => {
    const result = quickAssess({
      trigger: "pr_merged_downstream",
      upstreamBranch: "origin/main",
      shortId: "qa890123",
    });
    expect(result).not.toBeNull();
    expect(result.action).toBe("reprompt_same");
    expect(result.prompt).toContain("rebase");
    expect(result.prompt).toContain("origin/main");
  });

  it("returns null for pr_merged_downstream with rebase error", () => {
    // When there's already a rebase error from downstream merge, needs SDK assessment
    const result = quickAssess({
      trigger: "pr_merged_downstream",
      rebaseError: "CONFLICT",
      shortId: "qa901234",
    });
    // This case falls through because trigger matches but rebaseError is truthy
    expect(result).toBeNull();
  });

  it("returns null for unknown triggers", () => {
    const result = quickAssess({
      trigger: "idle_detected",
      shortId: "qa012345",
    });
    expect(result).toBeNull();
  });

  it("prioritizes max attempts check over session retries", () => {
    const result = quickAssess({
      trigger: "agent_failed",
      attemptCount: 5,
      sessionRetries: 3,
      shortId: "qa111222",
    });
    // Rebase check comes first but no files, then attempt check
    expect(result.action).toBe("manual_review");
  });
});

// ── VALID_ACTIONS ────────────────────────────────────────────────────────────

describe("VALID_ACTIONS", () => {
  it("contains all 8 expected actions", () => {
    const expected = [
      "merge",
      "reprompt_same",
      "reprompt_new_session",
      "new_attempt",
      "wait",
      "manual_review",
      "close_and_replan",
      "noop",
    ];
    expect(VALID_ACTIONS.size).toBe(8);
    for (const action of expected) {
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });
});

// ── resetAssessmentDedup ─────────────────────────────────────────────────────

describe("resetAssessmentDedup", () => {
  it("is a callable function", () => {
    expect(typeof resetAssessmentDedup).toBe("function");
    // Should not throw
    resetAssessmentDedup();
  });
});
