/* Bosun site analytics configuration.
 * Recommended: Umami (open source, self-hostable).
 * Leave values empty to disable analytics.
 */
window.BOSUN_ANALYTICS_CONFIG = {
  provider: 'umami',
  umami: {
    scriptUrl: 'https://cloud.umami.is/script.js',
    websiteId: '627ec37e-1fd6-4384-b6df-a144783baf2b',
    domains: 'bosun.virtengine.com',
  },
  plausible: {
    scriptUrl: 'https://plausible.io/js/script.js',
    domain: '',
  },
  ga4: {
    measurementId: '',
  },
};