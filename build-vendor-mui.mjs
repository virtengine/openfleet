#!/usr/bin/env node
// ── build-vendor-mui.mjs ──────────────────────────────────────────────────────
// Bundles @mui/material, @emotion/react, and @emotion/styled into single-file
// ESM vendor bundles under ui/vendor/.  React/ReactDOM are marked external so
// the browser import-map resolves them to preact-compat at runtime.
//
// Usage:  node build-vendor-mui.mjs          (one-shot, runs during postinstall)
// ──────────────────────────────────────────────────────────────────────────────
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(__dirname, "ui", "vendor");

mkdirSync(VENDOR_DIR, { recursive: true });

// Shared externals — resolved at runtime via the page import-map
const EXTERNALS = ["react", "react-dom", "react/jsx-runtime", "react-dom/client"];

const sharedOpts = {
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  external: EXTERNALS,
  // Suppress "Could not resolve …" warnings for optional/peer deps
  logLevel: "warning",
};

const entries = [
  {
    label: "@mui/material",
    outfile: resolve(VENDOR_DIR, "mui-material.js"),
    // stdin lets us control exactly what is exported
    stdin: {
      contents: `export * from "@mui/material";`,
      resolveDir: __dirname,
      loader: "js",
    },
  },
  {
    label: "@emotion/react",
    outfile: resolve(VENDOR_DIR, "emotion-react.js"),
    stdin: {
      contents: `export * from "@emotion/react";`,
      resolveDir: __dirname,
      loader: "js",
    },
  },
  {
    label: "@emotion/styled",
    outfile: resolve(VENDOR_DIR, "emotion-styled.js"),
    stdin: {
      contents: `export { default } from "@emotion/styled"; export * from "@emotion/styled";`,
      resolveDir: __dirname,
      loader: "js",
    },
  },
];

let ok = true;
for (const { label, outfile, stdin } of entries) {
  try {
    const result = await build({ ...sharedOpts, outfile, stdin });
    const warnings = result.warnings?.length || 0;
    console.log(`  ✓ ${label}  →  ${outfile}${warnings ? `  (${warnings} warnings)` : ""}`);
  } catch (err) {
    console.error(`  ✗ ${label}  →  ${err.message}`);
    ok = false;
  }
}

if (!ok) {
  console.error("\n[build-vendor-mui] Some bundles failed — portal MUI may not work.");
  process.exit(1);
}
console.log("\n[build-vendor-mui] All MUI vendor bundles ready.");
