const config = {
  // ── Test runner ────────────────────────────────────────────────────────────
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.mjs",
  },

  // ── Mutation scope ────────────────────────────────────────────────────────
  // Mutate production source files only (exclude tests, fixtures, vendor, CLI
  // entry-points that are just arg-parsing wrappers, and build scripts).
  mutate: [
    "*.mjs",
    "agent/**/*.mjs",
    "config/**/*.mjs",
    "git/**/*.mjs",
    "github/**/*.mjs",
    "infra/**/*.mjs",
    "kanban/**/*.mjs",
    "server/**/*.mjs",
    "shell/**/*.mjs",
    "task/**/*.mjs",
    "telegram/**/*.mjs",
    "voice/**/*.mjs",
    "workflow/**/*.mjs",
    "workspace/**/*.mjs",
    "!cli.mjs",
    "!setup.mjs",
    "!postinstall.mjs",
    "!tools/**",
    "!tests/**",
    "!bench/**",
    "!desktop/**",
    "!node_modules/**",
    "!.cache/**",
    "!stryker.config.mjs",
    "!vitest.config.mjs",
    "!scripts/**",
  ],

  // ── Mutators ──────────────────────────────────────────────────────────────
  // All built-in mutators are enabled by default. Remove specific ones here
  // if they produce too many equivalent mutants for this codebase.
  // See: https://stryker-mutator.io/docs/mutation-testing-elements/supported-mutators
  mutators: {
    excludedMutations: [
      // String literal mutations on log messages / error messages are almost
      // always equivalent — the tests don't assert on exact log text.
      "StringLiteral",
    ],
  },

  // ── Thresholds ────────────────────────────────────────────────────────────
  // high  → green in the report
  // low   → yellow in the report
  // break → CI exits non-zero if mutation score is below this
  thresholds: {
    high: 80,
    low: 60,
    break: 0, // Start with 0 so initial runs always succeed; raise over time
  },

  // ── Performance ───────────────────────────────────────────────────────────
  concurrency: 4, // parallelize mutant runs (tune to CI runner cores)
  timeoutMS: 30_000, // per-mutant test run timeout
  timeoutFactor: 2.5, // multiplier on baseline test duration

  // ── Incremental mode ──────────────────────────────────────────────────────
  // When --incremental is passed, Stryker only re-tests mutants in changed
  // files. The baseline file caches previous results.
  incremental: false, // toggled via CLI flag or workflow input
  incrementalFile: ".stryker-cache/incremental.json",

  // ── Reporters ─────────────────────────────────────────────────────────────
  reporters: [
    "html",        // visual report in reports/mutation/
    "json",        // machine-readable for the parser script
    "clear-text",  // terminal summary
    "progress",    // live progress bar
  ],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation-report.json",
  },

  // ── Misc ──────────────────────────────────────────────────────────────────
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  logLevel: "info",
};

export default config;
