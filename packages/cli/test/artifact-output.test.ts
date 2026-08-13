import { access, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { createTestRuntime, executableSpec, validToken } from "./helpers.js";

const SIXTEEN_MIB = 16 * 1024 * 1024;
const INVOICE_MAX_BYTES = 65_536;

function metadata(artifactOutput: Record<string, unknown>) {
  return {
    surface: "dashboard",
    exposure: "execute",
    principals: ["admin"],
    risk: "read",
    openWorld: false,
    idempotency: "none",
    revision: "none",
    batch: "forbidden",
    transport: "json",
    maximumResponseBytes: 65_536,
    maxRequestBytes: 1024 * 1024,
    sensitiveOutput: false,
    artifactOutput,
  };
}

function artifactSpec(): Record<string, unknown> {
  const spec = executableSpec();
  const paths = spec.paths as Record<string, unknown>;
  paths["/api/v1/admin/inventory/labels/artifact"] = {
    post: {
      operationId: "dashboard.inventory_labels.generate_artifact",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      responses: { "200": { description: "Label artifact" } },
      "x-scalius-agent": metadata({
        mediaTypes: ["application/pdf", "text/csv", "text/html"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: SIXTEEN_MIB,
        delivery: "authenticated-handle",
      }),
    },
  };
  paths["/api/v1/admin/orders/export"] = {
    get: {
      operationId: "dashboard.orders.export",
      responses: { "200": { description: "Order CSV" } },
      "x-scalius-agent": metadata({
        mediaTypes: ["text/csv"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: SIXTEEN_MIB,
        delivery: "authenticated-handle",
      }),
    },
  };
  paths["/api/v1/admin/orders/{id}/invoice/print"] = {
    get: {
      operationId: "dashboard.orders.invoice_print",
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Invoice HTML" } },
      "x-scalius-agent": metadata({
        mediaTypes: ["text/html"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: INVOICE_MAX_BYTES,
        delivery: "authenticated-handle",
      }),
    },
  };
  return spec;
}

async function authenticatedRuntime(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "scalius-artifact-"));
  const runtime = createTestRuntime({ directory, fetch });
  const store = new ConfigStore(runtime);
  await store.putProfile("default", "https://api.example.com");
  await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
  return { runtime, directory };
}

function artifactResponse(
  body: BodyInit,
  options: { contentType?: string; disposition?: string; contentLength?: string } = {},
): Response {
  const headers = new Headers();
  if (options.contentType !== undefined) headers.set("Content-Type", options.contentType);
  if (options.disposition !== undefined) headers.set("Content-Disposition", options.disposition);
  if (options.contentLength !== undefined) headers.set("Content-Length", options.contentLength);
  return new Response(body, { status: 200, headers });
}

function operationArguments(id: string, destination: string): string[] {
  if (id === "dashboard.inventory_labels.generate_artifact") {
    return ["operations", "run", id, "--input", '{"body":{"format":"csv"}}', "--save", destination];
  }
  if (id === "dashboard.orders.invoice_print") {
    return ["operations", "run", id, "--input", '{"path":{"id":"order_123"}}', "--save", destination];
  }
  return ["operations", "run", id, "--save", destination];
}

async function expectNoPartial(directory: string, destination: string): Promise<void> {
  await expect(access(destination)).rejects.toBeDefined();
  const prefix = `${destination.split("/").at(-1)!}.`;
  expect((await readdir(directory)).filter((name) => name.startsWith(prefix))).toEqual([]);
}

describe("contract-declared artifact output", () => {
  it.each([
    ["application/pdf", "labels.pdf"],
    ["text/csv; charset=utf-8", "labels.csv"],
    ["text/html; charset=utf-8", "labels.html"],
  ])("accepts the reviewed labels media type %s", async (contentType, filename) => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(bytes, {
        contentType,
        disposition: `attachment; filename="${filename}"`,
        contentLength: String(bytes.byteLength),
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, filename);
    expect(await runProgram(runtime, operationArguments("dashboard.inventory_labels.generate_artifact", destination))).toBe(0);
    expect((await stat(destination)).size).toBe(bytes.byteLength);
  });

  it("accepts a chunked order CSV while enforcing the actual streamed byte count", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id,total\n"));
        controller.enqueue(new TextEncoder().encode("o1,100\n"));
        controller.close();
      },
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(stream, {
        contentType: "text/csv; charset=utf-8",
        disposition: 'attachment; filename="orders.csv"',
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "orders.csv");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.export", destination))).toBe(0);
    expect((await stat(destination)).size).toBe(16);
  });

  it("accepts an invoice attachment at the exact artifact byte bound", async () => {
    const bytes = new Uint8Array(INVOICE_MAX_BYTES).fill(65);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(bytes, {
        contentType: "text/html; charset=utf-8",
        disposition: 'attachment; filename="invoice-order_123.html"',
        contentLength: String(INVOICE_MAX_BYTES),
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "invoice.html");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.invoice_print", destination))).toBe(0);
    expect((await stat(destination)).size).toBe(INVOICE_MAX_BYTES);
  });

  it.each([
    ["missing", undefined],
    ["wrong", "application/json"],
  ])("rejects a %s artifact Content-Type without a partial file", async (_label, contentType) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(Uint8Array.from([1]), {
        contentType,
        disposition: 'attachment; filename="orders.csv"',
        contentLength: "1",
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "orders.csv");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.export", destination))).toBe(8);
    expect(runtime.stderrText()).toContain("media type does not match");
    await expectNoPartial(directory, destination);
  });

  it.each([
    ["missing", undefined],
    ["wrong", 'inline; filename="orders.csv"'],
    ["unsafe filename", 'attachment; filename="../orders.csv"'],
  ])("rejects a %s artifact disposition without a partial file", async (_label, disposition) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(Uint8Array.from([1]), {
        contentType: "text/csv",
        disposition,
        contentLength: "1",
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "orders.csv");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.export", destination))).toBe(8);
    await expectNoPartial(directory, destination);
  });

  it.each([
    ["non-decimal", "1e2"],
    ["empty", "0"],
    ["over contract", String(INVOICE_MAX_BYTES + 1)],
  ])("rejects a %s declared Content-Length before creating output", async (_label, contentLength) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(Uint8Array.from([1]), {
        contentType: "text/html",
        disposition: 'attachment; filename="invoice.html"',
        contentLength,
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "invoice.html");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.invoice_print", destination))).toBe(8);
    expect(runtime.stderrText()).toContain("Content-Length");
    await expectNoPartial(directory, destination);
  });

  it("deletes the temporary output when actual bytes do not match Content-Length", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(Uint8Array.from([1, 2, 3]), {
        contentType: "text/html",
        disposition: 'attachment; filename="invoice.html"',
        contentLength: "4",
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "invoice.html");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.invoice_print", destination))).toBe(8);
    expect(runtime.stderrText()).toContain("do not match Content-Length");
    await expectNoPartial(directory, destination);
  });

  it("cancels and removes output as soon as actual bytes exceed Content-Length", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(Uint8Array.from([1, 2, 3]), {
        contentType: "text/html",
        disposition: 'attachment; filename="invoice.html"',
        contentLength: "2",
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "invoice.html");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.invoice_print", destination))).toBe(8);
    expect(runtime.stderrText()).toContain("do not match Content-Length");
    await expectNoPartial(directory, destination);
  });

  it("bounds a chunked artifact and deletes the temporary file on overflow", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(INVOICE_MAX_BYTES));
        controller.enqueue(Uint8Array.from([1]));
        controller.close();
      },
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(artifactSpec());
      return artifactResponse(stream, {
        contentType: "text/html",
        disposition: 'attachment; filename="invoice.html"',
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const destination = join(directory, "invoice.html");
    expect(await runProgram(runtime, operationArguments("dashboard.orders.invoice_print", destination))).toBe(8);
    expect(runtime.stderrText()).toContain("65536-byte contract limit");
    await expectNoPartial(directory, destination);
  });

  it("requires --save for artifacts and rejects it for structured responses", async () => {
    const fetch = vi.fn(async () => Response.json(artifactSpec()));
    const { runtime } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, ["operations", "run", "dashboard.orders.export"])).toBe(5);
    expect(runtime.stderrText()).toContain("requires --save");

    const { runtime: runtime2, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime2, [
      "operations", "run", "dashboard.products.get",
      "--input", '{"path":{"id":"p1"}}',
      "--save", join(directory, "product.json"),
    ])).toBe(5);
    expect(runtime2.stderrText()).toContain("does not declare an artifact output");
  });
});
