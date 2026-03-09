const isVitest = Boolean(process.env.VITEST) || process.argv.some((arg) => String(arg).toLowerCase().includes("vitest"));

if (isVitest) {
  await import("./agent-pool.vitest-suite.mjs");
}
