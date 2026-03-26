import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalDocument = globalThis.document;
const originalDispatchEvent = globalThis.dispatchEvent;
const originalCustomEvent = globalThis.CustomEvent;

function makeJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ui session recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    globalThis.location = new URL("http://127.0.0.1:4321/dashboard?view=compact");
    globalThis.document = { cookie: "" };
    globalThis.dispatchEvent = vi.fn();
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    };
  });

  afterEach(() => {
    vi.doUnmock("../ui/modules/api.js");
    vi.doUnmock("../ui/modules/telegram.js");
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
    globalThis.dispatchEvent = originalDispatchEvent;
    globalThis.CustomEvent = originalCustomEvent;
  });

  it("retries silent API requests after recovering an expired session", async () => {
    vi.doMock("../ui/modules/telegram.js", () => ({
      getInitData: () => "",
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({ ok: false, error: "Unauthorized." }, 401))
      .mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }))
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { healthy: true } }, 200));

    globalThis.fetch = fetchMock;

    const { apiFetch } = await import("../ui/modules/api.js");
    const payload = await apiFetch("/api/status", { _silent: true });

    expect(payload).toEqual({ ok: true, data: { healthy: true } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status");
    expect(fetchMock.mock.calls[1][0]).toBe("/dashboard?view=compact");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/status");
  });

  it("keeps initial successful loads on the primary request path", async () => {
    vi.doMock("../ui/modules/telegram.js", () => ({
      getInitData: () => "",
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { healthy: true } }, 200));

    globalThis.fetch = fetchMock;

    const { apiFetch } = await import("../ui/modules/api.js");
    const payload = await apiFetch("/api/status", { _silent: true });

    expect(payload).toEqual({ ok: true, data: { healthy: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status");
  });

  it("preserves the full executor payload shape for control and fleet tabs", async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        maxParallel: 5,
        activeSlots: 2,
        slots: [{ taskId: "task-1", status: "running" }],
        pollIntervalMs: 30000,
        taskTimeoutMs: 600000,
      },
      mode: "internal",
      paused: true,
    });

    vi.doMock("../ui/modules/api.js", () => ({
      apiFetch,
      onWsMessage: () => () => {},
      withLoadingSuppressed: async (fn) => fn(),
      withLoadingTracked: async (fn) => fn(),
    }));
    vi.doMock("../ui/modules/telegram.js", () => ({
      cloudStorageGet: vi.fn().mockResolvedValue(null),
    }));

    const state = await import("../ui/modules/state.js");
    await state.loadExecutor();

    expect(state.executorData.value).toEqual({
      ok: true,
      data: {
        maxParallel: 5,
        activeSlots: 2,
        slots: [{ taskId: "task-1", status: "running" }],
        pollIntervalMs: 30000,
        taskTimeoutMs: 600000,
      },
      mode: "internal",
      paused: true,
    });
  });

  it("extracts friendly auth errors instead of surfacing raw JSON payloads", async () => {
    vi.doMock("../ui/modules/telegram.js", () => ({
      getInitData: () => "",
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({ ok: false, error: "Forbidden." }, 403))
      .mockResolvedValueOnce(makeJsonResponse({ ok: false, error: "Forbidden." }, 403));

    globalThis.fetch = fetchMock;

    const { apiFetch } = await import("../ui/modules/api.js");

    await expect(apiFetch("/api/config", { _silent: true })).rejects.toMatchObject({
      message: "Forbidden.",
      status: 403,
    });
  });

  it("keeps tab loaders on safe empty or retained state when session recovery fails", async () => {
    const apiFetch = vi.fn(() => Promise.reject(new Error("Unauthorized.")));

    vi.doMock("../ui/modules/api.js", () => ({
      apiFetch,
      onWsMessage: () => () => {},
      withLoadingSuppressed: async (fn) => fn(),
      withLoadingTracked: async (fn) => fn(),
    }));
    vi.doMock("../ui/modules/telegram.js", () => ({
      cloudStorageGet: vi.fn().mockResolvedValue(null),
    }));

    const state = await import("../ui/modules/state.js");

    state.statusData.value = { ok: true, status: "healthy" };
    state.executorData.value = { paused: false };
    state.projectSummary.value = { repos: 3 };
    state.infraData.value = { nodes: 2 };
    state.logsData.value = { lines: ["cached"] };
    state.worktreeData.value = { data: [{ name: "wt-main" }], stats: { total: 1 } };
    state.sharedWorkspaces.value = [{ id: "shared-1" }];
    state.presenceInstances.value = [{ id: "agent-1" }];
    state.coordinatorInfo.value = { leader: "agent-1" };
    state.gitBranches.value = [{ name: "main" }];
    state.gitDiff.value = "cached diff";
    state.retryQueueData.value = { ok: true, items: [{ id: "retry-1" }], count: 1, stats: { queued: 1 } };
    state.agentLogFiles.value = ["agent.log"];
    state.agentLogFile.value = "agent.log";
    state.agentLogTail.value = { lines: ["cached tail"] };

    await state.loadStatus();
    await state.loadExecutor();
    await state.loadProjectSummary();
    await state.loadConfig();
    await state.loadWorktrees();
    await state.loadSharedWorkspaces();
    await state.loadPresence();
    await state.loadInfra();
    await state.loadLogs({ force: true });
    await state.loadGit();
    await state.loadAgentLogFileList();
    await state.loadAgentLogTailData({ force: true });
    await state.loadRetryQueue();
    state.tasksData.value = [];
    state.tasksTotal.value = 0;
    state.tasksTotalPages.value = 1;
    await state.loadTasks();

    expect(state.statusData.value).toEqual({ ok: true, status: "healthy" });
    expect(state.executorData.value).toEqual({ paused: false });
    expect(state.projectSummary.value).toEqual({ repos: 3 });
    expect(state.configData.value).toBe(null);
    expect(state.worktreeData.value).toEqual({ data: [{ name: "wt-main" }], stats: { total: 1 } });
    expect(state.sharedWorkspaces.value).toEqual([{ id: "shared-1" }]);
    expect(state.presenceInstances.value).toEqual([{ id: "agent-1" }]);
    expect(state.coordinatorInfo.value).toEqual({ leader: "agent-1" });
    expect(state.infraData.value).toEqual({ nodes: 2 });
    expect(state.logsData.value).toEqual({ lines: ["cached"] });
    expect(state.gitBranches.value).toEqual([{ name: "main" }]);
    expect(state.gitDiff.value).toBe("cached diff");
    expect(state.agentLogFiles.value).toEqual(["agent.log"]);
    expect(state.agentLogTail.value).toEqual({ lines: ["cached tail"] });
    expect(state.retryQueueData.value).toEqual(
      expect.objectContaining({ count: 1, items: [{ id: "retry-1" }] }),
    );
    expect(state.tasksData.value).toEqual([]);
    expect(state.tasksTotal.value).toBe(0);
    expect(state.tasksTotalPages.value).toBe(1);
    expect(state.tasksLoaded.value).toBe(true);
    expect(apiFetch).toHaveBeenCalled();
  });
});
