/* ─────────────────────────────────────────────────────────────
 *  Tab: Infra — worktrees, shared workspaces, presence
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  worktreeData,
  sharedWorkspaces,
  presenceInstances,
  coordinatorInfo,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { cloneValue, formatRelative, formatBytes, downloadFile } from "../modules/utils.js";
import {
  Card,
  Badge,
  StatCard,
  SkeletonCard,
  EmptyState,
} from "../components/shared.js";
import { ProgressBar } from "../components/charts.js";
import { Collapsible } from "../components/forms.js";
import {
  workspaces as managedWorkspaces,
  activeWorkspaceId,
  loadWorkspaces as loadManagedWorkspaces,
} from "../components/workspace-switcher.js";

/* ─── Worktree health indicator ─── */
function healthColor(wt) {
  if (wt.status === "stale" || wt.status === "error")
    return "var(--color-error)";
  const ageMin = Math.round((wt.age || 0) / 60000);
  if (ageMin > 180) return "var(--color-inreview)"; // yellow — old
  return "var(--color-done)"; // green — healthy
}

function HealthDot({ wt }) {
  return html`<span
    class="health-dot"
    style="background:${healthColor(wt)}"
  ></span>`;
}

function ageString(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min >= 1440) return `${Math.round(min / 1440)}d`;
  if (min >= 60) return `${Math.round(min / 60)}h`;
  return `${min}m`;
}

/* ─── InfraTab ─── */
export function InfraTab() {
  /* Worktrees — work with either the new signal name or a compatible shape */
  const wtRaw = worktreeData?.value;
  const wts = Array.isArray(wtRaw)
    ? wtRaw
    : wtRaw?.worktrees || wtRaw?.data || [];
  const wStats = (wtRaw && !Array.isArray(wtRaw) ? wtRaw.stats : null) || {};

  /* Shared workspaces */
  const swRaw = sharedWorkspaces?.value;
  const registry = swRaw || {};
  const workspaces =
    registry?.workspaces || (Array.isArray(swRaw) ? swRaw : []);
  const availability = registry?.availability || {};

  /* Presence */
  const instances = presenceInstances?.value || [];
  const coordinator = coordinatorInfo?.value || null;

  /* Local form state */
  const [releaseInput, setReleaseInput] = useState("");
  const [sharedOwner, setSharedOwner] = useState("");
  const [sharedTtl, setSharedTtl] = useState("");
  const [sharedNote, setSharedNote] = useState("");
  const [expandedWt, setExpandedWt] = useState(null);
  const [worktreeDetails, setWorktreeDetails] = useState({});

  /* ── Worktree actions ── */
  const handlePrune = async () => {
    const ok = await showConfirm("Prune all stale worktrees?");
    if (!ok) return;
    haptic("medium");
    await apiFetch("/api/worktrees/prune", { method: "POST" }).catch(() => {});
    showToast("Prune initiated", "success");
    scheduleRefresh(120);
  };

  const handleRelease = async (key, branch) => {
    haptic("medium");
    const prev = cloneValue(wts);
    await runOptimistic(
      () => {
        const setter = worktreeData || {};
        if (Array.isArray(setter.value)) {
          setter.value = setter.value.filter(
            (w) => w.taskKey !== key && w.branch !== branch,
          );
        }
      },
      () =>
        apiFetch("/api/worktrees/release", {
          method: "POST",
          body: JSON.stringify({ taskKey: key, branch }),
        }),
      () => {
        if (worktreeData) worktreeData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleReleaseInput = async () => {
    if (!releaseInput.trim()) return;
    haptic("medium");
    await apiFetch("/api/worktrees/release", {
      method: "POST",
      body: JSON.stringify({
        taskKey: releaseInput.trim(),
        branch: releaseInput.trim(),
      }),
    }).catch(() => {});
    setReleaseInput("");
    scheduleRefresh(120);
  };

  const loadWorktreePeek = async (wt) => {
    const key = wt?.path || wt?.branch || wt?.taskKey;
    if (!key) return;
    if (worktreeDetails[key]?.loading || worktreeDetails[key]?.loaded) return;
    setWorktreeDetails((prev) => ({
      ...prev,
      [key]: { loading: true },
    }));
    try {
      const res = await apiFetch(`/api/worktrees/peek?path=${encodeURIComponent(wt.path || "")}`, {
        _silent: true,
      });
      setWorktreeDetails((prev) => ({
        ...prev,
        [key]: { ...(res?.data || {}), loaded: true },
      }));
    } catch (err) {
      setWorktreeDetails((prev) => ({
        ...prev,
        [key]: { loaded: true, error: err?.message || "Failed to load" },
      }));
    }
  };

  /* ── Shared workspace actions ── */
  const handleClaim = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
          (x) => x.id === wsId,
        );
        if (w) {
          w.availability = "leased";
          w.lease = {
            owner: sharedOwner || "telegram-ui",
            lease_expires_at: new Date(
              Date.now() + (Number(sharedTtl) || 60) * 60000,
            ).toISOString(),
            note: sharedNote,
          };
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/claim", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: wsId,
            owner: sharedOwner,
            ttlMinutes: Number(sharedTtl) || undefined,
            note: sharedNote,
          }),
        }),
      () => {
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleRenew = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
          (x) => x.id === wsId,
        );
        if (w?.lease) {
          w.lease.owner = sharedOwner || w.lease.owner;
          w.lease.lease_expires_at = new Date(
            Date.now() + (Number(sharedTtl) || 60) * 60000,
          ).toISOString();
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/renew", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: wsId,
            owner: sharedOwner,
            ttlMinutes: Number(sharedTtl) || undefined,
          }),
        }),
      () => {
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleSharedRelease = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
          (x) => x.id === wsId,
        );
        if (w) {
          w.availability = "available";
          w.lease = null;
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/release", {
          method: "POST",
          body: JSON.stringify({ workspaceId: wsId, owner: sharedOwner }),
        }),
      () => {
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  /* ── Managed Workspace state ── */
  const [addRepoUrl, setAddRepoUrl] = useState("");
  const [addRepoWs, setAddRepoWs] = useState("");
  const [newWsName, setNewWsName] = useState("");

  const handleCreateWorkspace = async () => {
    const name = newWsName.trim();
    if (!name) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/create", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      showToast(`Workspace "${name}" created`, "success");
      setNewWsName("");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to create workspace", "error");
    }
  };

  const handleDeleteWorkspace = async (id) => {
    const ok = await showConfirm("Delete this workspace? This cannot be undone.");
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/delete", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      showToast("Workspace deleted", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to delete workspace", "error");
    }
  };

  const handlePullWorkspace = async (id) => {
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/pull", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      showToast("Pull initiated", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to pull workspace", "error");
    }
  };

  const handleAddRepo = async (wsId, url) => {
    if (!url || !url.trim()) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/repos/add", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, url: url.trim() }),
      });
      showToast("Repo added", "success");
      setAddRepoUrl("");
      setAddRepoWs("");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to add repo", "error");
    }
  };

  const handleRemoveRepo = async (wsId, repoName) => {
    const ok = await showConfirm(`Remove repo "${repoName}" from workspace?`);
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/repos/remove", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, repoName }),
      });
      showToast("Repo removed", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to remove repo", "error");
    }
  };

  const handleScanDisk = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/scan");
      showToast("Disk scan complete", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Scan failed", "error");
    }
  };

  /* ── Export infrastructure report ── */
  const handleExportReport = () => {
    haptic("medium");
    const now = new Date();
    const activeCount = wStats.active ?? wts.filter((w) => w.status !== "stale" && w.status !== "error").length;
    const staleCount = wStats.stale ?? wts.filter((w) => w.status === "stale").length;
    const availCount = workspaces.filter((w) => w.availability === "available").length;
    const leasedCount = workspaces.filter((w) => w.availability === "leased").length;

    let report = "";
    report += "VirtEngine Infrastructure Report\n";
    report += `Generated: ${now.toISOString()}\n\n`;

    report += "== Worktrees ==\n";
    report += `Total: ${wts.length} | Active: ${activeCount} | Stale: ${staleCount}\n\n`;
    for (const wt of wts) {
      report += `- ${wt.branch || "(detached)"} (${wt.status || "active"}) — Age: ${ageString(wt.age)}, Path: ${wt.path || "—"}\n`;
    }

    report += "\n== Shared Workspaces ==\n";
    report += `Total: ${workspaces.length} | Available: ${availCount} | Leased: ${leasedCount}\n\n`;
    for (const ws of workspaces) {
      const lease = ws.lease;
      const owner = lease ? lease.owner || "—" : "—";
      const expiry = lease ? new Date(lease.lease_expires_at).toISOString() : "—";
      report += `- ${ws.name || ws.id}: ${ws.availability || "unknown"} — Owner: ${owner}, Expires: ${expiry}\n`;
    }

    report += "\n== Active Instances ==\n";
    report += `Coordinator: ${coordinator?.instance_label || coordinator?.instance_id || "none"}\n`;
    report += `Instances: ${instances.length}\n`;
    for (const inst of instances) {
      const since = inst.last_seen_at ? new Date(inst.last_seen_at).toISOString() : "unknown";
      report += `- ${inst.instance_label || inst.instance_id} (${inst.workspace_role || "workspace"}) — Since: ${since}\n`;
    }

    const dateStr = now.toISOString().slice(0, 10);
    downloadFile(report, `infra-report-${dateStr}.txt`, "text/plain");
    showToast("Infrastructure report exported", "success");
  };

  /* ── Render ── */
  return html`
    <!-- ─── Infra header with export ─── -->
    <div class="flex-between mb-md" style="padding:0 4px">
      <span style="font-weight:600;font-size:15px">Infrastructure</span>
      <button class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;gap:4px" onClick=${handleExportReport}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Export Report
      </button>
    </div>

    <!-- ─── Managed Workspaces ─── -->
    <${Collapsible} title="Managed Workspaces" defaultOpen=${true}>
      <${Card}>
        <div class="input-row mb-md">
          <input
            class="input"
            placeholder="New workspace name"
            value=${newWsName}
            onInput=${(e) => setNewWsName(e.target.value)}
            onKeyDown=${(e) => e.key === "Enter" && handleCreateWorkspace()}
          />
          <button class="btn btn-primary btn-sm" onClick=${handleCreateWorkspace}>
            ${iconText(":plus: Create")}
          </button>
          <button class="btn btn-secondary btn-sm" onClick=${handleScanDisk}>
            ${iconText(":refresh: Scan")}
          </button>
        </div>

        ${(managedWorkspaces.value || []).map((ws) => {
          const isActive = ws.id === activeWorkspaceId.value;
          const repos = Array.isArray(ws.repos) ? ws.repos : [];
          return html`
            <div class="task-card" key=${ws.id}>
              <div class="task-card-header">
                <div>
                  <div class="task-card-title" style="display:flex;align-items:center;gap:6px">
                    <span
                      class="health-dot"
                      style="background:${isActive ? "var(--color-done)" : "var(--color-neutral)"}"
                    ></span>
                    ${ws.name || ws.id}
                    ${isActive && html`<${Badge} status="done" text="Active" />`}
                  </div>
                  <div class="task-card-meta">${repos.length} repos · ID: ${ws.id}</div>
                </div>
                <div class="btn-row">
                  <button
                    class="btn btn-secondary btn-sm"
                    onClick=${() => handlePullWorkspace(ws.id)}
                  >
                    :download: Pull
                  </button>
                  <button
                    class="btn btn-danger btn-sm"
                    onClick=${() => handleDeleteWorkspace(ws.id)}
                  >
                    ${resolveIcon(":trash:")}
                  </button>
                </div>
              </div>

              ${repos.length > 0 &&
              html`
                <div class="mt-sm">
                  ${repos.map((repo) => {
                    const repoName =
                      typeof repo === "string"
                        ? repo
                        : repo.name || repo.url || "?";
                    return html`
                      <div
                        class="flex-between"
                        style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)"
                      >
                        <span class="meta-text">${iconText(`:folder: ${repoName}`)}</span>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() => handleRemoveRepo(ws.id, repoName)}
                        >
                          ${resolveIcon("✕")}
                        </button>
                      </div>
                    `;
                  })}
                </div>
              `}

              <div class="input-row mt-sm">
                <input
                  class="input"
                  placeholder="Repo URL to clone"
                  value=${addRepoWs === ws.id ? addRepoUrl : ""}
                  onInput=${(e) => {
                    setAddRepoWs(ws.id);
                    setAddRepoUrl(e.target.value);
                  }}
                  onKeyDown=${(e) =>
                    e.key === "Enter" && handleAddRepo(ws.id, addRepoWs === ws.id ? addRepoUrl : "")}
                />
                <button
                  class="btn btn-secondary btn-sm"
                  onClick=${() => handleAddRepo(ws.id, addRepoWs === ws.id ? addRepoUrl : "")}
                >
                  ${iconText(":download: Clone")}
                </button>
              </div>
            </div>
          `;
        })}

        ${!(managedWorkspaces.value || []).length &&
        html`<${EmptyState} message="No managed workspaces. Create one or scan disk." />`}
      <//>
    <//>

    <!-- ─── Worktrees ─── -->
    <${Collapsible} title="Worktrees" defaultOpen=${true}>
      <${Card}>
        <div class="stats-grid mb-md">
          <${StatCard} value=${wStats.total ?? wts.length} label="Total" />
          <${StatCard}
            value=${wStats.active ?? 0}
            label="Active"
            color="var(--color-done)"
          />
          <${StatCard}
            value=${wStats.stale ?? 0}
            label="Stale"
            color="var(--color-inreview)"
          />
        </div>

        <div class="input-row mb-md">
          <input
            class="input"
            placeholder="Task key or branch"
            value=${releaseInput}
            onInput=${(e) => setReleaseInput(e.target.value)}
          />
          <button
            class="btn btn-secondary btn-sm"
            onClick=${handleReleaseInput}
          >
            Release
          </button>
          <button class="btn btn-danger btn-sm" onClick=${handlePrune}>
            ${iconText(":trash: Prune")}
          </button>
        </div>

        ${wts.map(
          (wt, idx) => {
            const key = wt?.path || wt?.branch || wt?.taskKey || String(idx);
            const detail = worktreeDetails[key] || {};
            const detailLoading = Boolean(detail?.loading);
            const detailError = detail?.error;
            return html`
            <div key=${wt.branch || wt.path || idx} class="task-card">
              <div
                class="task-card-header"
                style="cursor:pointer"
                onClick=${() => {
                  haptic();
                  const nextOpen = expandedWt === idx ? null : idx;
                  setExpandedWt(nextOpen);
                  if (nextOpen === idx) {
                    loadWorktreePeek(wt);
                  }
                }}
              >
                <div style="display:flex;align-items:center;gap:6px">
                  <${HealthDot} wt=${wt} />
                  <div>
                    <div class="task-card-title">
                      ${wt.branch || "(detached)"}
                    </div>
                    <div class="task-card-meta">${wt.path}</div>
                  </div>
                </div>
                <${Badge}
                  status=${wt.status || "active"}
                  text=${wt.status || "active"}
                />
              </div>
              <div class="meta-text">
                Age
                ${ageString(wt.age)}${wt.taskKey
                  ? ` · ${wt.taskKey}`
                  : ""}${wt.owner ? ` · Owner ${wt.owner}` : ""}
              </div>

              <!-- Collapsible git status section -->
              ${expandedWt === idx &&
              html`
                <div class="wt-detail mt-sm">
                  ${detailLoading &&
                  html`<div class="meta-text">Loading worktree details…</div>`}
                  ${detailError &&
                  html`<div class="meta-text" style="color:var(--color-error)">${detailError}</div>`}
                  ${detail.gitStatus &&
                  html` <div class="log-box log-box-sm">${detail.gitStatus}</div> `}
                  ${detail.lastCommit &&
                  html`
                    <div class="meta-text mt-xs">
                      Last commit: ${truncate(detail.lastCommit, 80)}
                    </div>
                  `}
                  ${detail.filesChanged != null &&
                  html`
                    <div class="meta-text">
                      Files changed: ${detail.filesChanged}
                    </div>
                  `}
                  ${detail.diffSummary &&
                  html`<div class="log-box log-box-sm mt-xs">${detail.diffSummary}</div>`}
                  ${Array.isArray(detail.recentCommits) && detail.recentCommits.length > 0 &&
                  html`
                    <div class="meta-text mt-xs">Recent commits:</div>
                    <div class="log-box log-box-sm">
                      ${detail.recentCommits.map((c) => html`<div>${c}</div>`)}
                    </div>
                  `}
                  ${Array.isArray(detail.sessions) && detail.sessions.length > 0 &&
                  html`
                    <div class="meta-text mt-xs">Active sessions:</div>
                    <div class="log-box log-box-sm">
                      ${detail.sessions.map((s) => html`<div>${s.title || s.id} · ${s.type} · ${formatRelative(s.lastActiveAt)}</div>`)}
                    </div>
                  `}
                </div>
              `}

              <div class="btn-row mt-sm">
                ${wt.taskKey &&
                html`
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() => handleRelease(wt.taskKey, "")}
                  >
                    Release Key
                  </button>
                `}
                ${wt.branch &&
                html`
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() => handleRelease("", wt.branch)}
                  >
                    Release Branch
                  </button>
                `}
              </div>
            </div>
          `;
          },
        )}
        ${!wts.length &&
        html`<${EmptyState} message="No worktrees tracked." />`}
      <//>
    <//>

    <!-- ─── Shared Workspaces ─── -->
    <${Collapsible} title="Shared Workspaces" defaultOpen=${true}>
      <${Card}>
        <div class="chip-group mb-sm">
          ${Object.entries(availability).map(
            ([k, v]) => html`<span key=${k} class="pill">${k}: ${v}</span>`,
          )}
          ${!Object.keys(availability).length &&
          html`<span class="pill">No registry</span>`}
        </div>

        <div class="input-row mb-sm">
          <input
            class="input"
            placeholder="Owner"
            value=${sharedOwner}
            onInput=${(e) => setSharedOwner(e.target.value)}
          />
          <input
            class="input"
            type="number"
            min="30"
            step="15"
            placeholder="TTL (min)"
            value=${sharedTtl}
            onInput=${(e) => setSharedTtl(e.target.value)}
          />
        </div>
        <input
          class="input mb-md"
          placeholder="Note (optional)"
          value=${sharedNote}
          onInput=${(e) => setSharedNote(e.target.value)}
        />

        ${workspaces.map((ws) => {
          const lease = ws.lease;
          const leaseInfo = lease
            ? `Leased to ${lease.owner} until ${new Date(lease.lease_expires_at).toLocaleString()}`
            : "Available";
          return html`
            <div key=${ws.id} class="task-card">
              <div class="task-card-header">
                <div>
                  <div class="task-card-title">${ws.name || ws.id}</div>
                  <div class="task-card-meta">
                    ${ws.provider || "provider"} · ${ws.region || "region?"}
                  </div>
                </div>
                <${Badge} status=${ws.availability} text=${ws.availability} />
              </div>
              <div class="meta-text">${leaseInfo}</div>
              ${lease?.note &&
              html`<div class="meta-text" style="font-style:italic">
                ${lease.note}
              </div>`}

              <div class="btn-row mt-sm">
                <button
                  class="btn btn-primary btn-sm"
                  onClick=${() => handleClaim(ws.id)}
                >
                  ${iconText(":lock: Claim")}
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  onClick=${() => handleRenew(ws.id)}
                >
                  ↻ Renew
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => handleSharedRelease(ws.id)}
                >
                  ${iconText(":unlock: Release")}
                </button>
              </div>
            </div>
          `;
        })}
        ${!workspaces.length &&
        html`<${EmptyState} message="No shared workspaces configured." />`}
      <//>
    <//>

    <!-- ─── Presence ─── -->
    <${Collapsible} title="Presence" defaultOpen=${true}>
      <${Card}>
        <!-- Coordinator info -->
        <div class="task-card mb-md">
          <div class="task-card-title">${iconText(":target: Coordinator")}</div>
          <div class="meta-text">
            ${coordinator?.instance_label || coordinator?.instance_id || "none"}
            · Priority ${coordinator?.coordinator_priority ?? "—"}
          </div>
          ${coordinator?.last_seen_at &&
          html`
            <div class="meta-text">
              Last seen: ${formatRelative(coordinator.last_seen_at)}
            </div>
          `}
        </div>

        <!-- Instance grid -->
        ${instances.length
          ? html`
              <div class="stats-grid">
                ${instances.map(
                  (inst, i) => html`
                    <div
                      key=${i}
                      class="stat-card"
                      style="text-align:left;padding:10px"
                    >
                      <div style="display:flex;align-items:center;gap:6px">
                        <span
                          class="health-dot"
                          style="background:${inst.status === "offline"
                            ? "var(--color-error)"
                            : "var(--color-done)"}"
                        ></span>
                        <span style="font-weight:600;font-size:13px">
                          ${inst.instance_label || inst.instance_id}
                        </span>
                      </div>
                      <div class="meta-text">
                        ${inst.workspace_role || "workspace"} ·
                        ${inst.host || "host"}
                      </div>
                      <div class="meta-text">
                        Last:
                        ${inst.last_seen_at
                          ? formatRelative(inst.last_seen_at)
                          : "unknown"}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<${EmptyState} message="No active instances." />`}
      <//>
    <//>
  `;
}
