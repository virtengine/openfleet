import { describe, expect, it } from "vitest";

import { buildAgentConfigurationGuide } from "../lib/agent-configuration-guide.mjs";

describe("agent configuration guide", () => {
  it("formats executor pool objects without object-object leakage", () => {
    const guide = buildAgentConfigurationGuide({
      PRIMARY_AGENT: "codex-sdk",
      INTERNAL_EXECUTOR_SDK: "auto",
      EXECUTOR_DISTRIBUTION: "primary-only",
      EXECUTORS: [
        { executor: "codex", variant: "default", weight: 70, model: "gpt-5.4" },
        { executor: "codex", variant: "fallback", weight: 30, model: "gpt-5.1-codex-mini" },
      ],
      BOSUN_PROVIDER_DEFAULT: "openai-responses",
    }, {
      defaultProviderId: "openai-responses",
      items: [
        {
          providerId: "openai-responses",
          label: "OpenAI Responses",
          enabled: true,
          auth: { authenticated: true, canRun: true },
        },
      ],
    });

    expect(guide.shellRuntime.currentLabel).toBe("Codex");
    expect(guide.routingPool.note).toContain("2 pool entries across 1 runtime");
    expect(guide.routingPool.note).toContain("Codex");
    expect(guide.routingPool.note).not.toContain("[object Object]");
    expect(guide.providerLayer.currentLabel).toBe("OpenAI Responses");
    expect(guide.providerLayer.items[0].statusLabel).toBe("connected");
  });
});
