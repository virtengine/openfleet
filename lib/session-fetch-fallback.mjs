export function classifySessionFetchError(error) {
  const raw = String(error?.message || "").trim();
  if (!raw) return { kind: "unknown", message: "" };
  let message = raw;
  let status = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === "string") {
      message = String(parsed.error).trim() || raw;
    }
    const parsedStatus = Number(parsed?.status ?? parsed?.statusCode ?? parsed?.code);
    if (Number.isFinite(parsedStatus)) {
      status = parsedStatus;
    }
  } catch {
    // Not a JSON API error body.
  }
  const normalized = message.toLowerCase();
  const is404 =
    status === 404 ||
    normalized.includes("session not found") ||
    normalized.includes("request failed (404)") ||
    normalized.includes("404 not found");
  if (is404) {
    return { kind: "not_found", message, status: 404 };
  }
  return { kind: "unknown", message, status };
}

export function createSessionFetchWithFallback({ fetcher, classifyError = classifySessionFetchError } = {}) {
  return async function fetchSessionWithFallback({ primaryPath, fallbackPath }) {
    if (typeof fetcher !== "function") {
      throw new TypeError("fetcher is required");
    }
    try {
      return await fetcher(primaryPath);
    } catch (error) {
      const classification =
        typeof classifyError === "function"
          ? classifyError(error)
          : classifySessionFetchError(error);
      const shouldRetryAll =
        classification?.kind === "not_found" &&
        Boolean(fallbackPath) &&
        fallbackPath !== primaryPath;
      if (!shouldRetryAll) throw error;
      return fetcher(fallbackPath);
    }
  };
}
