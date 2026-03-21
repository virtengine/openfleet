import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const hours = Number(process.env.BOSUN_GITHUB_SYNC_LOOKBACK_HOURS || "24") || 24;
const repoScope = String(process.env.BOSUN_GITHUB_SYNC_REPO_SCOPE || "auto").trim() || "auto";
const since = new Date(Date.now() - hours * 3_600_000).toISOString();

function ghJson(args) {
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function configPath() {
  const home = String(process.env.BOSUN_HOME || process.env.VK_PROJECT_DIR || "").trim();
  return home ? path.join(home, "bosun.config.json") : path.join(process.cwd(), "bosun.config.json");
}

function collectReposFromConfig() {
  const repos = [];
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
    if (workspaces.length > 0) {
      const activeWorkspace = String(config?.activeWorkspace || "").trim().toLowerCase();
      const selectedWorkspace = activeWorkspace
        ? workspaces.find((workspace) => String(workspace?.id || "").trim().toLowerCase() === activeWorkspace)
        : null;
      const workspaceList = selectedWorkspace ? [selectedWorkspace] : workspaces;
      for (const workspace of workspaceList) {
        for (const repo of Array.isArray(workspace?.repos) ? workspace.repos : []) {
          const slug = typeof repo === "string" ? String(repo).trim() : String(repo?.slug || "").trim();
          if (slug) repos.push(slug);
        }
      }
    }
    if (repos.length === 0) {
      for (const repo of Array.isArray(config?.repos) ? config.repos : []) {
        const slug = typeof repo === "string" ? String(repo).trim() : String(repo?.slug || "").trim();
        if (slug) repos.push(slug);
      }
    }
  } catch {}
  return repos;
}

function resolveRepoTargets() {
  if (repoScope && repoScope !== "auto" && repoScope !== "all" && repoScope !== "current") {
    return [...new Set(repoScope.split(",").map((value) => value.trim()).filter(Boolean))];
  }
  if (repoScope === "current") return [""];
  const configRepos = collectReposFromConfig();
  if (configRepos.length > 0) return [...new Set(configRepos)];
  const envRepo = String(process.env.GITHUB_REPOSITORY || "").trim();
  if (envRepo) return [envRepo];
  return [""];
}

function parseRepoFromUrl(url) {
  const raw = String(url || "");
  const marker = "github.com/";
  const index = raw.toLowerCase().indexOf(marker);
  if (index < 0) return "";
  const tail = raw.slice(index + marker.length).split("/");
  if (tail.length < 2) return "";
  const owner = String(tail[0] || "").trim();
  const repo = String(tail[1] || "").trim();
  return owner && repo ? `${owner}/${repo}` : "";
}

function extractTaskId(pr) {
  const source = String((pr.body || "") + "\n" + (pr.title || ""));
  const match = source.match(/(?:Bosun-Task|VE-Task|Task-ID|task[_-]?id)[:\s]+([a-zA-Z0-9_-]{4,64})/i);
  return match ? match[1].trim() : null;
}

const repoTargets = resolveRepoTargets();
const merged = [];
const open = [];
for (const target of repoTargets) {
  const repo = String(target || "").trim();
  const mergedArgs = ["pr", "list", "--state", "merged", "--label", "bosun-attached", "--json", "number,title,body,headRefName,mergedAt,url", "--limit", "50"];
  const openArgs = ["pr", "list", "--state", "open", "--label", "bosun-attached", "--json", "number,title,body,headRefName,isDraft,url", "--limit", "50"];
  if (repo) {
    mergedArgs.push("--repo", repo);
    openArgs.push("--repo", repo);
  }
  for (const pr of ghJson(mergedArgs)) {
    merged.push({
      ...pr,
      __repo: repo || parseRepoFromUrl(pr?.url) || String(process.env.GITHUB_REPOSITORY || "").trim(),
    });
  }
  for (const pr of ghJson(openArgs)) {
    open.push({
      ...pr,
      __repo: repo || parseRepoFromUrl(pr?.url) || String(process.env.GITHUB_REPOSITORY || "").trim(),
    });
  }
}

const recentMerged = merged.filter((pr) => !pr.mergedAt || new Date(pr.mergedAt) >= new Date(since));

console.log(JSON.stringify({
  repoScope,
  reposScanned: repoTargets.length,
  merged: recentMerged.map((pr) => ({
    n: pr.number,
    repo: pr.__repo || "",
    title: pr.title,
    branch: pr.headRefName,
    taskId: extractTaskId(pr),
  })),
  open: open
    .filter((pr) => !pr.isDraft)
    .map((pr) => ({
      n: pr.number,
      repo: pr.__repo || "",
      title: pr.title,
      branch: pr.headRefName,
      taskId: extractTaskId(pr),
    })),
}));
