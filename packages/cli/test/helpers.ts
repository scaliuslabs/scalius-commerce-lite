import { PassThrough } from "node:stream";
import type { Runtime } from "../src/types.js";

export interface TestRuntime extends Runtime {
  stdoutText: () => string;
  stderrText: () => string;
  openedUrls: string[];
  sleeps: number[];
}

export function createTestRuntime(options: {
  directory: string;
  fetch?: typeof globalThis.fetch;
  stdin?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<unknown>;
}): TestRuntime {
  const stdinStream = new PassThrough();
  const stdin = stdinStream as Runtime["stdin"];
  stdin.isTTY = false;
  if (options.stdin !== undefined) stdinStream.end(options.stdin);
  else stdinStream.end();
  const stdout = new PassThrough() as Runtime["stdout"];
  const stderr = new PassThrough() as Runtime["stderr"];
  let stdoutBuffer = "";
  let stderrBuffer = "";
  stdout.on("data", (chunk) => { stdoutBuffer += chunk.toString(); });
  stderr.on("data", (chunk) => { stderrBuffer += chunk.toString(); });
  const openedUrls: string[] = [];
  const sleeps: number[] = [];
  let clock = options.now ?? Date.parse("2026-08-13T00:00:00.000Z");
  return {
    env: { SCALIUS_CONFIG_HOME: options.directory, ...options.env },
    fetch: options.fetch ?? (async () => new Response("Not found", { status: 404 })),
    homedir: () => options.directory,
    now: () => clock,
    openUrl: async (url) => {
      openedUrls.push(url);
      return options.openUrl?.(url);
    },
    platform: "linux",
    signal: options.signal,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    stdin,
    stdout,
    stderr,
    openedUrls,
    sleeps,
    stdoutText: () => stdoutBuffer,
    stderrText: () => stderrBuffer,
  };
}

export function validToken(kind: "pat" | "cli" = "cli"): string {
  return `sc_${kind}_agc_${"A".repeat(20)}_${"B".repeat(43)}`;
}

export function executableSpec(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/v1/admin/products/{id}": {
        get: {
          operationId: "dashboard.products.get",
          summary: "Get product",
          tags: ["Products"],
          parameters: [
            { in: "path", name: "id", required: true, schema: { type: "string" } },
            { in: "query", name: "expand", schema: { type: "array", items: { type: "string" } } },
          ],
          responses: { "200": { description: "Product" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "read",
            openWorld: false,
            idempotency: "none",
            batch: "parallel",
            transport: "json",
            maxRequestBytes: 1024 * 1024,
          },
        },
      },
      "/api/v1/admin/products": {
        post: {
          operationId: "dashboard.products.create",
          summary: "Create product",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": { description: "Created" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "write",
            openWorld: false,
            idempotency: "required",
            batch: "sequential",
            transport: "json",
            maxRequestBytes: 1024 * 1024,
          },
        },
      },
      "/api/v1/admin/media": {
        post: {
          operationId: "dashboard.media.upload",
          summary: "Upload media",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    alt: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "write",
            openWorld: false,
            idempotency: "none",
            batch: "forbidden",
            transport: "multipart",
            maxRequestBytes: 16 * 1024 * 1024,
          },
        },
      },
      "/api/v1/admin/media/uploads": {
        post: {
          operationId: "dashboard.media.upload_initiate",
          summary: "Initiate media upload",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": { description: "Initiated" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "write",
            openWorld: false,
            idempotency: "none",
            batch: "sequential",
            transport: "json",
            maxRequestBytes: 1024 * 1024,
          },
        },
      },
      "/api/v1/admin/media/uploads/{id}/parts/{partNumber}": {
        put: {
          operationId: "dashboard.media.upload_part",
          summary: "Upload one media part",
          parameters: [
            { in: "path", name: "id", required: true, schema: { type: "string" } },
            { in: "path", name: "partNumber", required: true, schema: { type: "integer", minimum: 1, maximum: 20 } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary", minLength: 1, maxLength: 5 * 1024 * 1024 },
              },
            },
          },
          responses: { "200": { description: "Part stored" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "write",
            openWorld: false,
            idempotency: "supported",
            batch: "forbidden",
            transport: "octet-stream",
            maxRequestBytes: 5 * 1024 * 1024,
          },
        },
      },
      "/api/v1/admin/media/uploads/{id}/complete": {
        post: {
          operationId: "dashboard.media.upload_complete",
          summary: "Complete media upload",
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Completed" } },
          "x-scalius-agent": {
            surface: "dashboard",
            exposure: "execute",
            principals: ["admin"],
            risk: "write",
            openWorld: false,
            idempotency: "supported",
            batch: "sequential",
            transport: "json",
            maxRequestBytes: 1024 * 1024,
          },
        },
      },
      "/api/v1/internal": {
        post: {
          operationId: "system.internal.hidden",
          "x-scalius-agent": { exposure: "excluded", exclusionReason: "internal" },
        },
      },
    },
    ...overrides,
  };
}
