import {
  claimSharedWorkspace,
  formatSharedWorkspaceDetail,
  formatSharedWorkspaceSummary,
  loadSharedWorkspaceRegistry,
  releaseSharedWorkspace,
  resolveSharedWorkspace,
  sweepExpiredLeases,
} from "./shared-workspace-registry.mjs";

const args = process.argv.slice(2);
const command = (args[0] || "").toLowerCase();
const actor = process.env.USER || process.env.USERNAME || "cli";

function parseCommonFlags(tokens) {
  const parsed = {
    workspaceId: null,
    owner: null,
    ttlMinutes: null,
    note: "",
    reason: "",
    force: false,
    registryPath: null,
    auditPath: null,
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--owner") {
      parsed.owner = tokens[i + 1];
      i++;
      continue;
    }
    if (token === "--ttl") {
      parsed.ttlMinutes = Number(tokens[i + 1]);
      i++;
      continue;
    }
    if (token === "--note") {
      parsed.note = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--reason") {
      parsed.reason = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--force") {
      parsed.force = true;
      continue;
    }
    if (token === "--registry") {
      parsed.registryPath = tokens[i + 1];
      i++;
      continue;
    }
    if (token === "--audit") {
      parsed.auditPath = tokens[i + 1];
      i++;
      continue;
    }
    if (!parsed.workspaceId) {
      parsed.workspaceId = token;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(
    [
      "Shared cloud workspaces registry",
      "",
      "Usage:",
      "  node shared-workspace-cli.mjs list",
      "  node shared-workspace-cli.mjs show <workspace-id>",
      "  node shared-workspace-cli.mjs claim <workspace-id> [--owner <id>] [--ttl <minutes>] [--note <text>]",
      "  node shared-workspace-cli.mjs release <workspace-id> [--owner <id>] [--reason <text>] [--force]",
      "",
      "Flags:",
      "  --registry <path>   Override registry path",
      "  --audit <path>      Override audit log path",
      "  --ttl <minutes>     Lease TTL override",
      "  --owner <id>        Lease owner",
      "  --note <text>       Lease note (claim)",
      "  --reason <text>     Release reason",
      "  --force             Force claim/release",
    ].join("\n"),
  );
}

async function handleList(tokens) {
  const parsed = parseCommonFlags(tokens);
  const registry = await loadSharedWorkspaceRegistry({
    registryPath: parsed.registryPath,
    auditPath: parsed.auditPath,
  });
  const sweep = await sweepExpiredLeases({
    registry,
    actor,
    auditPath: parsed.auditPath,
    registryPath: parsed.registryPath,
  });
  console.log(formatSharedWorkspaceSummary(sweep.registry));
}

async function handleShow(tokens) {
  const parsed = parseCommonFlags(tokens);
  if (!parsed.workspaceId) {
    console.error("Missing workspace id.");
    return;
  }
  const registry = await loadSharedWorkspaceRegistry({
    registryPath: parsed.registryPath,
    auditPath: parsed.auditPath,
  });
  await sweepExpiredLeases({
    registry,
    actor,
    auditPath: parsed.auditPath,
    registryPath: parsed.registryPath,
  });
  const workspace = resolveSharedWorkspace(registry, parsed.workspaceId);
  console.log(formatSharedWorkspaceDetail(workspace));
}

async function handleClaim(tokens) {
  const parsed = parseCommonFlags(tokens);
  if (!parsed.workspaceId) {
    console.error("Missing workspace id.");
    return;
  }
  const result = await claimSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner: parsed.owner,
    ttlMinutes: parsed.ttlMinutes,
    note: parsed.note,
    force: parsed.force,
    registryPath: parsed.registryPath,
    auditPath: parsed.auditPath,
    actor,
  });
  if (result.error) {
    console.error(`Error: ${result.error}`);
    return;
  }
  console.log(
    `Claimed ${result.workspace.id} for ${result.lease.owner} (expires ${result.lease.lease_expires_at})`,
  );
}

async function handleRelease(tokens) {
  const parsed = parseCommonFlags(tokens);
  if (!parsed.workspaceId) {
    console.error("Missing workspace id.");
    return;
  }
  const result = await releaseSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner: parsed.owner,
    reason: parsed.reason,
    force: parsed.force,
    registryPath: parsed.registryPath,
    auditPath: parsed.auditPath,
    actor,
  });
  if (result.error) {
    console.error(`Error: ${result.error}`);
    return;
  }
  console.log(`Released ${result.workspace.id}`);
}

async function main() {
  switch (command) {
    case "list":
      await handleList(args.slice(1));
      break;
    case "show":
      await handleShow(args.slice(1));
      break;
    case "claim":
      await handleClaim(args.slice(1));
      break;
    case "release":
      await handleRelease(args.slice(1));
      break;
    case "help":
    case "-h":
    case "--help":
    case "":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

await main();
