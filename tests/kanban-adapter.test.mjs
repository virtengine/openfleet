import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const fetchWithFallbackMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../config.mjs", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../fetch-runtime.mjs", () => ({
  fetchWithFallback: fetchWithFallbackMock,
}));


const {
  getKanbanAdapter,
  setKanbanBackend,
  getKanbanBackendName,
  listTasks: listKanbanTasks,
  getTask: getKanbanTask,
  updateTaskStatus: updateKanbanTaskStatus,
  updateTask: patchKanbanTask,
  createTask: createKanbanTask,
  deleteTask: deleteKanbanTask,
  addComment: addKanbanComment,
  persistSharedStateToIssue,
  readSharedStateFromIssue,
  markTaskIgnored,
  __resetGhRateLimitBackoffForTests,
  __resetProjectPayloadWarningStateForTests,
  __reloadProjectCommandBackoffStateForTests,
} = await import("../kanban-adapter.mjs");
const {
  configureTaskStore,
  loadStore,
  addTask,
  removeTask,
  getTask,
} = await import("../task-store.mjs");
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function mockGh(stdout, stderr = "") {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(null, { stdout, stderr });
  });
}

function mockGhError(error) {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(error);
  });
}

beforeEach(() => {
  fetchWithFallbackMock.mockImplementation((...args) => globalThis.fetch(...args));
});

describe("kanban-adapter github backend", () => {
  const originalRepo = process.env.GITHUB_REPOSITORY;
  const originalOwner = process.env.GITHUB_REPO_OWNER;
  const originalName = process.env.GITHUB_REPO_NAME;
  const originalProjectMode = process.env.GITHUB_PROJECT_MODE;
  const originalTaskLabelEnforce = process.env.BOSUN_ENFORCE_TASK_LABEL;
  const originalDefaultAssignee = process.env.GITHUB_DEFAULT_ASSIGNEE;

  beforeEach(() => {
    execFileMock.mockReset();
    vi.clearAllMocks();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
    delete process.env.GITHUB_DEFAULT_ASSIGNEE;
    process.env.GITHUB_PROJECT_MODE = "issues";
    process.env.BOSUN_ENFORCE_TASK_LABEL = "true";
    loadConfigMock.mockReturnValue({
      repoSlug: "acme/widgets",
      kanban: { backend: "github" },
    });
    setKanbanBackend("github");
    __resetGhRateLimitBackoffForTests();
    __resetProjectPayloadWarningStateForTests();
  });

  afterEach(() => {
    if (originalRepo === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepo;
    }
    if (originalOwner === undefined) {
      delete process.env.GITHUB_REPO_OWNER;
    } else {
      process.env.GITHUB_REPO_OWNER = originalOwner;
    }
    if (originalName === undefined) {
      delete process.env.GITHUB_REPO_NAME;
    } else {
      process.env.GITHUB_REPO_NAME = originalName;
    }
    if (originalProjectMode === undefined) {
      delete process.env.GITHUB_PROJECT_MODE;
    } else {
      process.env.GITHUB_PROJECT_MODE = originalProjectMode;
    }
    if (originalTaskLabelEnforce === undefined) {
      delete process.env.BOSUN_ENFORCE_TASK_LABEL;
    } else {
      process.env.BOSUN_ENFORCE_TASK_LABEL = originalTaskLabelEnforce;
    }
    if (originalDefaultAssignee === undefined) {
      delete process.env.GITHUB_DEFAULT_ASSIGNEE;
    } else {
      process.env.GITHUB_DEFAULT_ASSIGNEE = originalDefaultAssignee;
    }
  });

  it("uses repo slug from config when owner/repo env vars are not set", async () => {
    mockGh("[]");
    const adapter = getKanbanAdapter();
    await adapter.listTasks("ignored-project-id", { status: "todo", limit: 5 });

    const call = execFileMock.mock.calls[0];
    expect(call).toBeTruthy();
    const args = call[1];
    expect(args).toContain("--repo");
    expect(args).toContain("acme/widgets");
  });

  it("uses default project backoff delays when GH delay env vars are blank", () => {
    const previous = {
      ownerRetry: process.env.GH_PROJECT_OWNER_RETRY_MS,
      commandBackoff: process.env.GH_PROJECT_COMMAND_BACKOFF_MS,
      modeFallback: process.env.GH_PROJECT_MODE_FALLBACK_MS,
      rateBackoff: process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS,
      rateWarn: process.env.GH_RATE_LIMIT_WARNING_THROTTLE_MS,
      rateRetry: process.env.GH_RATE_LIMIT_RETRY_MS,
      transientRetry: process.env.GH_TRANSIENT_RETRY_MS,
      defaultAssigneeRetry: process.env.GH_DEFAULT_ASSIGNEE_RETRY_MS,
    };

    process.env.GH_PROJECT_OWNER_RETRY_MS = "";
    process.env.GH_PROJECT_COMMAND_BACKOFF_MS = "";
    process.env.GH_PROJECT_MODE_FALLBACK_MS = "";
    process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = "";
    process.env.GH_RATE_LIMIT_WARNING_THROTTLE_MS = "";
    process.env.GH_RATE_LIMIT_RETRY_MS = "";
    process.env.GH_TRANSIENT_RETRY_MS = "";
    process.env.GH_DEFAULT_ASSIGNEE_RETRY_MS = "";

    try {
      setKanbanBackend("github");
      const adapter = getKanbanAdapter();
      expect(adapter._projectOwnerRetryDelayMs).toBe(300_000);
      expect(adapter._projectCommandBackoffMs).toBe(60_000);
      expect(adapter._projectModeFallbackMs).toBe(180_000);
      expect(adapter._projectRateLimitBackoffMs).toBe(300_000);
      expect(adapter._rateLimitWarningThrottleMs).toBe(60_000);
      expect(adapter._rateLimitRetryDelayMs).toBe(60_000);
      expect(adapter._transientRetryDelayMs).toBe(2_000);
      expect(adapter._defaultAssigneeRetryDelayMs).toBe(300_000);
    } finally {
      if (previous.ownerRetry === undefined) {
        delete process.env.GH_PROJECT_OWNER_RETRY_MS;
      } else {
        process.env.GH_PROJECT_OWNER_RETRY_MS = previous.ownerRetry;
      }
      if (previous.commandBackoff === undefined) {
        delete process.env.GH_PROJECT_COMMAND_BACKOFF_MS;
      } else {
        process.env.GH_PROJECT_COMMAND_BACKOFF_MS = previous.commandBackoff;
      }
      if (previous.modeFallback === undefined) {
        delete process.env.GH_PROJECT_MODE_FALLBACK_MS;
      } else {
        process.env.GH_PROJECT_MODE_FALLBACK_MS = previous.modeFallback;
      }
      if (previous.rateBackoff === undefined) {
        delete process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS;
      } else {
        process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = previous.rateBackoff;
      }
      if (previous.rateWarn === undefined) {
        delete process.env.GH_RATE_LIMIT_WARNING_THROTTLE_MS;
      } else {
        process.env.GH_RATE_LIMIT_WARNING_THROTTLE_MS = previous.rateWarn;
      }
      if (previous.rateRetry === undefined) {
        delete process.env.GH_RATE_LIMIT_RETRY_MS;
      } else {
        process.env.GH_RATE_LIMIT_RETRY_MS = previous.rateRetry;
      }
      if (previous.rateBackoffMax === undefined) {
        delete process.env.GH_RATE_LIMIT_BACKOFF_MAX_MS;
      } else {
        process.env.GH_RATE_LIMIT_BACKOFF_MAX_MS = previous.rateBackoffMax;
      }
      if (previous.transientRetry === undefined) {
        delete process.env.GH_TRANSIENT_RETRY_MS;
      } else {
        process.env.GH_TRANSIENT_RETRY_MS = previous.transientRetry;
      }
      if (previous.defaultAssigneeRetry === undefined) {
        delete process.env.GH_DEFAULT_ASSIGNEE_RETRY_MS;
      } else {
        process.env.GH_DEFAULT_ASSIGNEE_RETRY_MS = previous.defaultAssigneeRetry;
      }
      setKanbanBackend("github");
    }
  });

  it("handles non-JSON output for issue close and then fetches updated issue", async () => {
    mockGh("✓ Closed issue #42");
    mockGh(
      JSON.stringify({
        number: 42,
        title: "example",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.updateTaskStatus("42", "cancelled");

    expect(task?.id).toBe("42");
    expect(task?.status).toBe("done");

    const closeCallArgs = execFileMock.mock.calls[0][1];
    expect(closeCallArgs).toContain("close");
    expect(closeCallArgs).toContain("--reason");
    expect(closeCallArgs).toContain("not planned");
  });

  it("creates issue from URL output and resolves it via issue view", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "alice";
    mockGh("ok");
    mockGh("https://github.com/acme/widgets/issues/55\n");
    mockGh(
      JSON.stringify({
        number: 55,
        title: "new task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/55",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask("ignored-project-id", {
      title: "new task",
      description: "desc",
    });

    expect(task?.id).toBe("55");
    expect(task?.taskUrl).toBe("https://github.com/acme/widgets/issues/55");
    expect(getKanbanBackendName()).toBe("github");

    const issueCreateCall = execFileMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("create"),
    );
    expect(issueCreateCall).toBeTruthy();
    expect(issueCreateCall[1]).toContain("--label");
    expect(issueCreateCall[1]).toContain("bosun");
    expect(issueCreateCall[1]).toContain("--assignee");
    expect(issueCreateCall[1]).toContain("alice");
  });

  it("does not default assignee to repo owner when user resolution fails", async () => {
    mockGh("ok");
    mockGhError(new Error("gh auth status unavailable"));
    mockGhError(new Error("gh api unavailable"));
    mockGh("https://github.com/acme/widgets/issues/77\n");
    mockGh(
      JSON.stringify({
        number: 77,
        title: "new task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/77",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask("ignored-project-id", {
      title: "new task",
      description: "desc",
    });

    expect(task?.id).toBe("77");
    const issueCreateCall = execFileMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("create"),
    );
    expect(issueCreateCall).toBeTruthy();
    expect(issueCreateCall[1]).not.toContain("--assignee");
    expect(issueCreateCall[1]).not.toContain("acme");
  });

  it("uses gh auth status login as default assignee before calling gh api user", async () => {
    mockGh("ok");
    mockGh("Logged in to github.com as octocat (keyring)\n");
    mockGh("https://github.com/acme/widgets/issues/88\n");
    mockGh(
      JSON.stringify({
        number: 88,
        title: "new task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/88",
        labels: [],
        assignees: [{ login: "octocat" }],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask("ignored-project-id", {
      title: "new task",
      description: "desc",
    });

    expect(task?.id).toBe("88");
    const issueCreateCall = execFileMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("create"),
    );
    expect(issueCreateCall).toBeTruthy();
    expect(issueCreateCall[1]).toContain("--assignee");
    expect(issueCreateCall[1]).toContain("octocat");

    const authStatusCalls = execFileMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].join(" ").includes("auth status"),
    );
    const apiUserCalls = execFileMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].join(" ").includes("api user"),
    );
    expect(authStatusCalls).toHaveLength(1);
    expect(apiUserCalls).toHaveLength(0);
  });
  it("filters listTasks to codex-scoped labels when enforcement is enabled", async () => {
    mockGh(
      JSON.stringify([
        {
          number: 10,
          title: "scoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "bosun" }],
          assignees: [],
        },
        {
          number: 11,
          title: "unscoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/11",
          labels: [{ name: "bug" }],
          assignees: [],
        },
      ]),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("ignored-project-id", {
      status: "todo",
      limit: 25,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("10");
  });

  it("does not filter by codex labels when enforcement is disabled", async () => {
    process.env.BOSUN_ENFORCE_TASK_LABEL = "false";
    setKanbanBackend("github");
    mockGh(
      JSON.stringify([
        {
          number: 10,
          title: "scoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "bosun" }],
          assignees: [],
        },
        {
          number: 11,
          title: "unscoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/11",
          labels: [{ name: "bug" }],
          assignees: [],
        },
      ]),
    );
    mockGh("[]");
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("ignored-project-id", {
      status: "todo",
      limit: 25,
    });

    expect(tasks).toHaveLength(2);
  });

  it("normalizes wrapped project item-list payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(
      JSON.stringify({
        items: [
          {
            id: "PVTI_123",
            status: "Todo",
            content: {
              number: 101,
              title: "Wrapped task",
              body: "",
              state: "OPEN",
              url: "https://github.com/acme/widgets/issues/101",
              labels: [{ name: "bosun" }],
              assignees: [],
            },
          },
        ],
      }),
    );

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasksFromProject("5");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "101",
      title: "Wrapped task",
      status: "todo",
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("project item-list returned non-array"),
    );
    warnSpy.mockRestore();
  });

  it("normalizes object-map project item-list payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(
      JSON.stringify({
        items: {
          PVTI_123: {
            id: "PVTI_123",
            status: "Todo",
            content: {
              number: 101,
              title: "Mapped task",
              body: "",
              state: "OPEN",
              url: "https://github.com/acme/widgets/issues/101",
              labels: [{ name: "bosun" }],
              assignees: [],
            },
          },
        },
      }),
    );

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasksFromProject("5");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "101",
      title: "Mapped task",
      status: "todo",
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("project item-list returned non-array"),
    );
    warnSpy.mockRestore();
  });


  it("deduplicates concurrent project item-list fetches", async () => {
    mockGh(
      JSON.stringify([
        {
          id: "PVTI_123",
          status: "Todo",
          content: {
            number: 101,
            title: "Concurrent task",
            body: "",
            state: "OPEN",
            url: "https://github.com/acme/widgets/issues/101",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]),
    );

    const adapter = getKanbanAdapter();
    const [first, second, third] = await Promise.all([
      adapter.listTasksFromProject("concurrent-dedup-5"),
      adapter.listTasksFromProject("concurrent-dedup-5"),
      adapter.listTasksFromProject("concurrent-dedup-5"),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("retries project item-list without owner after owner-type failures", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ownerTypeError = new Error(
      "Command failed: gh project item-list 5 --owner acme --format json\nunknown owner type",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";
    mockGhError(ownerTypeError);
    mockGh(
      JSON.stringify([
        {
          id: "PVTI_123",
          status: "Todo",
          content: {
            number: 101,
            title: "Recovered task",
            body: "",
            state: "OPEN",
            url: "https://github.com/acme/widgets/issues/101",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]),
    );

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasksFromProject("5");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "101",
      title: "Recovered task",
      status: "todo",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    const firstArgs = execFileMock.mock.calls[0]?.[1] || [];
    const secondArgs = execFileMock.mock.calls[1]?.[1] || [];
    expect(firstArgs).toContain("--owner");
    expect(secondArgs).not.toContain("--owner");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("recovered project command without explicit owner"),
    );
    warnSpy.mockRestore();
  });

  it("retries without owner when owner-type signal is only in stderr", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ownerTypeError = new Error(
      "Command failed: gh project item-list 5 --owner acme --format json",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";
    mockGhError(ownerTypeError);
    mockGh(
      JSON.stringify([
        {
          id: "PVTI_123",
          status: "Todo",
          content: {
            number: 101,
            title: "Recovered from stderr-only owner error",
            body: "",
            state: "OPEN",
            url: "https://github.com/acme/widgets/issues/101",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]),
    );

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasksFromProject("5");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "101",
      title: "Recovered from stderr-only owner error",
      status: "todo",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    const firstArgs = execFileMock.mock.calls[0]?.[1] || [];
    const secondArgs = execFileMock.mock.calls[1]?.[1] || [];
    expect(firstArgs).toContain("--owner");
    expect(secondArgs).not.toContain("--owner");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("recovered project command without explicit owner"),
    );
    warnSpy.mockRestore();
  });

  it("uses owner retry backoff window after owner-type item-list failures", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ownerTypeError = new Error(
      "Command failed: gh project item-list owner-backoff-5 --owner acme --format json\nunknown owner type",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";

    mockGhError(ownerTypeError);
    mockGhError(ownerTypeError);

    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);

      const adapter = getKanbanAdapter();
      const first = await adapter.listTasksFromProject("owner-backoff-5");
      vi.setSystemTime(new Date(now.getTime() + 2 * 60 * 1000));
      const second = await adapter.listTasksFromProject("owner-backoff-5");

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to list tasks from project owner-backoff-5",
        ),
      );
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it("keeps owner retry backoff when ownerless fallback fails with a different error", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ownerTypeError = new Error(
      "Command failed: gh project item-list mixed-owner-backoff-5 --owner acme --format json\nunknown owner type",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";

    const ownerlessError = new Error(
      "Command failed: gh project item-list mixed-owner-backoff-5 --format json\nowner is required when not running interactively",
    );
    ownerlessError.stderr = "owner is required when not running interactively";
    ownerlessError.stdout = "";

    mockGhError(ownerTypeError);
    mockGhError(ownerlessError);

    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);

      const adapter = getKanbanAdapter();
      const first = await adapter.listTasksFromProject("mixed-owner-backoff-5");
      vi.setSystemTime(new Date(now.getTime() + 2 * 60 * 1000));
      const second = await adapter.listTasksFromProject("mixed-owner-backoff-5");

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to list tasks from project mixed-owner-backoff-5",
        ),
      );
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it("uses default command backoff when owner retry backoff is configured as zero", async () => {
    const prevOwnerRetryMs = process.env.GH_PROJECT_OWNER_RETRY_MS;
    const prevDefaultAssignee = process.env.GITHUB_DEFAULT_ASSIGNEE;
    process.env.GH_PROJECT_OWNER_RETRY_MS = "0";
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";

    const ownerTypeError = new Error(
      "Command failed: gh project item-list owner-zero-backoff-5 --owner acme --format json\nunknown owner type",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";

    mockGhError(ownerTypeError);
    mockGhError(ownerTypeError);

    try {
      const adapter = getKanbanAdapter();
      const first = await adapter.listTasksFromProject("owner-zero-backoff-5");
      const second = await adapter.listTasksFromProject("owner-zero-backoff-5");

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      if (prevOwnerRetryMs === undefined) {
        delete process.env.GH_PROJECT_OWNER_RETRY_MS;
      } else {
        process.env.GH_PROJECT_OWNER_RETRY_MS = prevOwnerRetryMs;
      }
      if (prevDefaultAssignee === undefined) {
        delete process.env.GITHUB_DEFAULT_ASSIGNEE;
      } else {
        process.env.GITHUB_DEFAULT_ASSIGNEE = prevDefaultAssignee;
      }
    }
  });
  it("skips GH calls while project owner fallback is in cooldown", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);

      const adapter = getKanbanAdapter();
      adapter._invalidProjectOwners.add("acme");
      adapter._projectOwnerAllInvalidUntil = now.getTime() + 60_000;

      const tasks = await adapter.listTasksFromProject("owner-cooldown-5");

      expect(tasks).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("project owner fallback cooling down"),
      );
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it("treats empty object-map project item-list payloads as valid", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(
      JSON.stringify({
        items: {},
      }),
    );

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasksFromProject("5");

    expect(tasks).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("project item-list returned non-array"),
    );
    warnSpy.mockRestore();
  });

  it("throttles repeated project item-list shape warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(JSON.stringify({ unexpected: true }));
    mockGh(JSON.stringify({ unexpected: true }));

    const adapter = getKanbanAdapter();
    const first = await adapter.listTasksFromProject("throttle-5");
    const second = await adapter.listTasksFromProject("throttle-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);

    const warningCalls = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("project item-list returned non-array"));
    expect(warningCalls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("throttles repeated project item-list shape warnings across adapter recreation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(JSON.stringify({ unexpected: true }));
    mockGh(JSON.stringify({ unexpected: true }));

    const firstAdapter = getKanbanAdapter();
    const first = await firstAdapter.listTasksFromProject("throttle-shared-5");

    setKanbanBackend("github");
    const secondAdapter = getKanbanAdapter();
    const second = await secondAdapter.listTasksFromProject("throttle-shared-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);

    const warningCalls = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("project item-list returned non-array"));
    expect(warningCalls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("normalizes project-number keys for item-list backoff", async () => {
    mockGh(JSON.stringify({ unexpected: true }));

    const adapter = getKanbanAdapter();
    const first = await adapter.listTasksFromProject("normalize-key-5 ");
    const second = await adapter.listTasksFromProject("normalize-key-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("applies extended item-list backoff after project rate-limit failures", async () => {
    const prevRetryMs = process.env.GH_RATE_LIMIT_RETRY_MS;
    const prevProjectRateLimitBackoffMs = process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS;
    process.env.GH_RATE_LIMIT_RETRY_MS = "0";
    process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = "300000";

    const rateLimitError = new Error(
      "Command failed: gh project item-list rate-limit-backoff-5 --owner acme --format json\nGraphQL: API rate limit exceeded for user ID 9289791.",
    );
    rateLimitError.stderr = "GraphQL: API rate limit exceeded for user ID 9289791.";
    rateLimitError.stdout = "";

    mockGhError(rateLimitError);
    mockGhError(rateLimitError);

    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);

      const adapter = getKanbanAdapter();
      const first = await adapter.listTasksFromProject("rate-limit-backoff-5");
      vi.setSystemTime(new Date(now.getTime() + 2 * 60 * 1000));
      const second = await adapter.listTasksFromProject("rate-limit-backoff-5");

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      if (prevRetryMs === undefined) {
        delete process.env.GH_RATE_LIMIT_RETRY_MS;
      } else {
        process.env.GH_RATE_LIMIT_RETRY_MS = prevRetryMs;
      }
      if (prevProjectRateLimitBackoffMs === undefined) {
        delete process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS;
      } else {
        process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = prevProjectRateLimitBackoffMs;
      }
    }
  });

  it("falls back to default command backoff when project rate-limit backoff is zero", async () => {
    const prevRetryMs = process.env.GH_RATE_LIMIT_RETRY_MS;
    const prevProjectRateLimitBackoffMs = process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS;
    process.env.GH_RATE_LIMIT_RETRY_MS = "0";
    process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = "0";

    const rateLimitError = new Error(
      "Command failed: gh project item-list rate-limit-zero-backoff-5 --owner acme --format json\nGraphQL: API rate limit exceeded for user ID 9289791.",
    );
    rateLimitError.stderr = "GraphQL: API rate limit exceeded for user ID 9289791.";
    rateLimitError.stdout = "";

    mockGhError(rateLimitError);
    mockGhError(rateLimitError);

    try {
      const adapter = getKanbanAdapter();
      const first = await adapter.listTasksFromProject("rate-limit-zero-backoff-5");
      const second = await adapter.listTasksFromProject("rate-limit-zero-backoff-5");

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      if (prevRetryMs === undefined) {
        delete process.env.GH_RATE_LIMIT_RETRY_MS;
      } else {
        process.env.GH_RATE_LIMIT_RETRY_MS = prevRetryMs;
      }
      if (prevProjectRateLimitBackoffMs === undefined) {
        delete process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS;
      } else {
        process.env.GH_PROJECT_RATE_LIMIT_BACKOFF_MS = prevProjectRateLimitBackoffMs;
      }
    }
  });
  it("backs off repeated project item-list fetches after invalid payload", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(JSON.stringify({ unexpected: true }));

    const adapter = getKanbanAdapter();
    const first = await adapter.listTasksFromProject("backoff-5");
    const second = await adapter.listTasksFromProject("backoff-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const warningCalls = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("project item-list returned non-array"));
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it("shares project item-list backoff across adapter recreation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(JSON.stringify({ unexpected: true }));

    const firstAdapter = getKanbanAdapter();
    const first = await firstAdapter.listTasksFromProject("backoff-shared-5");

    setKanbanBackend("github");
    const secondAdapter = getKanbanAdapter();
    const second = await secondAdapter.listTasksFromProject("backoff-shared-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const warningCalls = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("project item-list returned non-array"));
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });
  it("reloads project item-list backoff state from disk cache", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(JSON.stringify({ unexpected: true }));

    const firstAdapter = getKanbanAdapter();
    const first = await firstAdapter.listTasksFromProject("backoff-persist-5");

    __reloadProjectCommandBackoffStateForTests();

    setKanbanBackend("github");
    const secondAdapter = getKanbanAdapter();
    const second = await secondAdapter.listTasksFromProject("backoff-persist-5");

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const warningCalls = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("project item-list returned non-array"));
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it("normalizes wrapped project field-list payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(
      JSON.stringify({
        fields: [
          {
            id: "PVTSSF_status",
            name: "Status",
            type: "SINGLE_SELECT",
            options: [{ id: "todo-id", name: "Todo" }],
          },
        ],
      }),
    );

    const adapter = getKanbanAdapter();
    const fields = await adapter._getProjectFields("5");

    expect(fields).toEqual({
      statusFieldId: "PVTSSF_status",
      statusOptions: [{ id: "todo-id", name: "Todo" }],
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("project field-list returned non-array"),
    );
    warnSpy.mockRestore();
  });
  it("normalizes GraphQL connection project field-list payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGh(
      JSON.stringify({
        data: {
          organization: {
            projectV2: {
              fields: {
                nodes: [
                  {
                    id: "PVTSSF_status",
                    name: "Status",
                    data_type: "SINGLE_SELECT",
                    options: [{ id: "todo-id", name: "Todo" }],
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const adapter = getKanbanAdapter();
    const fields = await adapter._getProjectFields("5");

    expect(fields).toEqual({
      statusFieldId: "PVTSSF_status",
      statusOptions: [{ id: "todo-id", name: "Todo" }],
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("project field-list returned non-array"),
    );
    warnSpy.mockRestore();
  });

  it("throttles repeated missing-status-field warnings per project", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prevThrottle = process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
    process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = "60000";

    try {
      setKanbanBackend("github");
      const adapter = getKanbanAdapter();
      const baseTime = Date.now();

      // First warning should emit
      adapter._warnMissingProjectStatusField("5", baseTime);
      // Second within throttle window should be suppressed
      adapter._warnMissingProjectStatusField("5", baseTime + 1000);
      // Third after throttle expires should emit again
      adapter._warnMissingProjectStatusField("5", baseTime + 70_000);

      const statusFieldWarnings = warnSpy.mock.calls
        .map((call) => String(call?.[0] || ""))
        .filter((line) => line.includes("cannot sync to project: no status field found"));
      expect(statusFieldWarnings).toHaveLength(2);
    } finally {
      if (prevThrottle === undefined) {
        delete process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
      } else {
        process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = prevThrottle;
      }
      warnSpy.mockRestore();
    }
  });

  it("does not throttle status-field warnings when throttle is zero", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prevThrottle = process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
    process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = "0";

    try {
      setKanbanBackend("github");
      const adapter = getKanbanAdapter();
      const baseTime = Date.now();

      adapter._warnMissingProjectStatusField("5", baseTime);
      adapter._warnMissingProjectStatusField("5", baseTime + 100);

      const statusFieldWarnings = warnSpy.mock.calls
        .map((call) => String(call?.[0] || ""))
        .filter((line) => line.includes("cannot sync to project: no status field found"));
      expect(statusFieldWarnings).toHaveLength(2);
    } finally {
      if (prevThrottle === undefined) {
        delete process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
      } else {
        process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = prevThrottle;
      }
      warnSpy.mockRestore();
    }
  });

  it("tracks status-field warnings independently per project number", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prevThrottle = process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
    process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = "60000";

    try {
      // Reset module-level map state by re-creating backend
      setKanbanBackend("github");
      const adapter = getKanbanAdapter();
      // Clear the shared map to avoid leaking state from prior tests
      adapter._projectStatusFieldWarningAt.clear();
      const baseTime = Date.now();

      adapter._warnMissingProjectStatusField("5", baseTime);
      adapter._warnMissingProjectStatusField("7", baseTime);
      // Repeat within throttle — should both be suppressed
      adapter._warnMissingProjectStatusField("5", baseTime + 1000);
      adapter._warnMissingProjectStatusField("7", baseTime + 1000);

      const statusFieldWarnings = warnSpy.mock.calls
        .map((call) => String(call?.[0] || ""))
        .filter((line) => line.includes("cannot sync to project: no status field found"));
      expect(statusFieldWarnings).toHaveLength(2);
    } finally {
      if (prevThrottle === undefined) {
        delete process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
      } else {
        process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = prevThrottle;
      }
      warnSpy.mockRestore();
    }
  });

  it("skips status-field warning when project number is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = getKanbanAdapter();
    adapter._warnMissingProjectStatusField("", Date.now());
    adapter._warnMissingProjectStatusField(null, Date.now());
    adapter._warnMissingProjectStatusField(undefined, Date.now());

    const statusFieldWarnings = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) => line.includes("cannot sync to project: no status field found"));
    expect(statusFieldWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("uses default status-field warning throttle when env var is blank", () => {
    const prevThrottle = process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
    process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = "";

    try {
      setKanbanBackend("github");
      const adapter = getKanbanAdapter();
      expect(adapter._projectStatusFieldWarningThrottleMs).toBe(300_000);
    } finally {
      if (prevThrottle === undefined) {
        delete process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS;
      } else {
        process.env.GH_PROJECT_STATUS_WARNING_THROTTLE_MS = prevThrottle;
      }
    }
  });

  it("persists invalid project owner state and reloads it across adapter instances", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.GITHUB_DEFAULT_ASSIGNEE = "acme";

    const ownerTypeError = new Error(
      "Command failed: gh project item-list persist-test-5 --owner acme --format json\nunknown owner type",
    );
    ownerTypeError.stderr = "unknown owner type";
    ownerTypeError.stdout = "";

    // First mock: owner try fails with owner-type error
    mockGhError(ownerTypeError);
    // Second mock: ownerless fallback also fails with owner-type error
    mockGhError(ownerTypeError);

    try {
      const adapter1 = getKanbanAdapter();
      await adapter1.listTasksFromProject("persist-test-5");

      // Verify owner "acme" was added to the invalid set
      expect(adapter1._invalidProjectOwners.has("acme")).toBe(true);

      // Create a fresh adapter — it should load persisted state and know acme is invalid
      setKanbanBackend("github");
      const adapter2 = getKanbanAdapter();
      expect(adapter2._invalidProjectOwners.has("acme")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("merges sibling-process invalid owner state on reload", () => {
    const adapter = getKanbanAdapter();
    // Directly mark an owner invalid and persist
    adapter._invalidProjectOwners.add("org-a");
    adapter._projectOwnerAllInvalidUntil = Date.now() + 300_000;
    adapter._persistInvalidOwnerState();

    // Create a fresh adapter — it should load persisted state
    setKanbanBackend("github");
    const adapter2 = getKanbanAdapter();
    expect(adapter2._invalidProjectOwners.has("org-a")).toBe(true);
    expect(adapter2._projectOwnerAllInvalidUntil).toBeGreaterThan(Date.now());

    // Simulate sibling adding another owner
    adapter2._invalidProjectOwners.add("org-b");
    adapter2._persistInvalidOwnerState();

    // Reload and verify merge
    adapter._reloadInvalidOwnerState();
    expect(adapter._invalidProjectOwners.has("org-a")).toBe(true);
    expect(adapter._invalidProjectOwners.has("org-b")).toBe(true);
  });

  it("reopens issue and syncs status labels for open-state transitions", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const joined = args.join(" ");
      if (joined.includes("issue reopen")) {
        cb(null, { stdout: "✓ Reopened issue #42", stderr: "" });
        return;
      }
      if (joined.includes("label create")) {
        cb(null, { stdout: "✓ Created label", stderr: "" });
        return;
      }
      if (joined.includes("issue edit")) {
        cb(null, { stdout: "✓ Edited labels", stderr: "" });
        return;
      }
      if (joined.includes("issue view")) {
        cb(
          null,
          {
            stdout: JSON.stringify({
              number: 42,
              title: "example",
              body: "",
              state: "open",
              url: "https://github.com/acme/widgets/issues/42",
              labels: [{ name: "inprogress" }],
              assignees: [],
            }),
            stderr: "",
          },
        );
        return;
      }
      if (args[0] === "api" && args[1]?.includes("/issues/42/comments")) {
        cb(null, { stdout: "[]", stderr: "" });
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    });

    const adapter = getKanbanAdapter();
    const task = await adapter.updateTaskStatus("42", "inprogress");

    expect(task?.id).toBe("42");
    expect(task?.status).toBe("inprogress");
    const callArgs = execFileMock.mock.calls.map((call) => call[1].join(" "));
    expect(callArgs.some((args) => args.includes("reopen"))).toBe(true);
    expect(
      callArgs.some(
        (args) => args.includes("--add-label") && args.includes("inprogress"),
      ),
    ).toBe(true);
    expect(callArgs.some((args) => args.includes("--remove-label"))).toBe(true);
  });

  it("persists, reads, and ignores shared state through issue labels/comments", async () => {
    mockGh(JSON.stringify({ labels: [{ name: "bug" }] }));
    mockGh("✓ Labels updated");
    mockGh(JSON.stringify([]));
    mockGh("ok");

    mockGh(
      JSON.stringify([
        {
          id: 1001,
          body: `<!-- bosun-state
{
  "ownerId": "workstation-a/agent-a",
  "attemptToken": "token-a",
  "attemptStarted": "2026-02-17T00:00:00.000Z",
  "heartbeat": "2026-02-17T00:01:00.000Z",
  "status": "working",
  "retryCount": 1
}
-->`,
        },
      ]),
    );

    mockGh("✓ Labels updated");
    mockGh("ok");

    const adapter = getKanbanAdapter();
    const state = {
      ownerId: "workstation-a/agent-a",
      attemptToken: "token-a",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "working",
      retryCount: 1,
    };

    const persisted = await adapter.persistSharedStateToIssue("42", state);
    expect(persisted).toBe(true);

    const loaded = await adapter.readSharedStateFromIssue("42");
    expect(loaded).toMatchObject(state);

    const ignored = await adapter.markTaskIgnored("42", "manual-only");
    expect(ignored).toBe(true);

    const editCalls = execFileMock.mock.calls.filter(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("edit"),
    );
    expect(editCalls.some((call) => call[1].includes("codex:working"))).toBe(
      true,
    );
    expect(editCalls.some((call) => call[1].includes("codex:ignore"))).toBe(
      true,
    );
  });

  it("returns false when shared state persistence exhausts retries", async () => {
    mockGhError(new Error("api down"));
    mockGhError(new Error("still down"));

    const adapter = getKanbanAdapter();
    const persisted = await adapter.persistSharedStateToIssue("42", {
      ownerId: "ws/agent",
      attemptToken: "token-b",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "claimed",
      retryCount: 0,
    });
    expect(persisted).toBe(false);
  });

  it("caches issue-comment 404 misses to avoid repeated gh calls", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notFoundError = new Error(
      "Command failed: gh api /repos/acme/widgets/issues/42/comments --jq .\ngh: Not Found (HTTP 404)",
    );
    notFoundError.stderr = "gh: Not Found (HTTP 404)";
    mockGhError(notFoundError);

    const adapter = getKanbanAdapter();
    const first = await adapter.readSharedStateFromIssue("42");
    const second = await adapter.readSharedStateFromIssue("42");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const warnings = warnSpy.mock.calls
      .map((call) => String(call?.[0] || ""))
      .filter((line) =>
        line.includes("issue #42 not found while fetching comments"),
      );
    expect(warnings).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("addComment posts a comment on a github issue", async () => {
    mockGh("ok");

    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("42", "Hello from CI");

    expect(result).toBe(true);
    const call = execFileMock.mock.calls[0];
    const args = call[1];
    expect(args).toContain("issue");
    expect(args).toContain("comment");
    expect(args).toContain("42");
    expect(args).toContain("--body");
    expect(args).toContain("Hello from CI");
  });

  it("addComment returns false for invalid issue number", async () => {
    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("not-a-number", "body");
    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("addComment returns false when body is empty", async () => {
    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("42", "");
    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("addComment returns false when gh CLI fails", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error("network error"), { stdout: "", stderr: "" });
    });

    const adapter = getKanbanAdapter();
    adapter._transientRetryMax = 0;
    const result = await adapter.addComment("42", "test body");
    expect(result).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("kanban-adapter vk backend fallback fetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      vkEndpointUrl: "http://127.0.0.1:54089",
      kanban: { backend: "vk" },
    });
    setKanbanBackend("vk");
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws a descriptive error for invalid fetch response objects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(undefined);

    const adapter = getKanbanAdapter();
    await expect(
      adapter.listTasks("proj-1", { status: "todo" }),
    ).rejects.toThrow(/invalid response object/);
  });

  it("accepts JSON payloads mislabeled as text/plain", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () =>
        JSON.stringify({
          data: [{ id: "task-1", title: "Task One", status: "todo" }],
        }),
    });

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("proj-1", { status: "todo" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      title: "Task One",
      status: "todo",
      backend: "vk",
    });
  });

  it("normalizes nested /api/projects payloads before mapping", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name) =>
          String(name || "").toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => ({
        data: {
          projects: [{ id: "proj-1", name: "Project One" }],
        },
      }),
    });

    const adapter = getKanbanAdapter();
    const projects = await adapter.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "proj-1",
      name: "Project One",
      backend: "vk",
    });
  });

  it("normalizes object-map /api/projects payloads before mapping", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name) =>
          String(name || "").toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => ({
        data: {
          projects: {
            first: { id: "proj-1", name: "Project One" },
            second: { id: "proj-2", title: "Project Two" },
          },
        },
      }),
    });

    const adapter = getKanbanAdapter();
    const projects = await adapter.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      id: "proj-1",
      name: "Project One",
      backend: "vk",
    });
    expect(projects[1]).toMatchObject({
      id: "proj-2",
      name: "Project Two",
      backend: "vk",
    });
  });
  it("normalizes nested /api/tasks payloads before mapping", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name) =>
          String(name || "").toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => ({
        data: {
          tasks: [{ id: "task-nested-1", title: "Nested Task", status: "todo" }],
        },
      }),
    });

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("proj-1", { status: "todo" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-nested-1",
      title: "Nested Task",
      status: "todo",
      backend: "vk",
    });
  });
});

describe("kanban-adapter jira backend", () => {
  const originalKanbanBackend = process.env.KANBAN_BACKEND;
  const originalJiraBaseUrl = process.env.JIRA_BASE_URL;
  const originalJiraToken = process.env.JIRA_API_TOKEN;
  const originalJiraEmail = process.env.JIRA_EMAIL;
  const originalProjectKey = process.env.JIRA_PROJECT_KEY;
  const originalIssueType = process.env.JIRA_ISSUE_TYPE;
  const originalEnforce = process.env.JIRA_ENFORCE_TASK_LABEL;
  const originalUseAdf = process.env.JIRA_USE_ADF_COMMENTS;

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      headers: {
        get: (name) =>
          String(name || "").toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KANBAN_BACKEND = "jira";
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_API_TOKEN = "token-1";
    process.env.JIRA_EMAIL = "bot@acme.dev";
    process.env.JIRA_PROJECT_KEY = "PROJ";
    process.env.JIRA_ISSUE_TYPE = "Task";
    process.env.JIRA_ENFORCE_TASK_LABEL = "true";
    process.env.JIRA_USE_ADF_COMMENTS = "false";
    delete process.env.JIRA_CUSTOM_FIELD_OWNER_ID;
    delete process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN;
    delete process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED;
    delete process.env.JIRA_CUSTOM_FIELD_HEARTBEAT;
    delete process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT;
    delete process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON;
    delete process.env.JIRA_CUSTOM_FIELD_SHARED_STATE;
    loadConfigMock.mockReturnValue({
      kanban: { backend: "jira" },
    });
    setKanbanBackend("jira");
  });

  afterEach(() => {
    if (originalKanbanBackend === undefined) {
      delete process.env.KANBAN_BACKEND;
    } else {
      process.env.KANBAN_BACKEND = originalKanbanBackend;
    }
    if (originalJiraBaseUrl === undefined) {
      delete process.env.JIRA_BASE_URL;
    } else {
      process.env.JIRA_BASE_URL = originalJiraBaseUrl;
    }
    if (originalJiraToken === undefined) {
      delete process.env.JIRA_API_TOKEN;
    } else {
      process.env.JIRA_API_TOKEN = originalJiraToken;
    }
    if (originalJiraEmail === undefined) {
      delete process.env.JIRA_EMAIL;
    } else {
      process.env.JIRA_EMAIL = originalJiraEmail;
    }
    if (originalProjectKey === undefined) {
      delete process.env.JIRA_PROJECT_KEY;
    } else {
      process.env.JIRA_PROJECT_KEY = originalProjectKey;
    }
    if (originalIssueType === undefined) {
      delete process.env.JIRA_ISSUE_TYPE;
    } else {
      process.env.JIRA_ISSUE_TYPE = originalIssueType;
    }
    if (originalEnforce === undefined) {
      delete process.env.JIRA_ENFORCE_TASK_LABEL;
    } else {
      process.env.JIRA_ENFORCE_TASK_LABEL = originalEnforce;
    }
    if (originalUseAdf === undefined) {
      delete process.env.JIRA_USE_ADF_COMMENTS;
    } else {
      process.env.JIRA_USE_ADF_COMMENTS = originalUseAdf;
    }
  });

  it("initializes jira adapter and tracks configured Jira credentials", async () => {
    fetchWithFallbackMock.mockResolvedValueOnce(jsonResponse({ values: [] }));
    const adapter = getKanbanAdapter();
    expect(getKanbanBackendName()).toBe("jira");
    expect(adapter.name).toBe("jira");
    expect(adapter._baseUrl).toBe("https://acme.atlassian.net");
    expect(adapter._token).toBe("token-1");
    expect(adapter._email).toBe("bot@acme.dev");
    await adapter.listProjects();
    expect(fetchWithFallbackMock).toHaveBeenCalled();
  });

  it("lists and filters tasks by jira status/labels/projectField", async () => {
    fetchWithFallbackMock
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "First",
                description: "desc",
                status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                labels: ["bosun"],
                priority: { name: "High" },
                project: { key: "PROJ" },
                customfield_10042: "alpha",
              },
            },
            {
              key: "PROJ-2",
              fields: {
                summary: "Second",
                description: "desc",
                status: { name: "To Do", statusCategory: { key: "new" } },
                labels: ["bug"],
                project: { key: "PROJ" },
                customfield_10042: "beta",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ comments: [] }));

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("PROJ", {
      status: "inprogress",
      projectField: { customfield_10042: "alpha" },
      limit: 20,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("PROJ-1");
    expect(tasks[0]?.status).toBe("inprogress");
  });

  it("updates jira task status via transitions and supports wrapper delegation", async () => {
    let transitioned = false;
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "GET" && text.includes("/issue/PROJ-9?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-9",
            fields: {
              summary: "Task",
              description: "body",
              status: transitioned
                ? { name: "In Progress", statusCategory: { key: "indeterminate" } }
                : { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-9/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-9/transitions")) {
        return Promise.resolve(
          jsonResponse({
            transitions: [
              {
                id: "31",
                to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
              },
            ],
          }),
        );
      }
      if (method === "POST" && text.includes("/issue/PROJ-9/transitions")) {
        transitioned = true;
        return Promise.resolve(jsonResponse(null, 204));
      }
      return Promise.resolve(jsonResponse({ comments: [] }));
    });

    const updated = await updateKanbanTaskStatus("PROJ-9", "inprogress");
    expect(updated.status).toBe("inprogress");
    const transitionCall = fetchWithFallbackMock.mock.calls.find((call) =>
      String(call[0]).includes("/transitions"),
    );
    expect(transitionCall).toBeTruthy();
  });

  it("creates, patches, comments, and marks ignored jira tasks", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "POST" && text.endsWith("/rest/api/3/issue")) {
        return Promise.resolve(jsonResponse({ key: "PROJ-77" }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-77?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-77",
            fields: {
              summary: "Renamed",
              description: "Updated",
              status: { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-77/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      if (method === "PUT" && text.includes("/issue/PROJ-77")) {
        return Promise.resolve(jsonResponse(null, 204));
      }
      if (method === "POST" && text.includes("/issue/PROJ-77/comment")) {
        return Promise.resolve(jsonResponse({ id: "9001" }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const adapter = getKanbanAdapter();
    const created = await createKanbanTask("PROJ", {
      title: "New task",
      description: "Body",
    });
    expect(created.id).toBe("PROJ-77");

    const patched = await patchKanbanTask("PROJ-77", {
      title: "Renamed",
      description: "Updated",
    });
    expect(patched.title).toBe("Renamed");

    const commented = await addKanbanComment("PROJ-77", "hello jira");
    expect(commented).toBe(true);

    const ignored = await markTaskIgnored("PROJ-77", "manual review");
    expect(ignored).toBe(true);
  });

  it("persists and reads shared state from Jira comments", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "PUT" && text.includes("/issue/PROJ-201")) {
        return Promise.resolve(jsonResponse(null, 204));
      }
      if (method === "GET" && text.includes("/issue/PROJ-201/comment")) {
        return Promise.resolve(
          jsonResponse({
            comments: [
              {
                id: "c1",
                body: `<!-- bosun-state
{
  "ownerId": "ws-2/agent-2",
  "attemptToken": "token-2",
  "attemptStarted": "2026-02-17T00:00:00.000Z",
  "heartbeat": "2026-02-17T00:01:00.000Z",
  "status": "claimed",
  "retryCount": 0
}
-->`,
              },
            ],
            total: 1,
          }),
        );
      }
      if (method === "POST" && text.includes("/issue/PROJ-201/comment")) {
        return Promise.resolve(jsonResponse({ id: "c1" }));
      }
      return Promise.resolve(jsonResponse({ comments: [] }));
    });

    const sharedState = {
      ownerId: "ws-2/agent-2",
      attemptToken: "token-2",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "claimed",
      retryCount: 0,
    };
    const persisted = await persistSharedStateToIssue("PROJ-201", sharedState);
    expect(persisted).toBe(true);
    const loaded = await readSharedStateFromIssue("PROJ-201");
    expect(loaded).toMatchObject(sharedState);
  });

  it("throws on invalid jira issue keys", async () => {
    await expect(getKanbanTask("not-a-key")).rejects.toThrow(/invalid issue key/);
    await expect(deleteKanbanTask("123")).rejects.toThrow(/invalid issue key/);
  });
});

describe("kanban-adapter internal backend", () => {
  const originalKanbanBackend = process.env.KANBAN_BACKEND;
  let tempDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(resolve(tmpdir(), "bosun-internal-kanban-"));
    configureTaskStore({ baseDir: tempDir });
    loadStore();
    process.env.KANBAN_BACKEND = "internal";
    loadConfigMock.mockReturnValue({
      kanban: { backend: "internal" },
    });
    setKanbanBackend("internal");
  });

  afterEach(() => {
    if (originalKanbanBackend === undefined) {
      delete process.env.KANBAN_BACKEND;
    } else {
      process.env.KANBAN_BACKEND = originalKanbanBackend;
    }
  });

  it("uses internal backend by default when configured", () => {
    expect(getKanbanBackendName()).toBe("internal");
  });

  it("creates, lists, updates, comments, and deletes internal tasks", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Internal task",
      description: "Local source-of-truth task",
      status: "todo",
    });
    expect(created.backend).toBe("internal");
    expect(created.id).toBeTruthy();

    const listed = await adapter.listTasks("internal", { status: "todo" });
    expect(listed.some((task) => task.id === created.id)).toBe(true);

    const updated = await adapter.updateTaskStatus(created.id, "inprogress");
    expect(updated.status).toBe("inprogress");

    const commented = await adapter.addComment(created.id, "review me");
    expect(commented).toBe(true);
    const fromStore = getTask(created.id);
    expect(Array.isArray(fromStore?.meta?.comments)).toBe(true);
    expect(fromStore.meta.comments.length).toBeGreaterThan(0);

    const deleted = await adapter.deleteTask(created.id);
    expect(deleted).toBe(true);
    expect(removeTask(created.id)).toBe(false);
  });
});



