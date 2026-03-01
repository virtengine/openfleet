import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-server mini app", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_MINIAPP_ENABLED",
    "TELEGRAM_UI_PORT",
    "TELEGRAM_UI_TUNNEL",
    "TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK",
    "TELEGRAM_UI_FALLBACK_AUTH_ENABLED",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES",
    "TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS",
    "TELEGRAM_UI_FALLBACK_AUTH_ROTATE_DAYS",
    "TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS",
    "CLOUDFLARE_BASE_DOMAIN",
    "CLOUDFLARE_TUNNEL_HOSTNAME",
    "CLOUDFLARE_USERNAME_HOSTNAME_POLICY",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_DNS_SYNC_ENABLED",
    "CLOUDFLARE_DNS_MAX_RETRIES",
    "CLOUDFLARE_DNS_RETRY_BASE_MS",
    "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
    "BOSUN_UI_AUTO_OPEN_BROWSER",
    "BOSUN_UI_BROWSER_OPEN_MODE",
    "BOSUN_UI_LOG_TOKENIZED_BROWSER_URL",
    "TELEGRAM_INTERVAL_MIN",
    "BOSUN_CONFIG_PATH",
    "BOSUN_HOME",
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
    "TASK_TRIGGER_SYSTEM_ENABLED",
    "EXECUTORS",
    "FLEET_ENABLED",
    "FLEET_SYNC_INTERVAL_MS",
    "OPENAI_API_KEY",
  ];
  let envSnapshot = {};

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/api/webhooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "2";
    process.env.KANBAN_BACKEND = "internal";

    const { setKanbanBackend } = await import("../kanban-adapter.mjs");
    setKanbanBackend("internal");
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
    return 0;
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

  it("preserves launch query params when exchanging session token", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const token = mod.getSessionToken();
    expect(token).toBeTruthy();

    const response = await fetch(
      `http://127.0.0.1:${port}/chat?launch=meeting&call=video&token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/chat?launch=meeting&call=video");
    expect(response.headers.get("set-cookie") || "").toContain("ve_session=");
  });

  it("starts with TELEGRAM_UI_PORT=0 by falling back to non-ephemeral default", async () => {
    process.env.TELEGRAM_UI_PORT = "0";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "0";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    expect(server).toBeTruthy();
    expect(server.address().port).toBeGreaterThan(0);
  });

  it("uses http URL for local publicHost when TLS is disabled", async () => {
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      publicHost: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const url = mod.getTelegramUiUrl();

    expect(url).toBe(`http://127.0.0.1:${port}`);
  });

  it("hides tokenized browser URL in startup logs by default", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "manual";
    delete process.env.BOSUN_UI_LOG_TOKENIZED_BROWSER_URL;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mod = await import("../ui-server.mjs");
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      expect(server).toBeTruthy();
      const browserLog = logSpy.mock.calls
        .map((args) => String(args[0] || ""))
        .find((line) => line.includes("[telegram-ui] Browser access:")) || "";
      expect(browserLog).toContain("token hidden");
      expect(browserLog).not.toContain("/?token=");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("can opt in to tokenized browser URL logs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "manual";
    process.env.BOSUN_UI_LOG_TOKENIZED_BROWSER_URL = "true";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mod = await import("../ui-server.mjs");
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      expect(server).toBeTruthy();
      const browserLog = logSpy.mock.calls
        .map((args) => String(args[0] || ""))
        .find((line) => line.includes("[telegram-ui] Browser access:")) || "";
      expect(browserLog).toContain("/?token=");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns effective settings values and sources for derived/default cases", async () => {
    delete process.env.TELEGRAM_MINIAPP_ENABLED;
    process.env.TELEGRAM_UI_PORT = "4400";
    delete process.env.GITHUB_PROJECT_MODE;

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-settings-view-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "./bosun.schema.json" }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data?.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(json.sources?.TELEGRAM_MINIAPP_ENABLED).toBe("derived");
    expect(json.data?.GITHUB_PROJECT_MODE).toBe("issues");
    expect(json.sources?.GITHUB_PROJECT_MODE).toBe("default");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reflects runtime kanban backend switches via config update", async () => {
    process.env.KANBAN_BACKEND = "github";
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const toInternal = await fetch(`http://127.0.0.1:${port}/api/config/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "kanban", value: "internal" }),
    });
    const toInternalJson = await toInternal.json();
    expect(toInternal.status).toBe(200);
    expect(toInternalJson.ok).toBe(true);

    const internalRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    const internalJson = await internalRes.json();
    expect(internalRes.status).toBe(200);
    expect(internalJson.kanbanBackend).toBe("internal");

    const toGithub = await fetch(`http://127.0.0.1:${port}/api/config/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "kanban", value: "github" }),
    });
    const toGithubJson = await toGithub.json();
    expect(toGithub.status).toBe(200);
    expect(toGithubJson.ok).toBe(true);

    const githubRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    const githubJson = await githubRes.json();
    expect(githubRes.status).toBe(200);
    expect(githubJson.kanbanBackend).toBe("github");
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
          BOSUN_HOOK_TARGETS: "codex,invalid",
        },
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.fieldErrors?.BOSUN_HOOK_TARGETS).toBeTruthy();
  });

  it("writes supported settings into config file", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;

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
          TELEGRAM_UI_PORT: "4400",
          TELEGRAM_INTERVAL_MIN: "15",
          FLEET_ENABLED: "false",
          FLEET_SYNC_INTERVAL_MS: "90000",
          EXECUTORS: "CODEX:DEFAULT:70,COPILOT:DEFAULT:30",
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
        "TELEGRAM_UI_PORT",
        "TELEGRAM_INTERVAL_MIN",
        "FLEET_ENABLED",
        "FLEET_SYNC_INTERVAL_MS",
        "EXECUTORS",
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

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not sync unsupported settings into config file", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;

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

  it("returns trigger template payload with history/stat fields", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-trigger-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          triggerSystem: {
            enabled: false,
            defaults: { executor: "auto", model: "auto" },
            templates: [
              {
                id: "daily-review-digest",
                name: "Daily Review Digest",
                enabled: false,
                action: "create-task",
                trigger: { anyOf: [{ kind: "interval", minutes: 1440 }] },
                config: { executor: "auto", model: "auto" },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toBeTruthy();
    expect(Array.isArray(json.data.templates)).toBe(true);
    expect(json.data.templates.length).toBeGreaterThan(0);
    expect(json.data.templates[0].stats).toBeDefined();
    expect(json.data.templates[0].state).toBeDefined();

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("persists trigger template updates to config", async () => {
    const mod = await import("../ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-trigger-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          triggerSystem: {
            enabled: false,
            defaults: { executor: "auto", model: "auto" },
            templates: [
              {
                id: "daily-review-digest",
                name: "Daily Review Digest",
                enabled: false,
                action: "create-task",
                trigger: { anyOf: [{ kind: "interval", minutes: 1440 }] },
                config: { executor: "auto", model: "auto" },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        template: {
          id: "daily-review-digest",
          enabled: true,
          description: "updated from test",
          minIntervalMinutes: 45,
        },
      }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.enabled).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.triggerSystem.enabled).toBe(true);
    const updatedTemplate = (saved.triggerSystem.templates || []).find(
      (template) => template.id === "daily-review-digest",
    );
    expect(updatedTemplate?.enabled).toBe(true);
    expect(updatedTemplate?.description).toBe("updated from test");
    expect(updatedTemplate?.minIntervalMinutes).toBe(45);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("queues /plan commands in background to avoid request timeouts", async () => {
    const mod = await import("../ui-server.mjs");
    let resolveCommand;
    const pendingCommand = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const handleUiCommand = vi.fn().mockImplementation(() => pendingCommand);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        handleUiCommand,
      },
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/plan 5 fix flaky tests" }),
    });
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.command).toBe("/plan 5 fix flaky tests");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handleUiCommand).toHaveBeenCalledWith("/plan 5 fix flaky tests");

    resolveCommand({ executed: true });
    await pendingCommand;
  });

  it("binds chat session execution cwd to the active workspace repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-chat-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRepo = join(tmpDir, "workspaces", "chatws", "virtengine");
    mkdirSync(workspaceRepo, { recursive: true });
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "chatws",
          workspaces: [
            {
              id: "chatws",
              name: "Chat Workspace",
              activeRepo: "virtengine",
              repos: [{ name: "virtengine", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const execPrimaryPrompt = vi.fn().mockResolvedValue({
      finalResponse: "ok",
      items: [],
    });
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execPrimaryPrompt },
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "hello" }),
    });
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);
    expect(createJson.session.metadata.workspaceId).toBe("chatws");
    expect(createJson.session.metadata.workspaceDir).toBe(workspaceRepo);
    const sessionId = createJson.session.id;

    const messageResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "run task", mode: "agent" }),
      },
    );
    const messageJson = await messageResponse.json();
    expect(messageResponse.status).toBe(200);
    expect(messageJson.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
    const [, opts] = execPrimaryPrompt.mock.calls[0];
    expect(opts.sessionId).toBe(sessionId);
    expect(opts.cwd).toBe(workspaceRepo);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops an in-flight session turn via /api/sessions/:id/stop", async () => {
    let rejectTurn = null;
    const execPrimaryPrompt = vi.fn().mockImplementation((_content, opts = {}) => {
      return new Promise((_, reject) => {
        rejectTurn = reject;
        const signal = opts?.abortController?.signal;
        if (!signal) return;
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    });

    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execPrimaryPrompt },
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "hello" }),
    });
    const createJson = await createResponse.json();
    const sessionId = createJson.session.id;

    const messageResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "run until stopped", mode: "agent" }),
      },
    );
    const messageJson = await messageResponse.json();
    expect(messageResponse.status).toBe(200);
    expect(messageJson.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
    expect(execPrimaryPrompt.mock.calls[0][1]?.abortController).toBeTruthy();

    const stopResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const stopJson = await stopResponse.json();
    expect(stopResponse.status).toBe(200);
    expect(stopJson.ok).toBe(true);
    expect(stopJson.stopped).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopAgainResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const stopAgainJson = await stopAgainResponse.json();
    expect(stopAgainResponse.status).toBe(200);
    expect(stopAgainJson.ok).toBe(true);
    expect(stopAgainJson.stopped).toBe(false);

    // Ensure pending promise cannot leak if abort listener was not reached.
    if (rejectTurn) {
      const err = new Error("forced cleanup");
      err.name = "AbortError";
      rejectTurn(err);
    }
  });

  it("routes sdk commands with the session workspace cwd", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-sdk-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRepo = join(tmpDir, "workspaces", "sdkws", "app");
    mkdirSync(workspaceRepo, { recursive: true });
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "sdkws",
          workspaces: [
            {
              id: "sdkws",
              name: "SDK Workspace",
              activeRepo: "app",
              repos: [{ name: "app", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const execSdkCommand = vi.fn().mockResolvedValue("sdk-ok");
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execSdkCommand },
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "hello" }),
    });
    const createJson = await createResponse.json();
    const sessionId = createJson.session.id;

    const sdkResponse = await fetch(`http://127.0.0.1:${port}/api/agents/sdk-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/status", sessionId }),
    });
    const sdkJson = await sdkResponse.json();
    expect(sdkResponse.status).toBe(200);
    expect(sdkJson.ok).toBe(true);
    expect(sdkJson.result).toBe("sdk-ok");
    expect(execSdkCommand).toHaveBeenCalledWith(
      "/status",
      "",
      undefined,
      expect.objectContaining({
        cwd: workspaceRepo,
        sessionId,
      }),
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes and executes shared bosun tools via /api/agents/tool parity endpoints", async () => {
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "tool parity" }),
    });
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);
    const sessionId = createJson.session.id;

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/agents/tools?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.tools)).toBe(true);
    expect(listJson.tools.some((tool) => tool?.name === "list_sessions")).toBe(true);

    const execResponse = await fetch(`http://127.0.0.1:${port}/api/agents/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "list_sessions",
        sessionId,
        args: { limit: 5 },
      }),
    });
    const execJson = await execResponse.json();
    expect(execResponse.status).toBe(200);
    expect(execJson.ok).toBe(true);
    expect(execJson.toolName).toBe("list_sessions");
    expect(typeof execJson.result).toBe("string");
  });
});
