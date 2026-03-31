import React from "react";
import htm from "htm";
import { getFooterHints } from "../../ui/tui/HelpScreen.js";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

import {
  buildOsc52CopySequence,
  formatRetryQueueCountdown,
  projectSessionRow,
  reconcileSessionEntries,
} from "./agents-screen-helpers.mjs";

const html = htm.bind(React.createElement);
const FIXED_TABLE_WIDTH = 2 + 8 + 12 + 8 + 10 + 12 + 14 + 7;
const DETAIL_POLL_MS = 1000;
const MAX_DIFF_LINES = 40;
const MAX_LOG_LINES = 20;
const PAGE_SCROLL = 8;

function pad(text, width, align = "left") {
  const value = String(text || "");
  if (width <= 0) return "";
  if (value.length >= width) return value.slice(0, width);
  if (align === "right") return `${" ".repeat(width - value.length)}${value}`;
  return `${value}${" ".repeat(width - value.length)}`;
}

function renderCell(value, width, { keyName, color, inverse, dimColor, align = "left" } = {}) {
  return html`
    <${Box} key=${keyName} width=${width}>
      <${Text} color=${color} inverse=${inverse} dimColor=${dimColor}>
        ${pad(value, width, align)}
      <//>
    <//>
  `;
}

function describeSelection(session) {
  return String(session?.id || "").slice(0, 8) || "session";
}

function sessionActionPath(sessionId, action) {
  return `/api/sessions/${encodeURIComponent(String(sessionId || "").trim())}/${action}?workspace=all`;
}

async function fetchJson(host, port, path, init) {
  const response = await fetch(`http://${host}:${port}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatTimestamp(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").replace("Z", "");
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMsDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  if (value < 1000) return `${Math.round(value)}ms`;
  return formatDuration(value);
}

function getHarnessRunState(run) {
  return String(
    run?.health?.state
    || run?.status
    || run?.outcome
    || run?.result?.status
    || run?.result?.outcome
    || "unknown",
  ).trim().toLowerCase();
}

function getHarnessStateColor(state) {
  if (state === "working") return "blue";
  if (state === "waiting") return "yellow";
  if (state === "stalled" || state === "failed" || state === "aborted") return "red";
  if (state === "completed") return "green";
  return undefined;
}

function getHarnessStateLabel(state) {
  if (!state) return "unknown";
  return state.replace(/[_-]+/g, " ");
}

function getHarnessRunTimestamp(run) {
  const value = run?.updatedAt || run?.endedAt || run?.startedAt || run?.createdAt || 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeHarnessRuns(items) {
  const deduped = new Map();
  for (const run of Array.isArray(items) ? items : []) {
    if (!run || typeof run !== "object") continue;
    const runId = String(run?.runId || "").trim();
    if (!runId) continue;
    const existing = deduped.get(runId);
    if (!existing || getHarnessRunTimestamp(run) >= getHarnessRunTimestamp(existing)) {
      deduped.set(runId, run);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => getHarnessRunTimestamp(b) - getHarnessRunTimestamp(a));
}

function formatHarnessStage(run) {
  return String(
    run?.currentStageId
    || run?.health?.approvalStageId
    || run?.stageId
    || run?.completedStageId
    || run?.result?.completedStageId
    || "—",
  ).trim() || "—";
}

function getHarnessApprovalRequestId(run) {
  return String(
    run?.health?.approvalRequestId
    || run?.approvalRequestId
    || run?.requestId
    || run?.latestApproval?.requestId
    || "",
  ).trim();
}

function getHarnessLatestEventSummary(run) {
  return String(
    run?.health?.lastEventSummary
    || run?.latestEvent?.summary
    || run?.summary
    || "",
  ).trim();
}

function getHarnessAttentionDetail(run) {
  const state = getHarnessRunState(run);
  const approvalRequestId = getHarnessApprovalRequestId(run);
  const detail = String(run?.health?.attentionReason || run?.summary || "").trim();
  if (state === "waiting") {
    const base = detail || "Awaiting operator approval.";
    return approvalRequestId ? `${base} · ${approvalRequestId}` : base;
  }
  return detail || getHarnessLatestEventSummary(run) || "No summary yet";
}

function projectHarnessRow(run, isSelected, width = 72) {
  const runId = String(run?.runId || "").trim();
  const state = getHarnessRunState(run);
  const stage = formatHarnessStage(run);
  const idleMs = Number(run?.health?.idleMs || 0) || 0;
  const summary = getHarnessLatestEventSummary(run) || getHarnessAttentionDetail(run);
  const left = `${runId.slice(0, 8) || "unknown"} ${stage} ${getHarnessStateLabel(state)}`;
  const right = idleMs > 0 ? `idle ${formatMsDuration(idleMs)}` : (run?.active ? "live" : "history");
  const head = `${left} ${right}`.trim();
  const text = `${head} · ${summary}`.trim();
  return {
    key: runId || head,
    color: getHarnessStateColor(state),
    inverse: isSelected,
    text: pad(text, width),
  };
}

function summarizeDiff(diffPayload) {
  const diff = diffPayload?.diff || {};
  const files = Array.isArray(diff.files) ? diff.files : [];
  return {
    summary: String(diffPayload?.summary || diff.formatted || "").trim() || "(no diff summary)",
    files: files.slice(0, 12).map((file) => ({
      name: file.filename || file.path || "unknown",
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
    })),
    lines: collectDiffLines(diffPayload),
  };
}

function collectDiffLines(diffPayload) {
  const candidates = [];
  if (typeof diffPayload?.diff?.formatted === "string") candidates.push(diffPayload.diff.formatted);
  if (typeof diffPayload?.summary === "string" && diffPayload.summary.includes("\n")) candidates.push(diffPayload.summary);
  const filePatches = Array.isArray(diffPayload?.diff?.files)
    ? diffPayload.diff.files.map((file) => file.patch).filter(Boolean)
    : [];
  candidates.push(...filePatches);
  const source = candidates.find((value) => String(value || "").trim()) || "";
  const allLines = String(source).split(/\r?\n/).filter((line) => line.length);
  if (allLines.length <= MAX_DIFF_LINES) {
    return { omitted: 0, visible: allLines };
  }
  return {
    omitted: allLines.length - MAX_DIFF_LINES,
    visible: allLines.slice(-MAX_DIFF_LINES),
  };
}

function sessionMessagesToLogLines(sessionPayload) {
  const messages = Array.isArray(sessionPayload?.session?.messages)
    ? sessionPayload.session.messages
    : [];
  return messages.slice(-40).map((message) => {
    const ts = formatTimestamp(message.timestamp);
    const role = String(message.role || message.type || "event").padEnd(10, " ");
    const content = String(message.content || "").replace(/\s+/g, " ").trim();
    return `${ts}  ${role}  ${content}`;
  });
}

function streamPayloadToLogLine(payload) {
  if (!payload) return "";
  const timestamp = formatTimestamp(payload.timestamp || payload.time || payload.createdAt);
  const level = String(payload.level || payload.stream || payload.type || "log").padEnd(7, " ");
  const message = String(
    payload.line
      || payload.raw
      || payload.message
      || payload.content
      || payload.text
      || payload.stdout
      || payload.stderr
      || "",
  ).replace(/\s+/g, " ").trim();
  return `${timestamp}  ${level} ${message}`.trimEnd();
}

function readSession(sessionPayload) {
  return sessionPayload?.session || sessionPayload || {};
}

function deriveTurnTimeline(sessionPayload) {
  const session = readSession(sessionPayload);
  const turns = Array.isArray(session.turns) ? session.turns : [];
  if (turns.length) {
    return turns.map((turn, index) => ({
      key: turn.id || `turn-${index}`,
      number: Number(turn.number || index + 1),
      timestamp: formatTimestamp(turn.timestamp || turn.startedAt || turn.createdAt),
      tokenDelta: Number(turn.tokenDelta || turn.tokens || turn.outputTokens || 0),
      duration: formatDuration(turn.durationMs || turn.elapsedMs),
      eventType: String(turn.lastToolCall || turn.eventType || turn.type || "turn"),
    }));
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return messages.map((message, index) => ({
    key: `${message.timestamp || index}-${message.role || message.type || "event"}`,
    number: index + 1,
    timestamp: formatTimestamp(message.timestamp),
    tokenDelta: Number(message.tokenDelta || message.tokens || 0),
    duration: formatDuration(message.durationMs || 0),
    eventType: String(message.lastToolCall || message.role || message.type || "event"),
  }));
}

function detailLines(sessionPayload) {
  const session = readSession(sessionPayload);
  const metadata = session.metadata || {};
  const tokenIn = Number(session.tokensIn ?? metadata.tokensIn ?? 0);
  const tokenOut = Number(session.tokensOut ?? metadata.tokensOut ?? 0);
  const runtimeMs = Number(session.elapsedMs || session.runtimeMs || 0);
  return [
    `Task ID       ${session.taskId || "-"}`,
    `Session UUID  ${session.id || "-"}`,
    `Model         ${metadata.model || session.model || "-"}`,
    `Provider      ${metadata.provider || session.provider || "-"}`,
    `Branch        ${metadata.branch || session.branch || "-"}`,
    `Start time    ${formatTimestamp(session.createdAt || session.startedAt)}`,
    `Total runtime ${formatDuration(runtimeMs)}`,
    `Turn count    ${session.turnCount || deriveTurnTimeline(sessionPayload).length}`,
    `Token split   in ${tokenIn} / out ${tokenOut}`,
  ];
}

function sliceWindow(items, offset, size) {
  return items.slice(offset, offset + size);
}

function clampOffset(next, size, visible) {
  return Math.max(0, Math.min(next, Math.max(0, size - visible)));
}

function HarnessDetail({
  harnessPayload,
  harnessEvents,
  harnessNudgeMode,
  harnessNudgeValue,
}) {
  const run = harnessPayload?.run || harnessPayload || {};
  const state = getHarnessRunState(run);
  const approvalRequestId = getHarnessApprovalRequestId(run);
  const canApprove = run?.health?.waitingForOperator === true || run?.approvalPending === true;
  const lines = [
    `Run ID        ${run?.runId || "-"}`,
    `Name          ${run?.name || "-"}`,
    `State         ${getHarnessStateLabel(state)}`,
    `Stage         ${formatHarnessStage(run)}`,
    `Started       ${formatTimestamp(run?.startedAt)}`,
    `Updated       ${formatTimestamp(run?.updatedAt || run?.endedAt)}`,
    `Approval      ${approvalRequestId || "none"}`,
    `Summary       ${getHarnessAttentionDetail(run)}`,
  ];
  const visibleEvents = (Array.isArray(harnessEvents) ? harnessEvents : []).slice(0, 10);

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Text} bold>Harness Detail<//>
      ${lines.map((line) => html`<${Text} key=${line}>${line}<//>`)}
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Recent Events<//>
        ${visibleEvents.length
          ? visibleEvents.map((event, index) => {
              const eventLine = `${formatTimestamp(event?.timestamp || event?.createdAt)}  ${String(event?.type || event?.kind || "event")}  ${String(event?.summary || event?.message || event?.label || "").replace(/\s+/g, " ").trim()}`;
              return html`<${Text} key=${event?.id || `${index}-${eventLine}`} wrap="truncate-end">${eventLine}<//>`;
            })
          : html`<${Text} dimColor>No harness events yet<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        <${Text} dimColor>
          ${canApprove
            ? "[A]pprove  [X] deny  [N] nudge  [Esc] close"
            : "[N] nudge  [Esc] close"}
        <//>
        ${harnessNudgeMode
          ? html`
              <${Text}>Nudge: ${harnessNudgeValue || ""}<//>
              <${Text} dimColor>[Enter] send  [Esc] cancel<//>
            `
          : null}
      <//>
    <//>
  `;
}

function SessionDetail({
  sessionPayload,
  diffView,
  logLines,
  timelineOffset,
  visibleTimelineRows,
  steerMode,
  steerValue,
  terminalColumns,
}) {
  const metadataLines = detailLines(sessionPayload);
  const timeline = deriveTurnTimeline(sessionPayload);
  const visibleTurns = sliceWindow(timeline, timelineOffset, visibleTimelineRows);
  const rightPanel = terminalColumns >= 160;
  const diffLines = diffView?.lines?.visible || [];
  const omitted = Number(diffView?.lines?.omitted || 0);

  return html`
    <${Box} position="relative" flexDirection="column" paddingY=${1}>
      <${Text} bold>Session Detail<//>
      <${Box} marginTop=${1} flexDirection=${rightPanel ? "row" : "column"}>
        <${Box} flexDirection="column" width=${rightPanel ? Math.max(100, terminalColumns - 70) : undefined} flexGrow=${1}>
          <${Text} bold>Metadata<//>
          ${metadataLines.map((line) => html`<${Text} key=${line}>${line}<//>`) }

          <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
            <${Text} bold>Turn Timeline<//>
            <${Text} dimColor>turn | timestamp              | Δtokens | duration | event<//>
            ${visibleTurns.length
              ? visibleTurns.map((turn) => html`
                  <${Text} key=${turn.key}>
                    ${pad(turn.number, 4, "right")} | ${pad(turn.timestamp, 23)} | ${pad(turn.tokenDelta, 7, "right")} | ${pad(turn.duration, 8)} | ${turn.eventType}
                  <//>
                `)
              : html`<${Text} dimColor>No turns yet<//>`}
            <${Text} dimColor>↑/↓ scroll  PgUp/PgDn jump<//>
          <//>

          <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
            <${Text} bold>Latest Diff<//>
            <${Text}>${diffView?.summary || "(loading diff...)"}<//>
            ${omitted ? html`<${Text} dimColor>… ${omitted} lines omitted<//>` : null}
            ${diffLines.length
              ? diffLines.map((line, index) => html`
                  <${Text}
                    key=${`${index}-${line}`}
                    color=${line.startsWith("+") && !line.startsWith("+++") ? "green" : line.startsWith("-") && !line.startsWith("---") ? "red" : undefined}
                  >
                    ${line}
                  <//>
                `)
              : html`<${Text} dimColor>No diff lines available<//>`}
          <//>
        <//>

        ${rightPanel
          ? html`
              <${Box} marginLeft=${1} flexDirection="column" width=${44} borderStyle="single" paddingX=${1}>
                <${Text} bold>Stdout<//>
                ${(logLines || []).slice(-MAX_LOG_LINES).map((line, index) => html`
                  <${Text} key=${index} wrap="truncate-end">${line}<//>
                `)}
                ${!(logLines || []).length ? html`<${Text} dimColor>No stdout yet<//>` : null}
              <//>
            `
          : null}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        <${Text} dimColor>[S]teer  [F]orce new thread  [K]ill  [Esc] close modal<//>
        ${steerMode
          ? html`
              <${Text}>Steer message: ${steerValue || ""}<//>
            `
          : null}
      <//>
    <//>
  `;
}

export default function AgentsScreen({ wsBridge, host = "127.0.0.1", port = 3080, sessions, stats = null, onFooterHintsChange }) {
  const resolvedHost = wsBridge?.host || host;
  const resolvedPort = wsBridge?.port || port;
  const { stdout } = useStdout();
  const liveSessionsRef = React.useRef([]);
  const detailPollRef = React.useRef(null);
  const [entries, setEntries] = React.useState([]);
  const [retryQueue, setRetryQueue] = React.useState({ count: 0, items: [] });
  const [selectedId, setSelectedId] = React.useState("");
  const [showBackoff, setShowBackoff] = React.useState(true);
  const [detailView, setDetailView] = React.useState(null);
  const [logLines, setLogLines] = React.useState([]);
  const [diffView, setDiffView] = React.useState(null);
  const [confirmKill, setConfirmKill] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState("");
  const [clockMs, setClockMs] = React.useState(Date.now());
  const [timelineOffset, setTimelineOffset] = React.useState(0);
  const [steerMode, setSteerMode] = React.useState(false);
  const [steerValue, setSteerValue] = React.useState("");
  const [harnessRuns, setHarnessRuns] = React.useState([]);
  const [selectedHarnessRunId, setSelectedHarnessRunId] = React.useState("");
  const [harnessDetailView, setHarnessDetailView] = React.useState(null);
  const [harnessEvents, setHarnessEvents] = React.useState([]);
  const [harnessNudgeMode, setHarnessNudgeMode] = React.useState(false);
  const [harnessNudgeValue, setHarnessNudgeValue] = React.useState("");

  const terminalColumns = stdout?.columns || 120;
  const terminalRows = stdout?.rows || 40;
  const visibleTimelineRows = Math.max(6, Math.min(14, terminalRows - 20));

  const selectedSession = React.useMemo(
    () => entries.find((entry) => entry.id === selectedId)?.session || entries[0]?.session || null,
    [entries, selectedId],
  );
  const selectedHarnessRun = React.useMemo(
    () => harnessRuns.find((run) => String(run?.runId || "").trim() === selectedHarnessRunId) || harnessRuns[0] || null,
    [harnessRuns, selectedHarnessRunId],
  );

  const applyRetryQueue = React.useCallback((payload) => {
    setRetryQueue({
      count: Number(payload?.count || 0),
      items: Array.isArray(payload?.items) ? payload.items : [],
    });
  }, []);

  const applySessionSnapshot = React.useCallback((incomingSessions, now = Date.now()) => {
    liveSessionsRef.current = Array.isArray(incomingSessions) ? incomingSessions : [];
    setClockMs(now);
    setEntries((previous) => {
      const nextEntries = reconcileSessionEntries(previous, liveSessionsRef.current, now);
      setSelectedId((current) => {
        if (current && nextEntries.some((entry) => entry.id === current)) return current;
        return nextEntries[0]?.id || "";
      });
      return nextEntries;
    });
  }, []);

  React.useEffect(() => {
    const intervalId = setInterval(() => {
      const now = Date.now();
      setClockMs(now);
      setEntries((previous) => {
        const nextEntries = reconcileSessionEntries(previous, liveSessionsRef.current, now);
        setSelectedId((current) => {
          if (current && nextEntries.some((entry) => entry.id === current)) return current;
          return nextEntries[0]?.id || "";
        });
        return nextEntries;
      });
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, []);
  const clearDetailPoll = React.useCallback(() => {
    if (detailPollRef.current) {
      clearInterval(detailPollRef.current);
      detailPollRef.current = null;
    }
  }, []);

  const closeModal = React.useCallback(() => {
    clearDetailPoll();
    setDetailView(null);
    setLogLines([]);
    setDiffView(null);
    setConfirmKill(false);
    setTimelineOffset(0);
    setSteerMode(false);
    setSteerValue("");
    setHarnessDetailView(null);
    setHarnessEvents([]);
    setHarnessNudgeMode(false);
    setHarnessNudgeValue("");
  }, [clearDetailPoll]);

  const refreshData = React.useCallback(async () => {
    try {
      const [sessionsPayload, retryPayload, harnessPayload] = await Promise.all([
        fetchJson(resolvedHost, resolvedPort, "/api/sessions?workspace=all"),
        fetchJson(resolvedHost, resolvedPort, "/api/retry-queue"),
        fetchJson(resolvedHost, resolvedPort, "/api/harness/runs?limit=8"),
      ]);
      const now = Date.now();
      applyRetryQueue(retryPayload);
      applySessionSnapshot(sessionsPayload.sessions || [], now);
      const nextHarnessRuns = normalizeHarnessRuns(harnessPayload?.items || harnessPayload?.runs || []);
      setHarnessRuns(nextHarnessRuns);
      setSelectedHarnessRunId((current) => {
        if (current && nextHarnessRuns.some((run) => String(run?.runId || "").trim() === current)) return current;
        return String(nextHarnessRuns[0]?.runId || "").trim();
      });
      setStatusLine("");
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [applyRetryQueue, applySessionSnapshot, resolvedHost, resolvedPort]);

  React.useEffect(() => {
    applySessionSnapshot(sessions, Date.now());
  }, [applySessionSnapshot, sessions]);

  React.useEffect(() => {
    if (stats?.retryQueue) {
      applyRetryQueue(stats.retryQueue);
    }
  }, [applyRetryQueue, stats]);

  React.useEffect(() => {
    let active = true;
    void refreshData();
    const intervalId = setInterval(() => {
      const now = Date.now();
      setClockMs(now);
      setEntries((previous) => {
        const nextEntries = reconcileSessionEntries(previous, liveSessionsRef.current, now);
        setSelectedId((current) => {
          if (current && nextEntries.some((entry) => entry.id === current)) return current;
          return nextEntries[0]?.id || "";
        });
        return nextEntries;
      });
    }, 1000);
    return () => {
      active = false;
      clearInterval(intervalId);
      if (!active) {
        return;
      }
    };
  }, [refreshData]);

  React.useEffect(() => {
    if (!wsBridge || typeof wsBridge.on !== "function") return undefined;
    const handlers = [
      wsBridge.on("sessions:update", (payload) => {
        const nextSessions = Array.isArray(payload?.sessions)
          ? payload.sessions
          : Array.isArray(payload)
            ? payload
            : [];
        applySessionSnapshot(nextSessions, Date.now());
      }),
      wsBridge.on("session:event", (payload) => {
        const session = payload?.session;
        if (!session?.id) return;
        const nextSessions = Array.isArray(liveSessionsRef.current)
          ? [...liveSessionsRef.current]
          : [];
        const existingIndex = nextSessions.findIndex((candidate) => candidate.id === session.id);
        if (existingIndex >= 0) nextSessions[existingIndex] = session;
        else nextSessions.unshift(session);
        applySessionSnapshot(nextSessions, Date.now());

        if (String(detailView?.session?.id || "") !== String(session.id)) return;
        setDetailView(payload);
        if (Array.isArray(payload?.session?.messages) || payload?.event?.kind === "message") {
          setLogLines(sessionMessagesToLogLines(payload).slice(-MAX_LOG_LINES));
        }
      }),
      wsBridge.on("retry:update", applyRetryQueue),
      wsBridge.on("retry-queue-updated", applyRetryQueue),
      wsBridge.on("logs:stream", (payload) => {
        const line = streamPayloadToLogLine(payload);
        if (!line) return;
        setLogLines((current) => [...current.slice(-(MAX_LOG_LINES - 1)), line]);
      }),
    ];
    return () => {
      handlers.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
    };
  }, [applyRetryQueue, applySessionSnapshot, detailView, wsBridge]);

  React.useEffect(() => () => clearDetailPoll(), [clearDetailPoll]);

  const moveSelection = React.useCallback((delta) => {
    if (!entries.length) return;
    const index = entries.findIndex((entry) => entry.id === selectedSession?.id);
    const nextIndex = index === -1 ? 0 : (index + delta + entries.length) % entries.length;
    setSelectedId(entries[nextIndex]?.id || "");
  }, [entries, selectedSession]);

  const loadLogs = React.useCallback(async () => {
    if (!selectedSession?.id) return;
    try {
      const payload = await fetchJson(resolvedHost, resolvedPort, `/api/sessions/${encodeURIComponent(selectedSession.id)}?workspace=all`);
      setLogLines(sessionMessagesToLogLines(payload));
      setStatusLine(`Loaded logs for ${describeSelection(selectedSession)}`);
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [resolvedHost, resolvedPort, selectedSession]);

  const loadDiff = React.useCallback(async () => {
    if (!selectedSession?.id) return;
    try {
      const payload = await fetchJson(resolvedHost, resolvedPort, `/api/sessions/${encodeURIComponent(selectedSession.id)}/diff?workspace=all`);
      setDiffView(summarizeDiff(payload));
      setStatusLine(`Loaded diff for ${describeSelection(selectedSession)}`);
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [resolvedHost, resolvedPort, selectedSession]);

  const loadDetail = React.useCallback(async () => {
    if (!selectedSession?.id) return;
    try {
      const payload = await fetchJson(resolvedHost, resolvedPort, `/api/sessions/${encodeURIComponent(selectedSession.id)}?workspace=all`);
      setDetailView(payload);
      setStatusLine("");
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [resolvedHost, resolvedPort, selectedSession]);

  const openDetail = React.useCallback(async () => {
    if (!selectedSession?.id) return;
    setTimelineOffset(0);
    setDetailView({ session: selectedSession });
    setLogLines([]);
    setDiffView({ summary: "(loading diff...)", files: [], lines: { omitted: 0, visible: [] } });
    await Promise.all([loadDetail(), loadDiff()]);
    clearDetailPoll();
    detailPollRef.current = setInterval(() => {
      void loadDetail();
    }, DETAIL_POLL_MS);
  }, [clearDetailPoll, loadDetail, loadDiff, selectedSession]);

  const runAction = React.useCallback(async (action) => {
    if (!selectedSession?.id) return;
    try {
      await fetchJson(resolvedHost, resolvedPort, sessionActionPath(selectedSession.id, action), { method: "POST" });
      setStatusLine(`${action} sent to ${describeSelection(selectedSession)}`);
      if (action === "kill") setConfirmKill(false);
      await refreshData();
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [refreshData, resolvedHost, resolvedPort, selectedSession]);

  const sendSteer = React.useCallback(async () => {
    if (!selectedSession?.id || !steerValue.trim()) return;
    try {
      await fetchJson(
        resolvedHost,
        resolvedPort,
        `/api/sessions/${encodeURIComponent(selectedSession.id)}/message?workspace=all`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: steerValue.trim() }),
        },
      );
      setStatusLine("Steer sent ✓");
      setSteerMode(false);
      setSteerValue("");
      await loadDetail();
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [loadDetail, resolvedHost, resolvedPort, selectedSession, steerValue]);

  const loadHarnessDetail = React.useCallback(async (runId) => {
    if (!runId) return;
    const [runPayload, eventPayload] = await Promise.all([
      fetchJson(resolvedHost, resolvedPort, `/api/harness/runs/${encodeURIComponent(runId)}`),
      fetchJson(resolvedHost, resolvedPort, `/api/harness/runs/${encodeURIComponent(runId)}/events?limit=40&direction=desc`),
    ]);
    setHarnessDetailView(runPayload);
    setHarnessEvents(Array.isArray(eventPayload?.items) ? eventPayload.items : Array.isArray(eventPayload?.events) ? eventPayload.events : []);
  }, [resolvedHost, resolvedPort]);

  const openHarnessDetail = React.useCallback(async () => {
    const runId = String(selectedHarnessRun?.runId || "").trim();
    if (!runId) return;
    setHarnessDetailView({ run: selectedHarnessRun });
    setHarnessEvents([]);
    setHarnessNudgeMode(false);
    setHarnessNudgeValue("");
    try {
      await loadHarnessDetail(runId);
      setStatusLine("");
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [loadHarnessDetail, selectedHarnessRun]);

  const resolveHarnessApproval = React.useCallback(async (decision) => {
    const run = harnessDetailView?.run || harnessDetailView || selectedHarnessRun;
    const runId = String(run?.runId || "").trim();
    const requestId = getHarnessApprovalRequestId(run);
    if (!runId || !requestId) {
      setStatusLine("Harness approval request is missing metadata.");
      return;
    }
    try {
      await fetchJson(
        resolvedHost,
        resolvedPort,
        `/api/harness/approvals/${encodeURIComponent(requestId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            actor: "operator",
            note: decision === "approved"
              ? `Approved from harness monitor for stage ${formatHarnessStage(run)}.`
              : `Denied from harness monitor for stage ${formatHarnessStage(run)}.`,
          }),
        },
      );
      setStatusLine(decision === "approved" ? "Harness approval granted." : "Harness approval denied.");
      await refreshData();
      await loadHarnessDetail(runId);
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [harnessDetailView, loadHarnessDetail, refreshData, resolvedHost, resolvedPort, selectedHarnessRun]);

  const sendHarnessNudge = React.useCallback(async () => {
    const run = harnessDetailView?.run || harnessDetailView || selectedHarnessRun;
    const runId = String(run?.runId || "").trim();
    const prompt = harnessNudgeValue.trim();
    if (!runId || !prompt) return;
    try {
      await fetchJson(
        resolvedHost,
        resolvedPort,
        `/api/harness/runs/${encodeURIComponent(runId)}/nudge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            actor: "operator",
            mode: "steer",
            reason: "manual_intervention",
            stageId: formatHarnessStage(run),
          }),
        },
      );
      setHarnessNudgeMode(false);
      setHarnessNudgeValue("");
      setStatusLine("Harness nudge sent.");
      await refreshData();
      await loadHarnessDetail(runId);
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [harnessDetailView, harnessNudgeValue, loadHarnessDetail, refreshData, resolvedHost, resolvedPort, selectedHarnessRun]);

  useInput((input, key) => {
    if (confirmKill) {
      if (input === "y" || input === "Y") {
        void runAction("kill");
      } else if (key.escape || input === "n" || input === "N" || key.return) {
        setConfirmKill(false);
      }
      return;
    }

    if (harnessNudgeMode) {
      if (key.escape) {
        setHarnessNudgeMode(false);
        setHarnessNudgeValue("");
        return;
      }
      if (key.return || input === "`r") {
        void sendHarnessNudge();
        return;
      }
      if (key.backspace || key.delete) {
        setHarnessNudgeValue((current) => current.slice(0, -1));
        return;
      }
      if (input) {
        setHarnessNudgeValue((current) => current + input);
      }
      return;
    }

    if (steerMode) {
      if (key.escape) {
        setSteerMode(false);
        setSteerValue("");
        return;
      }
      if (key.return || input === "`r") {
        void sendSteer();
        return;
      }
      if (key.backspace || key.delete) {
        setSteerValue((current) => current.slice(0, -1));
        return;
      }
      if (input) {
        setSteerValue((current) => current + input);
      }
      return;
    }

    if (harnessDetailView) {
      const run = harnessDetailView?.run || harnessDetailView;
      const canApprove = run?.health?.waitingForOperator === true || run?.approvalPending === true;
      if (key.escape) {
        closeModal();
        return;
      }
      if ((input === "a" || input === "A") && canApprove) {
        void resolveHarnessApproval("approved");
        return;
      }
      if ((input === "x" || input === "X") && canApprove) {
        void resolveHarnessApproval("denied");
        return;
      }
      if ((input === "n" || input === "N")) {
        setHarnessNudgeMode(true);
        setHarnessNudgeValue("");
        return;
      }
      return;
    }

    if (detailView) {
      const timeline = deriveTurnTimeline(detailView);
      if (key.escape) {
        closeModal();
        return;
      }
      if (key.upArrow) {
        setTimelineOffset((current) => clampOffset(current - 1, timeline.length, visibleTimelineRows));
        return;
      }
      if (key.downArrow) {
        setTimelineOffset((current) => clampOffset(current + 1, timeline.length, visibleTimelineRows));
        return;
      }
      if (key.pageUp) {
        setTimelineOffset((current) => clampOffset(current - PAGE_SCROLL, timeline.length, visibleTimelineRows));
        return;
      }
      if (key.pageDown) {
        setTimelineOffset((current) => clampOffset(current + PAGE_SCROLL, timeline.length, visibleTimelineRows));
        return;
      }
      if (input === "s" || input === "S") {
        setSteerMode(true);
        setSteerValue("");
        return;
      }
      if (input === "f" || input === "F") {
        void runAction("force-new-thread");
        return;
      }
      if (input === "k" || input === "K") {
        setConfirmKill(true);
      }
      return;
    }

    if (key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (key.return || input === "`r") {
      void openDetail();
      return;
    }
    if (input === "k" || input === "K") {
      setConfirmKill(true);
      return;
    }
    if (input === "p" || input === "P") {
      void runAction("pause");
      return;
    }
    if (input === "r" || input === "R") {
      void runAction("resume");
      return;
    }
    if (input === "l" || input === "L") {
      void loadLogs();
      return;
    }
    if (input === "d" || input === "D") {
      void loadDiff();
      return;
    }
    if (input === "c" || input === "C") {
      if (selectedSession?.id) {
        stdout.write(buildOsc52CopySequence(selectedSession.id));
        setStatusLine(`Copied ${selectedSession.id}`);
      }
      return;
    }
    if (input === "b" || input === "B") {
      setShowBackoff((current) => !current);
      return;
    }
    if (input === "h" || input === "H") {
      void openHarnessDetail();
      return;
    }
    if (input === "[") {
      if (!harnessRuns.length) return;
      const index = harnessRuns.findIndex((run) => String(run?.runId || "").trim() === String(selectedHarnessRun?.runId || "").trim());
      const nextIndex = index <= 0 ? harnessRuns.length - 1 : index - 1;
      setSelectedHarnessRunId(String(harnessRuns[nextIndex]?.runId || "").trim());
      return;
    }
    if (input === "]") {
      if (!harnessRuns.length) return;
      const index = harnessRuns.findIndex((run) => String(run?.runId || "").trim() === String(selectedHarnessRun?.runId || "").trim());
      const nextIndex = index === -1 || index >= harnessRuns.length - 1 ? 0 : index + 1;
      setSelectedHarnessRunId(String(harnessRuns[nextIndex]?.runId || "").trim());
      return;
    }
    if (key.escape) {
      closeModal();
    }
  }, {
    isActive: true,
  });

  const eventWidth = Math.max(12, terminalColumns - FIXED_TABLE_WIDTH);
  const backoffMessageWidth = Math.max(20, terminalColumns - 34);

  React.useEffect(() => {
    if (typeof onFooterHintsChange !== "function") return;
    onFooterHintsChange(getFooterHints("agents", {
      confirmKill,
      detailOpen: Boolean(detailView),
      harnessDetailOpen: Boolean(harnessDetailView),
      harnessNudgeMode,
      logsOpen: logLines.length > 0,
      diffOpen: Boolean(diffView),
    }));
  }, [confirmKill, detailView, diffView, harnessDetailView, harnessNudgeMode, logLines.length, onFooterHintsChange]);


  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      ${detailView
        ? html`
            <${SessionDetail}
              sessionPayload=${detailView}
              diffView=${diffView}
              logLines=${logLines}
              timelineOffset=${timelineOffset}
              visibleTimelineRows=${visibleTimelineRows}
               steerMode=${steerMode}
               steerValue=${steerValue}
               terminalColumns=${terminalColumns}
            />`
        : harnessDetailView
          ? html`
              <${HarnessDetail}
                harnessPayload=${harnessDetailView}
                harnessEvents=${harnessEvents}
                harnessNudgeMode=${harnessNudgeMode}
                harnessNudgeValue=${harnessNudgeValue}
              />`
        : html`
            <${Box} borderStyle="single" paddingX=${1}>
              ${renderCell("", 2, { keyName: "header-status" })}
              ${renderCell("ID", 8, { keyName: "header-id", dimColor: true })}
              ${renderCell("STAGE", 12, { keyName: "header-stage", dimColor: true })}
              ${renderCell("PID", 8, { keyName: "header-pid", dimColor: true })}
              ${renderCell("AGE/TURN", 10, { keyName: "header-age-turn", dimColor: true })}
              ${renderCell("TOKENS", 12, { keyName: "header-tokens", dimColor: true })}
              ${renderCell("SESSION", 14, { keyName: "header-session", dimColor: true })}
              ${renderCell("EVENT", eventWidth, { keyName: "header-event", dimColor: true })}
            <//>
            ${(entries.length ? entries : [{ id: "empty", session: null }]).map((entry) => {
              if (!entry.session) {
                return html`
                  <${Box} key="empty" paddingX=${1}>
                    <${Text} dimColor>No sessions<//>
                  <//>
                `;
              }
              const row = projectSessionRow(entry.session, clockMs, eventWidth);
              const selected = entry.id === selectedSession?.id;
              return html`
                <${Box} key=${entry.id} paddingX=${1}>
                  ${renderCell(row.statusDot, 2, {
                    keyName: `${entry.id}-status`,
                    color: row.statusColor,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.idText, 8, {
                    keyName: `${entry.id}-id`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.stageText, 12, {
                    keyName: `${entry.id}-stage`,
                    inverse: selected,
                    color: row.statusColor,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.pidText, 8, {
                    keyName: `${entry.id}-pid`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.ageTurnText, 10, {
                    keyName: `${entry.id}-age-turn`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.tokensText, 12, {
                    keyName: `${entry.id}-tokens`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.sessionText, 14, {
                    keyName: `${entry.id}-session`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                  ${renderCell(row.eventText, eventWidth, {
                    keyName: `${entry.id}-event`,
                    inverse: selected,
                    dimColor: row.isDimmed || entry.isRetained,
                  })}
                <//>
              `;
            })}

            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>
                Backoff queue (${retryQueue.count || 0}) ${showBackoff ? "[B to collapse]" : "[B to expand]"}
              <//>
              ${showBackoff
                ? (retryQueue.items || []).slice(0, 6).map((item, index) => html`
                    <${Text} key=${item.taskId || item.id || index} wrap="truncate-end">
                      ${pad(String(item.taskTitle || item.taskId || item.id || `item-${index}`), 16)}
                      ${pad(formatRetryQueueCountdown(item, clockMs), 16)}
                      ${pad(String(item.lastError || item.error || item.reason || "-"), backoffMessageWidth)}
                    <//>
                  `)
                : null}
             ${showBackoff && !(retryQueue.items || []).length
                 ? html`<${Text} dimColor>No tasks cooling down<//>`
                 : null}
             <//>

             <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
               <${Text} bold>Harness monitor (${harnessRuns.length})<//>
               <${Text} dimColor>[H detail · [ / ] select]<//>
               ${harnessRuns.length
                 ? harnessRuns.slice(0, 6).map((run) => {
                     const isSelected = String(run?.runId || "").trim() === String(selectedHarnessRun?.runId || "").trim();
                     const row = projectHarnessRow(run, isSelected, Math.max(40, terminalColumns - 4));
                     return html`
                       <${Text} key=${row.key} color=${row.color} inverse=${row.inverse}>${row.text}<//>
                     `;
                   })
                 : html`<${Text} dimColor>No harness runs reported yet<//>`}
             <//>

             ${confirmKill && selectedSession
               ? html`
                  <${Box} marginTop=${1}>
                    <${Text} color="red">Kill ${describeSelection(selectedSession)}? [y/N]<//>
                  <//>
                `
              : null}

            ${logLines.length
              ? html`
                  <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
                    <${Text} bold>Logs<//>
                    ${logLines.map((line, index) => html`
                      <${Text} key=${index} wrap="truncate-end">${line}<//>
                    `)}
                  <//>
                `
              : null}

            ${diffView
              ? html`
                  <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
                    <${Text} bold>Diff<//>
                    <${Text}>${diffView.summary}<//>
                    ${diffView.files.length
                      ? diffView.files.map((file) => html`
                          <${Text} key=${file.name}>
                            ${file.name}  +${file.additions}  -${file.deletions}
                          <//>
                        `)
                      : html`<${Text} dimColor>No changed files<//>`}
                  <//>
                `
              : null}
          `}
      ${statusLine
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="yellow">${statusLine}<//>
            <//>
          `
        : null}
    <//>
  `;
}
