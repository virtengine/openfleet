/* ─────────────────────────────────────────────────────────────
 *  Tab: Dashboard — overview stats, executor, quick actions
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
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
  loadRetryQueue,
  retryQueueData,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  getTrend,
  getDashboardHistory,
  setPendingChange,
  clearPendingChange,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  truncate,
  countChangedFields,
} from "../modules/utils.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  Card,
  Badge,
  SkeletonCard,
  Modal,
  EmptyState,
  SaveDiscardBar,
} from "../components/shared.js";
import { DonutChart, ProgressBar, MiniSparkline } from "../components/charts.js";
import {
  SegmentedControl,
  PullToRefresh,
  SliderControl,
} from "../components/forms.js";
import { StartTaskModal } from "./tasks.js";
import {
  Button, TextField, Typography, Box, Stack, Chip, Paper,
  IconButton, Tooltip, CircularProgress, Alert,
} from "@mui/material";

/* ─── Quick Action definitions ─── */
const QUICK_ACTIONS = [
  {
    label: "Status",
    cmd: "/status",
    icon: "chart",
    color: "var(--accent)",
    targetTab: "dashboard",
  },
  {
    label: "Health",
    cmd: "/health",
    icon: "heart",
    color: "var(--color-done)",
    targetTab: "dashboard",
  },
  {
    label: "Create Task",
    action: "create",
    icon: "plus",
    color: "var(--color-inprogress)",
  },
  {
    label: "Start Task",
    action: "start",
    icon: "play",
    color: "var(--color-todo)",
  },
  {
    label: "Plan",
    cmd: "/plan",
    icon: "clipboard",
    color: "var(--color-inreview)",
    targetTab: "control",
  },
  {
    label: "Logs",
    cmd: "/logs 50",
    icon: "file",
    color: "var(--text-secondary)",
    targetTab: "logs",
  },
  {
    label: "Menu",
    cmd: "/menu",
    icon: "menu",
    color: "var(--color-todo)",
    targetTab: "control",
  },
];

/* ─── AnimatedNumber ─── */
function AnimatedNumber({ value, duration = 600, className = "" }) {
  const displayRef = useRef(value);
  const rafRef = useRef(null);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const from = displayRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(from + (to - from) * eased);
      displayRef.current = current;
      setDisplay(current);
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return html`<span class="${className}">${display}</span>`;
}

function normalizeCommitMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "";
  return text.replace(
    /^([a-z]+)\(([A-Za-z0-9._/-]+)\)(!?)(\s*:)/,
    (_m, type, scope, bang, suffix) => type + "(" + scope.toLowerCase() + ")" + bang + suffix,
  );
}

/* ─── CreateTaskModal ─── */
export function CreateTaskModal({ onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [submitting, setSubmitting] = useState(false);
  const initialSnapshotRef = useRef({
    title: "",
    description: "",
    priority: "medium",
  });
  const pendingKey = "modal:create-task-dashboard";

  const currentSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      priority: priority || "medium",
    }),
    [description, priority, title],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, currentSnapshot),
    [currentSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setPriority(base.priority || "medium");
    showToast("Changes discarded", "info");
  }, []);

  const handleSubmit = useCallback(async ({ closeAfterSave = true } = {}) => {
    if (!title.trim()) {
      showToast("Title is required", "error");
      return false;
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
      initialSnapshotRef.current = {
        title: title.trim(),
        description: description.trim(),
        priority,
      };
      if (closeAfterSave) {
        onClose?.();
      }
      await refreshTab("dashboard");
      return closeAfterSave ? { closed: true } : true;
    } catch {
      /* toast shown by apiFetch */
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, onClose]);

  /* Telegram MainButton integration */
  useEffect(() => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.MainButton) {
      tg.MainButton.setText("Create Task");
      tg.MainButton.show();
      const handler = () => {
        void handleSubmit({ closeAfterSave: true });
      };
      tg.MainButton.onClick(handler);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handler);
      };
    }
  }, [handleSubmit]);

  return html`
    <${Modal}
      title="Create Task"
      onClose=${onClose}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSubmit({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${submitting ? "Task creation is in progress" : ""}
    >
      <div class="flex-col gap-md">
        <${TextField}
          size="small"
          variant="outlined"
          fullWidth
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <${TextField}
          multiline
          rows=${4}
          size="small"
          fullWidth
          variant="outlined"
          placeholder="Description (optional)"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        />
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
        <${Button}
          variant="contained"
          size="small"
          onClick=${() => {
            void handleSubmit({ closeAfterSave: true });
          }}
          disabled=${submitting}
        >
          ${submitting ? "Creating…" : "Create Task"}
        <//>
        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${`You have unsaved changes (${changeCount})`}
          saveLabel="Create Task"
          discardLabel="Discard"
          onSave=${() => {
            void handleSubmit({ closeAfterSave: false });
          }}
          onDiscard=${resetToInitial}
          saving=${submitting}
        />
</div>
        <//>

        ${retryQueueData.value?.count > 0 ? html`
        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon" style="color:var(--color-error)">⚠</span>Retry Queue</span
          >`}
          className="dashboard-card dashboard-retry-queue"
        >
          <div class="dashboard-retry-queue-count">
            <span class="dashboard-retry-number">${retryQueueData.value.count}</span>
            <span class="dashboard-retry-label">tasks waiting</span>
          </div>
          <div class="dashboard-retry-items">
            ${retryQueueData.value.items.slice(0, 5).map((item) => html`
              <div class="dashboard-retry-item">
                <div class="dashboard-retry-task">${truncate(item.taskTitle || item.taskId || "Unknown", 40)}</div>
                <div class="dashboard-retry-meta">
                  <span style="color:var(--color-inreview)">${item.retryCount || 1}x</span>
                  <span> · </span>
                  <span class="dashboard-retry-error">${truncate(item.lastError || "Unknown error", 50)}</span>
                </div>
              </div>
            `)}
            ${retryQueueData.value.items.length > 5 ? html`
              <div class="dashboard-retry-more">
                +${retryQueueData.value.items.length - 5} more tasks
              </div>
            ` : null}
          </div>
          <div class="dashboard-retry-actions">
            <${Button}
              variant="outlined"
              size="small"
              onClick=${() => navigateTo("control")}
            >
              View All
            <//>
          </div>
        <//>
        ` : null}

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
          <div class="dashboard-health-score">
            <div class="health-score-value" style="color: ${healthScore >= 80 ? 'var(--color-done)' : healthScore >= 50 ? 'var(--color-inreview)' : 'var(--color-error)'}">${healthScore}</div>
            <div class="health-score-label">Health Score</div>
          </div>
          <div class="dashboard-health-grid">
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Slots</div>
              <div class="dashboard-health-value">
                ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">6h fail rate</div>
              <div class="dashboard-health-value" style="color:${healthStats?.total > 0 && healthStats.failRate > 0 ? 'var(--color-error)' : 'inherit'}">
                ${healthStats?.total > 0 ? `${Math.round(healthStats.failRate * 100)}%` : "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">6h runs</div>
              <div class="dashboard-health-value">
                ${healthStats?.total > 0 ? `${healthStats.successRuns}/${healthStats.total}` : "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Blocked</div>
              <div class="dashboard-health-value" style="color:${blocked > 0 ? 'var(--color-error)' : 'inherit'}">${blocked}</div>
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
            <${Button}
              variant="outlined"
              size="small"
              onClick=${handlePause}
            >
              Pause
            <//>
            <${Button}
              variant="outlined"
              size="small"
              onClick=${handleResume}
            >
              Resume
            <//>
          </div>
          ${tickerTasks.length > 0 ? html`
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
              <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:6px;display:flex;align-items:center;gap:5px;">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--color-done);animation:errorPulse 2s ease-in-out infinite;display:inline-block;"></span>
                Live
              </div>
              <div class="fleet-ticker-wrap">
                <div class="fleet-ticker-inner">
                  ${tickerTasks.map((task) => html`
                    <div class="fleet-ticker-item">
                      <${Badge} status=${task.status} text=${task.status} />
                      <span>${truncate(task.title || "(untitled)", 38)}</span>
                    </div>
                  `)}
                </div>
              </div>
            </div>
          ` : null}
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.grid}</span>Overview</span
          >`}
          className="dashboard-card dashboard-overview"
        >
          ${fleetAtRest
            ? html`
              <div class="fleet-rest-badge">
                <div class="fleet-rest-icon">${resolveIcon("check")}</div>
                <div class="fleet-rest-label">Fleet at rest</div>
                <div class="fleet-rest-sub">${done} task${done !== 1 ? "s" : ""} completed · zero pending</div>
              </div>
            `
            : html`
              <div class="dashboard-metric-grid stat-flash" key=${flashKey}>
                ${overviewMetrics.map(
                  (metric) => html`
                    <div
                      class="dashboard-metric"
                      style="cursor:pointer;"
                      role="button"
                      tabindex="0"
                      onClick=${() => navigateTo(metric.tab || "tasks")}
                      onKeyDown=${(e) => e.key === "Enter" && navigateTo(metric.tab || "tasks")}
                    >
                      <div class="dashboard-metric-label">${metric.label}</div>
                      <div
                        class="dashboard-metric-value"
                        style="color: ${metric.color}"
                      >
                        ${typeof metric.value === "number"
                          ? html`<${AnimatedNumber} value=${metric.value} />`
                          : metric.value} ${trend(metric.trend)}
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
            `}
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
                <${Button}
                  key=${a.label}
                  variant="text"
                  size="small"
                  className="dashboard-action-btn"
                  style=${{ '--qa-color': a.color }}
                  onClick=${(e) => handleQuickAction(a, e)}
                >
                  <span class="dashboard-action-icon">${resolveIcon(a.icon) || a.icon}</span>
                  <span class="dashboard-action-label">${a.label}</span>
                <//>
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

      ${recentCommits.length > 0 && html`
        <${Card}
          title=${html`<span class="dashboard-card-title"><span class="dashboard-title-icon">${ICONS.git || resolveIcon("git")}</span>Recent Commits</span>`}
          className="dashboard-card dashboard-commits-card"
        >
          <div class="dashboard-commits">
            ${recentCommits.map((c) => {
              // Support both structured {hash,message,author,date} and legacy/alternate field names
              const hash = (c.hash || c.sha || '').slice(0, 7);
              const messageRaw = c.message || c.msg || c.subject || (typeof c === 'string' ? c.split(' ').slice(1).join(' ') : '');
              const message = normalizeCommitMessage(messageRaw);
              const author = c.author || c.authorName || '';
              const date = c.date || c.timestamp || c.authoredDate || '';
              return html`
              <div class="dashboard-commit-item" key=${hash || message}>
                <div class="dashboard-commit-hash">${hash || '???'}</div>
                <div class="dashboard-commit-msg">${truncate(message, 60)}</div>
                ${(author || date) && html`<div class="dashboard-commit-meta">${author}${author && date ? ' · ' : ''}${date ? formatRelative(date) : ''}</div>`}
              </div>`;
            })}
          </div>
        <//>  
      `}

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
