import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../config.mjs";

const ENV_KEYS = [
  "TELEGRAM_INTERVAL_MIN",
  "INTERNAL_EXECUTOR_PARALLEL",
  "DEPENDABOT_MERGE_METHOD",
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
];

describe("loadConfig validation and edge cases", () => {
  let tempConfigDir = "";
  let originalEnv = {};

  beforeEach(async () => {
    tempConfigDir = await mkdtemp(resolve(tmpdir(), "openfleet-config-"));
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
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
      "openfleet",
      "--config-dir",
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
      "openfleet",
      "--config-dir",
      tempConfigDir,
    ]);

    expect(config.telegramIntervalMin).toBe(30);
    expect(config.internalExecutor.maxParallel).toBe(5);
    expect(config.dependabotMergeMethod).toBe("merge");
  });

  it("loadConfig does not throw on malformed JSON config file", async () => {
    await writeFile(
      resolve(tempConfigDir, "openfleet.config.json"),
      "{ invalid-json",
      "utf8",
    );

    // Should not throw — falls back to defaults
    const config = loadConfig([
      "node",
      "openfleet",
      "--config-dir",
      tempConfigDir,
    ]);

    expect(config).toBeDefined();
    expect(config.internalExecutor.maxParallel).toBe(3);
  });

  it("returns a config object with expected shape", () => {
    const config = loadConfig([
      "node",
      "openfleet",
      "--config-dir",
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
  });

  it("treats empty telegram credentials as disabled", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const config = loadConfig([
      "node",
      "openfleet",
      "--config-dir",
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
      "openfleet",
      "--config-dir",
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
      "openfleet",
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
});
