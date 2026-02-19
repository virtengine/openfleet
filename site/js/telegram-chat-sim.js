/* ═══════════════════════════════════════════════════════════════════════════
   OpenFleet Telegram Chat Simulator
   Realistic Telegram-style chat UI with real bot command responses.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Bot Info ─────────────────────────────────────────────────────────── */
  const BOT_NAME = 'OpenFleet Bot';
  const BOT_USERNAME = '@openfleet_bot';
  const BOT_AVATAR = '⚡';

  /* ── Fake timestamps ─────────────────────────────────────────────────── */
  function timeStr() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  /* ── Command Responses (matching real telegram-bot.mjs COMMANDS) ──── */
  const BOT_COMMANDS = {
    '/start': {
      text: '👋 Welcome to <b>OpenFleet</b>!\n\nI\'m your autonomous AI fleet supervisor. Use /menu to see all controls, or /help for available commands.\n\n⚡ <i>Ready to ship code autonomously.</i>',
    },

    '/menu': {
      text: '🎛️ <b>OpenFleet Control Center</b>\n\nChoose an action:',
      keyboard: [
        [{ text: '📊 Status', cmd: '/status' }, { text: '📋 Tasks', cmd: '/tasks' }],
        [{ text: '🤖 Agents', cmd: '/agents' }, { text: '📜 Logs', cmd: '/logs' }],
        [{ text: '💚 Health', cmd: '/health' }, { text: '📈 Metrics', cmd: '/metrics' }],
        [{ text: '🌿 Branches', cmd: '/branches' }, { text: '🔄 Retry Last', cmd: '/retry' }],
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
      text: '📱 Opening MiniApp...\n\n<i>In a real Telegram chat, this opens the full OpenFleet Mini App with Dashboard, Tasks, Agents, Infra, Logs, and more.</i>',
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
        '<i>Run</i> <code>openfleet --whatsapp-auth</code> <i>to set up WhatsApp notifications.</i>',
    },
  };

  /* ── Auto-demo sequence ──────────────────────────────────────────── */
  const DEMO_SEQUENCE = [
    { user: '/status', delay: 1500 },
    { wait: 2500 },
    { user: '/tasks', delay: 1500 },
    { wait: 3000 },
    { user: '/menu', delay: 1200 },
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
      const response = BOT_COMMANDS[cmdKey] || BOT_COMMANDS['/' + cmdKey.replace(/^\//, '')];

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
