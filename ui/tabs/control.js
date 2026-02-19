/* ─────────────────────────────────────────────────────────────
 *  Tab: Control — executor, commands, routing, quick commands
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  executorData,
  configData,
  loadConfig,
  showToast,
  runOptimistic,
  scheduleRefresh,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { cloneValue, truncate } from "../modules/utils.js";
import { Card, Badge, SkeletonCard } from "../components/shared.js";
import { SegmentedControl } from "../components/forms.js";

/* ─── Command registry for autocomplete ─── */
const CMD_REGISTRY = [
  { cmd: '/status', desc: 'Show orchestrator status', cat: 'System' },
  { cmd: '/health', desc: 'Health check', cat: 'System' },
  { cmd: '/menu', desc: 'Show command menu', cat: 'System' },
  { cmd: '/helpfull', desc: 'Full help text', cat: 'System' },
  { cmd: '/plan', desc: 'Generate execution plan', cat: 'Tasks' },
  { cmd: '/logs', desc: 'View recent logs', cat: 'Logs' },
  { cmd: '/diff', desc: 'View git diff', cat: 'Git' },
  { cmd: '/steer', desc: 'Steer active agent', cat: 'Agent' },
  { cmd: '/ask', desc: 'Ask agent a question', cat: 'Agent' },
  { cmd: '/start', desc: 'Start a task', cat: 'Tasks' },
  { cmd: '/retry', desc: 'Retry failed task', cat: 'Tasks' },
  { cmd: '/cancel', desc: 'Cancel running task', cat: 'Tasks' },
  { cmd: '/shell', desc: 'Execute shell command', cat: 'Shell' },
  { cmd: '/git', desc: 'Execute git command', cat: 'Git' },
];

/* ─── Category badge colors ─── */
const CAT_COLORS = {
  System: '#6366f1', Tasks: '#f59e0b', Logs: '#10b981',
  Git: '#f97316', Agent: '#8b5cf6', Shell: '#64748b',
};

/* ─── Persistent history key & limits ─── */
const HISTORY_KEY = 've-cmd-history';
const MAX_HISTORY = 50;
const MAX_OUTPUTS = 3;
const POLL_INTERVAL = 2000;
const MAX_POLLS = 7;

/* ─── ControlTab ─── */
export function ControlTab() {
  const executor = executorData.value;
  const execData = executor?.data;
  const mode = executor?.mode || "vk";
  const config = configData.value;

  /* Form inputs */
  const [commandInput, setCommandInput] = useState("");
  const [startTaskId, setStartTaskId] = useState("");
  const [retryTaskId, setRetryTaskId] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [askInput, setAskInput] = useState("");
  const [steerInput, setSteerInput] = useState("");
  const [quickCmdInput, setQuickCmdInput] = useState("");
  const [quickCmdPrefix, setQuickCmdPrefix] = useState("shell");
  const [quickCmdFeedback, setQuickCmdFeedback] = useState("");
  const [quickCmdFeedbackTone, setQuickCmdFeedbackTone] = useState("info");
  const [maxParallel, setMaxParallel] = useState(execData?.maxParallel ?? 0);
  const [cmdHistory, setCmdHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [retryTasks, setRetryTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [startTaskError, setStartTaskError] = useState("");
  const [retryTaskError, setRetryTaskError] = useState("");
  const startTaskIdRef = useRef("");
  const retryTaskIdRef = useRef("");

  /* ── Autocomplete state ── */
  const [acItems, setAcItems] = useState([]);
  const [acIndex, setAcIndex] = useState(-1);
  const [showAc, setShowAc] = useState(false);

  /* ── Persistent history state ── */
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInputRef = useRef("");

  /* ── Inline output state ── */
  const [cmdOutputs, setCmdOutputs] = useState([]);
  const [runningCmd, setRunningCmd] = useState(null);
  const [expandedOutputs, setExpandedOutputs] = useState({});
  const pollRef = useRef(null);
  const isPaused = Boolean(executor?.paused || execData?.paused);
  const slotsLabel = `${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}`;
  const pollLabel = execData?.pollIntervalMs
    ? `${Math.round(execData.pollIntervalMs / 1000)}s`
    : "—";
  const timeoutLabel = execData?.taskTimeoutMs
    ? `${Math.round(execData.taskTimeoutMs / 60000)}m`
    : "—";

  /* ── Load persistent history on mount ── */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(HISTORY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setCmdHistory(parsed.slice(0, MAX_HISTORY));
      }
    } catch (_) { /* ignore corrupt data */ }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    startTaskIdRef.current = startTaskId;
  }, [startTaskId]);

  useEffect(() => {
    retryTaskIdRef.current = retryTaskId;
  }, [retryTaskId]);

  /* ── Autocomplete filter ── */
  useEffect(() => {
    if (commandInput.startsWith('/') && commandInput.length > 0) {
      const q = commandInput.toLowerCase();
      const matches = CMD_REGISTRY.filter((r) => r.cmd.toLowerCase().includes(q));
      setAcItems(matches);
      setAcIndex(-1);
      setShowAc(matches.length > 0);
    } else {
      setShowAc(false);
      setAcItems([]);
      setAcIndex(-1);
    }
  }, [commandInput]);

  /* ── Command history helper (persistent) ── */
  const pushHistory = useCallback((cmd) => {
    setCmdHistory((prev) => {
      const next = [cmd, ...prev.filter((c) => c !== cmd)].slice(0, MAX_HISTORY);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  }, []);

  /* ── Inline output polling ── */
  const startOutputPolling = useCallback((cmd) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const ts = new Date().toISOString();
    setRunningCmd(cmd);
    let pollCount = 0;
    let lastContent = '';

    pollRef.current = setInterval(async () => {
      pollCount++;
      try {
        const res = await apiFetch('/api/logs?lines=15', { _silent: true });
        const text = typeof res === 'string' ? res : (res?.logs || res?.data || JSON.stringify(res, null, 2));
        if (text === lastContent || pollCount >= MAX_POLLS) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRunningCmd(null);
          setCmdOutputs((prev) => {
            const entry = { cmd, ts, output: text || '(no output)' };
            const next = [entry, ...prev].slice(0, MAX_OUTPUTS);
            return next;
          });
          setExpandedOutputs((prev) => ({ ...prev, [0]: true }));
        }
        lastContent = text;
      } catch (_) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunningCmd(null);
        setCmdOutputs((prev) => {
          const entry = { cmd, ts, output: '(failed to fetch output)' };
          return [entry, ...prev].slice(0, MAX_OUTPUTS);
        });
      }
    }, POLL_INTERVAL);
  }, []);

  const sendCmd = useCallback(
    (cmd) => {
      if (!cmd.trim()) return;
      sendCommandToChat(cmd.trim());
      pushHistory(cmd.trim());
      setHistoryIndex(-1);
      startOutputPolling(cmd.trim());
    },
    [pushHistory, startOutputPolling],
  );

  /* ── Config update helper ── */
  const updateConfig = useCallback(
    async (key, value) => {
      haptic();
      try {
        await apiFetch("/api/config/update", {
          method: "POST",
          body: JSON.stringify({ key, value }),
        });
        await loadConfig();
        showToast(`${key} → ${value}`, "success");
      } catch {
        showToast(`Failed to update ${key}`, "error");
      }
    },
    [],
  );

  const refreshTaskOptions = useCallback(async () => {
    setTasksLoading(true);
    try {
      const res = await apiFetch("/api/tasks?page=0&pageSize=200", {
        _silent: true,
      });
      const all = Array.isArray(res?.data) ? res.data : [];
      const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
      const score = (t) =>
        priorityRank[String(t?.priority || "").toLowerCase()] ?? 9;
      const byPriority = (a, b) => {
        const pa = score(a);
        const pb = score(b);
        if (pa !== pb) return pa - pb;
        const ta = String(a?.updated_at || a?.updatedAt || "");
        const tb = String(b?.updated_at || b?.updatedAt || "");
        return tb.localeCompare(ta);
      };

      const backlog = all
        .filter((t) =>
          ["todo", "backlog", "open"].includes(
            String(t?.status || "").toLowerCase(),
          ),
        )
        .sort(byPriority);
      const retryable = all
        .filter((t) =>
          ["error", "cancelled", "blocked", "failed", "inreview"].includes(
            String(t?.status || "").toLowerCase(),
          ),
        )
        .sort(byPriority);

      setBacklogTasks(backlog);
      setRetryTasks(retryable);

      if (backlog.length > 0) {
        const current = String(startTaskIdRef.current || "");
        if (!backlog.some((t) => String(t?.id) === current)) {
          setStartTaskId(String(backlog[0].id || ""));
        }
      } else {
        setStartTaskId("");
      }

      if (retryable.length > 0) {
        const currentRetry = String(retryTaskIdRef.current || "");
        if (!retryable.some((t) => String(t?.id) === currentRetry)) {
          setRetryTaskId(String(retryable[0].id || ""));
        }
      } else {
        setRetryTaskId("");
      }
    } catch {
      setBacklogTasks([]);
      setRetryTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshTaskOptions();
  }, [refreshTaskOptions]);

  /* ── Executor controls ── */
  const handlePause = async () => {
    const ok = await showConfirm(
      "Pause the executor? Running tasks will finish but no new tasks will start.",
    );
    if (!ok) return;
    haptic("medium");
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

  const handleMaxParallel = async (value) => {
    setMaxParallel(value);
    haptic();
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value?.data)
          executorData.value.data.maxParallel = value;
      },
      () =>
        apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ value }),
        }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  /* ── Region options from config ── */
  const regions = config?.regions || ["auto"];
  const regionOptions = regions.map((r) => ({
    value: r,
    label: r.charAt(0).toUpperCase() + r.slice(1),
  }));

  /* ── Quick command submit ── */
  const handleQuickCmd = useCallback(() => {
    const input = quickCmdInput.trim();
    if (!input) {
      setQuickCmdFeedbackTone("error");
      setQuickCmdFeedback("Enter a command to run.");
      return;
    }
    const cmd = `/${quickCmdPrefix} ${input}`;
    sendCmd(cmd);
    setQuickCmdInput("");
    setQuickCmdFeedbackTone("success");
    setQuickCmdFeedback("✓ Command sent to monitor");
    setTimeout(() => setQuickCmdFeedback(""), 4000);
  }, [quickCmdInput, quickCmdPrefix, sendCmd]);

  /* ── Autocomplete select helper ── */
  const selectAcItem = useCallback((item) => {
    setCommandInput(item.cmd + ' ');
    setShowAc(false);
    setAcIndex(-1);
  }, []);

  /* ── Console input keydown handler ── */
  const handleConsoleKeyDown = useCallback((e) => {
    // Autocomplete navigation
    if (showAc && acItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((prev) => (prev + 1) % acItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((prev) => (prev <= 0 ? acItems.length - 1 : prev - 1));
        return;
      }
      if (e.key === 'Enter' && acIndex >= 0) {
        e.preventDefault();
        selectAcItem(acItems[acIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAc(false);
        return;
      }
    }

    // History navigation (when input is empty or already in history mode)
    if (!showAc && (commandInput === '' || historyIndex >= 0)) {
      if (e.key === 'ArrowUp' && cmdHistory.length > 0) {
        e.preventDefault();
        const nextIdx = historyIndex + 1;
        if (nextIdx < cmdHistory.length) {
          if (historyIndex === -1) savedInputRef.current = commandInput;
          setHistoryIndex(nextIdx);
          setCommandInput(cmdHistory[nextIdx]);
        }
        return;
      }
      if (e.key === 'ArrowDown' && historyIndex >= 0) {
        e.preventDefault();
        const nextIdx = historyIndex - 1;
        if (nextIdx < 0) {
          setHistoryIndex(-1);
          setCommandInput(savedInputRef.current);
        } else {
          setHistoryIndex(nextIdx);
          setCommandInput(cmdHistory[nextIdx]);
        }
        return;
      }
    }

    // Submit
    if (e.key === 'Enter' && commandInput.trim()) {
      sendCmd(commandInput.trim());
      setCommandInput('');
      setShowAc(false);
    }
  }, [showAc, acItems, acIndex, commandInput, historyIndex, cmdHistory, sendCmd, selectAcItem]);

  /* ── Toggle output accordion ── */
  const toggleOutput = useCallback((idx) => {
    setExpandedOutputs((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const handleStartTask = useCallback(async () => {
    const taskId = String(startTaskId || "").trim();
    if (!taskId) {
      setStartTaskError("Select a backlog task to start.");
      showToast("Select a backlog task to start", "error");
      return;
    }
    setStartTaskError("");
    haptic("medium");
    try {
      await apiFetch("/api/tasks/start", {
        method: "POST",
        body: JSON.stringify({ taskId }),
      });
      showToast("Task started", "success");
      refreshTaskOptions();
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
  }, [startTaskId, refreshTaskOptions]);

  const handleRetryTask = useCallback(async () => {
    const taskId = String(retryTaskId || "").trim();
    if (!taskId) {
      setRetryTaskError("Select a task to retry.");
      showToast("Select a task to retry", "error");
      return;
    }
    setRetryTaskError("");
    haptic("medium");
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          retryReason: retryReason.trim() || undefined,
        }),
      });
      showToast("Task retried", "success");
      setRetryReason("");
      refreshTaskOptions();
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
  }, [retryTaskId, retryReason, refreshTaskOptions]);

  return html`
    <!-- Loading skeleton -->
    ${!executor && !config && html`<${Card} title="Loading…"><${SkeletonCard} /><//>`}

    <!-- ── Control Unit ── -->
    <${Card}
      title="Control Unit"
      subtitle="Executor status and quick actions"
      className="control-unit-card"
    >
      <div class="control-unit-body">
        <div class="control-unit-meta">
          <span>Mode <strong>${mode}</strong></span>
          <span>Slots <strong>${slotsLabel}</strong></span>
          <span>Poll <strong>${pollLabel}</strong></span>
          <span>Timeout <strong>${timeoutLabel}</strong></span>
          <span>Status ${
            isPaused
              ? html`<${Badge} status="error" text="Paused" />`
              : html`<${Badge} status="done" text="Running" />`
          }</span>
        </div>
        <div class="control-unit-actions">
          <button class="btn btn-primary btn-sm" onClick=${handlePause}>
            Pause Executor
          </button>
          <button class="btn btn-secondary btn-sm" onClick=${handleResume}>
            Resume Executor
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => sendCmd("/executor")}
            title="Open executor menu"
          >
            /executor
          </button>
        </div>
      </div>

      <div class="form-label mt-sm">Max parallel tasks</div>
      <div class="range-row mb-md">
        <input
          type="range"
          min="0"
          max="20"
          step="1"
          value=${maxParallel}
          aria-label="Max parallel tasks"
          onInput=${(e) => setMaxParallel(Number(e.target.value))}
          onChange=${(e) => handleMaxParallel(Number(e.target.value))}
        />
        <span class="pill">Max ${maxParallel}</span>
      </div>
    <//>

    <!-- ── Command Console ── -->
    <${Card} title="Command Console">
      <div class="input-row mb-sm">
        <div style="position:relative;flex:1">
          <input
            class="input"
            placeholder="/status"
            value=${commandInput}
            onInput=${(e) => {
              setCommandInput(e.target.value);
              setHistoryIndex(-1);
            }}
            onFocus=${() => setShowHistory(true)}
            onBlur=${() => setTimeout(() => { setShowHistory(false); setShowAc(false); }, 200)}
            onKeyDown=${handleConsoleKeyDown}
          />
          <!-- Autocomplete dropdown (above input) -->
          ${showAc && acItems.length > 0 && html`
            <div class="cmd-dropdown">
              ${acItems.map((item, i) => html`
                <div
                  key=${item.cmd}
                  class="cmd-dropdown-item${i === acIndex ? ' selected' : ''}"
                  onMouseDown=${(e) => { e.preventDefault(); selectAcItem(item); }}
                  onMouseEnter=${() => setAcIndex(i)}
                >
                  <div>
                    <span style="font-weight:600;color:#e2e8f0">${item.cmd}</span>
                    <span style="margin-left:8px;color:#94a3b8;font-size:0.85em">${item.desc}</span>
                  </div>
                  <span style=${{
                    fontSize: '0.7rem', padding: '2px 8px', borderRadius: '9999px',
                    background: (CAT_COLORS[item.cat] || '#6366f1') + '33',
                    color: CAT_COLORS[item.cat] || '#6366f1', fontWeight: 600,
                  }}>${item.cat}</span>
                </div>
              `)}
            </div>
          `}
          <!-- Command history dropdown (legacy, when no autocomplete) -->
          ${!showAc && showHistory &&
          cmdHistory.length > 0 &&
          html`
            <div class="cmd-history-dropdown">
              ${cmdHistory.map(
                (c, i) => html`
                  <button
                    key=${i}
                    class="cmd-history-item"
                    onMouseDown=${(e) => {
                      e.preventDefault();
                      setCommandInput(c);
                      setShowHistory(false);
                    }}
                  >
                    ${c}
                  </button>
                `,
              )}
            </div>
          `}
        </div>
        <button
          class="btn btn-primary btn-sm"
          onClick=${() => {
            if (commandInput.trim()) {
              sendCmd(commandInput.trim());
              setCommandInput("");
            }
          }}
        >
          ${ICONS.send}
        </button>
      </div>

      <!-- Quick command chips -->
      <div class="btn-row">
        ${["/status", "/health", "/menu", "/helpfull"].map(
          (cmd) => html`
            <button
              key=${cmd}
              class="btn btn-ghost btn-sm"
              onClick=${() => sendCmd(cmd)}
            >
              ${cmd}
            </button>
          `,
        )}
      </div>

      <!-- Running indicator -->
      ${runningCmd && html`
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:0.85rem">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#facc15;animation:pulse 1s infinite"></span>
          Running: <code style="color:#e2e8f0">${runningCmd}</code>
        </div>
      `}

      <!-- Inline command outputs accordion -->
      ${cmdOutputs.length > 0 && html`
        <div style="margin-top:12px">
          ${cmdOutputs.map((entry, idx) => html`
            <div key=${idx} style="margin-bottom:6px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden">
              <button
                style="width:100%;text-align:left;padding:6px 12px;background:rgba(255,255,255,0.03);border:none;color:#cbd5e1;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:0.8rem"
                onClick=${() => toggleOutput(idx)}
              >
                <span><code style="color:#818cf8">${entry.cmd}</code></span>
                <span style="color:#64748b;font-size:0.75rem">${new Date(entry.ts).toLocaleTimeString()} ${expandedOutputs[idx] ? '▲' : '▼'}</span>
              </button>
              ${expandedOutputs[idx] && html`
                <div class="cmd-output-panel">${entry.output}</div>
              `}
            </div>
          `)}
        </div>
      `}
    <//>

    <!-- ── Task Ops ── -->
    <${Card} title="Task Ops">
      <div class="field-group">
        <div class="form-label">Backlog task</div>
        <div class="input-row">
          <select
            class=${startTaskError ? "input input-error" : "input"}
            value=${startTaskId}
            aria-label="Backlog task"
            onChange=${(e) => {
              setStartTaskId(e.target.value);
              setStartTaskError("");
            }}
          >
            <option value="">Select backlog task…</option>
            ${backlogTasks.map(
              (task) => html`
                <option key=${task.id} value=${task.id}>
                  ${truncate(task.title || "(untitled)", 48)} · ${task.id}
                </option>
              `,
            )}
          </select>
          <button
            class="btn btn-secondary btn-sm"
            disabled=${!startTaskId}
            onClick=${handleStartTask}
          >
            Start Task
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${refreshTaskOptions}
            title="Refresh task list"
          >
            ↻
          </button>
        </div>
        ${startTaskError
          ? html`<div class="form-hint error">${startTaskError}</div>`
          : null}
      </div>
      <div class="meta-text mb-sm">
        ${tasksLoading
          ? "Loading tasks…"
          : `${backlogTasks.length} backlog · ${retryTasks.length} retryable`}
      </div>
      <div class="field-group">
        <div class="form-label">Retry task</div>
        <div class="input-row">
          <select
            class=${retryTaskError ? "input input-error" : "input"}
            value=${retryTaskId}
            aria-label="Retry task"
            onChange=${(e) => {
              setRetryTaskId(e.target.value);
              setRetryTaskError("");
            }}
          >
            <option value="">Select task to retry…</option>
            ${retryTasks.map(
              (task) => html`
                <option key=${task.id} value=${task.id}>
                  ${truncate(task.title || "(untitled)", 48)} · ${task.id}
                </option>
              `,
            )}
          </select>
          <input
            class="input"
            placeholder="Retry reason (optional)"
            value=${retryReason}
            onInput=${(e) => setRetryReason(e.target.value)}
          />
          <button
            class="btn btn-secondary btn-sm"
            disabled=${!retryTaskId}
            onClick=${handleRetryTask}
          >
            Retry Task
          </button>
          <button class="btn btn-ghost btn-sm" onClick=${() => sendCmd("/plan")}>
            📋 Plan
          </button>
        </div>
        ${retryTaskError
          ? html`<div class="form-hint error">${retryTaskError}</div>`
          : null}
      </div>
    <//>

    <!-- ── Agent Control ── -->
    <${Card} title="Agent Control">
      <div class="form-label">Ask agent</div>
      <textarea
        class="input mb-sm"
        rows="2"
        placeholder="Ask the agent…"
        value=${askInput}
        onInput=${(e) => setAskInput(e.target.value)}
      ></textarea>
      <div class="btn-row mb-md">
        <button
          class="btn btn-primary btn-sm"
          onClick=${() => {
            if (askInput.trim()) {
              sendCmd(`/ask ${askInput.trim()}`);
              setAskInput("");
            }
          }}
        >
          💬 Ask
        </button>
      </div>
      <div class="form-label">Steer prompt</div>
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="Steer prompt (focus on…)"
          value=${steerInput}
          onInput=${(e) => setSteerInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() => {
            if (steerInput.trim()) {
              sendCmd(`/steer ${steerInput.trim()}`);
              setSteerInput("");
            }
          }}
        >
          🎯 Steer
        </button>
      </div>
    <//>

    <!-- ── Routing ── -->
    <${Card} title="Routing">
      <div class="card-subtitle">SDK</div>
      <${SegmentedControl}
        options=${[
          { value: "codex", label: "Codex" },
          { value: "copilot", label: "Copilot" },
          { value: "claude", label: "Claude" },
          { value: "auto", label: "Auto" },
        ]}
        value=${config?.sdk || "auto"}
        onChange=${(v) => updateConfig("sdk", v)}
      />
      <div class="card-subtitle mt-sm">Kanban</div>
      <${SegmentedControl}
        options=${[
          { value: "vk", label: "VK" },
          { value: "github", label: "GitHub" },
          { value: "jira", label: "Jira" },
        ]}
        value=${config?.kanbanBackend || "github"}
        onChange=${(v) => updateConfig("kanban", v)}
      />
      ${regions.length > 1 && html`
        <div class="card-subtitle mt-sm">Region</div>
        <${SegmentedControl}
          options=${regionOptions}
          value=${regions[0]}
          onChange=${(v) => updateConfig("region", v)}
        />
      `}
    <//>

    <!-- ── Quick Commands ── -->
    <${Card} title="Quick Commands">
      <div class="form-label">Command</div>
      <div class="input-row mb-sm">
        <select
          class="input"
          style="flex:0 0 auto;width:80px"
          value=${quickCmdPrefix}
          onChange=${(e) => setQuickCmdPrefix(e.target.value)}
        >
          <option value="shell">Shell</option>
          <option value="git">Git</option>
        </select>
        <input
          class="input"
          placeholder=${quickCmdPrefix === "shell" ? "ls -la" : "status --short"}
          value=${quickCmdInput}
          onInput=${(e) => {
            setQuickCmdInput(e.target.value);
            if (quickCmdFeedbackTone === "error") setQuickCmdFeedback("");
          }}
          onKeyDown=${(e) => {
            if (e.key === "Enter") handleQuickCmd();
          }}
          style="flex:1"
        />
        <button class="btn btn-secondary btn-sm" onClick=${handleQuickCmd}>
          ▶ Run
        </button>
      </div>
      ${quickCmdFeedback && html`
        <div class="form-hint ${quickCmdFeedbackTone === "error" ? "error" : "success"} mb-sm">
          ${quickCmdFeedback}
        </div>
      `}
      <div class="meta-text">
        Output appears in agent logs. ${""}
        <a
          href="#"
          style="color:var(--tg-theme-link-color,#4ea8d6);text-decoration:underline;cursor:pointer"
          onClick=${(e) => {
            e.preventDefault();
            import("../modules/router.js").then(({ navigateTo }) => navigateTo("logs"));
          }}
        >Open Logs tab →</a>
      </div>
    <//>

    <!-- Inline styles for new elements -->
    <style>
      .cmd-dropdown { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--glass-bg, rgba(15,23,42,0.9)); border: 1px solid var(--glass-border, rgba(255,255,255,0.08)); border-radius: 12px; max-height: 240px; overflow-y: auto; z-index: 50; backdrop-filter: blur(12px); }
      .cmd-dropdown-item { padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
      .cmd-dropdown-item.selected { background: rgba(99,102,241,0.2); }
      .cmd-dropdown-item:hover { background: rgba(99,102,241,0.15); }
      .cmd-output-panel { margin-top: 0; background: rgba(0,0,0,0.4); border-radius: 0 0 8px 8px; padding: 8px 12px; font-family: monospace; font-size: 0.8rem; color: #4ade80; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    </style>

  `;
}
