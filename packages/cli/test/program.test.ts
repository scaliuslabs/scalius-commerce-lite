import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { createTestRuntime, executableSpec, validToken } from "./helpers.js";

async function authenticatedRuntime(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "scalius-cli-"));
  const runtime = createTestRuntime({ directory, fetch });
  const store = new ConfigStore(runtime);
  await store.putProfile("default", "https://api.example.com");
  await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
  return runtime;
}

async function storefrontRuntime(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "scalius-cli-storefront-"));
  const runtime = createTestRuntime({ directory, fetch });
  const store = new ConfigStore(runtime);
  await store.putProfile("storefront", "https://api.example.com");
  await store.putCredential("storefront", {
    token: validToken(),
    resource: "storefront",
    createdAt: "2026-08-13T00:00:00.000Z",
  });
  return runtime;
}

function mixedAudienceSpec(): Record<string, unknown> {
  const spec = specWithContinuations();
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  paths["/api/v1/products"] = {
    get: {
      operationId: "storefront.products.list",
      summary: "List storefront products",
      responses: { "200": { description: "Products" } },
      "x-scalius-agent": {
        surface: "storefront", exposure: "execute", principals: ["visitor", "customer"],
        risk: "read", openWorld: false, idempotency: "none", revision: "none",
        batch: "parallel", transport: "json", maximumResponseBytes: 65_536,
        maxRequestBytes: 16_384, sensitiveOutput: false, oneTimeSecretOutput: false,
      },
    },
  };
  return spec;
}

function specWithCreateRequestLimit(maxRequestBytes: number): Record<string, unknown> {
  const spec = executableSpec();
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  const operation = paths["/api/v1/admin/products"]!.post!;
  (operation["x-scalius-agent"] as Record<string, unknown>).maxRequestBytes = maxRequestBytes;
  return spec;
}

function specWithContinuations(): Record<string, unknown> {
  const spec = executableSpec();
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  paths["/api/v1/storefront/agent-contexts/{contextId}/continuations/{continuationId}"] = {
    get: {
      operationId: "storefront.continuations.get",
      parameters: [
        { in: "path", name: "contextId", required: true, schema: { type: "string" } },
        { in: "path", name: "continuationId", required: true, schema: { type: "string" } },
      ],
      "x-scalius-agent": {
        surface: "storefront", exposure: "continuation", principals: ["visitor", "customer"],
        risk: "read", openWorld: false, idempotency: "none", revision: "none",
        batch: "forbidden", transport: "json", maximumResponseBytes: 65_536,
        maxRequestBytes: 16_384, sensitiveOutput: false, oneTimeSecretOutput: false,
      },
    },
  };
  paths["/api/v1/admin/settings/theme/preview-session"] = {
    post: {
      operationId: "dashboard.theme.preview_session_create",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      "x-scalius-agent": {
        surface: "dashboard", exposure: "continuation", principals: ["admin"],
        risk: "read", openWorld: false, idempotency: "none", revision: "none",
        batch: "forbidden", transport: "continuation", maximumResponseBytes: 8_192,
        maxRequestBytes: 16_384, sensitiveOutput: true, oneTimeSecretOutput: false,
        continuationOutput: {
          method: "POST", urlJsonPointer: "/data/continuation/url",
          fieldsJsonPointer: "/data/continuation/fields", sensitiveFields: ["continuationCode"],
        },
      },
    },
  };
  return spec;
}

describe("CLI program", () => {
  it("reports the version from the published package manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-version-test-"));
    const runtime = createTestRuntime({ directory });
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(await runProgram(runtime, ["--version"])).toBe(0);
    expect(runtime.stdoutText().trim()).toBe(manifest.version);
  });

  it("searches the live OpenAPI contract with deterministic JSON stdout", async () => {
    const fetch = vi.fn(async () => Response.json(executableSpec(), { headers: { ETag: '"v1"' } }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, ["--output", "json", "operations", "search", "product"]);
    expect(exit).toBe(0);
    const output = JSON.parse(runtime.stdoutText()) as { count: number; operations: Array<{ openWorld?: boolean }> };
    expect(output.count).toBe(2);
    expect(output.operations).toHaveLength(2);
    expect(output.operations.every(({ openWorld }) => openWorld === false)).toBe(true);
    expect(runtime.stderrText()).toBe("");
  });

  it("shows and describes only operations for the paired credential audience", async () => {
    let operationCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(mixedAudienceSpec());
      operationCalls += 1;
      return Response.json({ products: [] });
    });
    const runtime = await storefrontRuntime(fetch as typeof globalThis.fetch);

    expect(await runProgram(runtime, ["--profile", "storefront", "--output", "json", "operations", "search", "", "--limit", "100"])).toBe(0);
    const output = JSON.parse(runtime.stdoutText()) as { operations: Array<{ surface: string }> };
    expect(output.operations.length).toBeGreaterThan(0);
    expect(output.operations.every(({ surface }) => surface === "storefront")).toBe(true);

    const describeRuntime = await storefrontRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(describeRuntime, [
      "--profile", "storefront", "--output", "json", "operations", "describe", "dashboard.products.get",
    ])).toBe(5);
    expect(describeRuntime.stderrText()).toContain("Executable operation 'dashboard.products.get' is not in the live server contract");
    expect(operationCalls).toBe(0);
  });

  it("keeps search and describe compact unless full responses are requested", async () => {
    const fetch = vi.fn(async () => Response.json(executableSpec(), { headers: { ETag: '"v1"' } }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, ["--output", "json", "operations", "search", "product", "--limit", "1"])).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ count: 1 });

    const compact = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(compact, ["--output", "json", "operations", "describe", "dashboard.products.create"])).toBe(0);
    const compactResult = JSON.parse(compact.stdoutText()) as Record<string, unknown>;
    expect(compactResult).not.toHaveProperty("responses");
    expect(compactResult.responseStatuses).toEqual(["201"]);
    expect(compactResult.constructionHint).toBe("Use --full only when constructing the exact input.");
    expect(JSON.stringify(compactResult)).not.toContain('"properties"');

    const full = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(full, ["--output", "json", "operations", "describe", "dashboard.products.create", "--full"])).toBe(0);
    const fullResult = JSON.parse(full.stdoutText());
    expect(fullResult).toHaveProperty("responses.201");
    expect(fullResult).toHaveProperty("requestBody.content.application/json.schema.type", "object");
  });

  it("executes only the fixed method and path from OpenAPI", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/openapi.json")) return Response.json(executableSpec());
      return Response.json({ product: { id: "p/1" } });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, [
      "--output", "json", "operations", "run", "dashboard.products.get",
      "--input", JSON.stringify({ path: { id: "p/1" }, query: { expand: ["variants", "media"] } }),
    ]);
    expect(exit).toBe(0);
    expect(calls[1]?.url).toBe("https://api.example.com/api/v1/admin/products/p%2F1?expand=variants&expand=media");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toMatch(/^Bearer sc_cli_/);
  });

  it("runs a non-sensitive JSON continuation status operation", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/openapi.json")) return Response.json(specWithContinuations());
      calls.push(url);
      return Response.json({ status: "pending" });
    });
    const runtime = await storefrontRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, [
      "--profile", "storefront", "--output", "json", "operations", "run", "storefront.continuations.get",
      "--input", JSON.stringify({ path: { contextId: "ctx_1", continuationId: "acn_1" } }),
    ])).toBe(0);
    expect(calls).toEqual([
      "https://api.example.com/api/v1/storefront/agent-contexts/ctx_1/continuations/acn_1",
    ]);
    expect(JSON.parse(runtime.stdoutText()).data).toEqual({ status: "pending" });
  });

  it("relays a sensitive browser continuation through ephemeral browser memory", async () => {
    let operationCalls = 0;
    const secret = "tpc_secret_that_must_never_escape";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(specWithContinuations());
      operationCalls += 1;
      return Response.json({ data: { continuation: {
        url: "https://storefront.example.test/theme-preview/continue",
        fields: { continuationCode: secret },
      } } });
    });
    let relayHtml = "";
    const directory = await mkdtemp(join(tmpdir(), "scalius-cli-continuation-"));
    const runtime = createTestRuntime({
      directory,
      fetch: fetch as typeof globalThis.fetch,
      openUrl: async (url) => {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
        expect(url).not.toContain(secret);
        const response = await globalThis.fetch(url);
        expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'none'");
        relayHtml = await response.text();
      },
    });
    const store = new ConfigStore(runtime);
    await store.putProfile("default", "https://api.example.com");
    await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
    expect(await runProgram(runtime, [
      "--output", "json", "operations", "run", "dashboard.theme.preview_session_create",
      "--input", '{"body":{"expectedDraftRevision":1}}',
    ])).toBe(0);
    expect(operationCalls).toBe(1);
    expect(relayHtml).not.toContain(secret);
    expect(relayHtml).not.toContain("window.name");
    expect(relayHtml).toContain("Continue to storefront");
    expect(relayHtml).toContain("window.open");
    expect(relayHtml).toContain("scalius-continuation-ready-v1");
    expect(relayHtml).toContain("scalius-continuation-fields-v1");
    expect(relayHtml).not.toContain("form.submit");
    expect(relayHtml).toContain("https://storefront.example.test/theme-preview/continue");
    expect(runtime.stdoutText()).not.toContain(secret);
    expect(runtime.stderrText()).not.toContain(secret);
    expect(JSON.parse(runtime.stdoutText()).data).toEqual({
      status: "browser_continuation_opened",
      method: "POST",
      origin: "https://storefront.example.test",
    });
  });

  it("requires both confirmation and idempotency for declared writes", async () => {
    const spec = executableSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/api/v1/admin/products"]!.post!;
    (operation["x-scalius-agent"] as Record<string, unknown>).openWorld = true;
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/openapi.json")
      ? Response.json(spec)
      : Response.json({ id: "p1" }, { status: 201 }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    let exit = await runProgram(runtime, ["operations", "run", "dashboard.products.create", "--input", '{"body":{"name":"A"}}']);
    expect(exit).toBe(2);
    expect(runtime.stderrText()).toContain("--yes");

    const runtime2 = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    exit = await runProgram(runtime2, ["operations", "run", "dashboard.products.create", "--input", '{"body":{"name":"A"}}', "--yes"]);
    expect(exit).toBe(5);
    expect(runtime2.stderrText()).toContain("idempotency-key");

    const runtime3 = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    exit = await runProgram(runtime3, ["operations", "run", "dashboard.products.create", "--input", '{"body":{"name":"A"}}', "--yes", "--idempotency-key", "request-1"]);
    expect(exit).toBe(0);
  });

  it("accepts an exact-bound serialized UTF-8 JSON request", async () => {
    const body = { value: "boundary" };
    const serialized = JSON.stringify(body);
    let operationCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/openapi.json")) {
        return Response.json(specWithCreateRequestLimit(Buffer.byteLength(serialized, "utf8")));
      }
      operationCalls += 1;
      expect(init?.body).toBe(serialized);
      return Response.json({ id: "p1" }, { status: 201 });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.products.create",
      "--input", JSON.stringify({ body }),
      "--yes", "--idempotency-key", "request-boundary",
    ])).toBe(0);
    expect(operationCalls).toBe(1);
  });

  it("rejects a serialized JSON request one byte over the reviewed limit before fetch", async () => {
    const body = { value: "overrun" };
    const limit = Buffer.byteLength(JSON.stringify(body), "utf8") - 1;
    let operationCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(specWithCreateRequestLimit(limit));
      operationCalls += 1;
      return Response.json({});
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.products.create",
      "--input", JSON.stringify({ body }),
      "--yes", "--idempotency-key", "request-overrun",
    ])).toBe(5);
    expect(runtime.stderrText()).toContain(`exceeds the ${limit}-byte operation limit`);
    expect(operationCalls).toBe(0);
  });

  it("counts multibyte JSON as UTF-8 bytes rather than JavaScript characters", async () => {
    const body = { value: "é" };
    const serialized = JSON.stringify(body);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(serialized.length);
    let operationCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(specWithCreateRequestLimit(serialized.length));
      operationCalls += 1;
      return Response.json({});
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, [
      "operations", "run", "dashboard.products.create",
      "--input", JSON.stringify({ body }),
      "--yes", "--idempotency-key", "request-multibyte",
    ])).toBe(5);
    expect(operationCalls).toBe(0);
  });

  it("applies the JSON byte boundary to each resolved batch step before fetch", async () => {
    let operationCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(specWithCreateRequestLimit(16));
      operationCalls += 1;
      return Response.json({});
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    expect(await runProgram(runtime, [
      "operations", "batch", "--yes", "--input", JSON.stringify({ steps: [{
        operationId: "dashboard.products.create",
        idempotencyKey: "batch-request-boundary",
        input: { body: { value: "this is too large" } },
      }] }),
    ])).toBe(5);
    expect(runtime.stderrText()).toContain("Serialized JSON request exceeds");
    expect(operationCalls).toBe(0);
  });

  it("has no token, URL, method, or header execution flags", async () => {
    const runtime = await authenticatedRuntime(async () => Response.json(executableSpec()));
    const exit = await runProgram(runtime, ["operations", "run", "dashboard.products.get", "--url", "https://attacker.example"]);
    expect(exit).toBe(2);
    expect(runtime.stderrText()).toContain("unknown option '--url'");
  });

  it("uploads only contract-declared multipart files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-upload-"));
    const file = join(directory, "photo.txt");
    await writeFile(file, "media");
    let requestBody: BodyInit | null | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(executableSpec());
      requestBody = init?.body;
      return Response.json({ id: "media-1" }, { status: 201 });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, [
      "operations", "run", "dashboard.media.upload",
      "--input", '{"body":{"alt":"Photo"}}',
      "--file", `file=@${file}`,
      "--yes",
    ]);
    expect(exit).toBe(0);
    expect(requestBody).toBeInstanceOf(FormData);
    const form = requestBody as FormData;
    expect(form.get("alt")).toBe("Photo");
    expect((form.get("file") as File).name).toBe("photo.txt");

    const runtime2 = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const denied = await runProgram(runtime2, [
      "operations", "run", "dashboard.media.upload",
      "--file", `undeclared=@${file}`,
      "--yes",
    ]);
    expect(denied).toBe(5);
    expect(runtime2.stderrText()).toContain("not a contract-declared binary upload");
  });

  it("never exposes a --token option on auth or operation commands", async () => {
    const runtime = await authenticatedRuntime(async () => Response.json(executableSpec()));
    const exit = await runProgram(runtime, ["auth", "status", "--token", validToken()]);
    expect(exit).toBe(2);
    expect(runtime.stderrText()).toContain("unknown option '--token'");
  });

  it("emits one parseable JSON error document for JSON-mode usage failures", async () => {
    const runtime = await authenticatedRuntime(async () => Response.json(executableSpec()));
    const exit = await runProgram(runtime, ["--output", "json", "auth", "status", "--token", validToken()]);
    expect(exit).toBe(2);
    expect(() => JSON.parse(runtime.stderrText())).not.toThrow();
    expect(runtime.stderrText().match(/"error"/g)).toHaveLength(1);
  });

  it("maps HTTP responses to stable exit codes without echoing arbitrary error bodies", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/openapi.json")
      ? Response.json(executableSpec())
      : new Response("secret backend dump", { status: 403 }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, ["operations", "run", "dashboard.products.get", "--input", '{"path":{"id":"p1"}}']);
    expect(exit).toBe(4);
    expect(runtime.stderrText()).not.toContain("secret backend dump");
  });

  it("redacts credentials echoed by a structured server error", async () => {
    const credential = validToken();
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/openapi.json")
      ? Response.json(executableSpec())
      : Response.json({ code: "denied", message: `Do not show ${credential}` }, { status: 403 }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, ["operations", "run", "dashboard.products.get", "--input", '{"path":{"id":"p1"}}']);
    expect(exit).toBe(4);
    expect(runtime.stderrText()).not.toContain(credential);
    expect(runtime.stderrText()).toContain("[REDACTED_CREDENTIAL]");
  });

  it("accepts the direct bounded batch shape and runs fixed operations sequentially", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/openapi.json")) return Response.json(executableSpec());
      calls.push(url);
      return Response.json({ ok: true });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, [
      "--output", "json", "operations", "batch", "--input",
      JSON.stringify({
        steps: [
          { operationId: "dashboard.products.get", input: { path: { id: "p1" } } },
          { operationId: "dashboard.products.get", input: { path: { id: "p2" } } },
        ],
      }),
    ]);
    expect(exit).toBe(0);
    expect(calls).toEqual([
      "https://api.example.com/api/v1/admin/products/p1",
      "https://api.example.com/api/v1/admin/products/p2",
    ]);
    expect(JSON.parse(runtime.stdoutText()).count).toBe(2);
  });

  it("resolves bounded JSON Pointers from completed batch results", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/openapi.json")) return Response.json(executableSpec());
      calls.push(url);
      return Response.json({ product: { id: "p2" } });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, ["operations", "batch", "--input", JSON.stringify({ steps: [
      { operationId: "dashboard.products.get", input: { path: { id: "p1" } } },
      { operationId: "dashboard.products.get", input: { path: { id: { $ref: "#/results/0/data/product/id" } } } },
    ] })]);
    expect(exit).toBe(0);
    expect(calls).toEqual([
      "https://api.example.com/api/v1/admin/products/p1",
      "https://api.example.com/api/v1/admin/products/p2",
    ]);
  });

  it.each([
    ["forward", "#/results/1/data/product/id", "completed prior result"],
    ["self", "#/results/0/data/product/id", "completed prior result"],
    ["missing", "#/results/0/data/missing", "was not found"],
  ])("rejects %s batch references", async (_name, pointer, message) => {
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/openapi.json")
      ? Response.json(executableSpec())
      : Response.json({ product: { id: "p1" } }));
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const steps = pointer.includes("missing") ? [
      { operationId: "dashboard.products.get", input: { path: { id: "p1" } } },
      { operationId: "dashboard.products.get", input: { path: { id: { $ref: pointer } } } },
    ] : [
      { operationId: "dashboard.products.get", input: { path: { id: { $ref: pointer } } } },
      { operationId: "dashboard.products.get", input: { path: { id: "p2" } } },
    ];
    const exit = await runProgram(runtime, ["operations", "batch", "--input", JSON.stringify({ steps })]);
    expect(exit).toBe(5);
    expect(runtime.stderrText()).toContain(message);
  });

  it("bounds batch reference expansion", async () => {
    const huge = "x".repeat(600_000);
    let call = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/openapi.json")) return Response.json(executableSpec());
      call += 1;
      return Response.json({ first: huge, second: huge });
    });
    const runtime = await authenticatedRuntime(fetch as typeof globalThis.fetch);
    const exit = await runProgram(runtime, ["operations", "batch", "--input", JSON.stringify({ steps: [
      { operationId: "dashboard.products.get", input: { path: { id: "p1" } } },
      { operationId: "dashboard.products.get", input: { path: { id: { $ref: "#/results/0/data" } } } },
    ] })]);
    expect(exit).toBe(5);
    expect(runtime.stderrText()).toContain("Expanded batch input exceeds");
    expect(call).toBe(1);
  });
});
