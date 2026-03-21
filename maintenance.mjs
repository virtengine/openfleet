export function formatPidFileSummary(parsed) {
  const rawSource = typeof parsed?.raw !== "undefined" ? parsed.raw : parsed?.pid;
  let rawPid =
    typeof rawSource === "string"
      ? rawSource.trim()
      : String(rawSource ?? "").trim();

  if (!rawPid || rawPid === "NaN") {
    return "unknown";
  }

  const maxLen = 64;
  if (rawPid.length > maxLen) {
    rawPid = `${rawPid.slice(0, maxLen - 3)}...`;
  }

  return rawPid;
}
