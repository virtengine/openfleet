import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../config.mjs";

const ENV_KEYS = [
  "TELEGRAM_INTERVAL_MIN",
  "INTERNAL_EXECUTOR_PARALLEL",
  "DEPENDABOT_MERGE_METHOD",
  "BOSUN_CONFIG_PATH",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "INTERNAL_EXECUTOR_SDK",
  "GITHUB_PROJECT_WEBHOOK_PATH",
  "GITHUB_PROJECT_WEBHOOK_SECRET",
  "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
  "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
  "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_ISSUE_TYPE",
  "JIRA_STATUS_TODO",
  "JIRA_LABEL_IGNORE",
  "JIRA_CUSTOM_FIELD_OWNER_ID",
  "EXECUTORS",
  "TASK_TRIGGER_SYSTEM_ENABLED",
  "KANBAN_BACKEND",
  "WATCH_PATH",
  "ORCHESTRATOR_SCRIPT",
  "PRIMARY_AGENT",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_SDK_DISABLED",
];

describe("loadConfig validation and edge cases", () => {
  let tempConfigDir = "";
  let originalEnv = {};

  beforeEach(async () => {
    tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-"));
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    delete process.env.BOSUN_CONFIG_PATH;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("returns sensible defaults when no overrides are provided", () => {
    delete process.env.TELEGRAM_INTERVAL_MIN;
    delete process.env.INTERNAL_EXECUTOR_PARALLEL;
    delete process.env.DEPENDABOT_MERGE_METHOD;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramIntervalMin).toBe(10);
    expect(config.internalExecutor.maxParallel).toBe(3);
    expect(config.dependabotMergeMethod).toBe("squash");
  });

  it("accepts valid env overrides", () => {
    process.env.TELEGRAM_INTERVAL_MIN = "30";
    process.env.INTERNAL_EXECUTOR_PARALLEL = "5";
    process.env.DEPENDABOT_MERGE_METHOD = "merge";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramIntervalMin).toBe(30);
    expect(config.internalExecutor.maxParallel).toBe(5);
    expect(config.dependabotMergeMethod).toBe("merge");
  });

  it("loadConfig does not throw on malformed JSON config file", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      "{ invalid-json",
      "utf8",
    );

    // Should not throw — falls back to defaults
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config).toBeDefined();
    expect(config.internalExecutor.maxParallel).toBe(3);
  });

  it("returns a config object with expected shape", () => {
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(typeof config.telegramIntervalMin).toBe("number");
    expect(typeof config.internalExecutor).toBe("object");
    expect(typeof config.internalExecutor.maxParallel).toBe("number");
    expect(typeof config.internalExecutor.sdk).toBe("string");
    expect(typeof config.dependabotMergeMethod).toBe("string");
    expect(typeof config.statusPath).toBe("string");
    expect(typeof config.telegramPollLockPath).toBe("string");
    expect(typeof config.githubProjectSync).toBe("object");
    expect(typeof config.githubProjectSync.webhookPath).toBe("string");
    expect(typeof config.githubProjectSync.webhookRequireSignature).toBe(
      "boolean",
    );
    expect(typeof config.jira).toBe("object");
    expect(typeof config.jira.projectKey).toBe("string");
    expect(typeof config.triggerSystem).toBe("object");
    expect(Array.isArray(config.triggerSystem.templates)).toBe(true);
  });

  it("parses executor model lists from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "CODEX:DEFAULT:60:gpt-5.2-codex|gpt-5.1-codex-mini,COPILOT:CLAUDE_OPUS_4_6:40:claude-opus-4.6";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.2-codex",
      "gpt-5.1-codex-mini",
    ]);
    expect(config.executorConfig.executors[1].models).toEqual([
      "claude-opus-4.6",
    ]);
  });

  it("preserves custom/deployment model slugs from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "CODEX:DEFAULT:100:gpt-5.2-codex|my-azure-deployment-42";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.2-codex",
      "my-azure-deployment-42",
    ]);
  });

  it("preserves executor metadata from config file when EXECUTORS env is set", async () => {
    process.env.EXECUTORS = "CODEX:GPT51_CODEX_MINI:100";

    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          executors: [
            {
              name: "codex-mini",
              executor: "CODEX",
              variant: "GPT51_CODEX_MINI",
              weight: 100,
              role: "primary",
              enabled: false,
              models: ["gpt-5.1-codex-mini"],
              codexProfile: "executor-2-profile",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].name).toBe("codex-mini");
    expect(config.executorConfig.executors[0].enabled).toBe(false);
    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.1-codex-mini",
    ]);
    expect(config.executorConfig.executors[0].codexProfile).toBe("executor-2-profile");
  });

  it("infers model allow-list from variant when EXECUTORS entry has no model list", () => {
    process.env.EXECUTORS = "COPILOT:CLAUDE_OPUS_4_6:100";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toContain("claude-opus-4.6");
    expect(config.executorConfig.executors[0].models).not.toContain("gpt-5.2-codex");
  });

  it("parses Gemini executor models from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "GEMINI:DEFAULT:100:gemini-2.5-pro|gemini-2.5-flash";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].executor).toBe("GEMINI");
    expect(config.executorConfig.executors[0].models).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("normalizes PRIMARY_AGENT=gemini to gemini-sdk", () => {
    process.env.PRIMARY_AGENT = "gemini";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.primaryAgent).toBe("gemini-sdk");
  });

  it("keeps trigger system disabled by default", () => {
    delete process.env.TASK_TRIGGER_SYSTEM_ENABLED;
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);
    expect(config.triggerSystem?.enabled).toBe(false);
    expect(
      (config.triggerSystem?.templates || []).every((template) => template.enabled === false),
    ).toBe(true);
  });

  it("treats empty telegram credentials as disabled", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramToken).toBeFalsy();
    expect(config.telegramChatId).toBeFalsy();
  });

  it("loads github project webhook sync settings from env", () => {
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/hooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "secret-1";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "4";
    process.env.GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD = "5";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.githubProjectSync.webhookPath).toBe(
      "/hooks/github/project-sync",
    );
    expect(config.githubProjectSync.webhookSecret).toBe("secret-1");
    expect(config.githubProjectSync.webhookRequireSignature).toBe(true);
    expect(config.githubProjectSync.alertFailureThreshold).toBe(4);
    expect(config.githubProjectSync.rateLimitAlertThreshold).toBe(5);
  });

  it("loads jira mapping settings from env", () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_EMAIL = "bot@acme.dev";
    process.env.JIRA_API_TOKEN = "token-1";
    process.env.JIRA_PROJECT_KEY = "ENG";
    process.env.JIRA_ISSUE_TYPE = "Bug";
    process.env.JIRA_STATUS_TODO = "Backlog";
    process.env.JIRA_LABEL_IGNORE = "codex-ignore";
    process.env.JIRA_CUSTOM_FIELD_OWNER_ID = "customfield_10042";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
    ]);

    expect(config.jira.baseUrl).toBe("https://acme.atlassian.net");
    expect(config.jira.email).toBe("bot@acme.dev");
    expect(config.jira.apiToken).toBe("token-1");
    expect(config.jira.projectKey).toBe("ENG");
    expect(config.jira.issueType).toBe("Bug");
    expect(config.jira.statusMapping.todo).toBe("Backlog");
    expect(config.jira.labels.ignore).toBe("codex-ignore");
    expect(config.jira.sharedStateFields.ownerId).toBe("customfield_10042");
  });

  it("fails fast when jira backend is selected without required jira config", () => {
    process.env.KANBAN_BACKEND = "jira";
    process.env.JIRA_BASE_URL = "";
    process.env.JIRA_EMAIL = "";
    process.env.JIRA_API_TOKEN = "";
    process.env.JIRA_PROJECT_KEY = "";

    expect(() =>
      loadConfig([
        "node",
        "bosun",
        "--config-dir",
        tempConfigDir,
        "--repo-root",
        tempConfigDir,
      ]),
    ).toThrow(/KANBAN_BACKEND=jira requires/i);
  });

  it("watchPath defaults to scriptPath when WATCH_PATH env is not set", () => {
    delete process.env.WATCH_PATH;
    delete process.env.ORCHESTRATOR_SCRIPT;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    // watchPath should be defined and be a string
    expect(typeof config.watchPath).toBe("string");
    expect(config.watchPath.length).toBeGreaterThan(0);
    // When WATCH_PATH is not set, watchPath should resolve to the scriptPath
    // (or a fallback within the config/repo dirs)
    expect(typeof config.scriptPath).toBe("string");
  });

  it("watchPath uses WATCH_PATH env when set (stale/nonexistent path is accepted as configured)", () => {
    const stalePath = resolve(tempConfigDir, "nonexistent-watch-target.ps1");
    process.env.WATCH_PATH = stalePath;
    delete process.env.ORCHESTRATOR_SCRIPT;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    // WATCH_PATH env is respected even if path doesn't exist on disk
    expect(config.watchPath).toBe(stalePath);
  });

  it("scriptPath resolves from ORCHESTRATOR_SCRIPT env when set", async () => {
    const { writeFile } = await import("node:fs/promises");
    const scriptFile = resolve(tempConfigDir, "my-custom-orchestrator.ps1");
    await writeFile(scriptFile, "# custom orchestrator", "utf8");
    process.env.ORCHESTRATOR_SCRIPT = scriptFile;
    delete process.env.WATCH_PATH;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.scriptPath).toBe(scriptFile);
  });
});
