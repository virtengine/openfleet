const STATUS_COLORS = {
	active: "green",
	running: "green",
	todo: "yellow",
	queued: "yellow",
	error: "red",
	stuck: "red",
	rework: "magenta",
	paused: "gray",
	completed: "gray",
	done: "gray",
	finished: "gray",
	stopped: "gray",
};

const COMPLETED_RETENTION_MS = 10_000;
const SESSION_EVENT_MAX_WIDTH = 120;

function truncate(value, width) {
	const text = String(value ?? "-");
	if (width <= 0) return "";
	if (text.length <= width) return text.padEnd(width, " ");
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function toMillis(value) {
	if (!value) return 0;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function shortId(value, width = 8) {
	return truncate(String(value ?? "-"), width);
}

function formatElapsed(valueMs) {
	const totalSeconds = Math.max(0, Math.floor((valueMs || 0) / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${String(remainingMinutes).padStart(2, "0")}m` : `${hours}h`;
}

function formatAgeTurn(session, now) {
	const startedAt = toMillis(session?.startedAt ?? session?.createdAt);
	const endedAt = toMillis(session?.endedAt);
	const ageLabel = startedAt ? formatElapsed((endedAt || now) - startedAt) : "-";
	const turnValue = session?.turn ?? session?.turnCount ?? session?.latestTurn ?? 0;
	return turnValue ? truncate(`${ageLabel}/${turnValue}`, 10) : truncate(ageLabel, 10);
}

function formatTokens(session) {
	const tokens = session?.tokens ?? session?.tokenCount ?? session?.usage?.totalTokens ?? session?.metrics?.tokens ?? 0;
	if (!tokens) return truncate("-", 12);
	return truncate(tokens.toLocaleString("en-US"), 12);
}

function formatSessionLabel(session) {
	return truncate(session?.sessionLabel ?? session?.executor ?? session?.model ?? session?.sessionId ?? "-", 14);
}

function formatEvent(session) {
	const raw = session?.event ?? session?.lastEvent ?? session?.message ?? session?.taskTitle ?? session?.prompt ?? "-";
	return truncate(raw, SESSION_EVENT_MAX_WIDTH).trimEnd();
}

function formatCountdown(nextRetryAt, now) {
	const diff = Math.max(0, toMillis(nextRetryAt) - now);
	return formatElapsed(diff);
}

function isCompletedStatus(status) {
	return ["completed", "done", "finished", "stopped"].includes(String(status || "").toLowerCase());
}

function resolveStatusColor(session) {
	const stageValue = String(session?.stage ?? "").toLowerCase();
	if (stageValue === "active" || stageValue === "running" || stageValue === "implementing") return "green";
	const stageColor = getStatusColor(session?.stage);
	if (stageColor !== "white") return stageColor;
	return getStatusColor(session?.status);
}

export function getStatusColor(status) {
	return STATUS_COLORS[String(status || "").toLowerCase()] || "white";
}

export function selectNextIndex(currentIndex, delta, itemCount) {
	if (!itemCount || itemCount <= 0) return 0;
	const safeCurrent = Math.max(0, Math.min(itemCount - 1, currentIndex));
	return Math.max(0, Math.min(itemCount - 1, safeCurrent + delta));
}

export function pruneCompletedSessions(sessions = [], now = Date.now()) {
	return sessions.filter((session) => {
		if (!isCompletedStatus(session?.status)) return true;
		const endedAt = toMillis(session?.endedAt);
		if (!endedAt) return true;
		return now - endedAt <= COMPLETED_RETENTION_MS;
	});
}

export function buildOsc52Sequence(value) {
	const payload = Buffer.from(String(value ?? ""), "utf8").toString("base64");
	return `\u001B]52;c;${payload}\u0007`;
}

export function buildKillConfirmationLabel(session) {
	return `Kill ${shortId(session?.id ?? session?.sessionId, 8).trim()}? [y/N]`;
}

export function buildSessionCommand(action, session = {}) {
	const id = session?.id ?? session?.sessionId;
	const sessionId = session?.sessionId ?? session?.id;
	const pid = session?.pid ?? session?.processId ?? null;
	const turn = session?.turn ?? session?.turnCount ?? session?.latestTurn ?? null;
	return {
		type: `session:${action}`,
		payload: { id, pid, sessionId, turn },
	};
}

export function buildAgentsViewModel({ sessions = [], backoffQueue = [], now = Date.now() } = {}) {
	const liveSessions = pruneCompletedSessions(sessions, now)
		.slice()
		.sort((left, right) => toMillis(right?.startedAt) - toMillis(left?.startedAt))
		.map((session) => ({
			...session,
			ageTurn: formatAgeTurn(session, now),
			eventText: formatEvent(session),
			idShort: shortId(session?.id ?? session?.sessionId, 8),
			isCompleted: isCompletedStatus(session?.status),
			pidText: truncate(session?.pid ?? session?.processId ?? "-", 8),
			sessionText: formatSessionLabel(session),
			stageText: truncate(session?.stage ?? session?.status ?? "-", 12),
			statusColor: resolveStatusColor(session),
			statusDot: "●",
			tokensText: formatTokens(session),
		}));

	const retryRows = (backoffQueue || []).map((entry) => ({
		attempt: entry?.attempt ?? entry?.retryAttempt ?? entry?.retries ?? 0,
		countdown: formatCountdown(entry?.nextRetryAt ?? entry?.retryAt, now),
		id: entry?.taskId ?? entry?.id ?? "-",
	}));

	return { sessions: liveSessions, backoffQueue: retryRows };
}