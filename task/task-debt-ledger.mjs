import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_LEDGER_RELATIVE_PATH = ".bosun/workflow-runs/task-debt-ledger.jsonl";

function normalizeSeverity(value) {
  const severity = String(value || "")
    .trim()
    .toLowerCase();
  if (["critical", "high", "medium", "low"].includes(severity)) return severity;
  return "medium";
}

function normalizeDebtType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "unspecified";
}

function trimText(value, maxLength = 2000) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeDebtItems(rawDebtItems, fallbackReason = "") {
  const items = Array.isArray(rawDebtItems) ? rawDebtItems : [];
  const normalized = items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const type = normalizeDebtType(item.type);
      const severity = normalizeSeverity(item.severity);
      const description = trimText(
        item.description || item.detail || item.message || "",
      );
      const criterion = trimText(item.criterion || "");
      if (!description && !criterion && type === "unspecified") return null;
      return {
        type,
        severity,
        description,
        criterion,
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) return normalized;

  const fallback = trimText(fallbackReason);
  if (!fallback) return [];
  return [
    {
      type: "assessment_reason",
      severity: "medium",
      description: fallback,
      criterion: "",
    },
  ];
}

export function recordTaskDebt(entry, options = {}) {
  const ledgerPath = resolve(
    options.baseDir || process.cwd(),
    options.ledgerPath || DEFAULT_LEDGER_RELATIVE_PATH,
  );
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const nowIso = new Date().toISOString();
  const payload = {
    recordedAt: nowIso,
    taskId: String(entry?.taskId || "").trim(),
    taskTitle: trimText(entry?.taskTitle || "", 500),
    attemptId: String(entry?.attemptId || "").trim(),
    trigger: String(entry?.trigger || "").trim(),
    action: String(entry?.action || "").trim(),
    reason: trimText(entry?.reason || ""),
    debtItems: normalizeDebtItems(entry?.debtItems, entry?.reason),
    metadata:
      entry?.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
  };

  appendFileSync(ledgerPath, `${JSON.stringify(payload)}\n`, "utf8");
  return { ledgerPath, entry: payload };
}

export function readTaskDebtEntries(options = {}) {
  const ledgerPath = resolve(
    options.baseDir || process.cwd(),
    options.ledgerPath || DEFAULT_LEDGER_RELATIVE_PATH,
  );
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed ledger lines.
    }
  }

  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}

