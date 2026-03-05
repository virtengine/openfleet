#!/usr/bin/env node
// scripts/mutation-report.mjs
//
// Parses Stryker's JSON output and produces:
//   1. reports/mutation/summary.md   — GitHub-friendly markdown
//   2. reports/mutation/survivors.json — machine-readable surviving mutants
//
// Designed to run inside CI after `npx stryker run`.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Paths ───────────────────────────────────────────────────────────────────
const REPORT_DIR = join(process.cwd(), "reports", "mutation");
const JSON_REPORT = join(REPORT_DIR, "mutation-report.json");
const SUMMARY_OUT = join(REPORT_DIR, "summary.md");
const SURVIVORS_OUT = join(REPORT_DIR, "survivors.json");

// ── Mutator-specific improvement tips ───────────────────────────────────────
const MUTATOR_TIPS = {
  ConditionalExpression:
    "Assert both branches of if/else and ternaries. Add boundary-value tests.",
  EqualityOperator:
    "Test boundary values (e.g., === vs !==, < vs <=). Ensure both true/false paths are verified.",
  LogicalOperator:
    "Test combinations that exercise && vs || differences. Add tests for short-circuit evaluation.",
  ArithmeticOperator:
    "Assert on computed numeric results, not just truthiness. Check + vs - and * vs / boundaries.",
  UnaryOperator:
    "Assert sign and negation. Test with positive, negative, and zero values.",
  ArrayDeclaration:
    "Assert on array contents, not just .length. Check element order.",
  BlockStatement:
    "This mutant removed an entire block. Ensure its side-effects are tested.",
  BooleanLiteral:
    "Assert on the exact boolean value, not just truthiness/falsiness.",
  MethodExpression:
    "Assert the return value of collection methods (filter, map, etc.) — not just that they're called.",
  OptionalChaining:
    "Test with both null/undefined and valid values to ensure ?. vs . matters.",
  ObjectLiteral:
    "Assert on specific object properties, not just object existence.",
  UpdateOperator:
    "Assert exact numeric values after increment/decrement, not just direction of change.",
  Regex:
    "Add test inputs that match/fail-to-match the specific regex pattern. Test edge cases.",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function pct(n, d) {
  return d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;
}

function badge(score) {
  if (score >= 80) return "🟢";
  if (score >= 60) return "🟡";
  return "🔴";
}

function summariseMutant(m) {
  const loc = m.location
    ? `L${m.location.start.line}:${m.location.start.column}`
    : "";
  return {
    file: m.fileName ?? m.sourceFile ?? "unknown",
    mutator: m.mutatorName,
    replacement: m.replacement ?? "(removed)",
    location: loc,
    status: m.status,
    description: m.description ?? "",
  };
}

function countByStatus(mutants, status) {
  return mutants.filter((m) => m.status === status).length;
}

// ── Report section builders ─────────────────────────────────────────────────

function buildHeader(overallScore, totalMutants, totalKilled, totalSurvived, totalNoCoverage) {
  return [
    `# ${badge(overallScore)} Mutation Testing Report`,
    "",
    `**Overall mutation score: ${overallScore.toFixed(1)}%**`,
    "",
    "| Metric | Count |",
    "|--------|-------|",
    `| Total mutants | ${totalMutants} |`,
    `| Killed (detected) | ${totalKilled} (${pct(totalKilled, totalMutants)}) |`,
    `| Survived (undetected) | ${totalSurvived} (${pct(totalSurvived, totalMutants)}) |`,
    `| No coverage | ${totalNoCoverage} (${pct(totalNoCoverage, totalMutants)}) |`,
    "",
  ];
}

function buildWeakFilesSection(fileStats) {
  const weakFiles = fileStats.filter((f) => f.score < 80 && f.total > 0);
  if (weakFiles.length === 0) return [];

  const rows = weakFiles.slice(0, 30).map(
    (f) =>
      `| \`${f.file}\` | ${badge(f.score)} ${f.score.toFixed(1)}% | ${f.killed} | ${f.survived} | ${f.noCoverage} | ${f.total} |`,
  );

  const overflow =
    weakFiles.length > 30
      ? [`| ... and ${weakFiles.length - 30} more files | | | | | |`]
      : [];

  return [
    "## 🔍 Weakest Files (mutation score < 80%)",
    "",
    "| File | Score | Killed | Survived | No Coverage | Total |",
    "|------|-------|--------|----------|-------------|-------|",
    ...rows,
    ...overflow,
    "",
  ];
}

function buildSurvivorsSection(survivors) {
  if (survivors.length === 0) return [];

  const byFile = new Map();
  for (const s of survivors) {
    const key = s.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(s);
  }

  const MAX_SHOWN = 50;
  let shown = 0;
  const body = [];

  for (const [file, mutants] of byFile) {
    if (shown >= MAX_SHOWN) break;
    body.push(
      `### \`${file}\``,
      "",
      "| Location | Mutator | Replacement | Status |",
      "|----------|---------|-------------|--------|",
    );
    for (const m of mutants) {
      if (shown >= MAX_SHOWN) break;
      body.push(`| ${m.location} | ${m.mutator} | \`${m.replacement}\` | ${m.status} |`);
      shown++;
    }
    body.push("");
  }

  const overflow =
    survivors.length > MAX_SHOWN
      ? [
          `> **${survivors.length - MAX_SHOWN} more survivors** — see \`survivors.json\` artifact for full list.`,
          "",
        ]
      : [];

  return [
    "## 🧟 Surviving Mutants — Action Required",
    "",
    "Each surviving mutant represents a code change your tests *cannot detect*.",
    "Add or strengthen tests to kill these mutants.",
    "",
    ...body,
    ...overflow,
  ];
}

function buildImprovementPlan(fileStats, survivors, totalSurvived, totalNoCoverage) {
  const sections = ["## 📋 Improvement Plan", ""];

  if (totalNoCoverage > 0) {
    const noCovFiles = fileStats
      .filter((f) => f.noCoverage > 0)
      .sort((a, b) => b.noCoverage - a.noCoverage)
      .slice(0, 10);
    sections.push(
      `### 1. Add basic coverage (${totalNoCoverage} mutants have NO test coverage)`,
      "",
      ...noCovFiles.map(
        (f) => `- \`${f.file}\` — ${f.noCoverage} uncovered mutant${f.noCoverage > 1 ? "s" : ""}`,
      ),
      "",
    );
  }

  if (totalSurvived > 0) {
    const idx = totalNoCoverage > 0 ? "2" : "1";
    const mutatorCounts = new Map();
    for (const s of survivors.filter((sv) => sv.status === "Survived")) {
      mutatorCounts.set(s.mutator, (mutatorCounts.get(s.mutator) ?? 0) + 1);
    }
    const sorted = [...mutatorCounts.entries()].sort((a, b) => b[1] - a[1]);
    sections.push(
      `### ${idx}. Strengthen existing tests (${totalSurvived} mutants survive despite coverage)`,
      "",
      "Common patterns that let mutants survive:",
      "",
      ...sorted.slice(0, 10).map(([mutator, count]) => {
        const tip = MUTATOR_TIPS[mutator] ?? "Add assertions that detect this change.";
        return `- **${mutator}** (${count} survivor${count > 1 ? "s" : ""}): ${tip}`;
      }),
      "",
    );
  }

  if (totalSurvived === 0 && totalNoCoverage === 0) {
    sections.push(
      "All mutants killed — your test suite is strong for the mutated scope.",
      "Consider raising the `break` threshold to lock in this quality.",
      "",
    );
  }

  return sections;
}

// ── Parse report ────────────────────────────────────────────────────────────

function parseReport(report) {
  const files = report.files ?? {};
  const allMutants = [];
  const fileStats = [];

  for (const [fileName, fileData] of Object.entries(files)) {
    const mutants = fileData.mutants ?? [];
    const killed =
      countByStatus(mutants, "Killed") + countByStatus(mutants, "Timeout");
    const survived = countByStatus(mutants, "Survived");
    const noCoverage = countByStatus(mutants, "NoCoverage");
    const total = mutants.length;
    const score = total > 0 ? (killed / total) * 100 : 100;

    fileStats.push({ file: fileName, total, killed, survived, noCoverage, score });

    for (const m of mutants) {
      allMutants.push({ ...summariseMutant(m), fileName });
    }
  }

  fileStats.sort((a, b) => a.score - b.score);
  return { allMutants, fileStats };
}

// ── Main ────────────────────────────────────────────────────────────────────

function run() {
  if (!existsSync(JSON_REPORT)) {
    console.error(`No mutation report found at ${JSON_REPORT}`);
    console.error("Run: npx stryker run   first.");
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(JSON_REPORT, "utf-8"));
  const { allMutants, fileStats } = parseReport(report);

  const totalMutants = allMutants.length;
  const totalKilled =
    countByStatus(allMutants, "Killed") + countByStatus(allMutants, "Timeout");
  const totalSurvived = countByStatus(allMutants, "Survived");
  const totalNoCoverage = countByStatus(allMutants, "NoCoverage");
  const overallScore =
    totalMutants > 0 ? (totalKilled / totalMutants) * 100 : 100;

  const survivors = allMutants.filter(
    (m) => m.status === "Survived" || m.status === "NoCoverage",
  );

  const markdown = [
    ...buildHeader(overallScore, totalMutants, totalKilled, totalSurvived, totalNoCoverage),
    ...buildWeakFilesSection(fileStats),
    ...buildSurvivorsSection(survivors),
    ...buildImprovementPlan(fileStats, survivors, totalSurvived, totalNoCoverage),
  ].join("\n");

  mkdirSync(dirname(SUMMARY_OUT), { recursive: true });
  writeFileSync(SUMMARY_OUT, markdown, "utf-8");
  writeFileSync(SURVIVORS_OUT, JSON.stringify(survivors, null, 2), "utf-8");

  console.log(`\n✅ Mutation report written to:`);
  console.log(`   Summary:   ${SUMMARY_OUT}`);
  console.log(`   Survivors: ${SURVIVORS_OUT}`);
  console.log(
    `\n   Overall score: ${badge(overallScore)} ${overallScore.toFixed(1)}%  (${totalKilled}/${totalMutants} killed)\n`,
  );
}

run();
