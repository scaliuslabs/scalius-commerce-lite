import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { findOperation, indexOperations, loadOpenApi, searchOperations } from "../src/openapi.js";
import type { OpenApiDocument } from "../src/types.js";
import { createTestRuntime, executableSpec, validToken } from "./helpers.js";

describe("OpenAPI operation indexing", () => {
  it("includes only explicitly executable stable operation IDs", () => {
    const operations = indexOperations(executableSpec());
    expect(operations.map((operation) => operation.id)).toEqual([
      "dashboard.media.upload",
      "dashboard.media.upload_complete",
      "dashboard.media.upload_initiate",
      "dashboard.media.upload_part",
      "dashboard.products.create",
      "dashboard.products.get",
    ]);
  });

  it("indexes and preserves mixed closed- and open-world executable operations", () => {
    const document = executableSpec() as OpenApiDocument;
    const openOperation = document.paths!["/api/v1/admin/products"]!.post as Record<string, unknown>;
    const openMetadata = openOperation["x-scalius-agent"] as Record<string, unknown>;
    openMetadata.openWorld = true;

    const operations = indexOperations(document);
    expect(findOperation(operations, "dashboard.products.get").agent.openWorld).toBe(false);
    expect(findOperation(operations, "dashboard.products.create").agent.openWorld).toBe(true);
  });

  it("indexes a non-sensitive JSON continuation and a protected browser continuation", () => {
    const document = executableSpec() as OpenApiDocument;
    document.paths!["/api/v1/storefront/contexts/{contextId}/continuations/{continuationId}"] = {
      get: {
        operationId: "storefront.continuations.get",
        parameters: [
          { in: "path", name: "contextId", required: true, schema: { type: "string" } },
          { in: "path", name: "continuationId", required: true, schema: { type: "string" } },
        ],
        "x-scalius-agent": {
          surface: "storefront",
          exposure: "continuation",
          principals: ["visitor", "customer"],
          risk: "read",
          openWorld: false,
          idempotency: "none",
          revision: "none",
          batch: "forbidden",
          transport: "json",
          maximumResponseBytes: 65_536,
          maxRequestBytes: 16_384,
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
        },
      },
    };
    document.paths!["/api/v1/admin/theme/preview"] = {
      post: {
        operationId: "dashboard.theme.preview_session_create",
        "x-scalius-agent": {
          surface: "dashboard",
          exposure: "continuation",
          principals: ["admin"],
          risk: "read",
          openWorld: false,
          idempotency: "none",
          revision: "none",
          batch: "forbidden",
          transport: "continuation",
          maximumResponseBytes: 8_192,
          maxRequestBytes: 16_384,
          sensitiveOutput: true,
          oneTimeSecretOutput: false,
          continuationOutput: {
            method: "POST",
            urlJsonPointer: "/data/continuation/url",
            fieldsJsonPointer: "/data/continuation/fields",
            sensitiveFields: ["continuationCode"],
          },
        },
      },
    };

    const operations = indexOperations(document);
    expect(findOperation(operations, "storefront.continuations.get").agent.transport).toBe("json");
    expect(findOperation(operations, "dashboard.theme.preview_session_create").agent.continuationOutput)
      .toEqual(expect.objectContaining({ sensitiveFields: ["continuationCode"] }));
  });

  it("rejects unsafe continuation output combinations", () => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products/{id}"]!.get as Record<string, unknown>;
    operation["x-scalius-agent"] = {
      ...(operation["x-scalius-agent"] as Record<string, unknown>),
      exposure: "continuation",
      batch: "forbidden",
      transport: "continuation",
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/url",
        fieldsJsonPointer: "/data/fields",
        sensitiveFields: [],
      },
    };
    expect(() => indexOperations(document)).toThrow("invalid continuation output metadata");
  });

  it.each([undefined, "false", 0, null])("rejects non-boolean openWorld metadata value %s", (openWorld) => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products"]!.post as Record<string, unknown>;
    const metadata = operation["x-scalius-agent"] as Record<string, unknown>;
    if (openWorld === undefined) delete metadata.openWorld;
    else metadata.openWorld = openWorld;
    expect(() => indexOperations(document)).toThrow("invalid agent metadata");
  });

  it("rejects a continuation transport mislabeled as directly executable", () => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products/{id}"]!.get as Record<string, unknown>;
    const metadata = operation["x-scalius-agent"] as Record<string, unknown>;
    metadata.transport = "continuation";

    expect(() => indexOperations(document)).toThrow("invalid agent metadata");
  });

  it.each([undefined, 0, 1.5, 16 * 1024 * 1024 + 1])("rejects invalid maxRequestBytes metadata value %s", (maxRequestBytes) => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products"]!.post as Record<string, unknown>;
    const metadata = operation["x-scalius-agent"] as Record<string, unknown>;
    if (maxRequestBytes === undefined) delete metadata.maxRequestBytes;
    else metadata.maxRequestBytes = maxRequestBytes;
    expect(() => indexOperations(document)).toThrow("invalid request limit");
  });

  it("searches identifiers, summaries, and tags", () => {
    const operations = indexOperations(executableSpec());
    expect(searchOperations(operations, "get product").map(({ id }) => id)).toEqual(["dashboard.products.get"]);
    expect(searchOperations(operations, "create product").map(({ id }) => id)).toEqual(["dashboard.products.create"]);
    expect(searchOperations(operations, "Products")).toHaveLength(2);
  });

  it("understands common merchant phrasing without requiring operation jargon", () => {
    const operations = indexOperations(executableSpec());
    findOperation(operations, "dashboard.products.get").operation.description = "Answer daily revenue and order questions.";
    findOperation(operations, "dashboard.products.create").operation.description = "Create catalog merchandise.";
    expect(searchOperations(operations, "what are today's sales?").map(({ id }) => id)).toEqual([
      "dashboard.products.get",
    ]);
    expect(searchOperations(operations, "please create catalog merchandise").map(({ id }) => id)).toEqual([
      "dashboard.products.create",
    ]);
  });

  it("ranks exact merchant language ahead of synonym-only matches", () => {
    const operations = indexOperations(executableSpec());
    findOperation(operations, "dashboard.products.get").operation.description = "Find orders needing fulfillment.";
    findOperation(operations, "dashboard.products.create").operation.description = "Create a shipping filter for orders.";
    expect(searchOperations(operations, "orders needing fulfillment").map(({ id }) => id)).toEqual([
      "dashboard.products.get",
    ]);
  });

  it("retains matching writes when no read operation can answer the request", () => {
    const operations = indexOperations(executableSpec());
    expect(searchOperations(operations, "create product").map(({ id }) => id)).toEqual([
      "dashboard.products.create",
    ]);
  });

  it("does not permit arbitrary paths disguised as operation IDs", () => {
    const operations = indexOperations(executableSpec());
    expect(() => findOperation(operations, "https://attacker.example/evil")).toThrow(CliError);
    expect(() => findOperation(operations, "dashboard.products.delete_all")).toThrow("not in the live server contract");
  });

  it("rejects duplicate operation IDs in server contracts", () => {
    const document = executableSpec() as OpenApiDocument;
    document.paths!["/api/v1/duplicate"] = {
      get: {
        operationId: "dashboard.products.get",
        "x-scalius-agent": {
          surface: "dashboard",
          exposure: "execute",
          risk: "read",
          openWorld: false,
          idempotency: "none",
          batch: "parallel",
          transport: "json",
          maxRequestBytes: 1024 * 1024,
        },
      },
    };
    expect(() => indexOperations(document)).toThrow("duplicate operation ID");
  });

  it("rejects the removed stream request transport", () => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products/{id}"]!.get as Record<string, unknown>;
    const metadata = operation["x-scalius-agent"] as Record<string, unknown>;
    metadata.transport = "stream";
    expect(() => indexOperations(document)).toThrow("invalid agent metadata");
  });

  it.each([
    ["duplicate media types", { mediaTypes: ["text/csv", "text/csv"] }],
    ["invalid media type", { mediaTypes: ["CSV"] }],
    ["invalid disposition", { disposition: "download" }],
    ["invalid filename policy", { filenamePolicy: "caller" }],
    ["invalid delivery", { delivery: "public-url" }],
    ["oversized limit", { maxArtifactBytes: 16 * 1024 * 1024 + 1 }],
  ])("rejects artifact metadata with %s", (_label, override) => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products/{id}"]!.get as Record<string, unknown>;
    const metadata = operation["x-scalius-agent"] as Record<string, unknown>;
    metadata.batch = "forbidden";
    metadata.artifactOutput = {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 1024,
      delivery: "authenticated-handle",
      ...override,
    };
    expect(() => indexOperations(document)).toThrow("invalid artifact output metadata");
  });

  it.each([
    ["batching", { batch: "parallel" }],
    ["sensitive output", { sensitiveOutput: true }],
  ])("rejects artifact output combined with %s", (_label, override) => {
    const document = executableSpec() as OpenApiDocument;
    const operation = document.paths!["/api/v1/admin/products/{id}"]!.get as Record<string, unknown>;
    operation["x-scalius-agent"] = {
      ...(operation["x-scalius-agent"] as Record<string, unknown>),
      batch: "forbidden",
      artifactOutput: {
        mediaTypes: ["text/csv"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 1024,
        delivery: "authenticated-handle",
      },
      ...override,
    };
    expect(() => indexOperations(document)).toThrow("invalid artifact output policy");
  });

  it("revalidates the cached contract with ETag and accepts 304", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-openapi-"));
    let calls = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Response.json(executableSpec(), { headers: { ETag: '"contract-1"' } });
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"contract-1"');
      return new Response(null, { status: 304 });
    });
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });
    const store = new ConfigStore(runtime);
    await store.putProfile("default", "https://api.example.com");
    await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
    const profile = await store.resolveProfile();
    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads the public contract without attaching an execution credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-openapi-public-"));
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Response.json(executableSpec(), { headers: { ETag: '"public-contract"' } });
    });
    const runtime = createTestRuntime({
      directory,
      env: { SCALIUS_SERVER: "https://api.example.com" },
      fetch: fetch as typeof globalThis.fetch,
    });
    const profile = await new ConfigStore(runtime).resolveProfile(undefined, false);

    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a multi-step workflow on one contract and revalidates after thirty minutes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-openapi-"));
    let calls = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Response.json(executableSpec(), { headers: { ETag: '"contract-1"' } });
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"contract-1"');
      return new Response(null, { status: 304 });
    });
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });
    const store = new ConfigStore(runtime);
    await store.putProfile("default", "https://api.example.com");
    await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
    const profile = await store.resolveProfile();
    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    await runtime.sleep(29 * 60 * 1_000);
    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runtime.sleep(60 * 1_000);
    expect(indexOperations(await loadOpenApi(runtime, profile))).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
