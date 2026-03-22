/**
 * runner-pool.mjs — isolated lease broker for heavyweight validation runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runInContainer, isContainerEnabled } from "./container-runner.mjs";

const HEAVY_TYPES = new Set(["build", "test", "validation", "diff", "pre-push"]);

function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function shouldOffloadHeavyRun(config = {}) {
  if (config?.heavyRun === true) return true;
  const heavyType = String(config?.heavyType || config?.commandType || "").trim().toLowerCase();
  return HEAVY_TYPES.has(heavyType);
}

export function classifyHeavyRun(config = {}) {
  const heavyType = String(config?.heavyType || config?.commandType || "").trim().toLowerCase();
  return HEAVY_TYPES.has(heavyType) ? heavyType : "validation";
}

function normalizeArtifacts(artifacts, workspaceRoot, leaseId) {
  const items = Array.isArray(artifacts) ? artifacts : [];
  const artifactDir = resolve(workspaceRoot || process.cwd(), ".bosun", "runner-artifacts", leaseId);
  mkdirSync(artifactDir, { recursive: true });
  return items.map((artifact, index) => {
    const name = String(artifact?.name || `artifact-${index + 1}`);
    const fileName = String(artifact?.fileName || `${name}.txt`).replace(/[\\/:*?"<>|]+/g, "-");
    const targetPath = join(artifactDir, fileName);
    const content = artifact?.content == null ? "" : String(artifact.content);
    if (content) writeFileSync(targetPath, content, "utf8");
    return {
      name,
      path: artifact?.path || targetPath,
      retrieveCommand: String(
        artifact?.retrieveCommand || `node -e "console.log(require('node:fs').readFileSync('${targetPath.replace(/\\/g, "\\\\")}', 'utf8'))"`,
      ),
      bytes: artifact?.bytes ?? Buffer.byteLength(content, "utf8"),
    };
  });
}

export function createRunnerPool(options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  return {
    async acquireLease(request = {}) {
      const leaseId = `lease-${randomUUID()}`;
      const isolated = parseBool(process.env.BOSUN_HEAVY_RUNNER_USE_CONTAINER, true) && isContainerEnabled();
      return {
        id: leaseId,
        mode: isolated ? "container" : "local",
        async runCommand(runRequest = {}) {
          const startedAt = Date.now();
          if (isolated) {
            const result = await runInContainer({
              command: runRequest.command,
              workDir: runRequest.cwd || workspaceRoot,
              env: runRequest.env || {},
              taskId: request.taskId || request.workflowRunId || leaseId,
            });
            return {
              exitCode: result.exitCode ?? 0,
              stdout: result.stdout || result.output || "",
              stderr: result.stderr || "",
              durationMs: result.durationMs ?? (Date.now() - startedAt),
              artifacts: normalizeArtifacts(runRequest.artifacts, workspaceRoot, leaseId),
            };
          }
          throw new Error("No isolated runners available");
        },
        async release() {
          return true;
        },
      };
    },
  };
}

export default createRunnerPool;
