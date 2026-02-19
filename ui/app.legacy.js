const state = {
  tab: "overview",
  status: null,
  executor: null,
  tasks: [],
  tasksTotal: 0,
  tasksPage: 0,
  tasksPageSize: 8,
  tasksStatus: "todo",
  tasksProject: "",
  tasksQuery: "",
  projects: [],
  logs: null,
  logsLines: 200,
  threads: [],
  worktrees: [],
  worktreeStats: null,
  presence: null,
  sharedWorkspaces: null,
  sharedAvailability: null,
  gitBranches: [],
  gitDiff: "",
  agentLogFiles: [],
  agentLogFile: "",
  agentLogLines: 200,
  agentLogQuery: "",
  agentLogTail: null,
  agentContext: null,
  manualMode: false,
  connected: false,
  ws: null,
  wsConnected: false,
  wsRetryMs: 1000,
  wsReconnectTimer: null,
  wsRefreshTimer: null,
  pendingMutation: false,
  modal: null,
};

const view = document.getElementById("view");
const connectionPill = document.getElementById("connection-pill");
const tabs = document.querySelectorAll(".tab");

function setConnection(status, detail = "") {
  state.connected = status;
  connectionPill.textContent = status
    ? `Connected ${detail}`.trim()
    : `Offline ${detail}`.trim();
}

function cloneStateValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value;
}

function scheduleRefresh(delayMs = 100) {
  if (state.wsRefreshTimer) {
    clearTimeout(state.wsRefreshTimer);
  }
  state.wsRefreshTimer = setTimeout(async () => {
    state.wsRefreshTimer = null;
    if (state.pendingMutation) return;
    try {
      await refreshTab();
    } catch {
      // ignore transient refresh failures
    }
  }, delayMs);
}

function channelsForTab(tab) {
  if (tab === "overview") return ["overview", "executor", "tasks", "agents"];
  if (tab === "tasks") return ["tasks"];
  if (tab === "agents") return ["agents", "executor"];
  if (tab === "worktrees") return ["worktrees"];
  if (tab === "workspaces") return ["workspaces"];
  if (tab === "executor") return ["executor", "overview"];
  return ["*"];
}

function connectRealtime() {
  const tg = telegram();
  const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = new URL(`${proto}://${globalThis.location.host}/ws`);
  if (tg?.initData) {
    wsUrl.searchParams.set("initData", tg.initData);
  }
  const socket = new WebSocket(wsUrl.toString());
  state.ws = socket;

  socket.addEventListener("open", () => {
    state.wsConnected = true;
    state.wsRetryMs = 1000;
    setConnection(true, "live");
    socket.send(
      JSON.stringify({ type: "subscribe", channels: channelsForTab(state.tab) }),
    );
  });

  socket.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data || "{}");
    } catch {
      return;
    }
    if (message?.type !== "invalidate") return;
    const channels = Array.isArray(message.channels) ? message.channels : [];
    const interested = channelsForTab(state.tab);
    const shouldRefresh =
      channels.includes("*") || channels.some((channel) => interested.includes(channel));
    if (shouldRefresh) {
      scheduleRefresh(120);
    }
  });

  socket.addEventListener("close", () => {
    state.wsConnected = false;
    setConnection(false, "reconnecting");
    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => {
      connectRealtime();
    }, state.wsRetryMs);
    state.wsRetryMs = Math.min(10000, state.wsRetryMs * 2);
  });

  socket.addEventListener("error", () => {
    setConnection(false, "ws error");
  });
}

async function runOptimisticMutation(apply, request, rollback) {
  state.pendingMutation = true;
  try {
    apply();
    render();
    const response = await request();
    state.pendingMutation = false;
    return response;
  } catch (err) {
    if (typeof rollback === "function") rollback();
    state.pendingMutation = false;
    render();
    throw err;
  }
}

function telegram() {
  return globalThis.Telegram ? globalThis.Telegram.WebApp : null;
}

function sendCommandToChat(command) {
  const tg = telegram();
  if (!tg) return;
  tg.sendData(JSON.stringify({ type: "command", command }));
  if (tg.showPopup) {
    tg.showPopup({ title: "Sent", message: command, buttons: [{ type: "ok" }] });
  }
}

async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const tg = telegram();
  if (tg?.initData) {
    headers["X-Telegram-InitData"] = tg.initData;
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadOverview() {
  const status = await apiFetch("/api/status").catch(() => ({ data: null }));
  const executor = await apiFetch("/api/executor").catch(() => ({ data: null }));
  state.status = status.data || null;
  state.executor = executor;
}

async function loadProjects() {
  const res = await apiFetch("/api/projects").catch(() => ({ data: [] }));
  state.projects = res.data || [];
  if (!state.tasksProject && state.projects.length) {
    state.tasksProject = state.projects[0].id || "";
  }
}

async function loadTasks() {
  const params = new URLSearchParams({
    status: state.tasksStatus,
    page: String(state.tasksPage),
    pageSize: String(state.tasksPageSize),
  });
  if (state.tasksProject) params.set("project", state.tasksProject);
  const res = await apiFetch(`/api/tasks?${params.toString()}`);
  state.tasks = res.data || [];
  state.tasksTotal = res.total || 0;
}

async function loadLogs() {
  const res = await apiFetch(`/api/logs?lines=${state.logsLines}`);
  state.logs = res.data || null;
}

async function loadThreads() {
  const res = await apiFetch("/api/threads").catch(() => ({ data: [] }));
  state.threads = res.data || [];
}

async function loadWorktrees() {
  const res = await apiFetch("/api/worktrees").catch(() => ({ data: [], stats: null }));
  state.worktrees = res.data || [];
  state.worktreeStats = res.stats || null;
}

async function loadPresence() {
  const res = await apiFetch("/api/presence").catch(() => ({ data: null }));
  state.presence = res.data || null;
}

async function loadSharedWorkspaces() {
  const res = await apiFetch("/api/shared-workspaces").catch(() => ({
    data: null,
    availability: null,
  }));
  state.sharedWorkspaces = res.data || null;
  state.sharedAvailability = res.availability || null;
}

async function loadGit() {
  const branches = await apiFetch("/api/git/branches").catch(() => ({ data: [] }));
  const diff = await apiFetch("/api/git/diff").catch(() => ({ data: "" }));
  state.gitBranches = branches.data || [];
  state.gitDiff = diff.data || "";
}

async function loadAgentLogFiles() {
  const params = new URLSearchParams();
  if (state.agentLogQuery) params.set("query", state.agentLogQuery);
  const path = params.toString()
    ? `/api/agent-logs?${params.toString()}`
    : "/api/agent-logs";
  const res = await apiFetch(path).catch(() => ({
    data: [],
  }));
  state.agentLogFiles = res.data || [];
}

async function loadAgentLogTail() {
  if (!state.agentLogFile) {
    state.agentLogTail = null;
    return;
  }
  const params = new URLSearchParams({
    file: state.agentLogFile,
    lines: String(state.agentLogLines),
  });
  const res = await apiFetch(`/api/agent-logs?${params.toString()}`).catch(() => ({
    data: null,
  }));
  state.agentLogTail = res.data || null;
}

async function loadAgentContext(query) {
  if (!query) {
    state.agentContext = null;
    return;
  }
  const res = await apiFetch(`/api/agent-logs/context?query=${encodeURIComponent(query)}`).catch(
    () => ({ data: null }),
  );
  state.agentContext = res.data || null;
}

async function refreshTab() {
  if (state.tab === "overview") {
    await loadOverview();
  }
  if (state.tab === "tasks") {
    await loadProjects();
    await loadTasks();
  }
  if (state.tab === "agents") {
    await loadOverview();
    await loadThreads();
  }
  if (state.tab === "worktrees") {
    await loadWorktrees();
  }
  if (state.tab === "workspaces") {
    await loadSharedWorkspaces();
  }
  if (state.tab === "presence") {
    await loadPresence();
  }
  if (state.tab === "executor") {
    await loadOverview();
  }
  if (state.tab === "logs") {
    await loadLogs();
  }
  if (state.tab === "git") {
    await loadGit();
  }
  if (state.tab === "agentlogs") {
    await loadAgentLogFiles();
    await loadAgentLogTail();
  }
  render();
}

function renderOverview() {
  const counts = state.status?.counts || {};
  const summary = state.status?.success_metrics || {};
  const executor = state.executor?.data;
  const mode = state.executor?.mode || "vk";
  const totalActive =
    Number(counts.running || 0) +
    Number(counts.review || 0) +
    Number(counts.error || 0);
  const backlog = Number(state.status?.backlog_remaining || 0) || 0;
  const progressPct = backlog + totalActive > 0 ? Math.round((totalActive / (backlog + totalActive)) * 100) : 0;
  return `
    <section class="card">
      <h2>Today at a glance</h2>
      <div class="grid columns-2">
        <div class="stat"><strong>${counts.running ?? 0}</strong>Running</div>
        <div class="stat"><strong>${counts.review ?? 0}</strong>In Review</div>
        <div class="stat"><strong>${counts.error ?? 0}</strong>Blocked</div>
        <div class="stat"><strong>${state.status?.backlog_remaining ?? "?"}</strong>Backlog</div>
      </div>
      <div style="margin-top:14px">
        <div class="meta">Active progress · ${progressPct}% engaged</div>
        <div class="progress" style="margin-top:6px"><span style="width:${progressPct}%"></span></div>
      </div>
    </section>
    <section class="card">
      <h3>Executor</h3>
      <p>Mode: ${mode} · Slots: ${executor?.activeSlots ?? 0}/${executor?.maxParallel ?? "-"}</p>
      <p>Paused: ${state.executor?.paused ? "Yes" : "No"}</p>
      <div class="button-row">
        <button class="action" data-action="executor:pause">Pause</button>
        <button class="action secondary" data-action="executor:resume">Resume</button>
      </div>
    </section>
    <section class="card">
      <h3>Quality</h3>
      <p>First-shot: ${summary.first_shot_rate ?? 0}% · Needed fix: ${summary.needed_fix ?? 0} · Failed: ${summary.failed ?? 0}</p>
      <div class="button-row">
        <button class="action muted" data-action="command:/status">Send /status to chat</button>
        <button class="action muted" data-action="command:/health">Send /health</button>
      </div>
    </section>
  `;
}

function renderTasks() {
  const canManual = Boolean(state.executor?.data);
  const totalPages = Math.max(1, Math.ceil((state.tasksTotal || 0) / state.tasksPageSize));
  const search = state.tasksQuery.trim().toLowerCase();
  const visibleTasks = search
    ? state.tasks.filter((task) => {
        const hay = `${task.title || ""} ${task.description || ""} ${task.id || ""}`.toLowerCase();
        return hay.includes(search);
      })
    : state.tasks;
  const tasksHtml = visibleTasks
    .map(
      (task) => `
        <div class="task-card">
          <header>
            <div>
              <div class="task-title">${task.title || "(untitled)"}</div>
              <div class="badge">${task.id}</div>
            </div>
            <span class="badge">${task.status}</span>
          </header>
          <p>${task.description ? task.description.slice(0, 120) : "No description."}</p>
          <div class="button-row">
            ${
              state.manualMode && task.status === "todo" && canManual
                ? `<button class="action" data-action="task:start:${task.id}">Start</button>`
                : ""
            }
            <button class="action secondary" data-action="task:update:${task.id}:inreview">Mark Review</button>
            <button class="action muted" data-action="task:update:${task.id}:done">Mark Done</button>
            <button class="action muted" data-action="task:detail:${task.id}">Details</button>
          </div>
        </div>
      `,
    )
    .join("");

  const projectOptions = state.projects
    .map(
      (project) =>
        `<option value="${project.id}" ${project.id === state.tasksProject ? "selected" : ""}>${project.name || project.id}</option>`,
    )
    .join("");

  return `
    <section class="card">
      <h2>Task Board</h2>
      <div class="chips">
        ${["todo", "inprogress", "inreview", "done"].map(
          (status) =>
            `<button class="chip ${state.tasksStatus === status ? "active" : ""}" data-action="tasks:filter:${status}">${status.toUpperCase()}</button>`,
        ).join("")}
      </div>
      <div class="input-row" style="margin-top:12px">
        <select data-action="tasks:project">
          ${projectOptions}
        </select>
        <label class="switch" data-action="manual:toggle">
          <input type="checkbox" ${state.manualMode ? "checked" : ""} ${canManual ? "" : "disabled"} />
          <span class="switch-track"><span class="switch-thumb"></span></span>
          Manual Mode
        </label>
      </div>
      <div class="input-row" style="margin-top:12px">
        <input type="text" data-action="tasks:search" placeholder="Search tasks..." value="${state.tasksQuery}" />
        <span class="pill">${visibleTasks.length} shown</span>
      </div>
      <div class="list" style="margin-top:16px">
        ${tasksHtml || "<p>No tasks found.</p>"}
      </div>
      <div class="pager" style="margin-top:16px">
        <button class="action xs muted" data-action="tasks:prev">Prev</button>
        <span>Page ${state.tasksPage + 1} / ${totalPages}</span>
        <button class="action xs muted" data-action="tasks:next">Next</button>
      </div>
    </section>
  `;
}

function renderAgents() {
  const executor = state.executor?.data;
  const slots = executor?.slots || [];
  const slotsHtml = slots
    .map(
      (slot) => `
        <div class="task-card">
          <header>
            <div>
              <div class="task-title">${slot.taskTitle}</div>
              <div class="badge">${slot.taskId}</div>
            </div>
            <span class="badge">${slot.status}</span>
          </header>
          <p>Agent ${slot.agentInstanceId || "n/a"} · ${slot.sdk} · Attempt ${slot.attempt}</p>
          <div class="button-row">
            <button class="action muted" data-action="command:/agentlogs ${slot.branch || slot.taskId}">View Logs</button>
            <button class="action secondary" data-action="command:/steer focus on ${slot.taskTitle}">Steer</button>
            <button class="action muted" data-action="agentlogs:search:${(slot.taskId || slot.branch || "").slice(0, 12)}">Log Files</button>
          </div>
        </div>
      `,
    )
    .join("");

  const threadsHtml = state.threads
    .map(
      (thread) => `
        <div class="stat">
          <strong>${thread.taskKey}</strong>
          <div>SDK: ${thread.sdk}</div>
          <div>Turns: ${thread.turnCount}</div>
        </div>
      `,
    )
    .join("");

  return `
    <section class="card">
      <h2>Active Agents</h2>
      <div class="list">${slotsHtml || "<p>No active agents.</p>"}</div>
    </section>
    <section class="card">
      <h3>Threads</h3>
      <div class="grid columns-2">${threadsHtml || "<p>No threads.</p>"}</div>
    </section>
  `;
}

function renderWorktrees() {
  const stats = state.worktreeStats || {};
  const worktrees = state.worktrees || [];
  const listHtml = worktrees
    .map((wt) => {
      const ageMin = Math.round((wt.age || 0) / 60000);
      const ageStr = ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
      const taskKey = wt.taskKey ? ` · ${wt.taskKey}` : "";
      return `
        <div class="task-card">
          <header>
            <div>
              <div class="task-title">${wt.branch || "(detached)"}</div>
              <div class="meta">${wt.path}</div>
            </div>
            <span class="badge">${wt.status || "active"}</span>
          </header>
          <p>Age ${ageStr}${taskKey} ${wt.owner ? `· Owner ${wt.owner}` : ""}</p>
          <div class="button-row">
            ${wt.taskKey ? `<button class="action muted" data-action="worktrees:release:${wt.taskKey}">Release</button>` : ""}
            ${wt.branch ? `<button class="action muted" data-action="worktrees:release-branch:${wt.branch}">Release Branch</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <section class="card">
      <h2>Worktrees</h2>
      <div class="data-grid">
        <div class="stat"><strong>${stats.total ?? worktrees.length}</strong>Total</div>
        <div class="stat"><strong>${stats.active ?? 0}</strong>Active</div>
        <div class="stat"><strong>${stats.stale ?? 0}</strong>Stale</div>
      </div>
      <div class="input-row" style="margin-top:12px">
        <input id="worktree-release-input" type="text" placeholder="Task key or branch" />
        <button class="action muted" data-action="worktrees:release-input">Release</button>
        <button class="action secondary" data-action="worktrees:prune">Prune stale</button>
      </div>
    </section>
    <section class="card">
      <h3>Active Worktrees</h3>
      <div class="list">${listHtml || "<p>No worktrees tracked.</p>"}</div>
    </section>
  `;
}

function renderWorkspaces() {
  const registry = state.sharedWorkspaces;
  const workspaces = registry?.workspaces || [];
  const availability = state.sharedAvailability || {};
  const availabilityHtml = Object.entries(availability)
    .map(
      ([key, value]) =>
        `<span class="pill">${key}: ${value}</span>`,
    )
    .join("");
  const workspaceHtml = workspaces
    .map((ws) => {
      const lease = ws.lease;
      const leaseInfo = lease
        ? `Leased to ${lease.owner} until ${new Date(lease.lease_expires_at).toLocaleString()}`
        : "Available";
      return `
        <div class="task-card">
          <header>
            <div>
              <div class="task-title">${ws.name || ws.id}</div>
              <div class="meta">${ws.provider || "provider"} · ${ws.region || "region?"}</div>
            </div>
            <span class="badge">${ws.availability}</span>
          </header>
          <p>${leaseInfo}</p>
          <div class="button-row">
            <button class="action" data-action="shared:claim:${ws.id}">Claim</button>
            <button class="action secondary" data-action="shared:renew:${ws.id}">Renew</button>
            <button class="action muted" data-action="shared:release:${ws.id}">Release</button>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <section class="card">
      <h2>Shared Workspaces</h2>
      <div class="chips">${availabilityHtml || "<span class=\"pill\">No registry</span>"}</div>
      <div class="input-row" style="margin-top:12px">
        <input id="shared-owner" type="text" placeholder="Owner (e.g. you@team)" />
        <input id="shared-ttl" type="number" min="30" step="15" placeholder="TTL (min)" />
        <input id="shared-note" type="text" placeholder="Note (optional)" />
      </div>
    </section>
    <section class="card">
      <h3>Workspace Pool</h3>
      <div class="list">${workspaceHtml || "<p>No shared workspaces configured.</p>"}</div>
    </section>
  `;
}

function renderPresence() {
  const instances = state.presence?.instances || [];
  const coordinator = state.presence?.coordinator || null;
  const instanceHtml = instances
    .map((inst) => {
      const lastSeen = inst.last_seen_at
        ? new Date(inst.last_seen_at).toLocaleString()
        : "unknown";
      return `
        <div class="stat">
          <strong>${inst.instance_label || inst.instance_id}</strong>
          <div>${inst.workspace_role || "workspace"} · ${inst.host || "host"}</div>
          <div class="meta">Last seen ${lastSeen}</div>
        </div>
      `;
    })
    .join("");

  return `
    <section class="card">
      <h2>Presence</h2>
      <p>Active openfleet instances discovered via presence beacons.</p>
      <div class="stat">
        <strong>${coordinator?.instance_label || coordinator?.instance_id || "none"}</strong>
        <div>Coordinator</div>
        <div class="meta">Priority ${coordinator?.coordinator_priority ?? "-"}</div>
      </div>
    </section>
    <section class="card">
      <h3>Instances</h3>
      <div class="data-grid">${instanceHtml || "<p>No active instances.</p>"}</div>
    </section>
  `;
}

function renderGit() {
  const branchesHtml = state.gitBranches
    .map((line) => `<div class="meta">${line}</div>`)
    .join("");
  return `
    <section class="card">
      <h2>Git Snapshot</h2>
      <div class="button-row">
        <button class="action muted" data-action="git:refresh">Refresh</button>
        <button class="action muted" data-action="command:/diff">Send /diff</button>
      </div>
      <div style="margin-top:12px">
        <h3>Working Tree Diff</h3>
        <div class="log-box">${state.gitDiff || "Clean working tree."}</div>
      </div>
    </section>
    <section class="card">
      <h3>Recent Branches</h3>
      <div class="list-compact">${branchesHtml || "<p>No branches found.</p>"}</div>
    </section>
    <section class="card">
      <h3>Run Git Command</h3>
      <div class="input-row">
        <input id="git-command" type="text" placeholder="log --oneline -5" />
        <button class="action" data-action="command:git">Send</button>
      </div>
    </section>
  `;
}

function renderAgentLogs() {
  const logList = state.agentLogFiles
    .map(
      (file) => `
        <div class="task-card">
          <header>
            <div>
              <div class="task-title">${file.name}</div>
              <div class="meta">${Math.round(file.size / 1024)}kb · ${new Date(file.mtime).toLocaleString()}</div>
            </div>
            <span class="badge">log</span>
          </header>
          <div class="button-row">
            <button class="action muted" data-action="agentlogs:open:${file.name}">Open</button>
          </div>
        </div>
      `,
    )
    .join("");
  const tailText = state.agentLogTail?.lines ? state.agentLogTail.lines.join("\n") : "Select a log file.";
  const tailMeta = state.agentLogTail?.truncated ? `<span class="pill">Tail clipped</span>` : "";

  return `
    <section class="card">
      <h2>Agent Log Library</h2>
      <div class="input-row">
        <input id="agentlog-search" type="text" placeholder="Search log files" value="${state.agentLogQuery}" />
        <button class="action muted" data-action="agentlogs:search">Search</button>
      </div>
      <div class="range-row" style="margin-top:10px">
        <input type="range" min="50" max="800" step="50" value="${state.agentLogLines}" data-action="agentlogs:lines" />
        <span class="pill">${state.agentLogLines} lines</span>
      </div>
    </section>
    <section class="card">
      <h3>Log Files</h3>
      <div class="list">${logList || "<p>No log files found.</p>"}</div>
    </section>
    <section class="card">
      <h3>${state.agentLogFile || "Log Tail"} ${tailMeta}</h3>
      <div class="log-box">${tailText}</div>
    </section>
    <section class="card">
      <h3>Worktree Context</h3>
      <div class="input-row">
        <input id="agentlog-context" type="text" placeholder="Worktree search (branch fragment)" />
        <button class="action muted" data-action="agentlogs:context">Load</button>
      </div>
      <div class="log-box" style="margin-top:12px">${
        state.agentContext
          ? [
              `Worktree: ${state.agentContext.name || "?"}`,
              "",
              state.agentContext.gitLog || "No git log.",
              "",
              state.agentContext.gitStatus || "Clean worktree.",
              "",
              state.agentContext.diffStat || "No diff stat.",
            ].join("\n")
          : "Load a worktree context to view git log/status."
      }</div>
    </section>
  `;
}

function renderExecutor() {
  const executor = state.executor?.data;
  const mode = state.executor?.mode || "vk";
  return `
    <section class="card">
      <h2>Executor Status</h2>
      <p>Mode: ${mode}</p>
      <p>Slots: ${executor?.activeSlots ?? 0}/${executor?.maxParallel ?? "-"}</p>
      <p>Poll: ${executor?.pollIntervalMs ? executor.pollIntervalMs / 1000 : "-"}s · Timeout: ${executor?.taskTimeoutMs ? Math.round(executor.taskTimeoutMs / 60000) : "-"}m</p>
      <div class="range-row" style="margin-top:12px">
        <input type="range" min="0" max="20" step="1" value="${executor?.maxParallel ?? 0}" data-action="executor:maxparallel" />
        <span class="pill">Max ${executor?.maxParallel ?? "-"}</span>
      </div>
      <div class="button-row">
        <button class="action" data-action="executor:pause">Pause</button>
        <button class="action secondary" data-action="executor:resume">Resume</button>
        <button class="action muted" data-action="command:/executor">Send /executor</button>
      </div>
    </section>
  `;
}

function renderLogs() {
  const logText = state.logs?.lines ? state.logs.lines.join("\n") : "No logs yet.";
  return `
    <section class="card">
      <h2>Logs</h2>
      <div class="chips">
        ${[50, 200, 500].map(
          (lines) =>
            `<button class="chip ${state.logsLines === lines ? "active" : ""}" data-action="logs:lines:${lines}">${lines} lines</button>`,
        ).join("")}
      </div>
      <div class="range-row" style="margin-top:10px">
        <input type="range" min="20" max="800" step="20" value="${state.logsLines}" data-action="logs:slider" />
        <span class="pill">${state.logsLines} lines</span>
      </div>
      <div class="log-box" style="margin-top:14px">${logText}</div>
      <div class="button-row" style="margin-top:12px">
        <button class="action muted" data-action="command:/logs ${state.logsLines}">Send /logs to chat</button>
      </div>
    </section>
  `;
}

function renderCommands() {
  return `
    <section class="card">
      <h2>Command Console</h2>
      <p>Send any slash command to the bot. Responses appear in chat.</p>
      <div class="input-row">
        <input type="text" id="command-input" placeholder="/status" />
        <button class="action" data-action="command:send">Send</button>
      </div>
      <div class="button-row" style="margin-top:12px">
        <button class="action muted" data-action="command:/menu">Open Chat Menu</button>
        <button class="action secondary" data-action="command:/helpfull">All Commands</button>
      </div>
    </section>
    <section class="card">
      <h3>Task Ops</h3>
      <div class="input-row">
        <input id="starttask-input" type="text" placeholder="Task ID" />
        <button class="action muted" data-action="command:starttask">Start Task</button>
      </div>
      <div class="input-row" style="margin-top:10px">
        <input id="retry-input" type="text" placeholder="Retry reason" />
        <button class="action secondary" data-action="command:retry">Retry</button>
        <button class="action muted" data-action="command:/plan">Plan</button>
      </div>
    </section>
    <section class="card">
      <h3>Agent Control</h3>
      <div class="input-row">
        <textarea id="ask-input" rows="2" placeholder="Ask the agent..."></textarea>
        <button class="action" data-action="command:ask">Ask</button>
      </div>
      <div class="input-row" style="margin-top:10px">
        <input id="steer-input" type="text" placeholder="Steer prompt (focus on...)" />
        <button class="action secondary" data-action="command:steer">Steer</button>
      </div>
    </section>
    <section class="card">
      <h3>Routing</h3>
      <div class="segmented">
        ${["codex", "copilot", "claude", "auto"].map(
          (sdk) =>
            `<button data-action="command:sdk:${sdk}">${sdk}</button>`,
        ).join("")}
      </div>
      <div class="segmented" style="margin-top:10px">
        ${["vk", "github", "jira"].map(
          (backend) =>
            `<button data-action="command:kanban:${backend}">${backend}</button>`,
        ).join("")}
      </div>
      <div class="segmented" style="margin-top:10px">
        ${["us", "sweden", "auto"].map(
          (region) =>
            `<button data-action="command:region:${region}">${region}</button>`,
        ).join("")}
      </div>
    </section>
    <section class="card">
      <h3>Shell / Git</h3>
      <div class="input-row">
        <input id="shell-input" type="text" placeholder="ls -la" />
        <button class="action muted" data-action="command:shell">Run /shell</button>
      </div>
      <div class="input-row" style="margin-top:10px">
        <input id="git-input" type="text" placeholder="status --short" />
        <button class="action muted" data-action="command:git">Run /git</button>
      </div>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) return "";
  if (state.modal.type === "task") {
    const task = state.modal.task;
    if (!task) return "";
    const priority = task.priority || "";
    const status = task.status || "todo";
    return `
      <div class="overlay" data-overlay="true">
        <div class="modal">
          <h2>${task.title || "(untitled task)"}</h2>
          <p class="meta">ID: ${task.id}</p>
          <div class="input-row" style="margin-top:10px">
            <input id="task-edit-title" type="text" value="${task.title || ""}" placeholder="Task title" />
          </div>
          <div class="input-row" style="margin-top:10px">
            <textarea id="task-edit-description" rows="5" placeholder="Task description">${task.description || ""}</textarea>
          </div>
          <div class="input-row" style="margin-top:10px">
            <select id="task-edit-status">
              ${["todo", "inprogress", "inreview", "done", "cancelled"]
                .map((item) => `<option value="${item}" ${item === status ? "selected" : ""}>${item}</option>`)
                .join("")}
            </select>
            <select id="task-edit-priority">
              <option value="" ${priority ? "" : "selected"}>priority: none</option>
              ${["low", "medium", "high", "critical"]
                .map((item) => `<option value="${item}" ${item === priority ? "selected" : ""}>priority: ${item}</option>`)
                .join("")}
            </select>
          </div>
          <div class="button-row" style="margin-top:14px">
            ${state.manualMode && task.status === "todo" ? `<button class="action" data-action="task:start:${task.id}">Start</button>` : ""}
            <button class="action secondary" data-action="task:save:${task.id}">Save</button>
            <button class="action muted" data-action="task:update:${task.id}:inreview">Mark Review</button>
            <button class="action muted" data-action="modal:close">Close</button>
          </div>
        </div>
      </div>
    `;
  }
  return "";
}

function render() {
  tabs.forEach((tab) => {
    const target = tab.dataset.action.replace("tab:", "");
    tab.classList.toggle("active", target === state.tab);
  });

  if (state.tab === "overview") view.innerHTML = renderOverview();
  if (state.tab === "tasks") view.innerHTML = renderTasks();
  if (state.tab === "agents") view.innerHTML = renderAgents();
  if (state.tab === "worktrees") view.innerHTML = renderWorktrees();
  if (state.tab === "workspaces") view.innerHTML = renderWorkspaces();
  if (state.tab === "presence") view.innerHTML = renderPresence();
  if (state.tab === "executor") view.innerHTML = renderExecutor();
  if (state.tab === "logs") view.innerHTML = renderLogs();
  if (state.tab === "git") view.innerHTML = renderGit();
  if (state.tab === "agentlogs") view.innerHTML = renderAgentLogs();
  if (state.tab === "commands") view.innerHTML = renderCommands();
  view.insertAdjacentHTML("beforeend", renderModal());
}

async function handleAction(action, element) {
  if (action.startsWith("tab:")) {
    state.tab = action.replace("tab:", "");
    state.modal = null;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(
        JSON.stringify({ type: "subscribe", channels: channelsForTab(state.tab) }),
      );
    }
    await refreshTab();
    return;
  }
  if (action === "refresh") {
    await refreshTab();
    return;
  }
  if (action.startsWith("tasks:filter:")) {
    state.tasksStatus = action.replace("tasks:filter:", "");
    state.tasksPage = 0;
    await refreshTab();
    return;
  }
  if (action === "tasks:prev") {
    state.tasksPage = Math.max(0, state.tasksPage - 1);
    await refreshTab();
    return;
  }
  if (action === "tasks:next") {
    state.tasksPage += 1;
    await refreshTab();
    return;
  }
  if (action === "manual:toggle") {
    const input = element?.querySelector?.("input");
    if (input?.disabled) return;
    const checked =
      typeof element?.checked === "boolean" ? element.checked : input?.checked;
    state.manualMode = typeof checked === "boolean" ? checked : !state.manualMode;
    render();
    return;
  }
  if (action === "modal:close") {
    state.modal = null;
    render();
    return;
  }
  if (action.startsWith("task:start:")) {
    const taskId = action.replace("task:start:", "");
    const previousTasks = cloneStateValue(state.tasks);
    const previousModal = cloneStateValue(state.modal);
    await runOptimisticMutation(
      () => {
        state.tasks = state.tasks.map((task) =>
          task.id === taskId ? { ...task, status: "inprogress" } : task,
        );
        if (state.modal?.task?.id === taskId) {
          state.modal.task.status = "inprogress";
        }
      },
      () =>
        apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId }),
        }),
      () => {
        state.tasks = previousTasks;
        state.modal = previousModal;
      },
    ).catch((err) => alert(err.message));
    state.modal = null;
    scheduleRefresh(150);
    return;
  }
  if (action.startsWith("task:detail:")) {
    const taskId = action.replace("task:detail:", "");
    const localTask = state.tasks.find((t) => t.id === taskId) || null;
    const result = await apiFetch(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`).catch(
      () => ({ data: localTask }),
    );
    const task = result.data || localTask;
    state.modal = { type: "task", task };
    render();
    return;
  }
  if (action.startsWith("task:save:")) {
    const taskId = action.replace("task:save:", "");
    const title = document.getElementById("task-edit-title")?.value ?? "";
    const description = document.getElementById("task-edit-description")?.value ?? "";
    const status = document.getElementById("task-edit-status")?.value ?? "todo";
    const priority = document.getElementById("task-edit-priority")?.value ?? "";
    const previousTasks = cloneStateValue(state.tasks);
    const previousModal = cloneStateValue(state.modal);
    await runOptimisticMutation(
      () => {
        state.tasks = state.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                title,
                description,
                status,
                priority: priority || null,
              }
            : task,
        );
        if (state.modal?.task?.id === taskId) {
          state.modal.task = {
            ...state.modal.task,
            title,
            description,
            status,
            priority: priority || null,
          };
        }
      },
      async () => {
        const response = await apiFetch("/api/tasks/edit", {
          method: "POST",
          body: JSON.stringify({ taskId, title, description, status, priority }),
        });
        if (response?.data) {
          state.tasks = state.tasks.map((task) =>
            task.id === taskId ? { ...task, ...response.data } : task,
          );
          if (state.modal?.task?.id === taskId) {
            state.modal.task = { ...state.modal.task, ...response.data };
          }
        }
        return response;
      },
      () => {
        state.tasks = previousTasks;
        state.modal = previousModal;
      },
    ).catch((err) => alert(err.message));
    render();
    return;
  }
  if (action.startsWith("task:update:")) {
    const [, taskId, status] = action.split(":");
    const previousTasks = cloneStateValue(state.tasks);
    const previousModal = cloneStateValue(state.modal);
    await runOptimisticMutation(
      () => {
        state.tasks = state.tasks.map((task) =>
          task.id === taskId ? { ...task, status } : task,
        );
        if (state.modal?.task?.id === taskId) {
          state.modal.task.status = status;
        }
      },
      async () => {
        const response = await apiFetch("/api/tasks/update", {
          method: "POST",
          body: JSON.stringify({ taskId, status }),
        });
        if (response?.data) {
          state.tasks = state.tasks.map((task) =>
            task.id === taskId ? { ...task, ...response.data } : task,
          );
          if (state.modal?.task?.id === taskId) {
            state.modal.task = { ...state.modal.task, ...response.data };
          }
        }
        return response;
      },
      () => {
        state.tasks = previousTasks;
        state.modal = previousModal;
      },
    ).catch((err) => alert(err.message));
    if (state.modal && status === "done") {
      state.modal = null;
    }
    render();
    return;
  }
  if (action === "tasks:search" && element) {
    state.tasksQuery = element.value || "";
    render();
    return;
  }
  if (action === "executor:pause") {
    const previous = cloneStateValue(state.executor);
    await runOptimisticMutation(
      () => {
        if (state.executor) state.executor.paused = true;
      },
      () => apiFetch("/api/executor/pause", { method: "POST" }),
      () => {
        state.executor = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action === "executor:resume") {
    const previous = cloneStateValue(state.executor);
    await runOptimisticMutation(
      () => {
        if (state.executor) state.executor.paused = false;
      },
      () => apiFetch("/api/executor/resume", { method: "POST" }),
      () => {
        state.executor = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action === "executor:maxparallel" && element) {
    const value = Number(element.value || "0");
    const previous = cloneStateValue(state.executor);
    await runOptimisticMutation(
      () => {
        if (state.executor?.data) {
          state.executor.data.maxParallel = value;
        }
      },
      () =>
        apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ value }),
        }),
      () => {
        state.executor = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("logs:lines:")) {
    state.logsLines = Number(action.replace("logs:lines:", "")) || 200;
    await refreshTab();
    return;
  }
  if (action === "logs:slider" && element) {
    state.logsLines = Number(element.value || "200");
    await refreshTab();
    return;
  }
  if (action === "git:refresh") {
    await loadGit();
    render();
    return;
  }
  if (action === "agentlogs:search") {
    const input = document.getElementById("agentlog-search");
    state.agentLogQuery = input?.value?.trim() || "";
    state.agentLogFile = "";
    await loadAgentLogFiles();
    await loadAgentLogTail();
    render();
    return;
  }
  if (action.startsWith("agentlogs:search:")) {
    const query = action.replace("agentlogs:search:", "");
    state.tab = "agentlogs";
    state.agentLogQuery = query;
    state.agentLogFile = "";
    await refreshTab();
    return;
  }
  if (action.startsWith("agentlogs:open:")) {
    state.agentLogFile = action.replace("agentlogs:open:", "");
    await loadAgentLogTail();
    render();
    return;
  }
  if (action === "agentlogs:lines" && element) {
    state.agentLogLines = Number(element.value || "200");
    await loadAgentLogTail();
    render();
    return;
  }
  if (action === "agentlogs:context") {
    const input = document.getElementById("agentlog-context");
    await loadAgentContext(input?.value?.trim() || "");
    render();
    return;
  }
  if (action === "worktrees:prune") {
    await apiFetch("/api/worktrees/prune", { method: "POST" }).catch((err) =>
      alert(err.message),
    );
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("worktrees:release-branch:")) {
    const branch = action.replace("worktrees:release-branch:", "");
    const previous = cloneStateValue(state.worktrees);
    await runOptimisticMutation(
      () => {
        state.worktrees = state.worktrees.filter((item) => item.branch !== branch);
      },
      () =>
        apiFetch("/api/worktrees/release", {
          method: "POST",
          body: JSON.stringify({ branch }),
        }),
      () => {
        state.worktrees = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("worktrees:release:")) {
    const taskKey = action.replace("worktrees:release:", "");
    const previous = cloneStateValue(state.worktrees);
    await runOptimisticMutation(
      () => {
        state.worktrees = state.worktrees.filter((item) => item.taskKey !== taskKey);
      },
      () =>
        apiFetch("/api/worktrees/release", {
          method: "POST",
          body: JSON.stringify({ taskKey }),
        }),
      () => {
        state.worktrees = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action === "worktrees:release-input") {
    const input = document.getElementById("worktree-release-input");
    const value = input?.value?.trim();
    if (!value) return;
    await apiFetch("/api/worktrees/release", {
      method: "POST",
      body: JSON.stringify({ taskKey: value, branch: value }),
    }).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("shared:claim:")) {
    const workspaceId = action.replace("shared:claim:", "");
    const owner = document.getElementById("shared-owner")?.value?.trim() || "";
    const ttlMinutes = Number(document.getElementById("shared-ttl")?.value || "");
    const note = document.getElementById("shared-note")?.value?.trim() || "";
    const previous = cloneStateValue(state.sharedWorkspaces);
    await runOptimisticMutation(
      () => {
        const now = Date.now();
        const ws = state.sharedWorkspaces?.workspaces?.find((item) => item.id === workspaceId);
        if (ws) {
          ws.availability = "leased";
          ws.lease = {
            owner: owner || "telegram-ui",
            lease_expires_at: new Date(now + (ttlMinutes || 60) * 60000).toISOString(),
            note,
          };
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/claim", {
          method: "POST",
          body: JSON.stringify({ workspaceId, owner, ttlMinutes, note }),
        }),
      () => {
        state.sharedWorkspaces = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("shared:renew:")) {
    const workspaceId = action.replace("shared:renew:", "");
    const owner = document.getElementById("shared-owner")?.value?.trim() || "";
    const ttlMinutes = Number(document.getElementById("shared-ttl")?.value || "");
    const previous = cloneStateValue(state.sharedWorkspaces);
    await runOptimisticMutation(
      () => {
        const ws = state.sharedWorkspaces?.workspaces?.find((item) => item.id === workspaceId);
        if (ws?.lease) {
          ws.lease.owner = owner || ws.lease.owner;
          ws.lease.lease_expires_at = new Date(
            Date.now() + (ttlMinutes || 60) * 60000,
          ).toISOString();
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/renew", {
          method: "POST",
          body: JSON.stringify({ workspaceId, owner, ttlMinutes }),
        }),
      () => {
        state.sharedWorkspaces = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action.startsWith("shared:release:")) {
    const workspaceId = action.replace("shared:release:", "");
    const owner = document.getElementById("shared-owner")?.value?.trim() || "";
    const previous = cloneStateValue(state.sharedWorkspaces);
    await runOptimisticMutation(
      () => {
        const ws = state.sharedWorkspaces?.workspaces?.find((item) => item.id === workspaceId);
        if (ws) {
          ws.availability = "available";
          ws.lease = null;
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/release", {
          method: "POST",
          body: JSON.stringify({ workspaceId, owner }),
        }),
      () => {
        state.sharedWorkspaces = previous;
      },
    ).catch((err) => alert(err.message));
    scheduleRefresh(120);
    return;
  }
  if (action === "command:send") {
    const input = document.getElementById("command-input");
    if (input && input.value) {
      sendCommandToChat(input.value.trim());
      input.value = "";
    }
    return;
  }
  if (action === "command:starttask") {
    const input = document.getElementById("starttask-input");
    const taskId = input?.value?.trim();
    if (taskId) sendCommandToChat(`/starttask ${taskId}`);
    return;
  }
  if (action === "command:retry") {
    const input = document.getElementById("retry-input");
    const reason = input?.value?.trim();
    sendCommandToChat(reason ? `/retry ${reason}` : "/retry");
    return;
  }
  if (action === "command:ask") {
    const input = document.getElementById("ask-input");
    const prompt = input?.value?.trim();
    if (prompt) {
      sendCommandToChat(`/ask ${prompt}`);
      input.value = "";
    }
    return;
  }
  if (action === "command:steer") {
    const input = document.getElementById("steer-input");
    const prompt = input?.value?.trim();
    if (prompt) {
      sendCommandToChat(`/steer ${prompt}`);
      input.value = "";
    }
    return;
  }
  if (action === "command:git") {
    const input = document.getElementById("git-input") || document.getElementById("git-command");
    const args = input?.value?.trim() || "";
    sendCommandToChat(`/git ${args}`.trim());
    return;
  }
  if (action === "command:shell") {
    const input = document.getElementById("shell-input");
    const args = input?.value?.trim() || "";
    sendCommandToChat(`/shell ${args}`.trim());
    return;
  }
  if (action.startsWith("command:sdk:")) {
    const sdk = action.replace("command:sdk:", "");
    sendCommandToChat(`/sdk ${sdk}`);
    return;
  }
  if (action.startsWith("command:kanban:")) {
    const backend = action.replace("command:kanban:", "");
    sendCommandToChat(`/kanban ${backend}`);
    return;
  }
  if (action.startsWith("command:region:")) {
    const region = action.replace("command:region:", "");
    sendCommandToChat(`/region ${region}`);
    return;
  }
  if (action.startsWith("command:")) {
    const command = action.replace("command:", "");
    sendCommandToChat(command);
    return;
  }
  if (action === "tasks:project" && element?.value) {
    state.tasksProject = element.value;
    state.tasksPage = 0;
    await refreshTab();
  }
}

document.body.addEventListener("click", (event) => {
  if (event.target?.dataset?.overlay === "true") {
    state.modal = null;
    render();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  handleAction(target.dataset.action, target);
});

document.body.addEventListener("change", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "tasks:project") {
    handleAction("tasks:project", target);
  }
  if (action === "executor:maxparallel") {
    handleAction("executor:maxparallel", target);
  }
});

document.body.addEventListener("input", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "tasks:search") {
    handleAction("tasks:search", target);
  }
  if (action === "logs:slider") {
    handleAction("logs:slider", target);
  }
  if (action === "agentlogs:lines") {
    handleAction("agentlogs:lines", target);
  }
});

async function boot() {
  const tg = telegram();
  if (tg) {
    tg.expand();
    tg.ready();
    setConnection(true, "via Telegram");
  } else {
    setConnection(false, "(open in Telegram)" );
  }
  try {
    await refreshTab();
    connectRealtime();
  } catch (err) {
    console.error(err);
    setConnection(false, "(API unavailable)");
    render();
  }
}

boot();

window.addEventListener("beforeunload", () => {
  try {
    state.ws?.close();
  } catch {
    // no-op
  }
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  if (state.wsRefreshTimer) clearTimeout(state.wsRefreshTimer);
});
