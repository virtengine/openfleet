export function createDaemonCrashTracker(options = {}) {
  const instantCrashWindowMs = Math.max(
    1000,
    Number(options.instantCrashWindowMs || 15_000) || 15_000,
  );
  const maxInstantCrashes = Math.max(
    1,
    Number(options.maxInstantCrashes || 3) || 3,
  );

  let lastStartAtMs = 0;
  let instantCrashCount = 0;

  return {
    markStart(nowMs = Date.now()) {
      lastStartAtMs = Number(nowMs) || Date.now();
    },

    recordExit(nowMs = Date.now()) {
      const now = Number(nowMs) || Date.now();
      const runDurationMs =
        lastStartAtMs > 0 ? Math.max(0, now - lastStartAtMs) : 0;
      const instantCrash =
        lastStartAtMs > 0 && runDurationMs <= instantCrashWindowMs;

      if (instantCrash) {
        instantCrashCount += 1;
      } else {
        instantCrashCount = 0;
      }

      return {
        runDurationMs,
        instantCrash,
        instantCrashCount,
        exceeded: instantCrashCount >= maxInstantCrashes,
        instantCrashWindowMs,
        maxInstantCrashes,
      };
    },

    reset() {
      lastStartAtMs = 0;
      instantCrashCount = 0;
    },

    getState() {
      return {
        lastStartAtMs,
        instantCrashCount,
        instantCrashWindowMs,
        maxInstantCrashes,
      };
    },
  };
}
