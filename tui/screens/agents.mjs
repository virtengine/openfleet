import React from "react";
import htm from "htm";
import { Box, Text, useInput, useStdout } from "ink";

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

function renderCell(value, width, { color, inverse, dimColor, align = "left" } = {}) {
  return html`
    <${Box} width=${width}>
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
    <${Box} position="absolute" zIndex=${1} borderStyle="double" flexDirection="column" width=${terminalColumns - 2} paddingX=${1}>
      <${Text} bold>Session Detail<//>
      <${Box} marginTop=${1} flexDirection=${rightPanel ? "row" : "column"}>
        <${Box} flexDirection="column" width=${rightPanel ? Math.max(100, terminalColumns - 70) : undefined} flexGrow=${1}>
          <${Text} bold>Metadata<//>
          ${metadataLines.map((line) => html`<${Text} key=${line}>${line}<//>`) }

          <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
            <${Text} bold>Turn Timeline<//>
            <${Text} dimColor>turn | timestamp | Δtokens | duration | event<//>
            ${visibleTurns.length
              ? visibleTurns.map((turn) => html`
                  <${Text} key=${turn.key}>
                    ${pad(turn.number, 4, "right")} | ${pad(turn.timestamp, 19)} | ${pad(turn.tokenDelta, 7, "right")} | ${pad(turn.duration, 8)} | ${turn.eventType}
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

export default function AgentsScreen({ wsBridge, host = "127.0.0.1", port = 3080, sessions, stats = null }) {
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

  const terminalColumns = stdout?.columns || 120;
  const terminalRows = stdout?.rows || 40;
  const visibleTimelineRows = Math.max(6, Math.min(14, terminalRows - 20));

  const selectedSession = React.useMemo(
    () => entries.find((entry) => entry.id === selectedId)?.session || entries[0]?.session || null,
    [entries, selectedId],
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
  }, [clearDetailPoll]);

  const refreshData = React.useCallback(async () => {
    try {
      const [sessionsPayload, retryPayload] = await Promise.all([
        fetchJson(resolvedHost, resolvedPort, "/api/sessions?workspace=all"),
        fetchJson(resolvedHost, resolvedPort, "/api/retry-queue"),
      ]);
      const now = Date.now();
      applyRetryQueue(retryPayload);
      applySessionSnapshot(sessionsPayload.sessions || [], now);
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
    if (!wsBridge || typeof wsBridge.on !== "function") return undefined;
    const off = wsBridge.on("logs:stream", (payload) => {
      const payloadSessionId = String(payload?.sessionId || payload?.id || payload?.session?.id || "");
      if (!detailView?.session?.id || payloadSessionId !== String(detailView.session.id)) return;
      const line = streamPayloadToLogLine(payload);
      if (!line) return;
      setLogLines((current) => [...current.slice(-(MAX_LOG_LINES - 1)), line]);
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [detailView?.session?.id, wsBridge]);

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
      setLogLines(sessionMessagesToLogLines(payload).slice(-MAX_LOG_LINES));
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

  useInput((input, key) => {
    if (confirmKill) {
      if (input === "y" || input === "Y") {
        void runAction("kill");
      } else if (key.escape || input === "n" || input === "N" || key.return) {
        setConfirmKill(false);
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
    if (key.escape) {
      closeModal();
    }
  });

  const eventWidth = Math.max(12, terminalColumns - FIXED_TABLE_WIDTH);
  const backoffMessageWidth = Math.max(20, terminalColumns - 34);

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box} borderStyle="single" paddingX=${1}>
        ${renderCell("", 2, {})}
        ${renderCell("ID", 8, { dimColor: true })}
        ${renderCell("STAGE", 12, { dimColor: true })}
        ${renderCell("PID", 8, { dimColor: true })}
        ${renderCell("AGE/TURN", 10, { dimColor: true })}
        ${renderCell("TOKENS", 12, { dimColor: true })}
        ${renderCell("SESSION", 14, { dimColor: true })}
        ${renderCell("EVENT", eventWidth, { dimColor: true })}
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
              color: row.statusColor,
              inverse: selected,
              dimColor: row.isDimmed || entry.isRetained,
            })}
            ${renderCell(row.idText, 8, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.stageText, 12, {
              inverse: selected,
              color: row.statusColor,
              dimColor: row.isDimmed || entry.isRetained,
            })}
            ${renderCell(row.pidText, 8, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.ageTurnText, 10, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.tokensText, 12, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.sessionText, 14, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.eventText, eventWidth, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
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

      ${confirmKill && selectedSession
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="red">Kill ${describeSelection(selectedSession)}? [y/N]<//>
            <//>
          `
        : null}

      ${!detailView && logLines.length
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>Logs<//>
              ${logLines.map((line, index) => html`
                <${Text} key=${index} wrap="truncate-end">${line}<//>
              `)}
            <//>
          `
        : null}

      ${!detailView && diffView
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

      <${Box} marginTop=${1} borderStyle="single" paddingX=${1}>
        <${Text} dimColor>
          [K]ill session  [P]ause  [R]esume  [L]ogs  [D]iff  [C]opy ID  [Enter] Detail
        <//>
      <//>
      ${statusLine
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="yellow">${statusLine}<//>
            <//>
          `
        : null}

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
            />
          `
        : null}
    <//>
  `;
}



