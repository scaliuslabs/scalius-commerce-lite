import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { createTestRuntime, executableSpec, validToken } from "./helpers.js";

async function authenticatedRuntime(
  fetch: typeof globalThis.fetch,
  options: { signal?: AbortSignal } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "scalius-raw-file-"));
  const runtime = createTestRuntime({ directory, fetch, signal: options.signal });
  const store = new ConfigStore(runtime);
  await store.putProfile("default", "https://api.example.com");
  await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
  return { runtime, directory };
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  expect(body).toBeInstanceOf(ReadableStream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe("reviewed raw octet-stream operation transport", () => {
  it("runs initiate, streams one exact-length part, then completes using fixed contract routes", async () => {
    const calls: Array<{ path: string; method?: string; headers: Headers; body: Uint8Array; streamed: boolean }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      const streamed = init?.body instanceof ReadableStream;
      const bytes = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array();
      calls.push({ path: url.pathname, method: init?.method, headers: new Headers(init?.headers), body: bytes, streamed });
      if (url.pathname.endsWith("/uploads")) {
        return Response.json({ data: { session: { id: "upload_session_123", expectedParts: 1, partSize: 5 * 1024 * 1024 } } }, { status: 201 });
      }
      if (url.pathname.includes("/parts/")) return Response.json({ data: { partNumber: 1, size: bytes.byteLength } });
      return Response.json({ data: { file: { id: "media_123" } } });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "part.bin");
    const contents = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await writeFile(file, contents);

    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_initiate",
      "--input", JSON.stringify({ body: { filename: "asset.png", mimeType: "image/png", size: contents.byteLength, folderId: null } }),
      "--yes",
    ])).toBe(0);
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", JSON.stringify({ path: { id: "upload_session_123", partNumber: 1 } }),
      "--file", file,
      "--yes",
    ])).toBe(0);
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_complete",
      "--input", JSON.stringify({ path: { id: "upload_session_123" } }),
      "--yes",
    ])).toBe(0);

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/admin/media/uploads",
      "PUT /api/v1/admin/media/uploads/upload_session_123/parts/1",
      "POST /api/v1/admin/media/uploads/upload_session_123/complete",
    ]);
    const part = calls[1]!;
    expect(part.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(part.headers.get("Content-Length")).toBe(String(contents.byteLength));
    expect(part.headers.get("Authorization")).toMatch(/^Bearer sc_cli_/);
    expect(part.streamed).toBe(true);
    expect(part.body).toEqual(contents);
    expect(runtime.stderrText()).toContain(`Uploading ${contents.byteLength} bytes.`);
    expect(runtime.stderrText()).not.toContain(file);
  });

  it("reopens and retries an idempotent raw request after a network failure", async () => {
    let partAttempts = 0;
    const payloads: Uint8Array[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      partAttempts += 1;
      const bytes = await bodyBytes(init?.body);
      payloads.push(bytes);
      if (partAttempts === 1) throw new TypeError("connection reset");
      return Response.json({ data: { partNumber: 1, size: bytes.byteLength } });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "part.bin");
    await writeFile(file, "retry-safe");
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ]);
    expect(exit).toBe(0);
    expect(partAttempts).toBe(2);
    expect(new TextDecoder().decode(payloads[0])).toBe("retry-safe");
    expect(payloads[1]).toEqual(payloads[0]);
    expect(runtime.stderrText()).toContain("retry 1");
  });

  it("aborts a streamed upload with exit 130 and never retries", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      attempts += 1;
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new DOMException("Interrupted", "AbortError"));
      throw new DOMException("Interrupted", "AbortError");
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch, { signal: controller.signal });
    const file = join(directory, "part.bin");
    await writeFile(file, "abort-me");
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ]);
    expect(exit).toBe(130);
    expect(attempts).toBe(1);
    expect(runtime.stderrText()).toContain("Operation interrupted");
  });

  it.each([
    ["missing", "missing.bin", "Unable to read upload file"],
    ["directory", ".", "not a regular file"],
  ])("rejects an unreadable %s source before network upload", async (_label, relative, message) => {
    let uploadCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      uploadCalls += 1;
      return Response.json({});
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = relative === "." ? directory : join(directory, relative);
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ]);
    expect(exit).toBe(5);
    expect(runtime.stderrText()).toContain(message);
    expect(uploadCalls).toBe(0);
  });

  it("enforces the live schema maximum before opening the network request", async () => {
    let uploadCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      uploadCalls += 1;
      return Response.json({});
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "oversize.bin");
    await writeFile(file, "x");
    await truncate(file, 5 * 1024 * 1024 + 1);
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ]);
    expect(exit).toBe(5);
    expect(runtime.stderrText()).toContain("1-5242880 bytes");
    expect(uploadCalls).toBe(0);
  });

  it("redacts a credential returned in a raw-upload error", async () => {
    const credential = validToken();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(executableSpec());
      await bodyBytes(init?.body);
      return Response.json({ code: "denied", message: `Rejected ${credential}` }, { status: 403 });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "part.bin");
    await writeFile(file, "denied");
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ]);
    expect(exit).toBe(4);
    expect(runtime.stderrText()).not.toContain(credential);
    expect(runtime.stderrText()).toContain("[REDACTED_CREDENTIAL]");
  });

  it("keeps the request file stream separate from an atomic --save response", async () => {
    const requestBodies: Uint8Array[] = [];
    const responseBytes = Uint8Array.from([9, 8, 7, 6]);
    const spec = executableSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/api/v1/admin/media/uploads/{id}/parts/{partNumber}"]!.put!;
    const agent = operation["x-scalius-agent"] as Record<string, unknown>;
    agent.artifactOutput = {
      mediaTypes: ["application/octet-stream"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16,
      delivery: "direct-stream",
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(spec);
      requestBodies.push(await bodyBytes(init?.body));
      return new Response(responseBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="result.bin"',
          "Content-Length": String(responseBytes.byteLength),
        },
      });
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const source = join(directory, "source.bin");
    const destination = join(directory, "result.bin");
    const requestBytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await writeFile(source, requestBytes);

    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", source,
      "--save", destination,
      "--yes",
    ])).toBe(0);
    expect(requestBodies).toEqual([requestBytes]);
    expect(new Uint8Array(await readFile(destination))).toEqual(responseBytes);
  });

  it("fails closed when the live raw request schema has no explicit byte maximum", async () => {
    let uploadCalls = 0;
    const spec = executableSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/api/v1/admin/media/uploads/{id}/parts/{partNumber}"]!.put!;
    operation.requestBody = {
      required: true,
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary", minLength: 1 },
        },
      },
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(spec);
      uploadCalls += 1;
      return Response.json({});
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "part.bin");
    await writeFile(file, "bounded-only");

    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ])).toBe(8);
    expect(runtime.stderrText()).toContain("requires a bounded application/octet-stream binary request schema");
    expect(uploadCalls).toBe(0);
  });

  it("fails closed when raw schema and reviewed maxRequestBytes disagree", async () => {
    let uploadCalls = 0;
    const spec = executableSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/api/v1/admin/media/uploads/{id}/parts/{partNumber}"]!.put!;
    const agent = operation["x-scalius-agent"] as Record<string, unknown>;
    agent.maxRequestBytes = 1024;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/openapi.json")) return Response.json(spec);
      uploadCalls += 1;
      return Response.json({});
    });
    const { runtime, directory } = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const file = join(directory, "part.bin");
    await writeFile(file, "bounded-only");

    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", file,
      "--yes",
    ])).toBe(8);
    expect(runtime.stderrText()).toContain("bounded application/octet-stream binary request schema");
    expect(uploadCalls).toBe(0);
  });

  it("rejects raw file stdin and raw operations in batch", async () => {
    const { runtime, directory } = await authenticatedRuntime(async () => Response.json(executableSpec()));
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload_part",
      "--input", '{"path":{"id":"upload_session_123","partNumber":1}}',
      "--file", "-",
      "--yes",
    ])).toBe(2);
    expect(runtime.stderrText()).toContain("stdin is not accepted");

    const runtime2 = createTestRuntime({ directory, fetch: async () => Response.json(executableSpec()) });
    expect(await runProgram(runtime2, [
      "operations", "batch", "--input", JSON.stringify({ steps: [{
        operationId: "dashboard.media.upload_part",
        input: { path: { id: "upload_session_123", partNumber: 1 } },
      }] }),
      "--yes",
    ])).toBe(5);
    expect(runtime2.stderrText()).toContain("cannot run in a batch");
  });
});
