/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Landing Page — Main JavaScript
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Scroll Progress Bar ─────────────────────────────────────────────── */
  const progressBar = document.getElementById('scroll-progress');
  if (progressBar) {
    window.addEventListener('scroll', function () {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
      progressBar.style.width = progress + '%';
    }, { passive: true });
  }

  /* ── Scroll-linked nav background ────────────────────────────────────── */
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('nav--scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── Active nav link highlighting ────────────────────────────────────── */
  const navLinks = document.querySelectorAll('.nav__links a[href^="#"]');
  const sections = [];
  navLinks.forEach(function (link) {
    var target = document.querySelector(link.getAttribute('href'));
    if (target) sections.push({ el: target, link: link });
  });
  if (sections.length) {
    window.addEventListener('scroll', function () {
      var scrollY = window.scrollY + 120;
      var active = null;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.offsetTop <= scrollY) active = sections[i].link;
      }
      navLinks.forEach(function (l) { l.classList.remove('nav__link--active'); });
      if (active) active.classList.add('nav__link--active');
    }, { passive: true });
  }

  /* ── Mobile nav toggle ───────────────────────────────────────────────── */
  const toggle = document.querySelector('.nav__toggle');
  const links = document.querySelector('.nav__links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('nav__links--open');
      toggle.textContent = links.classList.contains('nav__links--open') ? '✕' : '☰';
    });
    // Close on link click
    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        links.classList.remove('nav__links--open');
        toggle.textContent = '☰';
      });
    });
  }

  /* ── Hero Typing Effect ──────────────────────────────────────────────── */
  const typedEl = document.getElementById('hero-typed');
  const cursorEl = document.getElementById('typed-cursor');
  if (typedEl) {
    const phrases = [
      'Task Ops.',
      'PR Orchestration.',
      'Release Ops.',
      'Agent Ops.',
      'Fleet Ops.',
    ];
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;
    let pauseUntil = 0;
    const pauseDurationMs = 20000;

    function typeLoop() {
      var phrase = phrases[phraseIdx];
      if (!deleting) {
        charIdx++;
        typedEl.textContent = phrase.substring(0, charIdx);
        if (charIdx === phrase.length) {
          pauseUntil = Date.now() + pauseDurationMs;
          deleting = true;
        }
      } else {
        if (Date.now() < pauseUntil) {
          requestAnimationFrame(function () { setTimeout(typeLoop, 120); });
          return;
        }
        charIdx--;
        typedEl.textContent = phrase.substring(0, charIdx);
        if (charIdx === 0) {
          deleting = false;
          phraseIdx = (phraseIdx + 1) % phrases.length;
        }
      }

      var speed = deleting ? 120 + Math.random() * 60 : 140 + Math.random() * 80;
      setTimeout(typeLoop, speed);
    }

    // Start typing after a brief delay
    setTimeout(typeLoop, 800);

    // Cursor blink
    if (cursorEl) {
      setInterval(function () {
        cursorEl.style.opacity = cursorEl.style.opacity === '0' ? '1' : '0';
      }, 530);
    }
  }

  /* ── Copy install command ────────────────────────────────────────────── */
  document.querySelectorAll('.install-cmd').forEach((el) => {
    el.addEventListener('click', () => {
      const text = el.querySelector('.install-cmd__text')?.textContent;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const tip = el.querySelector('.install-cmd__tooltip');
        if (tip) {
          tip.classList.add('install-cmd__tooltip--visible');
          setTimeout(() => tip.classList.remove('install-cmd__tooltip--visible'), 1500);
        }
      });
    });
  });

  /* ── Inject package version in hero tag and footer ───────────────────── */
  const versionTargets = document.querySelectorAll('[data-version]');
  if (versionTargets.length > 0) {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const sources = isLocal
      ? ['../package.json', './package.json', 'https://raw.githubusercontent.com/virtengine/bosun/main/package.json']
      : ['https://raw.githubusercontent.com/virtengine/bosun/main/package.json'];
      
    const tryNext = () => {
      const next = sources.shift();
      if (!next) return;
      fetch(next, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((pkg) => {
          if (pkg?.version) {
            versionTargets.forEach(el => el.textContent = `v${pkg.version}`);
          } else {
            tryNext();
          }
        })
        .catch(() => tryNext());
    };
    tryNext();
  }

  /* ── Intersection Observer for scroll reveals ────────────────────────── */
  const reveals = document.querySelectorAll('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal--visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach((el) => observer.observe(el));
  }

  /* ── Terminal initialization (lazy, on scroll into view) ─────────────── */
  const terminalBody = document.querySelector('.terminal-window__body');
  if (terminalBody && typeof $ !== 'undefined' && $.fn.terminal) {
    let termInit = false;
    const termObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !termInit) {
          termInit = true;
          window.initBosunTerminal('.terminal-window__body', {
            autoDemo: true,
            greeting: true,
          });
          termObserver.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    termObserver.observe(terminalBody);
  }

  /* ── MiniApp fullscreen toggle ───────────────────────────────────────── */
  const miniappExpandBtn = document.querySelector('.miniapp-demo-window__expand');
  const miniappPhone = document.querySelector('.miniapp-demo-window__phone');
  const miniappOverlay = document.querySelector('.miniapp-demo-window__overlay');
  if (miniappExpandBtn && miniappPhone) {
    const setFullscreen = (enabled) => {
      miniappPhone.classList.toggle('is-fullscreen', enabled);
      miniappExpandBtn.classList.toggle('is-fullscreen', enabled);
      miniappExpandBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      miniappExpandBtn.setAttribute('aria-label', enabled ? 'Exit fullscreen' : 'Enter fullscreen');
      if (miniappOverlay) miniappOverlay.classList.toggle('is-visible', enabled);
      document.body.classList.toggle('is-miniapp-fullscreen', enabled);
    };

    const syncFullscreenState = () => {
      const isFs = document.fullscreenElement === miniappPhone;
      setFullscreen(isFs);
    };

    miniappExpandBtn.addEventListener('click', () => {
      const wantsFullscreen = !miniappPhone.classList.contains('is-fullscreen');
      if (wantsFullscreen && document.fullscreenEnabled && miniappPhone.requestFullscreen) {
        miniappPhone.requestFullscreen().catch(() => {
          setFullscreen(true);
        });
        return;
      }
      if (!wantsFullscreen && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {
          setFullscreen(false);
        });
        return;
      }
      setFullscreen(wantsFullscreen);
    });

    if (miniappOverlay) {
      miniappOverlay.addEventListener('click', () => {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => setFullscreen(false));
        } else {
          setFullscreen(false);
        }
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => setFullscreen(false));
        } else {
          setFullscreen(false);
        }
      }
    });

    document.addEventListener('fullscreenchange', syncFullscreenState);
  }

  /* ── Demo Tab Switching ──────────────────────────────────────────────── */
  var demoTabs = document.querySelectorAll('.demo-tab');
  var demoPanels = document.querySelectorAll('.demo-panel');
  var tgChatInitialized = false;
  var securityInitialized = false;

  demoTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.dataset.demo;

      // Update active tab
      demoTabs.forEach(function (t) { t.classList.remove('demo-tab--active'); });
      tab.classList.add('demo-tab--active');

      // Switch panel
      demoPanels.forEach(function (p) { p.classList.remove('demo-panel--active'); });
      var panel = document.getElementById('demo-panel-' + target);
      if (panel) panel.classList.add('demo-panel--active');

      // Lazy-init Telegram chat on first reveal
      if (target === 'telegram' && !tgChatInitialized && typeof window.initTelegramChatDemo === 'function') {
        tgChatInitialized = true;
        window.initTelegramChatDemo('#telegram-chat-container');
      }
    });
  });

  /* ── Security Section Initialization (lazy on scroll) ────────────────── */
  var securityContainer = document.getElementById('security-visualizer');
  if (securityContainer && 'IntersectionObserver' in window) {
    var secObserver = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting && !securityInitialized) {
          securityInitialized = true;
          if (typeof window.initSecurityVisualizer === 'function') {
            window.initSecurityVisualizer('#security-visualizer');
          }
          secObserver.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    secObserver.observe(securityContainer);
  }

  /* ── Smooth scroll for anchor links ──────────────────────────────────── */
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /* ── Animated counters for stats ─────────────────────────────────────── */
  const statValues = document.querySelectorAll('.stat__value[data-target]');
  if (statValues.length && 'IntersectionObserver' in window) {
    const counterObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            const target = parseInt(el.dataset.target, 10);
            const suffix = el.dataset.suffix || '';
            const prefix = el.dataset.prefix || '';
            const duration = 1500;
            const start = performance.now();

            function animate(now) {
              const elapsed = now - start;
              const progress = Math.min(elapsed / duration, 1);
              const eased = 1 - Math.pow(1 - progress, 3);
              const current = Math.round(eased * target);
              el.textContent = prefix + current.toLocaleString() + suffix;
              if (progress < 1) requestAnimationFrame(animate);
            }
            requestAnimationFrame(animate);
            counterObserver.unobserve(el);
          }
        });
      },
      { threshold: 0.5 }
    );
    statValues.forEach((el) => counterObserver.observe(el));
  }

  /* ── Code Showcase Tabs ──────────────────────────────────────────────── */
  var tabs = document.querySelectorAll('.code-tab');
  var panels = document.querySelectorAll('.code-showcase__panel');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.dataset.tab;
      tabs.forEach(function (t) { t.classList.remove('code-tab--active'); });
      panels.forEach(function (p) { p.classList.remove('code-showcase__panel--active'); });
      tab.classList.add('code-tab--active');
      var panel = document.querySelector('[data-panel="' + target + '"]');
      if (panel) panel.classList.add('code-showcase__panel--active');
    });
  });

  /* ── Tilt effect on feature cards ────────────────────────────────────── */
  document.querySelectorAll('.feature-card').forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var rect = card.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var centerX = rect.width / 2;
      var centerY = rect.height / 2;
      var rotateX = ((y - centerY) / centerY) * -4;
      var rotateY = ((x - centerX) / centerX) * 4;
      card.style.transform = 'perspective(800px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg) translateY(-4px)';
    });
    card.addEventListener('mouseleave', function () {
      card.style.transform = '';
    });
  });

  /* ── Docs sidebar toggle (mobile) ────────────────────────────────────── */
  const sidebarToggle = document.querySelector('.docs-sidebar-toggle');
  const sidebar = document.querySelector('.docs-sidebar');
  const backdrop = document.querySelector('.docs-sidebar-backdrop');
  if (sidebarToggle && sidebar) {
    const toggleSidebar = () => {
      sidebar.classList.toggle('docs-sidebar--open');
      if (backdrop) backdrop.classList.toggle('docs-sidebar-backdrop--visible');
    };
    sidebarToggle.addEventListener('click', toggleSidebar);
    if (backdrop) backdrop.addEventListener('click', toggleSidebar);
  }

  /* ── Docs search (filters sidebar links) ─────────────────────────────── */
  var searchInput = document.querySelector('.docs-search__input');
  if (searchInput) {
    var sidebarLinks = document.querySelectorAll('.sidebar-nav a');
    searchInput.addEventListener('input', function () {
      var query = searchInput.value.toLowerCase().trim();
      sidebarLinks.forEach(function (link) {
        var text = link.textContent.toLowerCase();
        var item = link.closest('li') || link;
        if (!query || text.indexOf(query) !== -1) {
          item.style.display = '';
        } else {
          item.style.display = 'none';
        }
      });
    });

    // Keyboard shortcut: Ctrl+K or / to focus search
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA')) {
        e.preventDefault();
        searchInput.focus();
      }
    });
  }

  // Shared time helper used by both PR and commit feeds
  function timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* ── PR Showcase — fetch real PRs from VirtEngine repo ───────────────── */
  const prContainer = document.getElementById('pr-showcase');
  const commitContainer = document.getElementById('commit-showcase');
  const showcaseTabs = document.querySelectorAll('.showcase-tab');
  const showcaseFeeds = document.querySelectorAll('.showcase-feed');
  const showcaseGhLink = document.getElementById('showcase-gh-link');

  const FEED_LINKS = {
    prs: 'https://github.com/virtengine/virtengine/pulls?q=is%3Apr+sort%3Aupdated-desc',
    commits: 'https://github.com/virtengine/bosun/commits/main',
  };

  // Tab switching
  showcaseTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var feed = tab.dataset.feed;
      showcaseTabs.forEach(function (t) { t.classList.remove('showcase-tab--active'); });
      tab.classList.add('showcase-tab--active');
      showcaseFeeds.forEach(function (p) { p.classList.remove('showcase-feed--active'); });
      var panel = document.querySelector('[data-feed-panel="' + feed + '"]');
      if (panel) panel.classList.add('showcase-feed--active');
      if (showcaseGhLink) {
        showcaseGhLink.href = FEED_LINKS[feed] || FEED_LINKS.prs;
        showcaseGhLink.textContent = feed === 'commits' ? 'View All Commits on GitHub →' : 'View All PRs on GitHub →';
      }
      // Lazy-load commits on first click
      if (feed === 'commits' && commitContainer && !commitContainer.dataset.loaded) {
        commitContainer.dataset.loaded = '1';
        fetchCommits();
      }
    });
  });

  if (prContainer) {
    const API = 'https://api.github.com/repos/virtengine/virtengine/pulls';
    const MAX_PRS = 8;

    function labelColor(color) {
      return 'background: #' + color + '22; color: #' + color + '; border-color: #' + color + '44;';
    }

    function prStateIcon(pr) {
      if (pr.merged_at) return { cls: 'merged', icon: '⇄' };
      if (pr.state === 'closed') return { cls: 'closed', icon: '✕' };
      return { cls: 'open', icon: '⬆' };
    }

    async function fetchPRs() {
      try {
        const [openRes, closedRes] = await Promise.all([
          fetch(API + '?state=open&sort=updated&direction=desc&per_page=' + MAX_PRS),
          fetch(API + '?state=closed&sort=updated&direction=desc&per_page=' + MAX_PRS),
        ]);

        if (!openRes.ok && !closedRes.ok) throw new Error('GitHub API rate limited');

        const openPRs = openRes.ok ? await openRes.json() : [];
        const closedPRs = closedRes.ok ? await closedRes.json() : [];

        const all = [].concat(openPRs, closedPRs)
          .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
          .slice(0, MAX_PRS);

        if (all.length === 0) {
          prContainer.innerHTML = '<div class="pr-showcase__error">No PRs found. Check back later.</div>';
          return;
        }

        prContainer.innerHTML = all.map(function (pr) {
          var state = prStateIcon(pr);
          var labels = (pr.labels || [])
            .slice(0, 3)
            .map(function (l) { return '<span class="pr-card__label" style="' + labelColor(l.color) + '">' + l.name + '</span>'; })
            .join('');
          var updatedAt = pr.merged_at || pr.closed_at || pr.updated_at;
          return '<a class="pr-card" href="' + pr.html_url + '" target="_blank" rel="noopener">' +
            '<div class="pr-card__state pr-card__state--' + state.cls + '">' + state.icon + '</div>' +
            '<div class="pr-card__body">' +
            '<div class="pr-card__title">' + pr.title + '</div>' +
            '<div class="pr-card__meta">' +
            '<span>#' + pr.number + '</span>' +
            '<span>by ' + (pr.user ? pr.user.login : 'unknown') + '</span>' +
            '<span>' + timeAgo(updatedAt) + '</span>' +
            '</div>' +
            (labels ? '<div class="pr-card__labels">' + labels + '</div>' : '') +
            '</div></a>';
        }).join('');

      } catch (err) {
        console.warn('[pr-showcase]', err);
        prContainer.innerHTML =
          '<div class="pr-showcase__error">Unable to load PRs. <a href="https://github.com/virtengine/virtengine/pulls" target="_blank" rel="noopener">View on GitHub →</a></div>';
      }
    }

    // Lazy-load PRs when section scrolls into view
    const showcaseSection = document.getElementById('showcase');
    if (showcaseSection && 'IntersectionObserver' in window) {
      const prObserver = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            fetchPRs();
            prObserver.disconnect();
          }
        },
        { threshold: 0.1 }
      );
      prObserver.observe(showcaseSection);
    } else {
      fetchPRs();
    }
  }

  /* ── Bosun Commit Feed — fetch real commits from bosun repo ──────────── */
  function fetchCommits() {
    if (!commitContainer) return;
    const COMMIT_API = 'https://api.github.com/repos/virtengine/bosun/commits?per_page=12&branch=main';
    const MAX_COMMITS = 12;

    function commitTypeIcon(msg) {
      if (/^feat/i.test(msg))    return { icon: '✦', cls: 'commit-type--feat',    label: 'feat' };
      if (/^fix/i.test(msg))     return { icon: '⬧', cls: 'commit-type--fix',     label: 'fix' };
      if (/^chore/i.test(msg))   return { icon: '○', cls: 'commit-type--chore',   label: 'chore' };
      if (/^docs/i.test(msg))    return { icon: '⬡', cls: 'commit-type--docs',    label: 'docs' };
      if (/^refactor/i.test(msg))return { icon: '⟳', cls: 'commit-type--refactor',label: 'refactor' };
      if (/^test/i.test(msg))    return { icon: '✓', cls: 'commit-type--test',    label: 'test' };
      if (/^ci/i.test(msg))      return { icon: '⚙', cls: 'commit-type--ci',      label: 'ci' };
      if (/^perf/i.test(msg))    return { icon: '▲', cls: 'commit-type--perf',    label: 'perf' };
      return { icon: '•', cls: 'commit-type--other', label: '' };
    }

    function sha7(sha) { return sha ? sha.slice(0, 7) : ''; }

    fetch(COMMIT_API, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('GitHub API rate limited');
        return res.json();
      })
      .then(function (commits) {
        if (!Array.isArray(commits) || commits.length === 0) {
          commitContainer.innerHTML = '<div class="pr-showcase__error">No commits found.</div>';
          return;
        }
        var items = commits.slice(0, MAX_COMMITS);
        commitContainer.innerHTML = items.map(function (c) {
          var msg = (c.commit && c.commit.message) ? c.commit.message : '';
          var firstLine = msg.split('\n')[0];
          var typeInfo = commitTypeIcon(firstLine);
          var author = (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || 'unknown';
          var authorUrl = c.author ? c.author.html_url : null;
          var avatarUrl = c.author ? c.author.avatar_url : null;
          var date = c.commit && c.commit.author ? c.commit.author.date : null;
          var commitUrl = c.html_url || '#';
          var sha = sha7(c.sha);
          var ago = date ? timeAgo(date) : '';
          return '<a class="pr-card commit-card" href="' + commitUrl + '" target="_blank" rel="noopener">' +
            '<div class="pr-card__state commit-type ' + typeInfo.cls + '">' + typeInfo.icon + '</div>' +
            '<div class="pr-card__body">' +
            '<div class="pr-card__title">' + escHtml(firstLine) + '</div>' +
            '<div class="pr-card__meta">' +
            '<code class="commit-sha">' + sha + '</code>' +
            (avatarUrl ? '<img class="commit-avatar" src="' + avatarUrl + '" alt="' + escHtml(author) + '" loading="lazy" width="16" height="16">' : '') +
            '<span>' + escHtml(author) + '</span>' +
            '<span>' + ago + '</span>' +
            (typeInfo.label ? '<span class="commit-label commit-label--' + typeInfo.label + '">' + typeInfo.label + '</span>' : '') +
            '</div>' +
            '</div></a>';
        }).join('');
      })
      .catch(function (err) {
        console.warn('[commit-showcase]', err);
        commitContainer.innerHTML =
          '<div class="pr-showcase__error">Unable to load commits. <a href="https://github.com/virtengine/bosun/commits/main" target="_blank" rel="noopener">View on GitHub →</a></div>';
      });
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
