/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Terminal Simulator
   Uses jQuery Terminal for a rich interactive + auto-demo terminal.
   Realistic logging structure matching actual bosun output.
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

  /* ── Realistic boot sequence matching actual bosun logs ──────────── */
  const DEMO_SEQUENCE = [
    { cmd: 'bosun --echo-logs', delay: 700 },
    { log: '', delay: 100 },
    { log: `  ${C.dim('╭──────────────────────────────────────────────────────────╮')}`, delay: 60 },
    { log: `  ${C.dim('│')} ${C.cyan('>_')} ${C.bold('bosun')} ${C.dim('v0.33.2')}                                 ${C.dim('│')}`, delay: 60 },
    { log: `  ${C.dim('╰──────────────────────────────────────────────────────────╯')}`, delay: 150 },
    { log: `${C.dim('[telegram-bot]')} agent timeout set to 90 min`, delay: 120 },
    { log: `${C.dim('[kanban]')} switched to ${C.cyan('internal')} backend`, delay: 100 },
    { log: `${C.dim('[maintenance]')} removing stale PID file ${C.dim('(PID 272221 no longer alive)')}`, delay: 110 },
    { log: `${C.dim('[dependabot]')} auto-merge enabled — checking every 10 min`, delay: 100 },
    { log: `${C.dim('[auto-update]')} monitoring parent process PID 277248`, delay: 90 },
    { log: `${C.dim('[monitor]')} self-restart watcher disabled ${C.dim('(default outside devmode)')}`, delay: 90 },
    { log: `${C.dim('[task-executor]')} initialized ${C.dim('(mode=internal, maxParallel=6, sdk=auto)')}`, delay: 110 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"prepush-go-vet"')} for event "PrePush" ${C.dim('(blocking)')}`, delay: 80 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"prepush-go-build"')} for event "PrePush" ${C.dim('(blocking)')}`, delay: 80 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"precommit-gofmt"')} for event "PreCommit"`, delay: 80 },
    { log: `${C.dim('[agent-hooks]')} registered hook ${C.green('"task-complete-audit"')} for event "TaskComplete"`, delay: 80 },
    { log: `${C.dim('[agent-hooks]')} loaded 6 hook(s) from .codex/hooks.json`, delay: 100 },
    { log: `${C.dim('[task-executor]')} stream-based watchdog started — analyzing agent health every 60s`, delay: 110 },
    { log: `${C.dim('[agent-pool]')} SDK selected: ${C.cyan('codex')} ${C.dim('(via fallback chain)')}`, delay: 110 },
    { log: `${C.dim('[review-agent]')} initialized ${C.dim('(sdk=codex, maxConcurrent=2, timeout=300000ms)')}`, delay: 100 },
    { log: `${C.dim('[review-agent]')} started`, delay: 70 },
    { log: `${C.dim('[codex-shell]')} SDK loaded successfully`, delay: 120 },
    { log: `${C.dim('[codex-shell]')} initialised with Codex SDK ${C.dim('(sub-agent features enabled)')}`, delay: 120 },
    { log: `${C.dim('[agent-endpoint]')} Listening on ${C.cyan('127.0.0.1:18432')}`, delay: 110 },
    { log: `${C.dim('[pr-cleanup-daemon]')} Starting with interval 1800000ms`, delay: 90 },
    { log: `${C.dim('[worktree-manager]')} git worktree prune completed`, delay: 120 },
    { log: `${C.dim('[maintenance]')} sweep complete: ${C.green('0')} stale orchestrators, ${C.green('0')} stuck pushes, ${C.green('1')} worktrees pruned`, delay: 150 },
    { log: '', delay: 300 },
    // ── Task polling cycle 1 ──
    { log: `${C.dim('[14:31:58]')} ${C.dim('[monitor]')} polling github board for new tasks...`, delay: 500 },
    { log: `${C.dim('[14:32:01]')} ${C.dim('[kanban]')}  found ${C.cyan('3')} new tasks in backlog`, delay: 200 },
    { log: '', delay: 100 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#42')}  feat(market): add order expiry        → ${C.cyan('copilot-claude')}`, delay: 400 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#43')}  fix(veid): token validation            → ${C.cyan('codex-default')}`, delay: 350 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#44')}  refactor(escrow): batch settlement     → ${C.cyan('copilot-claude')}`, delay: 350 },
    { log: '', delay: 200 },
    { log: `${C.dim('[14:33:12]')} ${C.dim('[worktree]')} created ${C.dim('ve/42-market-order-expiry')}`, delay: 200 },
    { log: `${C.dim('[14:33:14]')} ${C.dim('[worktree]')} created ${C.dim('ve/43-veid-token-fix')}`, delay: 180 },
    { log: `${C.dim('[14:33:15]')} ${C.dim('[worktree]')} created ${C.dim('ve/44-escrow-batch-settle')}`, delay: 180 },
    { log: `${C.dim('[14:33:16]')} ${C.dim('[copilot]')} session started for task ${C.bold('#42')}`, delay: 200 },
    { log: `${C.dim('[14:33:18]')} ${C.dim('[codex]')}   session started for task ${C.bold('#43')}`, delay: 180 },
    { log: `${C.dim('[14:33:20]')} ${C.dim('[copilot]')} session started for task ${C.bold('#44')}`, delay: 200 },
    { log: '', delay: 400 },
    // ── Agent working ──
    { log: `${C.dim('[14:35:44]')} ${C.dim('[agent:#43]')} ${C.dim('reading x/veid/keeper/keeper.go...')}`, delay: 300 },
    { log: `${C.dim('[14:36:02]')} ${C.dim('[agent:#43]')} ${C.dim('writing x/veid/keeper/token.go')}`, delay: 250 },
    { log: `${C.dim('[14:38:11]')} ${C.dim('[agent:#43]')} ${C.dim('running go test ./x/veid/... — 14 passed')}`, delay: 280 },
    { log: `${C.dim('[14:38:45]')} ${C.dim('[agent:#43]')} ${C.dim('pre-push hook: gofmt OK, golangci-lint OK')}`, delay: 250 },
    { log: `${C.dim('[14:39:02]')} ${C.dim('[agent:#43]')} ${C.dim('pushing branch ve/43-veid-token-fix...')}`, delay: 300 },
    { log: '', delay: 200 },
    { log: `${C.dim('[14:41:18]')} ${C.dim('[ OK ]')}  ${C.bold('#43')} PR #188 created — CI queued`, delay: 500 },
    { log: `${C.dim('[14:41:20]')} ${C.dim('[ OK ]')}  ${C.bold('#42')} PR #187 created — CI queued`, delay: 400 },
    // ── Watchdog health check ──
    { log: '', delay: 300 },
    { log: `${C.dim('[14:43:00]')} ${C.dim('[watchdog]')} agent health check — ${C.cyan('#42')} ${C.green('ok')}  ${C.cyan('#43')} ${C.green('ok')}  ${C.cyan('#44')} ${C.green('ok')}`, delay: 400 },
    { log: `${C.dim('[14:43:01]')} ${C.dim('[watchdog]')} no anomalies detected, streak: ${C.green('14')} clean checks`, delay: 300 },
    { log: '', delay: 200 },
    // ── CI results ──
    { log: `${C.dim('[14:44:02]')} ${C.dim('[  ✓ ]')}  ${C.bold('#43')} PR #188 — ${C.green('all checks passed')} ${C.dim('(lint ✓  build ✓  test ✓)')}`, delay: 600 },
    { log: `${C.dim('[14:44:05]')} ${C.dim('[MERGE]')} ${C.bold('#43')} PR #188 merged to main ${C.green('✓')}`, delay: 300 },
    { log: `${C.dim('[14:44:06]')} ${C.dim('[telegram]')} notified: :check: PR #188 merged`, delay: 200 },
    { log: '', delay: 200 },
    { log: `${C.dim('[14:45:11]')} ${C.dim('[  ✓ ]')}  ${C.bold('#42')} PR #187 — ${C.green('all checks passed')} ${C.dim('(lint ✓  build ✓  test ✓)')}`, delay: 500 },
    { log: `${C.dim('[14:45:14]')} ${C.dim('[MERGE]')} ${C.bold('#42')} PR #187 merged to main ${C.green('✓')}`, delay: 300 },
    { log: `${C.dim('[14:45:15]')} ${C.dim('[telegram]')} notified: :check: PR #187 merged`, delay: 200 },
    { log: '', delay: 400 },
    // ── Polling cycle 2 ──
    { log: `${C.dim('[14:46:00]')} ${C.dim('[monitor]')} polling github board — checking for new work...`, delay: 500 },
    { log: `${C.dim('[14:46:02]')} ${C.dim('[kanban]')}  found ${C.cyan('2')} new tasks`, delay: 250 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#45')}  feat(hpc): GPU resource metering       → ${C.cyan('codex-default')}`, delay: 350 },
    { log: `${C.dim('[TASK]')}  ${C.bold('#46')}  docs: update provider guide            → ${C.cyan('copilot-claude')}`, delay: 300 },
    { log: '', delay: 300 },
    // ── PR for #44 ──
    { log: `${C.dim('[14:51:20]')} ${C.dim('[ OK ]')}  ${C.bold('#44')} PR #189 created — CI queued`, delay: 600 },
    { log: `${C.dim('[14:52:44]')} ${C.dim('[  ✗ ]')}  ${C.bold('#44')} PR #189 — ${C.amber('lint warning:')} ${C.dim('unused import in escrow/batch.go')}`, delay: 500 },
    { log: `${C.dim('[14:52:45]')} ${C.dim('[autofix]')} ${C.bold('#44')} applying auto-fix for lint error...`, delay: 300 },
    { log: `${C.dim('[14:52:51]')} ${C.dim('[autofix]')} pushed fix commit to PR #189`, delay: 300 },
    { log: `${C.dim('[14:53:40]')} ${C.dim('[  ✓ ]')}  ${C.bold('#44')} PR #189 — ${C.green('all checks passed after auto-fix')}`, delay: 500 },
    { log: `${C.dim('[14:53:43]')} ${C.dim('[MERGE]')} ${C.bold('#44')} PR #189 merged to main ${C.green('✓')}`, delay: 300 },
    { log: '', delay: 300 },
    // ── Summary ──
    { log: `${C.dim('[INFO]')}  Fleet status: ${C.green('4 merged')}  ${C.amber('0 failed')}  ${C.dim('1 auto-fixed')}  ${C.cyan('2 in-progress')}`, delay: 200 },
    { log: `${C.dim('[INFO]')}  Executor load — copilot-claude: ${C.green('42%')}  codex-default: ${C.green('38%')}`, delay: 180 },
    { log: `${C.dim('[INFO]')}  Next poll in 60s. Type ${C.cyan('help')} for available commands.`, delay: 200 },
  ];

  /* ── Command responses ──────────────────────────────────────────────── */
  const COMMANDS = {
    help: () => [
      '',
      `  ${C.bold('Bosun')} ${C.dim('v0.33.2')} — Demo Commands`,
      '',
      `  ${C.cyan('bosun')}                 Start the supervisor`,
      `  ${C.cyan('bosun --setup')}         Launch the setup wizard`,
      `  ${C.cyan('bosun --doctor')}        Validate configuration`,
      `  ${C.cyan('bosun --daemon')}        Run as background daemon`,
      `  ${C.cyan('bosun --daemon-status')} Check daemon status`,
      `  ${C.cyan('bosun --echo-logs')}     Tail live orchestrator output`,
      `  ${C.cyan('bosun task list')}       List tasks`,
      `  ${C.cyan('bosun task stats')}      Task statistics`,
      `  ${C.cyan('bosun --portal')}        Launch desktop portal`,
      `  ${C.cyan('bosun --help')}          Show full CLI help`,
      `  ${C.cyan('bosun --version')}       Show version`,
      '',
      `  ${C.dim('This demo supports a subset of the CLI.')}`,
      `  ${C.dim('For the full reference, run')} ${C.cyan('bosun --help')} ${C.dim('(real command).')}`,
      '',
    ],

    'bosun --help': () => [
      '',
      `  ${C.bold('bosun')} ${C.dim('v0.33.2')}`,
      `  ${C.dim('AI-powered orchestrator supervisor with executor failover, smart PR flow, and Telegram notifications.')}`,
      '',
      `  ${C.bold('USAGE')}`,
      `    bosun [options]`,
      '',
      `  ${C.bold('COMMANDS')}`,
      `    ${C.cyan('--setup')}                     Launch the web-based setup wizard (default)`,
      `    ${C.cyan('--setup-terminal')}            Run the legacy terminal setup wizard`,
      `    ${C.cyan('--where')}                     Show the resolved bosun config directory`,
      `    ${C.cyan('--doctor')}                    Validate bosun .env/config setup`,
      `    ${C.cyan('--help')}                      Show this help`,
      `    ${C.cyan('--version')}                   Show version`,
      `    ${C.cyan('--portal')}, ${C.cyan('--desktop')}         Launch the Bosun desktop portal (Electron)`,
      `    ${C.cyan('--desktop-shortcut')}          Create a desktop shortcut for the portal`,
      `    ${C.cyan('--desktop-shortcut-remove')}   Remove the desktop shortcut`,
      `    ${C.cyan('--desktop-shortcut-status')}   Show desktop shortcut status`,
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
      `    ${C.cyan('--echo-logs')}                 Echo raw orchestrator output to console (off by default)`,
      `    ${C.cyan('--quiet')}, ${C.cyan('-q')}                 Only show warnings and errors in terminal`,
      `    ${C.cyan('--verbose')}, ${C.cyan('-V')}               Show debug-level messages in terminal`,
      `    ${C.cyan('--trace')}                     Show all messages including trace-level`,
      `    ${C.cyan('--log-level')} <level>         ${C.dim('trace|debug|info|warn|error|silent')}`,
      '',
      `  ${C.bold('AI / CODEX')}`,
      `    ${C.cyan('--no-codex')}                  Disable Codex SDK analysis`,
      `    ${C.cyan('--no-autofix')}                Disable automatic error fixing`,
      `    ${C.cyan('--primary-agent')} <name>      Override primary agent (codex|copilot|claude)`,
      `    ${C.cyan('--shell')}, ${C.cyan('--interactive')}      Enable interactive shell mode in monitor`,
      '',
      `  ${C.bold('TELEGRAM')}`,
      `    ${C.cyan('--no-telegram-bot')}           Disable the interactive Telegram bot`,
      `    ${C.cyan('--telegram-commands')}         Enable monitor-side Telegram polling (advanced)`,
      '',
      `  ${C.bold('WHATSAPP')}`,
      `    ${C.cyan('--whatsapp-auth')}             Run WhatsApp authentication (QR code)`,
      `    ${C.cyan('--whatsapp-auth --pairing-code')}  Authenticate via pairing code instead of QR`,
      '',
      `  ${C.bold('CONTAINERS')}`,
      `    ${C.dim('Container support is configured via environment variables:')}`,
      `      ${C.cyan('CONTAINER_ENABLED=1')}       Enable container isolation for agent execution`,
      `      ${C.cyan('CONTAINER_RUNTIME=docker')}  Runtime to use (docker|podman|container)`,
      '',
      `  ${C.bold('WORKSPACES')}`,
      `    ${C.cyan('--workspace-list')}            List configured workspaces`,
      `    ${C.cyan('--workspace-add')} <name>      Create a new workspace`,
      `    ${C.cyan('--workspace-switch')} <id>     Switch active workspace`,
      `    ${C.cyan('--workspace-add-repo')}        Add repo to workspace (interactive)`,
      `    ${C.cyan('--workspace-health')}          Run workspace health diagnostics`,
      '',
      `  ${C.bold('TASK MANAGEMENT')}`,
      `    ${C.cyan('task list')} [--status s] [--json]  List tasks with optional filters`,
      `    ${C.cyan('task create')} <json|flags>    Create a new task from JSON or flags`,
      `    ${C.cyan('task get')} <id> [--json]      Show task details by ID (prefix match)`,
      `    ${C.cyan('task update')} <id> <patch>    Update task fields (JSON or flags)`,
      `    ${C.cyan('task delete')} <id>            Delete a task`,
      `    ${C.cyan('task stats')} [--json]         Show aggregate task statistics`,
      `    ${C.cyan('task import')} <file.json>     Bulk import tasks from JSON`,
      `    ${C.cyan('task plan')} [--count N]       Trigger AI task planner`,
      '',
      `  ${C.bold('VIBE-KANBAN')}`,
      `    ${C.cyan('--no-vk-spawn')}               Don't auto-spawn Vibe-Kanban`,
      `    ${C.cyan('--vk-ensure-interval')} <ms>   VK health check interval ${C.dim('(default: 60000)')}`,
      '',
      `  ${C.bold('STARTUP SERVICE')}`,
      `    ${C.cyan('--enable-startup')}             Register bosun to auto-start on login`,
      `    ${C.cyan('--disable-startup')}           Remove bosun from startup services`,
      `    ${C.cyan('--startup-status')}            Check if startup service is installed`,
      '',
      `  ${C.bold('SENTINEL')}`,
      `    ${C.cyan('--sentinel')}                  Start telegram-sentinel in companion mode`,
      `    ${C.cyan('--sentinel-stop')}             Stop a running sentinel`,
      `    ${C.cyan('--sentinel-status')}           Show sentinel status`,
      '',
      `  ${C.bold('FILE WATCHING')}`,
      `    ${C.cyan('--no-watch')}                  Disable file watching for auto-restart`,
      `    ${C.cyan('--watch-path')} <path>         File to watch (default: script path)`,
      '',
      `  ${C.bold('CONFIGURATION')}`,
      `    ${C.cyan('--config-dir')} <path>         Directory containing config files`,
      `    ${C.cyan('--repo-root')} <path>          Repository root (auto-detected)`,
      `    ${C.cyan('--project-name')} <name>       Project name for display`,
      `    ${C.cyan('--repo')} <org/repo>           GitHub repo slug`,
      `    ${C.cyan('--repo-name')} <name>          Select repository from multi-repo config`,
      `    ${C.cyan('--profile')} <name>            Environment profile selection`,
      `    ${C.cyan('--mode')} <name>               Override mode (virtengine/generic)`,
      '',
      `  ${C.bold('ENVIRONMENT')}`,
      `    Configuration is loaded from (in priority order):`,
      `    1. CLI flags`,
      `    2. Environment variables`,
      `    3. .env file`,
      `    4. bosun.config.json`,
      `    5. Built-in defaults`,
      '',
      `    Auto-update environment variables:`,
      `      ${C.cyan('BOSUN_SKIP_UPDATE_CHECK=1')}     Disable startup version check`,
      `      ${C.cyan('BOSUN_SKIP_AUTO_UPDATE=1')}      Disable background polling`,
      `      ${C.cyan('BOSUN_UPDATE_INTERVAL_MS=N')}    Override poll interval ${C.dim('(default: 600000)')}`,
      '',
      `    ${C.dim('See .env.example for all environment variables.')}`,
      '',
    ],
    '--help': () => COMMANDS['bosun --help'](),

    bosun: () => [
      '',
      `  ${C.dim('Starting bosun supervisor...')}`,
      `  ${C.dim('Tip:')} ${C.cyan('bosun --help')} ${C.dim('for full CLI reference.')}`,
      '',
    ],
    'bosun --where': () => [
      '',
      `  ${C.dim('Bosun config dir:')} ${C.cyan('~/.config/bosun')}`,
      '',
    ],
    '--where': () => COMMANDS['bosun --where'](),
    'bosun --portal': () => [
      '',
      `  ${C.dim('Launching Bosun Desktop Portal (Electron)...')}`,
      '',
    ],
    '--portal': () => COMMANDS['bosun --portal'](),
    'bosun --desktop': () => COMMANDS['bosun --portal'](),
    '--desktop': () => COMMANDS['bosun --portal'](),

    'bosun --setup': () => [
      '',
      `  ${C.bold('Bosun Setup Wizard')}`,
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
      `  ${C.green('✓')} bosun.config.json generated`,
      `  ${C.green('✓')} VS Code Copilot settings configured`,
      `  ${C.green('✓')} .codex/hooks.json scaffolded`,
      '',
      `  ${C.bold('Setup complete!')} Run ${C.cyan('bosun')} to start.`,
      '',
    ],
    '--setup': () => COMMANDS['bosun --setup'](),

    'bosun --version': () => [
      `bosun v0.33.2`,
    ],
    '--version': () => COMMANDS['bosun --version'](),
    version: () => COMMANDS['bosun --version'](),

    'bosun task stats': () => [
      '',
      `  ${C.bold('Task Stats')}`,
      `  ${C.dim('──────────────────────────────')}`,
      `  ${C.dim('Tasks completed:')} ${C.green('12')}`,
      `  ${C.dim('Tasks in progress:')} ${C.cyan('2')}`,
      `  ${C.dim('Tasks queued:')} ${C.white('4')}`,
      `  ${C.dim('Auto-fix loops resolved:')} ${C.amber('3')}`,
      '',
    ],
    'task stats': () => COMMANDS['bosun task stats'](),

    'bosun task list': () => [
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
    'task list': () => COMMANDS['bosun task list'](),

    'bosun --doctor': () => [
      '',
      `  ${C.bold('Config Doctor')} ${C.dim('— checking your setup...')}`,
      '',
      `  ${C.green('✓')} .env file found`,
      `  ${C.green('✓')} bosun.config.json valid`,
      `  ${C.green('✓')} GitHub CLI authenticated`,
      `  ${C.green('✓')} Telegram bot token valid`,
      `  ${C.green('✓')} Executor pool configured (2 executors)`,
      `  ${C.green('✓')} Kanban backend reachable (github)`,
      `  ${C.green('✓')} Shared state persistence writable`,
      '',
      `  ${C.green('All checks passed.')} Your setup is ready.`,
      '',
    ],
    '--doctor': () => COMMANDS['bosun --doctor'](),
    doctor: () => COMMANDS['bosun --doctor'](),

    'bosun --daemon': () => [
      `${C.dim('[daemon]')} Starting bosun in background...`,
      `${C.dim('[daemon]')} PID file: .cache/bosun.pid`,
      `${C.dim('[daemon]')} Log file: logs/daemon.log`,
      `${C.green('✓')} Daemon started (PID: 28451)`,
    ],
    '--daemon': () => COMMANDS['bosun --daemon'](),

    'bosun --daemon-status': () => [
      `${C.green('●')} bosun daemon is running (PID: 28451, uptime: 2h 34m)`,
    ],
    '--daemon-status': () => COMMANDS['bosun --daemon-status'](),

    'bosun --sentinel': () => [
      `${C.dim('[sentinel]')} Starting Telegram sentinel in companion mode...`,
      `${C.dim('[sentinel]')} Watchdog enabled — auto-restart on crash loop`,
      `${C.dim('[sentinel]')} Listening for Telegram commands`,
      `${C.green('✓')} Sentinel started`,
    ],
    '--sentinel': () => COMMANDS['bosun --sentinel'](),

    'bosun --update': () => [
      `${C.dim('[update]')} Checking for updates...`,
      `${C.dim('[update]')} Current: v0.33.2`,
      `${C.dim('[update]')} Latest:  v0.33.2`,
      `${C.green('✓')} Already on the latest version.`,
    ],
    '--update': () => COMMANDS['bosun --update'](),

    clear: () => '__CLEAR__',

    ls: () => [
      `${C.cyan('cli.mjs')}  ${C.cyan('monitor.mjs')}  ${C.cyan('config.mjs')}  ${C.cyan('setup.mjs')}  ${C.cyan('ve-orchestrator.mjs')}  ${C.dim('.env')}  ${C.dim('package.json')}`,
    ],
    pwd: () => [`/home/user/virtengine/scripts/bosun`],
    whoami: () => [`bosun-agent`],

    'cat .env': () => [
      `${C.dim('# ─── Bosun Environment Configuration ───')}`,
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

    'bosun --echo-logs': () => [
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
    '--echo-logs': () => COMMANDS['bosun --echo-logs'](),

    'bosun --echo-daemon': () => [
      '',
      `  ${C.red('Unknown flag:')} ${C.cyan('--echo-daemon')}`,
      `  ${C.dim('Did you mean')} ${C.cyan('--echo-logs')} ${C.dim('or')} ${C.cyan('--daemon')}?`,
      `  ${C.dim('See')} ${C.cyan('bosun --help')} ${C.dim('for the full list.')}`,
      '',
    ],

    neofetch: () => [
      '',
      `  ${C.cyan('   ___  _____ ')}   ${C.bold('bosun')}@virtengine`,
      `  ${C.cyan('  / _ \\|  ___|')}   ${C.dim('─────────────────────')}`,
      `  ${C.cyan(' | | | | |_   ')}   ${C.dim('OS:')}      Linux x86_64`,
      `  ${C.cyan(' | |_| |  _|  ')}   ${C.dim('Runtime:')} Node.js 22.0`,
      `  ${C.cyan('  \\___/|_|    ')}   ${C.dim('Agents:')}  2 active`,
      `  ${C.cyan('              ')}   ${C.dim('Uptime:')}  2h 34m`,
      `  ${C.cyan('  bosun   ')}   ${C.dim('Tasks:')}   13 completed`,
      '',
    ],
  };

  /* ── Initialize terminal ─────────────────────────────────────────────── */
  window.initBosunTerminal = function (selector, options = {}) {
    const { autoDemo = true, greeting = true } = options;

    const term = $(selector).terminal(
      function (command) {
        command = command.trim();
        if (!command) return;

        // Check for exact match first
        let handler = COMMANDS[command] || COMMANDS[command.toLowerCase()];

        // Try normalized matching: "bosun --flag" :workflow: "--flag"
        if (!handler) {
          const lower = command.toLowerCase().trim();
          // If user typed "bosun --something", try as-is and stripped
          const stripped = lower.replace(/^bosun\s+/, '');
          handler =
            COMMANDS[lower] ||
            COMMANDS[stripped] ||
            COMMANDS['bosun ' + stripped];
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
            `${C.dim('Try')} ${C.cyan('help')} ${C.dim('or')} ${C.cyan('bosun --help')} ${C.dim('for the full CLI list.')}`
          );
        }
      },
      {
        greetings: false,
        prompt: `${C.cyan('❯')} `,
        name: 'bosun-demo',
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
      term.echo(`  ${C.dim('│')}  ${C.cyan(':zap:')} ${C.bold('Bosun Interactive Demo')}                    ${C.dim('│')}`);
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

      // Show loading screen, then start demo after 5 seconds
      term.echo('');
      term.echo(`  ${C.dim('Connecting to fleet supervisor...')}`);
      setTimeout(() => {
        if (!demoRunning) return;
        term.echo(`  ${C.green('●')} ${C.dim('Session established — starting live tail...')}`);
        term.echo('');
        setTimeout(() => {
          if (demoRunning) runDemo(0);
        }, 800);
      }, 4200);
    }

    return term;
  };
})();
