/* ─────────────────────────────────────────────────────────────
 *  Workspace Switcher — dropdown + full management panel
 *  Used in the Header component for quick workspace navigation
 *  and a full-screen manager for CRUD operations on workspaces.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { apiFetch, onWsMessage } from "../modules/api.js";
import { haptic } from "../modules/telegram.js";
import { Modal } from "./shared.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  Card, CardContent, CardActions,
  Typography, TextField, Button, IconButton,
  Chip, Box, Stack, CircularProgress,
  Dialog, DialogTitle, DialogContent,
  DialogActions as MuiDialogActions,
  List, ListItem, ListItemText, ListItemIcon,
  ListItemSecondaryAction, Divider, Tooltip, Alert,
  Menu, MenuItem,
} from "@mui/material";

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
    try {
      globalThis.dispatchEvent?.(
        new CustomEvent("ve:workspace-switched", {
          detail: { workspaceId: activeWorkspaceId.value || String(wsId || "") },
        }),
      );
    } catch {
      // no-op
    }
    try {
      const { refreshTab } = await import("../modules/state.js");
      await Promise.allSettled([
        refreshTab("tasks", { background: true, manual: false }),
        refreshTab("dashboard", { background: true, manual: false }),
      ]);
    } catch {
      // best effort
    }
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

// ─── Confirm dialog helper ─────────────────────────────────
function ConfirmBar({ message, onConfirm, onCancel, loading }) {
  return html`
    <${Alert}
      severity="warning"
      variant="outlined"
      sx=${{ my: 1 }}
      action=${html`
        <${Stack} direction="row" spacing=${1}>
          <${Button}
            size="small"
            color="error"
            variant="contained"
            onClick=${onConfirm}
            disabled=${loading}
          >
            ${loading ? html`<${CircularProgress} size=${16} />` : "Yes"}
          <//>
          <${Button}
            size="small"
            variant="outlined"
            onClick=${onCancel}
            disabled=${loading}
          >Cancel<//>
        <//>
      `}
    >
      <${Typography} variant="body2">${message}<//>
    <//>
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
      <${ListItem} sx=${{ flexDirection: "column", alignItems: "stretch" }}>
        <${ConfirmBar}
          message="Remove ${repo.name}?"
          onConfirm=${handleRemove}
          onCancel=${() => setConfirming(false)}
          loading=${removing}
        />
      <//>
    `;
  }

  return html`
    <${ListItem} dense>
      ${repo.primary && html`
        <${ListItemIcon} sx=${{ minWidth: 32 }}>
          <${Tooltip} title="Primary">
            <span>${resolveIcon("star")}</span>
          <//>
        <//>
      `}
      <${ListItemText}
        primary=${repo.name}
        secondary=${repo.exists ? null : "Missing on disk"}
        primaryTypographyProps=${{
          sx: { color: repo.exists ? "text.primary" : "error.main" },
        }}
      />
      <${ListItemSecondaryAction}>
        <${Stack} direction="row" spacing=${0.5} alignItems="center">
          <${Chip}
            label=${repo.exists ? "✓" : "✗ missing"}
            size="small"
            color=${repo.exists ? "success" : "error"}
            variant="outlined"
          />
          <${Tooltip} title="Remove repo">
            <${IconButton}
              size="small"
              onClick=${() => { haptic("light"); setConfirming(true); }}
            >${resolveIcon("✕")}<//>
          <//>
        <//>
      <//>
    <//>
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
      <${Box} sx=${{ px: 2, pb: 1 }}>
        <${Button}
          size="small"
          variant="text"
          onClick=${() => { haptic("light"); setExpanded(true); }}
        >+ Add Repo<//>
      <//>
    `;
  }

  return html`
    <${Stack} spacing=${1.5} sx=${{ px: 2, pb: 2 }}>
      <${TextField}
        size="small"
        fullWidth
        label="Git URL (https or ssh)"
        value=${url}
        onInput=${(e) => setUrl(e.target.value)}
        disabled=${loading}
      />
      <${TextField}
        size="small"
        fullWidth
        label="Branch (optional)"
        value=${branch}
        onInput=${(e) => setBranch(e.target.value)}
        disabled=${loading}
      />
      <${Stack} direction="row" spacing=${1}>
        <${Button}
          size="small"
          variant="contained"
          onClick=${handleAdd}
          disabled=${loading || !url.trim()}
          startIcon=${loading ? html`<${CircularProgress} size=${16} />` : null}
        >${loading ? "Cloning…" : "Clone"}<//>
        <${Button}
          size="small"
          variant="outlined"
          onClick=${() => { setExpanded(false); setUrl(""); setBranch(""); }}
          disabled=${loading}
        >Cancel<//>
      <//>
    <//>
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
    <${Card}
      variant="outlined"
      sx=${{
        mb: 2,
        borderColor: isActive ? "primary.main" : "divider",
        borderWidth: isActive ? 2 : 1,
      }}
    >
      <${CardContent} sx=${{ pb: 0 }}>
        <${Stack} direction="row" justifyContent="space-between" alignItems="center">
          <${Stack} direction="row" spacing=${1} alignItems="center">
            <${Typography} variant="subtitle1" fontWeight="bold">${ws.name}<//>
            ${isActive && html`
              <${Chip} label="Active" size="small" color="primary" />
            `}
          <//>
        <//>
      <//>

      <${CardActions} sx=${{ justifyContent: "flex-end", pt: 0.5 }}>
        ${!isActive && html`
          <${Button}
            size="small"
            variant="outlined"
            onClick=${handleSetActive}
            disabled=${activating}
            startIcon=${activating ? html`<${CircularProgress} size=${16} />` : null}
          >${activating ? "Activating…" : "Activate"}<//>
        `}
        <${Button}
          size="small"
          variant="text"
          onClick=${handlePull}
          disabled=${pulling}
          startIcon=${pulling ? html`<${CircularProgress} size=${16} />` : null}
        >${pulling ? "Pulling…" : iconText(":refresh: Pull")}<//>
        <${Tooltip} title="Delete workspace">
          <${IconButton}
            size="small"
            color="error"
            onClick=${() => { haptic("light"); setDelConfirm(true); }}
          >${resolveIcon(":trash:")}<//>
        <//>
      <//>

      ${delConfirm && html`
        <${Box} sx=${{ px: 2, pb: 1 }}>
          <${ConfirmBar}
            message="Delete workspace '${ws.name}'?"
            onConfirm=${handleDelete}
            onCancel=${() => setDelConfirm(false)}
            loading=${deleting}
          />
        <//>
      `}

      <${Divider} />

      <${CardContent} sx=${{ pt: 1, "&:last-child": { pb: 1 } }}>
        ${(ws.repos || []).length === 0
          ? html`<${Typography} variant="body2" color="text.secondary">No repos yet<//>`
          : html`
            <${List} dense disablePadding>
              ${(ws.repos || []).map((r) => html`
                <${RepoRow} key=${r.name} repo=${r} workspaceId=${ws.id} />
              `)}
            <//>
          `
        }
        <${AddRepoForm} workspaceId=${ws.id} />
      <//>
    <//>
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
    <${Box} sx=${{ p: 2, mt: 1 }}>
      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Create Workspace<//>
      <${Stack} direction="row" spacing=${1} alignItems="center">
        <${TextField}
          size="small"
          fullWidth
          label="Workspace name"
          value=${name}
          onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") handleCreate(); }}
          disabled=${loading}
        />
        <${Button}
          variant="contained"
          onClick=${handleCreate}
          disabled=${loading || !name.trim()}
          startIcon=${loading ? html`<${CircularProgress} size=${16} />` : null}
        >${loading ? "Creating…" : "Create"}<//>
      <//>
    <//>
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
      <${Box} sx=${{ mb: 2 }}>
        <${Button}
          size="small"
          variant="outlined"
          onClick=${handleScan}
          disabled=${scanning}
          startIcon=${scanning ? html`<${CircularProgress} size=${16} />` : null}
        >${scanning ? "Scanning…" : iconText(":search: Scan Disk")}<//>
      <//>

      ${loading && !wsList.length
        ? html`
          <${Stack} alignItems="center" sx=${{ py: 4 }}>
            <${CircularProgress} size=${28} />
            <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 1 }}>
              Loading workspaces…
            <//>
          <//>
        `
        : null
      }

      <${Stack} spacing=${0}>
        ${wsList.map((ws) => html`
          <${WorkspaceCard} key=${ws.id} ws=${ws} />
        `)}
      <//>

      ${!wsList.length && !loading
        ? html`
          <${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: "center", py: 3 }}>
            No workspaces found. Create one or scan disk.
          <//>
        `
        : null
      }

      <${AddWorkspaceForm} />
    <//>
  `;
}

// ─── Main component: MUI Menu dropdown + manage trigger ─────
export function WorkspaceSwitcher() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // Keep selector state in sync when workspace is switched externally
  // (for example via Electron menu or another client).
  useEffect(() => {
    const unsubscribe = onWsMessage((msg) => {
      if (msg?.type !== "invalidate") return;
      const channels = Array.isArray(msg.channels) ? msg.channels : [];
      if (channels.includes("*") || channels.includes("workspaces")) {
        loadWorkspaces().catch(() => {});
      }
    });
    return unsubscribe;
  }, []);

  // Desktop fallback when WS is unavailable: refresh workspace state whenever
  // the window regains focus/visibility.
  useEffect(() => {
    const sync = () => loadWorkspaces().catch(() => {});
    const onFocus = () => sync();
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    globalThis.addEventListener?.("focus", onFocus);
    document.addEventListener?.("visibilitychange", onVisibility);
    return () => {
      globalThis.removeEventListener?.("focus", onFocus);
      document.removeEventListener?.("visibilitychange", onVisibility);
    };
  }, []);

  const wsList = workspaces.value;
  const currentId = activeWorkspaceId.value;
  const currentWs = wsList.find((ws) => ws.id === currentId);

  const handleMenuOpen = (e) => {
    setMenuAnchor(e.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleSelect = async (wsId) => {
    handleMenuClose();
    if (wsId === "__manage__") {
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
        <${Button}
          size="small"
          variant="text"
          onClick=${() => { haptic("medium"); setManagerOpen(true); }}
          title="Set up a workspace"
          startIcon=${html`<span>${resolveIcon("settings")}</span>`}
        >Set up workspace<//>
        <${WorkspaceManager}
          open=${managerOpen}
          onClose=${() => setManagerOpen(false)}
        />
      </div>
    `;
  }

  return html`
    <div class="ws-switcher">
      <${Button}
        size="small"
        variant="text"
        onClick=${handleMenuOpen}
        disabled=${Boolean(switchingId)}
        sx=${{ textTransform: "none" }}
      >
        ${switchingId
          ? html`<${CircularProgress} size=${16} sx=${{ mr: 1 }} />`
          : null
        }
        ${currentWs?.name || currentId || "Select Workspace"}
      <//>

      <${Menu}
        anchorEl=${menuAnchor}
        open=${Boolean(menuAnchor)}
        onClose=${handleMenuClose}
      >
        ${wsList.map((ws) => html`
          <${MenuItem}
            key=${ws.id}
            selected=${ws.id === currentId}
            onClick=${() => handleSelect(ws.id)}
          >${ws.name || ws.id}<//>
        `)}
        <${Divider} />
        <${MenuItem} onClick=${() => handleSelect("__manage__")}>
          Manage Workspaces
        <//>
      <//>

      <${WorkspaceManager}
        open=${managerOpen}
        onClose=${() => setManagerOpen(false)}
      />
    </div>
  `;
}
