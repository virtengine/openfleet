export const monitorStatsFixture = {
  uptimeMs: 90_000,
  runtimeMs: 45_000,
  totalCostUsd: 12.5,
  totalSessions: 4,
  activeSessions: 1,
  totalTasks: 3,
  activeTasks: 1,
  completedTasks: 1,
  failedTasks: 1,
  workflows: { active: ["wf-1"], total: 3 },
  agents: { online: 2, total: 4 },
  retryQueue: {
    count: 1,
    items: [
      {
        taskId: "task-7",
        taskTitle: "Retry flaky test",
        retryCount: 2,
        nextRetryAt: "2026-03-23T00:00:02.000Z",
        lastError: "timeout",
      },
    ],
  },
  cpu: { usage: 17.4 },
  memory: { used: 256 * 1024 * 1024, total: 1024 * 1024 * 1024 },
  tokensIn: 12_300,
  tokensOut: 4_560,
  tokensTotal: 16_860,
};

export const sessionsFixture = [
  {
    id: "session-active-1",
    status: "active",
    title: "Investigate failing build",
    taskId: "task-1",
    createdAt: "2026-03-23T00:00:00.000Z",
    lastActiveAt: "2026-03-23T00:00:30.000Z",
    turnCount: 3,
    elapsedMs: 30_000,
    lastMessage: "Applied the first fix candidate",
    metadata: { pid: 4120, workspaceId: "ws-1", workspaceDir: "/tmp/ws-1", model: "gpt-5.4", agent: "primary" },
    insights: { contextWindow: { usedTokens: 2300, totalTokens: 32000 } },
  },
  {
    id: "session-done-2",
    status: "completed",
    title: "Merge cleanup",
    taskId: "task-2",
    createdAt: "2026-03-23T00:00:00.000Z",
    lastActiveAt: "2026-03-23T00:00:20.000Z",
    turnCount: 6,
    elapsedMs: 20_000,
    metadata: { pid: 5120 },
  },
];

export const tasksFixture = [
  { id: "task-1", title: "Fix CI failure", status: "todo" },
  { id: "task-2", title: "Review PR #404", status: "inprogress" },
  { id: "task-3", title: "Ship release notes", status: "done" },
];

export const sessionDetailFixture = {
  ok: true,
  session: {
    ...sessionsFixture[0],
    branch: "task/cfd631a87666-feat-tui-session-detail-modal-full-session-drill",
    provider: "openai",
    model: "gpt-5.4",
    tokensIn: 2300,
    tokensOut: 1100,
    runtimeMs: 30000,
    turns: Array.from({ length: 18 }, (_, index) => ({
      id: `turn-${index + 1}`,
      number: index + 1,
      timestamp: `2026-03-23T00:00:${String(index).padStart(2, "0")}.000Z`,
      tokenDelta: 50 + index,
      durationMs: 1000 + (index * 250),
      lastToolCall: index % 2 === 0 ? "shell.exec" : "assistant.message",
    })),
    messages: [
      { timestamp: "2026-03-23T00:00:00.000Z", role: "user", content: "Start debugging" },
      { timestamp: "2026-03-23T00:00:05.000Z", role: "assistant", content: "Loaded the relevant logs" },
    ],
  },
};

export const sessionDiffFixture = {
  ok: true,
  summary: "2 files changed",
  diff: {
    formatted: [
      "diff --git a/src/app.mjs b/src/app.mjs",
      "--- a/src/app.mjs",
      "+++ b/src/app.mjs",
      ...Array.from({ length: 45 }, (_, index) => index % 3 === 0 ? `+added line ${index}` : index % 3 === 1 ? `-removed line ${index}` : ` context line ${index}`),
    ].join("\\n"),
    files: [
      { filename: "src/app.mjs", additions: 8, deletions: 2, patch: "+added line\n-removed line\n context" },
      { filename: "tests/app.test.mjs", additions: 4, deletions: 0, patch: "+test line" },
    ],
  },
};

export const FIXTURE_STATS = {
  ...monitorStatsFixture,
  tokensIn: 1234,
  tokensOut: 5678,
  tokensTotal: 6912,
};

export const FIXTURE_SESSIONS = [
  {
    ...sessionsFixture[0],
    title: "Synthesized failing smoke test",
  },
  ...sessionsFixture.slice(1),
];

export const FIXTURE_TASKS = [
  { id: "task-1", title: "Fix CI failure", status: "todo" },
  { id: "task-2", title: "Review PR #404", status: "inprogress" },
  { id: "task-3", title: "Ship release notes", status: "done" },
  { id: "task-4", title: "Triage websocket bridge", status: "blocked" },
  { id: "task-5", title: "Ship smoke test", status: "done" },
];

export const tuiConfigFixture = {
  ok: true,
  meta: {
    configPath: "/tmp/bosun.config.json",
  },
  sections: [
    {
      id: "general",
      label: "General",
      items: [
        {
          kind: "field",
          id: "projectName",
          path: "projectName",
          depth: 0,
          label: "projectName",
          valueText: "Bosun Demo",
          sourceLabel: "from config",
          description: "Display name",
          editorKind: "string",
          readOnly: false,
          masked: false,
          enumValues: [],
        },
      ],
    },
    {
      id: "kanban",
      label: "Kanban",
      items: [
        {
          kind: "group",
          id: "group:kanban",
          path: "kanban",
          depth: 0,
          label: "kanban",
        },
        {
          kind: "field",
          id: "kanban.backend",
          path: "kanban.backend",
          depth: 1,
          label: "backend",
          valueText: "github",
          sourceLabel: "from config",
          description: "Backend",
          editorKind: "enum",
          readOnly: false,
          masked: false,
          enumValues: ["internal", "github", "jira", "gnap"],
        },
      ],
    },
  ],
};

export function createMockWsClient() {
  const listeners = new Map();
  return {
    host: "127.0.0.1",
    port: 3080,
    connectCalled: 0,
    disconnectCalled: 0,
    connect() {
      this.connectCalled += 1;
    },
    disconnect() {
      this.disconnectCalled += 1;
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback);
    },
    async getConfigTree() {
      return tuiConfigFixture;
    },
    async saveConfigField(path, value) {
      const target = tuiConfigFixture.sections
        .flatMap((section) => section.items)
        .find((item) => item.path === path);
      if (target) {
        target.valueText = String(value);
      }
      return { ok: true, path };
    },
    emit(event, payload) {
      for (const callback of listeners.get(event) || []) callback(payload);
    },
  };
}

