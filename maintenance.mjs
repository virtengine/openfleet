import { formatPidFileSummary as formatPidFileSummaryImpl } from "./infra/maintenance.mjs";


export function formatPidFileSummary(parsed) {

  // Prefer the raw representation if available, to align with infra/maintenance.mjs.
  const rawSource = typeof parsed?.raw !== "undefined" ? parsed.raw : parsed?.pid;
  let rawPid =
    typeof rawSource === "string"
      ? rawSource.trim()
      : String(rawSource ?? "").trim();

  // Avoid treating clearly invalid values (like the string "NaN") as valid summaries.
  if (!rawPid || rawPid === "NaN") {
    return "unknown";
  }

  // Truncate overly long values to keep log output robust and consistent.
  const MAX_LEN = 64;
  if (rawPid.length > MAX_LEN) {
    rawPid = rawPid.slice(0, MAX_LEN - 1) + "…";
  }

  return rawPid;