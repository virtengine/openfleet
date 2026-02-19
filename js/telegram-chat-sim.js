/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Telegram Chat Simulator
   Realistic Telegram-style chat UI with real bot command responses.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Bot Info ─────────────────────────────────────────────────────────── */
  const BOT_NAME = 'Bosun Bot';
  const BOT_USERNAME = '@bosun_bot';
  const BOT_AVATAR = '🤖';

  /* ── Fake timestamps ─────────────────────────────────────────────────── */
  function timeStr() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  /* ── Command Responses (matching real telegram-bot.mjs COMMANDS) ──── */
  const BOT_COMMANDS = {
    '/start': {
      text: '🤖 <b>Bosun Primary Agent</b>\n\nI\'m your autonomous AI fleet supervisor with full repo + MCP access.\n\nUse /menu for the control center, /help for commands, or just type your request.\n\n<i>⚡ Ready to ship code autonomously.</i>',
      keyboard: [
        [{ text: '🎛 Open Control Center', cmd: '/menu' }, { text: '📊 Status', cmd: '/status' }],
      ],
    },

    '/menu': {
      text: '🎛️ <b>Bosun Control Center</b>\n\nChoose an action:',
      keyboard: [
        [{ text: '📊 Status', cmd: '/status' }, { text: '📋 Tasks', cmd: '/tasks' }, { text: '🤖 Agents', cmd: '/agents' }, { text: '📜 Logs', cmd: '/logs' }],
        [{ text: '💚 Health', cmd: '/health' }, { text: '⚡ Executor', cmd: '/executor' }, { text: '🧵 Threads', cmd: '/threads' }, { text: '🌿 Branches', cmd: '/branches' }],
        [{ text: '🔄 Retry', cmd: '/retry' }, { text: '🧹 Cleanup', cmd: '/cleanup' }, { text: '⏸ Pause', cmd: '/pausetasks' }, { text: '📋 Kanban', cmd: '/kanban' }],
        [{ text: '📱 Open MiniApp', cmd: '/app' }],
      ],
    },

    '/help': {
      text: '📚 <b>Available Commands</b>\n\n' +
        '<b>Core</b>\n' +
        '/status — Fleet overview\n' +
        '/tasks — List active tasks\n' +
        '/agents — Agent pool status\n' +
        '/logs — Recent log entries\n\n' +
        '<b>Actions</b>\n' +
        '/starttask <code>&lt;id&gt;</code> — Start a specific task\n' +
        '/restart <code>&lt;id&gt;</code> — Restart failed task\n' +
        '/retry — Retry last failed task\n' +
        '/plan <code>&lt;description&gt;</code> — Plan a new task\n\n' +
        '<b>Fleet</b>\n' +
        '/health — System health check\n' +
        '/branches — Active branches\n' +
        '/worktrees — Git worktree list\n' +
        '/executor — Executor pool info\n' +
        '/presence — Agent presence map\n\n' +
        '<b>Control</b>\n' +
        '/pausetasks — Pause all task processing\n' +
        '/resumetasks — Resume task processing\n' +
        '/maxparallel <code>&lt;n&gt;</code> — Set max parallel\n' +
        '/cleanup — Clean stale resources\n\n' +
        '<b>Infra</b>\n' +
        '/container — Container status\n' +
        '/shell <code>&lt;cmd&gt;</code> — Run shell command\n' +
        '/git <code>&lt;cmd&gt;</code> — Run git command\n',
    },

    '/status': {
      text: '📊 <b>Fleet Status</b> — <code>● RUNNING</code>\n\n' +
        '⏱ Uptime: <code>2h 34m 12s</code>\n' +
        '🔧 Mode: <code>internal</code>\n' +
        '📋 Board: <code>github</code> (bidirectional)\n' +
        '⚡ Max Parallel: <code>6</code>\n\n' +
        '<b>Today\'s Stats</b>\n' +
        '✅ Tasks completed: <b>13</b>\n' +
        '🔀 PRs merged: <b>11</b>\n' +
        '⏳ PRs pending: <b>2</b>\n' +
        '❌ Failures: <b>1</b> (auto-retried)\n\n' +
        '<b>Executors</b>\n' +
        '├─ <code>copilot-claude</code> 🟢 load: 67% tasks: 8\n' +
        '└─ <code>codex-default</code> 🟢 load: 42% tasks: 5',
    },

    '/tasks': {
      text: '📋 <b>Active Tasks</b>\n\n' +
        '🟢 <b>#42</b> feat(market): add order expiry\n' +
        '   └─ <code>copilot-claude</code> • PR #187 merged ✓\n\n' +
        '🟢 <b>#43</b> fix(veid): token validation\n' +
        '   └─ <code>codex-default</code> • PR #188 merged ✓\n\n' +
        '🔵 <b>#44</b> refactor(escrow): batch settle\n' +
        '   └─ <code>copilot-claude</code> • PR #189 in review\n\n' +
        '🔵 <b>#45</b> feat(hpc): GPU resource metering\n' +
        '   └─ <code>codex-default</code> • working...\n\n' +
        '⚪ <b>#46</b> docs: update provider guide\n' +
        '   └─ queued',
      keyboard: [
        [{ text: '▶ Start #46', cmd: '/starttask 46' }, { text: '🔄 Refresh', cmd: '/tasks' }],
      ],
    },

    '/agents': {
      text: '🤖 <b>Agent Pool</b>\n\n' +
        '<b>copilot-claude</b> — Claude Opus 4.6\n' +
        '├─ Status: 🟢 active\n' +
        '├─ Session: <code>sk-...7f3a</code>\n' +
        '├─ Weight: 50\n' +
        '└─ Uptime: 2h 34m\n\n' +
        '<b>codex-default</b> — Codex o4-mini\n' +
        '├─ Status: 🟢 active\n' +
        '├─ Session: <code>cx-...a91b</code>\n' +
        '├─ Weight: 50\n' +
        '└─ Uptime: 2h 34m',
    },

    '/logs': {
      text: '📜 <b>Recent Logs</b>\n\n' +
        '<code>14:32</code> [monitor] Polling for new tasks...\n' +
        '<code>14:32</code> [kanban] Found 2 new tasks\n' +
        '<code>14:32</code> [TASK] #47 → copilot-claude\n' +
        '<code>14:33</code> [worktree] Created ve/47-...\n' +
        '<code>14:35</code> [codex] Session started for #48\n' +
        '<code>14:41</code> [OK] PR #201 created\n' +
        '<code>14:44</code> [✓] PR #201 checks passed\n' +
        '<code>14:44</code> [MERGE] PR #201 merged ✓',
    },

    '/health': {
      text: '💚 <b>System Health</b> — All Clear\n\n' +
        '✅ GitHub API <code>142ms</code>\n' +
        '✅ Telegram Bot <code>89ms</code>\n' +
        '✅ Codex SDK <code>234ms</code>\n' +
        '✅ Copilot SDK <code>178ms</code>\n' +
        '✅ Shared State <code>12ms</code>\n' +
        '✅ Worktree Manager <code>45ms</code>',
    },

    '/metrics': {
      text: '📈 <b>Fleet Metrics</b> (24h)\n\n' +
        '<b>Tasks</b>\n' +
        '▓▓▓▓▓▓▓▓▓▓░░ 89% — 47 completed\n' +
        '▓░░░░░░░░░░░  6% — 3 failed\n' +
        '▓░░░░░░░░░░░  5% — 5 retried\n\n' +
        '<b>PRs</b>\n' +
        'Created: 52 | Merged: 44\n' +
        'CI failures: 8 (auto-fixed: 6)\n\n' +
        '<b>Executors</b>\n' +
        'copilot-claude: 99.8% uptime, avg 12m\n' +
        'codex-default: 98.2% uptime, avg 18m',
    },

    '/branches': {
      text: '🌿 <b>Active Branches</b>\n\n' +
        '├─ <code>ve/abc123-market-order-expiry</code> (merged)\n' +
        '├─ <code>ve/def456-veid-token-fix</code> (merged)\n' +
        '├─ <code>ve/ghi789-escrow-batch</code> 🔵 active\n' +
        '├─ <code>ve/jkl012-hpc-gpu-metering</code> 🔵 active\n' +
        '└─ <code>ve/vwx234-mfa-tests</code> 📝 in review',
    },

    '/worktrees': {
      text: '🌳 <b>Git Worktrees</b>\n\n' +
        '├─ /worktrees/abc123 (idle)\n' +
        '├─ /worktrees/ghi789 🟢 active\n' +
        '├─ /worktrees/jkl012 🟢 active\n' +
        '└─ /worktrees/vwx234 🟢 active\n\n' +
        'Total: 4 worktrees (3 active)',
    },

    '/executor': {
      text: '⚡ <b>Executor Pool</b>\n\n' +
        'Mode: <code>internal</code>\n' +
        'Max parallel: <code>6</code>\n\n' +
        '1. copilot-claude (50%) — COPILOT:CLAUDE_OPUS_4_6\n' +
        '2. codex-default (50%) — CODEX:DEFAULT',
    },

    '/presence': {
      text: '👥 <b>Agent Presence</b>\n\n' +
        '🟢 <b>workstation-1</b> (this machine)\n' +
        '   ├─ copilot-claude: busy (#44)\n' +
        '   └─ codex-default: busy (#45)\n\n' +
        'Fleet: 1 workstation, 2 agents online',
    },

    '/app': {
      text: '📱 Opening MiniApp...\n\n<i>In a real Telegram chat, this opens the full Bosun Mini App with Dashboard, Tasks, Agents, Infra, Logs, and more.</i>',
    },

    '/starttask': {
      text: '▶ <b>Starting task #46</b>...\n\n' +
        '📋 docs: update provider guide\n' +
        '🤖 Assigned to: <code>codex-default</code>\n' +
        '🌿 Branch: <code>ve/46-docs-provider-guide</code>\n\n' +
        '✅ Task dispatched successfully.',
    },

    '/restart': {
      text: '🔄 <b>Restarting task</b>...\n\nNo failed tasks to restart. All tasks healthy.',
    },

    '/retry': {
      text: '🔄 <b>Retrying last failed task</b>...\n\nNo recent failures found. Fleet is running clean.',
    },

    '/cleanup': {
      text: '🧹 <b>Cleanup Results</b>\n\n' +
        '✅ 0 stale orchestrators removed\n' +
        '✅ 0 stuck pushes cleared\n' +
        '✅ 1 worktree pruned\n' +
        '✅ 0 orphaned branches cleaned',
    },

    '/pausetasks': {
      text: '⏸ <b>Task processing paused.</b>\n\nNo new tasks will be dispatched. Active tasks continue running.\nUse /resumetasks to resume.',
    },

    '/resumetasks': {
      text: '▶ <b>Task processing resumed.</b>\n\nThe fleet will begin picking up new tasks from the backlog.',
    },

    '/container': {
      text: '📦 <b>Container Status</b>\n\n' +
        'Container Mode: <code>disabled</code>\n' +
        'Available Runtimes: Docker, Podman\n\n' +
        '<i>Enable container isolation in .env with</i>\n' +
        '<code>CONTAINER_MODE=docker</code>',
    },

    '/kanban': {
      text: '📊 <b>Kanban Board</b>\n\n' +
        '📝 Draft: 1\n' +
        '📋 Todo: 2\n' +
        '🔵 In Progress: 2\n' +
        '📝 In Review: 1\n' +
        '✅ Done: 2\n\n' +
        'Total: 8 tasks',
    },

    '/model': {
      text: '🧠 <b>Model Configuration</b>\n\n' +
        'Primary: <code>claude-opus-4-6</code> (Copilot)\n' +
        'Secondary: <code>o4-mini</code> (Codex)\n' +
        'Review: <code>codex</code>\n\n' +
        'Task routing: weighted random (50/50)',
    },

    '/sdk': {
      text: '🔧 <b>SDK Status</b>\n\n' +
        '✅ Copilot SDK: loaded\n' +
        '✅ Codex SDK: loaded\n' +
        '✅ GitHub CLI: authenticated\n' +
        '✅ Telegram API: connected',
    },

    '/whatsapp': {
      text: '📱 <b>WhatsApp Integration</b>\n\n' +
        'Status: <code>not configured</code>\n\n' +
        '<i>Run</i> <code>bosun --whatsapp-auth</code> <i>to set up WhatsApp notifications.</i>',
    },

    '/helpfull': {
      text: '📋 <b>All Commands</b>\n\n' +
        '/menu /help /helpfull /app /cancel\n' +
        '/ask /status /tasks /starttask /agents\n' +
        '/logs /agentlogs /branches /diff\n' +
        '/restart /retry /plan /cleanup /history\n' +
        '/clear /git /shell /background\n' +
        '/region /health /anomalies /model /sdk\n' +
        '/kanban /autobacklog /requirements\n' +
        '/threads /worktrees /executor\n' +
        '/shared_workspaces /claim /release /agent\n' +
        '/stop /steer /presence /coordinator\n' +
        '/pausetasks /resumetasks /repos\n' +
        '/maxparallel /whatsapp /container\n\n' +
        '<i>Any other text → sent to the primary agent.</i>',
    },

    '/ask': {
      text: '🤖 <b>Primary Agent</b>\n\n<i>Send me your prompt and I\'ll dispatch it to the primary agent with full repo + MCP access.</i>\n\nExample: /ask refactor the escrow module to support batch payments',
    },

    '/diff': {
      text: '📝 <b>Git Diff Summary</b> (staged)\n\n' +
        '<code>x/market/keeper/order.go</code>  +47 -12\n' +
        '<code>x/market/types/msgs.go</code>     +23 -0\n' +
        '<code>x/market/keeper/keeper.go</code>  +8  -2\n\n' +
        '3 files changed, 78 insertions(+), 14 deletions(-)',
    },

    '/plan': {
      text: '📐 <b>Task Planner</b>\n\nPlanning next 5 tasks from backlog...\n\n' +
        '1. feat(hpc): GPU resource metering\n' +
        '2. fix(provider): health check endpoint\n' +
        '3. docs: update provider guide\n' +
        '4. refactor(roles): simplify permission model\n' +
        '5. test(escrow): add settlement edge cases\n\n' +
        '✅ 5 tasks queued for dispatch.',
      keyboard: [
        [{ text: '▶ Dispatch All', cmd: '/resumetasks' }, { text: '📋 View Tasks', cmd: '/tasks' }],
      ],
    },

    '/history': {
      text: '📖 <b>Agent Session History</b>\n\n' +
        '├─ Session #14: feat(market) order expiry — 23 turns\n' +
        '├─ Session #15: fix(veid) token validation — 11 turns\n' +
        '├─ Session #16: refactor(escrow) batch settle — 31 turns\n' +
        '└─ Session #17: feat(hpc) GPU metering — <i>in progress</i>\n\n' +
        'Total: 4 sessions today, 65 turns',
    },

    '/clear': {
      text: '🔄 <b>Session context cleared.</b>\n\nThe primary agent\'s conversation history has been reset.\nNext task will start with a fresh context window.',
    },

    '/git': {
      text: '🔧 <b>Git — log --oneline -5</b>\n\n' +
        '<code>a3f8e91</code> feat(market): add order expiry (#187)\n' +
        '<code>7bc2d44</code> fix(veid): token validation (#188)\n' +
        '<code>1e9f077</code> refactor(escrow): batch settlement (#189)\n' +
        '<code>4da8b33</code> chore(deps): bump cosmos-sdk v0.53.2\n' +
        '<code>9cd0e51</code> ci: fix lint on portal workflow',
    },

    '/shell': {
      text: '💻 <b>Shell — ls logs/</b>\n\n' +
        '<code>daemon.log</code>  monitor.log  agent-42.log\n' +
        '<code>agent-43.log</code>  agent-44.log  telegram.log',
    },

    '/stop': {
      text: '🛑 <b>Stop Agent</b>\n\nNo active agents running right now.\nUse /steer to redirect a running agent, or /restart to reset the orchestrator.',
      keyboard: [
        [{ text: '🔄 Restart', cmd: '/restart' }, { text: '📊 Status', cmd: '/status' }],
      ],
    },

    '/steer': {
      text: '🧭 <b>Steer Agent</b>\n\nUse: /steer <directive>\n\nExample:\n<code>/steer focus on adding tests first</code>\n<code>/steer skip the CLI and focus on keeper only</code>\n\n<i>The directive will be injected into the active agent\'s context on the next turn.</i>',
    },

    '/anomalies': {
      text: '🔍 <b>Anomaly Detector</b> — <code>All Clear</code>\n\n' +
        '✅ No stuck agents\n' +
        '✅ No repeated lint failures\n' +
        '✅ No push loop detected\n' +
        '✅ No memory pressure\n\n' +
        'Streak: <code>14</code> clean checks in a row\n' +
        'Last anomaly: <i>none today</i>',
    },

    '/region': {
      text: '🌍 <b>Codex Region</b>\n\nCurrent: <code>auto</code>\n\nAvailable regions:\n├─ <code>us</code> — US East (latency: ~180ms)\n├─ <code>sweden</code> — EU North (latency: ~95ms)\n└─ <code>auto</code> ✅ — lowest latency selected dynamically\n\nChange with: /region us',
    },

    '/threads': {
      text: '🧵 <b>Active Agent Threads</b>\n\n' +
        '├─ Thread #1: <code>ve/44-escrow-batch</code> 🟢 working (31 turns)\n' +
        '├─ Thread #2: <code>ve/45-hpc-gpu</code> 🟢 working (8 turns)\n' +
        '└─ Thread #3: <code>primary-agent</code> 🟡 idle\n\n' +
        'Total: 3 threads (2 active)',
      keyboard: [
        [{ text: '🗑 Clear Idle', cmd: '/threads clear' }, { text: '🔄 Refresh', cmd: '/threads' }],
      ],
    },

    '/maxparallel': {
      text: '⚡ <b>Max Parallel Slots</b>\n\nCurrent: <code>6</code>\n\nRunning: <code>2</code> tasks\nQueued: <code>2</code> tasks\n\nChange with: /maxparallel 4',
    },

    '/repos': {
      text: '📁 <b>Repositories</b>\n\nActive: <code>virtengine/virtengine</code>\n\n├─ <code>virtengine/virtengine</code> ✅ primary\n└─ <code>virtengine/bosun</code> 📦 package\n\nSwitch with: /repos virtengine/bosun',
    },

    '/coordinator': {
      text: '🎯 <b>Coordinator</b>\n\nCurrent: <code>workstation-1</code> (this machine)\n\nAll task dispatch and agent management is handled by this instance.\n\n<i>Multiple coordinators require shared workspace setup.</i>',
    },

    '/autobacklog': {
      text: '📥 <b>Auto-Backlog</b> — Experimental\n\nStatus: <code>enabled</code>\nReplenishment threshold: <code>2</code> tasks remaining\nSource: <code>github issues + vibe-kanban</code>\n\nNext replenishment check: <code>4m 12s</code>',
    },

    '/requirements': {
      text: '📋 <b>Project Requirements</b>\n\nProfile: <code>blockchain-go</code>\n\n' +
        '✅ Go 1.22+\n' +
        '✅ Cosmos SDK v0.53.x\n' +
        '✅ Conventional Commits\n' +
        '✅ Pre-push hooks (lint + build + test)\n' +
        '✅ golangci-lint strict mode\n\n' +
        'Edit: bosun.config.json → requirements',
    },
  };

  /* ── Auto-demo sequence ──────────────────────────────────────────── */
  const DEMO_SEQUENCE = [
    { user: '/start', delay: 1200 },
    { wait: 2500 },
    { user: '/status', delay: 1500 },
    { wait: 3000 },
    { user: '/tasks', delay: 1500 },
    { wait: 3500 },
    { user: '/menu', delay: 1200 },
    { wait: 4000 },
    { user: '/health', delay: 1500 },
    { wait: 3000 },
    { user: '/agents', delay: 1500 },
    { wait: 3500 },
    { user: '/anomalies', delay: 1200 },
    { wait: 4000 },
    { user: '/branches', delay: 1500 },
    { wait: 3000 },
    { user: '/threads', delay: 1500 },
  ];

  /* ── Main initialization ─────────────────────────────────────────── */
  window.initTelegramChatDemo = function (containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    // Build the chat UI
    container.innerHTML = `
      <div class="tg-chat">
        <div class="tg-chat__header">
          <div class="tg-chat__avatar">${BOT_AVATAR}</div>
          <div class="tg-chat__header-info">
            <div class="tg-chat__header-name">${BOT_NAME}</div>
            <div class="tg-chat__header-status">online</div>
          </div>
          <div class="tg-chat__header-actions">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </div>
        </div>

        <div class="tg-chat__messages" id="tg-messages">
          <div class="tg-chat__date-badge">Today</div>
        </div>

        <div class="tg-chat__keyboard" id="tg-keyboard" style="display:none;"></div>

        <div class="tg-chat__input-bar">
          <button class="tg-chat__menu-btn" id="tg-menu-btn" title="Bot menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <input type="text" class="tg-chat__input" id="tg-input" placeholder="Message ${BOT_NAME}..." autocomplete="off" spellcheck="false" />
          <button class="tg-chat__send-btn" id="tg-send-btn" title="Send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    `;

    const messagesEl = container.querySelector('#tg-messages');
    const keyboardEl = container.querySelector('#tg-keyboard');
    const inputEl = container.querySelector('#tg-input');
    const sendBtn = container.querySelector('#tg-send-btn');
    const menuBtn = container.querySelector('#tg-menu-btn');

    let demoRunning = true;
    let typingTimeout = null;

    /* ── Message rendering ─────────────────────────────────────────── */
    function addMessage(type, html, keyboard) {
      // Remove typing indicator if present
      const typingEl = messagesEl.querySelector('.tg-chat__typing');
      if (typingEl) typingEl.remove();

      const msg = document.createElement('div');
      msg.className = 'tg-chat__msg tg-chat__msg--' + type;

      if (type === 'bot') {
        msg.innerHTML = `
          <div class="tg-chat__msg-avatar">${BOT_AVATAR}</div>
          <div class="tg-chat__msg-bubble">
            <div class="tg-chat__msg-name">${BOT_NAME}</div>
            <div class="tg-chat__msg-text">${html}</div>
            <div class="tg-chat__msg-time">${timeStr()}</div>
          </div>
        `;
      } else {
        msg.innerHTML = `
          <div class="tg-chat__msg-bubble">
            <div class="tg-chat__msg-text">${escapeHtml(html)}</div>
            <div class="tg-chat__msg-time">${timeStr()} ✓✓</div>
          </div>
        `;
      }

      messagesEl.appendChild(msg);

      // Handle inline keyboard
      if (keyboard && keyboard.length) {
        keyboardEl.innerHTML = '';
        keyboard.forEach(function (row) {
          const rowEl = document.createElement('div');
          rowEl.className = 'tg-chat__kb-row';
          row.forEach(function (btn) {
            const btnEl = document.createElement('button');
            btnEl.className = 'tg-chat__kb-btn';
            btnEl.textContent = btn.text;
            btnEl.addEventListener('click', function () {
              handleUserCommand(btn.cmd);
            });
            rowEl.appendChild(btnEl);
          });
          keyboardEl.appendChild(rowEl);
        });
        keyboardEl.style.display = '';
      } else {
        keyboardEl.style.display = 'none';
      }

      // Scroll to bottom
      requestAnimationFrame(function () {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    function showTyping() {
      // Remove any existing
      const existing = messagesEl.querySelector('.tg-chat__typing');
      if (existing) return;

      const el = document.createElement('div');
      el.className = 'tg-chat__typing';
      el.innerHTML = `
        <div class="tg-chat__msg-avatar">${BOT_AVATAR}</div>
        <div class="tg-chat__typing-dots">
          <span></span><span></span><span></span>
        </div>
      `;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    /* ── Command handler ───────────────────────────────────────────── */
    function handleUserCommand(text) {
      text = text.trim();
      if (!text) return;

      // Stop demo on user interaction
      if (demoRunning) {
        demoRunning = false;
      }

      // Show user message
      addMessage('user', text);

      // Find matching command
      const cmdKey = text.split(' ')[0].toLowerCase();
      const aliases = {
        '/log': '/logs',
        '/reconcile': '/cleanup',
        '/reset_thread': '/clear',
        '/pause': '/pausetasks',
        '/resume': '/resumetasks',
        '/instances': '/presence',
        '/context': '/steer',
        '/miniapp': '/app',
        '/webapp': '/app',
        '/cancel': '/clear',
      };
      const resolvedKey = aliases[cmdKey] || cmdKey;
      const response = BOT_COMMANDS[resolvedKey] || BOT_COMMANDS['/' + resolvedKey.replace(/^\//, '')];

      // Show typing then respond
      showTyping();
      const delay = 400 + Math.random() * 800;
      typingTimeout = setTimeout(function () {
        if (response) {
          addMessage('bot', response.text, response.keyboard);
        } else {
          addMessage('bot', '❓ Unknown command: <code>' + escapeHtml(text) + '</code>\n\nType /help to see available commands.', null);
        }
      }, delay);
    }

    /* ── Input handling ────────────────────────────────────────────── */
    function sendInput() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      handleUserCommand(text);
    }

    sendBtn.addEventListener('click', sendInput);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendInput();
      }
    });

    menuBtn.addEventListener('click', function () {
      if (demoRunning) demoRunning = false;
      handleUserCommand('/menu');
    });

    // Focus input on click anywhere in chat (but not on buttons/links)
    container.addEventListener('click', function (e) {
      if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && !e.target.closest('button')) {
        inputEl.focus();
      }
    });

    /* ── Bot welcome ───────────────────────────────────────────────── */
    setTimeout(function () {
      addMessage('bot', BOT_COMMANDS['/start'].text, null);
    }, 300);

    /* ── Auto-demo ─────────────────────────────────────────────────── */
    function runAutoDemo() {
      let idx = 0;
      function next() {
        if (!demoRunning || idx >= DEMO_SEQUENCE.length) {
          return;
        }
        const step = DEMO_SEQUENCE[idx++];
        if (step.wait) {
          setTimeout(next, step.wait);
        } else if (step.user) {
          // Simulate typing
          let charIdx = 0;
          const typeInterval = setInterval(function () {
            if (!demoRunning) { clearInterval(typeInterval); return; }
            charIdx++;
            inputEl.value = step.user.substring(0, charIdx);
            if (charIdx >= step.user.length) {
              clearInterval(typeInterval);
              setTimeout(function () {
                if (!demoRunning) return;
                inputEl.value = '';
                handleUserCommand(step.user);
                setTimeout(next, step.delay || 1500);
              }, 300);
            }
          }, 50);
        }
      }

      setTimeout(function () {
        if (demoRunning) next();
      }, 2000);
    }

    // Stop demo on any user interaction
    inputEl.addEventListener('focus', function () {
      if (demoRunning) demoRunning = false;
    });
    inputEl.addEventListener('keydown', function () {
      if (demoRunning) demoRunning = false;
    });

    runAutoDemo();
  };

})();
