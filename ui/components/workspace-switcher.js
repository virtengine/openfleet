/* ─────────────────────────────────────────────────────────────
 *  Workspace Switcher — dropdown to switch between workspaces
 *  Used in the Header component for quick workspace navigation
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { apiFetch } from "../modules/api.js";

const html = htm.bind(h);

// Shared signals for workspace state
export const workspaces = signal([]);
export const activeWorkspaceId = signal(null);
export const workspacesLoading = signal(false);

/**
 * Load workspaces from the API.
 */
export async function loadWorkspaces() {
  workspacesLoading.value = true;
  try {
    const res = await apiFetch("/api/workspaces");
    if (res?.ok) {
      workspaces.value = res.data || [];
      activeWorkspaceId.value = res.activeId || null;
    }
  } catch (err) {
    console.warn("[workspace-switcher] Failed to load workspaces:", err);
  } finally {
    workspacesLoading.value = false;
  }
}

/**
 * Switch to a different workspace.
 */
export async function switchWorkspace(wsId) {
  try {
    const res = await apiFetch("/api/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: wsId }),
    });
    if (res?.ok) {
      activeWorkspaceId.value = wsId;
      await loadWorkspaces();
    }
  } catch (err) {
    console.warn("[workspace-switcher] Failed to switch workspace:", err);
  }
}

/**
 * WorkspaceSwitcher component — compact dropdown for the header bar.
 */
export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!e.target.closest?.(".ws-switcher")) setOpen(false);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [open]);

  const activeWs = workspaces.value.find((ws) => ws.id === activeWorkspaceId.value);
  const wsList = workspaces.value;

  if (!wsList.length) return null;
  if (wsList.length === 1 && !wsList[0].repos?.length) return null;

  return html`
    <div class="ws-switcher">
      <button
        class="ws-switcher-btn"
        onClick=${(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Switch workspace"
      >
        <span class="ws-switcher-icon">⬡</span>
        <span class="ws-switcher-name">${activeWs?.name || "Select Workspace"}</span>
        <span class="ws-switcher-chevron ${open ? "open" : ""}">${open ? "▴" : "▾"}</span>
      </button>
      ${open && html`
        <div class="ws-switcher-dropdown">
          <div class="ws-switcher-header">Workspaces</div>
          ${wsList.map((ws) => html`
            <button
              key=${ws.id}
              class="ws-switcher-item ${ws.id === activeWorkspaceId.value ? "active" : ""}"
              onClick=${() => { switchWorkspace(ws.id); setOpen(false); }}
            >
              <div class="ws-switcher-item-main">
                <span class="ws-switcher-item-name">${ws.name}</span>
                ${ws.id === activeWorkspaceId.value
                  ? html`<span class="ws-switcher-badge">Active</span>`
                  : null}
              </div>
              <div class="ws-switcher-item-repos">
                ${(ws.repos || []).map((r) => html`
                  <span key=${r.name} class="ws-switcher-repo ${r.exists ? "" : "missing"}" title=${r.slug || r.name}>
                    ${r.primary ? "★ " : ""}${r.name}
                  </span>
                `)}
              </div>
            </button>
          `)}
        </div>
      `}
    </div>
  `;
}
