/**
 * health-status.mjs — Side-effect-free module for Bosun health reporting.
 *
 * This module is safe to import from any context (ui-server, entrypoint, tests)
 * without triggering process spawning or other startup side effects.
 */

const TAG = "[health-status]";

/** @type {{ monitor: string, server: string }} */
const componentStatus = {
  monitor: "stopped",
  server: "stopped",
};

let shuttingDown = false;
let setupComplete = false;
let monitorCircuitBroken = false;
const startedAt = Date.now();
let isDocker = process.env.BOSUN_DOCKER === "1";
let isDesktop = process.env.BOSUN_DESKTOP === "1";

/**
 * Returns current health status object.
 * @returns {object}
 */
export function getHealthStatus() {
  return {
    status: shuttingDown ? "shutting_down" : monitorCircuitBroken ? "degraded" : "ok",
    setup: setupComplete,
    monitor: componentStatus.monitor,
    server: componentStatus.server,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    docker: isDocker,
    desktop: isDesktop,
  };
}

/**
 * Update a named component's status.
 * @param {string} name
 * @param {string} status
 */
export function setComponentStatus(name, status) {
  componentStatus[name] = status;
}

/** Mark setup as complete. */
export function markSetupComplete() {
  setupComplete = true;
}

/** @returns {boolean} */
export function isSetupComplete() {
  return setupComplete;
}

/** Mark the process as shutting down. */
export function setShuttingDown(value = true) {
  shuttingDown = value;
}

/** Mark the monitor circuit breaker as tripped. */
export function setMonitorCircuitBroken(value = true) {
  monitorCircuitBroken = value;
}

/** Allow callers (entrypoint) to override mode flags after env detection. */
export function setMode({ docker, desktop } = {}) {
  if (docker !== undefined) isDocker = Boolean(docker);
  if (desktop !== undefined) isDesktop = Boolean(desktop);
}
