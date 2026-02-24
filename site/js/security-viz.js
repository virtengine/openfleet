/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Security Visualizer
   Interactive visualization of Bosun's security architecture.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Icon set (line style to match landing page) ─────────────────────── */
  const ICONS = {
    lock: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2"></rect>
        <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
      </svg>
    `,
    user: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5"></circle>
        <path d="M5 20a7 7 0 0 1 14 0"></path>
      </svg>
    `,
    signal: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 16a8 8 0 0 1 16 0"></path>
        <path d="M7 16a5 5 0 0 1 10 0"></path>
        <circle cx="12" cy="16" r="1"></circle>
      </svg>
    `,
    search: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="4"></circle>
        <path d="M20 20l-3.5-3.5"></path>
      </svg>
    `,
    check: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 12l4 4 8-8"></path>
      </svg>
    `,
    ticket: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 7h14v4a2 2 0 0 1 0 4v4H5v-4a2 2 0 0 0 0-4z"></path>
      </svg>
    `,
    phone: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="7" y="3" width="10" height="18" rx="2"></rect>
        <path d="M11 17h2"></path>
      </svg>
    `,
    key: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="11" r="3"></circle>
        <path d="M12 11h8M18 11v3M16 11v2"></path>
      </svg>
    `,
    shield: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z"></path>
      </svg>
    `,
    globe: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M3 12h18"></path>
        <path d="M12 3c3 3 3 15 0 18c-3-3-3-15 0-18z"></path>
      </svg>
    `,
    bolt: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M13 2L5 14h6l-1 8 8-12h-6z"></path>
      </svg>
    `,
    cloud: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 18h10a4 4 0 0 0 0-8 5 5 0 0 0-9-2 4 4 0 0 0-1 10z"></path>
      </svg>
    `,
    box: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7l9-4 9 4-9 4-9-4z"></path>
        <path d="M3 7v10l9 4 9-4V7"></path>
        <path d="M12 11v10"></path>
      </svg>
    `,
    clipboard: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="6" y="5" width="12" height="15" rx="2"></rect>
        <path d="M9 3h6v4H9z"></path>
        <path d="M9 11h6M9 15h4"></path>
      </svg>
    `,
    cpu: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="2"></rect>
        <path d="M9 9h6M9 13h6"></path>
        <path d="M4 10h2M4 14h2M18 10h2M18 14h2"></path>
      </svg>
    `,
    folder: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
      </svg>
    `,
    refresh: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 6v6h-6"></path>
        <path d="M4 18v-6h6"></path>
        <path d="M20 12a8 8 0 0 0-14.5-4.5M4 12a8 8 0 0 0 14.5 4.5"></path>
      </svg>
    `,
    clock: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8"></circle>
        <path d="M12 8v5l3 2"></path>
      </svg>
    `,
  };

  /* ── Security flow data ──────────────────────────────────────────────── */
  const SECURITY_FLOWS = [
    {
      id: 'telegram-auth',
      icon: ICONS.lock,
      title: 'Telegram Token Authorization',
      desc: 'Bot tokens authenticate the Telegram channel. Only authorized chat IDs can issue commands. The bot validates every incoming message against the configured TELEGRAM_CHAT_ID before executing any action.',
      steps: [
        { label: 'User sends /command', icon: ICONS.user, color: '#3b82f6' },
        { label: 'Telegram Bot API', icon: ICONS.signal, color: '#64748b' },
        { label: 'Verify chat_id match', icon: ICONS.search, color: '#f59e0b' },
        { label: 'Execute if authorized', icon: ICONS.check, color: '#10b981' },
      ],
      details: [
        'TELEGRAM_BOT_TOKEN authenticates bot → Telegram API',
        'TELEGRAM_CHAT_ID restricts command execution to a single chat',
        'Admin user list enforces per-user ACL on destructive actions',
        'Rate limiting prevents command flooding',
      ],
    },
    {
      id: 'miniapp-token',
      title: 'MiniApp Secure Token Flow',
      icon: ICONS.ticket,
      desc: 'The MiniApp receives authentication tokens through Telegram\'s secure WebView channel. Tokens are passed via initData — cryptographically signed by Telegram — and verified server-side before granting API access.',
      steps: [
        { label: 'Telegram WebView', icon: ICONS.phone, color: '#3b82f6' },
        { label: 'initData + HMAC', icon: ICONS.key, color: '#a78bfa' },
        { label: 'Server validates hash', icon: ICONS.shield, color: '#f59e0b' },
        { label: 'Session token issued', icon: ICONS.ticket, color: '#10b981' },
      ],
      details: [
        'Telegram signs initData with bot token HMAC-SHA256',
        'Server verifies signature — prevents forged requests',
        'Session tokens auto-refresh on expiry (configurable TTL)',
        'HTTPS enforced — MiniApp only loads over TLS',
      ],
    },
    {
      id: 'cloudflare-tunnel',
      title: 'Automatic Cloudflare Tunnel',
      icon: ICONS.globe,
      desc: 'Bosun auto-provisions a Cloudflare tunnel for HTTPS access to the MiniApp. No port forwarding, no SSL cert management — the tunnel creates a persistent, secure endpoint automatically.',
      steps: [
        { label: 'bosun starts', icon: ICONS.bolt, color: '#60cc5d' },
        { label: 'cloudflared tunnel', icon: ICONS.cloud, color: '#f59e0b' },
        { label: 'HTTPS endpoint live', icon: ICONS.lock, color: '#10b981' },
        { label: 'Telegram webhook set', icon: ICONS.signal, color: '#3b82f6' },
      ],
      details: [
        'CLOUDFLARE_TUNNEL_MODE: auto | cloudflared | disabled',
        'Auto mode: zero-config tunnel provisioning via cloudflared',
        'Persistent URL or rotating TryCloudflare URLs',
        'Token auto-appended to MiniApp URL for auth',
      ],
    },
    {
      id: 'container-isolation',
      title: 'Container Isolation',
      icon: ICONS.box,
      desc: 'AI agents run inside isolated containers — Docker, Podman, or Apple Containers. Each agent gets its own filesystem, network namespace, and resource limits. No lateral movement between agents.',
      steps: [
        { label: 'Task dispatched', icon: ICONS.clipboard, color: '#3b82f6' },
        { label: 'Container spawned', icon: ICONS.box, color: '#a78bfa' },
        { label: 'Agent runs isolated', icon: ICONS.cpu, color: '#f59e0b' },
        { label: 'Result extracted', icon: ICONS.check, color: '#10b981' },
      ],
      details: [
        'CONTAINER_MODE: docker | podman | apple-container | disabled',
        'Each agent session = dedicated container with resource limits',
        'Filesystem isolation — agents cannot access host or each other',
        'Automatic cleanup — containers destroyed after task completion',
        'Concurrent container limit via MAX_CONTAINERS',
      ],
    },
    {
      id: 'sandbox-policy',
      title: 'Codex Sandbox Policy',
      icon: ICONS.shield,
      desc: 'Codex agents run under a bubblewrap (bwrap) sandbox with strict filesystem policies. Workspace-write mode allows only the project directory, blocking access to secrets, SSH keys, and system files.',
      steps: [
        { label: 'Codex task starts', icon: ICONS.bolt, color: '#60cc5d' },
        { label: 'bwrap sandbox init', icon: ICONS.shield, color: '#f59e0b' },
        { label: 'Filesystem policy', icon: ICONS.folder, color: '#a78bfa' },
        { label: 'Secure execution', icon: ICONS.lock, color: '#10b981' },
      ],
      details: [
        'SANDBOX_POLICY: workspace-write (default) | full-auto',
        'workspace-write: read-only / except project directory',
        'Full network isolation — no outbound except Codex API',
        'No access to ~/.ssh, ~/.gnupg, /etc/shadow, etc.',
        'Custom sandbox permissions via SANDBOX_PERMISSIONS',
      ],
    },
    {
      id: 'token-refresh',
      title: 'Automatic Token Refresh',
      icon: ICONS.refresh,
      desc: 'Session tokens, Cloudflare tunnel URLs, and API keys are automatically refreshed before expiry. The daemon monitors token lifetimes and rotates credentials seamlessly — zero downtime.',
      steps: [
        { label: 'Token issued', icon: ICONS.ticket, color: '#10b981' },
        { label: 'TTL monitored', icon: ICONS.clock, color: '#3b82f6' },
        { label: 'Refresh triggered', icon: ICONS.refresh, color: '#f59e0b' },
        { label: 'New token active', icon: ICONS.check, color: '#10b981' },
      ],
      details: [
        'Session tokens: 24h default TTL, auto-refresh at 80% lifetime',
        'Cloudflare tunnel: auto-reconnect with exponential backoff',
        'GitHub token: PAT validation on startup, warnings on expiry',
        'WebSocket: heartbeat + auto-reconnect with jitter',
      ],
    },
  ];

  /* ── Initialize security section ─────────────────────────────────────── */
  window.initSecurityVisualizer = function (containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    // Build the security cards
    let html = '<div class="security-grid">';

    SECURITY_FLOWS.forEach(function (flow, index) {
      html += `
        <div class="security-card reveal reveal--delay-${(index % 3) + 1}" data-flow="${flow.id}">
          <div class="security-card__header">
            <div class="security-card__icon">${flow.icon}</div>
            <h3 class="security-card__title">${flow.title}</h3>
          </div>
          <p class="security-card__desc">${flow.desc}</p>

          <div class="security-flow" id="flow-${flow.id}">
            <div class="security-flow__steps">
              ${flow.steps.map(function (step, i) {
                return `
                  <div class="security-flow__step" style="--step-color: ${step.color}">
                    <div class="security-flow__step-icon">${step.icon}</div>
                    <div class="security-flow__step-label">${step.label}</div>
                  </div>
                  ${i < flow.steps.length - 1 ? '<div class="security-flow__arrow"><svg width="20" height="12" viewBox="0 0 20 12"><path d="M0 6h16M12 1l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' : ''}
                `;
              }).join('')}
            </div>
          </div>

          <div class="security-card__details">
            <div class="security-card__details-toggle" data-target="details-${flow.id}">
              <span>Technical Details</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <ul class="security-card__details-list" id="details-${flow.id}" style="display:none;">
              ${flow.details.map(function (d) {
                return '<li>' + d + '</li>';
              }).join('')}
            </ul>
          </div>
        </div>
      `;
    });

    html += '</div>';
    container.innerHTML = html;

    /* ── Toggle details ────────────────────────────────────────────── */
    container.querySelectorAll('.security-card__details-toggle').forEach(function (toggle) {
      toggle.addEventListener('click', function () {
        const target = document.getElementById(toggle.dataset.target);
        if (!target) return;
        const isOpen = target.style.display !== 'none';
        target.style.display = isOpen ? 'none' : '';
        toggle.classList.toggle('security-card__details-toggle--open', !isOpen);
      });
    });

    /* ── Animate flow steps on scroll ──────────────────────────────── */
    if ('IntersectionObserver' in window) {
      const flowObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            const steps = entry.target.querySelectorAll('.security-flow__step');
            const arrows = entry.target.querySelectorAll('.security-flow__arrow');
            steps.forEach(function (step, i) {
              setTimeout(function () {
                step.classList.add('security-flow__step--visible');
              }, i * 200);
            });
            arrows.forEach(function (arrow, i) {
              setTimeout(function () {
                arrow.classList.add('security-flow__arrow--visible');
              }, i * 200 + 100);
            });
            flowObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.3 });

      container.querySelectorAll('.security-flow').forEach(function (flow) {
        flowObserver.observe(flow);
      });
    }

    /* ── Re-observe reveal elements for cards ──────────────────────── */
    if ('IntersectionObserver' in window) {
      const revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal--visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

      container.querySelectorAll('.reveal').forEach(function (el) {
        revealObserver.observe(el);
      });
    }
  };

})();
