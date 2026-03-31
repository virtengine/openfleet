import { _resetSingleton } from "../infra/session-tracker.mjs";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import { installTestRuntimeGuards } from "../infra/test-runtime-guards.mjs";

export function bootstrapTestRuntime() {
  ensureTestRuntimeSandbox({ force: true });
  installTestRuntimeGuards();
  _resetSingleton({ persistDir: null });
}

bootstrapTestRuntime();
