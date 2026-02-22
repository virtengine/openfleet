/* ─────────────────────────────────────────────────────────────
 *  Tab: Dashboard — overview stats, executor, quick actions
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useCallback,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm, showAlert } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  statusData,
  executorData,
  tasksData,
  projectSummary,
  loadStatus,
  loadProjectSummary,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  getTrend,
  getDashboardHistory,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { cloneValue, formatRelative, truncate } from "../modules/utils.js";
import {
  Card,
  Badge,
  SkeletonCard,
  Modal,
  EmptyState,
} from "../components/shared.js";
import { DonutChart, ProgressBar, MiniSparkline } from "../components/charts.js";
import {
  SegmentedControl,
  PullToRefresh,
  SliderControl,
} from "../components/forms.js";
import { StartTaskModal } from "./tasks.js";

/* ─── Quick Action definitions ─── */
const QUICK_ACTIONS = [
  {
    label: "Status",
    cmd: "/status",
    icon: "📊",
    color: "var(--accent)",
    targetTab: "dashboard",
  },
  {
    label: "Health",
    cmd: "/health",
    icon: "💚",
    color: "var(--color-done)",
    targetTab: "dashboard",
  },
  {
    label: "Create Task",
    action: "create",
    icon: "➕",
    color: "var(--color-inprogress)",
  },
  {
    label: "Start Task",
    action: "start",
    icon: "▶",
    color: "var(--color-todo)",
  },
  {
    label: "Plan",
    cmd: "/plan",
    icon: "📋",
    color: "var(--color-inreview)",
    targetTab: "control",
  },
  {
    label: "Logs",
    cmd: "/logs 50",
    icon: "📄",
    color: "var(--text-secondary)",
    targetTab: "logs",
  },
  {
    label: "Menu",
    cmd: "/menu",
    icon: "☰",
    color: "var(--color-todo)",
    targetTab: "control",
  },
];

/* ─── CreateTaskModal ─── */
export function CreateTaskModal({ onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      showToast("Title is required", "error");
      return;
    }
    setSubmitting(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          priority,
        }),
      });
      showToast("Task created", "success");
      onClose();
      await refreshTab("dashboard");
    } catch {
      /* toast shown by apiFetch */
    }
    setSubmitting(false);
  }, [title, description, priority, onClose]);

  /* Telegram MainButton integration */
  useEffect(() => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.MainButton) {
      tg.MainButton.setText("Create Task");
      tg.MainButton.show();
      const handler = () => handleSubmit();
      tg.MainButton.onClick(handler);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handler);
      };
    }
  }, [handleSubmit]);

  return html`
    <${Modal} title="Create Task" onClose=${onClose}>
      <div class="flex-col gap-md">
        <input
          class="input"
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input"
          rows="4"
          placeholder="Description (optional)"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <div class="card-subtitle">Priority</div>
        <${SegmentedControl}
          options=${[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          value=${priority}
          onChange=${(v) => {
            haptic();
            setPriority(v);
          }}
        />
        <button
          class="btn btn-primary"
          onClick=${handleSubmit}
          disabled=${submitting}
        >
          ${submitting ? "Creating…" : "Create Task"}
        </button>
      </div>
    <//>
  `;
}

/* ─── DashboardTab ─── */
export function DashboardTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);
  const status = statusData.value;
  const executor = executorData.value;
  const project = projectSummary.value;
  const counts = status?.counts || {};
  const summary = status?.success_metrics || {};
  const execData = executor?.data;
  const mode = executor?.mode || "vk";
  const defaultSdk = execData?.sdk || "auto";

  const running = Number(counts.running || counts.inprogress || 0);
  const review = Number(counts.review || counts.inreview || 0);
  const blocked = Number(counts.error || 0);
  const done = Number(counts.done || 0);
  const backlog = Number(status?.backlog_remaining || counts.todo || 0);
  const totalTasks = running + review + blocked + backlog + done;
  const errorRateValue = totalTasks > 0 ? (blocked / totalTasks) * 100 : 0;
  const errorRate = errorRateValue.toFixed(1);

  const totalActive = running + review + blocked;
  const progressPct =
    backlog + totalActive > 0
      ? Math.round((totalActive / (backlog + totalActive)) * 100)
      : 0;
  const slotPct = execData?.maxParallel
    ? ((execData.activeSlots || 0) / execData.maxParallel) * 100
    : 0;
  const headerLine = `${totalActive} active · ${backlog} backlog · ${done} done${
    blocked ? ` · ${blocked} blocked` : ""
  }`;

  const overviewMetrics = [
    {
      label: "Total tasks",
      value: totalTasks,
      color: "var(--text-primary)",
      trend: getTrend("total"),
      spark: "total",
    },
    {
      label: "In progress",
      value: running,
      color: "var(--color-inprogress)",
      trend: getTrend("running"),
      spark: "running",
    },
    {
      label: "Done",
      value: done,
      color: "var(--color-done)",
      trend: getTrend("done"),
      spark: "done",
    },
    {
      label: "Error rate",
      value: `${errorRate}%`,
      color: "var(--color-error)",
      trend: -getTrend("errors"),
      spark: "errors",
    },
  ];

  const workItems = [
    { label: "Running", value: running, color: "var(--color-inprogress)" },
    { label: "Review", value: review, color: "var(--color-inreview)" },
    { label: "Backlog", value: backlog, color: "var(--color-todo)" },
    { label: "Done", value: done, color: "var(--color-done)" },
  ];

  const alertItems = [
    {
      label: "Blocked tasks",
      value: blocked,
      tone: blocked > 0 ? "error" : "ok",
    },
    {
      label: "Error rate",
      value: `${errorRate}%`,
      tone: errorRateValue > 0 ? "warning" : "ok",
    },
  ];
  const hasAlerts = alertItems.some((item) => item.tone !== "ok");

  const qualityItems = [
    {
      label: "First-shot",
      value: `${summary.first_shot_rate ?? 0}%`,
      tone: "good",
    },
    {
      label: "Needed Fix",
      value: summary.needed_fix ?? 0,
      tone: "warn",
    },
    {
      label: "Failed",
      value: summary.failed ?? 0,
      tone: "error",
    },
  ];

  /* Trend indicator helper */
  const trend = (val) =>
    val > 0
      ? html`<span class="stat-trend up">▲</span>`
      : val < 0
        ? html`<span class="stat-trend down">▼</span>`
        : null;

  /* Historical sparkline data */
  const history = getDashboardHistory();
  const sparkData = (metric) => history.map((h) => h[metric] ?? 0);

  const segments = [
    { label: "Running", value: running, color: "var(--color-inprogress)" },
    { label: "Review", value: review, color: "var(--color-inreview)" },
    { label: "Blocked", value: blocked, color: "var(--color-error)" },
    { label: "Backlog", value: backlog, color: "var(--color-todo)" },
    { label: "Done", value: done, color: "var(--color-done)" },
  ].filter((s) => s.value > 0);

  /* ── Executor controls ── */
  const handlePause = async () => {
    haptic("medium");
    const confirmed = await showConfirm(
      "Pause the executor? Active tasks will finish but no new ones will start.",
    );
    if (!confirmed) return;
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: true };
      },
      () => apiFetch("/api/executor/pause", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleResume = async () => {
    haptic("medium");
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: false };
      },
      () => apiFetch("/api/executor/resume", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  /* ── Quick-action handler ── */
  const handleQuickAction = async (action, e) => {
    haptic();
    if (action.targetTab) {
      navigateTo(action.targetTab, {
        resetHistory: action.targetTab === "dashboard",
        forceRefresh: true,
      });
    }
    if (action.action === "create") {
      setShowCreate(true);
    } else if (action.action === "start") {
      setShowStartModal(true);
    } else if (action.cmd) {
      try {
        if (action.cmd.startsWith("/status")) {
          await refreshTab("dashboard", { force: true });
          showToast("Status refreshed", "success");
        } else if (action.cmd.startsWith("/health")) {
          const res = await apiFetch("/api/health", { _silent: true });
          const uptime = Number(res?.uptime || 0);
          showToast(`Health OK · uptime ${Math.round(uptime)}s`, "success");
        } else if (action.cmd.startsWith("/logs")) {
          await refreshTab("logs", { force: true });
          showToast("Opened logs", "success");
        } else if (action.cmd.startsWith("/menu")) {
          await sendCommandToChat(action.cmd);
          showToast("Opened control panel", "success");
          scheduleRefresh(60);
        } else if (action.cmd.startsWith("/plan")) {
          await sendCommandToChat(action.cmd);
          showToast("Planner dispatched", "success");
          scheduleRefresh(120);
        } else {
          await sendCommandToChat(action.cmd);
          showToast(`Sent: ${action.cmd}`, "success");
          scheduleRefresh(120);
        }
        const btn = e?.currentTarget;
        if (btn) {
          btn.classList.add("quick-action-sent");
          setTimeout(() => btn.classList.remove("quick-action-sent"), 1500);
        }
      } catch {
        showToast("Command failed", "error");
      }
    }
  };

  const handleModalStart = useCallback(async ({ taskId, sdk, model }) => {
    if (!taskId) return;
    await apiFetch("/api/tasks/start", {
      method: "POST",
      body: JSON.stringify({
        taskId,
        ...(sdk ? { sdk } : {}),
        ...(model ? { model } : {}),
      }),
    });
    showToast("Task started", "success");
    scheduleRefresh(150);
  }, []);

  /* ── Recent activity (last 5 tasks from global tasks signal) ── */
  const recentTasks = (tasksData.value || []).slice(0, 5);

  /* ── Loading skeleton ── */
  if (!status && !executor)
    return html`<${Card} title="Loading…"><${SkeletonCard} count=${4} /><//>`;

  return html`
    <div class="dashboard-shell">
      <div class="dashboard-header">
        <div class="dashboard-header-text">
          <div class="dashboard-eyebrow">Pulse</div>
          <div class="dashboard-title">Calm system overview</div>
          <div class="dashboard-subtitle">${headerLine}</div>
        </div>
        <div class="dashboard-header-meta">
          <span class="dashboard-chip">Mode ${mode}</span>
          <span class="dashboard-chip">SDK ${defaultSdk}</span>
          ${executor
            ? executor.paused
              ? html`<${Badge} status="error" text="Paused" />`
              : html`<${Badge} status="done" text="Running" />`
            : html`<span class="dashboard-chip">Executor · —</span>`}
        </div>
      </div>

      <div class="dashboard-grid">
        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.shield}</span>Health
            Summary</span
          >`}
          className="dashboard-card dashboard-health"
        >
          <div class="dashboard-status-row">
            <div class="dashboard-status-label">Executor status</div>
            <div class="dashboard-status-value">
              ${executor?.paused ? "Paused" : "Running"}
            </div>
          </div>
          <div class="dashboard-health-grid">
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Slots</div>
              <div class="dashboard-health-value">
                ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Error rate</div>
              <div class="dashboard-health-value">${errorRate}%</div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Active</div>
              <div class="dashboard-health-value">${totalActive}</div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Total tasks</div>
              <div class="dashboard-health-value">${totalTasks}</div>
            </div>
          </div>
          <div class="dashboard-health-progress">
            <div class="dashboard-progress-meta">
              <span>Slot utilization</span>
              <span>${Math.round(slotPct)}%</span>
            </div>
            <${ProgressBar} percent=${slotPct} />
          </div>
          <div class="dashboard-inline-actions">
            <button
              class="btn btn-secondary btn-sm dashboard-btn"
              onClick=${handlePause}
            >
              Pause
            </button>
            <button
              class="btn btn-secondary btn-sm dashboard-btn"
              onClick=${handleResume}
            >
              Resume
            </button>
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.grid}</span>Overview</span
          >`}
          className="dashboard-card dashboard-overview"
        >
          <div class="dashboard-metric-grid">
            ${overviewMetrics.map(
              (metric) => html`
                <div class="dashboard-metric">
                  <div class="dashboard-metric-label">${metric.label}</div>
                  <div
                    class="dashboard-metric-value"
                    style="color: ${metric.color}"
                  >
                    ${metric.value} ${trend(metric.trend)}
                  </div>
                  <div class="dashboard-metric-spark">
                    <${MiniSparkline}
                      data=${sparkData(metric.spark)}
                      color=${metric.color}
                      height=${20}
                      width=${90}
                    />
                  </div>
                </div>
              `,
            )}
          </div>
          ${segments.length > 0 && html`
            <div class="dashboard-work-layout" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
              <div class="dashboard-work-list">
                ${workItems.map(
                  (item) => html`
                    <div class="dashboard-work-item">
                      <div class="dashboard-work-left">
                        <span
                          class="dashboard-work-dot"
                          style="background: ${item.color}"
                        ></span>
                        <span class="dashboard-work-label">${item.label}</span>
                      </div>
                      <span class="dashboard-work-value">${item.value}</span>
                    </div>
                  `,
                )}
              </div>
              <div class="dashboard-work-chart">
                <${DonutChart} segments=${segments} size=${90} strokeWidth=${9} />
                <div class="dashboard-work-meta">
                  ${progressPct}% engaged
                </div>
                <${ProgressBar} percent=${progressPct} />
              </div>
            </div>
          `}
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.bell}</span>Alerts</span
          >`}
          className="dashboard-card dashboard-alerts"
        >
          <div class="dashboard-alerts-wrap">
            ${alertItems.map(
              (alert) => html`
                <div class="dashboard-alert-item">
                  <div class="dashboard-alert-left">
                    <span class="dashboard-alert-dot ${alert.tone}"></span>
                    <div class="dashboard-alert-text">
                      <div class="dashboard-alert-title">${alert.label}</div>
                      <div class="dashboard-alert-meta">
                        ${alert.tone === "ok"
                          ? hasAlerts
                            ? "Stable"
                            : "All clear"
                          : "Needs attention"}
                      </div>
                    </div>
                  </div>
                  <div class="dashboard-alert-value">${alert.value}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.bosun}</span>Quick
            Actions</span
          >`}
          className="dashboard-card dashboard-actions"
        >
          <div class="dashboard-actions-grid">
            ${QUICK_ACTIONS.map(
              (a) => html`
                <button
                  key=${a.label}
                  class="dashboard-action-btn"
                  style="--qa-color: ${a.color}"
                  onClick=${(e) => handleQuickAction(a, e)}
                >
                  <span class="dashboard-action-icon">${a.icon}</span>
                  <span class="dashboard-action-label">${a.label}</span>
                </button>
              `,
            )}
          </div>
        <//>

        ${project &&
        html`
          <${Card}
            title=${html`<span class="dashboard-card-title"
              ><span class="dashboard-title-icon">${ICONS.server}</span>Project</span
            >`}
            className="dashboard-card dashboard-project"
          >
            <div class="dashboard-project-name">
              ${project.name || project.id || "Current Project"}
            </div>
            ${project.description &&
            html`<div class="dashboard-project-desc">
              ${truncate(project.description, 160)}
            </div>`}
            ${project.taskCount != null &&
            html`
              <div class="dashboard-project-grid">
                <div class="dashboard-project-item">
                  <div class="dashboard-project-label">Tasks</div>
                  <div class="dashboard-project-value">
                    ${project.taskCount}
                  </div>
                </div>
                <div class="dashboard-project-item">
                  <div class="dashboard-project-label">Completed</div>
                  <div
                    class="dashboard-project-value"
                    style="color: var(--color-done)"
                  >
                    ${project.completedCount ?? 0}
                  </div>
                </div>
              </div>
            `}
          <//>
        `}

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.star}</span>Quality</span
          >`}
          className="dashboard-card dashboard-quality"
        >
          <div class="dashboard-quality-grid">
            ${qualityItems.map(
              (item) => html`
                <div class="dashboard-quality-item tone-${item.tone}">
                  <div class="dashboard-quality-value">${item.value}</div>
                  <div class="dashboard-quality-label">${item.label}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.clock}</span>Recent
            Activity</span
          >`}
          className="dashboard-card dashboard-activity"
        >
          <div class="dashboard-activity-list">
            ${recentTasks.length
              ? recentTasks.map(
                  (task) => html`
                    <div key=${task.id} class="list-item">
                      <div class="list-item-content">
                        <div class="list-item-title">
                          ${truncate(task.title || "(untitled)", 50)}
                        </div>
                        <div class="meta-text">
                          ${task.id}${(task.updated_at || task.updated)
                            ? ` · ${formatRelative(task.updated_at || task.updated)}`
                            : ""}
                        </div>
                      </div>
                      <${Badge} status=${task.status} text=${task.status} />
                    </div>
                  `,
                )
              : html`<${EmptyState} message="No recent tasks" />`}
          </div>
        <//>
      </div>

      ${showCreate &&
      html`<${CreateTaskModal} onClose=${() => setShowCreate(false)} />`}

      ${showStartModal &&
      html`
        <${StartTaskModal}
          task=${null}
          defaultSdk=${defaultSdk}
          allowTaskIdInput=${true}
          onClose=${() => setShowStartModal(false)}
          onStart=${handleModalStart}
        />
      `}
    </div>
  `;
}
