import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockTaskStore = vi.hoisted(() => ({
  getTask: vi.fn(),
  getAllTasks: vi.fn(() => []),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  getDirtyTasks: vi.fn(() => []),
  markSynced: vi.fn(),
  upsertFromExternal: vi.fn(),
  setTaskStatus: vi.fn(),
  removeTask: vi.fn(),
}));

const mockKanban = vi.hoisted(() => ({
  getKanbanAdapter: vi.fn(),
  getKanbanBackendName: vi.fn(() => "vk"),
  listTasks: vi.fn(() => Promise.resolve([])),
  updateTaskStatus: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../task-store.mjs", () => mockTaskStore);
vi.mock("../kanban-adapter.mjs", () => mockKanban);

const { SyncEngine } = await import("../sync-engine.mjs");

const ORIGINAL_SYNC_POLICY = process.env.KANBAN_SYNC_POLICY;

beforeEach(() => {
  process.env.KANBAN_SYNC_POLICY = "bidirectional";
});

afterEach(() => {
  if (ORIGINAL_SYNC_POLICY === undefined) {
    delete process.env.KANBAN_SYNC_POLICY;
  } else {
    process.env.KANBAN_SYNC_POLICY = ORIGINAL_SYNC_POLICY;
  }
});

describe("sync-engine backward external status handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
  });

  it("re-pushes backward move when internal equals old external status", async () => {
    // When internal is at the same rank as oldExternal, the code treats the
    // backward move as VK state loss and marks dirty for re-push.
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-1",
        projectId: "proj-1",
        status: "inprogress",
        externalStatus: "inprogress",
        syncDirty: false,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-1", status: "todo", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).not.toHaveBeenCalled();
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith("task-1", {
      externalStatus: "todo",
      syncDirty: true,
    });
    expect(result.pulled).toBe(0);
  });

  it("re-pushes external backward move when internal task is dirty", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-2",
        projectId: "proj-1",
        status: "inprogress",
        externalStatus: "inprogress",
        syncDirty: true,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-2", status: "todo", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).not.toHaveBeenCalled();
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith("task-2", {
      externalStatus: "todo",
      syncDirty: true,
    });
    expect(result.pulled).toBe(0);
  });

  it("preserves internal status under internal-primary sync policy", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-keep-internal",
        projectId: "proj-1",
        status: "inreview",
        externalStatus: "inprogress",
        syncDirty: false,
        meta: {},
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-keep-internal", status: "done", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({
      projectId: "proj-1",
      syncPolicy: "internal-primary",
    });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).not.toHaveBeenCalled();
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith(
      "task-keep-internal",
      expect.objectContaining({
        externalStatus: "done",
      }),
    );
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith(
      "task-keep-internal",
    );
    expect(result.pulled).toBe(0);
  });

  it("does not cancel internal tasks deleted externally under internal-primary policy", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-survives",
        projectId: "proj-1",
        status: "todo",
        externalStatus: "todo",
        syncDirty: false,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([]);

    const engine = new SyncEngine({
      projectId: "proj-1",
      syncPolicy: "internal-primary",
    });
    await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).not.toHaveBeenCalledWith(
      "task-survives",
      "cancelled",
      "external",
    );
  });
});

describe("sync-engine external status normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
  });

  it("normalizes external closed to cancelled and updates internal status", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-closed",
        projectId: "proj-1",
        status: "inprogress",
        externalStatus: "inprogress",
        syncDirty: false,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-closed", status: "closed", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).toHaveBeenCalledWith(
      "task-closed",
      "cancelled",
      "external",
    );
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith("task-closed", {
      externalStatus: "cancelled",
      syncDirty: false,
    });
    expect(result.pulled).toBe(1);
  });

  it("normalizes external merged to done and updates internal status", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-merged",
        projectId: "proj-1",
        status: "inreview",
        externalStatus: "inreview",
        syncDirty: false,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-merged", status: "merged", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).toHaveBeenCalledWith(
      "task-merged",
      "done",
      "external",
    );
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith("task-merged", {
      externalStatus: "done",
      syncDirty: false,
    });
    expect(result.pulled).toBe(1);
  });

  it("normalizes mixed-case and spacing/hyphen variants", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([
      {
        id: "task-normalized",
        projectId: "proj-1",
        status: "todo",
        externalStatus: "todo",
        syncDirty: false,
      },
    ]);
    mockKanban.listTasks.mockResolvedValue([
      { id: "task-normalized", status: "In-Review", projectId: "proj-1" },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pullFromExternal();

    expect(mockTaskStore.setTaskStatus).toHaveBeenCalledWith(
      "task-normalized",
      "inreview",
      "external",
    );
    expect(mockTaskStore.updateTask).toHaveBeenCalledWith("task-normalized", {
      externalStatus: "inreview",
      syncDirty: false,
    });
    expect(result.pulled).toBe(1);
  });
});

describe("sync-engine push 404 orphan handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
  });

  it("removes orphaned task from internal store on 404 push error", async () => {
    mockTaskStore.getDirtyTasks.mockReturnValue([
      { id: "orphan-1", status: "inprogress", syncDirty: true },
    ]);
    mockKanban.updateTaskStatus.mockRejectedValue(
      new Error("VK API PUT /api/tasks/orphan-1 failed: 404"),
    );

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    expect(mockTaskStore.removeTask).toHaveBeenCalledWith("orphan-1");
    expect(mockTaskStore.markSynced).not.toHaveBeenCalled();
    expect(result.pushed).toBe(0);
    // 404 is handled gracefully, should not appear in errors
    expect(result.errors.length).toBe(0);
  });

  it("does not remove task on non-404 push errors", async () => {
    mockTaskStore.getDirtyTasks.mockReturnValue([
      { id: "task-x", status: "inprogress", syncDirty: true },
    ]);
    mockKanban.updateTaskStatus.mockRejectedValue(
      new Error("VK API PUT /api/tasks/task-x failed: 500"),
    );

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    expect(mockTaskStore.removeTask).not.toHaveBeenCalled();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("500");
  });
});

describe("sync-engine UUID-to-GitHub ID mismatch handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
  });

  it("skips UUID tasks when backend is github", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    mockTaskStore.getDirtyTasks.mockReturnValue([
      {
        id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
        status: "cancelled",
        syncDirty: true,
      },
      {
        id: "ab411a51-5428-4075-a47d-9f208c7421eb",
        status: "done",
        syncDirty: true,
      },
    ]);

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    // UUID tasks should be skipped, not pushed
    expect(mockKanban.updateTaskStatus).not.toHaveBeenCalled();
    // They should be marked as synced to clear the dirty flag
    expect(mockTaskStore.markSynced).toHaveBeenCalledTimes(2);
    expect(result.pushed).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("pushes numeric ID tasks when backend is github", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    mockTaskStore.getDirtyTasks.mockReturnValue([
      { id: "42", status: "done", syncDirty: true },
    ]);
    mockKanban.updateTaskStatus.mockResolvedValue({});

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    expect(mockKanban.updateTaskStatus).toHaveBeenCalledWith("42", "done");
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith("42");
    expect(result.pushed).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it("pushes UUID tasks when backend is vk", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("vk");
    mockTaskStore.getDirtyTasks.mockReturnValue([
      {
        id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
        status: "inprogress",
        syncDirty: true,
      },
    ]);
    mockKanban.updateTaskStatus.mockResolvedValue({});

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    expect(mockKanban.updateTaskStatus).toHaveBeenCalledWith(
      "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
      "inprogress",
    );
    expect(result.pushed).toBe(1);
  });

  it("uses externalId over id when available for github push", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    mockTaskStore.getDirtyTasks.mockReturnValue([
      {
        id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
        externalId: "99",
        status: "done",
        syncDirty: true,
      },
    ]);
    mockKanban.updateTaskStatus.mockResolvedValue({});

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    // Should use externalId "99" instead of the UUID
    expect(mockKanban.updateTaskStatus).toHaveBeenCalledWith("99", "done");
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith(
      "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
    );
    expect(result.pushed).toBe(1);
  });

  it("handles invalid-id-format error gracefully as fallback", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    // Simulate a numeric-looking ID that somehow still fails with format error
    mockTaskStore.getDirtyTasks.mockReturnValue([
      { id: "123", status: "done", syncDirty: true },
    ]);
    mockKanban.updateTaskStatus.mockRejectedValue(
      new Error(
        'GitHub Issues: invalid issue number "123" — expected a numeric ID',
      ),
    );

    const engine = new SyncEngine({ projectId: "proj-1" });
    const result = await engine.pushToExternal();

    // Should be handled gracefully — no error in result
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith("123");
    expect(result.errors.length).toBe(0);
  });
});

describe("sync-engine syncTask backend ID handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
  });

  it("syncTask uses externalId for github backend", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    mockTaskStore.getTask.mockReturnValue({
      id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
      externalId: "151",
      status: "done",
      syncDirty: true,
    });
    mockKanban.updateTaskStatus.mockResolvedValue({});

    const engine = new SyncEngine({ projectId: "proj-1" });
    await engine.syncTask("28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e");

    expect(mockKanban.updateTaskStatus).toHaveBeenCalledWith("151", "done");
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith(
      "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
    );
  });

  it("syncTask skips incompatible IDs for github backend", async () => {
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    mockTaskStore.getTask.mockReturnValue({
      id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
      status: "inreview",
      syncDirty: true,
    });

    const engine = new SyncEngine({ projectId: "proj-1" });
    await engine.syncTask("28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e");

    expect(mockKanban.updateTaskStatus).not.toHaveBeenCalled();
    expect(mockTaskStore.markSynced).toHaveBeenCalledWith(
      "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
    );
  });
});

describe("sync-engine monitoring counters and alerts", () => {
  const originalRateLimitDelay = SyncEngine.RATE_LIMIT_DELAY_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKanban.getKanbanBackendName.mockReturnValue("github");
    SyncEngine.RATE_LIMIT_DELAY_MS = 0;
  });

  afterEach(() => {
    SyncEngine.RATE_LIMIT_DELAY_MS = originalRateLimitDelay;
  });

  it("increments success/failure metrics across full sync cycles", async () => {
    mockTaskStore.getAllTasks.mockReturnValue([]);
    mockKanban.listTasks.mockResolvedValue([]);
    mockTaskStore.getDirtyTasks.mockReturnValue([]);

    const engine = new SyncEngine({ projectId: "proj-1" });

    await engine.fullSync();
    let status = engine.getStatus();
    expect(status.metrics.syncSuccesses).toBe(1);
    expect(status.metrics.syncFailures).toBe(0);
    expect(status.metrics.lastSuccessAt).toBeTruthy();

    mockKanban.listTasks.mockRejectedValueOnce(new Error("list failed"));
    await engine.fullSync();
    status = engine.getStatus();
    expect(status.metrics.syncFailures).toBe(1);
    expect(status.metrics.lastFailureAt).toBeTruthy();
    expect(status.metrics.lastError).toContain("list failed");
  });

  it("tracks rate-limit usage and emits alert hook", async () => {
    const onAlert = vi.fn();
    mockTaskStore.getDirtyTasks.mockReturnValue([
      { id: "42", status: "inprogress", syncDirty: true },
    ]);
    mockKanban.updateTaskStatus
      .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
      .mockResolvedValueOnce({});

    const engine = new SyncEngine({
      projectId: "proj-1",
      onAlert,
      rateLimitAlertThreshold: 1,
    });

    const result = await engine.pushToExternal();
    const status = engine.getStatus();

    expect(result.pushed).toBe(1);
    expect(status.metrics.rateLimitEvents).toBe(1);
    expect(status.metrics.rateLimitRetrySuccesses).toBe(1);
    expect(status.metrics.alertsTriggered).toBeGreaterThanOrEqual(1);
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rate_limit" }),
    );
  });
});
