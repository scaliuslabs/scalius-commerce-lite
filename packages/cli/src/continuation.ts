import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CliError } from "./errors.js";
import type { AgentContinuationOutput, Runtime } from "./types.js";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_FIELDS = 16;
const MAX_FIELD_BYTES = 4_096;
const RELAY_TIMEOUT_MS = 30_000;
const READY_MESSAGE = "scalius-continuation-ready-v1";
const FIELDS_MESSAGE = "scalius-continuation-fields-v1";
const ACCEPTED_MESSAGE = "scalius-continuation-accepted-v1";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
    throw new CliError(8, "invalid_continuation", "Continuation metadata contains an invalid JSON Pointer.");
  }
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_POINTER_SEGMENTS.has(segment) || !isObject(current) || !Object.hasOwn(current, segment)) {
      throw new CliError(8, "invalid_continuation", "Continuation response does not match its reviewed contract.");
    }
    current = current[segment];
  }
  return current;
}

function continuationAction(
  response: unknown,
  policy: AgentContinuationOutput,
): { target: URL; fields: Record<string, string> } {
  const rawUrl = readPointer(response, policy.urlJsonPointer);
  const rawFields = readPointer(response, policy.fieldsJsonPointer);
  if (typeof rawUrl !== "string" || !isObject(rawFields)) {
    throw new CliError(8, "invalid_continuation", "Continuation response does not match its reviewed contract.");
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new CliError(8, "invalid_continuation", "Continuation target is invalid.");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
    throw new CliError(8, "invalid_continuation", "Continuation target must be a credential-free HTTPS URL without query or fragment data.");
  }
  const entries = Object.entries(rawFields);
  if (entries.length < 1 || entries.length > MAX_FIELDS) {
    throw new CliError(8, "invalid_continuation", "Continuation fields are outside the reviewed bounds.");
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries) {
    if (!FIELD_NAME.test(name) || typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES) {
      throw new CliError(8, "invalid_continuation", "Continuation fields are outside the reviewed bounds.");
    }
    fields[name] = value;
  }
  if (policy.sensitiveFields.some((name) => typeof fields[name] !== "string")) {
    throw new CliError(8, "invalid_continuation", "Continuation response is missing a reviewed sensitive field.");
  }
  return { target, fields };
}

function scriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function relayHtml(target: URL, fields: Record<string, string>): string {
  const payload = Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>Continue securely</title></head><body><main><h1>Continue securely</h1><p id="status">Scalius is ready to open the protected storefront step.</p><button id="continue" type="button">Continue to storefront</button><noscript>JavaScript is required to continue securely.</noscript></main><script>(()=>{const target=${scriptJson(target.toString())};const origin=${scriptJson(target.origin)};const encoded=${scriptJson(payload)};let popup=null;const button=document.getElementById("continue");const status=document.getElementById("status");const fields=()=>{const base64=encoded.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-encoded.length%4)%4);const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes))};window.addEventListener("message",event=>{if(event.origin!==origin||event.source!==popup||!event.data||typeof event.data!=="object")return;if(event.data.type===${scriptJson(READY_MESSAGE)}){popup.postMessage({type:${scriptJson(FIELDS_MESSAGE)},fields:fields()},origin);return}if(event.data.type===${scriptJson(ACCEPTED_MESSAGE)}){status.textContent="The protected storefront step is open. You may close this tab."}});button.addEventListener("click",()=>{popup=window.open(target,"scalius-secure-continuation");if(!popup){status.textContent="Allow the storefront popup, then try again.";return}button.disabled=true;status.textContent="Opening the protected storefront step…"})})()</script></body></html>`;
}

async function openRelay(runtime: Runtime, target: URL, fields: Record<string, string>): Promise<void> {
  const route = `/${randomBytes(32).toString("base64url")}`;
  const html = relayHtml(target, fields);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let opened = false;
    let served = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close(() => error ? reject(error) : resolve());
    };
    const finishWhenComplete = () => {
      if (opened && served) finish();
    };
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== route) {
        response.writeHead(404, { "Cache-Control": "private, no-store" }).end();
        return;
      }
      const body = Buffer.from(html, "utf8");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        Connection: "close",
      });
      response.end(body, () => {
        served = true;
        finishWhenComplete();
      });
    });
    const timeout = setTimeout(() => finish(new CliError(
      7,
      "browser_continuation_timeout",
      "The protected browser continuation was not opened before it expired locally.",
    )), RELAY_TIMEOUT_MS);
    server.once("error", () => finish(new CliError(
      7,
      "browser_continuation_failed",
      "Unable to start the protected local browser continuation.",
    )));
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(new CliError(7, "browser_continuation_failed", "Unable to start the protected local browser continuation."));
        return;
      }
      try {
        await runtime.openUrl(`http://127.0.0.1:${address.port}${route}`);
        opened = true;
        finishWhenComplete();
      } catch {
        finish(new CliError(7, "browser_continuation_failed", "Unable to open the protected browser continuation."));
      }
    });
  });
}

export async function openBrowserContinuation(
  runtime: Runtime,
  response: unknown,
  policy: AgentContinuationOutput,
): Promise<Record<string, unknown>> {
  const { target, fields } = continuationAction(response, policy);
  await openRelay(runtime, target, fields);
  return {
    status: "browser_continuation_opened",
    method: "POST",
    origin: target.origin,
  };
}
