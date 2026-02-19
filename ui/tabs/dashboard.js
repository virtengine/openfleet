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
  StatCard,
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
  const errorRate =
    totalTasks > 0 ? ((blocked / totalTasks) * 100).toFixed(1) : "0.0";

  const totalActive = running + review + blocked;
  const progressPct =
    backlog + totalActive > 0
      ? Math.round((totalActive / (backlog + totalActive)) * 100)
      : 0;

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
    <!-- Stats Grid -->
    <${Card} title="Today at a Glance">
      <div class="stats-grid">
        <${StatCard}
          value=${totalTasks}
          label="Total Tasks"
          color="var(--text-primary)"
        >
          ${trend(getTrend('total'))}
          <${MiniSparkline} data=${sparkData('total')} color="var(--text-primary)" />
        <//>
        <${StatCard}
          value=${running}
          label="In Progress"
          color="var(--color-inprogress)"
        >
          ${trend(getTrend('running'))}
          <${MiniSparkline} data=${sparkData('running')} color="var(--color-inprogress)" />
        <//>
        <${StatCard} value=${done} label="Done" color="var(--color-done)">
          ${trend(getTrend('done'))}
          <${MiniSparkline} data=${sparkData('done')} color="var(--color-done)" />
        <//>
        <${StatCard}
          value="${errorRate}%"
          label="Error Rate"
          color="var(--color-error)"
        >
          ${trend(-getTrend('errors'))}
          <${MiniSparkline} data=${sparkData('errors')} color="var(--color-error)" />
        <//>
      </div>
    <//>

    <!-- Task Distribution -->
    <${Card} title="Task Distribution">
      <${DonutChart} segments=${segments} />
      <div class="meta-text text-center mt-sm">
        Active progress · ${progressPct}% engaged
      </div>
      <${ProgressBar} percent=${progressPct} />
    <//>

    <!-- Project Summary -->
    ${project &&
    html`
      <${Card} title="Project Summary" className="project-summary-card">
        <div class="meta-text mb-sm">
          ${project.name || project.id || "Current Project"}
        </div>
        ${project.description &&
        html`<div class="meta-text">
          ${truncate(project.description, 160)}
        </div>`}
        ${project.taskCount != null &&
        html`
          <div class="stats-grid mt-sm">
            <${StatCard} value=${project.taskCount} label="Tasks" />
            <${StatCard}
              value=${project.completedCount ?? 0}
              label="Completed"
              color="var(--color-done)"
            />
          </div>
        `}
      <//>
    `}

    <!-- Executor -->
    <${Card} title="Executor">
      <div class="meta-text mb-sm">
        Mode: <strong>${mode}</strong> · Slots:
        ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"} ·
        ${executor?.paused
          ? html`<${Badge} status="error" text="Paused" />`
          : html`<${Badge} status="done" text="Running" />`}
      </div>
      <${ProgressBar}
        percent=${execData?.maxParallel
          ? ((execData.activeSlots || 0) / execData.maxParallel) * 100
          : 0}
      />
      <div class="btn-row mt-sm">
        <button class="btn btn-primary btn-sm" onClick=${handlePause}>
          Pause Executor
        </button>
        <button class="btn btn-secondary btn-sm" onClick=${handleResume}>
          Resume Executor
        </button>
      </div>
    <//>

    <!-- Quick Actions -->
    <${Card} title="Quick Actions">
      <div class="quick-actions-grid">
        ${QUICK_ACTIONS.map(
          (a) => html`
            <button
              key=${a.label}
              class="quick-action-btn"
              style="--qa-color: ${a.color}"
              onClick=${(e) => handleQuickAction(a, e)}
            >
              <span class="quick-action-icon">${a.icon}</span>
              <span class="quick-action-label">${a.label}</span>
            </button>
          `,
        )}
      </div>
    <//>

    <!-- Quality -->
    <${Card} title="Quality">
      <div class="stats-grid">
        <${StatCard}
          value="${summary.first_shot_rate ?? 0}%"
          label="First-shot"
          color="var(--color-done)"
        />
        <${StatCard}
          value=${summary.needed_fix ?? 0}
          label="Needed Fix"
          color="var(--color-inreview)"
        />
        <${StatCard}
          value=${summary.failed ?? 0}
          label="Failed"
          color="var(--color-error)"
        />
      </div>
    <//>

    <!-- Recent Activity -->
    <${Card} title="Recent Activity">
      ${recentTasks.length
        ? recentTasks.map(
            (task) => html`
              <div key=${task.id} class="list-item">
                <div class="list-item-content">
                  <div class="list-item-title">
                    ${truncate(task.title || "(untitled)", 50)}
                  </div>
                  <div class="meta-text">
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
    <//>

    <!-- Create Task Modal -->
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
  `;
}
