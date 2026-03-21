import { formatPidFileSummary as formatPidFileSummaryImpl } from "./infra/maintenance.mjs";

export * from "./infra/maintenance.mjs";

export function formatPidFileSummary(parsed) {
  return formatPidFileSummaryImpl(parsed);
}
