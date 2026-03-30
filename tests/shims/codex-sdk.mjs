export class Codex {
  startThread() {
    throw new Error("Codex SDK shim invoked without a test mock");
  }

  resumeThread() {
    throw new Error("Codex SDK shim invoked without a test mock");
  }
}

export default {
  Codex,
};