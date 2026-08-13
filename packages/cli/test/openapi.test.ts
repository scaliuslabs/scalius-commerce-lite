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
    expect(searchOperations(operations, "Products")).toHaveLength(2);
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
  });
});
