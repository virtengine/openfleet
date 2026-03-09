import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AGENT_TYPES,
  INTERACTION_TYPES,
  CONTENT_TYPES,
  DEFAULT_SHREDDING_CONFIG,
  loadContextShreddingConfig,
  resolveContextShreddingOptions,
  getDefaultOptions,
  CONTEXT_SHREDDING_ENV_DEFS,
  _resetConfigCache,
} from "../config/context-shredding-config.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("AGENT_TYPES", () => {
  it("is frozen and contains expected SDK names", () => {
    expect(Object.isFrozen(AGENT_TYPES)).toBe(true);
    expect(AGENT_TYPES).toContain("codex-sdk");
    expect(AGENT_TYPES).toContain("claude-sdk");
    expect(AGENT_TYPES).toContain("copilot-sdk");
    expect(AGENT_TYPES).toContain("gemini-sdk");
    expect(AGENT_TYPES).toContain("opencode-sdk");
    expect(AGENT_TYPES).toHaveLength(5);
  });
});

describe("INTERACTION_TYPES", () => {
  it("is frozen and contains expected session types", () => {
    expect(Object.isFrozen(INTERACTION_TYPES)).toBe(true);
    expect(INTERACTION_TYPES).toContain("task");
    expect(INTERACTION_TYPES).toContain("chat");
    expect(INTERACTION_TYPES).toContain("voice");
    expect(INTERACTION_TYPES).toContain("flow");
    expect(INTERACTION_TYPES).toContain("manual");
    expect(INTERACTION_TYPES).toContain("primary");
  });
});

describe("CONTENT_TYPES", () => {
  it("is frozen and contains expected content types", () => {
    expect(Object.isFrozen(CONTENT_TYPES)).toBe(true);
    expect(CONTENT_TYPES).toContain("tool_output");
    expect(CONTENT_TYPES).toContain("agent_message");
    expect(CONTENT_TYPES).toContain("user_message");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SHREDDING_CONFIG
// ---------------------------------------------------------------------------
describe("DEFAULT_SHREDDING_CONFIG", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_SHREDDING_CONFIG)).toBe(true);
  });

  it("has expected default values matching context-cache.mjs constants", () => {
    expect(DEFAULT_SHREDDING_CONFIG.enabled).toBe(true);
    expect(DEFAULT_SHREDDING_CONFIG.fullContextTurns).toBe(3);
    expect(DEFAULT_SHREDDING_CONFIG.tier1MaxAge).toBe(5);
    expect(DEFAULT_SHREDDING_CONFIG.tier2MaxAge).toBe(9);
    expect(DEFAULT_SHREDDING_CONFIG.tier1HeadChars).toBe(2000);
    expect(DEFAULT_SHREDDING_CONFIG.tier1TailChars).toBe(800);
    expect(DEFAULT_SHREDDING_CONFIG.tier2HeadChars).toBe(600);
    expect(DEFAULT_SHREDDING_CONFIG.tier2TailChars).toBe(300);
    expect(DEFAULT_SHREDDING_CONFIG.scoreHighThreshold).toBe(70);
    expect(DEFAULT_SHREDDING_CONFIG.scoreLowThreshold).toBe(30);
    expect(DEFAULT_SHREDDING_CONFIG.compressMessages).toBe(true);
    expect(DEFAULT_SHREDDING_CONFIG.compressToolOutputs).toBe(true);
    expect(DEFAULT_SHREDDING_CONFIG.compressAgentMessages).toBe(true);
    expect(DEFAULT_SHREDDING_CONFIG.compressUserMessages).toBe(true);
    expect(DEFAULT_SHREDDING_CONFIG.msgTier0MaxAge).toBe(1);
    expect(DEFAULT_SHREDDING_CONFIG.msgTier1MaxAge).toBe(4);
    expect(DEFAULT_SHREDDING_CONFIG.msgMinCompressChars).toBe(120);
    expect(DEFAULT_SHREDDING_CONFIG.userMsgFullTurns).toBe(1);
  });

  it("has empty perType and perAgent by default", () => {
    expect(DEFAULT_SHREDDING_CONFIG.perType).toEqual({});
    expect(DEFAULT_SHREDDING_CONFIG.perAgent).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// loadContextShreddingConfig
// ---------------------------------------------------------------------------
describe("loadContextShreddingConfig", () => {
  it("returns defaults when no env vars are set", () => {
    const vars = {};
    for (const d of CONTEXT_SHREDDING_ENV_DEFS) {
      vars[d.key] = undefined;
    }
    const cfg = withEnv(vars, () => loadContextShreddingConfig());
    expect(cfg.enabled).toBe(true);
    expect(cfg.fullContextTurns).toBe(3);
    expect(cfg.tier1MaxAge).toBe(5);
    expect(cfg.tier2MaxAge).toBe(9);
  });

  it("parses CONTEXT_SHREDDING_ENABLED=false correctly", () => {
    const cfg = withEnv({ CONTEXT_SHREDDING_ENABLED: "false" }, () =>
      loadContextShreddingConfig(),
    );
    expect(cfg.enabled).toBe(false);
  });

  it("parses CONTEXT_SHREDDING_ENABLED=1 as true", () => {
    const cfg = withEnv({ CONTEXT_SHREDDING_ENABLED: "1" }, () =>
      loadContextShreddingConfig(),
    );
    expect(cfg.enabled).toBe(true);
  });

  it("parses integer env vars", () => {
    const cfg = withEnv(
      {
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "5",
        CONTEXT_SHREDDING_TIER1_MAX_AGE: "8",
        CONTEXT_SHREDDING_TIER2_MAX_AGE: "15",
        CONTEXT_SHREDDING_TIER1_HEAD_CHARS: "3000",
        CONTEXT_SHREDDING_TIER1_TAIL_CHARS: "1200",
        CONTEXT_SHREDDING_SCORE_HIGH: "80",
        CONTEXT_SHREDDING_SCORE_LOW: "20",
      },
      () => loadContextShreddingConfig(),
    );
    expect(cfg.fullContextTurns).toBe(5);
    expect(cfg.tier1MaxAge).toBe(8);
    expect(cfg.tier2MaxAge).toBe(15);
    expect(cfg.tier1HeadChars).toBe(3000);
    expect(cfg.tier1TailChars).toBe(1200);
    expect(cfg.scoreHighThreshold).toBe(80);
    expect(cfg.scoreLowThreshold).toBe(20);
  });

  it("clamps integer values to min/max bounds", () => {
    const cfg = withEnv(
      {
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "999",   // max is 20
        CONTEXT_SHREDDING_TIER1_MAX_AGE: "0",            // min is 1
      },
      () => loadContextShreddingConfig(),
    );
    expect(cfg.fullContextTurns).toBe(20);
    expect(cfg.tier1MaxAge).toBe(1);
  });

  it("parses boolean message compression toggles", () => {
    const cfg = withEnv(
      {
        CONTEXT_SHREDDING_COMPRESS_MESSAGES: "false",
        CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS: "false",
        CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES: "false",
        CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES: "false",
      },
      () => loadContextShreddingConfig(),
    );
    expect(cfg.compressMessages).toBe(false);
    expect(cfg.compressToolOutputs).toBe(false);
    expect(cfg.compressAgentMessages).toBe(false);
    expect(cfg.compressUserMessages).toBe(false);
  });

  it("parses CONTEXT_SHREDDING_PROFILES JSON correctly", () => {
    const profiles = JSON.stringify({
      perType: { voice: { fullContextTurns: 6 }, chat: { tier1MaxAge: 7 } },
      perAgent: { "claude-sdk": { tier2MaxAge: 12 } },
    });
    const cfg = withEnv({ CONTEXT_SHREDDING_PROFILES: profiles }, () =>
      loadContextShreddingConfig(),
    );
    expect(cfg.perType.voice.fullContextTurns).toBe(6);
    expect(cfg.perType.chat.tier1MaxAge).toBe(7);
    expect(cfg.perAgent["claude-sdk"].tier2MaxAge).toBe(12);
  });

  it("silently ignores invalid CONTEXT_SHREDDING_PROFILES JSON", () => {
    const cfg = withEnv(
      { CONTEXT_SHREDDING_PROFILES: "not-valid-json{{" },
      () => loadContextShreddingConfig(),
    );
    expect(cfg.perType).toEqual({});
    expect(cfg.perAgent).toEqual({});
  });

  it("ignores non-numeric values for integer fields", () => {
    const cfg = withEnv(
      { CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "banana" },
      () => loadContextShreddingConfig(),
    );
    // Falls back to default when NaN
    expect(cfg.fullContextTurns).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getDefaultOptions
// ---------------------------------------------------------------------------
describe("getDefaultOptions", () => {
  it("returns an object with all expected fields", () => {
    const opts = getDefaultOptions();
    expect(opts).toHaveProperty("fullContextTurns", 3);
    expect(opts).toHaveProperty("tier1MaxAge", 5);
    expect(opts).toHaveProperty("tier2MaxAge", 9);
    expect(opts).toHaveProperty("tier1HeadChars", 2000);
    expect(opts).toHaveProperty("tier1TailChars", 800);
    expect(opts).toHaveProperty("tier2HeadChars", 600);
    expect(opts).toHaveProperty("tier2TailChars", 300);
    expect(opts).toHaveProperty("scoreHighThreshold", 70);
    expect(opts).toHaveProperty("scoreLowThreshold", 30);
    expect(opts).toHaveProperty("compressMessages", true);
    expect(opts).toHaveProperty("compressToolOutputs", true);
    expect(opts).toHaveProperty("compressAgentMessages", true);
    expect(opts).toHaveProperty("compressUserMessages", true);
    expect(opts).toHaveProperty("msgTier0MaxAge", 1);
    expect(opts).toHaveProperty("msgTier1MaxAge", 4);
    expect(opts).toHaveProperty("msgMinCompressChars", 120);
    expect(opts).toHaveProperty("userMsgFullTurns", 1);
  });

  it("does NOT include perType or perAgent (these are config, not options)", () => {
    const opts = getDefaultOptions();
    expect(opts).not.toHaveProperty("perType");
    expect(opts).not.toHaveProperty("perAgent");
  });
});

// ---------------------------------------------------------------------------
// resolveContextShreddingOptions
// ---------------------------------------------------------------------------
describe("resolveContextShreddingOptions", () => {
  // resolveContextShreddingOptions uses getContextShreddingConfig() which
  // caches at module scope. Reset the cache before each test so env changes
  // propagate correctly.
  beforeEach(() => _resetConfigCache());
  afterEach(() => _resetConfigCache());

  it("returns _skip when shredding is disabled via env", () => {
    const opts = withEnv(
      { CONTEXT_SHREDDING_ENABLED: "false" },
      () => resolveContextShreddingOptions(),
    );
    expect(opts._skip).toBe(true);
  });

  it("returns full options object when enabled", () => {
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: undefined,
        CONTEXT_SHREDDING_TIER1_MAX_AGE: undefined,
      },
      () => resolveContextShreddingOptions(),
    );
    expect(opts._skip).toBeUndefined();
    expect(opts.fullContextTurns).toBe(3);
    expect(opts.tier1MaxAge).toBe(5);
  });

  it("applies per-interaction-type overrides", () => {
    const profiles = JSON.stringify({
      perType: { voice: { fullContextTurns: 6, tier1MaxAge: 8 } },
    });
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_PROFILES: profiles,
      },
      () => resolveContextShreddingOptions("voice"),
    );
    expect(opts.fullContextTurns).toBe(6);
    expect(opts.tier1MaxAge).toBe(8);
  });

  it("applies per-agent-type overrides", () => {
    const profiles = JSON.stringify({
      perAgent: { "claude-sdk": { tier2MaxAge: 15, compressMessages: false } },
    });
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_PROFILES: profiles,
      },
      () => resolveContextShreddingOptions(undefined, "claude-sdk"),
    );
    expect(opts.tier2MaxAge).toBe(15);
    expect(opts.compressMessages).toBe(false);
  });

  it("per-agent overrides take priority over per-type overrides", () => {
    const profiles = JSON.stringify({
      perType: { task: { fullContextTurns: 4 } },
      perAgent: { "codex-sdk": { fullContextTurns: 2 } },
    });
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_PROFILES: profiles,
      },
      () => resolveContextShreddingOptions("task", "codex-sdk"),
    );
    // per-agent (2) wins over per-type (4)
    expect(opts.fullContextTurns).toBe(2);
  });

  it("falls back to global config when no matching type profile", () => {
    const profiles = JSON.stringify({
      perType: { voice: { fullContextTurns: 6 } },
    });
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "4",
        CONTEXT_SHREDDING_PROFILES: profiles,
      },
      () => resolveContextShreddingOptions("task"),
    );
    // "task" has no override → uses global env override of 4
    expect(opts.fullContextTurns).toBe(4);
  });

  it("works with no arguments", () => {
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: undefined,
      },
      () => resolveContextShreddingOptions(),
    );
    expect(opts.fullContextTurns).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CONTEXT_SHREDDING_ENV_DEFS
// ---------------------------------------------------------------------------
describe("CONTEXT_SHREDDING_ENV_DEFS", () => {
  it("is an array with the expected entries", () => {
    expect(Array.isArray(CONTEXT_SHREDDING_ENV_DEFS)).toBe(true);
    expect(CONTEXT_SHREDDING_ENV_DEFS.length).toBeGreaterThan(10);
  });

  it("every entry has key, label, type, default, and description", () => {
    for (const d of CONTEXT_SHREDDING_ENV_DEFS) {
      expect(typeof d.key).toBe("string", `${d.key} missing key`);
      expect(typeof d.label).toBe("string", `${d.key} missing label`);
      expect(typeof d.type).toBe("string", `${d.key} missing type`);
      expect(d).toHaveProperty("default");
      expect(typeof d.description).toBe("string", `${d.key} missing description`);
    }
  });

  it("all keys start with CONTEXT_SHREDDING_", () => {
    for (const d of CONTEXT_SHREDDING_ENV_DEFS) {
      expect(d.key.startsWith("CONTEXT_SHREDDING_")).toBe(true);
    }
  });

  it("contains CONTEXT_SHREDDING_ENABLED entry", () => {
    const enabled = CONTEXT_SHREDDING_ENV_DEFS.find(
      (d) => d.key === "CONTEXT_SHREDDING_ENABLED",
    );
    expect(enabled).toBeTruthy();
    expect(enabled.type).toBe("boolean");
    expect(enabled.default).toBe(true);
  });

  it("contains CONTEXT_SHREDDING_PROFILES entry with json type", () => {
    const profiles = CONTEXT_SHREDDING_ENV_DEFS.find(
      (d) => d.key === "CONTEXT_SHREDDING_PROFILES",
    );
    expect(profiles).toBeTruthy();
    expect(profiles.type).toBe("json");
  });

  it("min/max values on numeric entries are reasonable", () => {
    for (const d of CONTEXT_SHREDDING_ENV_DEFS) {
      if (d.type === "number" && d.min != null && d.max != null) {
        expect(d.min).toBeLessThan(d.max);
        if (typeof d.default === "number") {
          expect(d.default).toBeGreaterThanOrEqual(d.min);
          expect(d.default).toBeLessThanOrEqual(d.max);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: loadContextShreddingConfig + resolveContextShreddingOptions
// ---------------------------------------------------------------------------
describe("integration", () => {
  beforeEach(() => _resetConfigCache());
  afterEach(() => _resetConfigCache());
  it("env override flows all the way to resolved options", () => {
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "true",
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "7",
        CONTEXT_SHREDDING_TIER1_HEAD_CHARS: "4000",
        CONTEXT_SHREDDING_COMPRESS_MESSAGES: "false",
      },
      () => resolveContextShreddingOptions("task", "codex-sdk"),
    );
    expect(opts._skip).toBeUndefined();
    expect(opts.fullContextTurns).toBe(7);
    expect(opts.tier1HeadChars).toBe(4000);
    expect(opts.compressMessages).toBe(false);
  });

  it("disabled shredding produces _skip regardless of other settings", () => {
    const opts = withEnv(
      {
        CONTEXT_SHREDDING_ENABLED: "false",
        CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "7",
      },
      () => resolveContextShreddingOptions("voice", "claude-sdk"),
    );
    expect(opts._skip).toBe(true);
    expect(opts.fullContextTurns).toBeUndefined();
  });
});
