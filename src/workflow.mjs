import { performance } from "node:perf_hooks";

import { approvalRecordsFor, citedNotesFor, finishAudit, positiveChanges, prepareCase, validateMatches } from "./domain.mjs";

const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");
const round = (value) => Math.round(value * 100) / 100;

export async function auditCase(input, provider, strategy = "multi") {
  const started = performance.now();
  const caseData = prepareCase(input);
  const trace = [];
  const items = { estimate: caseData.estimate, invoice: caseData.invoice };
  const usage = { input: 0, output: 0 };
  let modelCalls = 0;

  async function run(task, agent, title, inputs, describe) {
    const stepStarted = performance.now();
    const result = await provider.run(task, inputs);
    if (provider.mode === "openai") modelCalls++;
    usage.input += result.usage?.input ?? 0;
    usage.output += result.usage?.output ?? 0;
    trace.push({
      agent, title, detail: describe(result.data), elapsedMs: round(performance.now() - stepStarted), usage: result.usage,
    });
    return result.data;
  }

  let checked;
  let grants;
  if (strategy === "single") {
    const proposals = await run("single", "Single auditor", "Read, match and review in one pass", {
      ...caseData.docs, items, notes: caseData.notes, approvals: caseData.approvals,
      approvalSource: caseData.docs.approvals,
    }, () => "Received extraction, matching and approval proposals together.");
    const notes = citedNotesFor(caseData, proposals.notes, caseData.invoice.map((line) => line.id));
    checked = validateMatches(caseData, proposals.reading, proposals.matching, notes);
    grants = proposals.approval;
  } else {
    const reading = await run("read", "Document reader", "Identify invoice and estimate lines", {
      estimate: caseData.docs.estimate, invoice: caseData.docs.invoice, items,
    }, (proposal) => "Proposed " + plural(proposal.estimateIds?.length ?? 0, "estimate line")
      + " and " + plural(proposal.invoiceIds?.length ?? 0, "invoice line") + ".");
    const confirmedItems = {
      estimate: caseData.estimate.filter((item) => reading.estimateIds?.includes(item.id)),
      invoice: caseData.invoice.filter((item) => reading.invoiceIds?.includes(item.id)),
    };
    const plan = (verifiedNotes) => ({
      ...confirmedItems,
      verifiedNotes,
      pendingNoteIds: [...new Set(caseData.notes
        .filter((note) => !verifiedNotes.some((known) => known.id === note.id))
        .map((note) => note.invoiceId))],
    });
    const proposal = await run("match", "Invoice auditor", "Match invoice items to the estimate", plan([]),
      (result) => "Proposed " + plural(result.matches?.length ?? 0, "line decision") + " for verification.");
    checked = validateMatches(caseData, reading, proposal, []);
    const targetIds = checked.rows.filter((row) => row.kind === "review").map((row) => row.invoiceId);
    if (targetIds.length) {
      const pending = await run("reread", "Document reader", "Recheck ambiguous lines", {
        targetIds, notes: caseData.notes.filter((note) => targetIds.includes(note.invoiceId)),
        source: caseData.docs.invoice,
      }, (result) => "Rechecked " + targetIds.join(", ") + " and found "
        + plural(result.noteIds?.length ?? 0, "cited cross-reference") + ".");
      const notes = citedNotesFor(caseData, pending, targetIds);
      if (notes.length) {
        const updated = await run("match", "Invoice auditor", "Reconcile with the new evidence", plan(notes),
          () => "Rechecked the proposed matches using " + notes.map((note) => note.id).join(", ") + ".");
        checked = validateMatches(caseData, reading, updated, notes);
      }
    }

    const changes = positiveChanges(checked.rows);
    if (changes.length) {
      const references = new Set(changes.map((row) => row.ref).filter(Boolean));
      const records = approvalRecordsFor(caseData.approvals, references);
      grants = await run("approve", "Approval reviewer", "Review additional amounts", { changes, records },
        (result) => "Checked " + plural(changes.length, "increase") + " against " + plural(records.length, "record")
          + " and proposed " + plural(result.grants?.length ?? 0, "grant") + ".");
    } else {
      trace.push({
        agent: "Approval reviewer", title: "No verified increases to check",
        detail: "The reviewer runs when a matched item costs more or an additional item is identified.",
        elapsedMs: null, usage: null,
      });
    }
  }

  const result = finishAudit(caseData, checked, grants);
  return {
    title: caseData.title, strategy, mode: provider.mode, model: provider.model,
    ...result, trace,
    metrics: {
      elapsedMs: round(performance.now() - started), modelCalls,
      tokens: provider.mode === "openai" ? usage : null,
    },
  };
}
