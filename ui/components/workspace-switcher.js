/* ─────────────────────────────────────────────────────────────
 *  Workspace Switcher — dropdown + full management panel
 *  Used in the Header component for quick workspace navigation
 *  and a full-screen manager for CRUD operations on workspaces.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { haptic } from "../modules/telegram.js";
import { Modal } from "./shared.js";

const html = htm.bind(h);

// ─── Shared signals for workspace state ────────────────────
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

// ─── API helpers for workspace management ──────────────────

async function createWorkspace(name) {
  const res = await apiFetch("/api/workspaces/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function deleteWorkspace(workspaceId, deleteFiles = false) {
  const res = await apiFetch("/api/workspaces/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, deleteFiles }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function addRepo(workspaceId, url, opts = {}) {
  const res = await apiFetch("/api/workspaces/repos/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, url, ...opts }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function removeRepo(workspaceId, repoName, deleteFiles = false) {
  const res = await apiFetch("/api/workspaces/repos/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, repoName, deleteFiles }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function pullWorkspace(workspaceId) {
  const res = await apiFetch("/api/workspaces/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function scanDisk() {
  const res = await apiFetch("/api/workspaces/scan");
  if (res?.ok) await loadWorkspaces();
  return res;
}

// ─── Inline spinner helper ─────────────────────────────────
function Spinner() {
  return html`<span class="ws-manager-spinner" />`;
}

// ─── Confirm dialog helper ─────────────────────────────────
function ConfirmBar({ message, onConfirm, onCancel, loading }) {
  return html`
    <div class="flex items-center gap-2 px-3 py-2 bg-warning/10 rounded-lg text-sm">
      <span class="flex-1">${message}</span>
      <div class="flex gap-1">
        <button class="btn btn-error btn-sm btn-outline" onClick=${onConfirm} disabled=${loading}>
          ${loading ? html`<${Spinner} />` : "Yes"}
        </button>
        <button class="btn btn-ghost btn-sm" onClick=${onCancel} disabled=${loading}>Cancel</button>
      </div>
    </div>
  `;
}

// ─── Single repo row in management panel ───────────────────
function RepoRow({ repo, workspaceId }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    haptic("medium");
    try {
      await removeRepo(workspaceId, repo.name, false);
    } catch (e) {
      console.warn("[ws-manager] remove repo error:", e);
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  }, [workspaceId, repo.name]);

  if (confirming) {
    return html`
      <div class="flex items-center gap-2 py-1">
        <${ConfirmBar}
          message="Remove ${repo.name}?"
          onConfirm=${handleRemove}
          onCancel=${() => setConfirming(false)}
          loading=${removing}
        />
      </div>
    `;
  }

  return html`
    <div class="flex items-center gap-2 py-1">
      <span class="text-sm truncate flex-1 ${repo.exists ? '' : 'opacity-50 line-through'}">
        ${repo.primary ? html`<span class="text-warning mr-1" title="Primary">★</span>` : null}
        ${repo.name}
      </span>
      <span class="text-xs ${repo.exists ? 'text-success' : 'text-error'}">
        ${repo.exists ? "✓" : "✗ missing"}
      </span>
      <button
        class="btn btn-ghost btn-xs"
        title="Remove repo"
        onClick=${() => { haptic("light"); setConfirming(true); }}
      >✕</button>
    </div>
  `;
}

// ─── Add-repo form (expandable per workspace) ──────────────
function AddRepoForm({ workspaceId }) {
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!url.trim()) return;
    setLoading(true);
    haptic("medium");
    try {
      await addRepo(workspaceId, url.trim(), branch.trim() ? { branch: branch.trim() } : {});
      setUrl("");
      setBranch("");
      setExpanded(false);
    } catch (e) {
      console.warn("[ws-manager] add repo error:", e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, url, branch]);

  if (!expanded) {
    return html`
      <button
        class="btn btn-ghost btn-sm"
        onClick=${() => { haptic("light"); setExpanded(true); }}
      >+ Add Repo</button>
    `;
  }

  return html`
    <div class="flex flex-col gap-2 pt-2">
      <input
        class="input input-bordered input-sm w-full"
        placeholder="Git URL (https or ssh)"
        value=${url}
        onInput=${(e) => setUrl(e.target.value)}
        disabled=${loading}
      />
      <input
        class="input input-bordered input-sm w-full"
        placeholder="Branch (optional)"
        value=${branch}
        onInput=${(e) => setBranch(e.target.value)}
        disabled=${loading}
      />
      <div class="flex gap-2">
        <button
          class="btn btn-primary btn-sm"
          onClick=${handleAdd}
          disabled=${loading || !url.trim()}
        >${loading ? html`<${Spinner} />` : "Clone"}</button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => { setExpanded(false); setUrl(""); setBranch(""); }}
          disabled=${loading}
        >Cancel</button>
      </div>
    </div>
  `;
}

// ─── Single workspace card in the management panel ─────────
function WorkspaceCard({ ws }) {
  const isActive = ws.id === activeWorkspaceId.value;
  const [pulling, setPulling] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activating, setActivating] = useState(false);

  const handleSetActive = useCallback(async () => {
    setActivating(true);
    haptic("medium");
    try {
      await switchWorkspace(ws.id);
    } finally {
      setActivating(false);
    }
  }, [ws.id]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    haptic("light");
    try {
      await pullWorkspace(ws.id);
    } catch (e) {
      console.warn("[ws-manager] pull error:", e);
    } finally {
      setPulling(false);
    }
  }, [ws.id]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    haptic("heavy");
    try {
      await deleteWorkspace(ws.id, false);
    } catch (e) {
      console.warn("[ws-manager] delete error:", e);
    } finally {
      setDeleting(false);
      setDelConfirm(false);
    }
  }, [ws.id]);

  return html`
    <div class="card bg-base-200 shadow-sm mb-2 ${isActive ? "ring-1 ring-primary" : ""}">
      <div class="card-body p-3 gap-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-medium text-sm">${ws.name}</span>
            ${isActive ? html`<span class="badge badge-primary badge-sm">Active</span>` : null}
          </div>
          <div class="flex gap-1">
          ${!isActive && html`
            <button
              class="btn btn-ghost btn-sm"
              onClick=${handleSetActive}
              disabled=${activating}
              title="Set as active workspace"
            >${activating ? html`<${Spinner} />` : "Activate"}</button>
          `}
          <button
            class="btn btn-ghost btn-sm"
            onClick=${handlePull}
            disabled=${pulling}
            title="Pull all repos"
          >${pulling ? html`<${Spinner} /> Pulling` : "⟳ Pull"}</button>
          <button
            class="btn btn-ghost btn-sm text-error"
            onClick=${() => { haptic("light"); setDelConfirm(true); }}
            title="Delete workspace"
          >🗑</button>
        </div>
      </div>

      ${delConfirm && html`
        <${ConfirmBar}
          message="Delete workspace '${ws.name}'?"
          onConfirm=${handleDelete}
          onCancel=${() => setDelConfirm(false)}
          loading=${deleting}
        />
      `}

      <div class="flex flex-col gap-1 mt-1">
        ${(ws.repos || []).length === 0
          ? html`<div class="text-xs opacity-50 py-1">No repos yet</div>`
          : (ws.repos || []).map((r) => html`
            <${RepoRow} key=${r.name} repo=${r} workspaceId=${ws.id} />
          `)
        }
        <${AddRepoForm} workspaceId=${ws.id} />
      </div>
    </div>
  `;
}

// ─── Add workspace form ────────────────────────────────────
function AddWorkspaceForm() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setLoading(true);
    haptic("medium");
    try {
      await createWorkspace(name.trim());
      setName("");
    } catch (e) {
      console.warn("[ws-manager] create workspace error:", e);
    } finally {
      setLoading(false);
    }
  }, [name]);

  return html`
    <div class="card bg-base-200 shadow-sm mt-3">
      <div class="card-body p-3 gap-2">
        <div class="text-sm font-semibold">Create Workspace</div>
        <div class="flex gap-2">
          <input
            class="input input-bordered input-sm flex-1"
            placeholder="Workspace name"
            value=${name}
            onInput=${(e) => setName(e.target.value)}
            onKeyDown=${(e) => { if (e.key === "Enter") handleCreate(); }}
            disabled=${loading}
          />
          <button
            class="btn btn-primary btn-sm"
            onClick=${handleCreate}
            disabled=${loading || !name.trim()}
          >${loading ? html`<${Spinner} />` : "Create"}</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Full-screen management panel ──────────────────────────
export function WorkspaceManager({ open, onClose }) {
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (open) loadWorkspaces();
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    haptic("medium");
    try {
      await scanDisk();
    } catch (e) {
      console.warn("[ws-manager] scan error:", e);
    } finally {
      setScanning(false);
    }
  }, []);

  if (!open) return null;

  const wsList = workspaces.value;
  const loading = workspacesLoading.value;

  return html`
    <${Modal} title="Manage Workspaces" open=${open} onClose=${onClose}>
      <div class="flex justify-end pb-2">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${handleScan}
          disabled=${scanning}
          title="Scan disk for workspaces"
        >${scanning ? "Scanning…" : "🔍 Scan Disk"}</button>
      </div>

      ${loading && !wsList.length
        ? html`<div class="flex items-center justify-center py-8 text-sm opacity-60">Loading workspaces…</div>`
        : null
      }

      <div class="flex flex-col gap-2">
        ${wsList.map((ws) => html`
          <${WorkspaceCard} key=${ws.id} ws=${ws} />
        `)}
      </div>

      ${!wsList.length && !loading
        ? html`<div class="text-center text-sm opacity-60 py-8">No workspaces found. Create one or scan disk.</div>`
        : null
      }

      <${AddWorkspaceForm} />
    <//>
  `;
}

// ─── Main component: compact dropdown + manage trigger ─────
export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // Close dropdown on outside click
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

  if (!wsList.length && !managerOpen) return null;

  return html`
    <div class="ws-switcher dropdown dropdown-bottom">
      <button
        class="btn btn-ghost btn-sm gap-1 truncate max-w-[200px]"
        onClick=${(e) => { e.stopPropagation(); haptic("light"); setOpen(!open); }}
        title="Switch workspace"
      >
        <span>⬡</span>
        <span class="truncate">${activeWs?.name || "Select Workspace"}</span>
        <span class="text-xs">${open ? "▴" : "▾"}</span>
      </button>

      ${open && html`
        <div class="dropdown-content menu bg-base-200 rounded-box w-64 p-2 shadow-lg z-50">
          <div class="text-xs font-semibold uppercase opacity-50 px-3 py-1">Workspaces</div>
          ${wsList.map((ws) => html`
            <button
              key=${ws.id}
              class="flex flex-col gap-0.5 w-full text-left px-3 py-2 rounded-lg cursor-pointer transition-colors ${ws.id === activeWorkspaceId.value ? "bg-primary/10" : "hover:bg-base-300"}"
              onClick=${() => { haptic("light"); switchWorkspace(ws.id); setOpen(false); }}
            >
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium truncate">${ws.name}</span>
                ${ws.id === activeWorkspaceId.value
                  ? html`<span class="badge badge-primary badge-xs">Active</span>`
                  : null}
              </div>
              <div class="flex flex-wrap gap-1">
                ${(ws.repos || []).map((r) => html`
                  <span key=${r.name} class="text-xs opacity-60 ${r.exists ? '' : 'line-through opacity-40'}" title=${r.slug || r.name}>
                    ${r.primary ? "★ " : ""}${r.name}
                  </span>
                `)}
              </div>
            </button>
          `)}
          <div class="divider my-1 h-0" />
          <button
            class="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg cursor-pointer hover:bg-base-300 transition-colors text-sm"
            onClick=${() => { haptic("medium"); setOpen(false); setManagerOpen(true); }}
          >
            <span>⚙</span>
            <span>Manage Workspaces</span>
          </button>
        </div>
      `}

      <${WorkspaceManager}
        open=${managerOpen}
        onClose=${() => setManagerOpen(false)}
      />
    </div>
  `;
}
