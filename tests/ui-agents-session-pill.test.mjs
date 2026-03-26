import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import htm from "htm";

const html = htm.bind(h);

vi.mock("../ui/modules/telegram.js", () => ({
  haptic: vi.fn(),
  showConfirm: vi.fn(),
}));

vi.mock("../ui/modules/api.js", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ data: [] })),
  sendCommandToChat: vi.fn(),
}));

vi.mock("../ui/modules/state.js", async () => {
  const actual = await vi.importActual("../ui/modules/state.js");
  return {
    ...actual,
    executorData: {
      value: {
        data: {
          slots: [
            {
              taskId: "task-1",
              taskTitle: "Agent task",
              branch: "feature/test",
              status: "busy",
              sessionId: "12345678-1234-1234-1234-1234567890ab",
              startedAt: "2026-03-21T00:00:00.000Z",
            },
          ],
        },
      },
    },
    showToast: vi.fn(),
    scheduleRefresh: vi.fn(),
    refreshTab: vi.fn(),
  };
});

vi.mock("../ui/components/session-list.js", () => ({
  loadSessions: vi.fn(),
  loadSessionMessages: vi.fn(),
  selectedSessionId: { value: null },
  sessionsData: {
    value: [
      {
        id: "12345678-1234-1234-1234-1234567890ab",
        taskId: "task-1",
        title: "Agent task",
        branch: "feature/test",
        status: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:00:10.000Z",
      },
    ],
  },
  sessionMessages: { value: [] },
  sessionMessagesSessionId: { value: null },
}));

vi.mock("../ui/components/chat-view.js", () => ({ ChatView: () => html`<div />` }));
vi.mock("../ui/components/diff-viewer.js", () => ({ DiffViewer: () => html`<div />` }));

describe("agents session ID pill", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("copies the full session id and clears copied state after animation end", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue();
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: clipboardWrite } },
      configurable: true,
    });

    const mod = await import("../ui/tabs/agents.js");
    const FleetSessionsTab = mod.FleetSessionsTab;
    const { findByRole } = render(html`<${FleetSessionsTab} />`);
    const pill = await findByRole("button", { name: /copy session id 12345678-1234-1234-1234-1234567890ab/i });

    await fireEvent.click(pill);
    expect(clipboardWrite).toHaveBeenCalledWith("12345678-1234-1234-1234-1234567890ab");
    expect(pill.getAttribute("data-copied")).toBe("true");

    fireEvent.animationEnd(pill);
    expect(pill.getAttribute("data-copied")).toBe("false");
  });
});
