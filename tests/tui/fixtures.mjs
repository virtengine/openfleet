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
    files: [
      { filename: "src/app.mjs", additions: 8, deletions: 2 },
      { filename: "tests/app.test.mjs", additions: 4, deletions: 0 },
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
    emit(event, payload) {
      for (const callback of listeners.get(event) || []) callback(payload);
    },
  };
}
