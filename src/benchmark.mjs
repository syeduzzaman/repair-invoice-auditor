import { readFile } from "node:fs/promises";
import { auditCase } from "./workflow.mjs";

export const samples = JSON.parse(await readFile(new URL("../cases/sample-cases.json", import.meta.url), "utf8"));

export function scoreAudit(report, expected) {
  const resultMatches = new Map(report.rows.filter((row) => row.status !== "needs_match")
    .map((row) => [row.invoiceId, row.estimateId]));
  const truth = Object.entries(expected.matched);
  const matches = truth.filter(([id, target]) => resultMatches.has(id) && resultMatches.get(id) === target).length;
  return {
    correct: report.verdict === expected.verdict && report.uncoveredCents === expected.uncoveredCents
      && report.reviewLines === expected.reviewLines && matches === truth.length,
    matches,
    totalMatches: truth.length,
  };
}

export async function evaluate(provider) {
  const results = [];
  for (const sample of samples) {
    const outcomes = {};
    for (const strategy of ["multi", "single"]) {
      const report = await auditCase(sample, provider, strategy);
      outcomes[strategy] = {
        ...scoreAudit(report, sample.expected),
        verdict: report.verdict, uncoveredCents: report.uncoveredCents,
        elapsedMs: report.metrics.elapsedMs, modelCalls: report.metrics.modelCalls,
        tokens: report.metrics.tokens,
      };
    }
    results.push({ id: sample.id, title: sample.title, ...outcomes });
  }

  const metric = (strategy) => {
    const runs = results.map((row) => row[strategy]);
    const sum = (read) => runs.reduce((total, row) => total + read(row), 0);
    const timings = runs.map((row) => row.elapsedMs).sort((a, b) => a - b);
    return {
      casesPassed: runs.filter((row) => row.correct).length,
      cases: runs.length,
      lineMatches: sum((row) => row.matches),
      lines: sum((row) => row.totalMatches),
      medianMs: timings[Math.floor(timings.length / 2)],
      modelCalls: sum((row) => row.modelCalls),
      tokens: provider.mode === "demo" ? null : {
        input: sum((row) => row.tokens.input), output: sum((row) => row.tokens.output),
      },
    };
  };
  return { mode: provider.mode, model: provider.model, results, multi: metric("multi"), single: metric("single") };
}
