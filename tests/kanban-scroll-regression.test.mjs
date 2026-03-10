import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBoardFilterStorageKey,
  persistBoardFilters,
  readPersistedBoardFilters,
  sanitizeBoardFilters,
} from "../ui/components/kanban-board.js";

const boardSource = readFileSync(
  resolve(process.cwd(), "ui/components/kanban-board.js"),
  "utf8",
);
const cssSource = readFileSync(
  resolve(process.cwd(), "ui/styles/kanban.css"),
  "utf8",
);

describe("kanban scroll regression guards", () => {
  it("keeps multiple load-more triggers for per-column pagination", () => {
    expect(boardSource).toMatch(/IntersectionObserver/);
    expect(boardSource).toMatch(/useLayoutEffect/);
    expect(boardSource).toMatch(/onScroll=\$\{onCardsScroll\}/);
    expect(boardSource).toMatch(/onWheel=\$\{onCardsWheel\}/);
    expect(boardSource).toMatch(/class="kanban-load-more"/);
  });

  it("keeps the manual load-more affordance outside the scroll body", () => {
    const cardsIndex = boardSource.indexOf('class="kanban-cards"');
    const sentinelIndex = boardSource.indexOf('class="kanban-tail-sentinel"');
    const footerIndex = boardSource.indexOf('class="kanban-column-footer"');
    expect(cardsIndex).toBeGreaterThan(-1);
    expect(sentinelIndex).toBeGreaterThan(cardsIndex);
    expect(footerIndex).toBeGreaterThan(sentinelIndex);
  });

  it("keeps columns as bounded independent scroll lanes", () => {
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*overflow: hidden;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*overflow-y: auto;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*touch-action: pan-y;/);
    expect(cssSource).toMatch(/\.kanban-column-footer \{[\s\S]*position: sticky;/);
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*height: clamp\(/);
  });
});

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

describe("kanban board filter persistence", () => {
  it("persists and rehydrates board filters for refresh in the same workspace", () => {
    const storage = new MemoryStorage();
    const filters = {
      repo: "repo-alpha",
      assignee: "agent-1",
      priority: "high",
      search: "bugfix",
    };
    const ok = persistBoardFilters({
      storage,
      workspaceId: "ws-alpha",
      filters,
    });

    expect(ok).toBe(true);
    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual(filters);
  });

  it("keeps filter state isolated across workspace switches", () => {
    const storage = new MemoryStorage();
    persistBoardFilters({
      storage,
      workspaceId: "ws-alpha",
      filters: { repo: "repo-alpha", assignee: "", priority: "", search: "" },
    });
    persistBoardFilters({
      storage,
      workspaceId: "ws-beta",
      filters: { repo: "repo-beta", assignee: "agent-2", priority: "medium", search: "triage" },
    });

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual({
      repo: "repo-alpha",
      assignee: "",
      priority: "",
      search: "",
    });
    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-beta" })).toEqual({
      repo: "repo-beta",
      assignee: "agent-2",
      priority: "medium",
      search: "triage",
    });
  });

  it("falls back to safe defaults for stale schema payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem(buildBoardFilterStorageKey("ws-stale"), JSON.stringify({
      version: 0,
      filters: { repo: "legacy", assignee: "legacy", priority: "high", search: "legacy" },
    }));

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-stale" })).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "",
    });
  });

  it("sanitizes invalid and stale filter values during mutation validation", () => {
    const sanitized = sanitizeBoardFilters(
      {
        repo: "repo-missing",
        assignee: "agent-missing",
        priority: "urgent",
        search: "  escaped  ",
      },
      {
        allowedRepos: new Set(["repo-live"]),
        allowedAssignees: new Set(["agent-live"]),
      },
    );

    expect(sanitized).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "escaped",
    });
  });
});
