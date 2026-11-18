# Repair Invoice Auditor

A multi-agent workshop invoice review. Given an approved estimate, a submitted invoice, and written approval records, it proposes line matches, checks the amount of each increase, and shows source evidence for the decision. This is a local portfolio project with fictional data.

## Start locally

Install Node.js 22 or newer. From the project directory:

```powershell
node --env-file-if-exists=.env src/server.mjs
```

Open [http://127.0.0.1:8081](http://127.0.0.1:8081). No package installation or API key is needed for the demo. With Docker Desktop, you can also use `docker compose up --build --detach`.

The app opens **Partial approval** by default. The approved estimate is €1,200 and the invoice is €1,450. Approval A-101 covers €150 of the €250 sensor-bracket supplement, so **€100 needs review**. Expand the invoice and approval evidence on the line item.

Next, select **Ambiguous bracket** and run the multi-agent audit. The auditor requests a second read of invoice line I1. The reader finds the cross-reference in line I3, and the auditor matches it to the correct estimate line. Try deleting I3 and rerunning the case. The line should stay unresolved. To run the same fixture through the single-agent workflow, change **Workflow** above **Run audit**.

## Agents and application rules

| Role | Inputs | Output |
| --- | --- | --- |
| Document reader | Numbered estimate and invoice lines | IDs for the item lines |
| Invoice auditor | Confirmed lines and any verified notes | One proposed decision per billed line |
| Document reader, follow-up | Ambiguous invoice IDs and their original invoice | Source IDs for cross-reference notes |
| Approval reviewer | Positive changes and related approval records | Matching authorization citations |

The orchestrator performs at most one targeted reread. It skips the approval review if the invoice has no verified increases. The single-agent baseline makes one model call with the same source data and uses the same application rules to verify its result.

Code verifies all source IDs, calculates amounts as integer cents, refuses to allocate an estimate line or approval twice, and treats unsupported matches as unresolved. An approval applies only to its exact item reference. A revoked or conflicting record sharing the approval ID blocks authorization. Multiple different active approval IDs for the same item are flagged for manual review. A lower billed amount on another line never pays for an unapproved increase.

## Input format

Use **View or edit case documents** to try different inputs. The benchmark ships with five fictional cases. Imports are structured plain text, with one record per line. PDF parsing, OCR, and external workshop system connectors are outside this version.

- Estimate or invoice item: `ITEM | REF: B01 | Front bumper repair | €900.00`.
- Reference-free invoice item: `ITEM | Mounting bracket | €140.00`.
- Cross-reference: `NOTE | I1 | REF: BR-L`, where I1 is invoice line 1. Blank lines count towards line numbers.
- Approval: `APPROVED | A-101 | REF: B01 | €150.00`. `PENDING`, `REVOKED`, and `DENIED` records may omit the amount.
- EUR amounts such as `EUR 1.200,00` and `€1,200.00` are accepted. Use the same tax basis across the documents. The audit adds the records itself. A heading starting with `TOTAL` is display text.

The app needs the records for one case at a time. It does not execute payments or store cases. A clear result means the supported invoice lines have no unresolved increases under the demo rules. A workshop reviewer still controls the decision.

## Run with OpenAI

Copy `.env.example` to `.env`, set your API key there, and restart the server. Select **OpenAI** in the app before running. Keep the local demo selected when working with data you do not want to send to OpenAI. In OpenAI mode, the server sends the entered documents and related approval records to the Responses API as needed. The browser never receives the key. The model is configurable through `OPENAI_MODEL`.

Demo mode uses deterministic rules to simulate agent decisions. OpenAI mode uses independent structured model calls and shows the resulting model calls, token usage, and elapsed time. The app is bound to localhost by default and is designed for single-user use.

## Evaluate

```powershell
node --test
node src/evaluate.mjs --assert
node --env-file-if-exists=.env src/evaluate.mjs --openai
```

You can also click **Benchmark → Run benchmark** for the local comparison. The evaluator checks exact line matches, the case verdict, the unapproved amount, and the number of lines sent for review. It reports median latency, model calls, and input and output tokens for each workflow. The OpenAI command uses API credits, so run it explicitly. A successful demo benchmark verifies the fixture logic and handoffs. Use a larger unseen dataset for any quality comparison between model configurations.

The included GitHub Actions workflow runs the tests and local benchmark without credentials. Tests exercise the role-specific OpenAI request and response contracts using a simulated provider response.

## Project structure

- `src/workflow.mjs` orchestrates the agent handoffs and records timings and usage.
- `src/domain.mjs` validates source references and implements the audit rules.
- `src/providers.mjs` contains the local and OpenAI providers.
- `src/benchmark.mjs` compares the two workflows on the same labeled cases.
- `public/` serves the audit workbench and benchmark.
