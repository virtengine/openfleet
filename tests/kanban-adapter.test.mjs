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
  const originalTaskLabelEnforce = process.env.OPENFLEET_ENFORCE_TASK_LABEL;

  beforeEach(() => {
    execFileMock.mockReset();
    vi.clearAllMocks();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
    process.env.GITHUB_PROJECT_MODE = "issues";
    process.env.OPENFLEET_ENFORCE_TASK_LABEL = "true";
    loadConfigMock.mockReturnValue({
      repoSlug: "acme/widgets",
      kanban: { backend: "github" },
    });
    setKanbanBackend("github");
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
      delete process.env.OPENFLEET_ENFORCE_TASK_LABEL;
    } else {
      process.env.OPENFLEET_ENFORCE_TASK_LABEL = originalTaskLabelEnforce;
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
    mockGh('{"name":"openfleet"}\n');
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
    expect(issueCreateCall[1]).toContain("openfleet");
    expect(issueCreateCall[1]).toContain("--assignee");
    expect(issueCreateCall[1]).toContain("acme");
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
          labels: [{ name: "openfleet" }],
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
    process.env.OPENFLEET_ENFORCE_TASK_LABEL = "false";
    setKanbanBackend("github");
    mockGh(
      JSON.stringify([
        {
          number: 10,
          title: "scoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "openfleet" }],
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
          body: `<!-- openfleet-state
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
    const result = await adapter.addComment("42", "test body");
    expect(result).toBe(false);
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
                labels: ["openfleet"],
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
              labels: ["openfleet"],
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
              labels: ["openfleet"],
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
                body: `<!-- openfleet-state
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
    tempDir = mkdtempSync(resolve(tmpdir(), "openfleet-internal-kanban-"));
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
