/* ═══════════════════════════════════════════════════════════════════════════
   OpenFleet Security Visualizer
   Interactive visualization of OpenFleet's security architecture.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Security flow data ──────────────────────────────────────────────── */
  const SECURITY_FLOWS = [
    {
      id: 'telegram-auth',
      icon: '🔐',
      title: 'Telegram Token Authorization',
      desc: 'Bot tokens authenticate the Telegram channel. Only authorized chat IDs can issue commands. The bot validates every incoming message against the configured TELEGRAM_CHAT_ID before executing any action.',
      steps: [
        { label: 'User sends /command', icon: '👤', color: '#3b82f6' },
        { label: 'Telegram Bot API', icon: '📡', color: '#64748b' },
        { label: 'Verify chat_id match', icon: '🔍', color: '#f59e0b' },
        { label: 'Execute if authorized', icon: '✅', color: '#10b981' },
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
      icon: '🎫',
      desc: 'The MiniApp receives authentication tokens through Telegram\'s secure WebView channel. Tokens are passed via initData — cryptographically signed by Telegram — and verified server-side before granting API access.',
      steps: [
        { label: 'Telegram WebView', icon: '📱', color: '#3b82f6' },
        { label: 'initData + HMAC', icon: '🔑', color: '#a78bfa' },
        { label: 'Server validates hash', icon: '🛡️', color: '#f59e0b' },
        { label: 'Session token issued', icon: '🎫', color: '#10b981' },
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
      icon: '🌐',
      desc: 'OpenFleet auto-provisions a Cloudflare tunnel for HTTPS access to the MiniApp. No port forwarding, no SSL cert management — the tunnel creates a persistent, secure endpoint automatically.',
      steps: [
        { label: 'openfleet starts', icon: '⚡', color: '#60cc5d' },
        { label: 'cloudflared tunnel', icon: '🌐', color: '#f59e0b' },
        { label: 'HTTPS endpoint live', icon: '🔒', color: '#10b981' },
        { label: 'Telegram webhook set', icon: '📡', color: '#3b82f6' },
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
      icon: '📦',
      desc: 'AI agents run inside isolated containers — Docker, Podman, or Apple Containers. Each agent gets its own filesystem, network namespace, and resource limits. No lateral movement between agents.',
      steps: [
        { label: 'Task dispatched', icon: '📋', color: '#3b82f6' },
        { label: 'Container spawned', icon: '📦', color: '#a78bfa' },
        { label: 'Agent runs isolated', icon: '🤖', color: '#f59e0b' },
        { label: 'Result extracted', icon: '✅', color: '#10b981' },
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
      icon: '🛡️',
      desc: 'Codex agents run under a bubblewrap (bwrap) sandbox with strict filesystem policies. Workspace-write mode allows only the project directory, blocking access to secrets, SSH keys, and system files.',
      steps: [
        { label: 'Codex task starts', icon: '⚡', color: '#60cc5d' },
        { label: 'bwrap sandbox init', icon: '🛡️', color: '#f59e0b' },
        { label: 'Filesystem policy', icon: '📂', color: '#a78bfa' },
        { label: 'Secure execution', icon: '🔒', color: '#10b981' },
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
      icon: '🔄',
      desc: 'Session tokens, Cloudflare tunnel URLs, and API keys are automatically refreshed before expiry. The daemon monitors token lifetimes and rotates credentials seamlessly — zero downtime.',
      steps: [
        { label: 'Token issued', icon: '🎫', color: '#10b981' },
        { label: 'TTL monitored', icon: '⏱', color: '#3b82f6' },
        { label: 'Refresh triggered', icon: '🔄', color: '#f59e0b' },
        { label: 'New token active', icon: '✅', color: '#10b981' },
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
