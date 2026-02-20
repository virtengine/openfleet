/* ═══════════════════════════════════════════════════════════════════════════
   Bosun Landing Page — Analytics bootstrap
   Supports Umami (open source), Plausible, and GA4.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const config = window.BOSUN_ANALYTICS_CONFIG || {};
  const provider = String(config.provider || 'disabled').toLowerCase();
  const doNotTrack =
    (typeof navigator !== 'undefined' && (navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes')) ||
    (typeof window !== 'undefined' && window.doNotTrack === '1');

  const state = {
    ready: false,
    queue: [],
  };

  function track(eventName, props) {
    if (!eventName || doNotTrack) return;
    if (!state.ready) {
      state.queue.push({ eventName, props: props || {} });
      return;
    }
    dispatch(eventName, props || {});
  }

  window.bosunTrack = track;

  function dispatch(eventName, props) {
    if (provider === 'umami' && window.umami && typeof window.umami.track === 'function') {
      window.umami.track(eventName, props);
      return;
    }
    if (provider === 'plausible' && typeof window.plausible === 'function') {
      window.plausible(eventName, { props: props });
      return;
    }
    if (provider === 'ga4' && typeof window.gtag === 'function') {
      window.gtag('event', eventName, props);
    }
  }

  function flushQueue() {
    if (!state.ready || state.queue.length === 0) return;
    const queued = state.queue.slice();
    state.queue = [];
    queued.forEach((item) => dispatch(item.eventName, item.props));
  }

  function loadScript(src, attrs) {
    return new Promise((resolve, reject) => {
      if (!src) {
        reject(new Error('missing script src'));
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      if (attrs && typeof attrs === 'object') {
        Object.keys(attrs).forEach((key) => {
          if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') {
            script.setAttribute(key, String(attrs[key]));
          }
        });
      }
      script.onload = () => resolve();
      script.onerror = (err) => reject(err);
      document.head.appendChild(script);
    });
  }

  function enableUmami() {
    const umami = config.umami || {};
    if (!umami.scriptUrl || !umami.websiteId) return false;
    const attrs = {
      'data-website-id': umami.websiteId,
    };
    if (umami.domains) attrs['data-domains'] = umami.domains;

    loadScript(umami.scriptUrl, attrs)
      .then(() => {
        state.ready = true;
        flushQueue();
      })
      .catch(() => {});
    return true;
  }

  function enablePlausible() {
    const plausible = config.plausible || {};
    const scriptUrl = plausible.scriptUrl || 'https://plausible.io/js/script.js';
    if (!plausible.domain) return false;

    loadScript(scriptUrl, { 'data-domain': plausible.domain })
      .then(() => {
        state.ready = true;
        flushQueue();
      })
      .catch(() => {});
    return true;
  }

  function enableGa4() {
    const ga4 = config.ga4 || {};
    if (!ga4.measurementId) return false;

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = window.gtag || gtag;

    window.gtag('js', new Date());
    window.gtag('config', ga4.measurementId, {
      anonymize_ip: true,
      send_page_view: true,
    });

    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga4.measurementId))
      .then(() => {
        state.ready = true;
        flushQueue();
      })
      .catch(() => {});
    return true;
  }

  if (doNotTrack || provider === 'disabled') {
    return;
  }

  const enabled =
    (provider === 'umami' && enableUmami()) ||
    (provider === 'plausible' && enablePlausible()) ||
    (provider === 'ga4' && enableGa4());

  if (!enabled) {
    // No valid config provided; leave analytics disabled.
  }
})();
