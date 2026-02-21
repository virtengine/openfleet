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
      <div class="flex flex-col gap-3">
        <input
          class="input input-bordered w-full"
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input input-bordered w-full"
          rows="4"
          placeholder="Description (optional)"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <div class="text-sm font-semibold text-base-content/70">Priority</div>
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
    return html`<div class="flex flex-col gap-4 max-w-7xl mx-auto p-4">
      <${Card} title="Loading…">
        <div class="flex flex-col gap-3">
          <${SkeletonCard} height="60px" />
          <${SkeletonCard} height="60px" />
          <${SkeletonCard} height="60px" />
          <${SkeletonCard} height="60px" />
        </div>
      <//>
    </div>`;

  return html`
    <div class="flex flex-col gap-4 max-w-7xl mx-auto">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div class="flex flex-col gap-0.5">
          <div class="text-xs font-semibold uppercase tracking-wider text-primary">Pulse</div>
          <div class="text-lg font-bold text-base-content">Calm system overview</div>
          <div class="text-sm text-base-content/60 truncate">${headerLine}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge badge-outline badge-sm">Mode ${mode}</span>
          <span class="badge badge-outline badge-sm">SDK ${defaultSdk}</span>
          ${executor
            ? executor.paused
              ? html`<${Badge} status="error" text="Paused" />`
              : html`<${Badge} status="done" text="Running" />`
            : html`<span class="badge badge-outline badge-sm">Executor · —</span>`}
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.shield}</span>Health
            Summary</span
          >`}
        >
          <div class="flex items-center justify-between py-1">
            <div class="text-sm text-base-content/60">Executor status</div>
            <div class="text-sm font-semibold">
              ${executor?.paused ? "Paused" : "Running"}
            </div>
          </div>
          <div class="stats stats-vertical lg:stats-horizontal shadow bg-base-200 w-full my-2">
            <div class="stat py-2 px-3">
              <div class="stat-desc">Slots</div>
              <div class="stat-value text-base">
                ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}
              </div>
            </div>
            <div class="stat py-2 px-3">
              <div class="stat-desc">Error rate</div>
              <div class="stat-value text-base">${errorRate}%</div>
            </div>
            <div class="stat py-2 px-3">
              <div class="stat-desc">Active</div>
              <div class="stat-value text-base">${totalActive}</div>
            </div>
            <div class="stat py-2 px-3">
              <div class="stat-desc">Total tasks</div>
              <div class="stat-value text-base">${totalTasks}</div>
            </div>
          </div>
          <div class="mt-2">
            <div class="flex items-center justify-between text-xs text-base-content/60 mb-1">
              <span>Slot utilization</span>
              <span>${Math.round(slotPct)}%</span>
            </div>
            <${ProgressBar} percent=${slotPct} />
          </div>
          <div class="flex gap-2 mt-3">
            <button
              class="btn btn-ghost btn-sm"
              onClick=${handlePause}
            >
              Pause
            </button>
            <button
              class="btn btn-ghost btn-sm"
              onClick=${handleResume}
            >
              Resume
            </button>
          </div>
        <//>

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.grid}</span>Overview</span
          >`}
        >
          <div class="grid grid-cols-2 gap-3">
            ${overviewMetrics.map(
              (metric) => html`
                <div class="flex flex-col gap-0.5">
                  <div class="text-xs text-base-content/60 truncate">${metric.label}</div>
                  <div
                    class="text-xl font-bold"
                    style="color: ${metric.color}"
                  >
                    ${metric.value} ${trend(metric.trend)}
                  </div>
                  <div class="h-5">
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
        <//>

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.check}</span>Active Work</span
          >`}
        >
          <div class="flex flex-col sm:flex-row gap-4">
            <div class="flex flex-col gap-2 flex-1">
              ${workItems.map(
                (item) => html`
                  <div class="flex items-center justify-between py-1">
                    <div class="flex items-center gap-2">
                      <span
                        class="w-2.5 h-2.5 rounded-full shrink-0"
                        style="background: ${item.color}"
                      ></span>
                      <span class="text-sm text-base-content/80">${item.label}</span>
                    </div>
                    <span class="text-sm font-semibold">${item.value}</span>
                  </div>
                `,
              )}
            </div>
            <div class="flex flex-col items-center gap-2 flex-1">
              <${DonutChart} segments=${segments} size=${110} strokeWidth=${10} />
              <div class="text-xs text-base-content/60 text-center">
                Active progress · ${progressPct}% engaged
              </div>
              <${ProgressBar} percent=${progressPct} />
            </div>
          </div>
        <//>

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.bell}</span>Alerts</span
          >`}
        >
          <div class="flex flex-col gap-2">
            ${alertItems.map(
              (alert) => html`
                <div class="flex items-center justify-between p-2 rounded-lg bg-base-300/50">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0 ${
                      alert.tone === "error" ? "bg-error" :
                      alert.tone === "warning" ? "bg-warning" : "bg-success"
                    }"></span>
                    <div class="flex flex-col">
                      <div class="text-sm font-medium">${alert.label}</div>
                      <div class="text-xs text-base-content/50">
                        ${alert.tone === "ok"
                          ? hasAlerts
                            ? "Stable"
                            : "All clear"
                          : "Needs attention"}
                      </div>
                    </div>
                  </div>
                  <div class="text-sm font-bold">${alert.value}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.bosun}</span>Quick
            Actions</span
          >`}
        >
          <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
            ${QUICK_ACTIONS.map(
              (a) => html`
                <button
                  key=${a.label}
                  class="btn btn-ghost btn-sm flex flex-col items-center gap-1 h-auto py-2"
                  onClick=${(e) => handleQuickAction(a, e)}
                >
                  <span class="text-lg">${a.icon}</span>
                  <span class="text-xs truncate">${a.label}</span>
                </button>
              `,
            )}
          </div>
        <//>

        ${project &&
        html`
          <${Card}
            title=${html`<span class="flex items-center gap-1.5"
              ><span class="text-base">${ICONS.server}</span>Project</span
            >`}
          >
            <div class="text-base font-bold truncate overflow-hidden">
              ${project.name || project.id || "Current Project"}
            </div>
            ${project.description &&
            html`<div class="text-sm text-base-content/60 mt-1 overflow-hidden truncate">
              ${truncate(project.description, 160)}
            </div>`}
            ${project.taskCount != null &&
            html`
              <div class="stats stats-vertical lg:stats-horizontal shadow bg-base-200 w-full mt-3">
                <div class="stat py-2 px-3">
                  <div class="stat-desc">Tasks</div>
                  <div class="stat-value text-base">
                    ${project.taskCount}
                  </div>
                </div>
                <div class="stat py-2 px-3">
                  <div class="stat-desc">Completed</div>
                  <div
                    class="stat-value text-base text-success"
                  >
                    ${project.completedCount ?? 0}
                  </div>
                </div>
              </div>
            `}
          <//>
        `}

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.star}</span>Quality</span
          >`}
        >
          <div class="grid grid-cols-3 gap-3">
            ${qualityItems.map(
              (item) => html`
                <div class="flex flex-col items-center p-2 rounded-lg bg-base-300/50">
                  <div class="text-lg font-bold ${
                    item.tone === "error" ? "text-error" :
                    item.tone === "warn" ? "text-warning" : "text-success"
                  }">${item.value}</div>
                  <div class="text-xs text-base-content/60">${item.label}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="flex items-center gap-1.5"
            ><span class="text-base">${ICONS.clock}</span>Recent
            Activity</span
          >`}
          className="md:col-span-2 xl:col-span-3"
        >
          <div class="flex flex-col gap-2">
            ${recentTasks.length
              ? recentTasks.map(
                  (task) => html`
                    <div key=${task.id} class="flex items-center justify-between p-2 rounded-lg hover:bg-base-300/50 transition-colors">
                      <div class="flex flex-col min-w-0 flex-1 mr-2">
                        <div class="text-sm font-medium truncate overflow-hidden">
                          ${truncate(task.title || "(untitled)", 50)}
                        </div>
                        <div class="text-xs text-base-content/50 truncate overflow-hidden">
                          ${task.id}${task.updated_at
                            ? ` · ${formatRelative(task.updated_at)}`
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
