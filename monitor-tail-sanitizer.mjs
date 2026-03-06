export function sanitizeMonitorTailForPrompt(tail, backend) {
  const text = String(tail || "");
  if (!text) return text;
  if (String(backend || "").toLowerCase() === "vk") return text;

  const fixtureTokens = [
    "/api/tasks/999",
    "/api/tasks/111",
    "/api/tasks/123",
    "/api/tasks/task-5",
    "safeRecover: could not re-fetch status for \"Failing Task\"",
    "Invalid JSON - Invalid JSON",
    "plain text response",
    "<h1>404 Not Found</h1>",
    "<h1>502 Bad Gateway</h1>",
    "nginx/1.18.0",
  ];
  const fixtureTokensLower = fixtureTokens.map((token) =>
    String(token || "").toLowerCase(),
  );
  const benignMonitorTailPatterns = [
    /ExperimentalWarning:\s+SQLite is an experimental feature/i,
    /Use `node --trace-warnings .*` to show where the warning was created/i,
    /local\s+'[^']+'\s+diverged\s+\(\d+↑\s+\d+↓\)\s+but has uncommitted changes\s+[—-]\s+skipping/i,
    /workspace sync:\s+\d+\s+repo\(s\)\s+failed in\s+[^(]+$/i,
    /quick tunnel exited with code\s+(?:-?\d+|null|undefined|unknown)(?:\s+signal\s+\S+)?(?:;\s+restart scheduled)?(?:\s+\(tail:\s+.*\))?$/i,
    /quick tunnel exited\s+\(code\s+(?:-?\d+|null|undefined|unknown)(?:,\s+signal\s+\S+)?\);\s+restart scheduled(?:\s+\(tail:\s+.*\))?$/i,
    /(?:\[task-store\]\s+)?Loaded\s+\d+\s+tasks?\s+from\s+disk$/i,
    /'[^']+'\s+is checked out with uncommitted changes\s+[—-]\s+skipping pull$/i,
  ];

  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const current = String(line || "");
    const decolorized = current.replace(/\x1B\[[0-9;]*m/g, "");
    const normalized = current
      .replace(/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?\s+/, "")
      .replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, "")
      .replace(/^(?:\[[^\]]+\]\s*)+/, "")
      .trim();
    const normalizedDecolorized = decolorized
      .replace(/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?\s+/, "")
      .replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, "")
      .replace(/^(?:\[[^\]]+\]\s*)+/, "")
      .trim();
    const currentLower = decolorized.toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    const normalizedDecolorizedLower = normalizedDecolorized.toLowerCase();
    if (/A{40,}/.test(current)) return false;
    if (
      benignMonitorTailPatterns.some(
        (pattern) =>
          pattern.test(current) ||
          pattern.test(decolorized) ||
          pattern.test(normalized) ||
          pattern.test(normalizedDecolorized),
      )
    ) {
      return false;
    }
    return !fixtureTokensLower.some(
      (token) =>
        currentLower.includes(token) ||
        normalizedLower.includes(token) ||
        normalizedDecolorizedLower.includes(token),
    );
  });

  if (filtered.length === lines.length) return text;

  return [
    filtered.join("\n"),
    "[monitor] (sanitized benign tail noise for non-VK backend)",
  ]
    .filter(Boolean)
    .join("\n");
}
