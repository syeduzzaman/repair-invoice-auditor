const $ = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const euros = (cents) => cents == null ? "—" : currency.format(cents / 100);
const statusNames = {
  matched: "Matched", reduced: "Lower amount", approved: "Approved",
  needs_match: "Match needs review", needs_approval: "Approval needed",
};
let samples = [];
let selectedId;

function make(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function append(parent, ...children) {
  parent.append(...children);
  return parent;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setMessage(id, value, error = false) {
  $(id).textContent = value;
  $(id).classList.toggle("problem", error);
}

function showView(benchmark) {
  $("audit-view").hidden = benchmark;
  $("benchmark-view").hidden = !benchmark;
  $("audit-tab").setAttribute("aria-pressed", !benchmark);
  $("benchmark-tab").setAttribute("aria-pressed", benchmark);
}

function renderCases() {
  $("cases").replaceChildren(...samples.map((sample) => {
    const button = make("button", null, "case");
    button.type = "button";
    button.setAttribute("aria-pressed", sample.id === selectedId);
    button.addEventListener("click", () => loadCase(sample));
    return append(button, make("strong", sample.title), make("span", sample.vehicle));
  }));
}

function loadCase(sample) {
  selectedId = sample.id;
  $("case-title").textContent = sample.title;
  $("case-summary").textContent = sample.summary;
  $("case-name").value = sample.title;
  for (const key of ["estimate", "invoice", "approvals"]) $(key).value = sample[key];
  $("report").replaceChildren();
  setMessage("audit-message", "");
  renderCases();
}

function verifyStat(label, value, className) {
  return append(make("div", null, "stat" + (className ? " " + className : "")),
    make("p", label, "muted"), make("strong", value));
}

function sourceDetails(label, source) {
  const details = make("details", null, "source");
  return append(details, make("summary", label + " · " + source.id), make("blockquote", source.text));
}

function renderItem(row) {
  const warning = row.status.startsWith("needs_");
  const item = make("article", null, "line-item");
  const rowHeader = append(make("div", null, "row-head"),
    make("h4", row.label), make("span", statusNames[row.status], "badge" + (warning ? " amber" : "")));
  if (row.ref) rowHeader.querySelector("h4").append(make("small", row.ref, "reference"));
  item.append(rowHeader);
  const amounts = make("dl", null, "amounts");
  for (const [name, cents] of [["Estimated", row.estimatedCents], ["Billed", row.billedCents],
    ["Authorized extra", row.approvedCents], ["Uncovered extra", row.uncoveredCents]]) {
    amounts.append(append(make("div"), make("dt", name), make("dd", euros(cents))));
  }
  item.append(amounts);
  if (row.reason) item.append(make("p", row.reason, "reason"));
  const evidence = append(make("div", null, "evidence"), sourceDetails("Invoice", row.invoice));
  if (row.kind !== "review" && row.estimate) evidence.append(sourceDetails("Estimate", row.estimate));
  if (row.kind !== "review" && row.note) evidence.append(sourceDetails("Cross-reference", row.note));
  if (row.approval) evidence.append(sourceDetails("Approval", row.approval));
  for (const { status, source } of row.relatedEvidence ?? []) {
    evidence.append(sourceDetails("Related record (" + status.toLowerCase() + ")", source));
  }
  item.append(evidence);
  return item;
}

function renderReport(report) {
  const summary = make("section", null, "panel results-summary");
  const needsReview = report.verdict === "review";
  const header = append(make("div", null, "summary-head"),
    append(make("div"), make("h2", "Audit result"), make("p", report.title, "muted")),
    make("span", needsReview ? "Needs review" : "Clear on supplied records", "badge " + (needsReview ? "amber" : "green")));
  summary.append(header);
  summary.append(append(make("div", null, "stat-grid"),
    verifyStat("Approved estimate", euros(report.estimateCents)),
    verifyStat("Submitted invoice", euros(report.invoiceCents)),
    verifyStat("Authorized extra", euros(report.approvedCents)),
    verifyStat("Uncovered extra", euros(report.uncoveredCents), report.uncoveredCents ? "warn" : "")));
  if (report.unresolvedCents) {
    summary.append(make("p", euros(report.unresolvedCents)
      + " in invoice lines still needs matching. These amounts are separate from uncovered extras.", "reason"));
  }
  if (report.issues.length) {
    summary.append(append(make("ul", null, "issues"), ...report.issues.map((issue) => make("li", issue))));
  }
  const findings = append(make("section", null, "panel findings"), make("h3", "Line-by-line review"),
    ...report.rows.map(renderItem));
  if (report.missingFromInvoice.length) {
    const missing = make("details", null, "unmatched");
    missing.append(make("summary", "Estimate lines without a verified invoice match (" + report.missingFromInvoice.length + ")"));
    missing.append(...report.missingFromInvoice.map((row) => sourceDetails(row.label, row.source)));
    findings.append(missing);
  }

  const timeline = append(make("section", null, "panel timeline"),
    make("h3", report.strategy === "single" ? "Single-agent trace" : "Agent handoffs"),
    make("p", report.metrics.elapsedMs + " ms total · " + report.metrics.modelCalls + " OpenAI calls", "muted"));
  if (report.metrics.tokens) timeline.append(make("p", report.metrics.tokens.input.toLocaleString()
    + " input + " + report.metrics.tokens.output.toLocaleString() + " output tokens", "muted"));
  const steps = make("ol");
  for (const step of report.trace) {
    const item = make("li");
    if (step.elapsedMs === null) item.classList.add("skipped");
    item.append(make("span", step.agent, "step-role"), make("strong", step.title), make("p", step.detail, "muted"));
    if (step.elapsedMs !== null) item.append(make("span", step.elapsedMs + " ms", "step-time"));
    steps.append(item);
  }
  timeline.append(steps);
  $("report").replaceChildren(summary, append(make("div", null, "report-layout"), findings, timeline));
}

async function runAudit(event) {
  event?.preventDefault();
  const fields = [...$("audit-form").querySelectorAll("input, textarea, select, button"), ...$("cases").querySelectorAll("button")];
  fields.forEach((field) => { field.disabled = true; });
  setMessage("audit-message", $("mode").value === "openai" ? "The agents are reviewing the documents…" : "Running the audit…");
  $("report").replaceChildren();
  const caseData = { title: $("case-name").value };
  for (const key of ["estimate", "invoice", "approvals"]) caseData[key] = $(key).value;
  try {
    const report = await request("/api/audit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: $("mode").value, strategy: $("strategy").value, case: caseData }),
    });
    renderReport(report);
    setMessage("audit-message", "Audit complete.");
  } catch (error) {
    setMessage("audit-message", error.message, true);
  } finally {
    fields.forEach((field) => { field.disabled = false; });
  }
}

function renderBenchmark(result) {
  const panel = append(make("section", null, "panel results-summary"), make("h2", "Comparison"));
  const scroll = make("div", null, "table-scroll");
  const table = make("table");
  const head = append(make("tr"), ...["Metric", "Multi-agent", "Single-agent"].map((value) => make("th", value)));
  const rows = [
    ["Cases passed", (value) => value.casesPassed + " / " + value.cases],
    ["Correct line decisions", (value) => value.lineMatches + " / " + value.lines],
    ["Median duration", (value) => value.medianMs + " ms"],
    ["OpenAI calls", (value) => value.modelCalls],
  ];
  const body = append(make("tbody"), ...rows.map(([label, display]) =>
    append(make("tr"), make("th", label), make("td", display(result.multi)), make("td", display(result.single)))));
  table.append(append(make("thead"), head), body);
  panel.append(append(scroll, table), make("h3", "Cases"));
  const cases = make("ul", null, "benchmark-cases");
  for (const row of result.results) {
    const multi = row.multi.correct ? "pass" : "needs investigation";
    const single = row.single.correct ? "pass" : "needs investigation";
    cases.append(append(make("li"), make("strong", row.title), make("span", "Multi-agent: " + multi + " · Single-agent: " + single, "muted")));
  }
  panel.append(cases);
  $("benchmark-report").replaceChildren(panel);
}

$("audit-tab").addEventListener("click", () => showView(false));
$("benchmark-tab").addEventListener("click", () => showView(true));
$("audit-form").addEventListener("submit", runAudit);
$("mode").addEventListener("change", () => {
  const live = $("mode").value === "openai";
  $("connection").textContent = live ? "OpenAI configured" : "Demo mode";
  $("mode-note").textContent = live
    ? "Running an audit sends the supplied documents to OpenAI and uses API credits."
    : "Demo mode uses local rules to simulate agent decisions.";
});
$("benchmark-run").addEventListener("click", async () => {
  $("benchmark-run").disabled = true;
  setMessage("benchmark-message", "Evaluating both workflows…");
  try {
    renderBenchmark(await request("/api/benchmark"));
    setMessage("benchmark-message", "Benchmark complete.");
  } catch (error) {
    setMessage("benchmark-message", error.message, true);
  } finally {
    $("benchmark-run").disabled = false;
  }
});
$("run").disabled = true;
try {
  const config = await request("/api/cases");
  samples = config.samples;
  const option = $("mode").querySelector('[value="openai"]');
  option.disabled = !config.openAIAvailable;
  if (config.openAIAvailable) option.textContent = "OpenAI · " + config.model;
  loadCase(samples.find((sample) => sample.id === "partial"));
  await runAudit();
} catch (error) {
  $("startup-error").hidden = false;
  setMessage("startup-error", error.message, true);
}
