import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addComment as addKanbanComment,
  getKanbanAdapter,
  getKanbanBackendName,
  updateTaskStatus,
} from "./kanban-adapter.mjs";

const execFileAsync = promisify(execFile);
const TAG = "[gh-reconciler]";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MERGED_LOOKBACK_HOURS = 72;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRepoSlug(raw) {
  const text = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "");
  if (!text) return "";
  const cleaned = text.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = cleaned.split("/", 2);
  if (!owner || !repo) return "";
  return `${owner}/${repo}`;
}

function parseIssueRefs(text) {
  const refs = new Set();
  const raw = String(text || "");
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*#(\d+)\b/gi;
  let match = re.exec(raw);
  while (match) {
    refs.add(String(match[1]));
    match = re.exec(raw);
  }
  return refs;
}

function parseIssueFromBranch(branchName) {
  const match = String(branchName || "").trim().match(/^ve\/(\d+)-/i);
  return match?.[1] || null;
}

function normalizeIssueLabels(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels
    .map((label) =>
      typeof label === "string" ? label : String(label?.name || "").trim(),
    )
    .map((label) => label.toLowerCase())
    .filter(Boolean);
}

function isIssueInReview(issue) {
  const labels = new Set(normalizeIssueLabels(issue));
  return labels.has("inreview") || labels.has("in-review");
}

function isTrackingIssue(issue, trackingLabels) {
  const title = String(issue?.title || "").toLowerCase();
  if (title.includes("meta issue") || title.includes("tracker")) {
    return true;
  }
  const labels = new Set(normalizeIssueLabels(issue));
  for (const label of trackingLabels) {
    if (labels.has(label)) return true;
  }
  return false;
}

async function defaultGh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
  const raw = String(stdout || "").trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

function buildIssueMappings(openPrs, mergedPrs) {
  const map = new Map();

  function ensure(issueNumber) {
    if (!map.has(issueNumber)) {
      map.set(issueNumber, {
        openPrs: [],
        mergedPrs: [],
      });
    }
    return map.get(issueNumber);
  }

  function refsForPr(pr) {
    const refs = new Set();
    for (const issue of parseIssueRefs(pr?.title)) refs.add(issue);
    for (const issue of parseIssueRefs(pr?.body)) refs.add(issue);
    const fromBranch = parseIssueFromBranch(pr?.headRefName);
    if (fromBranch) refs.add(fromBranch);
    return refs;
  }

  for (const pr of openPrs) {
    for (const issueNumber of refsForPr(pr)) {
      ensure(issueNumber).openPrs.push(pr);
    }
  }
  for (const pr of mergedPrs) {
    for (const issueNumber of refsForPr(pr)) {
      ensure(issueNumber).mergedPrs.push(pr);
    }
  }
  return map;
}

export class GitHubReconciler {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intervalMs = Math.max(
      30_000,
      parseNumber(options.intervalMs, DEFAULT_INTERVAL_MS),
    );
    this.mergedLookbackHours = Math.max(
      1,
      parseNumber(
        options.mergedLookbackHours,
        DEFAULT_MERGED_LOOKBACK_HOURS,
      ),
    );
    this.repoSlug =
      parseRepoSlug(options.repoSlug) ||
      parseRepoSlug(process.env.GITHUB_REPOSITORY) ||
      parseRepoSlug(
        process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
          ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
          : "",
      ) ||
      "unknown/unknown";
    this.trackingLabels = new Set(
      (Array.isArray(options.trackingLabels)
        ? options.trackingLabels
        : String(options.trackingLabels || "tracking").split(",")
      )
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    );
    this.addComment = options.addComment || addKanbanComment;
    this.updateTaskStatus = options.updateTaskStatus || updateTaskStatus;
    this.gh = options.gh || defaultGh;
    this.sendTelegram = options.sendTelegram || null;
    this.timer = null;
    this.running = false;
  }

  async _listOpenIssues() {
    return await this.gh([
      "issue",
      "list",
      "--repo",
      this.repoSlug,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,labels,url",
    ]);
  }

  async _listOpenPrs() {
    return await this.gh([
      "pr",
      "list",
      "--repo",
      this.repoSlug,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,headRefName,url",
    ]);
  }

  async _listMergedPrs() {
    const since = new Date(
      Date.now() - this.mergedLookbackHours * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    return await this.gh([
      "pr",
      "list",
      "--repo",
      this.repoSlug,
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--limit",
      "200",
      "--json",
      "number,title,body,headRefName,mergedAt,url",
    ]);
  }

  async reconcileOnce() {
    const backend = String(getKanbanBackendName() || "").toLowerCase();
    if (!this.enabled) {
      return { status: "skipped", reason: "disabled" };
    }
    if (backend !== "github") {
      return { status: "skipped", reason: `backend=${backend || "unknown"}` };
    }

    const summary = {
      status: "ok",
      checked: 0,
      closed: 0,
      inreview: 0,
      normalized: 0,
      skippedTracking: 0,
      projectMismatches: 0,
      errors: 0,
    };

    // Build a map of project board statuses for issues when in kanban mode
    /** @type {Map<string, string>} issueNumber → project board status */
    const projectStatusMap = new Map();
    const projectMode = String(process.env.GITHUB_PROJECT_MODE || "issues").trim().toLowerCase();
    if (projectMode === "kanban") {
      try {
        const adapter = getKanbanAdapter();
        if (typeof adapter.listTasksFromProject === "function") {
          const projectNumber =
            process.env.GITHUB_PROJECT_NUMBER ||
            process.env.GITHUB_PROJECT_ID ||
            null;
          if (projectNumber) {
            const projectTasks = await adapter.listTasksFromProject(projectNumber);
            for (const task of projectTasks) {
              if (task?.id && task?.status) {
                projectStatusMap.set(String(task.id), task.status);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`${TAG} failed to read project board for reconciliation: ${err?.message || err}`);
      }
    }

    const [issuesRaw, openPrsRaw, mergedPrsRaw] = await Promise.all([
      this._listOpenIssues(),
      this._listOpenPrs(),
      this._listMergedPrs(),
    ]);

    const issues = Array.isArray(issuesRaw) ? issuesRaw : [];
    const openPrs = Array.isArray(openPrsRaw) ? openPrsRaw : [];
    const mergedPrs = Array.isArray(mergedPrsRaw) ? mergedPrsRaw : [];
    const mappings = buildIssueMappings(openPrs, mergedPrs);

    for (const issue of issues) {
      const issueNumber = String(issue?.number || "").trim();
      if (!issueNumber) continue;
      summary.checked += 1;
      const mapped = mappings.get(issueNumber) || {
        openPrs: [],
        mergedPrs: [],
      };
      const hasOpenPr = mapped.openPrs.length > 0;
      const hasMergedPr = mapped.mergedPrs.length > 0;

      try {
        if (hasMergedPr) {
          if (isTrackingIssue(issue, this.trackingLabels)) {
            summary.skippedTracking += 1;
            continue;
          }
          await this.updateTaskStatus(issueNumber, "done");
          if (this.addComment) {
            const mergedUrls = mapped.mergedPrs
              .slice(0, 3)
              .map((pr) => pr?.url)
              .filter(Boolean);
            const suffix =
              mergedUrls.length > 0
                ? `\n\nMerged PR(s):\n${mergedUrls.map((url) => `- ${url}`).join("\n")}`
                : "";
            await this.addComment(
              issueNumber,
              `## ✅ Auto-Reconciled\nThis issue was auto-closed by openfleet after detecting merged PR linkage.${suffix}`,
            );
          }
          summary.closed += 1;
          continue;
        }

        if (hasOpenPr) {
          if (!isIssueInReview(issue)) {
            await this.updateTaskStatus(issueNumber, "inreview");
            summary.inreview += 1;
          }
          continue;
        }

        if (isIssueInReview(issue)) {
          await this.updateTaskStatus(issueNumber, "todo");
          summary.normalized += 1;
          continue;
        }

        // Project board mismatch detection (kanban mode only)
        if (projectStatusMap.size > 0) {
          const projectStatus = projectStatusMap.get(issueNumber);
          if (projectStatus) {
            const issueStatus = isIssueInReview(issue) ? "inreview" : "todo";
            if (projectStatus !== issueStatus && projectStatus !== "todo") {
              // Project board says a different status than issue labels — reconcile
              try {
                await this.updateTaskStatus(issueNumber, projectStatus);
                summary.projectMismatches += 1;
              } catch (syncErr) {
                console.warn(
                  `${TAG} failed to sync project status for #${issueNumber}: ${syncErr?.message || syncErr}`,
                );
              }
            }
          }
        }
      } catch (err) {
        summary.errors += 1;
        console.warn(
          `${TAG} failed reconciling issue #${issueNumber}: ${err?.message || err}`,
        );
      }
    }

    console.log(
      `${TAG} cycle complete: checked=${summary.checked} closed=${summary.closed} inreview=${summary.inreview} normalized=${summary.normalized} skippedTracking=${summary.skippedTracking} projectMismatches=${summary.projectMismatches} errors=${summary.errors}`,
    );
    return summary;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    console.log(
      `${TAG} started (repo=${this.repoSlug}, interval=${this.intervalMs}ms, lookback=${this.mergedLookbackHours}h)`,
    );
    void this.reconcileOnce().catch((err) => {
      console.warn(`${TAG} initial cycle failed: ${err?.message || err}`);
    });
    this.timer = setInterval(() => {
      void this.reconcileOnce().catch((err) => {
        console.warn(`${TAG} cycle failed: ${err?.message || err}`);
        if (this.sendTelegram) {
          void this.sendTelegram(
            `⚠️ GitHub reconciler cycle failed: ${err?.message || err}`,
          );
        }
      });
    }, this.intervalMs);
    if (this.timer?.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log(`${TAG} stopped`);
  }
}

let _singleton = null;

export function startGitHubReconciler(options = {}) {
  if (_singleton) {
    _singleton.stop();
  }
  _singleton = new GitHubReconciler(options);
  return _singleton.start();
}

export function stopGitHubReconciler() {
  if (_singleton) {
    _singleton.stop();
    _singleton = null;
  }
}

export async function runGitHubReconcilerOnce(options = {}) {
  const reconciler = new GitHubReconciler(options);
  return await reconciler.reconcileOnce();
}
