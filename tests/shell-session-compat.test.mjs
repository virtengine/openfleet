import { describe, expect, it } from "vitest";

import { createHarnessSessionManager } from "../agent/session-manager.mjs";
import { createShellSessionCompat } from "../shell/shell-session-compat.mjs";

describe("shell-session-compat", () => {
  it("hydrates and clears canonical shell session state via the Bosun session manager", () => {
    const sessionManager = createHarnessSessionManager();
    const compat = createShellSessionCompat({
      adapterName: "gemini",
      providerSelection: "gemini",
      sessionManager,
    });

    compat.hydrate({
      sessionId: "gemini-primary",
      threadId: "gemini-thread-1",
      cwd: "/repo",
      status: "idle",
      metadata: {
        turnCount: 2,
        transport: "sdk",
      },
    });

    expect(sessionManager.getActiveSessionId("shell:gemini")).toBe("gemini-primary");
    expect(compat.getSessionRecord("gemini-primary")).toMatchObject({
      id: "gemini-primary",
      sessionId: "gemini-primary",
      threadId: "gemini-thread-1",
      cwd: "/repo",
      adapter: "gemini",
      turnCount: 2,
      metadata: expect.objectContaining({
        transport: "sdk",
        adapterName: "gemini",
      }),
    });

    compat.registerExecution("gemini-primary", {
      status: "running",
      threadId: "gemini-thread-2",
      metadata: {
        turnCount: 3,
      },
    });

    expect(compat.getSessionInfo({
      sessionId: "gemini-primary",
      isBusy: true,
      transport: "sdk",
    })).toMatchObject({
      sessionId: "gemini-primary",
      threadId: "gemini-thread-2",
      turnCount: 3,
      isBusy: true,
      transport: "sdk",
      metadata: expect.objectContaining({
        turnCount: 3,
      }),
    });

    compat.reset({ keepManagedRecord: false });
    expect(sessionManager.getActiveSessionId("shell:gemini")).toBeNull();
  });

  it("merges legacy compatibility sessions with canonical shell sessions", () => {
    const sessionManager = createHarnessSessionManager();
    const compat = createShellSessionCompat({
      adapterName: "codex",
      providerSelection: "codex",
      sessionManager,
    });

    compat.createSession("codex-primary", {
      status: "idle",
      metadata: {
        turnCount: 4,
      },
    });
    compat.switchSession("codex-primary", {
      threadId: "thread-1",
      cwd: "/workspace",
      status: "active",
      metadata: {
        turnCount: 5,
      },
    });

    const sessions = compat.listSessions({
      extraSessions: [{
        id: "codex-primary",
        sessionId: "codex-primary",
        createdAt: "2026-04-02T00:00:00.000Z",
        metadata: {
          providerThreadId: "thread-1",
          legacyOnly: true,
        },
      }],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "codex-primary",
      sessionId: "codex-primary",
      threadId: "thread-1",
      cwd: "/workspace",
      active: true,
      isActive: true,
      turnCount: 5,
      metadata: expect.objectContaining({
        providerThreadId: "thread-1",
        legacyOnly: true,
        turnCount: 5,
      }),
    });
  });
});
