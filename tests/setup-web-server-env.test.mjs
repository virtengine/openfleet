import { describe, expect, it } from "vitest";
import {
  applyNonBlockingSetupEnvDefaults,
  applyTelegramMiniAppSetupEnv,
  normalizeTelegramUiPort,
} from "../setup-web-server.mjs";

describe("setup web server telegram defaults", () => {
  it("normalizes UI port values with a safe fallback", () => {
    expect(normalizeTelegramUiPort("4400")).toBe("4400");
    expect(normalizeTelegramUiPort("0")).toBe("3080");
    expect(normalizeTelegramUiPort("bad-port")).toBe("3080");
  });

  it("injects Mini App defaults when Telegram token is provided", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
      },
      {},
    );

    expect(applied).toBe(true);
    expect(envMap.TELEGRAM_BOT_TOKEN).toBe("123456:abc-token");
    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(envMap.TELEGRAM_UI_PORT).toBe("3080");
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("auto");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("false");
  });

  it("respects explicit Mini App settings from setup input", () => {
    const envMap = {};
    applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
        telegramMiniappEnabled: false,
        telegramUiPort: 4522,
        telegramUiTunnel: "cloudflared",
        telegramUiAllowUnsafe: true,
      },
      {},
    );

    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("false");
    expect(envMap.TELEGRAM_UI_PORT).toBe("4522");
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("cloudflared");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("true");
  });

  it("does not mutate env map when Telegram is not configured", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(envMap, {}, {});

    expect(applied).toBe(false);
    expect(envMap).toEqual({});
  });
});

describe("setup web server non-blocking env defaults", () => {
  it("backfills safe defaults when setup payload omits values", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(envMap, {}, {});

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "4",
      KANBAN_BACKEND: "internal",
      KANBAN_SYNC_POLICY: "internal-primary",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "primary-only",
      FAILOVER_STRATEGY: "next-in-line",
      FAILOVER_MAX_RETRIES: "3",
      FAILOVER_COOLDOWN_MIN: "5",
      FAILOVER_DISABLE_AFTER: "3",
      PROJECT_REQUIREMENTS_PROFILE: "feature",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "false",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "1",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "2",
      WORKFLOW_AUTOMATION_ENABLED: "true",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "false",
      COPILOT_AGENT_MAX_REQUESTS: "500",
      CODEX_AGENT_MAX_THREADS: "12",
      CODEX_TRANSPORT: "sdk",
      COPILOT_TRANSPORT: "sdk",
      CODEX_SANDBOX: "workspace-write",
      CONTAINER_ENABLED: "false",
      CONTAINER_RUNTIME: "auto",
      WHATSAPP_ENABLED: "false",
      TELEGRAM_INTERVAL_MIN: "10",
      VK_BASE_URL: "http://127.0.0.1:54089",
      VK_RECOVERY_PORT: "54089",
      ORCHESTRATOR_ARGS: "-MaxParallel 4",
    });
  });

  it("normalizes invalid input values to non-blocking bounds and enums", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        maxParallel: -5,
        kanbanBackend: "monday",
        kanbanSyncPolicy: "sync-it",
        executorMode: "remote",
        executorDistribution: "random",
        failoverStrategy: "always-first",
        maxRetries: 999,
        failoverCooldownMinutes: 0,
        failoverDisableOnConsecutive: 999,
        projectRequirementsProfile: "enterprise-only",
        internalReplenishEnabled: "maybe",
        internalReplenishMin: 9,
        internalReplenishMax: 0,
        workflowAutomationEnabled: "maybe",
        copilotEnableAllMcpTools: "maybe",
        copilotAgentMaxRequests: -10,
        codexAgentMaxThreads: 9999,
        codexTransport: "pipe",
        copilotTransport: "grpc",
        codexSandbox: "unsafe",
        containerEnabled: "sometimes",
        containerRuntime: "runc",
        whatsappEnabled: "sometimes",
        telegramIntervalMin: 100000,
        vkBaseUrl: "   ",
        vkRecoveryPort: 999999,
        orchestratorArgs: "   ",
      },
      {},
    );

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "1",
      KANBAN_BACKEND: "internal",
      KANBAN_SYNC_POLICY: "internal-primary",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "primary-only",
      FAILOVER_STRATEGY: "next-in-line",
      FAILOVER_MAX_RETRIES: "20",
      FAILOVER_COOLDOWN_MIN: "1",
      FAILOVER_DISABLE_AFTER: "50",
      PROJECT_REQUIREMENTS_PROFILE: "feature",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "false",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "2",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "2",
      WORKFLOW_AUTOMATION_ENABLED: "true",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "false",
      COPILOT_AGENT_MAX_REQUESTS: "1",
      CODEX_AGENT_MAX_THREADS: "256",
      CODEX_TRANSPORT: "sdk",
      COPILOT_TRANSPORT: "sdk",
      CODEX_SANDBOX: "workspace-write",
      CONTAINER_ENABLED: "false",
      CONTAINER_RUNTIME: "auto",
      WHATSAPP_ENABLED: "false",
      TELEGRAM_INTERVAL_MIN: "1440",
      VK_BASE_URL: "http://127.0.0.1:54089",
      VK_RECOVERY_PORT: "65535",
      ORCHESTRATOR_ARGS: "-MaxParallel 1",
    });
  });

  it("preserves valid explicit setup values", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        maxParallel: 8,
        kanbanBackend: "github",
        kanbanSyncPolicy: "bidirectional",
        executorMode: "hybrid",
        executorDistribution: "round-robin",
        failoverStrategy: "weighted-random",
        maxRetries: 0,
        failoverCooldownMinutes: 12,
        failoverDisableOnConsecutive: 9,
        projectRequirementsProfile: "system",
        internalReplenishEnabled: true,
        internalReplenishMin: 2,
        internalReplenishMax: 3,
        workflowAutomationEnabled: false,
        copilotEnableAllMcpTools: true,
        copilotAgentMaxRequests: 1200,
        codexAgentMaxThreads: 33,
        codexTransport: "cli",
        copilotTransport: "url",
        codexSandbox: "danger-full-access",
        containerEnabled: true,
        containerRuntime: "podman",
        whatsappEnabled: true,
        telegramIntervalMin: 42,
        vkBaseUrl: "https://vk.example.com/",
        vkRecoveryPort: 5500,
        orchestratorArgs: "-CustomFlag true",
      },
      {},
    );

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "8",
      KANBAN_BACKEND: "github",
      KANBAN_SYNC_POLICY: "bidirectional",
      EXECUTOR_MODE: "hybrid",
      EXECUTOR_DISTRIBUTION: "round-robin",
      FAILOVER_STRATEGY: "weighted-random",
      FAILOVER_MAX_RETRIES: "0",
      FAILOVER_COOLDOWN_MIN: "12",
      FAILOVER_DISABLE_AFTER: "9",
      PROJECT_REQUIREMENTS_PROFILE: "system",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "true",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "2",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "3",
      WORKFLOW_AUTOMATION_ENABLED: "false",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "true",
      COPILOT_AGENT_MAX_REQUESTS: "1200",
      CODEX_AGENT_MAX_THREADS: "33",
      CODEX_TRANSPORT: "cli",
      COPILOT_TRANSPORT: "url",
      CODEX_SANDBOX: "danger-full-access",
      CONTAINER_ENABLED: "true",
      CONTAINER_RUNTIME: "podman",
      WHATSAPP_ENABLED: "true",
      TELEGRAM_INTERVAL_MIN: "42",
      VK_BASE_URL: "https://vk.example.com",
      VK_RECOVERY_PORT: "5500",
      ORCHESTRATOR_ARGS: "-CustomFlag true",
    });
  });
});
