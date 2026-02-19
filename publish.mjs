#!/usr/bin/env node
//
// Usage:
//   node publish.mjs                  # publish at current version (prompts login if no token)
//   node publish.mjs --bump minor      # 0.25.0 → 0.25.1  (patch digit)
//   node publish.mjs --bump major      # 0.25.0 → 0.26.0  (minor digit)
//   node publish.mjs --bump minor --dry-run
//
// To set an automation token (Linux/macOS bash — NOT setx/PowerShell):
//   export NPM_ACCESS_TOKEN=npm_xxxx && node publish.mjs --bump minor
//   # or inline:
//   NPM_ACCESS_TOKEN=npm_xxxx npm run publish:minor
//
// Terminology matches the openfleet convention (not semver):
//   minor = last digit (semver patch)
//   major = middle digit (semver minor)

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

function hasArg(flag) {
  return process.argv.includes(flag);
}

function getRegistryUrl() {
  const raw =
    process.env.NPM_REGISTRY_URL ||
    process.env.npm_config_registry ||
    "https://registry.npmjs.org/";
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function createEphemeralNpmrc(registryUrl, token) {
  const folder = mkdtempSync(join(tmpdir(), "openfleet-npmrc-"));
  const npmrcPath = join(folder, ".npmrc");
  const parsed = new URL(registryUrl);
  const authPath = parsed.pathname || "/";
  const authLine = `//${parsed.host}${authPath}:_authToken=${token}`;
  const content = [
    `registry=${registryUrl}`,
    "always-auth=true",
    authLine,
  ].join("\n");
  writeFileSync(npmrcPath, `${content}\n`, "utf8");
  return { folder, npmrcPath };
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: SCRIPT_DIR,
    env,
    shell: true,
  });
  if (result.error) {
    console.error(`[publish] Failed to execute ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function runCheck(label, command, args, env) {
  console.log(`[publish] Running ${label}...`);
  const status = run(command, args, env);
  if (status !== 0) {
    console.error(`[publish] ${label} failed (exit ${status}). Aborting publish.`);
  }
  return status;
}

const NPM_BIN = "npm";

/**
 * Bump the version in package.json and sync package-lock.json.
 * type: "minor" → patch digit (0.25.0 → 0.25.1)
 *       "major" → middle digit (0.25.0 → 0.26.0)
 * Returns the new version string.
 */
function bumpVersion(type, dryRun) {
  const pkgPath = resolve(SCRIPT_DIR, "package.json");
  const lockPath = resolve(SCRIPT_DIR, "package-lock.json");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const [maj, mid, pat] = pkg.version.split(".").map(Number);

  let newVersion;
  if (type === "minor") {
    // minor = patch digit (last number)
    newVersion = `${maj}.${mid}.${pat + 1}`;
  } else if (type === "major") {
    // major = middle digit, reset patch
    newVersion = `${maj}.${mid + 1}.0`;
  } else {
    console.error(
      `[publish] Unknown bump type "${type}". Use "minor" (0.25.0→0.25.1) or "major" (0.25.0→0.26.0).`,
    );
    process.exit(1);
  }

  console.log(`[publish] Bumping version: ${pkg.version} → ${newVersion}`);

  if (!dryRun) {
    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

    // Update package-lock.json in-place
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = newVersion;
      if (lock.packages?.[""] != null) {
        lock.packages[""].version = newVersion;
      }
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
      console.log(
        `[publish] package.json + package-lock.json updated to ${newVersion}`,
      );
    } catch {
      console.warn(
        "[publish] Could not update package-lock.json — regenerating...",
      );
      spawnSync(NPM_BIN, ["install", "--package-lock-only", "--ignore-scripts"], {
        stdio: "inherit",
        cwd: SCRIPT_DIR,
        shell: true,
      });
    }
  } else {
    console.log(
      `[publish] dry-run: would write version ${newVersion} to package.json & package-lock.json`,
    );
  }

  return newVersion;
}

function getBumpArg() {
  const idx = process.argv.indexOf("--bump");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const flag = process.argv.find((a) => a.startsWith("--bump="));
  if (flag) return flag.slice(7);
  return null;
}

function main() {
  const bumpType = getBumpArg();
  const dryRun = hasArg("--dry-run");
  if (bumpType) bumpVersion(bumpType, dryRun);

  const tag = process.env.NPM_PUBLISH_TAG || "latest";
  const otp = process.env.NPM_OTP || "";
  const access = process.env.NPM_PUBLISH_ACCESS || "public";
  const registry = getRegistryUrl();
  const token = process.env.NPM_ACCESS_TOKEN || process.env.NODE_AUTH_TOKEN || "";

  if (!dryRun && !token) {
    console.log(
      "[publish] No NPM_ACCESS_TOKEN found — npm will prompt for login.",
    );
  } else if (!dryRun && token) {
    console.log("[publish] Token found — using NPM_ACCESS_TOKEN for auth.");
  }

  console.log(
    `[publish] Running validation gates (${dryRun ? "dry-run" : "publish"})...`,
  );
  const prepushStatus = runCheck(
    "pre-push checks",
    NPM_BIN,
    ["run", "prepush:check"],
    process.env,
  );
  if (prepushStatus !== 0) {
    process.exit(prepushStatus);
  }

  const prepublishStatus = runCheck(
    "prepublish checks",
    NPM_BIN,
    ["run", "prepublishOnly"],
    process.env,
  );
  if (prepublishStatus !== 0) {
    process.exit(prepublishStatus);
  }

  let tempConfig = null;
  try {
    const env = { ...process.env };
    if (!dryRun && token) {
      tempConfig = createEphemeralNpmrc(registry, token);
      env.NPM_CONFIG_USERCONFIG = tempConfig.npmrcPath;
      env.NODE_AUTH_TOKEN = token;
    }

    const publishArgs = [
      "publish",
      "--registry",
      registry,
      "--access",
      access,
      "--tag",
      tag,
    ];

    if (dryRun) {
      publishArgs.push("--dry-run");
    }
    if (otp) {
      publishArgs.push("--otp", otp);
    }

    console.log(
      `[publish] npm ${publishArgs.join(" ")} (token via env/userconfig, redacted)`,
    );
    const status = run(NPM_BIN, publishArgs, env);
    if (status === 0 && !dryRun) {
      console.log(
        "\n[publish] REMINDER: deprecate the legacy npm package to redirect users:\n" +
        "  npm deprecate openfleet@'*' \"Renamed to @virtengine/openfleet. Install: npm install -g @virtengine/openfleet\"\n" +
        "  # If a scoped legacy package exists:\n" +
        "  npm deprecate @virtengine/openfleet@'*' \"Renamed to @virtengine/openfleet. Install: npm install -g @virtengine/openfleet\"\n",
      );
    }
    process.exit(status);
  } finally {
    if (tempConfig?.folder) {
      rmSync(tempConfig.folder, { recursive: true, force: true });
    }
  }
}

main();
