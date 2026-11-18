import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { evaluate, samples } from "../src/benchmark.mjs";
import { parseEuro } from "../src/domain.mjs";
import { createDemoProvider } from "../src/providers.mjs";
import { buildServer } from "../src/server.mjs";
import { auditCase } from "../src/workflow.mjs";

const fixtures = Object.fromEntries(samples.map((sample) => [sample.id, sample]));
const demo = createDemoProvider();
const multiAudit = (sample) => auditCase(sample, demo, "multi");

test("both workflows pass all five labeled cases", async () => {
  const report = await evaluate(demo);
  for (const strategy of ["multi", "single"]) {
    assert.equal(report[strategy].casesPassed, samples.length);
    assert.equal(report[strategy].lineMatches, 11);
    assert.equal(report[strategy].modelCalls, 0);
  }
});

test("partial authorization covers only the written amount and cites the original record", async () => {
  const report = await multiAudit(fixtures.partial);
  assert.equal(report.estimateCents, 120_000);
  assert.equal(report.invoiceCents, 145_000);
  assert.equal(report.approvedCents, 15_000);
  assert.equal(report.uncoveredCents, 10_000);
  assert.equal(report.rows[2].approval.text, fixtures.partial.approvals);
  assert.equal(report.rows[2].status, "needs_approval");
});

test("the auditor sends an ambiguous line to the reader and applies the cited note once", async () => {
  const report = await multiAudit(fixtures.handoff);
  assert.equal(report.rows[0].estimateId, "E1");
  assert.equal(report.rows[0].note.id, "I3");
  const passes = report.trace.filter((step) => step.agent === "Invoice auditor");
  assert.equal(passes.length, 2);
  assert.ok(report.trace.some((step) => step.title === "Recheck ambiguous lines"));

  const invoice = fixtures.handoff.invoice.split("\n").slice(0, 2).join("\n");
  const withoutNote = await multiAudit({ ...fixtures.handoff, invoice });
  assert.equal(withoutNote.verdict, "review");
  assert.equal(withoutNote.unresolvedCents, 14_000);
  assert.equal(withoutNote.uncoveredCents, 0);
  assert.equal(withoutNote.trace.filter((step) => step.title === "Recheck ambiguous lines").length, 1);
});

test("two conflicting notes stay unresolved even if an agent cites only one", async () => {
  const provider = {
    ...demo,
    run(task, input) {
      if (task === "reread") return { data: { noteIds: ["I3"] }, usage: null };
      return demo.run(task, input);
    },
  };
  const invoice = fixtures.handoff.invoice + "\nNOTE | I1 | REF: BR-R";
  const report = await auditCase({ ...fixtures.handoff, invoice }, provider);
  assert.equal(report.verdict, "review");
  assert.equal(report.rows[0].status, "needs_match");
});

test("rejects a fabricated approval citation and a revoked approval even when the agent proposes it", async () => {
  const propose = (invoiceId, sourceId) => ({
    ...demo,
    run(task, input) {
      if (task === "approve") return { data: { grants: [{ invoiceId, sourceId }] }, usage: null };
      return demo.run(task, input);
    },
  });
  const fake = await auditCase(fixtures.partial, propose("I3", "A99"));
  const revoked = await auditCase(fixtures.revoked, propose("I2", "A1"));
  assert.equal(fake.uncoveredCents, 25_000);
  assert.equal(revoked.uncoveredCents, 20_000);
  assert.deepEqual(revoked.rows[1].relatedEvidence.map((record) => record.status), ["APPROVED", "REVOKED"]);
});

test("does not allocate the same approval across duplicate extra lines", async () => {
  const invoice = fixtures.partial.invoice + "\nITEM | REF: S01 | Sensor bracket additional charge | €50.00";
  const report = await multiAudit({ ...fixtures.partial, invoice });
  assert.equal(report.approvedCents, 0);
  assert.equal(report.uncoveredCents, 30_000);
  assert.equal(report.reviewLines, 2);
});

test("flags malformed monetary lines and never allocates a discount to an uncovered extra", async () => {
  assert.equal(parseEuro("EUR 1.200,25"), 120_025);
  assert.equal(parseEuro("€1,200.25"), 120_025);
  assert.equal(parseEuro("12.50"), null);
  const invoice = fixtures.partial.invoice.replace("€900.00", "€850.00") + "\nOther charge €500.00";
  const report = await multiAudit({ ...fixtures.partial, invoice });
  assert.equal(report.uncoveredCents, 10_000);
  assert.equal(report.verdict, "review");
  assert.match(report.issues[0], /missing its ITEM label/);
});

test("local server serves UI and demo, restricts cross-origin requests, and validates input", async (t) => {
  const server = buildServer();
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Repair Invoice Auditor/);

  const send = (body, headers = {}) => fetch(base + "/api/audit", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const request = { case: fixtures.partial, mode: "demo", strategy: "multi" };
  const result = await send(request);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).uncoveredCents, 10_000);
  assert.equal((await send(request, { Origin: "https://other.example" })).status, 403);
  assert.equal((await send({ ...request, case: {} })).status, 400);
  assert.equal((await send({ ...request, mode: "openai" })).status, 409);
});

test("OpenAI adapter sends independent role contracts and accounts for response tokens", async (t) => {
  const calls = [];
  const providerOutputs = {
    read: { estimateIds: ["E1", "E2"], invoiceIds: ["I1", "I2", "I3"] },
    match: { matches: [
      { invoiceId: "I1", kind: "matched", estimateId: "E1" },
      { invoiceId: "I2", kind: "matched", estimateId: "E2" },
      { invoiceId: "I3", kind: "additional", estimateId: null },
    ] },
    approve: { grants: [{ invoiceId: "I3", sourceId: "A1" }] },
  };
  const server = buildServer({
    key: "fake-test-key",
    model: "test-model",
    async requestOpenAI(url, options) {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, "test-model");
      assert.equal(payload.store, false);
      const role = payload.text.format.name.replace("audit_", "");
      calls.push({ role, input: JSON.parse(payload.input) });
      return new Response(JSON.stringify({ status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(providerOutputs[role]) }] }],
        usage: { input_tokens: 310, output_tokens: 57 },
      }));
    },
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/audit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ case: fixtures.partial, mode: "openai", strategy: "multi" }),
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(calls.map(({ role }) => role), ["read", "match", "approve"]);
  assert.deepEqual(Object.keys(calls[0].input), ["estimate", "invoice"]);
  assert.equal(calls[2].input.records.length, 1);
  assert.equal(report.uncoveredCents, 10_000);
  assert.deepEqual(report.metrics.tokens, { input: 930, output: 171 });
});
