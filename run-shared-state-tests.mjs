#!/usr/bin/env node

/**
 * Test runner for shared state tests
 * Run: node run-shared-state-tests.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tests = [
  "tests/shared-state-manager.test.mjs",
  "tests/github-shared-state.test.mjs",
  "tests/shared-state-integration.test.mjs",
];

console.log("Running shared state test suite...\n");

function runTest(testFile) {
  return new Promise((resolve, reject) => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Running: ${testFile}`);
    console.log("=".repeat(60));

    const child = spawn(
      "npx",
      ["vitest", "run", testFile, "--reporter=verbose"],
      {
        cwd: __dirname,
        stdio: "inherit",
        shell: true,
      },
    );

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ file: testFile, success: true });
      } else {
        resolve({ file: testFile, success: false, code });
      }
    });

    child.on("error", (err) => {
      reject({ file: testFile, error: err });
    });
  });
}

async function runAllTests() {
  const results = [];

  for (const testFile of tests) {
    try {
      const result = await runTest(testFile);
      results.push(result);
    } catch (error) {
      results.push(error);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.success) {
      console.log(`✓ ${result.file} - PASSED`);
      passed++;
    } else {
      console.log(
        `✗ ${result.file} - FAILED (code: ${result.code || "error"})`,
      );
      failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(
    `Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`,
  );
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
