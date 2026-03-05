const DEFAULT_MUTEX_BACKOFF_STEP_MS = 30_000;
const DEFAULT_MUTEX_BACKOFF_MAX_MS = 90_000;
const DEFAULT_MIN_RESTART_INTERVAL_MS = 15_000;
const DEFAULT_QUICK_EXIT_THRESHOLD_MS = 20_000;

export class RestartController {
  constructor(options = {}) {
    this.mutexBackoffStepMs =
      options.mutexBackoffStepMs ?? DEFAULT_MUTEX_BACKOFF_STEP_MS;
    this.mutexBackoffMaxMs =
      options.mutexBackoffMaxMs ?? DEFAULT_MUTEX_BACKOFF_MAX_MS;
    this.minRestartIntervalMs =
      options.minRestartIntervalMs ?? DEFAULT_MIN_RESTART_INTERVAL_MS;
    this.quickExitThresholdMs =
      options.quickExitThresholdMs ?? DEFAULT_QUICK_EXIT_THRESHOLD_MS;

    this.mutexHeldDetected = false;
    this.mutexBackoffMs = 0;
    this.lastProcessStartAt = 0;
    this.consecutiveQuickExits = 0;
  }

  noteLogLine(line) {
    if (!line) return;
    if (
      line.includes("Another orchestrator instance is already running") ||
      line.includes("mutex held")
    ) {
      this.mutexHeldDetected = true;
    }
  }

  noteProcessStarted(nowMs = Date.now()) {
    this.mutexHeldDetected = false;
    this.lastProcessStartAt = nowMs;
  }

  getMinRestartDelay(nowMs = Date.now()) {
    if (this.lastProcessStartAt <= 0) return 0;
    const sinceLast = nowMs - this.lastProcessStartAt;
    if (sinceLast < this.minRestartIntervalMs) {
      return this.minRestartIntervalMs - sinceLast;
    }
    return 0;
  }

  shouldSuppressRestart(reason) {
    return reason === "file-change" && this.mutexBackoffMs > 0;
  }

  resetBackoff() {
    this.mutexBackoffMs = 0;
  }

  getRestartDelay() {
    return this.mutexBackoffMs;
  }

  recordExit(runDurationMs, isMutexHeld) {
    const hadBackoff = this.mutexBackoffMs > 0;
    const isQuickExit = runDurationMs < this.quickExitThresholdMs;

    if (isQuickExit) {
      this.consecutiveQuickExits += 1;
    } else {
      this.consecutiveQuickExits = 0;
      if (this.mutexBackoffMs > 0) {
        this.mutexBackoffMs = 0;
      }
    }

    if (isMutexHeld) {
      this.mutexHeldDetected = false;
      this.mutexBackoffMs = Math.min(
        this.mutexBackoffMs + this.mutexBackoffStepMs,
        this.mutexBackoffMaxMs,
      );
      return {
        isMutexHeld: true,
        backoffMs: this.mutexBackoffMs,
        consecutiveQuickExits: this.consecutiveQuickExits,
        backoffReset: hadBackoff && !isQuickExit,
      };
    }

    return {
      isMutexHeld: false,
      backoffMs: this.mutexBackoffMs,
      consecutiveQuickExits: this.consecutiveQuickExits,
      backoffReset: hadBackoff && !isQuickExit,
    };
  }
}

export const RESTART_DEFAULTS = {
  mutexBackoffStepMs: DEFAULT_MUTEX_BACKOFF_STEP_MS,
  mutexBackoffMaxMs: DEFAULT_MUTEX_BACKOFF_MAX_MS,
  minRestartIntervalMs: DEFAULT_MIN_RESTART_INTERVAL_MS,
  quickExitThresholdMs: DEFAULT_QUICK_EXIT_THRESHOLD_MS,
};
