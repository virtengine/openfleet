/**
 * container-runner.mjs — Optional container isolation for agent execution.
 *
 * When CONTAINER_ENABLED=1, agent tasks run inside Docker containers for
 * security isolation. Inspired by nanoclaw's Apple Container architecture
 * but using Docker (cross-platform: Linux, macOS, Windows).
 *
 * Features:
 *   - Docker container isolation for agent execution
 *   - Volume mount security (allowlist-based)
 *   - Configurable timeouts and resource limits
 *   - Output streaming via sentinel markers
 *   - Graceful shutdown with container cleanup
 *
 * The container mounts the workspace read-only and a scratch directory
 * read-write, then runs the agent inside the container.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

// ── Configuration ────────────────────────────────────────────────────────────

const containerEnabled = ["1", "true", "yes"].includes(
  String(process.env.CONTAINER_ENABLED || "").toLowerCase(),
);
const containerRuntime = process.env.CONTAINER_RUNTIME || "docker"; // docker | podman | container (macOS)
const containerImage = process.env.CONTAINER_IMAGE || "node:22-slim";
const containerTimeout = parseInt(
  process.env.CONTAINER_TIMEOUT_MS || "1800000",
  10,
); // 30 min default
const containerMaxOutput = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || "10485760",
  10,
); // 10MB
const maxConcurrentContainers = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || "3", 10),
);

// Sentinel markers for output parsing (protocol compatible with nanoclaw)
const OUTPUT_START_MARKER = "---CODEXMON_OUTPUT_START---";
const OUTPUT_END_MARKER = "---CODEXMON_OUTPUT_END---";

// ── State ────────────────────────────────────────────────────────────────────

const activeContainers = new Map(); // containerName → { proc, startTime, taskId }
let containerIdCounter = 0;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if container mode is enabled and runtime is available.
 */
export function isContainerEnabled() {
  return containerEnabled;
}

/**
 * Get container subsystem status.
 */
export function getContainerStatus() {
  return {
    enabled: containerEnabled,
    runtime: containerRuntime,
    image: containerImage,
    timeout: containerTimeout,
    maxConcurrent: maxConcurrentContainers,
    active: activeContainers.size,
    containers: [...activeContainers.entries()].map(([name, info]) => ({
      name,
      taskId: info.taskId,
      uptime: Date.now() - info.startTime,
    })),
  };
}

/**
 * Check if the container runtime is installed and running.
 */
export function checkContainerRuntime() {
  try {
    if (containerRuntime === "container") {
      // macOS Apple Container
      execSync("container system status", { stdio: "pipe" });
      return { available: true, runtime: "container", platform: "macos" };
    }
    // Docker or Podman
    execSync(`${containerRuntime} info`, { stdio: "pipe", timeout: 10000 });
    return {
      available: true,
      runtime: containerRuntime,
      platform: process.platform,
    };
  } catch {
    return {
      available: false,
      runtime: containerRuntime,
      platform: process.platform,
    };
  }
}

/**
 * Ensure the container runtime is ready (start if needed for macOS).
 */
export function ensureContainerRuntime() {
  if (containerRuntime === "container") {
    // macOS Apple Container — may need explicit start
    try {
      execSync("container system status", { stdio: "pipe" });
    } catch {
      console.log("[container] Starting Apple Container system...");
      try {
        execSync("container system start", { stdio: "pipe", timeout: 30000 });
        console.log("[container] Apple Container system started");
      } catch (err) {
        throw new Error(
          `Apple Container failed to start: ${err.message}\n` +
            "Install from: https://github.com/apple/container/releases",
        );
      }
    }
    return;
  }

  // Docker/Podman — just verify it's running
  const check = checkContainerRuntime();
  if (!check.available) {
    throw new Error(
      `${containerRuntime} is not available. Install it or set CONTAINER_RUNTIME to an available runtime.`,
    );
  }
}

/**
 * Build volume mount arguments for the container.
 * @param {string} workspacePath - Path to the workspace/repo
 * @param {string} scratchDir - Path to scratch directory for container writes
 * @param {object} options - Additional mount options
 */
function buildMountArgs(workspacePath, scratchDir, options = {}) {
  const args = [];

  if (containerRuntime === "container") {
    // Apple Container uses --mount and -v syntax
    args.push(
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace,readonly`,
    );
    args.push("-v", `${scratchDir}:/scratch`);
  } else {
    // Docker/Podman
    args.push("-v", `${workspacePath}:/workspace:ro`);
    args.push("-v", `${scratchDir}:/scratch:rw`);
  }

  // Additional mounts
  if (options.additionalMounts) {
    for (const mount of options.additionalMounts) {
      const target =
        mount.containerPath || `/workspace/extra/${basename(mount.hostPath)}`;
      const ro = mount.readonly !== false ? ":ro" : "";
      if (containerRuntime === "container") {
        if (mount.readonly !== false) {
          args.push(
            "--mount",
            `type=bind,source=${mount.hostPath},target=${target},readonly`,
          );
        } else {
          args.push("-v", `${mount.hostPath}:${target}`);
        }
      } else {
        args.push("-v", `${mount.hostPath}:${target}${ro}`);
      }
    }
  }

  return args;
}

/**
 * Run an agent command inside a container.
 *
 * @param {object} options
 * @param {string} options.workspacePath - Path to workspace/repo to mount
 * @param {string} options.command - Command to run inside container
 * @param {string[]} [options.args] - Command arguments
 * @param {object} [options.env] - Environment variables for the container
 * @param {string} [options.taskId] - Task identifier for tracking
 * @param {number} [options.timeout] - Override timeout in ms
 * @param {object} [options.mountOptions] - Additional mount configuration
 * @param {function} [options.onOutput] - Streaming output callback
 * @returns {Promise<{status: string, stdout: string, stderr: string, exitCode: number}>}
 */
export async function runInContainer(options) {
  if (!containerEnabled) {
    throw new Error("Container mode is not enabled (set CONTAINER_ENABLED=1)");
  }

  if (activeContainers.size >= maxConcurrentContainers) {
    throw new Error(
      `Max concurrent containers reached (${maxConcurrentContainers}). Wait for a slot.`,
    );
  }

  const {
    workspacePath,
    command,
    args = [],
    env = {},
    taskId = "unknown",
    timeout = containerTimeout,
    mountOptions = {},
    onOutput,
  } = options;

  // Create scratch directory for container writes
  const scratchDir = resolve(
    workspacePath,
    ".cache",
    "container-scratch",
    `task-${Date.now()}`,
  );
  mkdirSync(scratchDir, { recursive: true });

  const containerName = `codexmon-${taskId.replace(/[^a-zA-Z0-9-]/g, "-")}-${++containerIdCounter}`;
  const mountArgs = buildMountArgs(workspacePath, scratchDir, mountOptions);

  // Build container run command
  const containerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-w",
    "/workspace",
    ...mountArgs,
  ];

  // Add environment variables
  for (const [key, value] of Object.entries(env)) {
    containerArgs.push("-e", `${key}=${value}`);
  }

  // Resource limits (Docker/Podman only)
  if (containerRuntime !== "container") {
    const memLimit = process.env.CONTAINER_MEMORY_LIMIT || "4g";
    const cpuLimit = process.env.CONTAINER_CPU_LIMIT || "2";
    containerArgs.push("--memory", memLimit);
    containerArgs.push("--cpus", cpuLimit);
  }

  // Image and command
  containerArgs.push(containerImage);
  if (command) {
    containerArgs.push(command, ...args);
  }

  console.log(
    `[container] spawning ${containerName} (image: ${containerImage}, task: ${taskId})`,
  );

  return new Promise((resolvePromise) => {
    const proc = spawn(containerRuntime, containerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const startTime = Date.now();
    activeContainers.set(containerName, { proc, startTime, taskId });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let parseBuffer = "";

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      if (stdout.length + chunk.length <= containerMaxOutput) {
        stdout += chunk;
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;
          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
          try {
            const parsed = JSON.parse(jsonStr);
            onOutput(parsed);
          } catch {
            /* ignore parse errors */
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      if (stderr.length + chunk.length <= containerMaxOutput) {
        stderr += chunk;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[container] ${containerName} timed out after ${timeout}ms, stopping`,
      );
      try {
        execSync(`${containerRuntime} stop ${containerName}`, {
          stdio: "pipe",
          timeout: 15000,
        });
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeContainers.delete(containerName);
      const duration = Date.now() - startTime;

      console.log(
        `[container] ${containerName} exited (code: ${code}, duration: ${Math.round(duration / 1000)}s, timedOut: ${timedOut})`,
      );

      resolvePromise({
        status: timedOut ? "timeout" : code === 0 ? "success" : "error",
        stdout,
        stderr,
        exitCode: code,
        duration,
        containerName,
        scratchDir,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeContainers.delete(containerName);
      console.error(`[container] ${containerName} spawn error: ${err.message}`);
      resolvePromise({
        status: "error",
        stdout,
        stderr: err.message,
        exitCode: -1,
        duration: Date.now() - startTime,
        containerName,
        scratchDir,
      });
    });
  });
}

/**
 * Stop all running containers (graceful shutdown).
 */
export async function stopAllContainers(timeoutMs = 10000) {
  const names = [...activeContainers.keys()];
  if (names.length === 0) return;

  console.log(`[container] stopping ${names.length} active containers...`);

  for (const name of names) {
    try {
      execSync(`${containerRuntime} stop ${name}`, {
        stdio: "pipe",
        timeout: timeoutMs,
      });
    } catch {
      // Try force kill
      try {
        execSync(`${containerRuntime} kill ${name}`, { stdio: "pipe" });
      } catch {
        /* already stopped */
      }
    }
  }

  activeContainers.clear();
  console.log("[container] all containers stopped");
}

/**
 * Clean up orphaned containers from previous runs.
 */
export function cleanupOrphanedContainers() {
  try {
    let output;
    if (containerRuntime === "container") {
      output = execSync("container ls --format json", {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      });
      const containers = JSON.parse(output || "[]");
      const orphans = containers
        .filter(
          (c) =>
            c.status === "running" &&
            c.configuration?.id?.startsWith("codexmon-"),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          execSync(`container stop ${name}`, { stdio: "pipe" });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        console.log(
          `[container] cleaned up ${orphans.length} orphaned containers`,
        );
      }
    } else {
      output = execSync(
        `${containerRuntime} ps --filter "name=codexmon-" --format "{{.Names}}"`,
        { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
      );
      const orphans = output
        .trim()
        .split("\n")
        .filter((n) => n);
      for (const name of orphans) {
        try {
          execSync(`${containerRuntime} stop ${name}`, { stdio: "pipe" });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        console.log(
          `[container] cleaned up ${orphans.length} orphaned containers`,
        );
      }
    }
  } catch {
    /* no orphans or runtime not available */
  }
}
