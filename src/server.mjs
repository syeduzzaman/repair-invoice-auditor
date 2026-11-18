import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { evaluate, samples } from "./benchmark.mjs";
import { InputError } from "./domain.mjs";
import { createDemoProvider, createOpenAIProvider, ProviderError } from "./providers.mjs";
import { auditCase } from "./workflow.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function send(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new InputError("Send a JSON request.");
  }
  const limit = 90_000;
  if (Number(request.headers["content-length"]) > limit) throw new InputError("The request is too large.");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(chunk);
  }
  if (bytes > limit) throw new InputError("The request is too large.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("Invalid JSON request.");
  }
}

export function buildServer({ key, model = "gpt-6-luna", requestOpenAI } = {}) {
  const demo = createDemoProvider();
  const live = key ? createOpenAIProvider({ key, model, request: requestOpenAI }) : null;
  let liveInProgress = false;

  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; object-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) || (origin && origin !== "http://" + host)) {
      send(response, 403, { error: "Open the auditor directly using its localhost address." });
      return;
    }

    const path = request.url?.split("?")[0];
    try {
      if (request.method === "GET" && assets.has(path)) {
        const [name, mime] = assets.get(path);
        const contents = await readFile(new URL("../public/" + name, import.meta.url));
        response.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        response.end(contents);
        return;
      }
      if (request.method === "GET" && path === "/api/cases") {
        send(response, 200, { samples, openAIAvailable: Boolean(live), model: live?.model ?? null });
        return;
      }
      if (request.method === "GET" && path === "/api/benchmark") {
        send(response, 200, await evaluate(demo));
        return;
      }
      if (request.method === "POST" && path === "/api/audit") {
        const body = await readBody(request);
        if (!body || !["demo", "openai"].includes(body.mode) || !["multi", "single"].includes(body.strategy)) {
          throw new InputError("Select a valid audit mode and strategy.");
        }
        if (body.mode === "demo") {
          send(response, 200, await auditCase(body.case, demo, body.strategy));
          return;
        }
        if (!live) {
          send(response, 409, { error: "Set OPENAI_API_KEY in .env and restart to enable OpenAI mode." });
          return;
        }
        if (liveInProgress) {
          send(response, 409, { error: "An OpenAI audit is already in progress." });
          return;
        }
        liveInProgress = true;
        try {
          send(response, 200, await auditCase(body.case, live, body.strategy));
        } finally {
          liveInProgress = false;
        }
        return;
      }
      send(response, 404, { error: "This page does not exist." });
    } catch (error) {
      if (error instanceof InputError) send(response, 400, { error: error.message });
      else if (error instanceof ProviderError) send(response, 502, { error: error.message });
      else {
        console.error("Audit request failed:", error.name);
        send(response, 500, { error: "The server could not complete the audit." });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8081);
  const host = process.env.HOST || "127.0.0.1";
  buildServer({ key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }).listen(port, host, () => {
    console.log("Repair Invoice Auditor is ready at http://localhost:" + port);
  });
}
