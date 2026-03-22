import { spawnSync } from "node:child_process";
import { nowISO, toStringArray, uniqueStrings } from "./library-manager-utils.mjs";

const wellKnownSourceProbeCache = new Map();
const TRUSTED_GITHUB_OWNERS = new Set(["microsoft", "github", "azure", "desktop", "canonical", "mastra-ai"]);

export const WELL_KNOWN_AGENT_SOURCES = Object.freeze([
  // ── Microsoft — Official ──────────────────────────────────────────────────
  {
    id: "microsoft-skills",
    name: "Microsoft Skills",
    repoUrl: "https://github.com/microsoft/skills.git",
    defaultBranch: "main",
    description: "Microsoft-maintained backend, frontend, planner, infrastructure, and scaffolder agents with hundreds of Azure SDK skills.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    estimatedPlugins: 180,
    focuses: ["backend", "frontend", "planner", "infra", "scaffolding", "azure"],
  },
  {
    id: "microsoft-hve-core",
    name: "Microsoft HVE Core",
    repoUrl: "https://github.com/microsoft/hve-core.git",
    defaultBranch: "main",
    description: "Core HVE agent library with domain and plugin agent templates and experimental skills.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    estimatedPlugins: 60,
    focuses: ["core", "plugins", "platform"],
  },
  {
    id: "microsoft-vscode",
    name: "Microsoft VS Code",
    repoUrl: "https://github.com/microsoft/vscode.git",
    defaultBranch: "main",
    description: "VS Code editor skills for hygiene, testing, and extension development workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 15,
    focuses: ["vscode", "editor", "extensions", "testing"],
  },
  {
    id: "microsoft-powertoys",
    name: "Microsoft PowerToys",
    repoUrl: "https://github.com/microsoft/PowerToys.git",
    defaultBranch: "main",
    description: "PowerToys development skills for Windows utility and plugin engineering.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 10,
    focuses: ["windows", "utilities", "c-sharp", "plugins"],
  },
  {
    id: "microsoft-typespec",
    name: "Microsoft TypeSpec",
    repoUrl: "https://github.com/microsoft/typespec.git",
    defaultBranch: "main",
    description: "TypeSpec API definition language skills for code generation and API design workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 20,
    focuses: ["api", "code-generation", "typescript", "openapi"],
  },
  {
    id: "microsoft-copilot-for-azure",
    name: "GitHub Copilot for Azure",
    repoUrl: "https://github.com/microsoft/GitHub-Copilot-for-Azure.git",
    defaultBranch: "main",
    description: "Azure-focused Copilot skills for cloud infrastructure, deployment, and resource management.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    estimatedPlugins: 45,
    focuses: ["azure", "cloud", "infrastructure", "deployment"],
  },
  {
    id: "microsoft-vscode-python-environments",
    name: "Microsoft VS Code Python Environments",
    repoUrl: "https://github.com/microsoft/vscode-python-environments.git",
    defaultBranch: "main",
    description: "Maintainer, reviewer, and documentation agents for a production VS Code extension.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 8,
    focuses: ["vscode", "python", "extension", "maintainer"],
  },
  {
    id: "microsoft-vscode-docs",
    name: "Microsoft VS Code Documentation",
    repoUrl: "https://github.com/microsoft/vscode-docs.git",
    defaultBranch: "main",
    description: "Skills for VS Code documentation authoring, editing, and review workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 12,
    focuses: ["documentation", "vscode", "markdown", "authoring"],
  },
  {
    id: "microsoft-windowsappsdk",
    name: "Microsoft Windows App SDK",
    repoUrl: "https://github.com/microsoft/WindowsAppSDK.git",
    defaultBranch: "main",
    description: "Windows App SDK skills for WinUI and Windows platform development.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 8,
    focuses: ["windows", "winui", "sdk", "desktop"],
  },
  {
    id: "microsoft-vscode-java-pack",
    name: "Microsoft VS Code Java Pack",
    repoUrl: "https://github.com/microsoft/vscode-java-pack.git",
    defaultBranch: "main",
    description: "Java development skills for VS Code including debugging, testing, and project management.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 10,
    focuses: ["java", "vscode", "debugging", "testing"],
  },
  {
    id: "microsoft-duroxide",
    name: "Microsoft Duroxide",
    repoUrl: "https://github.com/microsoft/duroxide.git",
    defaultBranch: "main",
    description: "Durable Functions in Rust — skills for building resilient serverless workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 6,
    focuses: ["rust", "serverless", "durable-functions", "workflows"],
  },
  {
    id: "microsoft-ebpf-for-windows",
    name: "Microsoft eBPF for Windows",
    repoUrl: "https://github.com/microsoft/ebpf-for-windows.git",
    defaultBranch: "main",
    description: "eBPF development skills for Windows kernel and networking instrumentation.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 6,
    focuses: ["ebpf", "windows", "kernel", "networking"],
  },
  // ── GitHub — Official ─────────────────────────────────────────────────────
  {
    id: "github-copilot-sdk",
    name: "GitHub Copilot SDK",
    repoUrl: "https://github.com/github/copilot-sdk.git",
    defaultBranch: "main",
    description: "Official GitHub workflow-authoring and docs-maintenance agents for Copilot SDK projects.",
    owner: "github",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 10,
    focuses: ["copilot", "workflow", "docs"],
  },
  {
    id: "github-desktop",
    name: "GitHub Desktop",
    repoUrl: "https://github.com/desktop/desktop.git",
    defaultBranch: "development",
    description: "GitHub Desktop app agent profiles for Electron, TypeScript, and Git workflow development.",
    owner: "desktop",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 10,
    focuses: ["electron", "typescript", "git", "desktop"],
  },
  // ── Azure — Official ──────────────────────────────────────────────────────
  {
    id: "azure-sdk-for-js",
    name: "Azure SDK for JavaScript",
    repoUrl: "https://github.com/Azure/azure-sdk-for-js.git",
    defaultBranch: "main",
    description: "Azure JavaScript SDK repo with agentic workflow authoring guidance and prompts.",
    owner: "azure",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 15,
    focuses: ["azure", "javascript", "sdk", "workflow"],
  },
  // ── Community — Verified ──────────────────────────────────────────────────
  {
    id: "mastra-ai-mastra",
    name: "Mastra AI Framework",
    repoUrl: "https://github.com/mastra-ai/mastra.git",
    defaultBranch: "main",
    description: "AI agent framework with extensive prompt templates for issue tracking, code review, and workflow automation.",
    owner: "mastra-ai",
    trustTier: "community",
    importCoverage: "high",
    estimatedPlugins: 40,
    focuses: ["ai", "agents", "prompts", "automation"],
  },
  {
    id: "z3prover-z3",
    name: "Z3 Theorem Prover",
    repoUrl: "https://github.com/Z3Prover/z3.git",
    defaultBranch: "master",
    description: "Z3 SMT solver agent profiles for formal verification and constraint solving workflows.",
    owner: "Z3Prover",
    trustTier: "community",
    importCoverage: "low",
    estimatedPlugins: 3,
    focuses: ["formal-verification", "smt", "solver", "c++"],
  },
  {
    id: "likec4-likec4",
    name: "LikeC4",
    repoUrl: "https://github.com/likec4/likec4.git",
    defaultBranch: "main",
    description: "Architecture-as-code tool with agents for diagram generation and architecture documentation.",
    owner: "likec4",
    trustTier: "community",
    importCoverage: "medium",
    estimatedPlugins: 12,
    focuses: ["architecture", "diagrams", "documentation", "c4"],
  },
  {
    id: "canonical-copilot-collections",
    name: "Canonical Copilot Collections",
    repoUrl: "https://github.com/canonical/copilot-collections.git",
    defaultBranch: "main",
    description: "Canonical's curated collection of Copilot agent definitions for Ubuntu and open-source development.",
    owner: "canonical",
    trustTier: "community",
    importCoverage: "high",
    estimatedPlugins: 50,
    focuses: ["ubuntu", "linux", "open-source", "devops"],
  },
  {
    id: "playwright-mcp-prompts",
    name: "Playwright MCP Prompts",
    repoUrl: "https://github.com/debs-obrien/playwright-mcp-prompts.git",
    defaultBranch: "main",
    description: "Prompt templates for Playwright end-to-end testing, page objects, and test generation.",
    owner: "debs-obrien",
    trustTier: "community",
    importCoverage: "high",
    estimatedPlugins: 25,
    focuses: ["playwright", "testing", "e2e", "automation"],
  },
  {
    id: "copilot-prompts-collection",
    name: "GitHub Copilot Prompts",
    repoUrl: "https://github.com/raffertyuy/github-copilot-prompts.git",
    defaultBranch: "main",
    description: "Curated collection of GitHub Copilot prompt files for code review, refactoring, and documentation.",
    owner: "raffertyuy",
    trustTier: "community",
    importCoverage: "high",
    estimatedPlugins: 30,
    focuses: ["prompts", "code-review", "refactoring", "docs"],
  },
  {
    id: "copilot-kit",
    name: "Copilot Kit",
    repoUrl: "https://github.com/TheSethRose/Copilot-Kit.git",
    defaultBranch: "main",
    description: "Comprehensive Copilot customization kit with agent profiles, skills, and prompt templates.",
    owner: "TheSethRose",
    trustTier: "community",
    importCoverage: "high",
    estimatedPlugins: 35,
    focuses: ["copilot", "agents", "skills", "prompts"],
  },
  {
    id: "dataplat-dbatools",
    name: "dbatools",
    repoUrl: "https://github.com/dataplat/dbatools.git",
    defaultBranch: "development",
    description: "SQL Server and database administration prompts for DBA workflows and automation.",
    owner: "dataplat",
    trustTier: "community",
    importCoverage: "medium",
    estimatedPlugins: 10,
    focuses: ["sql-server", "database", "powershell", "administration"],
  },
  {
    id: "finops-focus-spec",
    name: "FinOps FOCUS Spec",
    repoUrl: "https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec.git",
    defaultBranch: "working_draft",
    description: "FinOps specification prompts for cloud cost management and financial operations workflows.",
    owner: "FinOps-Open-Cost-and-Usage-Spec",
    trustTier: "community",
    importCoverage: "medium",
    estimatedPlugins: 8,
    focuses: ["finops", "cloud-costs", "specification", "governance"],
  },
  // ── MCP Tool Repositories ──────────────────────────────────────────────────
  {
    id: "modelcontextprotocol-servers",
    name: "MCP Official Servers",
    repoUrl: "https://github.com/modelcontextprotocol/servers.git",
    defaultBranch: "main",
    description: "Official Model Context Protocol reference servers — filesystem, GitHub, Git, Postgres, Slack, Google Maps, Puppeteer, and more.",
    owner: "modelcontextprotocol",
    trustTier: "official",
    importCoverage: "high",
    estimatedPlugins: 25,
    focuses: ["mcp", "tools", "filesystem", "database", "web", "search"],
  },
  {
    id: "github-mcp-server",
    name: "GitHub MCP Server",
    repoUrl: "https://github.com/github/github-mcp-server.git",
    defaultBranch: "main",
    description: "Official GitHub MCP server for repository management, issues, pull requests, and code search.",
    owner: "github",
    trustTier: "official",
    importCoverage: "medium",
    estimatedPlugins: 3,
    focuses: ["mcp", "github", "issues", "pull-requests", "code-search"],
  },
  {
    id: "punkpeye-awesome-mcp-servers",
    name: "Awesome MCP Servers",
    repoUrl: "https://github.com/punkpeye/awesome-mcp-servers.git",
    defaultBranch: "main",
    description: "Community-curated list of MCP server implementations — databases, dev tools, cloud platforms, AI services, and productivity tools.",
    owner: "punkpeye",
    trustTier: "community",
    importCoverage: "low",
    estimatedPlugins: 5,
    focuses: ["mcp", "tools", "community", "catalog"],
  },
]);

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeWellKnownSource(source = {}) {
  const repoUrl = String(source.repoUrl || "").trim();
  const github = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  const owner = String(source.owner || (github?.[1] || "")).trim();
  const repo = String(source.repo || (github?.[2] || "")).trim();
  return {
    ...source,
    owner: owner || null,
    repo: repo || null,
    provider: source.provider || (github ? "github" : null),
    importCoverage: String(source.importCoverage || "medium"),
    focuses: toStringArray(source.focuses),
  };
}

function compareWellKnownSources(a, b) {
  // Sort by estimated plugin count (most first), then trust score, then name
  const pluginDelta = Number(b?.estimatedPlugins || 0) - Number(a?.estimatedPlugins || 0);
  if (pluginDelta !== 0) return pluginDelta;
  const delta = Number(b?.trust?.score || 0) - Number(a?.trust?.score || 0);
  if (delta !== 0) return delta;
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

export function computeWellKnownSourceTrust(source, probe = {}, options = {}) {
  const nowMs = Number(options?.nowMs || Date.now());
  const normalized = normalizeWellKnownSource(source);
  const reasons = [];
  let score = 20;

  if (normalized.trustTier === "official") {
    score += 25;
    reasons.push("official-maintainer");
  }
  if (TRUSTED_GITHUB_OWNERS.has(String(normalized.owner || "").toLowerCase())) {
    score += 15;
    reasons.push("trusted-owner");
  }
  if (normalized.importCoverage === "high") {
    score += 12;
    reasons.push("high-import-coverage");
  } else if (normalized.importCoverage === "medium") {
    score += 6;
    reasons.push("import-coverage");
  }
  if (normalized.provider === "github") {
    score += 4;
    reasons.push("github-source");
  }

  const stars = Number(probe?.stars || 0);
  if (stars >= 10000) {
    score += 10;
    reasons.push("popular-repo");
  } else if (stars >= 1000) {
    score += 6;
    reasons.push("established-repo");
  } else if (stars >= 100) {
    score += 3;
  }

  const daysSincePush = Number.isFinite(probe?.daysSincePush)
    ? Number(probe.daysSincePush)
    : (probe?.pushedAt ? Math.max(0, (nowMs - Date.parse(probe.pushedAt)) / 86400000) : null);
  if (daysSincePush != null) {
    if (daysSincePush <= 45) {
      score += 10;
      reasons.push("recently-updated");
    } else if (daysSincePush <= 180) {
      score += 6;
      reasons.push("active-updates");
    } else if (daysSincePush <= 365) {
      score += 2;
    } else if (daysSincePush > 730) {
      score -= 16;
      reasons.push("stale-upstream");
    }
  }

  if (probe?.reachable === true) {
    score += 8;
    reasons.push("remote-reachable");
  } else if (probe?.reachable === false) {
    score -= 28;
    reasons.push("remote-unreachable");
  }

  if (probe?.branchExists === true) {
    score += 6;
    reasons.push("branch-ok");
  } else if (probe?.branchExists === false) {
    score -= 22;
    reasons.push("branch-missing");
  }

  if (probe?.archived === true) {
    score -= 45;
    reasons.push("archived");
  }
  if (probe?.disabled === true) {
    score -= 45;
    reasons.push("disabled");
  }

  score = Math.round(clampNumber(score, 0, 100));
  // Hard-disable only for unreachable/archived/disabled repos — low score gets a warning but remains importable
  const hardBlocked = probe?.archived === true || probe?.disabled === true || probe?.reachable === false || probe?.branchExists === false;
  const enabled = !hardBlocked;
  const lowTrust = score < 55;
  const status = hardBlocked ? "disabled" : score >= 85 ? "healthy" : score >= 65 ? "warning" : score >= 55 ? "degraded" : "low-trust";

  return {
    score,
    status,
    enabled,
    lowTrust,
    reasons: uniqueStrings(reasons),
  };
}

function buildWellKnownSourceResult(source, probe = null, options = {}) {
  const normalized = normalizeWellKnownSource(source);
  const trust = computeWellKnownSourceTrust(normalized, probe || {}, options);
  return {
    ...normalized,
    trust,
    probe: probe ? { ...probe } : null,
    enabled: trust.enabled,
    status: trust.status,
  };
}

export function listWellKnownAgentSources() {
  return WELL_KNOWN_AGENT_SOURCES
    .map((source) => buildWellKnownSourceResult(source))
    .sort(compareWellKnownSources);
}

export function clearWellKnownAgentSourceProbeCache() {
  wellKnownSourceProbeCache.clear();
}

async function fetchGithubRepoProbe(source, options = {}) {
  const normalized = normalizeWellKnownSource(source);
  if (normalized.provider !== "github" || !normalized.owner || !normalized.repo) {
    return { checkedAt: nowISO(), reachable: false, branchExists: false, error: "Unsupported repository provider" };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawnSync;
  const branch = String(normalized.defaultBranch || "main").trim() || "main";
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "bosun-library-manager",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let repoMeta = null;
  let repoError = null;
  if (typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${normalized.owner}/${normalized.repo}`, { headers });
      if (response?.ok) {
        repoMeta = await response.json();
      } else {
        repoError = `GitHub API returned ${Number(response?.status || 0) || "error"}`;
      }
    } catch (err) {
      repoError = err?.message || String(err);
    }
  } else {
    repoError = "fetch unavailable";
  }

  let reachable = false;
  let branchExists = false;
  let gitError = null;
  try {
    const remote = spawnImpl("git", ["ls-remote", "--exit-code", "--heads", normalized.repoUrl, branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number(options.timeoutMs || 15000),
    });
    const stdout = String(remote?.stdout || "").trim();
    reachable = Number(remote?.status) === 0 || stdout.length > 0;
    branchExists = reachable && stdout.length > 0;
    if (!reachable || !branchExists) {
      gitError = String(remote?.stderr || remote?.stdout || "git ls-remote failed").trim() || null;
    }
  } catch (err) {
    gitError = err?.message || String(err);
  }

  return {
    checkedAt: nowISO(),
    reachable,
    branchExists,
    defaultBranch: String(repoMeta?.default_branch || branch || "main"),
    archived: repoMeta?.archived === true,
    disabled: repoMeta?.disabled === true,
    stars: Number(repoMeta?.stargazers_count || 0),
    forks: Number(repoMeta?.forks_count || 0),
    openIssues: Number(repoMeta?.open_issues_count || 0),
    pushedAt: repoMeta?.pushed_at || null,
    daysSincePush: repoMeta?.pushed_at ? Math.max(0, Math.round((Date.now() - Date.parse(repoMeta.pushed_at)) / 86400000)) : null,
    apiReachable: Boolean(repoMeta),
    importReady: reachable && branchExists && repoMeta?.archived !== true && repoMeta?.disabled !== true,
    error: gitError || repoError || null,
  };
}

export async function probeWellKnownAgentSources(options = {}) {
  const nowMs = Number(options?.nowMs || Date.now());
  const ttlMs = Math.max(1000, Number(options?.ttlMs || 30 * 60 * 1000));
  const sourceId = String(options?.sourceId || "").trim().toLowerCase();
  const refresh = options?.refresh === true;
  const sources = WELL_KNOWN_AGENT_SOURCES.filter((source) => !sourceId || source.id === sourceId);
  const results = [];

  for (const source of sources) {
    const cacheKey = source.id;
    const cached = wellKnownSourceProbeCache.get(cacheKey) || null;
    if (!refresh && cached && (nowMs - Number(cached.cachedAt || 0)) < ttlMs) {
      results.push(buildWellKnownSourceResult(source, cached.probe, { nowMs }));
      continue;
    }

    const probe = await fetchGithubRepoProbe(source, options);
    wellKnownSourceProbeCache.set(cacheKey, { cachedAt: nowMs, probe });
    results.push(buildWellKnownSourceResult(source, probe, { nowMs }));
  }

  return results.sort(compareWellKnownSources);
}
