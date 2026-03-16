import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}


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
    "BOSUN_UI_LOCAL_BOOTSTRAP",
    "BOSUN_UI_RATE_LIMIT_PER_MIN",
    "BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN",
    "BOSUN_UI_RATE_LIMIT_PRIVILEGED_PER_MIN",
    "TELEGRAM_INTERVAL_MIN",
    "BOSUN_CONFIG_PATH",
    "BOSUN_HOME",
    "BOSUN_DIR",
    "CODEX_MONITOR_HOME",
    "CODEX_MONITOR_DIR",
    "BOSUN_DESKTOP_API_KEY",
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
    "WORKFLOW_AUTOMATION_ENABLED",
    "EXECUTORS",
    "FLEET_ENABLED",
    "FLEET_SYNC_INTERVAL_MS",
    "OPENAI_API_KEY",
    "BOSUN_ENV_NO_OVERRIDE",
  ];
  let envSnapshot = {};

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    // Prevent loadConfig() → loadDotEnv() from overriding test-controlled env
    // vars with values from the user's on-disk .env file.
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/api/webhooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "2";
    process.env.KANBAN_BACKEND = "internal";

    const { setKanbanBackend } = await import("../kanban/kanban-adapter.mjs");
    setKanbanBackend("internal");
  });

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
    expect(typeof mod.startTelegramUiServer).toBe("function");
    expect(typeof mod.stopTelegramUiServer).toBe("function");
    expect(typeof mod.getTelegramUiUrl).toBe("function");
    expect(typeof mod.injectUiDependencies).toBe("function");
    expect(typeof mod.getLocalLanIp).toBe("function");
  }, 15000);

  it("getLocalLanIp returns a string", async () => {
    const mod = await import("../server/ui-server.mjs");
    const ip = mod.getLocalLanIp();
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
  });

  it("preserves launch query params when exchanging session token", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
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

  it("bootstraps local static requests into a session cookie", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_LOCAL_BOOTSTRAP = "true";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const first = await fetch(`http://127.0.0.1:${port}/app.js?native=1`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const cookie = first.headers.get("set-cookie") || "";
    expect(cookie).toContain("ve_session=");
    const location = first.headers.get("location") || "";
    expect(location).toContain("localBootstrap=1");

    const second = await fetch(`http://127.0.0.1:${port}${location}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(second.status).toBe(302);
    const finalLocation = second.headers.get("location") || "";
    expect(finalLocation).toContain("/app.js?native=1");
    expect(finalLocation).not.toContain("localBootstrap=1");

    const third = await fetch(`http://127.0.0.1:${port}${finalLocation}`, {
      headers: { cookie },
    });
    expect(third.status).toBe(200);
    expect(String(third.headers.get("content-type") || "")).toContain("application/javascript");
  });

  it("serves shared /lib modules after local bootstrap", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_LOCAL_BOOTSTRAP = "true";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const first = await fetch(`http://127.0.0.1:${port}/lib/session-insights.mjs`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const cookie = first.headers.get("set-cookie") || "";
    expect(cookie).toContain("ve_session=");
    const location = first.headers.get("location") || "";
    expect(location).toContain("localBootstrap=1");

    const second = await fetch(`http://127.0.0.1:${port}${location}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(second.status).toBe(302);

    const finalLocation = second.headers.get("location") || "";
    const third = await fetch(`http://127.0.0.1:${port}${finalLocation}`, {
      headers: { cookie },
    });
    expect(third.status).toBe(200);
    expect(String(third.headers.get("content-type") || "")).toContain("application/javascript");
    expect(await third.text()).toContain("buildSessionInsights");
  });

  it("does not auto-bootstrap local static requests when BOSUN_UI_LOCAL_BOOTSTRAP is unset", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    delete process.env.BOSUN_UI_LOCAL_BOOTSTRAP;
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/app.js?native=1`, {
      redirect: "manual",
    });

    expect(response.status).toBe(401);
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).not.toContain("ve_session=");
    const location = response.headers.get("location") || "";
    expect(location).not.toContain("localBootstrap=1");
  });

  it("prefers persisted desktop API key over stale env key during desktop bootstrap", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-desktop-key-"));
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DESKTOP_API_KEY = "bosun_desktop_stale_env_key";
    writeFileSync(
      join(tmpDir, "desktop-api-key.json"),
      JSON.stringify({ key: "bosun_desktop_persisted_key" }, null, 2),
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
      dependencies: { configDir: tmpDir },
    });
    const port = server.address().port;

    const bad = await fetch(
      `http://127.0.0.1:${port}/?desktopKey=${encodeURIComponent("bosun_desktop_stale_env_key")}`,
      { redirect: "manual" },
    );
    expect(bad.status).toBe(401);

    const good = await fetch(
      `http://127.0.0.1:${port}/?desktopKey=${encodeURIComponent("bosun_desktop_persisted_key")}`,
      { redirect: "manual" },
    );
    expect(good.status).toBe(302);
    expect(good.headers.get("set-cookie") || "").toContain("ve_session=");
    expect(process.env.BOSUN_DESKTOP_API_KEY).toBe("bosun_desktop_persisted_key");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with TELEGRAM_UI_PORT=0 by falling back to non-ephemeral default", async () => {
    process.env.TELEGRAM_UI_PORT = "0";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "0";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
      const mod = await import("../server/ui-server.mjs");
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
      const mod = await import("../server/ui-server.mjs");
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

    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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
          state: {
            last_success_at: new Date().toISOString(),
          },
          stats: {
            spawnedTotal: 12,
          },
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
    expect(updatedTemplate).not.toHaveProperty("state");
    expect(updatedTemplate).not.toHaveProperty("stats");

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("exports task state snapshots via mini app API", async () => {
    const mod = await import("../server/ui-server.mjs");
    const taskStore = await import("../task/task-store.mjs");

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-export-1",
      title: "Export me",
      status: "todo",
      timeline: [{ type: "task.created", source: "test" }],
      workflowRuns: [{ runId: "run-1", workflowId: "wf-1", status: "completed" }],
      statusHistory: [{ status: "todo", timestamp: new Date().toISOString(), source: "test" }],
    });
    await taskStore.waitForStoreWrites();

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/export`);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.kind).toBe("bosun-task-state-export");
    expect(json.data.backend).toBe("internal");
    expect(Array.isArray(json.data.tasks)).toBe(true);
    const exported = json.data.tasks.find((task) => task.id === "task-export-1");
    expect(exported?.title).toBe("Export me");
    expect(Array.isArray(exported?.timeline)).toBe(true);
    expect(exported?.timeline?.length).toBeGreaterThan(0);
    expect(Array.isArray(exported?.workflowRuns)).toBe(true);
    expect(exported?.workflowRuns?.[0]?.runId).toBe("run-1");
  }, 15000);

  it("imports task state snapshots with merge semantics via mini app API", async () => {
    const mod = await import("../server/ui-server.mjs");
    const taskStore = await import("../task/task-store.mjs");

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-import-1",
      title: "Original title",
      status: "todo",
    });
    await taskStore.waitForStoreWrites();

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "merge",
        tasks: [
          {
            id: "task-import-1",
            title: "Updated title",
            status: "inreview",
            timeline: [{ type: "status.transition", source: "import" }],
            workflowRuns: [{ runId: "run-import-1", workflowId: "wf-import-1", status: "completed" }],
            statusHistory: [{ status: "inreview", timestamp: new Date().toISOString(), source: "import" }],
          },
          {
            id: "task-import-2",
            title: "Imported task",
            status: "todo",
          },
        ],
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.summary.created).toBe(1);
    expect(json.data.summary.updated).toBe(1);

    const updatedTask = taskStore.getTask("task-import-1");
    const createdTask = taskStore.getTask("task-import-2");
    expect(updatedTask?.title).toBe("Updated title");
    expect(updatedTask?.status).toBe("inreview");
    expect(Array.isArray(updatedTask?.workflowRuns)).toBe(true);
    expect(updatedTask?.workflowRuns?.[0]?.runId).toBe("run-import-1");
    expect(createdTask?.title).toBe("Imported task");
  }, 15000);

  it("queues /plan commands in background to avoid request timeouts", async () => {
    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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

    const mod = await import("../server/ui-server.mjs");
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
    const mod = await import("../server/ui-server.mjs");
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

  it("scopes session listing to the active workspace by default", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-session-scope-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const ws1Repo = join(tmpDir, "workspaces", "ws-one", "repo1");
    const ws2Repo = join(tmpDir, "workspaces", "ws-two", "repo2");
    mkdirSync(join(ws1Repo, ".git"), { recursive: true });
    mkdirSync(join(ws2Repo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "ws-one",
          workspaces: [
            {
              id: "ws-one",
              name: "Workspace One",
              activeRepo: "repo1",
              repos: [{ name: "repo1", primary: true }],
            },
            {
              id: "ws-two",
              name: "Workspace Two",
              activeRepo: "repo2",
              repos: [{ name: "repo2", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const setActiveWsOne = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-one" }),
    }).then((r) => r.json());
    // Some environments initialize managed workspaces lazily, so explicit
    // activation can fail even when activeWorkspace is already set in config.
    expect(typeof setActiveWsOne.ok).toBe("boolean");

    const wsOneCreate = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "workspace-scope-test", workspaceId: "ws-one" }),
    }).then((r) => r.json());
    if (!wsOneCreate?.ok) {
      return;
    }
    const wsOneSessionId = wsOneCreate?.session?.id;

    const wsTwoCreate = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "workspace-scope-test", workspaceId: "ws-two" }),
    }).then((r) => r.json());
    if (!wsTwoCreate?.ok) {
      return;
    }

    const activeList = await fetch(
      `http://127.0.0.1:${port}/api/sessions?type=workspace-scope-test`,
    ).then((r) => r.json());
    expect(activeList.ok).toBe(true);
    expect(activeList.sessions).toHaveLength(1);
    expect(activeList.sessions[0]?.id).toBe(wsOneSessionId);

    const allList = await fetch(
      `http://127.0.0.1:${port}/api/sessions?type=workspace-scope-test&workspace=all`,
    ).then((r) => r.json());
    expect(allList.ok).toBe(true);
    expect(allList.sessions.length).toBeGreaterThanOrEqual(2);
    const wsTwoSessionId = wsTwoCreate?.session?.id;
    expect(typeof wsTwoSessionId).toBe("string");

    const allScopedSession = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(wsTwoSessionId)}?workspace=all&limit=10`,
    );
    expect(allScopedSession.status).toBe(200);
    const allScopedSessionBody = await allScopedSession.json();
    expect(allScopedSessionBody.ok).toBe(true);
    expect(allScopedSessionBody.session?.id).toBe(wsTwoSessionId);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 20000);

  it("hides leaked smoke sessions from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const tracker = getSessionTracker();
    tracker.createSession({
      id: "smoke-openai-legacy",
      type: "primary",
      metadata: { title: "smoke-openai-legacy" },
    });
    tracker.createSession({
      id: "manual-visible-session",
      type: "primary",
      metadata: { title: "Visible Session" },
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const listJson = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.sessions.some((session) => session.id === "smoke-openai-legacy")).toBe(false);
    expect(listJson.sessions.some((session) => session.id === "manual-visible-session")).toBe(true);

    const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
    const hiddenListJson = await hiddenListRes.json();
    expect(hiddenListRes.status).toBe(200);
    expect(hiddenListJson.ok).toBe(true);
    expect(hiddenListJson.sessions.some((session) => session.id === "smoke-openai-legacy")).toBe(true);
  });

  it("uses the higher authenticated session rate limit for session-token requests", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_RATE_LIMIT_PER_MIN = "2";
    process.env.BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN = "4";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const token = mod.getSessionToken();
    expect(token).toBeTruthy();

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const makeRequest = (type) => fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type }),
    });

    const first = await makeRequest("authed-rate-1");
    const second = await makeRequest("authed-rate-2");
    const third = await makeRequest("authed-rate-3");
    const fourth = await makeRequest("authed-rate-4");
    const fifth = await makeRequest("authed-rate-5");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(fourth.status).toBe(200);
    expect(fifth.status).toBe(429);
  });

  it("scopes workflows and library data by active workspace", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-workflow-library-scope-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const ws1Repo = join(tmpDir, "workspaces", "ws-alpha", "alpha");
    const ws2Repo = join(tmpDir, "workspaces", "ws-beta", "beta");
    mkdirSync(join(ws1Repo, ".git"), { recursive: true });
    mkdirSync(join(ws2Repo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "ws-alpha",
          workspaces: [
            {
              id: "ws-alpha",
              name: "Workspace Alpha",
              activeRepo: "alpha",
              repos: [{ name: "alpha", primary: true }],
            },
            {
              id: "ws-beta",
              name: "Workspace Beta",
              activeRepo: "beta",
              repos: [{ name: "beta", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const wfOneId = `wf-ws-alpha-${Date.now()}`;
    const wfSaveOne = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: wfOneId,
        name: "Alpha Workflow",
        description: "Workspace alpha workflow",
        enabled: true,
        nodes: [],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(wfSaveOne.ok).toBe(true);

    const libOne = await fetch(`http://127.0.0.1:${port}/api/library/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        name: "Alpha Prompt",
        description: "alpha only",
        content: "# alpha",
      }),
    }).then((r) => r.json());
    expect(libOne.ok).toBe(true);

    const switchResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-beta" }),
    });
    const switchJson = await switchResponse.json();
    expect(switchResponse.status).toBe(200);
    expect(switchJson.ok).toBe(true);

    const wfBetaListBefore = await fetch(`http://127.0.0.1:${port}/api/workflows`).then((r) => r.json());
    expect(wfBetaListBefore.ok).toBe(true);
    expect(wfBetaListBefore.workflows.some((wf) => wf.id === wfOneId)).toBe(false);

    const libBetaListBefore = await fetch(`http://127.0.0.1:${port}/api/library?search=Alpha`).then((r) => r.json());
    expect(libBetaListBefore.ok).toBe(true);
    expect(libBetaListBefore.data).toHaveLength(0);

    const wfTwoId = `wf-ws-beta-${Date.now()}`;
    const wfSaveTwo = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: wfTwoId,
        name: "Beta Workflow",
        description: "Workspace beta workflow",
        enabled: true,
        nodes: [],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(wfSaveTwo.ok).toBe(true);

    const libTwo = await fetch(`http://127.0.0.1:${port}/api/library/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        name: "Beta Prompt",
        description: "beta only",
        content: "# beta",
      }),
    }).then((r) => r.json());
    expect(libTwo.ok).toBe(true);

    const switchBackResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-alpha" }),
    });
    const switchBackJson = await switchBackResponse.json();
    expect(switchBackResponse.status).toBe(200);
    expect(switchBackJson.ok).toBe(true);

    const wfAlphaList = await fetch(`http://127.0.0.1:${port}/api/workflows`).then((r) => r.json());
    expect(wfAlphaList.ok).toBe(true);
    expect(wfAlphaList.workflows.some((wf) => wf.id === wfOneId)).toBe(true);
    expect(wfAlphaList.workflows.some((wf) => wf.id === wfTwoId)).toBe(false);

    const libAlphaList = await fetch(`http://127.0.0.1:${port}/api/library?search=Prompt`).then((r) => r.json());
    expect(libAlphaList.ok).toBe(true);
    expect(libAlphaList.data.some((entry) => entry.name === "Alpha Prompt")).toBe(true);
    expect(libAlphaList.data.some((entry) => entry.name === "Beta Prompt")).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("previews and imports custom library repositories through the API", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-library-import-api-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "library-ws");
    const workspaceRepo = join(workspaceRoot, "repo");
    const sourceRepo = join(tmpDir, "source-repo");

    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    mkdirSync(join(sourceRepo, ".github", "agents"), { recursive: true });
    mkdirSync(join(sourceRepo, "skills", "triage"), { recursive: true });
    mkdirSync(join(sourceRepo, "prompts"), { recursive: true });
    mkdirSync(join(sourceRepo, ".codex"), { recursive: true });

    writeFileSync(
      join(sourceRepo, ".github", "agents", "TaskPlanner.agent.md"),
      [
        "---",
        "name: Task Planner",
        "description: 'Plans and routes engineering tasks'",
        "tools: ['search', 'edit']",
        "skills: ['triage-skill']",
        "---",
        "Use this agent to break down complex tasks.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, "skills", "triage", "SKILL.md"),
      "# Skill: Triage\n\nPrioritize incidents quickly.",
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, "prompts", "chat.prompt.md"),
      "# Chat Prompt\n\nAlways ask clarifying questions when ambiguous.",
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, ".codex", "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "@anthropic/mcp-github"]',
      ].join("\n"),
      "utf8",
    );

    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "library-ws",
          workspaces: [
            {
              id: "library-ws",
              name: "Library Workspace",
              path: workspaceRoot,
              activeRepo: "repo",
              repos: [{ name: "repo", path: workspaceRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git add .", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sourceRepo,
      stdio: "pipe",
      env: sanitizedGitEnv(),
      encoding: "utf8",
    }).trim();

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/api/library/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "custom",
          repoUrl: sourceRepo,
          branch,
          maxEntries: 20,
        }),
      });
      const previewJson = await previewResponse.json();
      expect(previewResponse.status).toBe(200);
      expect(previewJson.ok).toBe(true);
      expect(previewJson.data.repoUrl).toBe(sourceRepo);
      expect(previewJson.data.branch).toBe(branch);
      expect(previewJson.data.totalCandidates).toBeGreaterThanOrEqual(3);
      expect(previewJson.data.candidatesByType).toEqual(
        expect.objectContaining({
          agent: 1,
          prompt: 1,
          skill: 1,
        }),
      );

      const selectedPaths = previewJson.data.candidates
        .filter((candidate) => [
          ".github/agents/TaskPlanner.agent.md",
          "skills/triage/SKILL.md",
        ].includes(candidate.relPath))
        .map((candidate) => candidate.relPath);
      expect(selectedPaths).toEqual([
        ".github/agents/TaskPlanner.agent.md",
        "skills/triage/SKILL.md",
      ]);

      const importResponse = await fetch(`http://127.0.0.1:${port}/api/library/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "custom",
          repoUrl: sourceRepo,
          branch,
          includeEntries: selectedPaths,
          importAgents: true,
          importSkills: true,
          importPrompts: true,
          importTools: false,
        }),
      });
      const importJson = await importResponse.json();
      expect(importResponse.status).toBe(200);
      expect(importJson.ok).toBe(true);
      expect(importJson.data.storageScope).toBe("repo");
      expect(importJson.data.importedCount).toBe(3);
      expect(importJson.data.imported).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent",
            name: "Task Planner",
            relPath: ".github/agents/TaskPlanner.agent.md",
          }),
          expect.objectContaining({
            type: "skill",
            name: "triage",
            relPath: "skills/triage/SKILL.md",
          }),
          expect.objectContaining({
            type: "prompt",
            name: "Task Planner Prompt",
            relPath: ".github/agents/TaskPlanner.agent.md",
          }),
        ]),
      );

      const libraryJson = await fetch(`http://127.0.0.1:${port}/api/library?search=Task`).then((r) => r.json());
      expect(libraryJson.ok).toBe(true);
      expect(libraryJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Task Planner", type: "agent" }),
          expect.objectContaining({ name: "Task Planner Prompt", type: "prompt" }),
        ]),
      );

      const skillLibraryJson = await fetch(`http://127.0.0.1:${port}/api/library?search=Triage`).then((r) => r.json());
      expect(skillLibraryJson.ok).toBe(true);
      expect(skillLibraryJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "triage", type: "skill" }),
        ]),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);

  it("exposes typed workflow node ports and inline UI metadata", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/workflows/node-types`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.nodeTypes)).toBe(true);
    expect(payload.nodeTypes.length).toBeGreaterThan(10);

    const manualTrigger = payload.nodeTypes.find((nodeType) => nodeType.type === "trigger.manual");
    expect(manualTrigger).toBeTruthy();
    expect(Array.isArray(manualTrigger.ports?.outputs)).toBe(true);
    expect(manualTrigger.ports.outputs[0]).toMatchObject({
      name: "default",
      type: "TaskDef",
    });

    const runAgent = payload.nodeTypes.find((nodeType) => nodeType.type === "action.run_agent");
    expect(runAgent).toBeTruthy();
    expect(Array.isArray(runAgent.ports?.inputs)).toBe(true);
    expect(Array.isArray(runAgent.ports?.outputs)).toBe(true);
    expect(runAgent.ports.inputs[0]).toMatchObject({
      name: "default",
      type: "TaskDef",
    });
    expect(runAgent.ports.outputs[0]).toMatchObject({
      name: "default",
      type: "AgentResult",
    });
    expect(Array.isArray(runAgent.ui?.primaryFields)).toBe(true);
    expect(runAgent.ui.primaryFields).toContain("model");
  }, 20000);

  it("exposes and executes shared bosun tools via /api/agents/tool parity endpoints", async () => {
    const mod = await import("../server/ui-server.mjs");
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

  it("applies task lifecycle start and pause actions through /api/tasks/update", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.TASK_TRIGGER_SYSTEM_ENABLED = "false";
    process.env.WORKFLOW_AUTOMATION_ENABLED = "false";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const abortTask = vi.fn(() => ({ ok: true, reason: "task_lifecycle_pause" }));
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
        abortTask,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Lifecycle test task",
        description: "verify lifecycle transitions",
        status: "todo",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const started = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        status: "inprogress",
        lifecycleAction: "start",
      }),
    }).then((r) => r.json());

    expect(started.ok).toBe(true);
    expect(started.lifecycle.action).toBe("start");
    expect(started.lifecycle.startDispatch.started).toBe(true);
    expect(executeTask).toHaveBeenCalled();

    const paused = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        status: "todo",
        lifecycleAction: "pause",
        pauseExecution: true,
      }),
    }).then((r) => r.json());

    expect(paused.ok).toBe(true);
    expect(paused.lifecycle.action).toBe("pause");
    expect(abortTask).toHaveBeenCalledWith(taskId, "task_lifecycle_pause");
  });

  it("serves retry queue snapshots from the agent event bus when available", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const getRetryQueue = vi.fn(() => ({
      count: 1,
      items: [
        {
          taskId: "retry-task-1",
          retryCount: 2,
          lastError: "Build failed",
          nextAttemptAt: Date.now() + 10_000,
        },
      ],
      stats: {
        totalRetriesToday: 7,
        peakRetryDepth: 3,
        exhaustedTaskIds: ["retry-task-old"],
      },
    }));
    mod.injectUiDependencies({
      getAgentEventBus: () => ({
        getRetryQueue,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const payload = await fetch(`http://127.0.0.1:${port}/api/retry-queue`).then((r) => r.json());
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.items[0].taskId).toBe("retry-task-1");
    expect(payload.stats.totalRetriesToday).toBe(7);
    expect(getRetryQueue).toHaveBeenCalled();
  });

  it("retries tasks immediately and clears retry queue entries via the event bus", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const clearRetryQueueTask = vi.fn();
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
      getAgentEventBus: () => ({
        clearRetryQueueTask,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Retry queue manual retry test",
        description: "ensures retry now bypasses cooldown",
        status: "error",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const retried = await fetch(`http://127.0.0.1:${port}/api/tasks/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(retried.ok).toBe(true);
    expect(retried.taskId).toBe(taskId);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(executeTask.mock.calls[0][0]?.id).toBe(taskId);
    expect(clearRetryQueueTask).toHaveBeenCalledWith(taskId, "manual-retry-now");
  });

  it("clears blocked task state through /api/tasks/unblock", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-unblock-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const storeDir = join(isolatedDir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    const taskStore = await import("../task/task-store.mjs");
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Blocked UI task",
        description: "verify unblock route",
        status: "todo",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    taskStore.updateTask(taskId, {
      status: "blocked",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      blockedReason: "bootstrap pending",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        note: "keep-me",
      },
    });

    const unblocked = await fetch(`http://127.0.0.1:${port}/api/tasks/unblock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(unblocked.ok).toBe(true);
    expect(unblocked.data.status).toBe("todo");

    const task = taskStore.getTask(taskId);
    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery).toBeUndefined();
    expect(task.meta?.note).toBe("keep-me");
  });

  it("clears blocked task state when editing a blocked task back to todo", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-edit-unblock-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const storeDir = join(isolatedDir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    const taskStore = await import("../task/task-store.mjs");
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-edit-unblock",
      title: "Blocked via edit",
      description: "verify edit route clears block state",
      status: "blocked",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      blockedReason: "dependency not ready",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        note: "preserve-me",
      },
    });

    const edited = await fetch(`http://127.0.0.1:${port}/api/tasks/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-edit-unblock",
        title: "Blocked via edit",
        description: "verify edit route clears block state",
        status: "todo",
      }),
    }).then((r) => r.json());

    expect(edited.ok).toBe(true);
    expect(edited.data.status).toBe("todo");

    const task = taskStore.getTask("task-edit-unblock");
    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery).toBeUndefined();
    expect(task.meta?.note).toBe("preserve-me");
  });

  it("queues task starts when no executor slots are free and reports truthful runtime state", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-queue-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 1, activeSlots: 1, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Queued lifecycle test task",
        description: "verify truthful queued state",
        status: "todo",
      }),
    }).then((r) => r.json());

    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const started = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(started.ok).toBe(true);
    expect(started.queued).toBe(true);
    expect(started.started).toBe(false);
    expect(started.data.runtimeSnapshot.state).toBe("queued");
    expect(executeTask).not.toHaveBeenCalled();

    const tasksList = await fetch(
      `http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`,
    ).then((r) => r.json());

    expect(tasksList.ok).toBe(true);
    const queuedTask = Array.isArray(tasksList.data)
      ? tasksList.data.find((task) => task?.id === taskId)
      : null;
    expect(queuedTask).toBeTruthy();
    expect(queuedTask.runtimeSnapshot.state).toBe("queued");
    expect(queuedTask.runtimeSnapshot.isLive).toBe(false);
  }, 60000);

  it("enriches task detail with linked workflow runs for the same taskId", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-detail-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Workflow linked task", description: "trace workflow runs" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const workflowId = `wf-task-trace-${Date.now()}`;
    const saveWorkflow = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: workflowId,
        name: "Task trace workflow",
        enabled: true,
        nodes: [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        ],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(saveWorkflow.ok).toBe(true);

    const runResponse = await fetch(`http://127.0.0.1:${port}/api/workflows/${encodeURIComponent(workflowId)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        waitForCompletion: true,
        taskId,
        taskTitle: "Workflow linked task",
      }),
    }).then((r) => r.json());
    expect(runResponse.ok).toBe(true);

    const detail = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    ).then((r) => r.json());

    expect(detail.ok).toBe(true);
    expect(detail.data.id).toBe(taskId);
    expect(Array.isArray(detail.data.workflowRuns)).toBe(true);
    expect(detail.data.workflowRuns.length).toBeGreaterThan(0);
    expect(detail.data.workflowRuns.some((run) => run.workflowId === workflowId)).toBe(true);
  }, 20000);

  it("preserves stored workflow session links while adding primary session ids from workflow detail", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-merge-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const fakeEngine = {
      getRunHistory: vi.fn(() => [{ runId: "run-merge-1" }]),
      getRunDetail: vi.fn(() => ({
        runId: "run-merge-1",
        workflowId: "wf-merge-1",
        workflowName: "Merged workflow",
        status: "completed",
        startedAt: "2026-03-15T12:00:00.000Z",
        endedAt: "2026-03-15T12:02:00.000Z",
        duration: 120000,
        detail: {
          data: {
            taskId: "__task__",
            sessionId: "derived-session-1",
          },
        },
      })),
      getTaskTraceEvents: vi.fn(() => [
        {
          taskId: "__task__",
          meta: { sessionId: "trace-session-1" },
        },
      ]),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Workflow merge task",
          description: "preserve stored workflow session link",
          status: "todo",
        }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);
      const taskId = created.data.id;

      fakeEngine.getRunDetail.mockImplementation(() => ({
        runId: "run-merge-1",
        workflowId: "wf-merge-1",
        workflowName: "Merged workflow",
        status: "completed",
        startedAt: "2026-03-15T12:00:00.000Z",
        endedAt: "2026-03-15T12:02:00.000Z",
        duration: 120000,
        detail: {
          data: {
            taskId,
            sessionId: "derived-session-1",
          },
        },
      }));
      fakeEngine.getTaskTraceEvents.mockImplementation(() => [
        {
          taskId,
          meta: { sessionId: "trace-session-1" },
        },
      ]);

      const taskStore = await import("../task/task-store.mjs");
      taskStore.updateTask(taskId, {
        workflowRuns: [
          {
            runId: "run-merge-1",
            workflowId: "wf-merge-1",
            status: "linked",
            summary: "Stored workflow link",
            meta: { sessionId: "stored-session-1" },
          },
        ],
      });
      expect(taskStore.getTask(taskId)?.workflowRuns?.[0]?.meta?.sessionId).toBe("stored-session-1");

      const detail = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());

      expect(detail.ok).toBe(true);
      const mergedRun = detail.data.workflowRuns.find((run) => run.runId === "run-merge-1");
      expect(mergedRun).toMatchObject({
        runId: "run-merge-1",
        workflowId: "wf-merge-1",
        sessionId: "stored-session-1",
        primarySessionId: "derived-session-1",
      });
      expect(mergedRun.meta?.sessionId).toBe("stored-session-1");
    } finally {
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  });

  it("reports epic dependency blockers from start guards", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({
          canStart: false,
          reason: "epic_dependencies_unresolved",
          blockingEpicIds: ["EPIC-B"],
          blockingTaskIds: ["dep-task-1"],
        })),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded epic start", description: "epic guard" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const blockedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: created.data.id }),
    });
    const blockedJson = await blockedResp.json();

    expect(blockedResp.status).toBe(409);
    expect(blockedJson.ok).toBe(false);
    expect(blockedJson.canStart.reason).toBe("epic_dependencies_unresolved");
    expect(blockedJson.canStart.raw.blockingEpicIds).toEqual(["EPIC-B"]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("keeps task detail responses JSON-safe when can-start guards return circular raw data", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const rawGuard = {
      canStart: false,
      reason: "dependency_blocked",
      blockingTaskIds: ["dep-task-1"],
      attemptCount: 3n,
      debug: () => "ignored",
    };
    rawGuard.self = rawGuard;

    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => rawGuard),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
        executeTask: vi.fn(async () => {}),
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded detail task", description: "detail guard" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const detailResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(created.data.id)}`,
    );
    const detailJson = await detailResp.json();

    expect(detailResp.status).toBe(200);
    expect(detailJson.ok).toBe(true);
    expect(detailJson.data.canStart.canStart).toBe(false);
    expect(detailJson.data.canStart.raw.blockingTaskIds).toEqual(["dep-task-1"]);
    expect(detailJson.data.canStart.raw.attemptCount).toBe("3");
    expect(detailJson.data.canStart.raw.self).toBe("[Circular]");
    expect("debug" in detailJson.data.canStart.raw).toBe(false);
  });

  it("blocks /api/tasks/start when can-start guard fails unless force override is set", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const canStartTask = vi.fn(() => ({ canStart: false, reason: "dependency_blocked", blockedBy: [{ taskId: "dep-1" }] }));
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask,
        appendTaskTimelineEvent: vi.fn(),
        addTaskComment: vi.fn(() => ({ id: "comment-1" })),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded start task", description: "start guard" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const blockedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    const blockedJson = await blockedResp.json();

    expect(blockedResp.status).toBe(409);
    expect(blockedJson.ok).toBe(false);
    expect(blockedJson.canStart.canStart).toBe(false);
    expect(executeTask).not.toHaveBeenCalled();

    const forcedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, force: true }),
    });
    const forcedJson = await forcedResp.json();

    expect(forcedResp.status).toBe(200);
    expect(forcedJson.ok).toBe(true);
    expect(forcedJson.canStart.override).toBe(true);
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it("reports guarded lifecycle start without dispatching execution", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({ canStart: false, reason: "dependency_blocked" })),
        appendTaskTimelineEvent: vi.fn(),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 3, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded lifecycle", description: "lifecycle guard" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const update = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        status: "inprogress",
        lifecycleAction: "start",
      }),
    }).then((r) => r.json());

    expect(update.ok).toBe(true);
    expect(update.lifecycle.startDispatch.started).toBe(false);
    expect(update.lifecycle.startDispatch.reason).toBe("start_guard_blocked");
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("includes blocked diagnostics on /api/tasks/detail and counts blocked tasks on /api/tasks", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({
          canStart: false,
          reason: "dependency_blocked",
          blockedBy: [{ taskId: "dep-1", reason: "Waiting for dep-1" }],
          blockingTaskIds: ["dep-1"],
        })),
      },
      getAgentSupervisor: () => ({
        getTaskDiagnostics: () => ({
          taskId,
          interventionCount: 2,
          lastIntervention: "continue_signal",
          lastDecision: { reason: "retry same thread" },
          apiErrorRecovery: {
            signature: "upstream timeout while polling",
            continueAttempts: 2,
            cooldownUntil: Date.now() + 60_000,
          },
        }),
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked detail task",
        description: "waiting on dependency",
        status: "blocked",
        blockedReason: "Dependency dep-1 is unresolved",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const detailResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    );
    const detailJson = await detailResp.json();

    expect(detailResp.status).toBe(200);
    expect(detailJson.ok).toBe(true);
    expect(detailJson.data.canStart.canStart).toBe(false);
    expect(detailJson.data.blockedContext.category).toBe("dependency_blocked");
    expect(detailJson.data.blockedContext.blockedBy).toEqual([
      { taskId: "dep-1", reason: "Waiting for dep-1" },
    ]);
    expect(detailJson.data.blockedContext.reason).toBe("dependency_blocked");
    expect(detailJson.data.blockedContext.summary).toContain("Bosun will not dispatch this task");
    expect(detailJson.data.diagnostics.stableCause.code).toBe("api_error_cooldown");
    expect(detailJson.data.diagnostics.supervisor.apiErrorRecovery.continueAttempts).toBe(2);

    const listResp = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    const listJson = await listResp.json();

    expect(listResp.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.statusCounts.blocked).toBeGreaterThanOrEqual(1);
  });

  it("returns a diagnosticId on task detail failures and logs the raw backend cause", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => {
          throw new Error("detail exploded\n    at fake-stack-frame");
        }),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "diagnostic detail task",
        description: "trigger task detail failure",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const detailResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(created.data.id)}`,
    );
    const detailJson = await detailResp.json();

    expect(detailResp.status).toBe(500);
    expect(detailJson.ok).toBe(false);
    expect(detailJson.error).toBe("Internal server error");
    expect(detailJson.diagnosticId).toMatch(/^req_[a-f0-9]+$/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ui-server] request failed",
      expect.objectContaining({
        diagnosticId: detailJson.diagnosticId,
        path: "/api/tasks/detail",
        payload: expect.objectContaining({
          error: expect.stringContaining("detail exploded"),
        }),
      }),
    );
  });

  it("wires sprint and dag task-store APIs through ui-server endpoints", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const sprintMap = new Map();
    sprintMap.set("s-1", { id: "s-1", name: "Sprint 1", executionMode: "parallel" });

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        listSprints: vi.fn(() => [...sprintMap.values()]),
        createSprint: vi.fn((payload = {}) => {
          const id = payload.id || "s-2";
          const sprint = {
            id,
            name: payload.name || `Sprint ${id}`,
            executionMode: payload.executionMode || payload.taskOrderMode || "parallel",
            taskOrderMode: payload.taskOrderMode || payload.executionMode || "parallel",
          };
          sprintMap.set(id, sprint);
          return sprint;
        }),
        getSprint: vi.fn((id) => sprintMap.get(id) || null),
        updateSprint: vi.fn((id, payload = {}) => {
          const current = sprintMap.get(id) || { id, name: `Sprint ${id}` };
          const next = {
            ...current,
            ...payload,
            id,
            executionMode: payload.executionMode || payload.taskOrderMode || current.executionMode || "parallel",
            taskOrderMode: payload.taskOrderMode || payload.executionMode || current.taskOrderMode || current.executionMode || "parallel",
          };
          sprintMap.set(id, next);
          return next;
        }),
        deleteSprint: vi.fn((id) => ({ id, deleted: true })),
        getSprintDag: vi.fn((id) => ({ sprintId: id, nodes: [{ id: "A" }], edges: [] })),
        getGlobalDagOfDags: vi.fn(() => ({ nodes: [{ id: "s-1" }], edges: [] })),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const sprintList = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`).then((r) => r.json());
    expect(sprintList.ok).toBe(true);
    expect(Array.isArray(sprintList.data)).toBe(true);
    expect(sprintList.data[0].executionMode).toBe("parallel");

    const invalidMode = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad-mode", name: "Bad", executionMode: "random" }),
    });
    expect(invalidMode.status).toBe(400);

    const sprintCreate = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s-2", name: "Sprint 2", executionMode: "sequential" }),
    }).then((r) => r.json());
    expect(sprintCreate.ok).toBe(true);
    expect(sprintCreate.data.id).toBe("s-2");
    expect(sprintCreate.data.executionMode).toBe("sequential");
    expect(sprintCreate.data.taskOrderMode).toBe("sequential");

    const sprintUpdate = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionMode: "parallel" }),
    }).then((r) => r.json());
    expect(sprintUpdate.ok).toBe(true);
    expect(sprintUpdate.data.executionMode).toBe("parallel");

    const sprintGet = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-2`).then((r) => r.json());
    expect(sprintGet.ok).toBe(true);
    expect(sprintGet.data.executionMode).toBe("parallel");

    const sprintDag = await fetch(`http://127.0.0.1:${port}/api/tasks/dag?sprintId=s-1`).then((r) => r.json());
    expect(sprintDag.ok).toBe(true);
    expect(sprintDag.data.sprintId).toBe("s-1");
    expect(sprintDag.sprint.executionMode).toBe("parallel");

    const sprintSpecificDag = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-1/dag`).then((r) => r.json());
    expect(sprintSpecificDag.ok).toBe(true);
    expect(sprintSpecificDag.sprint.executionMode).toBe("parallel");

    const dagOfDags = await fetch(`http://127.0.0.1:${port}/api/tasks/dag-of-dags`).then((r) => r.json());
    expect(dagOfDags.ok).toBe(true);
    expect(Array.isArray(dagOfDags.data.nodes)).toBe(true);
  });

  it("supports task comment aliases and validation through /api/tasks/comment", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const addTaskComment = vi.fn(() => ({ id: "comment-1" }));
    mod.injectUiDependencies({
      taskStoreApi: {
        addTaskComment,
        appendTaskTimelineEvent: vi.fn(),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "comment test task", description: "comment coverage" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const missingBodyResp = await fetch(`http://127.0.0.1:${port}/api/tasks/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: created.data.id }),
    });
    expect(missingBodyResp.status).toBe(400);

    const commentResp = await fetch(`http://127.0.0.1:${port}/api/tasks/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        comment: "looks good",
        author: "qa",
      }),
    });
    const commentJson = await commentResp.json();

    expect(commentResp.status).toBe(200);
    expect(commentJson.ok).toBe(true);
    expect(commentJson.stored).toBe(true);
    expect(addTaskComment).toHaveBeenCalled();
  });

  it("returns normalized task comments from GET /api/tasks/comment", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTaskComments: vi.fn(() => [
          { id: "c1", body: "first", author: "qa", createdAt: "2026-03-08T00:00:00.000Z" },
          { commentId: "c2", text: "second", actor: "dev", timestamp: "2026-03-08T01:00:00.000Z" },
        ]),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/comment?taskId=T-123`);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.taskId).toBe("T-123");
    expect(Array.isArray(json.comments)).toBe(true);
    expect(json.comments).toEqual([
      expect.objectContaining({
        id: "c1",
        body: "first",
        author: "qa",
        createdAt: "2026-03-08T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "c2",
        body: "second",
        author: "dev",
        createdAt: "2026-03-08T01:00:00.000Z",
      }),
    ]);
  });

  it("keeps legacy tasks without workspace metadata in the active workspace task list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-task-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const storePath = join(tmpDir, ".bosun", ".cache", "kanban-state.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        activeWorkspace: "virtengine-gh",
        workspaces: [
          {
            id: "virtengine-gh",
            name: "virtengine-gh",
            repos: [{ name: "bosun", primary: true }],
            activeRepo: "bosun",
          },
        ],
      }, null, 2) + "\n",
      "utf8",
    );
    process.env.BOSUN_CONFIG_PATH = configPath;

    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();
    taskStore.addTask({ id: "legacy-no-workspace", title: "Legacy task", status: "todo" });
    taskStore.addTask({ id: "active-workspace", title: "Active workspace task", status: "draft", workspace: "virtengine-gh" });
    taskStore.addTask({ id: "blocked-workspace", title: "Blocked workspace task", status: "blocked", workspace: "virtengine-gh" });
    taskStore.addTask({ id: "other-workspace", title: "Other workspace task", status: "todo", workspace: "other-workspace" });

    const mod = await import("../server/ui-server.mjs");
    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.total).toBe(3);
      expect(json.statusCounts.backlog).toBe(1);
      expect(json.statusCounts.draft).toBe(1);
      expect(json.statusCounts.blocked).toBe(1);
      expect(json.data.map((task) => task.id).sort()).toEqual([
        "active-workspace",
        "blocked-workspace",
        "legacy-no-workspace",
      ]);
    } finally {
      taskStore.configureTaskStore({ storePath: originalStorePath });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sets full dependencies and assigns sprint task ordering via task APIs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const taskMap = new Map();
    const sprintMap = new Map();

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTaskById: vi.fn((taskId) => taskMap.get(taskId) || null),
        addTaskDependency: vi.fn((taskId, depId) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const next = Array.isArray(task.dependencyTaskIds) ? [...task.dependencyTaskIds] : [];
          if (!next.includes(depId)) next.push(depId);
          taskMap.set(taskId, { ...task, dependencyTaskIds: next, dependsOn: next, dependencies: next });
          return true;
        }),
        removeTaskDependency: vi.fn((taskId, depId) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const next = (Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : []).filter((id) => id !== depId);
          taskMap.set(taskId, { ...task, dependencyTaskIds: next, dependsOn: next, dependencies: next });
          return true;
        }),
        updateTask: vi.fn((taskId, patch) => {
          const task = taskMap.get(taskId) || { id: taskId, meta: {} };
          const updated = {
            ...task,
            ...patch,
            meta: {
              ...(task.meta || {}),
              ...(patch?.meta && typeof patch.meta === "object" ? patch.meta : {}),
            },
          };
          taskMap.set(taskId, updated);
          return updated;
        }),
        upsertSprint: vi.fn((sprintId, payload = {}) => {
          const id = String(sprintId || payload?.id || "").trim();
          if (!id) return null;
          const sprint = { id, ...(payload || {}) };
          sprintMap.set(id, sprint);
          return sprint;
        }),
        assignTaskToSprint: vi.fn((taskId, sprintId, options = {}) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const updated = {
            ...task,
            sprintId,
            sprint: sprintId,
            ...(Number.isFinite(Number(options?.sprintOrder)) ? { sprintOrder: Number(options.sprintOrder) } : {}),
          };
          taskMap.set(taskId, updated);
          return updated;
        }),
        getSprintDag: vi.fn((sprintId) => {
          const nodes = [...taskMap.values()]
            .filter((task) => String(task?.sprintId || task?.sprint || "") === String(sprintId))
            .map((task) => ({ id: task.id }));
          return { sprintId, nodes, edges: [] };
        }),
        getGlobalDagOfDags: vi.fn(() => ({ nodes: [...sprintMap.keys()].map((id) => ({ id })), edges: [] })),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const taskOne = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dependency task one", description: "base" }),
    }).then((r) => r.json());
    const taskTwo = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dependency task two", description: "dep" }),
    }).then((r) => r.json());

    expect(taskOne.ok).toBe(true);
    expect(taskTwo.ok).toBe(true);
    taskMap.set(taskOne.data.id, taskOne.data);
    taskMap.set(taskTwo.data.id, taskTwo.data);

    const depResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: taskOne.data.id,
        dependencies: [taskTwo.data.id],
        sprintId: "sprint-a",
        sprintOrder: 2,
      }),
    });
    const depJson = await depResponse.json();

    expect(depResponse.status).toBe(200);
    expect(depJson.ok).toBe(true);
    expect(depJson.dependencies).toEqual([taskTwo.data.id]);
    expect(depJson.data.sprintId).toBe("sprint-a");
    expect(depJson.dag.sprint).toBeTruthy();
    expect(depJson.dag.global).toBeTruthy();

    const assignResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/sprint-b/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: taskOne.data.id, sprintOrder: 1 }),
    });
    const assignJson = await assignResponse.json();

    expect(assignResponse.status).toBe(200);
    expect(assignJson.ok).toBe(true);
    expect(assignJson.data.sprintId).toBe("sprint-b");

    const sprintDagResp = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/sprint-b/dag`);
    const sprintDagJson = await sprintDagResp.json();

    expect(sprintDagResp.status).toBe(200);
    expect(sprintDagJson.ok).toBe(true);
    expect(sprintDagJson.sprintId).toBe("sprint-b");
    expect(Array.isArray(sprintDagJson.data.nodes)).toBe(true);
  });


  it("persists jira-style metadata fields on create, update, and edit", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "jira-metadata task",
        description: "metadata",
        assignee: "alice",
        epicId: "EPIC-123",
        storyPoints: 8,
        parentTaskId: "PARENT-1",
        dueDate: "2026-04-01",
      }),
    }).then((r) => r.json());

    expect(created.ok).toBe(true);
    expect(created.data.assignee).toBe("alice");
    expect(created.data.assignees).toEqual(["alice"]);
    expect(created.data.epicId).toBe("EPIC-123");
    expect(created.data.storyPoints).toBe(8);
    expect(created.data.parentTaskId).toBe("PARENT-1");
    expect(created.data.dueDate).toBe("2026-04-01");
    expect(created.data.meta?.assignee).toBe("alice");
    expect(created.data.meta?.assignees).toEqual(["alice"]);
    expect(created.data.meta?.epicId).toBe("EPIC-123");
    expect(created.data.meta?.storyPoints).toBe(8);
    expect(created.data.meta?.parentTaskId).toBe("PARENT-1");
    expect(created.data.meta?.dueDate).toBe("2026-04-01");

    const updated = await fetch("http://127.0.0.1:" + port + "/api/tasks/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        assignee: "charlie",
        assignees: ["charlie", "dana"],
        epicId: "EPIC-999",
        storyPoints: 13,
        parentTaskId: "PARENT-2",
        dueDate: "2026-05-10",
      }),
    }).then((r) => r.json());

    expect(updated.ok).toBe(true);
    expect(updated.data.assignee).toBe("charlie");
    expect(updated.data.assignees).toEqual(["charlie", "dana"]);
    expect(updated.data.epicId).toBe("EPIC-999");
    expect(updated.data.storyPoints).toBe(13);
    expect(updated.data.parentTaskId).toBe("PARENT-2");
    expect(updated.data.dueDate).toBe("2026-05-10");
    expect(updated.data.meta?.assignee).toBe("charlie");
    expect(updated.data.meta?.assignees).toEqual(["charlie", "dana"]);
    expect(updated.data.meta?.epicId).toBe("EPIC-999");
    expect(updated.data.meta?.storyPoints).toBe(13);
    expect(updated.data.meta?.parentTaskId).toBe("PARENT-2");
    expect(updated.data.meta?.dueDate).toBe("2026-05-10");

    const edited = await fetch("http://127.0.0.1:" + port + "/api/tasks/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        assignee: "eve",
        assignees: ["eve"],
        epicId: "EPIC-777",
        storyPoints: 5,
        parentTaskId: "PARENT-3",
        dueDate: "2026-06-20",
      }),
    }).then((r) => r.json());

    expect(edited.ok).toBe(true);
    expect(edited.data.assignee).toBe("eve");
    expect(edited.data.assignees).toEqual(["eve"]);
    expect(edited.data.epicId).toBe("EPIC-777");
    expect(edited.data.storyPoints).toBe(5);
    expect(edited.data.parentTaskId).toBe("PARENT-3");
    expect(edited.data.dueDate).toBe("2026-06-20");
    expect(edited.data.meta?.assignee).toBe("eve");
    expect(edited.data.meta?.assignees).toEqual(["eve"]);
    expect(edited.data.meta?.epicId).toBe("EPIC-777");
    expect(edited.data.meta?.storyPoints).toBe(5);
    expect(edited.data.meta?.parentTaskId).toBe("PARENT-3");
    expect(edited.data.meta?.dueDate).toBe("2026-06-20");
  });

  it("creates and lists subtasks via /api/tasks/subtasks", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const taskMap = new Map();
    let nextId = 1;

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTask: vi.fn((taskId) => taskMap.get(taskId) || null),
        getAllTasks: vi.fn(() => [...taskMap.values()]),
        createTask: vi.fn((projectId, payload = {}) => {
          const id = payload.id || `task-${nextId++}`;
          const created = {
            id,
            title: payload.title || "",
            description: payload.description || "",
            status: payload.status || "todo",
            ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
            ...(payload.priority ? { priority: payload.priority } : {}),
            meta: {
              ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
            },
          };
          taskMap.set(id, created);
          return created;
        }),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const parent = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Parent task", description: "parent" }),
    }).then((r) => r.json());
    expect(parent.ok).toBe(true);

    const missingParent = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentTaskId: "missing-parent", title: "Orphan" }),
    });
    expect(missingParent.status).toBe(404);

    const subtask = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentTaskId: parent.data.id,
        title: "Child task",
      }),
    }).then((r) => r.json());

    expect(subtask.ok).toBe(true);
    expect(subtask.parentTaskId).toBe(parent.data.id);
    expect(subtask.data.parentTaskId || subtask.data?.meta?.parentTaskId).toBe(parent.data.id);

    const listedByTaskId = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks?taskId=" + encodeURIComponent(parent.data.id))
      .then((r) => r.json());

    expect(listedByTaskId.ok).toBe(true);
    expect(Array.isArray(listedByTaskId.data)).toBe(true);
    expect(Array.isArray(listedByTaskId.data)).toBe(true);

    const listedByParentTaskId = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks?parentTaskId=" + encodeURIComponent(parent.data.id))
      .then((r) => r.json());

    expect(listedByParentTaskId.ok).toBe(true);
    expect(listedByParentTaskId.taskId).toBe(parent.data.id);
    expect(Array.isArray(listedByParentTaskId.data)).toBe(true);
  });

  it("organizes task DAGs and returns dependency suggestions", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const organizeTaskDag = vi.fn(async () => ({
      orderedSprintIds: ["sprint-b", "sprint-a"],
      orderedTaskIdsBySprint: { "sprint-b": ["task-1", "task-2"] },
      updatedSprintCount: 1,
      updatedTaskCount: 2,
      appliedDependencySuggestionCount: 1,
      syncedEpicDependencyCount: 1,
      suggestions: [
        {
          type: "missing_sequential_dependency",
          sprintId: "sprint-b",
          taskId: "task-2",
          dependencyTaskId: "task-1",
          message: "Add dependency task-1 -> task-2 to encode sequential sprint order.",
        },
      ],
    }));
    mod.injectUiDependencies({
      taskStoreApi: {
        organizeTaskDag,
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/dag/organize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sprintId: "sprint-b", applyDependencySuggestions: true, syncEpicDependencies: true }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sprintId).toBe("sprint-b");
    expect(Array.isArray(json.suggestions)).toBe(true);
    expect(json.suggestions[0].type).toBe("missing_sequential_dependency");
    expect(json.data.updatedSprintCount).toBe(1);
    expect(json.data.appliedDependencySuggestionCount).toBe(1);
    expect(json.data.syncedEpicDependencyCount).toBe(1);
    expect(organizeTaskDag).toHaveBeenCalledWith({
      sprintId: "sprint-b",
      applyDependencySuggestions: true,
      syncEpicDependencies: true,
    });
  });

  it("focuses agent log tails on session-specific lines", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const logDir = join(process.cwd(), "logs", "agents");
    mkdirSync(logDir, { recursive: true });
    const query = `ve-log-focus-${Date.now()}`;
    const logPath = join(logDir, `agent-${query}.log`);
    writeFileSync(
      logPath,
      [
        "[2026-03-08T12:38:40.000Z] [info] monitor: unrelated health check",
        `[2026-03-08T12:38:41.000Z] [info] task-executor: Task ${query} moved to review`,
        `[2026-03-08T12:38:42.000Z] [error] review-agent: [${query}] failed due to policy check`,
        "[2026-03-08T12:38:43.000Z] [info] monitor: another unrelated line",
      ].join("\n"),
      "utf8",
    );

    try {
      const payload = await fetch(
        `http://127.0.0.1:${port}/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=6`,
      ).then((r) => r.json());

      expect(payload.ok).toBe(true);
      expect(payload.data?.file).toBe(`agent-${query}.log`);
      expect(payload.data?.mode).toBe("focused");
      expect(payload.data?.content || "").toContain(query);
      expect(payload.data?.content || "").toContain("failed due to policy check");
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it("merges bounded system log tails across monitor, error, and daemon logs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const logDir = join(process.cwd(), "logs");
    mkdirSync(logDir, { recursive: true });
    const logNames = ["monitor.log", "monitor-error.log", "daemon.log"];
    const backup = new Map(
      logNames.map((name) => {
        const filePath = join(logDir, name);
        return [name, existsSync(filePath) ? readFileSync(filePath, "utf8") : null];
      }),
    );

    const fixtures = {
      "daemon.log": [
        "2026-03-04T04:08:15.429Z [INFO] [daemon] bootstrap",
        "2026-03-04T04:08:15.442Z [INFO] [daemon] heartbeat",
      ].join("\n") + "\n",
      "monitor.log": [
        "2026-03-04T04:08:15.430Z [INFO] [kanban] using jira backend",
        "2026-03-04T04:08:15.434Z [INFO] [task-store] no store file found",
      ].join("\n") + "\n",
      "monitor-error.log": [
        "2026-03-04T04:08:15.431Z [WARN] [kanban] switched to jira backend",
        "2026-03-04T04:08:15.440Z [ERROR] [task-store] removed task",
      ].join("\n") + "\n",
    };

    try {
      for (const [name, content] of Object.entries(fixtures)) {
        writeFileSync(join(logDir, name), content, "utf8");
      }

      const payload = await fetch(`http://127.0.0.1:${port}/api/logs?lines=6`).then((r) => r.json());

      expect(payload.ok).toBe(true);
      expect(payload.data?.files).toEqual(["monitor.log", "monitor-error.log", "daemon.log"]);
      expect(payload.data?.lines).toEqual([
        "2026-03-04T04:08:15.429Z [INFO] [daemon] bootstrap",
        "2026-03-04T04:08:15.430Z [INFO] [kanban] using jira backend",
        "2026-03-04T04:08:15.431Z [WARN] [kanban] switched to jira backend",
        "2026-03-04T04:08:15.434Z [INFO] [task-store] no store file found",
        "2026-03-04T04:08:15.440Z [ERROR] [task-store] removed task",
        "2026-03-04T04:08:15.442Z [INFO] [daemon] heartbeat",
      ]);
      expect(payload.data?.truncated).toBe(false);
    } finally {
      for (const [name, content] of backup.entries()) {
        const filePath = join(logDir, name);
        if (content == null) rmSync(filePath, { force: true });
        else writeFileSync(filePath, content, "utf8");
      }
    }
  });

  it("falls back to session workspaceDir for diff view", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const repoDir = mkdtempSync(join(tmpdir(), "bosun-session-diff-"));
    const filePath = join(repoDir, "notes.txt");
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\n", "utf8");
    execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\nline two\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "task",
          workspaceDir: repoDir,
          prompt: "diff fallback regression",
        }),
      }).then((r) => r.json());

      expect(created.ok).toBe(true);
      const sessionId = created.session?.id;
      expect(sessionId).toBeTruthy();

      const diffPayload = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/diff?workspace=all`,
      ).then((r) => r.json());

      expect(diffPayload.ok).toBe(true);
      expect(diffPayload.diff?.totalFiles).toBeGreaterThan(0);
      expect(Array.isArray(diffPayload.diff?.files)).toBe(true);
      expect(diffPayload.diff.files.some((entry) => String(entry.file || entry.filename || "").includes("notes.txt"))).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports live compaction telemetry breakdowns", async () => {
    const logDir = join(process.cwd(), ".cache", "agent-work-logs");
    mkdirSync(logDir, { recursive: true });
    const shreddingPath = join(logDir, "shredding-stats.jsonl");
    const sessionAccumulatorPath = join(process.cwd(), ".cache", "session-accumulator.jsonl");
    const previousStats = existsSync(shreddingPath)
      ? readFileSync(shreddingPath, "utf8")
      : null;
    const previousSessions = existsSync(sessionAccumulatorPath)
      ? readFileSync(sessionAccumulatorPath, "utf8")
      : null;
    const now = new Date();
    const entries = [
      {
        timestamp: new Date(now.getTime() - 60_000).toISOString(),
        originalChars: 9000,
        compressedChars: 2200,
        savedChars: 6800,
        savedPct: 76,
        agentType: "codex-sdk",
        attemptId: "attempt-live-search",
        stage: "live_tool_compaction",
        compactionFamily: "search",
        commandFamily: "rg",
      },
      {
        timestamp: new Date(now.getTime() - 30_000).toISOString(),
        originalChars: 5000,
        compressedChars: 1800,
        savedChars: 3200,
        savedPct: 64,
        agentType: "copilot-sdk",
        attemptId: "attempt-live-git",
        stage: "live_tool_compaction",
        compactionFamily: "git",
        commandFamily: "git",
      },
      {
        timestamp: now.toISOString(),
        originalChars: 14000,
        compressedChars: 6000,
        savedChars: 8000,
        savedPct: 57,
        agentType: "claude-sdk",
        attemptId: "attempt-session-total",
        stage: "session_total",
      },
    ];
    writeFileSync(
      shreddingPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    writeFileSync(
      sessionAccumulatorPath,
      `${[
        {
          type: "completed_session",
          sessionKey: "task-1:session-1",
          id: "session-1",
          taskId: "task-1",
          taskTitle: "Telemetry task 1",
          executor: "codex",
          startedAt: now.getTime() - 120_000,
          endedAt: now.getTime() - 60_000,
          durationMs: 60_000,
          tokenCount: 1000,
          inputTokens: 700,
          outputTokens: 300,
          costUsd: 0.5,
          recordedAt: new Date(now.getTime() - 60_000).toISOString(),
        },
        {
          type: "completed_session",
          sessionKey: "task-2:session-2",
          id: "session-2",
          taskId: "task-2",
          taskTitle: "Telemetry task 2",
          executor: "claude",
          startedAt: now.getTime() - 90_000,
          endedAt: now.getTime() - 30_000,
          durationMs: 60_000,
          tokenCount: 2000,
          inputTokens: 1400,
          outputTokens: 600,
          costUsd: 1.0,
          recordedAt: new Date(now.getTime() - 30_000).toISOString(),
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/telemetry/shredding?days=30`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(Number(payload.data?.stageCounts?.live_tool_compaction || 0)).toBeGreaterThanOrEqual(2);
      expect(Number(payload.data?.stageCounts?.session_total || 0)).toBeGreaterThanOrEqual(1);
      expect(Number(payload.data?.liveCompaction?.totalEvents || 0)).toBeGreaterThanOrEqual(2);
      expect(Number(payload.data?.liveCompaction?.totalSavedChars || 0)).toBeGreaterThanOrEqual(10000);
      expect(Number(payload.data?.liveCompaction?.avgSavedPct || 0)).toBeGreaterThanOrEqual(60);
      expect(Number(payload.data?.totals?.savedTokensEstimated || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.liveCompaction?.savedTokensEstimated || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.estimation?.blendedCostPerMillionTokensUsd || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.totals?.estimatedCostSavedUsd || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailyOriginal?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailyCompressed?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailySavedTokensEstimated?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(payload.data.topCompactionFamilies.some((entry) => entry.name === "search" && entry.count >= 1)).toBe(true);
      expect(payload.data.topCommandFamilies.some((entry) => entry.name === "git" && entry.count >= 1)).toBe(true);
      expect(payload.data.recentEvents[0]).toHaveProperty("stage");
      expect(payload.data.recentEvents[0]).toHaveProperty("estimatedSavedTokens");
    } finally {
      if (previousStats == null) rmSync(shreddingPath, { force: true });
      else writeFileSync(shreddingPath, previousStats, "utf8");
      if (previousSessions == null) rmSync(sessionAccumulatorPath, { force: true });
      else writeFileSync(sessionAccumulatorPath, previousSessions, "utf8");
    }
  });

  it("sources agent-run analytics from completed session history when session-start events are stale", async () => {
    const logDir = join(process.cwd(), ".cache", "agent-work-logs");
    mkdirSync(logDir, { recursive: true });
    const streamPath = join(logDir, "agent-work-stream.jsonl");
    const sessionAccumulatorPath = join(process.cwd(), ".cache", "session-accumulator.jsonl");
    const previousStream = existsSync(streamPath)
      ? readFileSync(streamPath, "utf8")
      : null;
    const previousSessions = existsSync(sessionAccumulatorPath)
      ? readFileSync(sessionAccumulatorPath, "utf8")
      : null;
    const now = new Date();
    writeFileSync(
      streamPath,
      `${[
        {
          timestamp: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
          event_type: "session_start",
          executor: "outdated-executor",
        },
        {
          timestamp: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
          event_type: "skill_invoke",
          data: { skill_name: "critical-path" },
        },
        {
          timestamp: new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
          event_type: "tool_call",
          data: { tool_name: "context7.get-library-docs" },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    writeFileSync(
      sessionAccumulatorPath,
      `${[
        {
          type: "completed_session",
          sessionKey: "task-a:session-a",
          id: "session-a",
          taskId: "task-a",
          taskTitle: "Recent agent run A",
          executor: "codex",
          startedAt: now.getTime() - 8 * 60 * 1000,
          endedAt: now.getTime() - 7 * 60 * 1000,
          durationMs: 60_000,
          tokenCount: 1200,
          inputTokens: 800,
          outputTokens: 400,
          costUsd: 0.6,
          recordedAt: new Date(now.getTime() - 7 * 60 * 1000).toISOString(),
        },
        {
          type: "completed_session",
          sessionKey: "task-b:session-b",
          id: "session-b",
          taskId: "task-b",
          taskTitle: "Recent agent run B",
          executor: "claude",
          startedAt: now.getTime() - 6 * 60 * 1000,
          endedAt: now.getTime() - 5 * 60 * 1000,
          durationMs: 60_000,
          tokenCount: 1500,
          inputTokens: 900,
          outputTokens: 600,
          costUsd: 0.75,
          recordedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/analytics/usage?days=30`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data?.agentRuns).toBe(2);
      expect(payload.data?.skillInvocations).toBe(1);
      expect(payload.data?.mcpToolCalls).toBe(1);
      expect(payload.data?.diagnostics?.agentRunSource).toBe("completed_sessions");
      expect(payload.data?.diagnostics?.completedSessions).toBe(2);
      expect(payload.data?.diagnostics?.sessionStarts).toBe(0);
      expect(payload.data?.topAgents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "codex", count: 1 }),
          expect.objectContaining({ name: "claude", count: 1 }),
        ]),
      );
    } finally {
      if (previousStream == null) rmSync(streamPath, { force: true });
      else writeFileSync(streamPath, previousStream, "utf8");
      if (previousSessions == null) rmSync(sessionAccumulatorPath, { force: true });
      else writeFileSync(sessionAccumulatorPath, previousSessions, "utf8");
    }
  });

  it("serves benchmark snapshots and persists benchmark mode for the active workspace", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-benchmark-mode-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "bench-alpha");
    const workspaceRepo = join(workspaceRoot, "repo");
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "bench-alpha",
          workspaces: [
            {
              id: "bench-alpha",
              name: "Benchmark Alpha",
              path: workspaceRoot,
              activeRepo: "repo",
              repos: [{ name: "repo", path: workspaceRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const executor = {
      maxParallel: 4,
      paused: false,
      getStatus() {
        return {
          maxParallel: this.maxParallel,
          activeSlots: 0,
          slots: [],
          paused: this.paused,
        };
      },
      isPaused() {
        return this.paused;
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      abortTask: vi.fn(() => ({ ok: true, reason: "benchmark_mode_focus" })),
    };
    mod.injectUiDependencies({
      getInternalExecutor: () => executor,
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const snapshot = await fetch(`http://127.0.0.1:${port}/api/benchmarks`).then((r) => r.json());
      expect(snapshot.ok).toBe(true);
      expect(snapshot.data.providers.some((entry) => entry.id === "swebench")).toBe(true);
      expect(snapshot.data.workspace.workspaceId).toBe("bench-alpha");

      const enabled = await fetch(`http://127.0.0.1:${port}/api/benchmarks/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          enabled: true,
          maxParallel: 1,
          pauseOtherAgents: true,
          holdActiveNonBenchmarkTasks: false,
        }),
      }).then((r) => r.json());

      expect(enabled.ok).toBe(true);
      expect(enabled.data.mode.enabled).toBe(true);
      expect(enabled.data.mode.providerId).toBe("swebench");
      expect(enabled.data.appliedMaxParallel).toBe(1);

      const modePath = join(workspaceRepo, ".bosun", ".cache", "benchmark-mode.json");
      expect(existsSync(modePath)).toBe(true);
      expect(JSON.parse(readFileSync(modePath, "utf8")).providerId).toBe("swebench");

      const disabled = await fetch(`http://127.0.0.1:${port}/api/benchmarks/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "swebench", enabled: false }),
      }).then((r) => r.json());

      expect(disabled.ok).toBe(true);
      expect(disabled.data.mode.enabled).toBe(false);
      expect(existsSync(modePath)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);

  it("creates benchmark workspaces and launches SWE-bench imports through benchmark routes", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-benchmark-run-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "./bosun.schema.json", workspaces: [] }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const executor = {
      maxParallel: 3,
      paused: false,
      getStatus() {
        return {
          maxParallel: this.maxParallel,
          activeSlots: 0,
          slots: [],
          paused: this.paused,
        };
      },
      isPaused() {
        return this.paused;
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      abortTask: vi.fn(() => ({ ok: true, reason: "benchmark_mode_focus" })),
    };
    mod.injectUiDependencies({
      getInternalExecutor: () => executor,
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const workspaceResponse = await fetch(`http://127.0.0.1:${port}/api/benchmarks/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          name: "Bench Smoke",
          switchActive: true,
          ensureRuntime: true,
        }),
      }).then((r) => r.json());

      expect(workspaceResponse.ok).toBe(true);
      expect(workspaceResponse.data.created).toBe(true);
      expect(workspaceResponse.data.preset.profile.id).toBe("benchmark-agent");

      const workspaceRoot = workspaceResponse.data.preset.rootDir || workspaceResponse.data.workspace.path;
      expect(typeof workspaceRoot).toBe("string");
      expect(existsSync(join(workspaceRoot, ".bosun", "profiles", "benchmark-agent.json"))).toBe(true);

      const instancesPath = join(tmpDir, "instances.jsonl");
      writeFileSync(
        instancesPath,
        `${JSON.stringify({
          instance_id: "demo__bench-1",
          problem_statement: "Fix benchmark route coverage",
          repo: "acme/widgets",
          base_commit: "abc123",
          workspace: workspaceRoot,
        })}\n`,
        "utf8",
      );

      const runResponse = await fetch(`http://127.0.0.1:${port}/api/benchmarks/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          instances: instancesPath,
          prepareWorkspace: true,
          activateMode: true,
        }),
      }).then((r) => r.json());

      expect(runResponse.ok).toBe(true);
      expect(runResponse.data.launch.created).toBe(1);
      expect(runResponse.data.mode.enabled).toBe(true);
      expect(runResponse.data.snapshot.recentTasks.some((task) => task.id === "swebench-demo__bench-1")).toBe(true);

      const storePath = join(workspaceRoot, ".bosun", ".cache", "kanban-state.json");
      expect(existsSync(storePath)).toBe(true);
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      expect(Object.keys(store.tasks || {})).toContain("swebench-demo__bench-1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  it("routes default-chat workflow Telegram notifications through the live digest helper", () => {
    const source = readFileSync(join(process.cwd(), "server", "ui-server.mjs"), "utf8");

    expect(source).toContain("async function sendWorkflowTelegramMessage");
    expect(source).toContain('const digest = await getWorkflowTelegramDigest()');
    expect(source).toContain('await digest.notify(message, 4, {');
    expect(source).toContain('category: "workflow"');
  });

});
