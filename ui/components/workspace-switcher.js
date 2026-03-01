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
import { iconText, resolveIcon } from "../modules/icon-utils.js";

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
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to switch workspace");
    }
    activeWorkspaceId.value = String(res.activeId || wsId);
    await loadWorkspaces();
    return true;
  } catch (err) {
    console.warn("[workspace-switcher] Failed to switch workspace:", err);
    return false;
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
    <div class="ws-manager-confirm">
      <span class="ws-manager-confirm-msg">${message}</span>
      <div class="ws-manager-confirm-actions">
        <button class="ws-manager-btn danger sm" onClick=${onConfirm} disabled=${loading}>
          ${loading ? html`<${Spinner} />` : "Yes"}
        </button>
        <button class="ws-manager-btn ghost sm" onClick=${onCancel} disabled=${loading}>Cancel</button>
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
      <div class="ws-manager-repo-row">
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
    <div class="ws-manager-repo-row">
      <span class="ws-manager-repo-name ${repo.exists ? "" : "missing"}">
        ${repo.primary ? html`<span class="ws-manager-repo-star" title="Primary">${resolveIcon("star")}</span>` : null}
        ${repo.name}
      </span>
      <span class="ws-manager-repo-status ${repo.exists ? "ok" : "err"}">
        ${repo.exists ? resolveIcon("✓") : iconText("✗ missing")}
      </span>
      <button
        class="ws-manager-btn ghost sm icon-btn"
        title="Remove repo"
        onClick=${() => { haptic("light"); setConfirming(true); }}
      >${resolveIcon("✕")}</button>
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
        class="ws-manager-btn ghost sm add-repo-toggle"
        onClick=${() => { haptic("light"); setExpanded(true); }}
      >+ Add Repo</button>
    `;
  }

  return html`
    <div class="ws-manager-form repo-form">
      <input
        class="ws-manager-input"
        placeholder="Git URL (https or ssh)"
        value=${url}
        onInput=${(e) => setUrl(e.target.value)}
        disabled=${loading}
      />
      <input
        class="ws-manager-input sm"
        placeholder="Branch (optional)"
        value=${branch}
        onInput=${(e) => setBranch(e.target.value)}
        disabled=${loading}
      />
      <div class="ws-manager-form-actions">
        <button
          class="ws-manager-btn primary sm"
          onClick=${handleAdd}
          disabled=${loading || !url.trim()}
        >${loading ? html`<${Spinner} />` : "Clone"}</button>
        <button
          class="ws-manager-btn ghost sm"
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
    <div class="ws-manager-item ${isActive ? "active" : ""}">
      <div class="ws-manager-item-header">
        <div class="ws-manager-item-title">
          <span class="ws-manager-item-name">${ws.name}</span>
          ${isActive ? html`<span class="ws-manager-active-badge">Active</span>` : null}
        </div>
        <div class="ws-manager-actions">
          ${!isActive && html`
            <button
              class="ws-manager-btn ghost sm"
              onClick=${handleSetActive}
              disabled=${activating}
              title="Set as active workspace"
            >${activating ? html`<${Spinner} />` : "Activate"}</button>
          `}
          <button
            class="ws-manager-btn ghost sm"
            onClick=${handlePull}
            disabled=${pulling}
            title="Pull all repos"
          >${pulling ? html`<${Spinner} /> Pulling` : iconText(":refresh: Pull")}</button>
          <button
            class="ws-manager-btn ghost sm danger-text"
            onClick=${() => { haptic("light"); setDelConfirm(true); }}
            title="Delete workspace"
          >${resolveIcon(":trash:")}</button>
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

      <div class="ws-manager-repos">
        ${(ws.repos || []).length === 0
          ? html`<div class="ws-manager-empty">No repos yet</div>`
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
    <div class="ws-manager-form add-ws-form">
      <div class="ws-manager-form-title">Create Workspace</div>
      <div class="ws-manager-form-row">
        <input
          class="ws-manager-input"
          placeholder="Workspace name"
          value=${name}
          onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") handleCreate(); }}
          disabled=${loading}
        />
        <button
          class="ws-manager-btn primary"
          onClick=${handleCreate}
          disabled=${loading || !name.trim()}
        >${loading ? html`<${Spinner} />` : "Create"}</button>
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
      <div class="ws-manager-modal-toolbar">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${handleScan}
          disabled=${scanning}
          title="Scan disk for workspaces"
        >${scanning ? "Scanning…" : iconText(":search: Scan Disk")}</button>
      </div>

      ${loading && !wsList.length
        ? html`<div class="ws-manager-loading">Loading workspaces…</div>`
        : null
      }

      <div class="ws-manager-list">
        ${wsList.map((ws) => html`
          <${WorkspaceCard} key=${ws.id} ws=${ws} />
        `)}
      </div>

      ${!wsList.length && !loading
        ? html`<div class="ws-manager-empty-state">No workspaces found. Create one or scan disk.</div>`
        : null
      }

      <${AddWorkspaceForm} />
    <//>
  `;
}

// ─── Main component: native <select> dropdown + manage trigger ─────
export function WorkspaceSwitcher() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const wsList = workspaces.value;
  const currentId = activeWorkspaceId.value;

  const handleSelection = async (e) => {
    const wsId = e.target.value;
    if (wsId === "__manage__") {
      e.target.value = currentId || "";
      haptic("medium");
      setManagerOpen(true);
      return;
    }
    if (!wsId || wsId === currentId) return;
    if (switchingId && switchingId === wsId) return;
    haptic("light");
    setSwitchingId(wsId);
    try {
      await switchWorkspace(wsId);
    } finally {
      setSwitchingId(null);
    }
  };

  if (!wsList.length && !workspacesLoading.value) {
    return html`
      <div class="ws-switcher">
        <button
          class="ws-switcher-btn ws-switcher-btn-empty"
          onClick=${() => { haptic("medium"); setManagerOpen(true); }}
          title="Set up a workspace"
        >
          <span class="ws-switcher-icon">${resolveIcon("settings")}</span>
          <span class="ws-switcher-name">Set up workspace</span>
        </button>
        <${WorkspaceManager}
          open=${managerOpen}
          onClose=${() => setManagerOpen(false)}
        />
      </div>
    `;
  }

  return html`
    <div class="ws-switcher">
      <select
        class="ws-native-select"
        value=${currentId || ""}
        onChange=${handleSelection}
        onInput=${handleSelection}
        disabled=${Boolean(switchingId)}
      >
        ${wsList.map((ws) => html`
          <option key=${ws.id} value=${ws.id}>${ws.name || ws.id}</option>
        `)}
        <option disabled>──────────</option>
        <option value="__manage__">Manage Workspaces</option>
      </select>

      <${WorkspaceManager}
        open=${managerOpen}
        onClose=${() => setManagerOpen(false)}
      />
    </div>
  `;
}
