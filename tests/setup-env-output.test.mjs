import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  applyTelegramMiniAppDefaults,
  applyEnvFileToProcess,
  buildStandardizedEnvFile,
  extractProjectNumber,
  resolveOrCreateGitHubProject,
} from "../setup.mjs";

describe("setup env output", () => {
  it("removes duplicate env keys from template output", () => {
    const template = [
      "# Section A",
      "# COPILOT_SDK_DISABLED=false",
      "# CODEX_SDK_DISABLED=false",
      "# Section B",
      "# COPILOT_SDK_DISABLED=false",
      "",
    ].join("\n");

    const output = buildStandardizedEnvFile(template, {
      COPILOT_SDK_DISABLED: "true",
    });

    const copilotLines = output
      .split(/\r?\n/)
      .filter((line) => /^\s*#?\s*COPILOT_SDK_DISABLED=/.test(line));

    expect(copilotLines).toEqual(["COPILOT_SDK_DISABLED=true"]);
    expect(output).toContain("# CODEX_SDK_DISABLED=false");
  });

  it("loads existing .env values into process env for setup defaults", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "bosun-setup-env-"));
    const envPath = resolve(dir, ".env");
    delete process.env.BOSUN_TEST_KEY;

    try {
      await writeFile(envPath, "BOSUN_TEST_KEY=from-file\n", "utf8");
      const result = applyEnvFileToProcess(envPath, { override: true });
      expect(result.found).toBe(true);
      expect(result.loaded).toBe(1);
      expect(process.env.BOSUN_TEST_KEY).toBe("from-file");
    } finally {
      delete process.env.BOSUN_TEST_KEY;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enables Telegram Mini App defaults when Telegram is configured", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "123456:abc-token",
    };

    const configured = applyTelegramMiniAppDefaults(env, {});
    expect(configured).toBe(true);
    expect(env.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(env.TELEGRAM_UI_PORT).toBe("3080");
    expect(env.TELEGRAM_UI_TUNNEL).toBe("named");
    expect(env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK).toBe("false");
    expect(env.TELEGRAM_UI_FALLBACK_AUTH_ENABLED).toBe("true");
    expect(env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY).toBe("per-user-fixed");
    expect(env.TELEGRAM_UI_ALLOW_UNSAFE).toBe("false");
  });

  it("keeps explicit Telegram Mini App overrides from setup inputs", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "123456:abc-token",
      TELEGRAM_MINIAPP_ENABLED: "false",
      TELEGRAM_UI_PORT: "4410",
      TELEGRAM_UI_TUNNEL: "cloudflared",
      TELEGRAM_UI_ALLOW_UNSAFE: "true",
    };

    applyTelegramMiniAppDefaults(env, {});
    expect(env.TELEGRAM_MINIAPP_ENABLED).toBe("false");
    expect(env.TELEGRAM_UI_PORT).toBe("4410");
    expect(env.TELEGRAM_UI_TUNNEL).toBe("cloudflared");
    expect(env.TELEGRAM_UI_ALLOW_UNSAFE).toBe("true");
  });
});

describe("GitHub project resolution helpers", () => {
  it("extracts project number from number/url/object/text variants", () => {
    expect(extractProjectNumber("12")).toBe("12");
    expect(extractProjectNumber(34)).toBe("34");
    expect(
      extractProjectNumber("https://github.com/orgs/acme/projects/56"),
    ).toBe("56");
    expect(extractProjectNumber("Created project 'Codex' (project #78)"))
      .toBe("78");
    expect(
      extractProjectNumber({
        url: "https://github.com/orgs/acme/projects/91",
      }),
    ).toBe("91");
  });

  it("returns existing project number when list output contains matching title", () => {
    const runCommand = (args) => {
      expect(args).toEqual([
        "project",
        "list",
        "--owner",
        "acme",
        "--format",
        "json",
      ]);
      return JSON.stringify({
        projects: [
          {
            title: "Bosun",
            number: 17,
            url: "https://github.com/orgs/acme/projects/17",
          },
        ],
      });
    };

    const result = resolveOrCreateGitHubProject({
      owner: "acme",
      title: "Bosun",
      runCommand,
    });

    expect(result).toMatchObject({ number: "17", owner: "acme" });
  });

  it("creates project when list has no match and preserves quoted title safely", () => {
    const calls = [];
    const runCommand = (args) => {
      calls.push(args);
      if (args[1] === "list") {
        return JSON.stringify([]);
      }
      if (args[1] === "create") {
        return "https://github.com/orgs/acme/projects/88";
      }
      return "";
    };

    const result = resolveOrCreateGitHubProject({
      owner: "acme",
      title: 'Codex "Monitor" Board',
      runCommand,
    });

    expect(result).toMatchObject({ number: "88", owner: "acme" });
    expect(calls[1]).toEqual([
      "project",
      "create",
      "--owner",
      "acme",
      "--title",
      'Codex "Monitor" Board',
    ]);
  });

  it("falls back to create when list fails for same owner", () => {
    const runCommand = (args) => {
      if (args[1] === "list") {
        throw new Error("network timeout");
      }
      if (args[1] === "create") {
        return "Created project #41";
      }
      return "";
    };

    const result = resolveOrCreateGitHubProject({
      owner: "acme",
      title: "Bosun",
      runCommand,
    });

    expect(result).toMatchObject({ number: "41", owner: "acme" });
  });

  it("tries owner fallback candidates (configured -> github login -> repo owner)", () => {
    const ownersSeen = [];
    const runCommand = (args) => {
      if (args[1] === "list") {
        ownersSeen.push(args[3]);
        if (args[3] === "configured-owner") {
          return JSON.stringify([]);
        }
        if (args[3] === "detected-user") {
          throw new Error("no project scope for user");
        }
        if (args[3] === "repo-owner") {
          return JSON.stringify([
            {
              title: "Bosun",
              url: "https://github.com/orgs/repo-owner/projects/73",
            },
          ]);
        }
      }

      if (args[1] === "create" && args[3] === "configured-owner") {
        throw new Error("forbidden");
      }
      if (args[1] === "create" && args[3] === "detected-user") {
        throw new Error("forbidden");
      }

      return "";
    };

    const result = resolveOrCreateGitHubProject({
      owner: "configured-owner",
      title: "Bosun",
      githubLogin: "detected-user",
      repoOwner: "repo-owner",
      runCommand,
    });

    expect(result).toMatchObject({ number: "73", owner: "repo-owner" });
    expect(ownersSeen).toEqual([
      "configured-owner",
      "detected-user",
      "repo-owner",
    ]);
  });
});
