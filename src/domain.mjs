const itemPattern = /^ITEM\s*\|\s*(?:REF:\s*([A-Z0-9-]+)\s*\|\s*)?([^|]+?)\s*\|\s*(.+)$/i;
const notePattern = /^NOTE\s*\|\s*(I[1-9][0-9]*)\s*\|\s*REF:\s*([A-Z0-9-]+)$/i;
const approvalPattern = /^(APPROVED|PENDING|REVOKED|DENIED)\s*\|\s*([A-Z0-9-]+)\s*\|\s*REF:\s*([A-Z0-9-]+)(?:\s*\|\s*(.+))?$/i;

export class InputError extends Error {}

export function parseEuro(value) {
  const amount = value.trim().match(/^(?:EUR\s*|€\s*)(\d{1,7}|\d{1,3}(?:,\d{3}){1,2})\.(\d{2})$/i);
  const german = amount ? null : value.trim().match(/^(?:EUR\s*|€\s*)(\d{1,7}|\d{1,3}(?:\.\d{3}){1,2}),(\d{2})$/i);
  if (amount) return Number(amount[1].replaceAll(",", "")) * 100 + Number(amount[2]);
  if (german) return Number(german[1].replaceAll(".", "")) * 100 + Number(german[2]);
  return null;
}

export function numbered(text, prefix) {
  return text.split(/\r\n|\n|\r/).map((value, index) => ({
    id: prefix + (index + 1), line: index + 1, text: value.trim(),
  })).filter((line) => line.text);
}

function extractItems(lines, issues) {
  const items = [];
  for (const source of lines) {
    if (!/^ITEM\b/i.test(source.text)) {
      if (/(?:€|\bEUR\s*\d)/i.test(source.text) && !/^TOTAL\b/i.test(source.text)) {
        issues.push("A monetary line on " + source.id + " is missing its ITEM label.");
      }
      continue;
    }
    const match = source.text.match(itemPattern);
    const amountCents = match ? parseEuro(match[3]) : null;
    if (!match || !match[2].trim() || amountCents === null) {
      issues.push("Invalid item format on " + source.id + ".");
      continue;
    }
    items.push({
      id: source.id, ref: match[1]?.toUpperCase() ?? null, label: match[2].trim(), amountCents, source,
    });
  }
  return items;
}

function extractNotes(lines, issues) {
  return lines.filter((source) => /^NOTE\b/i.test(source.text)).flatMap((source) => {
    const match = source.text.match(notePattern);
    if (!match) {
      issues.push("Invalid cross-reference note on " + source.id + ".");
      return [];
    }
    return [{ id: source.id, invoiceId: match[1].toUpperCase(), ref: match[2].toUpperCase(), source }];
  });
}

function extractApprovals(lines, issues) {
  return lines.flatMap((source) => {
    const match = source.text.match(approvalPattern);
    const amountCents = match?.[4] ? parseEuro(match[4]) : null;
    if (!match || (match[4] && amountCents === null) || (match[1].toUpperCase() === "APPROVED" && !amountCents)) {
      issues.push("Invalid approval record on " + source.id + ".");
      return [];
    }
    return [{
      id: source.id, status: match[1].toUpperCase(), approvalId: match[2].toUpperCase(),
      ref: match[3].toUpperCase(), amountCents, source,
    }];
  });
}

export function prepareCase(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new InputError("Send a case object.");
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 100) : "Untitled repair case";
  for (const key of ["estimate", "invoice", "approvals"]) {
    if (typeof input[key] !== "string" || input[key].length > 6500) {
      throw new InputError(key + " must be text with at most 6,500 characters.");
    }
  }
  const docs = {
    estimate: numbered(input.estimate, "E"),
    invoice: numbered(input.invoice, "I"),
    approvals: numbered(input.approvals, "A"),
  };
  if (Object.values(docs).some((lines) => lines.length > 40 || lines.some((line) => line.text.length > 450))) {
    throw new InputError("Use at most 40 lines per document and 450 characters per line.");
  }
  const issues = [];
  const estimate = extractItems(docs.estimate, issues);
  const invoice = extractItems(docs.invoice, issues);
  if (!estimate.length) issues.push("The estimate has no readable ITEM lines.");
  if (!invoice.length) issues.push("The invoice has no readable ITEM lines.");
  const notes = extractNotes(docs.invoice, issues);
  for (const note of notes) {
    if (!invoice.some((item) => item.id === note.invoiceId)) issues.push(note.id + " points to an unknown invoice line.");
  }
  const approvals = extractApprovals(docs.approvals, issues);
  return { title: title || "Untitled repair case", docs, estimate, invoice, notes, approvals, issues };
}

const labelKey = (text) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function possibleMatch(invoice, estimate, knownNotes, notePending = false) {
  const citedNotes = knownNotes.filter((note) => note.invoiceId === invoice.id);
  const notedRefs = new Set(citedNotes.map((note) => note.ref));
  const [notedRef] = notedRefs;
  if (notedRefs.size > 1 || (invoice.ref && notedRef && invoice.ref !== notedRef)) {
    return { kind: "review", reason: "The source references conflict." };
  }
  if (notePending) {
    return { kind: "review", reason: "A cross-reference note needs inspection." };
  }
  const ref = invoice.ref ?? notedRef ?? null;
  const byRef = ref ? estimate.filter((item) => item.ref === ref) : [];
  const byLabel = estimate.filter((item) =>
    labelKey(item.label) === labelKey(invoice.label) && (!ref || !item.ref));
  const choices = byRef.length ? byRef : byLabel;
  if (choices.length > 1) return { kind: "review", reason: "More than one estimate line fits." };
  if (choices.length === 1) return { kind: "matched", estimateId: choices[0].id, note: citedNotes[0], ref };
  if (ref) return { kind: "additional", note: citedNotes[0], ref };
  return { kind: "review", reason: "There is no unique estimate match or item reference." };
}

export function citedNotesFor(caseData, proposal, targets) {
  if (!Array.isArray(proposal?.noteIds)) return [];
  return caseData.notes.filter((note) => proposal.noteIds.includes(note.id) && targets.includes(note.invoiceId));
}

export function validateMatches(caseData, reading, proposal, citedNotes) {
  const readEstimate = new Set(Array.isArray(reading?.estimateIds) ? reading.estimateIds : []);
  const readInvoice = new Set(Array.isArray(reading?.invoiceIds) ? reading.invoiceIds : []);
  const issues = [...caseData.issues];
  const missing = [...caseData.estimate.filter((item) => !readEstimate.has(item.id)),
    ...caseData.invoice.filter((item) => !readInvoice.has(item.id))];
  if (missing.length) issues.push("Document reader did not confirm " + missing.map((item) => item.id).join(", ") + ".");
  const matches = Array.isArray(proposal?.matches) ? proposal.matches : [];
  const rows = caseData.invoice.map((item) => {
    const suggestions = matches.filter((match) => match?.invoiceId === item.id);
    const choice = suggestions[0];
    const notePending = caseData.notes.some((note) =>
      note.invoiceId === item.id && !citedNotes.some((cited) => cited.id === note.id));
    const candidate = possibleMatch(item, caseData.estimate, citedNotes, notePending);
    const base = {
      invoiceId: item.id, label: item.label, ref: candidate.ref ?? item.ref,
      invoice: item.source, billedCents: item.amountCents,
    };
    if (candidate.kind === "review" || !readInvoice.has(item.id) || suggestions.length !== 1
      || choice.kind !== candidate.kind || (choice.estimateId ?? null) !== (candidate.estimateId ?? null)
      || (candidate.estimateId && !readEstimate.has(candidate.estimateId))) {
      return { ...base, kind: "review", reason: candidate.reason ?? "The proposed match has no verified support." };
    }
    const estimate = caseData.estimate.find((line) => line.id === candidate.estimateId);
    const deltaCents = item.amountCents - (estimate?.amountCents ?? 0);
    return {
      ...base, kind: candidate.kind, estimateId: estimate?.id ?? null,
      estimate: estimate?.source ?? null, estimatedCents: estimate?.amountCents ?? 0,
      note: candidate.note?.source ?? null, deltaCents,
    };
  });

  // Never allocate the same estimate line to multiple billed rows.
  const matchCounts = new Map();
  for (const row of rows) {
    if (row.estimateId) matchCounts.set(row.estimateId, (matchCounts.get(row.estimateId) ?? 0) + 1);
  }
  return {
    issues,
    rows: rows.map((row) => matchCounts.get(row.estimateId) > 1
      ? { ...row, kind: "review", reason: "Multiple invoice lines map to the same estimate line." }
      : row),
  };
}

export function activeApproval(records, reference) {
  if (!reference) return null;
  const approved = records.filter((record) => record.ref === reference && record.status === "APPROVED");
  const active = approved.filter((record) => records.every((other) =>
    other.approvalId !== record.approvalId ||
    (other.status === "APPROVED" && other.ref === record.ref && other.amountCents === record.amountCents)));
  const unique = new Map();
  for (const record of active) {
    if (!unique.has(record.approvalId)) unique.set(record.approvalId, record);
  }
  return unique.size === 1 ? unique.values().next().value : null;
}

export function approvalRecordsFor(records, references) {
  const approvalIds = new Set(records.filter((record) => references.has(record.ref)).map((record) => record.approvalId));
  return records.filter((record) => approvalIds.has(record.approvalId));
}

export function positiveChanges(rows) {
  return rows.filter((row) => row.kind !== "review" && row.deltaCents > 0);
}

export function finishAudit(caseData, audit, approvalProposal) {
  const increases = positiveChanges(audit.rows);
  const grants = Array.isArray(approvalProposal?.grants) ? approvalProposal.grants : [];
  const rows = audit.rows.map((row) => {
    if (row.kind === "review") return { ...row, status: "needs_match" };
    if (row.deltaCents <= 0) {
      return { ...row, approvedCents: 0, uncoveredCents: 0, status: row.deltaCents < 0 ? "reduced" : "matched" };
    }
    const approval = activeApproval(caseData.approvals, row.ref);
    const proposals = grants.filter((grant) => grant?.invoiceId === row.invoiceId);
    const refUsedOnce = increases.filter((change) => change.ref === row.ref).length === 1;
    const verified = approval && refUsedOnce && proposals.length === 1 && proposals[0].sourceId === approval.id;
    const approvedCents = verified ? Math.min(approval.amountCents, row.deltaCents) : 0;
    const uncoveredCents = row.deltaCents - approvedCents;
    const relatedEvidence = approvalRecordsFor(caseData.approvals, new Set([row.ref]))
      .filter((record) => !verified || record.id !== approval.id)
      .map((record) => ({ status: record.status, source: record.source }));
    return {
      ...row, approvedCents, uncoveredCents, approval: verified ? approval.source : null, relatedEvidence,
      status: uncoveredCents === 0 ? "approved" : "needs_approval",
    };
  });

  const sum = (items, field) => items.reduce((total, item) => total + (item[field] ?? 0), 0);
  const reviewLines = rows.filter((row) => row.status.startsWith("needs_")).length;
  const appliedEstimateIds = new Set(rows.filter((row) => row.kind !== "review").map((row) => row.estimateId));
  return {
    verdict: reviewLines || audit.issues.length ? "review" : "clear",
    estimateCents: sum(caseData.estimate, "amountCents"),
    invoiceCents: sum(caseData.invoice, "amountCents"),
    approvedCents: sum(rows, "approvedCents"),
    uncoveredCents: sum(rows, "uncoveredCents"),
    unresolvedCents: sum(rows.filter((row) => row.status === "needs_match"), "billedCents"),
    reviewLines,
    issues: audit.issues,
    missingFromInvoice: caseData.estimate.filter((row) => !appliedEstimateIds.has(row.id)),
    rows,
  };
}
