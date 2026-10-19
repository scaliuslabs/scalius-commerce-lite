import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { startLocalApi, type LocalApi } from "./fixtures/local-api.js";
import { createTestRuntime, type TestRuntime } from "./helpers.js";

let api: LocalApi;

beforeAll(async () => {
  api = await startLocalApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.requests.length = 0;
  api.state.refunds.length = 0;
  api.state.products.length = 0;
  api.state.failNextProductCreate = 0;
});

async function pairedRuntime(options: { tty?: boolean } = {}): Promise<TestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "scalius-agent-cli-"));
  const runtime = createTestRuntime({ directory, fetch: globalThis.fetch, tty: options.tty ?? false });
  const store = new ConfigStore(runtime);
  await store.putProfile("default", api.origin);
  await store.putCredential("default", { token: api.token, resource: "dashboard", createdAt: "2026-08-13T00:00:00.000Z" });
  return runtime;
}

const toolCalls = () => api.requests.filter((request) => request.rpcMethod === "tools/call");

describe("agent commands over the store's MCP tools", () => {
  it("prints one JSON envelope when piped and text on a terminal", async () => {
    const piped = await pairedRuntime();
    expect(await runProgram(piped, ["ask", "How", "much", "did", "we", "sell", "today?"])).toBe(0);
    const envelope = JSON.parse(piped.stdoutText()) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ok: true, data: { kind: "result", workflowId: "operations.sales-today.v1" } });
    const call = toolCalls()[0]!;
    expect(call.tool).toBe("scalius_answer");
    expect(call.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(call.headers["mcp-method"]).toBe("tools/call");
    expect(call.headers["mcp-name"]).toBe("scalius_answer");

    const terminal = await pairedRuntime({ tty: true });
    expect(await runProgram(terminal, ["search", "refund", "an", "order"])).toBe(0);
    expect(terminal.stdoutText()).toContain("dashboard.order-refund");
    expect(terminal.stdoutText()).toContain("Steps for dashboard.order-refund: dashboard.orders.payments -> dashboard.orders.refund");
    expect(() => JSON.parse(terminal.stdoutText())).toThrow();
  });

  it("(b) streams every row of a 3-page read as NDJSON: line count equals the server total", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["read", "dashboard.orders.list", "--all", "--ndjson"])).toBe(0);
    const lines = runtime.stdoutText().trim().split("\n");
    expect(lines).toHaveLength(api.state.orders.length);
    expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(api.state.orders.map((order) => order.id));
    const reads = toolCalls().filter((call) => call.tool === "scalius_read");
    expect(reads).toHaveLength(3);
    expect(reads[0]!.arguments?.cursor).toBeUndefined();
    expect(reads[1]!.arguments?.cursor).toMatch(/^sc1\./);
  });

  it("applies --select and the built-in --jq to the data", async () => {
    const selected = await pairedRuntime();
    expect(await runProgram(selected, ["--select", "/items/*/id", "read", "dashboard.orders.list"])).toBe(0);
    expect(toolCalls()[0]!.arguments?.select).toEqual(["/items/*/id"]);

    const filtered = await pairedRuntime();
    expect(await runProgram(filtered, ["--jq", ".items[] | select(.number > 1041) | .id", "read", "dashboard.orders.list"])).toBe(0);
    expect(filtered.stdoutText().trim().split("\n")).toEqual(["ord_3"]);

    const allRows = await pairedRuntime();
    expect(await runProgram(allRows, ["--jq", ".number", "read", "dashboard.orders.list", "--all"])).toBe(0);
    expect(allRows.stdoutText().trim().split("\n").map(Number)).toEqual(api.state.orders.map((order) => order.number));
  });

  it("(c) refuses a gated write without --yes: exit 10 and no request with a body", async () => {
    const runtime = await pairedRuntime();
    const exit = await runProgram(runtime, ["write", "dashboard.orders.refund", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}']);
    expect(exit).toBe(10);
    expect(api.requests.filter((request) => request.body.length > 0)).toEqual([]);
    expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    expect(api.state.refunds).toEqual([]);
    const error = JSON.parse(runtime.stderrText()) as { ok: boolean; error: Record<string, unknown> };
    expect(error).toMatchObject({ ok: false, error: { code: "confirmation_required", status: 428 } });
    expect(String(error.error.message)).toContain("Process order refund: id=ord_1, amount=500");
    expect(String(error.error.hint)).toContain("--yes");
  });

  it("previews with --dry-run (exit 11, nothing written) and writes once with --yes", async () => {
    const preview = await pairedRuntime();
    expect(await runProgram(preview, ["write", "dashboard.orders.refund", "--dry-run", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(11);
    expect(JSON.parse(preview.stdoutText())).toMatchObject({ ok: true, dryRun: true, written: false, confirmation: { summary: expect.any(String), confirmToken: expect.any(String) } });
    expect(api.state.refunds).toHaveLength(0);

    const approved = await pairedRuntime();
    expect(await runProgram(approved, ["write", "dashboard.orders.refund", "--yes", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(0);
    expect(api.state.refunds).toHaveLength(1);
    const writes = toolCalls().filter((call) => call.tool === "scalius_write");
    expect(writes.at(-2)!.arguments).toMatchObject({ dryRun: true });
    expect(writes.at(-1)!.arguments).toMatchObject({ confirmToken: expect.stringMatching(/^sct_/) });
    expect(JSON.parse(approved.stdoutText())).toMatchObject({ ok: true, data: { refundId: "rfd_1" } });
  });

  it("sends one automatic idempotency key per write and reuses it on a retry", async () => {
    api.state.failNextProductCreate = 1;
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["write", "dashboard.products.create", "--input", '{"body":{"name":"Cotton Panjabi"}}'])).toBe(0);
    expect(api.state.products).toHaveLength(2);
    const [first, second] = api.state.products;
    expect(first!.idempotencyKey).toMatch(/^sck_[0-9a-f-]{36}$/);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ ok: true, meta: { idempotencyKey: first!.idempotencyKey } });

    const next = await pairedRuntime();
    expect(await runProgram(next, ["write", "dashboard.products.create", "--input", '{"body":{"name":"Shirt"}}'])).toBe(0);
    expect(api.state.products.at(-1)!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it("maps a tool error to its exit code with the hint on stderr", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["read", "dashboard.orders.list", "--cursor", "sc1.e30"])).toBe(0);
    const missing = await pairedRuntime();
    expect(await runProgram(missing, ["read", "dashboard.products.list"])).toBe(5);
    expect(JSON.parse(missing.stderrText())).toMatchObject({ ok: false, error: { code: "operation_not_found" } });
  });

  it("emits the command tree and exit codes with --help --json", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["--help", "--json"])).toBe(0);
    const tree = JSON.parse(runtime.stdoutText()) as { command: { commands: Array<{ name: string }> }; exitCodes: Record<string, string> };
    const names = tree.command.commands.map((command) => command.name);
    for (const name of ["init", "doctor", "ask", "search", "describe", "read", "write", "batch", "bulk", "export", "mcp"]) expect(names).toContain(name);
    expect(tree.exitCodes["10"]).toContain("approval");
    expect(tree.exitCodes["11"]).toContain("dry run");

    const write = await pairedRuntime();
    expect(await runProgram(write, ["write", "--help", "--json"])).toBe(0);
    const command = (JSON.parse(write.stdoutText()) as { command: { path: string; options: Array<{ flags: string }> } }).command;
    expect(command.path).toBe("scalius write");
    expect(command.options.map((option) => option.flags)).toEqual(expect.arrayContaining(["--dry-run", "--yes", "--idempotency-key <key>"]));
  });

  it("reports a bulk kind the store's API does not offer yet without sending anything", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["bulk", "prices", "--ids", "var_1", "--set", '{"percent":5}', "--dry-run"])).toBe(5);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({ error: { code: "bulk_unavailable" } });
    expect(toolCalls()).toEqual([]);
  });
});
