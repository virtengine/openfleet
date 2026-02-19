import { createHmac } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-server mini app", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_PORT",
    "TELEGRAM_INTERVAL_MIN",
    "OPENFLEET_CONFIG_PATH",
    "KANBAN_BACKEND",
    "GITHUB_PROJECT_MODE",
    "GITHUB_PROJECT_WEBHOOK_SECRET",
    "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
    "GITHUB_PROJECT_WEBHOOK_PATH",
    "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
    "EXECUTOR_MODE",
    "INTERNAL_EXECUTOR_PARALLEL",
    "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
    "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
    "PROJECT_REQUIREMENTS_PROFILE",
    "TASK_PLANNER_DEDUP_HOURS",
    "EXECUTORS",
    "OPENFLEET_PROMPT_PLANNER",
    "FLEET_ENABLED",
    "FLEET_SYNC_INTERVAL_MS",
    "OPENAI_API_KEY",
  ];
  let envSnapshot = {};

  beforeEach(() => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/api/webhooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "2";
  });

  afterEach(async () => {
    const mod = await import("../ui-server.mjs");
    mod.stopTelegramUiServer();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  async function getFreePort() {
    const server = createNetServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  function signBody(secret, body) {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    return `sha256=${digest}`;
  }

  it("exports mini app server helpers", async () => {
    const mod = await import("../ui-server.mjs");
    expect(typeof mod.startTelegramUiServer).toBe("function");
    expect(typeof mod.stopTelegramUiServer).toBe("function");
    expect(typeof mod.getTelegramUiUrl).toBe("function");
    expect(typeof mod.injectUiDependencies).toBe("function");
    expect(typeof mod.getLocalLanIp).toBe("function");
  });

  it("getLocalLanIp returns a string", async () => {
    const mod = await import("../ui-server.mjs");
    const ip = mod.getLocalLanIp();
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
  });

  it("accepts signed project webhook and triggers task sync", async () => {
    const mod = await import("../ui-server.mjs");
    const syncTask = vi.fn().mockResolvedValue(undefined);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: {
        content: {
          number: 42,
          url: "https://github.com/acme/widgets/issues/42",
        },
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/webhooks/github/project-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "projects_v2_item",
          "x-hub-signature-256": signBody("webhook-secret", body),
        },
        body,
      },
    );
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(syncTask).toHaveBeenCalledWith("42");

    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
      { headers: { Authorization: "Bearer unused" } },
    ).then((r) => r.json());
    expect(metrics.data.webhook.syncSuccess).toBe(1);
  });

  it("rejects webhook with invalid signature", async () => {
    const mod = await import("../ui-server.mjs");
    const syncTask = vi.fn().mockResolvedValue(undefined);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: { content: { number: 7 } },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/webhooks/github/project-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "projects_v2_item",
          "x-hub-signature-256": "sha256=bad",
        },
        body,
      },
    );

    expect(response.status).toBe(401);
    expect(syncTask).not.toHaveBeenCalled();

    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
    ).then((r) => r.json());
    expect(metrics.data.webhook.invalidSignature).toBe(1);
  });

  it("triggers alert hook after repeated webhook sync failures", async () => {
    const mod = await import("../ui-server.mjs");
    const onProjectSyncAlert = vi.fn();
    const syncTask = vi.fn().mockRejectedValue(new Error("sync failed"));
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
        onProjectSyncAlert,
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: { content: { number: 9 } },
    });
    const signature = signBody("webhook-secret", body);

    await fetch(`http://127.0.0.1:${port}/api/webhooks/github/project-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "projects_v2_item",
        "x-hub-signature-256": signature,
      },
      body,
    });
    await fetch(`http://127.0.0.1:${port}/api/webhooks/github/project-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "projects_v2_item",
        "x-hub-signature-256": signature,
      },
      body,
    });

    expect(onProjectSyncAlert).toHaveBeenCalledTimes(1);
    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
    ).then((r) => r.json());
    expect(metrics.data.webhook.alertsTriggered).toBe(1);
  });

  it("returns schema field errors for invalid hook targets", async () => {
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          OPENFLEET_HOOK_TARGETS: "codex,invalid",
        },
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.fieldErrors?.OPENFLEET_HOOK_TARGETS).toBeTruthy();
  });

  it("writes supported settings into config file", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "openfleet-config-"));
    const configPath = join(tmpDir, "openfleet.config.json");
    process.env.OPENFLEET_CONFIG_PATH = configPath;

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          KANBAN_BACKEND: "github",
          GITHUB_PROJECT_MODE: "kanban",
          GITHUB_PROJECT_WEBHOOK_PATH: "/api/webhooks/github/project-sync",
          GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD: "5",
          EXECUTOR_MODE: "internal",
          INTERNAL_EXECUTOR_PARALLEL: "5",
          INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED: "false",
          INTERNAL_EXECUTOR_REPLENISH_ENABLED: "true",
          PROJECT_REQUIREMENTS_PROFILE: "system",
          TASK_PLANNER_DEDUP_HOURS: "12",
          TELEGRAM_UI_PORT: "4400",
          TELEGRAM_INTERVAL_MIN: "15",
          FLEET_ENABLED: "false",
          FLEET_SYNC_INTERVAL_MS: "90000",
          EXECUTORS: "CODEX:DEFAULT:70,COPILOT:DEFAULT:30",
          OPENFLEET_PROMPT_PLANNER: ".openfleet/agents/task-planner.md",
        },
      }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.updatedConfig).toEqual(
      expect.arrayContaining([
        "KANBAN_BACKEND",
        "GITHUB_PROJECT_MODE",
        "GITHUB_PROJECT_WEBHOOK_PATH",
        "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
        "EXECUTOR_MODE",
        "INTERNAL_EXECUTOR_PARALLEL",
        "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
        "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
        "PROJECT_REQUIREMENTS_PROFILE",
        "TASK_PLANNER_DEDUP_HOURS",
        "TELEGRAM_UI_PORT",
        "TELEGRAM_INTERVAL_MIN",
        "FLEET_ENABLED",
        "FLEET_SYNC_INTERVAL_MS",
        "EXECUTORS",
        "OPENFLEET_PROMPT_PLANNER",
      ]),
    );
    expect(json.configPath).toBe(configPath);
    expect(json.configDir).toBe(tmpDir);

    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    expect(config.kanban?.backend).toBe("github");
    expect(config.kanban?.github?.project?.mode).toBe("kanban");
    expect(config.kanban?.github?.project?.webhook?.path).toBe("/api/webhooks/github/project-sync");
    expect(config.kanban?.github?.project?.syncMonitoring?.alertFailureThreshold).toBe(5);
    expect(config.internalExecutor?.mode).toBe("internal");
    expect(config.internalExecutor?.maxParallel).toBe(5);
    expect(config.internalExecutor?.reviewAgentEnabled).toBe(false);
    expect(config.internalExecutor?.backlogReplenishment?.enabled).toBe(true);
    expect(config.projectRequirements?.profile).toBe("system");
    expect(config.plannerDedupHours).toBe(12);
    expect(config.telegramUiPort).toBe(4400);
    expect(config.telegramIntervalMin).toBe(15);
    expect(config.fleetEnabled).toBe(false);
    expect(config.fleetSyncIntervalMs).toBe(90000);
    expect(config.executors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executor: "CODEX", variant: "DEFAULT", weight: 70 }),
        expect.objectContaining({ executor: "COPILOT", variant: "DEFAULT", weight: 30 }),
      ]),
    );
    expect(config.agentPrompts?.planner).toBe(".openfleet/agents/task-planner.md");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not sync unsupported settings into config file", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "openfleet-config-"));
    const configPath = join(tmpDir, "openfleet.config.json");
    process.env.OPENFLEET_CONFIG_PATH = configPath;

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          OPENAI_API_KEY: "sk-test-value",
        },
      }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.updatedConfig).toEqual([]);

    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      const config = JSON.parse(raw);
      expect(config.openaiApiKey).toBeUndefined();
    } else {
      expect(existsSync(configPath)).toBe(false);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
