import { syncDemoDefaults } from "../tools/generate-demo-defaults.mjs";

export default async function vitestGlobalSetup() {
  await syncDemoDefaults({ silent: true });
}