const initialFetch =
  typeof globalThis.fetch === "function" ? globalThis.fetch : null;
const fallbackEnabled =
  !process.env.VITEST &&
  String(process.env.NODE_ENV || "").toLowerCase() !== "test";

export function resolveFetch() {
  if (process.env.VITEST) {
    return initialFetch || globalThis.fetch;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch;
  }
  return initialFetch;
}

export async function fetchWithFallback(url, options = {}, opts = {}) {
  const allowFallback =
    opts.allowFallback !== undefined ? opts.allowFallback : fallbackEnabled;
  const primary = resolveFetch();
  if (typeof primary !== "function") {
    throw new Error("global fetch is unavailable");
  }
  let response = await primary(url, options);
  if (
    (!response || typeof response.ok === "undefined") &&
    allowFallback &&
    initialFetch &&
    initialFetch !== primary
  ) {
    response = await initialFetch(url, options);
  }
  return response;
}
