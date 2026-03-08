import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  PROMPT_DIR,
  SKILL_DIR,
  PROFILE_DIR,
  MCP_DIR,
  rebuildManifest,
  rebuildAgentProfileIndex,
  loadAgentProfileIndex,
  matchAgentProfiles,
  resolveLibraryPlan,
} from "../../infra/library-manager.mjs";

function parseIntArg(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = Number.parseInt(hit.slice(name.length + 3), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function measure(label, fn) {
  const start = performance.now();
  const result = fn();
  const durationMs = Number((performance.now() - start).toFixed(2));
  return { label, durationMs, result };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index].toFixed(2));
}

function createAgentProfile(index) {
  const domain = index % 3 === 0 ? "ui" : index % 3 === 1 ? "api" : "infra";
  return {
    id: `bench-agent-${index}`,
    name: `Bench Agent ${index}`,
    description: `Synthetic ${domain} agent for resolver benchmarking`,
    titlePatterns: [`\\b${domain}\\b`, `\\bissue-${index}\\b`],
    scopes: [domain, `${domain}/module-${index % 25}`],
    tags: [domain, "benchmark", `cluster-${index % 20}`],
    agentType: "task",
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    enabledTools: null,
    enabledMcpServers: [],
  };
}

function ensureFixtureDirs(rootDir) {
  mkdirSync(resolve(rootDir, PROMPT_DIR), { recursive: true });
  mkdirSync(resolve(rootDir, SKILL_DIR), { recursive: true });
  mkdirSync(resolve(rootDir, PROFILE_DIR), { recursive: true });
  mkdirSync(resolve(rootDir, MCP_DIR), { recursive: true });
}

const config = {
  agents: parseIntArg("agents", 500),
  prompts: parseIntArg("prompts", 500),
  skills: parseIntArg("skills", 5000),
  mcps: parseIntArg("mcps", 1000),
  iterations: parseIntArg("iterations", 40),
};

const rootDir = mkdtempSync(join(tmpdir(), "bosun-library-bench-"));

try {
  const fixturePopulate = measure("fixturePopulate", () => {
    ensureFixtureDirs(rootDir);

    for (let index = 0; index < config.prompts; index += 1) {
      writeFileSync(
        resolve(rootDir, PROMPT_DIR, `bench-prompt-${index}.md`),
        `# Bench Prompt ${index}\n\nSynthetic benchmark prompt.\n`,
        "utf8",
      );
    }

    for (let index = 0; index < config.skills; index += 1) {
      writeFileSync(
        resolve(rootDir, SKILL_DIR, `bench-skill-${index}.md`),
        `# Bench Skill ${index}\n\nReusable synthetic benchmark skill.\n`,
        "utf8",
      );
    }

    for (let index = 0; index < config.mcps; index += 1) {
      writeFileSync(
        resolve(rootDir, MCP_DIR, `bench-mcp-${index}.json`),
        JSON.stringify({
          id: `bench-mcp-${index}`,
          name: `Bench MCP ${index}`,
          description: "Synthetic benchmark MCP",
          transport: "stdio",
          command: "node",
          args: ["-e", "process.exit(0)"],
          env: {},
          tags: ["benchmark", `mcp-${index % 50}`],
        }, null, 2) + "\n",
        "utf8",
      );
    }

    for (let index = 0; index < config.agents; index += 1) {
      const profile = createAgentProfile(index);
      writeFileSync(
        resolve(rootDir, PROFILE_DIR, `${profile.id}.json`),
        JSON.stringify(profile, null, 2) + "\n",
        "utf8",
      );
    }
  });

  const rebuild = measure("manifestRebuild", () => rebuildManifest(rootDir));
  const indexBuild = measure("agentIndexBuild", () => rebuildAgentProfileIndex(rootDir));
  const indexLoad = measure("agentIndexLoad", () => loadAgentProfileIndex(rootDir));

  const coldResolve = measure("coldResolve", () =>
    matchAgentProfiles(rootDir, {
      title: "fix(ui): benchmark resolver regression",
      description: "Investigate ui workflow issue and component rendering bug",
      changedFiles: ["ui/tabs/library.js", "ui/styles/layout.css"],
      topN: 5,
    }));

  const coldPlanResolve = measure("coldPlanResolve", () =>
    resolveLibraryPlan(rootDir, {
      title: "fix(ui): benchmark resolver regression",
      description: "Investigate ui workflow issue and component rendering bug",
      changedFiles: ["ui/tabs/library.js", "ui/styles/layout.css"],
      topN: 5,
      skillTopN: 6,
    }));

  const iterations = [];
  const planIterations = [];
  for (let index = 0; index < config.iterations; index += 1) {
    const titleDomain = index % 2 === 0 ? "ui" : "api";
    const sample = measure("warmResolve", () =>
      matchAgentProfiles(rootDir, {
        title: `fix(${titleDomain}): benchmark issue-${index % Math.max(config.agents, 1)}`,
        description: `Synthetic ${titleDomain} benchmark iteration ${index}`,
        changedFiles: [`${titleDomain}/module-${index % 25}/file-${index}.js`],
        topN: 5,
      }));
    iterations.push(sample.durationMs);

    const planSample = measure("warmPlanResolve", () =>
      resolveLibraryPlan(rootDir, {
        title: `fix(${titleDomain}): benchmark issue-${index % Math.max(config.agents, 1)}`,
        description: `Synthetic ${titleDomain} benchmark iteration ${index}`,
        changedFiles: [`${titleDomain}/module-${index % 25}/file-${index}.js`],
        topN: 5,
        skillTopN: 6,
      }));
    planIterations.push(planSample.durationMs);
  }

  const output = {
    config,
    timings: {
      fixturePopulateMs: fixturePopulate.durationMs,
      manifestRebuildMs: rebuild.durationMs,
      agentIndexBuildMs: indexBuild.durationMs,
      agentIndexLoadMs: indexLoad.durationMs,
      coldResolveMs: coldResolve.durationMs,
      coldPlanResolveMs: coldPlanResolve.durationMs,
      warmResolve: {
        iterations: config.iterations,
        p50Ms: percentile(iterations, 0.5),
        p95Ms: percentile(iterations, 0.95),
        p99Ms: percentile(iterations, 0.99),
        minMs: iterations.length ? Number(Math.min(...iterations).toFixed(2)) : 0,
        maxMs: iterations.length ? Number(Math.max(...iterations).toFixed(2)) : 0,
      },
      warmPlanResolve: {
        iterations: config.iterations,
        p50Ms: percentile(planIterations, 0.5),
        p95Ms: percentile(planIterations, 0.95),
        p99Ms: percentile(planIterations, 0.99),
        minMs: planIterations.length ? Number(Math.min(...planIterations).toFixed(2)) : 0,
        maxMs: planIterations.length ? Number(Math.max(...planIterations).toFixed(2)) : 0,
      },
    },
    counts: {
      indexedAgents: Number(indexBuild.result?.count || 0),
      bestMatchId: coldResolve.result?.best?.id || null,
      candidateCount: Array.isArray(coldResolve.result?.candidates) ? coldResolve.result.candidates.length : 0,
      planSkillCount: Array.isArray(coldPlanResolve.result?.plan?.skillIds) ? coldPlanResolve.result.plan.skillIds.length : 0,
    },
  };

  console.log(JSON.stringify(output, null, 2));
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}
