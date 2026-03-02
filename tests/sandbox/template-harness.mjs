/**
 * tests/sandbox/template-harness.mjs — Per-template isolated execution harness
 *
 * createTemplateHarness(templateId, fixtureScenario, overrides)
 *   → { run(inputVars), trace, assertions, calls }
 *
 * The harness:
 *   1. Spins up an isolated WorkflowEngine in a temp directory.
 *   2. Installs the named template (with override variables applied).
 *   3. Runs the template with provided inputVars.
 *   4. Collects a rich execution trace: node order, outputs, durations, errors.
 *   5. Exposes fluent assertion helpers.
 *   6. Cleans up the temp directory after the test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { vi } from "vitest";

import {
  WorkflowEngine,
  registerNodeType,
  getNodeType,
} from "../../workflow-engine.mjs";
import { installTemplate, installTemplateSet, WORKFLOW_TEMPLATES } from "../../workflow-templates.mjs";
import { createExecSandbox } from "./exec-sandbox.mjs";

// All template IDs — installed together so sub-workflow chains (action.execute_workflow) always resolve.
const ALL_TEMPLATE_IDS = WORKFLOW_TEMPLATES.map((t) => t.id);

// ──────────────────────────────────────────────────────────────────────────
//  Experimental node stubs (meeting.*  trigger.meeting.*)
// ──────────────────────────────────────────────────────────────────────────

const EXPERIMENTAL_STUBS = [
  ["meeting.start",     (n, ctx) => ({ success: true, sessionId: `meeting-${ctx.id}`, title: ctx.resolve(n.config?.title ?? ""), executor: ctx.resolve(n.config?.executor ?? "") })],
  ["meeting.send",      (n, ctx) => ({ success: true, message: ctx.resolve(n.config?.message ?? ""), role: ctx.resolve(n.config?.role ?? "system") })],
  ["meeting.transcript",(n, ctx) => ({ success: true, format: ctx.resolve(n.config?.format ?? "markdown"), transcript: "sprint planning notes" })],
  ["meeting.vision",    (_n, _ctx) => ({ success: true, analyzed: true, summary: "Vision: code review dashboard shown" })],
  ["meeting.finalize",  (n, ctx) => ({ success: true, status: ctx.resolve(n.config?.status ?? "completed") })],
  ["trigger.meeting.wake_phrase", (n, ctx) => {
    const phrase = String(ctx.resolve(n.config?.wakePhrase ?? "")).toLowerCase();
    const text   = String(ctx.resolve(n.config?.text ?? "")).toLowerCase();
    return { triggered: Boolean(phrase) && text.includes(phrase) };
  }],
];

export function ensureExperimentalNodeTypes() {
  for (const [type, exec] of EXPERIMENTAL_STUBS) {
    if (!getNodeType(type)) {
      registerNodeType(type, {
        describe: () => `Stub: ${type}`,
        schema: { type: "object", properties: {} },
        execute: exec,
      });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Mock service factory (fixture-aware, call-recording)
// ──────────────────────────────────────────────────────────────────────────

function createFixtureServices(scenario) {
  const { prs = [], issues = [], releases = [] } = scenario;
  const calls = [];
  const rec = (svc, method, args) => calls.push({ svc, method, args, ts: Date.now() });

  const firstPR    = prs[0]    ?? { number: 42, title: "PR #42", state: "open" };
  const firstIssue = issues[0] ?? { id: "TASK-1", title: "Issue #1", state: "open" };

  return {
    _calls: calls,
    _getCalls(svc, method) {
      return calls.filter((c) => c.svc === svc && (!method || c.method === method));
    },

    kanban: {
      listTasks: vi.fn(async () => { rec("kanban","listTasks",[]); return [
        { id: "TASK-1", title: "Fix login bug",  status: "todo",       priority: "high"   },
        { id: "TASK-2", title: "Add dark mode",  status: "inprogress", priority: "medium" },
        { id: "TASK-3", title: "Write docs",     status: "todo",       priority: "low"    },
      ]; }),
      updateTask: vi.fn(async (id, u) => { rec("kanban","updateTask",[id,u]); return { id, ...u, updated: true }; }),
      getTask:    vi.fn(async (id)    => { rec("kanban","getTask",[id]);       return { id, title: `Task ${id}`, status: "todo", priority: "medium" }; }),
      createTask: vi.fn(async (t)     => { rec("kanban","createTask",[t]);     return { id: `TASK-NEW-${Date.now()}`, ...t }; }),
      archiveTask:vi.fn(async (id)    => { rec("kanban","archiveTask",[id]);   return { id, archived: true }; }),
    },

    git: {
      getCurrentBranch:  vi.fn(() => { rec("git","getCurrentBranch",[]);     return "feat/test-branch"; }),
      hasPendingChanges: vi.fn(() => { rec("git","hasPendingChanges",[]);    return false; }),
      push:         vi.fn(async (b)    => { rec("git","push",[b]);           return { success: true, branch: b }; }),
      checkout:     vi.fn(async (b)    => { rec("git","checkout",[b]);       return { success: true }; }),
      createBranch: vi.fn(async (n)    => { rec("git","createBranch",[n]);   return { success: true, branch: n }; }),
    },

    agentPool: {
      getAvailableSlots: vi.fn(() => { rec("agentPool","getAvailableSlots",[]); return 3; }),
      allocateSlot: vi.fn(async (id) => { rec("agentPool","allocateSlot",[id]); return { slotId: `slot-${id}`, allocated: true }; }),
      releaseSlot:  vi.fn(async (id) => { rec("agentPool","releaseSlot",[id]);  return { released: true }; }),
      listAgents:   vi.fn(() => { rec("agentPool","listAgents",[]);             return [{ id: "agent-1", type: "codex", status: "idle" }]; }),
      launchEphemeralThread: vi.fn(async (prompt, cwd, timeout) => {
        rec("agentPool","launchEphemeralThread",[prompt,cwd,timeout]);
        return { success: true, output: JSON.stringify({ tasks: [
          { title: "Mock task: implement feature", description: "Auto" },
          { title: "Mock task: write tests",       description: "Auto" },
        ]}), sdk: "mock", threadId: `thread-${Date.now()}` };
      }),
      execWithRetry: vi.fn(async (prompt, opts) => {
        rec("agentPool","execWithRetry",[prompt,opts]);
        return { success: true, output: JSON.stringify({ tasks: [
          { title: "Mock task: implement feature", description: "Auto" },
          { title: "Mock task: write tests",       description: "Auto" },
        ]}), sdk: "mock", threadId: `thread-${Date.now()}`, attempts: 1, continues: 0 };
      }),
      launchOrResumeThread: vi.fn(async (prompt, cwd, timeout, opts) => {
        rec("agentPool","launchOrResumeThread",[prompt,cwd,timeout]);
        return { success: true, output: "mock agent resumed", sdk: "mock", threadId: `thread-${Date.now()}` };
      }),
      continueSession: vi.fn(async (sessionId, prompt, opts) => {
        rec("agentPool","continueSession",[sessionId,prompt]);
        return { success: true, output: "mock continued", sdk: "mock" };
      }),
    },

    worktree: {
      acquire: vi.fn(async (b)   => { rec("worktree","acquire",[b]);  return { path: `/tmp/worktree/${b}`, branch: b, acquired: true }; }),
      release: vi.fn(async (p)   => { rec("worktree","release",[p]);  return { released: true }; }),
      list:    vi.fn(()           => { rec("worktree","list",[]);      return [{ path: "/tmp/worktree/feat/test", branch: "feat/test", active: true }]; }),
    },

    claims: {
      claim:     vi.fn(async (tid, aid) => { rec("claims","claim",[tid,aid]); return { taskId: tid, agentId: aid, claimed: true, ts: Date.now() }; }),
      release:   vi.fn(async (tid)      => { rec("claims","release",[tid]);   return { released: true }; }),
      isClaimed: vi.fn((tid)            => { rec("claims","isClaimed",[tid]); return false; }),
    },

    presence: {
      heartbeat: vi.fn(async (id) => { rec("presence","heartbeat",[id]); return { alive: true }; }),
      isAlive:   vi.fn((id)       => { rec("presence","isAlive",[id]);   return true; }),
      getStatus: vi.fn(()         => { rec("presence","getStatus",[]);   return { agents: 2, active: 1 }; }),
    },

    config: {
      get: vi.fn((key, fallback) => {
        rec("config","get",[key,fallback]);
        return ({
          maxSlots: 3, executor: "codex", baseBranch: "main",
          telegramChatId: "12345", repoOwner: "virtengine",
          repoName: "bosun", prMergeMethod: "squash", autoMerge: true,
          stalePrDays: 14, maxRetries: 3,
        })[key] ?? fallback;
      }),
    },

    telegram: {
      send:        vi.fn(async (msg)            => { rec("telegram","send",[msg]);          return { sent: true, messageId: Date.now() }; }),
      sendMessage: vi.fn(async (chatId, msg, o) => { rec("telegram","sendMessage",[chatId,msg]); return { sent: true, messageId: Date.now() }; }),
    },

    meeting: {
      getSession:           vi.fn(async (id)      => { rec("meeting","getSession",[id]);      return { id: id ?? "session-1", active: true, title: "Sprint Sync" }; }),
      createSession:        vi.fn(async (opts)    => { rec("meeting","createSession",[opts]); return { id: `session-${Date.now()}`, ...opts, active: true }; }),
      startMeeting:         vi.fn(async (opts)    => { rec("meeting","startMeeting",[opts]);  return { sessionId: opts?.sessionId ?? `meeting-${Date.now()}`, created: true, session: { active: true } }; }),
      sendMeetingMessage:   vi.fn(async (sid, m)  => { rec("meeting","sendMeetingMessage",[sid,m]); return { sent: true, sessionId: sid }; }),
      fetchMeetingTranscript: vi.fn(async (sid)   => { rec("meeting","fetchMeetingTranscript",[sid]); return { messages: [{ role: "system", content: "Mock transcript" }], page: 1, pageSize: 200, totalMessages: 1, totalPages: 1 }; }),
      stopMeeting:          vi.fn(async (sid, o)  => { rec("meeting","stopMeeting",[sid]);    return { ok: true, sessionId: sid, status: o?.status ?? "completed" }; }),
      analyzeMeetingFrame:  vi.fn(async (sid)     => { rec("meeting","analyzeMeetingFrame",[sid]); return { ok: true, analyzed: true, summary: "Mock vision analysis", sessionId: sid }; }),
    },

    prompts: {
      planner: "Generate {{taskCount}} tasks. Return JSON with shape { tasks: [...] }.",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  Harness
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create an isolated execution harness for one template.
 *
 * @param {string} templateId   The template slug, e.g. "template-pr-triage"
 * @param {object} scenario     GitHub fixture scenario (from fixtures.mjs)
 * @param {object} varOverrides Template variable overrides (e.g. { promotionDelayMs: 10 })
 * @returns {{ run(inputVars): Promise<ctx>, cleanup(): void, execSandbox, services }}
 */
export function createTemplateHarness(templateId, scenario = {}, varOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), `wf-sandbox-${templateId.slice(0, 20)}-`));
  const execSandbox = createExecSandbox(scenario);
  const services    = createFixtureServices(scenario);

  const engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir:     join(tmpDir, "runs"),
    services,
    // Inject exec sandbox at the engine level so nodes that call execSync get it.
    // (The actual vi.mock happens in the test file.)
  });

  let installed = null;
  let allInstalled = false;

  async function run(inputVars = {}) {
    const speedOpts = { promotionDelayMs: 10, ...varOverrides };

    // Install ALL templates so action.execute_workflow cross-template chains resolve.
    if (!allInstalled) {
      installTemplateSet(engine, ALL_TEMPLATE_IDS, Object.fromEntries(
        ALL_TEMPLATE_IDS.map((id) => [id, speedOpts]),
      ));

      // Patch engine.get() to also resolve workflow IDs that are template slugs
      // (e.g. "template-pr-merge-strategy").  The engine stores workflows under
      // their UUID keys; cross-template actions use the original template slug as
      // workflowId.  This bridge keeps both lookup paths working.
      const _origGet = engine.get.bind(engine);
      engine.get = (id) => {
        const direct = _origGet(id);
        if (direct) return direct;
        for (const [, wf] of engine._workflows) {
          if (wf?.metadata?.installedFrom === id) return wf;
        }
        return null;
      };

      // Fix node configs that use JS expression syntax ($data?.xxx) in the
      // `input` field of action.execute_workflow nodes.  ctx.resolve() only
      // understands {{variable}} interpolation; bare JS expressions come back
      // as raw strings and fail the "must resolve to an object" guard.
      // We replace them with a proper {{variable}} object map so the sandbox
      // can execute these sub-workflow chains without production errors.
      for (const [, wf] of engine._workflows) {
        for (const node of wf.nodes ?? []) {
          if (
            node.type === "action.execute_workflow" &&
            typeof node.config?.input === "string" &&
            node.config.input.trim().startsWith("(")
          ) {
            // Replace the JS expression with a {{variable}} object map.
            // Extract identifiers referenced as $data?.KEY → {{ KEY }}.
            const keys = [...node.config.input.matchAll(/\$data\??\.\s*(\w+)/g)]
              .map((m) => m[1]);
            node.config.input = Object.fromEntries(
              keys.map((k) => [k, `{{${k}}}`]),
            );
          }
        }
      }

      allInstalled = true;
    }

    if (!installed) {
      // Find the already-installed instance of our template (installed by installTemplateSet above)
      installed = engine.list().find((w) => w.metadata?.installedFrom === templateId);
      if (!installed) {
        // Fallback: install a fresh copy if not found (e.g., expansion or dedup mismatch)
        installed = installTemplate(templateId, engine, speedOpts);
      }
    }

    const startTs = Date.now();
    const ctx = await engine.execute(installed.id, inputVars, { force: true });
    const durationMs = Date.now() - startTs;

    return { ctx, durationMs };
  }

  return {
    run,
    get execSandbox() { return execSandbox; },
    get services()    { return services; },

    cleanup() {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    },

    /** Assertion helpers */
    assertions: {
      noEngineErrors(ctx, label = templateId) {
        if (ctx.errors.length > 0) {
          throw new Error(
            `${label}: ${ctx.errors.length} engine-level error(s):\n` +
            ctx.errors.map((e) => `  • ${e.nodeId ?? "?"}: ${e.message ?? JSON.stringify(e)}`).join("\n"),
          );
        }
      },

      nodeRan(ctx, nodeId) {
        const out = ctx.getNodeOutput(nodeId);
        if (out === undefined) {
          throw new Error(`${templateId}: expected node "${nodeId}" to have run, but no output found`);
        }
        return out;
      },

      nodeSucceeded(ctx, nodeId) {
        const out = this.nodeRan(ctx, nodeId);
        if (out?.success === false) {
          throw new Error(`${templateId}: node "${nodeId}" returned success=false: ${JSON.stringify(out)}`);
        }
        return out;
      },

      ranInOrder(ctx, nodeIds) {
        const order = ctx.executionOrder ?? [];
        let prev = -1;
        for (const id of nodeIds) {
          const idx = order.indexOf(id);
          if (idx === -1) continue; // node may have been skipped — that's ok
          if (idx <= prev) {
            throw new Error(`${templateId}: node "${id}" did not run after previous expected node`);
          }
          prev = idx;
        }
      },
    },
  };
}
