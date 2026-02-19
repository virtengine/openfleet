/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Command Palette
 *  Global fuzzy search palette (Cmd+K / Ctrl+K)
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { ICONS } from "../modules/icons.js";
import { navigateTo, TAB_CONFIG } from "../modules/router.js";
import { sendCommandToChat } from "../modules/api.js";
import { executorData, refreshTab } from "../modules/state.js";
import { activeTab } from "../modules/router.js";

/* ═══════════════════════════════════════════════
 *  Palette Items
 * ═══════════════════════════════════════════════ */

const TAB_DESCRIPTIONS = {
  dashboard: "Overview, status, and metrics",
  tasks: "View and manage tasks",
  agents: "Monitor running agents",
  logs: "Application and agent logs",
  control: "Executor and system controls",
  settings: "Preferences and configuration",
  infra: "Infrastructure and worktrees",
};

function buildNavigationItems() {
  return TAB_CONFIG.map((tab, i) => ({
    id: `nav-${tab.id}`,
    category: "Navigation",
    title: tab.label,
    description: TAB_DESCRIPTIONS[tab.id] || "",
    hint: String(i + 1),
    icon: tab.icon,
    action: () => navigateTo(tab.id),
  }));
}

const COMMAND_ITEMS = [
  {
    id: "cmd-status",
    category: "Commands",
    title: "/status",
    description: "Check orchestrator status",
    action: () => sendCommandToChat("/status"),
  },
  {
    id: "cmd-health",
    category: "Commands",
    title: "/health",
    description: "Health check",
    action: () => sendCommandToChat("/health"),
  },
  {
    id: "cmd-plan",
    category: "Commands",
    title: "/plan",
    description: "Generate plan",
    action: () => sendCommandToChat("/plan"),
  },
  {
    id: "cmd-logs",
    category: "Commands",
    title: "/logs 50",
    description: "View recent logs",
    action: () => sendCommandToChat("/logs 50"),
  },
  {
    id: "cmd-menu",
    category: "Commands",
    title: "/menu",
    description: "Show menu",
    action: () => sendCommandToChat("/menu"),
  },
  {
    id: "cmd-helpfull",
    category: "Commands",
    title: "/helpfull",
    description: "Full help",
    action: () => sendCommandToChat("/helpfull"),
  },
];

function buildQuickActions() {
  const paused = executorData.value?.paused;
  return [
    {
      id: "qa-new-task",
      category: "Quick Actions",
      title: "Create Task",
      description: "Open task creation",
      action: () => {
        navigateTo("tasks");
        // Dispatch event for task creation UI
        globalThis.dispatchEvent(new CustomEvent("ve:create-task"));
      },
    },
    {
      id: "qa-toggle-executor",
      category: "Quick Actions",
      title: paused ? "Resume Executor" : "Pause Executor",
      description: paused
        ? "Resume task processing"
        : "Stop processing new tasks",
      action: () => {
        const cmd = paused ? "/resume" : "/pause";
        sendCommandToChat(cmd);
      },
    },
    {
      id: "qa-refresh",
      category: "Quick Actions",
      title: "Refresh Data",
      description: "Force refresh current tab",
      action: () => refreshTab(activeTab.value),
    },
  ];
}

/* ═══════════════════════════════════════════════
 *  Fuzzy Matching
 * ═══════════════════════════════════════════════ */

/**
 * Score a query against text. Higher = better match.
 * Returns { score, indices } or null if no match.
 */
function fuzzyMatch(query, text) {
  if (!query) return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact prefix match — highest score
  if (t.startsWith(q)) {
    const indices = [];
    for (let i = 0; i < q.length; i++) indices.push(i);
    return { score: 100, indices };
  }

  // Word-start match
  const words = t.split(/[\s/\-_]+/);
  let wordStartIndices = [];
  let wordPos = 0;
  let qi = 0;
  for (const word of words) {
    const startIdx = t.indexOf(word, wordPos);
    if (qi < q.length && word.startsWith(q[qi])) {
      // Match characters from the start of each word
      let wi = 0;
      while (qi < q.length && wi < word.length && word[wi] === q[qi]) {
        wordStartIndices.push(startIdx + wi);
        qi++;
        wi++;
      }
    }
    wordPos = startIdx + word.length;
  }
  if (qi === q.length) {
    return { score: 75, indices: wordStartIndices };
  }

  // Substring match
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    const indices = [];
    for (let i = 0; i < q.length; i++) indices.push(subIdx + i);
    return { score: 50, indices };
  }

  // Fuzzy character-by-character match
  const indices = [];
  let ti = 0;
  for (let i = 0; i < q.length; i++) {
    const found = t.indexOf(q[i], ti);
    if (found === -1) return null;
    indices.push(found);
    ti = found + 1;
  }
  return { score: 25, indices };
}

/**
 * Highlight matched characters in text by wrapping them in <mark>.
 */
function HighlightedText({ text, indices }) {
  if (!indices || indices.length === 0) return html`<span>${text}</span>`;

  const set = new Set(indices);
  const parts = [];
  let buf = "";
  let inMatch = false;

  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    if (match !== inMatch) {
      if (buf) {
        parts.push(
          inMatch
            ? html`<mark class="cp-highlight">${buf}</mark>`
            : html`<span>${buf}</span>`,
        );
      }
      buf = "";
      inMatch = match;
    }
    buf += text[i];
  }
  if (buf) {
    parts.push(
      inMatch
        ? html`<mark class="cp-highlight">${buf}</mark>`
        : html`<span>${buf}</span>`,
    );
  }
  return html`<span>${parts}</span>`;
}

/* ═══════════════════════════════════════════════
 *  Styles
 * ═══════════════════════════════════════════════ */

const PALETTE_STYLES = `
  .cp-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(20vh, 120px);
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: cpFadeIn 0.15s ease-out;
  }
  @keyframes cpFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .cp-container {
    width: min(560px, 92vw);
    max-height: 70vh;
    background: var(--card-bg, rgba(30,30,46,0.95));
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: cpSlideIn 0.15s ease-out;
  }
  @keyframes cpSlideIn {
    from { opacity: 0; transform: translateY(-12px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .cp-search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  }
  .cp-search-icon {
    width: 20px;
    height: 20px;
    opacity: 0.5;
    flex-shrink: 0;
    color: var(--text-secondary, #999);
  }
  .cp-search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: 17px;
    color: var(--text, #e0e0e0);
    font-family: inherit;
  }
  .cp-search-input::placeholder {
    color: var(--text-secondary, #666);
  }
  .cp-kbd {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-secondary, rgba(255,255,255,0.06));
    color: var(--text-secondary, #888);
    font-family: monospace;
    flex-shrink: 0;
  }
  .cp-results {
    overflow-y: auto;
    padding: 8px;
    flex: 1;
  }
  .cp-group-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary, #888);
    padding: 8px 12px 4px;
  }
  .cp-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .cp-item:hover,
  .cp-item.selected {
    background: var(--bg-hover, rgba(255,255,255,0.08));
  }
  .cp-item-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    opacity: 0.7;
    color: var(--text-secondary, #aaa);
  }
  .cp-item-text {
    flex: 1;
    min-width: 0;
  }
  .cp-item-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text, #e0e0e0);
  }
  .cp-item-desc {
    font-size: 12px;
    color: var(--text-secondary, #888);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cp-item-hint {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-secondary, rgba(255,255,255,0.06));
    color: var(--text-secondary, #888);
    font-family: monospace;
    flex-shrink: 0;
  }
  .cp-highlight {
    background: rgba(99,102,241,0.35);
    color: inherit;
    border-radius: 2px;
  }
  .cp-empty {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-secondary, #888);
    font-size: 14px;
  }
`;

/* ═══════════════════════════════════════════════
 *  CommandPalette Component
 * ═══════════════════════════════════════════════ */

export function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      // Auto-focus with a small delay for the render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build all items (nav items are static, quick actions are dynamic)
  const allItems = useMemo(() => {
    return [
      ...buildNavigationItems(),
      ...COMMAND_ITEMS,
      ...buildQuickActions(),
    ];
  }, [open, executorData.value]);

  // Filter and score
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;

    const results = [];
    const q = query.trim();
    for (const item of allItems) {
      const titleMatch = fuzzyMatch(q, item.title);
      const descMatch = fuzzyMatch(q, item.description);
      const bestScore = Math.max(
        titleMatch?.score ?? 0,
        (descMatch?.score ?? 0) * 0.8,
      );
      if (titleMatch || descMatch) {
        results.push({
          ...item,
          _score: bestScore,
          _titleIndices: titleMatch?.indices || [],
          _descIndices: descMatch?.indices || [],
        });
      }
    }
    results.sort((a, b) => b._score - a._score);
    return results;
  }, [query, allItems]);

  // Group results by category
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const item of filtered) {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    }
    return groups;
  }, [filtered]);

  // Flat list for keyboard navigation
  const flatList = useMemo(() => {
    const flat = [];
    for (const items of grouped.values()) flat.push(...items);
    return flat;
  }, [grouped]);

  // Clamp selection
  useEffect(() => {
    if (selectedIdx >= flatList.length) {
      setSelectedIdx(Math.max(0, flatList.length - 1));
    }
  }, [flatList.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(".cp-item.selected");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const execute = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      // Defer action slightly so the palette closes first
      requestAnimationFrame(() => item.action());
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, flatList.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        execute(flatList[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [flatList, selectedIdx, execute, onClose],
  );

  if (!open) return null;

  let itemIndex = 0;

  return html`
    <style>
      ${PALETTE_STYLES}
    </style>
    <div class="cp-overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="cp-container" onKeyDown=${handleKeyDown}>
        <div class="cp-search-row">
          <svg class="cp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            ref=${inputRef}
            class="cp-search-input"
            type="text"
            placeholder="Search commands, tabs, actions…"
            value=${query}
            onInput=${(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
          />
          <span class="cp-kbd">esc</span>
        </div>
        <div class="cp-results" ref=${listRef}>
          ${flatList.length === 0
            ? html`<div class="cp-empty">No results for "${query}"</div>`
            : Array.from(grouped.entries()).map(
                ([category, items]) => html`
                  <div key=${category}>
                    <div class="cp-group-label">${category}</div>
                    ${items.map((item) => {
                      const idx = itemIndex++;
                      return html`
                        <div
                          key=${item.id}
                          class="cp-item ${idx === selectedIdx ? "selected" : ""}"
                          onClick=${() => execute(item)}
                          onMouseEnter=${() => setSelectedIdx(idx)}
                        >
                          ${item.icon
                            ? html`<div class="cp-item-icon">${ICONS[item.icon]}</div>`
                            : null}
                          <div class="cp-item-text">
                            <div class="cp-item-title">
                              <${HighlightedText}
                                text=${item.title}
                                indices=${item._titleIndices || []}
                              />
                            </div>
                            ${item.description
                              ? html`<div class="cp-item-desc">
                                  <${HighlightedText}
                                    text=${item.description}
                                    indices=${item._descIndices || []}
                                  />
                                </div>`
                              : null}
                          </div>
                          ${item.hint
                            ? html`<span class="cp-item-hint">${item.hint}</span>`
                            : null}
                        </div>
                      `;
                    })}
                  </div>
                `,
              )}
        </div>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  useCommandPalette hook
 *  Manages open state and global Cmd+K listener
 * ═══════════════════════════════════════════════ */

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onClose = useCallback(() => setOpen(false), []);

  return { open, onClose, setOpen };
}
