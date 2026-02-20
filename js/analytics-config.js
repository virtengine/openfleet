/* Bosun site analytics configuration.
 * Recommended: Umami (open source, self-hostable).
 * Leave values empty to disable analytics.
 */
window.BOSUN_ANALYTICS_CONFIG = {
  provider: 'umami',
  umami: {
    scriptUrl: '',
    websiteId: '',
    domains: '',
  },
  plausible: {
    scriptUrl: 'https://plausible.io/js/script.js',
    domain: '',
  },
  ga4: {
    measurementId: '',
  },
};
