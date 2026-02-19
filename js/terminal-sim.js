/* ═══════════════════════════════════════════════════════════════════════════
   OpenFleet Terminal Simulator
   Uses jQuery Terminal for a rich interactive + auto-demo terminal.
   Realistic logging structure matching actual openfleet output.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Color helpers ───────────────────────────────────────────────────── */
  const C = {
    cyan: (t) => `[[;#60cc5d;]${t}]`,
    green: (t) => `[[;#10b981;]${t}]`,
    amber: (t) => `[[;#f59e0b;]${t}]`,
    red: (t) => `[[;#ef4444;]${t}]`,
    purple: (t) => `[[;#a78bfa;]${t}]`,
    pink: (t) => `[[;#ec4899;]${t}]`,
    dim: (t) => `[[;#64748b;]${t}]`,
    bold: (t) => `[[b;#f1f5f9;]${t}]`,
    white: (t) => `[[;#e2e8f0;]${t}]`,
    blue: (t) => `[[;#3b82f6;]${t}]`,
  };

  /* ── Realistic boot sequence matching actual openfleet logs ──────────── */
  const DEMO_SEQUENCE = [
    { cmd: 'openfleet --echo-logs', delay: 600 },
    { log: '', delay: 80 },
    { log: `  ${C.dim('╭──────────────────────────────────────────────────────────╮')}`, delay: 40 },
    { log: `  ${C.dim('│')} ${C.cyan('>_')} ${C.bold('openfleet')} ${C.dim('(v0.26.2)')}                                 ${C.dim('│')}`, delay: 40 },
    { log: `  ${C.dim('╰──────────────────────────────────────────────────────────╯')}`, delay: 120 },
    { log: `${C.dim('[telegram-bot]')} agent timeout set to 90 min`, delay: 90 },
    { log: `${C.dim('[kanban]')} switched to ${C.cyan('internal')} backend`, delay: 70 },
    { log: `${C.dim('[maintenance]')} removing stale PID file (PID 272221 no longer alive)`, delay: 80 },
    { log: `${C.dim('[dependabot]')} auto-merge enabled — checking every 10 min for: ${C.dim('dependabot[bot], app/dependabot')}`, delay: 70 },
    { log: `${C.dim('[auto-update]')} Monitoring parent process PID 277248`, delay: 60 },
    { log: `${C.dim('[monitor]')} self-restart watcher disabled ${C.dim('(default outside devmode)')}`, delay: 60 },
    { log: `${C.dim('[task-executor]')} initialized ${C.dim('(mode=internal, maxParallel=3, sdk=auto)')}`, delay: 80 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"prepush-go-vet"')} for event "PrePush" ${C.dim('(blocking)')}`, delay: 50 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"prepush-go-build"')} for event "PrePush" ${C.dim('(blocking)')}`, delay: 50 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"precommit-gofmt"')} for event "PreCommit"`, delay: 50 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"task-complete-audit"')} for event "TaskComplete"`, delay: 50 },
    { log: `${C.dim('[agent-hooks]')} loaded 6 hook(s) from .codex/hooks.json`, delay: 60 },
    { log: `${C.dim('[task-executor]')} stream-based watchdog started — analyzing agent health every 60s`, delay: 70 },
    { log: `${C.dim('[agent-pool]')} SDK selected: ${C.cyan('codex')} ${C.dim('(via fallback chain)')}`, delay: 70 },
    { log: `${C.dim('[review-agent]')} initialized ${C.dim('(sdk=codex, maxConcurrent=2, timeout=300000ms)')}`, delay: 60 },
    { log: `${C.dim('[review-agent]')} started`, delay: 40 },
    { log: `${C.dim('[codex-shell]')} SDK loaded successfully`, delay: 80 },
    { log: `${C.dim('[codex-shell]')} initialised with Codex SDK ${C.dim('(sub-agent features enabled)')}`, delay: 80 },
    { log: `${C.dim('[agent-endpoint]')} Listening on ${C.cyan('127.0.0.1:18432')}`, delay: 70 },
    { log: `${C.dim('[pr-cleanup-daemon]')} Starting with interval 1800000ms`, delay: 60 },
    { log: `${C.dim('[worktree-manager]')} git worktree prune completed`, delay: 80 },
    { log: `${C.dim('[maintenance]')} sweep complete: ${C.green('0')} stale orchestrators, ${C.green('0')} stuck pushes, ${C.green('1')} worktrees pruned`, delay: 100 },
    { log: '', delay: 200 },
    // Task routing phase
    { log: `${C.dim('[TASK]')}  ${C.bold('#42')} feat(market): add order expiry → ${C.cyan('copilot-claude')}`, delay: 600 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#43')} fix(veid): token validation  → ${C.cyan('codex-default')}`, delay: 500 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#44')} refactor(escrow): batch settle → ${C.cyan('copilot-claude')}`, delay: 400 },
    { log: '', delay: 300 },
    // PR lifecycle
    { log: `${C.dim('[ OK ]')}  ${C.bold('#43')} PR #188 created — CI running...`, delay: 800 },
    { log: `${C.dim('[ OK ]')}  ${C.bold('#42')} PR #187 created — CI running...`, delay: 600 },
    { log: `${C.dim('[  ✓ ]')}  ${C.bold('#43')} PR #188 — ${C.green('all checks passed')}`, delay: 1000 },
    { log: `${C.dim('[MERGE]')} ${C.bold('#43')} PR #188 merged to main ${C.green('✓')}`, delay: 400 },
    { log: `${C.dim('[  ✓ ]')}  ${C.bold('#42')} PR #187 — ${C.green('all checks passed')}`, delay: 800 },
    { log: `${C.dim('[MERGE]')} ${C.bold('#42')} PR #187 merged to main ${C.green('✓')}`, delay: 400 },
    { log: `${C.dim('[ OK ]')}  ${C.bold('#44')} PR #189 created — CI running...`, delay: 500 },
    { log: '', delay: 200 },
    { log: `${C.dim('[INFO]')}  Fleet status: ${C.green('3 completed')}, ${C.amber('0 failed')}, ${C.dim('0 retried')}`, delay: 100 },
    { log: `${C.dim('[INFO]')}  Next poll in 60s...`, delay: 100 },
  ];

  /* ── Command responses ──────────────────────────────────────────────── */
  const COMMANDS = {
    help: () => [
      '',
      `  ${C.bold('OpenFleet')} ${C.dim('v0.26.2')} — Available Commands`,
      '',
      `  ${C.cyan('openfleet')}              Start the supervisor`,
      `  ${C.cyan('openfleet --setup')}      Run interactive setup wizard`,
      `  ${C.cyan('openfleet --doctor')}     Validate configuration`,
      `  ${C.cyan('openfleet --help')}       Show full CLI help`,
      `  ${C.cyan('openfleet --status')}     Show fleet status`,
      `  ${C.cyan('openfleet --tasks')}      List current tasks`,
      `  ${C.cyan('openfleet --agents')}     Show agent pool`,
      `  ${C.cyan('openfleet --daemon')}     Run as background daemon`,
      `  ${C.cyan('openfleet --shell')}      Interactive shell mode`,
      `  ${C.cyan('openfleet --metrics')}    Show fleet metrics (24h)`,
      `  ${C.cyan('openfleet --logs')}       Tail recent logs`,
      `  ${C.cyan('openfleet --version')}    Show version`,
      '',
      `  ${C.dim('Type any command to try it out.')}`,
      '',
    ],

    'openfleet --help': () => [
      '',
      `  ${C.bold('openfleet')} ${C.dim('v0.26.2')}`,
      `  ${C.dim('AI-powered orchestrator supervisor with executor failover, smart PR flow, and Telegram notifications.')}`,
      '',
      `  ${C.bold('USAGE')}`,
      `    openfleet [options]`,
      '',
      `  ${C.bold('COMMANDS')}`,
      `    ${C.cyan('--setup')}                     Run the interactive setup wizard`,
      `    ${C.cyan('--doctor')}                    Validate openfleet .env/config setup`,
      `    ${C.cyan('--help')}                      Show this help`,
      `    ${C.cyan('--version')}                   Show version`,
      `    ${C.cyan('--update')}                    Check for and install latest version`,
      `    ${C.cyan('--no-update-check')}           Skip automatic update check on startup`,
      `    ${C.cyan('--no-auto-update')}            Disable background auto-update polling`,
      `    ${C.cyan('--daemon')}, ${C.cyan('-d')}                Run as a background daemon (detached, with PID file)`,
      `    ${C.cyan('--stop-daemon')}               Stop a running daemon process`,
      `    ${C.cyan('--daemon-status')}             Check if daemon is running`,
      '',
      `  ${C.bold('ORCHESTRATOR')}`,
      `    ${C.cyan('--script')} <path>             Path to the orchestrator script`,
      `    ${C.cyan('--args')} "<args>"             Arguments passed to the script ${C.dim('(default: "-MaxParallel 6")')}`,
      `    ${C.cyan('--restart-delay')} <ms>        Delay before restart ${C.dim('(default: 10000)')}`,
      `    ${C.cyan('--max-restarts')} <n>          Max restarts, 0 = unlimited ${C.dim('(default: 0)')}`,
      '',
      `  ${C.bold('LOGGING')}`,
      `    ${C.cyan('--log-dir')} <path>            Log directory ${C.dim('(default: ./logs)')}`,
      `    ${C.cyan('--echo-logs')}                 Echo raw orchestrator output to console`,
      `    ${C.cyan('--quiet')}, ${C.cyan('-q')}                 Only show warnings and errors`,
      `    ${C.cyan('--verbose')}, ${C.cyan('-V')}               Show debug-level messages`,
      `    ${C.cyan('--trace')}                     Show all messages including trace-level`,
      `    ${C.cyan('--log-level')} <level>         ${C.dim('trace|debug|info|warn|error|silent')}`,
      '',
      `  ${C.bold('AI / AGENT')}`,
      `    ${C.cyan('--no-codex')}                  Disable Codex SDK analysis`,
      `    ${C.cyan('--no-autofix')}                Disable automatic error fixing`,
      `    ${C.cyan('--primary-agent')} <name>      Override primary: ${C.dim('codex, copilot, claude')}`,
      `    ${C.cyan('--shell')}, ${C.cyan('--interactive')}      Enable interactive shell mode`,
      '',
      `  ${C.bold('TELEGRAM')}`,
      `    ${C.cyan('--no-telegram-bot')}           Disable the interactive Telegram bot`,
      `    ${C.cyan('--telegram-commands')}         Enable monitor-side Telegram polling`,
      '',
      `  ${C.bold('WHATSAPP')}`,
      `    ${C.cyan('--whatsapp-auth')}             Run WhatsApp authentication (QR code)`,
      `    ${C.cyan('--whatsapp-auth --pairing-code')}  Authenticate via pairing code`,
      '',
      `  ${C.bold('VIBE-KANBAN')}`,
      `    ${C.cyan('--no-vk-spawn')}               Don't auto-spawn Vibe-Kanban`,
      `    ${C.cyan('--vk-ensure-interval')} <ms>   VK health check interval ${C.dim('(default: 60000)')}`,
      '',
      `  ${C.bold('SENTINEL')}`,
      `    ${C.cyan('--sentinel')}                  Start Telegram sentinel in companion mode`,
      `    ${C.cyan('--sentinel-stop')}             Stop a running sentinel`,
      `    ${C.cyan('--sentinel-status')}           Check sentinel status`,
      '',
      `  ${C.bold('STARTUP SERVICE')}`,
      `    ${C.cyan('--enable-startup')}            Register auto-start on login`,
      `    ${C.cyan('--disable-startup')}           Remove from startup services`,
      `    ${C.cyan('--startup-status')}            Check if startup service is installed`,
      '',
    ],
    '--help': () => COMMANDS['openfleet --help'](),

    'openfleet --setup': () => [
      '',
      `  ${C.bold('OpenFleet Setup Wizard')}`,
      '',
      `  ${C.cyan('?')} Setup mode: ${C.bold('Recommended')} ${C.dim('(press Enter for default)')}`,
      `    ${C.green('❯')} ${C.bold('Recommended')} ${C.dim('— Prompts only for important decisions')}`,
      `      Advanced     ${C.dim('— Full control over every setting')}`,
      '',
      `  ${C.cyan('?')} Project name: ${C.bold('virtengine')} ${C.dim('(auto-detected from package.json)')}`,
      `  ${C.cyan('?')} GitHub repo: ${C.bold('virtengine/virtengine')} ${C.dim('(auto-detected from git remote)')}`,
      '',
      `  ${C.cyan('?')} Executor preset:`,
      `    ${C.green('❯')} ${C.bold('Balanced')} ${C.dim('— Copilot (Claude Opus 4.6) 50% + Codex 50%')}`,
      `      Codex Only  ${C.dim('— 100% Codex with o4-mini')}`,
      `      Custom      ${C.dim('— Define your own executor weights')}`,
      '',
      `  ${C.cyan('?')} Telegram bot token: ${C.dim('(paste from @BotFather)')}`,
      `    ${C.bold('7891234567:AAG...')} ${C.green('✓')} ${C.dim('valid')}`,
      '',
      `  ${C.cyan('?')} Telegram chat ID: ${C.bold('1234567890')}`,
      '',
      `  ${C.cyan('?')} Kanban backend: ${C.bold('Internal')} ${C.dim('(recommended primary)')}`,
      '',
      `  ${C.green('✓')} .env written with inline documentation`,
      `  ${C.green('✓')} openfleet.config.json generated`,
      `  ${C.green('✓')} VS Code Copilot settings configured`,
      `  ${C.green('✓')} .codex/hooks.json scaffolded`,
      '',
      `  ${C.bold('Setup complete!')} Run ${C.cyan('openfleet')} to start.`,
      '',
    ],
    '--setup': () => COMMANDS['openfleet --setup'](),

    'openfleet --version': () => [
      `@virtengine/openfleet v0.26.2`,
    ],
    '--version': () => COMMANDS['openfleet --version'](),
    version: () => COMMANDS['openfleet --version'](),

    'openfleet --status': () => [
      '',
      `  ${C.bold('Fleet Status')}  ${C.green('● RUNNING')}`,
      '',
      `  ${C.dim('Uptime:')}        2h 34m 12s`,
      `  ${C.dim('Executor Mode:')} internal`,
      `  ${C.dim('Board:')}         github (bidirectional sync)`,
      `  ${C.dim('Max Parallel:')}  6`,
      '',
      `  ${C.bold('Executors')}`,
      `  ${C.dim('  ├─')} ${C.cyan('copilot-claude')}  ${C.green('active')}  ${C.dim('load: 67%  tasks: 8  avg: 12m')}`,
      `  ${C.dim('  └─')} ${C.cyan('codex-default')}   ${C.green('active')}  ${C.dim('load: 42%  tasks: 5  avg: 18m')}`,
      '',
      `  ${C.bold('Today')}`,
      `  ${C.dim('  Tasks completed:')} ${C.green('13')}`,
      `  ${C.dim('  PRs merged:')}      ${C.green('11')}`,
      `  ${C.dim('  PRs pending:')}     ${C.amber('2')}`,
      `  ${C.dim('  Failures:')}        ${C.red('1')} ${C.dim('(auto-retried)')}`,
      '',
    ],
    '--status': () => COMMANDS['openfleet --status'](),
    status: () => COMMANDS['openfleet --status'](),

    'openfleet --tasks': () => [
      '',
      `  ${C.bold('Active Tasks')}`,
      '',
      `  ${C.dim('#')}   ${C.dim('STATUS')}     ${C.dim('TITLE')}                            ${C.dim('AGENT')}`,
      `  ${C.bold('42')}  ${C.green('merged')}     feat(market): add order expiry       copilot-claude`,
      `  ${C.bold('43')}  ${C.green('merged')}     fix(veid): token validation          codex-default`,
      `  ${C.bold('44')}  ${C.amber('in-review')}  refactor(escrow): batch settle       copilot-claude`,
      `  ${C.bold('45')}  ${C.cyan('working')}    feat(hpc): gpu resource metering     codex-default`,
      `  ${C.bold('46')}  ${C.dim('queued')}     docs: update provider guide           —`,
      '',
    ],
    '--tasks': () => COMMANDS['openfleet --tasks'](),
    tasks: () => COMMANDS['openfleet --tasks'](),

    'openfleet --agents': () => [
      '',
      `  ${C.bold('Agent Pool')}`,
      '',
      `  ${C.cyan('copilot-claude')}  ${C.dim('|')} Claude Opus 4.6 via Copilot ${C.dim('|')} weight: 50 ${C.dim('|')} role: primary`,
      `  ${C.dim('  ├─ Status:')}  ${C.green('active')}`,
      `  ${C.dim('  ├─ Session:')} sk-...7f3a`,
      `  ${C.dim('  └─ Uptime:')}  2h 34m`,
      '',
      `  ${C.cyan('codex-default')}   ${C.dim('|')} Codex o4-mini            ${C.dim('|')} weight: 50 ${C.dim('|')} role: backup`,
      `  ${C.dim('  ├─ Status:')}  ${C.green('active')}`,
      `  ${C.dim('  ├─ Session:')} cx-...a91b`,
      `  ${C.dim('  └─ Uptime:')}  2h 34m`,
      '',
    ],
    '--agents': () => COMMANDS['openfleet --agents'](),
    agents: () => COMMANDS['openfleet --agents'](),

    'openfleet --doctor': () => [
      '',
      `  ${C.bold('Config Doctor')} ${C.dim('— checking your setup...')}`,
      '',
      `  ${C.green('✓')} .env file found`,
      `  ${C.green('✓')} openfleet.config.json valid`,
      `  ${C.green('✓')} GitHub CLI authenticated`,
      `  ${C.green('✓')} Telegram bot token valid`,
      `  ${C.green('✓')} Executor pool configured (2 executors)`,
      `  ${C.green('✓')} Kanban backend reachable (github)`,
      `  ${C.green('✓')} Shared state persistence writable`,
      '',
      `  ${C.green('All checks passed.')} Your setup is ready.`,
      '',
    ],
    '--doctor': () => COMMANDS['openfleet --doctor'](),
    doctor: () => COMMANDS['openfleet --doctor'](),

    'openfleet --daemon': () => [
      `${C.dim('[daemon]')} Starting openfleet in background...`,
      `${C.dim('[daemon]')} PID file: .cache/openfleet.pid`,
      `${C.dim('[daemon]')} Log file: logs/daemon.log`,
      `${C.green('✓')} Daemon started (PID: 28451)`,
    ],
    '--daemon': () => COMMANDS['openfleet --daemon'](),

    'openfleet --daemon-status': () => [
      `${C.green('●')} openfleet daemon is running (PID: 28451, uptime: 2h 34m)`,
    ],
    '--daemon-status': () => COMMANDS['openfleet --daemon-status'](),

    'openfleet --sentinel': () => [
      `${C.dim('[sentinel]')} Starting Telegram sentinel in companion mode...`,
      `${C.dim('[sentinel]')} Watchdog enabled — auto-restart on crash loop`,
      `${C.dim('[sentinel]')} Listening for Telegram commands`,
      `${C.green('✓')} Sentinel started`,
    ],
    '--sentinel': () => COMMANDS['openfleet --sentinel'](),

    'openfleet --update': () => [
      `${C.dim('[update]')} Checking for updates...`,
      `${C.dim('[update]')} Current: v0.26.2`,
      `${C.dim('[update]')} Latest:  v0.26.2`,
      `${C.green('✓')} Already on the latest version.`,
    ],
    '--update': () => COMMANDS['openfleet --update'](),

    clear: () => '__CLEAR__',

    ls: () => [
      `${C.cyan('cli.mjs')}  ${C.cyan('monitor.mjs')}  ${C.cyan('config.mjs')}  ${C.cyan('setup.mjs')}  ${C.cyan('ve-orchestrator.mjs')}  ${C.dim('.env')}  ${C.dim('package.json')}`,
    ],
    pwd: () => [`/home/user/virtengine/scripts/openfleet`],
    whoami: () => [`openfleet-agent`],

    'cat .env': () => [
      `${C.dim('# ─── OpenFleet Environment Configuration ───')}`,
      `${C.dim('PROJECT_NAME=')}${C.green('virtengine')}`,
      `${C.dim('KANBAN_BACKEND=')}${C.green('internal')}`,
      `${C.dim('EXECUTOR_MODE=')}${C.green('internal')}`,
      `${C.dim('EXECUTORS=')}${C.green('COPILOT:CLAUDE_OPUS_4_6:50,CODEX:DEFAULT:50')}`,
      `${C.dim('MAX_PARALLEL=')}${C.green('6')}`,
      `${C.dim('TELEGRAM_BOT_TOKEN=')}${C.green('7891234567:AAG...')}`,
      `${C.dim('TELEGRAM_CHAT_ID=')}${C.green('1234567890')}`,
      `${C.dim('SHARED_STATE_ENABLED=')}${C.green('true')}`,
      `${C.dim('...')}`,
    ],

    'openfleet --metrics': () => [
      '',
      `  ${C.bold('Fleet Metrics')} ${C.dim('(last 24h)')}`,
      '',
      `  ${C.dim('Tasks')}`,
      `    Completed    ${C.green('47')}  ${C.dim('████████████████████░░  89%')}`,
      `    Failed       ${C.red('3')}   ${C.dim('██░░░░░░░░░░░░░░░░░░░░   6%')}`,
      `    Retried      ${C.amber('5')}   ${C.dim('█░░░░░░░░░░░░░░░░░░░░░   5%')}`,
      '',
      `  ${C.dim('PRs')}`,
      `    Created      ${C.cyan('52')}`,
      `    Merged       ${C.green('44')}  ${C.dim('avg merge time: 14m')}`,
      `    CI failures  ${C.amber('8')}   ${C.dim('auto-fixed: 6')}`,
      '',
      `  ${C.dim('Executors')}`,
      `    copilot-claude  ${C.dim('uptime:')} ${C.green('99.8%')}  ${C.dim('avg task:')} 12m`,
      `    codex-default   ${C.dim('uptime:')} ${C.green('98.2%')}  ${C.dim('avg task:')} 18m`,
      '',
    ],
    '--metrics': () => COMMANDS['openfleet --metrics'](),
    metrics: () => COMMANDS['openfleet --metrics'](),

    'openfleet --logs': () => [
      `${C.dim('[14:32:01]')} ${C.dim('[monitor]')} polling github for new tasks...`,
      `${C.dim('[14:32:03]')} ${C.dim('[kanban]')} found 2 new tasks in backlog`,
      `${C.dim('[14:32:04]')} ${C.dim('[TASK]')}  ${C.bold('#47')} feat(provider): add health check → ${C.cyan('copilot-claude')}`,
      `${C.dim('[14:32:04]')} ${C.dim('[TASK]')}  ${C.bold('#48')} fix(escrow): decimal rounding    → ${C.cyan('codex-default')}`,
      `${C.dim('[14:33:12]')} ${C.dim('[worktree]')} created ve/47-provider-health-check`,
      `${C.dim('[14:33:14]')} ${C.dim('[copilot]')} session started for #47`,
      `${C.dim('[14:35:22]')} ${C.dim('[codex]')} session started for #48`,
      `${C.dim('[14:41:18]')} ${C.dim('[ OK ]')}  ${C.bold('#48')} PR #201 created — CI running...`,
      `${C.dim('[14:44:02]')} ${C.dim('[  ✓ ]')}  ${C.bold('#48')} PR #201 — ${C.green('all checks passed')}`,
      `${C.dim('[14:44:05]')} ${C.dim('[MERGE]')} ${C.bold('#48')} PR #201 merged to main ${C.green('✓')}`,
    ],
    '--logs': () => COMMANDS['openfleet --logs'](),
    logs: () => COMMANDS['openfleet --logs'](),

    neofetch: () => [
      '',
      `  ${C.cyan('   ___  _____ ')}   ${C.bold('openfleet')}@virtengine`,
      `  ${C.cyan('  / _ \\|  ___|')}   ${C.dim('─────────────────────')}`,
      `  ${C.cyan(' | | | | |_   ')}   ${C.dim('OS:')}      Linux x86_64`,
      `  ${C.cyan(' | |_| |  _|  ')}   ${C.dim('Runtime:')} Node.js 22.0`,
      `  ${C.cyan('  \\___/|_|    ')}   ${C.dim('Agents:')}  2 active`,
      `  ${C.cyan('              ')}   ${C.dim('Uptime:')}  2h 34m`,
      `  ${C.cyan('  openfleet   ')}   ${C.dim('Tasks:')}   13 completed`,
      '',
    ],
  };

  /* ── Initialize terminal ─────────────────────────────────────────────── */
  window.initOpenFleetTerminal = function (selector, options = {}) {
    const { autoDemo = true, greeting = true } = options;

    const term = $(selector).terminal(
      function (command) {
        command = command.trim();
        if (!command) return;

        // Check for exact match first
        let handler = COMMANDS[command] || COMMANDS[command.toLowerCase()];

        // Try normalized matching: "openfleet --flag" ↔ "--flag"
        if (!handler) {
          const lower = command.toLowerCase().trim();
          // If user typed "openfleet --something", try as-is and stripped
          const stripped = lower.replace(/^openfleet\s+/, '');
          handler =
            COMMANDS[lower] ||
            COMMANDS[stripped] ||
            COMMANDS['openfleet ' + stripped];
        }

        // Case-insensitive fallback
        if (!handler) {
          const key = Object.keys(COMMANDS).find(
            (k) => command.toLowerCase().trim() === k.toLowerCase()
          );
          if (key) handler = COMMANDS[key];
        }

        if (handler) {
          const result = handler();
          if (result === '__CLEAR__') {
            this.clear();
            return;
          }
          result.forEach((line) => this.echo(line));
        } else {
          this.echo(
            `${C.dim('command not found:')} ${C.red(command)}`
          );
          this.echo(
            `${C.dim('Try')} ${C.cyan('help')} ${C.dim('to see available commands.')}`
          );
        }
      },
      {
        greetings: false,
        prompt: `${C.cyan('❯')} `,
        name: 'openfleet-demo',
        height: 420,
        outputLimit: 300,
        checkArity: false,
        completion: Object.keys(COMMANDS),
        keymap: {},
      }
    );

    if (greeting) {
      term.echo('');
      term.echo(`  ${C.dim('┌──────────────────────────────────────────────────┐')}`);
      term.echo(`  ${C.dim('│')}  ${C.cyan('⚡')} ${C.bold('OpenFleet Interactive Demo')}                    ${C.dim('│')}`);
      term.echo(`  ${C.dim('│')}  ${C.dim('Type')} ${C.cyan('help')} ${C.dim('for commands, or watch the auto-demo')}  ${C.dim('│')}`);
      term.echo(`  ${C.dim('└──────────────────────────────────────────────────┘')}`);
      term.echo('');
    }

    /* ── Auto-demo (types commands + shows logs) ───────────────────────── */
    if (autoDemo) {
      let demoRunning = true;
      let demoTimeout = null;

      // Stop demo on user interaction
      const stopDemo = () => {
        if (!demoRunning) return;
        demoRunning = false;
        if (demoTimeout) clearTimeout(demoTimeout);
        term.echo('');
        term.echo(
          `${C.dim('Demo paused — terminal is now interactive. Type')} ${C.cyan('help')} ${C.dim('to explore.')}`
        );
        term.echo('');
      };

      term.on('keydown', stopDemo);

      function runDemo(idx) {
        if (!demoRunning || idx >= DEMO_SEQUENCE.length) {
          if (demoRunning) {
            term.echo('');
            term.echo(
              `${C.dim('Demo complete — terminal is now interactive. Type')} ${C.cyan('help')} ${C.dim('to explore.')}`
            );
            term.echo('');
            demoRunning = false;
          }
          return;
        }

        const step = DEMO_SEQUENCE[idx];
        demoTimeout = setTimeout(() => {
          if (!demoRunning) return;

          if (step.cmd) {
            // Simulate typing a command
            term.exec(step.cmd, false);
          } else if (step.log !== undefined) {
            term.echo(step.log);
          }

          runDemo(idx + 1);
        }, step.delay || 200);
      }

      // Start demo after a brief pause
      setTimeout(() => {
        if (demoRunning) runDemo(0);
      }, 1200);
    }

    return term;
  };
})();
