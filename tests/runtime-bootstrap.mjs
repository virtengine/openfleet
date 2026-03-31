import { _resetSingleton } from "../infra/session-tracker.mjs";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import { installTestRuntimeGuards } from "../infra/test-runtime-guards.mjs";
import { _resetRuntimeAccumulatorForTests } from "../infra/runtime-accumulator.mjs";

export function bootstrapTestRuntime() {
  const sandbox = ensureTestRuntimeSandbox({ force: true });
  installTestRuntimeGuards();
  _resetSingleton({ persistDir: null });
  // Redirect the session accumulator to the test sandbox so tests never
  // write synthetic sessions into the real workspace .cache directory.
  // Store the sandbox cacheDir in an env var so that any bare
  // _resetRuntimeAccumulatorForTests() call (without args) also lands in
  // the sandbox rather than the real .cache folder.
  if (sandbox?.cacheDir) {
    process.env.BOSUN_TEST_CACHE_DIR = sandbox.cacheDir;
    _resetRuntimeAccumulatorForTests({ cacheDir: sandbox.cacheDir });
  }
}

bootstrapTestRuntime();
