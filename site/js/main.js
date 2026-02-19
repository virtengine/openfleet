/* ═══════════════════════════════════════════════════════════════════════════
   OpenFleet Landing Page — Main JavaScript
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
      'Fully autonomous.',
      'Self-healing.',
      'Zero intervention.',
      'Production ready.',
      'Always shipping.',
    ];
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;
    let pauseTimer = 0;

    function typeLoop() {
      var phrase = phrases[phraseIdx];
      if (!deleting) {
        charIdx++;
        typedEl.textContent = phrase.substring(0, charIdx);
        if (charIdx === phrase.length) {
          pauseTimer = 2200;
          deleting = true;
        }
      } else {
        if (pauseTimer > 0) {
          pauseTimer -= 60;
          requestAnimationFrame(function () { setTimeout(typeLoop, 60); });
          return;
        }
        charIdx--;
        typedEl.textContent = phrase.substring(0, charIdx);
        if (charIdx === 0) {
          deleting = false;
          phraseIdx = (phraseIdx + 1) % phrases.length;
        }
      }

      var speed = deleting ? 35 : 70 + Math.random() * 40;
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
          window.initOpenFleetTerminal('.terminal-window__body', {
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

  /* ── PR Showcase — fetch real PRs from VirtEngine repo ───────────────── */
  const prContainer = document.getElementById('pr-showcase');
  if (prContainer) {
    const API = 'https://api.github.com/repos/virtengine/virtengine/pulls';
    const MAX_PRS = 8;

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
})();
