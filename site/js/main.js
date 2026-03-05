/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Landing Page — Main JavaScript
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const track = typeof window !== 'undefined' && typeof window.bosunTrack === 'function'
    ? window.bosunTrack
    : function () {};

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
      toggle.textContent = links.classList.contains('nav__links--open') ? '✕' : ':menu:';
    });
    // Close on link click
    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        links.classList.remove('nav__links--open');
        toggle.textContent = ':menu:';
      });
    });
  }

  /* ── Navigation click tracking ─────────────────────────────────────── */
  const navTrackLinks = document.querySelectorAll('.nav__links a');
  navTrackLinks.forEach((link) => {
    link.addEventListener('click', () => {
      track('nav_click', {
        label: link.textContent.trim(),
        href: link.getAttribute('href') || '',
      });
    });
  });

  /* ── Hero Typing Effect ──────────────────────────────────────────────── */
  const typedEl = document.getElementById('hero-typed');
  const cursorEl = document.getElementById('typed-cursor');
  if (typedEl) {
    const phrases = [
      'planning',
      'coding',
      'reviewing',
      'recovering',
      'shipping',
    ];
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;
    let pauseUntil = 0;
    const pauseDurationMs = 10000;

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

      var speed = deleting ? 70 + Math.random() * 40 : 95 + Math.random() * 50;
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
        track('install_copy', { command: text });
      });
    });
  });

  /* ── CTA click tracking ────────────────────────────────────────────── */
  function resolveCtaLocation(link) {
    if (link.closest('.cta-section')) return 'cta_section';
    if (link.closest('.hero__install')) return 'hero_install';
    if (link.closest('.nav')) return 'nav';
    if (link.closest('.footer')) return 'footer';
    return 'site';
  }

  const ctaSelectors = [
    '.hero__install a',
    '.cta-section .btn',
    '.footer__links a',
    '.footer__left a',
    '.nav__cta',
  ];
  document.querySelectorAll(ctaSelectors.join(', ')).forEach((link) => {
    link.addEventListener('click', () => {
      track('cta_click', {
        label: link.textContent.trim(),
        href: link.getAttribute('href') || '',
        location: resolveCtaLocation(link),
      });
    });
  });

  /* ── Inject package version in hero tag and footer ───────────────────── */
  const versionTargets = document.querySelectorAll('[data-version]');
  if (versionTargets.length > 0) {
    const sources = [
      'https://registry.npmjs.org/bosun/latest',
      'https://raw.githubusercontent.com/virtengine/bosun/main/package.json',
    ];
      
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

  /* ── Terminal initialization (lazy, on tab click only) ─────────────── */
  var termInit = false;
  function lazyInitTerminal() {
    var terminalBody = document.querySelector('.terminal-window__body');
    if (terminalBody && !termInit && typeof $ !== 'undefined' && $.fn.terminal && typeof window.initBosunTerminal === 'function') {
      termInit = true;
      window.initBosunTerminal('.terminal-window__body', {
        autoDemo: true,
        greeting: true,
      });
    }
  }

  /* ── MiniApp fullscreen toggle ───────────────────────────────────────── */
  const miniappOverlay = document.querySelector('.miniapp-demo-window__overlay');
  const fullscreenControllers = [];

  const updateFullscreenOverlay = () => {
    const anyFullscreen = fullscreenControllers.some(({ target }) =>
      target.classList.contains('is-fullscreen'),
    ) || document.fullscreenElement;
    if (miniappOverlay) miniappOverlay.classList.toggle('is-visible', Boolean(anyFullscreen));
    document.body.classList.toggle('is-miniapp-fullscreen', Boolean(anyFullscreen));
  };

  const setupFullscreenToggle = (button, target, label) => {
    if (!button || !target) return;
    let lastFullscreenState = null;

    const setFullscreen = (enabled) => {
      target.classList.toggle('is-fullscreen', enabled);
      button.classList.toggle('is-fullscreen', enabled);
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.setAttribute('aria-label', enabled ? 'Exit fullscreen' : 'Enter fullscreen');
      updateFullscreenOverlay();
      if (enabled !== lastFullscreenState) {
        track('miniapp_fullscreen', { enabled: enabled ? 'true' : 'false', target: label });
        lastFullscreenState = enabled;
      }
    };

    const toggle = () => {
      const wantsFullscreen = !target.classList.contains('is-fullscreen');
      if (wantsFullscreen && document.fullscreenEnabled && target.requestFullscreen) {
        target.requestFullscreen().catch(() => setFullscreen(true));
        return;
      }
      if (!wantsFullscreen && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => setFullscreen(false));
        return;
      }
      setFullscreen(wantsFullscreen);
    };

    button.addEventListener('click', toggle);
    document.addEventListener('fullscreenchange', () => {
      const isFs = document.fullscreenElement === target;
      if (isFs || target.classList.contains('is-fullscreen')) {
        setFullscreen(isFs);
      }
    });

    fullscreenControllers.push({ target, setFullscreen });
  };

  setupFullscreenToggle(
    document.querySelector('.miniapp-demo-window__expand'),
    document.querySelector('.miniapp-demo-window__phone'),
    'mobile',
  );
  setupFullscreenToggle(
    document.querySelector('.desktop-demo-window__expand'),
    document.querySelector('.desktop-demo-window'),
    'desktop',
  );

  if (miniappOverlay) {
    miniappOverlay.addEventListener('click', () => {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      fullscreenControllers.forEach(({ target, setFullscreen }) => {
        if (target.classList.contains('is-fullscreen')) {
          setFullscreen(false);
        }
      });
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      fullscreenControllers.forEach(({ target, setFullscreen }) => {
        if (target.classList.contains('is-fullscreen')) {
          setFullscreen(false);
        }
      });
    }
  });

  /* ── Demo Tab Switching ──────────────────────────────────────────────── */
  var demoTabs = document.querySelectorAll('.demo-tab');
  var demoPanels = document.querySelectorAll('.demo-panel');
  var tgChatInitialized = false;
  var securityInitialized = false;

  function activateDemoTab(target) {
    demoTabs.forEach(function (t) { t.classList.remove('demo-tab--active'); });
    demoPanels.forEach(function (p) { p.classList.remove('demo-panel--active'); });

    var matchingTab = document.querySelector('.demo-tab[data-demo="' + target + '"]');
    if (matchingTab) matchingTab.classList.add('demo-tab--active');

    var panel = document.getElementById('demo-panel-' + target);
    if (panel) panel.classList.add('demo-panel--active');

    track('demo_tab', { tab: target });

    // Lazy-init CLI terminal on first reveal
    if (target === 'cli') {
      lazyInitTerminal();
    }

    // Lazy-init Telegram chat on first reveal
    if (target === 'telegram' && !tgChatInitialized && typeof window.initTelegramChatDemo === 'function') {
      tgChatInitialized = true;
      window.initTelegramChatDemo('#telegram-chat-container');
    }
  }

  demoTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activateDemoTab(tab.dataset.demo);
    });
  });

  /* ── Viewport-based default demo tab ─────────────────────────────────── */
  if (demoTabs.length) {
    var isMobile = window.innerWidth < 768;
    var defaultTab = isMobile ? 'mobile' : 'desktop';
    activateDemoTab(defaultTab);
  }

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
    var searchTimer = null;
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

      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (query) {
          track('docs_search', { length: query.length });
        }
      }, 600);
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

  const FEED_META = {
    commits: {
      href: 'https://github.com/virtengine/bosun/commits/main',
      cta: 'View All Commits on GitHub →',
    },
    prs: {
      href: 'https://github.com/virtengine/virtengine/pulls?q=is%3Apr+sort%3Aupdated-desc',
      cta: 'View VirtEngine PRs on GitHub →',
    },
  };

  const loadedFeeds = { commits: false, prs: false };
  var loadPRs = function () {};

  function updateShowcaseLink(feed) {
    if (!showcaseGhLink) return;
    var meta = FEED_META[feed] || FEED_META.commits;
    showcaseGhLink.href = meta.href;
    showcaseGhLink.textContent = meta.cta;
  }

  function setActiveShowcaseFeed(feed) {
    showcaseTabs.forEach(function (t) {
      t.classList.toggle('showcase-tab--active', t.dataset.feed === feed);
    });
    showcaseFeeds.forEach(function (p) {
      p.classList.toggle('showcase-feed--active', p.dataset.feedPanel === feed);
    });
    updateShowcaseLink(feed);
  }

  // Tab switching
  showcaseTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var feed = tab.dataset.feed;
      setActiveShowcaseFeed(feed);

      if (feed === 'commits' && !loadedFeeds.commits) {
        loadedFeeds.commits = true;
        fetchCommits();
      }

      if (feed === 'prs' && !loadedFeeds.prs) {
        loadedFeeds.prs = true;
        loadPRs();
      }
    });
  });

  var activeShowcaseTab = document.querySelector('.showcase-tab--active');
  if (activeShowcaseTab) {
    setActiveShowcaseFeed(activeShowcaseTab.dataset.feed || 'commits');
  } else {
    setActiveShowcaseFeed('commits');
  }

  if (prContainer) {
    const API = 'https://api.github.com/repos/virtengine/virtengine/pulls';
    const MAX_PRS = 8;

    function labelColor(color) {
      return 'background: #' + color + '22; color: #' + color + '; border-color: #' + color + '44;';
    }

    function prStateIcon(pr) {
      if (pr.merged_at) return { cls: 'merged', icon: '⇄' };
      if (pr.state === 'closed') return { cls: 'closed', icon: '✕' };
      return { cls: 'open', icon: ':upload:' };
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

    loadPRs = fetchPRs;
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
      if (/^ci/i.test(msg))      return { icon: ':settings:', cls: 'commit-type--ci',      label: 'ci' };
      if (/^perf/i.test(msg))    return { icon: '▲', cls: 'commit-type--perf',    label: 'perf' };
      return { icon: '•', cls: 'commit-type--other', label: '' };
    }

    function sha7(sha) { return sha ? sha.slice(0, 7) : ''; }

    function normalizeAuthorName(commit) {
      var candidates = [
        commit && commit.author ? commit.author.login : '',
        commit && commit.committer ? commit.committer.login : '',
        commit && commit.commit && commit.commit.author ? commit.commit.author.name : '',
        commit && commit.commit && commit.commit.committer ? commit.commit.committer.name : '',
      ].filter(Boolean);

      var bosunBotMatch = candidates.some(function (value) {
        var normalized = String(value).toLowerCase().replace(/\s+/g, '').replace(/_/g, '-');
        return normalized === 'bosun-ve[bot]' || normalized === 'bosun-ve' || normalized === 'bosun[ve]' || normalized.indexOf('bosun-ve') !== -1;
      });

      if (bosunBotMatch) return 'bosun-ve[bot]';
      return candidates[0] || 'unknown';
    }

    function hasBosunCoAuthor(commit) {
      var msg = (commit && commit.commit && commit.commit.message) ? commit.commit.message : '';
      // Look for Co-Authored-By trailers referencing bosun-agent or bosun-ve
      return /co-authored-by:[^\n]*bosun/i.test(msg);
    }

    function resolveAuthorActor(commit) {
      if (commit && commit.author) return commit.author;
      if (commit && commit.committer) return commit.committer;
      return null;
    }

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
          var author = normalizeAuthorName(c);
          var authorActor = resolveAuthorActor(c);
          var authorUrl = authorActor ? authorActor.html_url : null;
          var avatarUrl = authorActor ? authorActor.avatar_url : null;
          var date = c.commit && c.commit.author ? c.commit.author.date : null;
          var commitUrl = c.html_url || '#';
          var sha = sha7(c.sha);
          var ago = date ? timeAgo(date) : '';
          var bosunCoAuthor = hasBosunCoAuthor(c);
          return '<a class="pr-card commit-card' + (bosunCoAuthor ? ' commit-card--coauthored' : '') + '" href="' + commitUrl + '" target="_blank" rel="noopener">' +
            '<div class="pr-card__state commit-type ' + typeInfo.cls + '">' + typeInfo.icon + '</div>' +
            '<div class="pr-card__body">' +
            '<div class="pr-card__title">' + escHtml(firstLine) + '</div>' +
            '<div class="pr-card__meta">' +
            '<code class="commit-sha">' + sha + '</code>' +
            (avatarUrl ? '<img class="commit-avatar" src="' + avatarUrl + '" alt="' + escHtml(author) + '" loading="lazy" width="16" height="16">' : '') +
            '<span>' + escHtml(author) + '</span>' +
            '<span>' + ago + '</span>' +
            (bosunCoAuthor ? '<span class="commit-coauthor-badge" title="Co-authored by bosun-agent">✦ bosun</span>' : '') +
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

  if (commitContainer && !loadedFeeds.commits) {
    loadedFeeds.commits = true;
    fetchCommits();
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Fetch Latest Version ────────────────────────────────────────────── */
  function fetchLatestVersion() {
    const versionEl = document.getElementById('current-version');
    if (!versionEl) return;
    
    fetch('https://registry.npmjs.org/bosun/latest')
      .then(res => res.json())
      .then(data => {
        if (data && data.version) {
          versionEl.textContent = 'Current Version: v' + data.version;
        }
      })
      .catch(err => console.warn('[version-fetch]', err));
  }
  
  fetchLatestVersion();
})();
