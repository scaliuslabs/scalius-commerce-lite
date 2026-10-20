import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { DEFAULT_STORE, startLocalApi, type LocalApi } from "./fixtures/local-api.js";
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
  api.state.approvals.clear();
  api.state.dialogs = 0;
  api.state.approvalOff = false;
  api.state.bulkWrites.length = 0;
  api.state.bulkDryRuns.length = 0;
  api.state.bulkRunReads = 0;
  api.state.batchWrites = 0;
  api.state.store = { ...DEFAULT_STORE };
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

  it("(c) a gated write off a terminal gets the server's approval link: exit 10, nothing sent after it, --yes changes nothing", async () => {
    const runtime = await pairedRuntime();
    const exit = await runProgram(runtime, ["write", "dashboard.orders.refund", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}']);
    expect(exit).toBe(10);
    const writes = toolCalls().filter((call) => call.tool === "scalius_write");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.arguments).not.toHaveProperty("approvalId");
    expect(writes[0]!.arguments).not.toHaveProperty("dryRun");
    expect(api.state.refunds).toEqual([]);
    expect(api.state.dialogs).toBe(0);
    const error = JSON.parse(runtime.stderrText()) as { ok: boolean; error: Record<string, unknown> };
    expect(error).toMatchObject({ ok: false, error: { code: "confirmation_required", status: 428 } });
    expect(String(error.error.message)).toContain("Process order refund: id=ord_1, amount=500");
    expect(String(error.error.message)).toContain(`${api.origin}/admin/settings/agent-access/approve/abh_`);
    expect(String(error.error.hint)).toContain("--approval abh_");

    // An agent's --yes off a terminal is refused, pointing at the approval link.
    const agent = await pairedRuntime();
    expect(await runProgram(agent, ["write", "dashboard.orders.refund", "--yes", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(10);
    expect(String((JSON.parse(agent.stderrText()) as { error: { message: string } }).error.message)).toMatch(/--yes cannot approve this change.*approve\/abh_/);
    expect(api.state.refunds).toEqual([]);
  });

  it("previews with --dry-run (exit 11, nothing written) and writes once with the merchant's --approval", async () => {
    const preview = await pairedRuntime();
    expect(await runProgram(preview, ["write", "dashboard.orders.refund", "--dry-run", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(11);
    expect(JSON.parse(preview.stdoutText())).toMatchObject({ ok: true, dryRun: true, written: false, confirmation: { summary: expect.any(String), approvalRequired: true } });
    expect(api.state.refunds).toHaveLength(0);

    const refused = await pairedRuntime();
    expect(await runProgram(refused, ["write", "dashboard.orders.refund", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(10);
    const [approvalId] = [...api.state.approvals.keys()];
    // Not approved yet: still exit 10, nothing written.
    const early = await pairedRuntime();
    expect(await runProgram(early, ["write", "dashboard.orders.refund", "--approval", approvalId!, "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(10);
    expect(api.state.refunds).toHaveLength(0);

    api.state.approvals.set(approvalId!, "approved");
    const approved = await pairedRuntime();
    expect(await runProgram(approved, ["write", "dashboard.orders.refund", "--approval", approvalId!, "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(0);
    expect(api.state.refunds).toHaveLength(1);
    expect(JSON.parse(approved.stdoutText())).toMatchObject({ ok: true, data: { refundId: "rfd_1" } });
  });

  it("asks the merchant at a terminal through the server's dialog; a no writes nothing", async () => {
    const answer = async (line: string) => {
      const directory = await mkdtemp(join(tmpdir(), "scalius-agent-cli-"));
      const runtime = createTestRuntime({ directory, fetch: globalThis.fetch, tty: true, stdin: line });
      runtime.stdin.isTTY = true;
      runtime.stderr.isTTY = true;
      const store = new ConfigStore(runtime);
      await store.putProfile("default", api.origin);
      await store.putCredential("default", { token: api.token, resource: "dashboard", createdAt: "2026-08-13T00:00:00.000Z" });
      return runtime;
    };
    const yes = await answer("y\n");
    expect(await runProgram(yes, ["write", "dashboard.orders.refund", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(0);
    expect(yes.stderrText()).toContain("Approve: Process order refund: id=ord_1, amount=500");
    expect(api.state.dialogs).toBe(1);
    expect(api.state.refunds).toHaveLength(1);
    const call = toolCalls().filter((request) => request.tool === "scalius_write").at(-1)!;
    expect(JSON.parse(call.body).params).toMatchObject({ inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, requestState: "dialog-state" });

    const no = await answer("n\n");
    expect(await runProgram(no, ["write", "dashboard.orders.refund", "--input", '{"path":{"id":"ord_1"},"body":{"amount":500}}'])).toBe(10);
    expect(api.state.refunds).toHaveLength(1);
  });

  it("batch: the 428 covers the whole batch; --approval repeats the identical steps once", async () => {
    const steps = '{"steps":[{"id":"refund","operationId":"dashboard.orders.refund","input":{"path":{"id":"ord_1"},"body":{"amount":500}}}]}';
    const refused = await pairedRuntime();
    expect(await runProgram(refused, ["batch", "--yes", "--input", steps])).toBe(10);
    expect(toolCalls().filter((call) => call.tool === "scalius_write")).toHaveLength(1);
    expect(api.state.batchWrites).toBe(0);
    expect(JSON.parse(refused.stderrText())).toMatchObject({ ok: false, error: { code: "confirmation_required", status: 428 } });

    const [approvalId] = [...api.state.approvals.keys()];
    api.state.approvals.set(approvalId!, "approved");
    api.requests.length = 0;
    const approved = await pairedRuntime();
    expect(await runProgram(approved, ["batch", "--approval", approvalId!, "--input", steps])).toBe(0);
    const writes = toolCalls().filter((call) => call.tool === "scalius_write");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.arguments).toMatchObject({ approvalId });
    expect(api.state.batchWrites).toBe(1);
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
    expect(await runProgram(runtime, ["bulk", "status", "--ids", "prod_1", "--status", "draft", "--dry-run"])).toBe(5);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({ error: { code: "bulk_unavailable" } });
    expect(toolCalls()).toEqual([]);
  });
});

describe("scalius bulk", () => {
  const bulkBody = () => api.state.bulkWrites.at(-1)!.input;
  // These grants run price changes without asking (their owner turned approval off); the gated case turns it on.
  beforeEach(() => { api.state.approvalOff = true; });

  it("builds the prices body from friendly flags: --set, --percent and --amount, by ids or filter", async () => {
    const set = await pairedRuntime();
    expect(await runProgram(set, ["bulk", "prices", "--ids", "var_1, var_2", "--set", "1500", "--yes"])).toBe(0);
    expect(bulkBody()).toEqual({ variants: [{ id: "var_1" }, { id: "var_2" }], change: { mode: "set", amountMinor: 150000 } });

    const percent = await pairedRuntime();
    expect(await runProgram(percent, ["bulk", "prices", "--filter", "category=Shoes", "--percent", "5", "--yes"])).toBe(0);
    expect(bulkBody()).toEqual({ filter: { category: "Shoes" }, change: { mode: "percent", percent: 5 } });

    const amount = await pairedRuntime();
    expect(await runProgram(amount, ["bulk", "prices", "--ids", "var_1", "--amount", "-100", "--yes"])).toBe(0);
    expect(bulkBody()).toEqual({ variants: [{ id: "var_1" }], change: { mode: "amount", amountMinor: -10000 } });

    const fraction = await pairedRuntime();
    expect(await runProgram(fraction, ["bulk", "prices", "--ids", "var_1", "--percent=-12.5", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "percent", percent: -12.5 } });
  });

  it("takes --set and --amount in the store currency and converts them with its decimal places", async () => {
    const taka = await pairedRuntime();
    expect(await runProgram(taka, ["bulk", "prices", "--ids", "var_1", "--set", "1500.5", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "set", amountMinor: 150050 } });

    const cents = await pairedRuntime();
    expect(await runProgram(cents, ["bulk", "prices", "--ids", "var_1", "--amount", "19.99", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "amount", amountMinor: 1999 } });

    api.state.store = { name: "Tokyo", currency: "JPY", decimals: 0, timeZone: "Asia/Tokyo" };
    const yen = await pairedRuntime();
    expect(await runProgram(yen, ["bulk", "prices", "--ids", "var_1", "--set", "1500", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "set", amountMinor: 1500 } });

    api.state.store = { name: "Kuwait", currency: "KWD", decimals: 3, timeZone: "Asia/Kuwait" };
    const dinar = await pairedRuntime();
    expect(await runProgram(dinar, ["bulk", "prices", "--ids", "var_1", "--set", "2.5", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "set", amountMinor: 2500 } });
  });

  it("falls back to the currency's own decimals when the store does not report them", async () => {
    api.state.store = { name: "Old API", currency: "JPY", timeZone: "Asia/Tokyo" };
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["bulk", "prices", "--ids", "var_1", "--set", "800", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "set", amountMinor: 800 } });
  });

  it("--minor keeps minor units as the amount, and --percent needs neither", async () => {
    const minor = await pairedRuntime();
    expect(await runProgram(minor, ["bulk", "prices", "--ids", "var_1", "--set", "150000", "--minor", "--yes"])).toBe(0);
    expect(bulkBody()).toMatchObject({ change: { mode: "set", amountMinor: 150000 } });
    expect(api.requests.filter((request) => request.rpcMethod === "resources/read")).toEqual([]);

    const percent = await pairedRuntime();
    expect(await runProgram(percent, ["bulk", "prices", "--ids", "var_1", "--percent", "5", "--yes"])).toBe(0);
    expect(api.requests.filter((request) => request.rpcMethod === "resources/read")).toEqual([]);
  });

  it("refuses an amount the currency cannot hold, or --minor where it means nothing, before writing", async () => {
    const cases: Array<{ argv: string[]; message: RegExp }> = [
      { argv: ["bulk", "prices", "--ids", "var_1", "--set", "10.555"], message: /BDT has 2 decimal places/ },
      { argv: ["bulk", "prices", "--ids", "var_1", "--set", "1,500"], message: /amount in BDT/ },
      { argv: ["bulk", "prices", "--ids", "var_1", "--set", "-5"], message: /must not be negative/ },
      { argv: ["bulk", "prices", "--ids", "var_1", "--percent", "5", "--minor"], message: /--minor goes with/ },
      { argv: ["bulk", "tags", "--ids", "cus_1", "--add", "VIP", "--minor"], message: /--minor goes with/ },
    ];
    for (const { argv, message } of cases) {
      const runtime = await pairedRuntime();
      expect(await runProgram(runtime, argv)).toBe(2);
      expect(JSON.parse(runtime.stderrText()).error.message).toMatch(message);
    }
    expect(api.state.bulkWrites).toEqual([]);
  });

  it("says --minor is needed when the store does not report a currency", async () => {
    api.state.store = { name: "Odd", currency: "", timeZone: "UTC" };
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["bulk", "prices", "--ids", "var_1", "--set", "10", "--yes"])).toBe(5);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({ error: { code: "store_currency_unknown", hint: expect.stringContaining("--minor") } });
    expect(api.state.bulkWrites).toEqual([]);
  });

  it("builds the stock, tags and the other bodies", async () => {
    const stock = await pairedRuntime();
    expect(await runProgram(stock, ["bulk", "stock", "--items", "var_1=20,var_2=0", "--location", "loc_1", "--reason", "Stocktake"])).toBe(0);
    expect(api.state.bulkWrites.at(-1)).toMatchObject({
      operationId: "dashboard.resources.variants.bulk_set_stock",
      input: { locationId: "loc_1", items: [{ variantId: "var_1", quantity: 20 }, { variantId: "var_2", quantity: 0 }], reason: "Stocktake" },
    });

    const sameCount = await pairedRuntime();
    expect(await runProgram(sameCount, ["bulk", "stock", "--ids", "var_1,var_2", "--quantity", "0"])).toBe(0);
    expect(bulkBody()).toEqual({ items: [{ variantId: "var_1", quantity: 0 }, { variantId: "var_2", quantity: 0 }] });

    const tags = await pairedRuntime();
    expect(await runProgram(tags, ["bulk", "tags", "--filter", "tag=lead,minOrders=4", "--add", "VIP,loyal", "--remove", "cold"])).toBe(0);
    expect(api.state.bulkWrites.at(-1)).toMatchObject({
      operationId: "dashboard.resources.customers.bulk_tag",
      input: { filter: { tag: "lead", minOrders: 4 }, add: ["VIP", "loyal"], remove: ["cold"] },
    });
    const byIds = await pairedRuntime();
    expect(await runProgram(byIds, ["bulk", "tags", "--ids", "cus_1", "--add", "VIP"])).toBe(0);
    expect(bulkBody()).toEqual({ customerIds: ["cus_1"], add: ["VIP"] });
  });

  it("sends --input as the raw body and refuses to mix it with the friendly flags", async () => {
    const raw = await pairedRuntime();
    const body = { variants: [{ id: "var_1", expectedPriceMinor: 1000 }], change: { mode: "set", amountMinor: 1200 } };
    expect(await runProgram(raw, ["bulk", "prices", "--input", JSON.stringify({ body }), "--yes"])).toBe(0);
    expect(bulkBody()).toEqual(body);

    const mixed = await pairedRuntime();
    expect(await runProgram(mixed, ["bulk", "prices", "--input", JSON.stringify({ body }), "--percent", "5"])).toBe(2);
    expect(JSON.parse(mixed.stderrText())).toMatchObject({ error: { code: "invalid_input" } });
    expect(api.state.bulkWrites).toHaveLength(1);
  });

  it("refuses a request it can see is wrong before sending anything", async () => {
    const cases: string[][] = [
      ["bulk", "prices", "--ids", "var_1"],
      ["bulk", "prices", "--set", "1500"],
      ["bulk", "prices", "--ids", "var_1", "--set", "10", "--percent", "5"],
      ["bulk", "prices", "--ids", "var_1", "--filter", "category=x", "--set", "10"],
      ["bulk", "prices", "--filter", "colour=red", "--set", "10"],
      ["bulk", "prices", "--ids", "var_1", "--set", "ten"],
      ["bulk", "tags", "--ids", "cus_1"],
      ["bulk", "stock", "--filter", "category=x"],
    ];
    for (const argv of cases) {
      const runtime = await pairedRuntime();
      expect(await runProgram(runtime, argv)).toBe(2);
    }
    expect(toolCalls().filter((call) => call.tool === "scalius_write")).toEqual([]);
  });

  it("--dry-run sends dryRun: true and writes nothing (exit 11)", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["bulk", "prices", "--ids", "var_1,var_2", "--percent", "5", "--dry-run"])).toBe(11);
    expect(api.state.bulkDryRuns).toEqual([{
      operationId: "dashboard.resources.variants.bulk_set_prices",
      input: { variants: [{ id: "var_1" }, { id: "var_2" }], change: { mode: "percent", percent: 5 }, dryRun: true },
    }]);
    expect(api.state.bulkWrites).toEqual([]);
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ ok: true, dryRun: true, written: false, currency: { code: "BDT", decimals: 2 } });
  });

  it("a prices dry run names the currency and the change in it, in text and JSON", async () => {
    const terminal = await pairedRuntime({ tty: true });
    expect(await runProgram(terminal, ["bulk", "prices", "--ids", "var_1", "--set", "1500", "--dry-run"])).toBe(11);
    expect(terminal.stdoutText()).toContain("Currency: BDT (2 decimal places); set every price to 1500.00 BDT.");
    expect(api.state.bulkDryRuns.at(-1)!.input).toMatchObject({ change: { mode: "set", amountMinor: 150000 }, dryRun: true });

    const percent = await pairedRuntime({ tty: true });
    expect(await runProgram(percent, ["bulk", "prices", "--ids", "var_1", "--percent", "5", "--dry-run"])).toBe(11);
    expect(percent.stdoutText()).toContain("Currency: BDT (2 decimal places); change every price by 5%.");
  });

  it("a gated bulk change: 428 with the server's summary, then the identical request with the approval and the same Idempotency-Key", async () => {
    api.state.approvalOff = false;
    const refused = await pairedRuntime();
    expect(await runProgram(refused, ["bulk", "prices", "--ids", "var_1,var_2", "--percent", "5", "--yes"])).toBe(10);
    expect(JSON.parse(refused.stderrText())).toMatchObject({ error: { code: "confirmation_required", status: 428, message: expect.stringContaining("Change the price of 2 SKUs by 5%") } });
    expect(api.state.bulkWrites).toEqual([]);
    expect(toolCalls().filter((call) => call.tool === "scalius_write")).toHaveLength(1);

    const [approvalId] = [...api.state.approvals.keys()];
    api.state.approvals.set(approvalId!, "approved");
    api.requests.length = 0;
    const approved = await pairedRuntime();
    expect(await runProgram(approved, ["bulk", "prices", "--ids", "var_1,var_2", "--percent", "5", "--approval", approvalId!])).toBe(0);
    const writes = toolCalls().filter((call) => call.tool === "scalius_write");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.arguments).toMatchObject({ approvalId, idempotencyKey: expect.stringMatching(/^sck_[0-9a-f-]{36}$/) });
    expect(api.state.bulkWrites).toHaveLength(1);
    expect(api.state.bulkWrites[0]).toMatchObject({ approvalId });
    expect(JSON.parse(approved.stdoutText())).toMatchObject({ ok: true, data: { id: "bulk_bbbb", status: "done" }, meta: { status: 200 } });

    // An approval works once.
    const again = await pairedRuntime();
    expect(await runProgram(again, ["bulk", "prices", "--ids", "var_1,var_2", "--percent", "5", "--approval", approvalId!])).not.toBe(0);
    expect(api.state.bulkWrites).toHaveLength(1);
  });

  it("the same Idempotency-Key replays the first run, never a second", async () => {
    const first = await pairedRuntime();
    expect(await runProgram(first, ["bulk", "prices", "--ids", "var_1", "--set", "900", "--yes"])).toBe(0);
    const { idempotencyKey } = api.state.bulkWrites[0]!;
    const replay = await pairedRuntime();
    expect(await runProgram(replay, ["write", "dashboard.resources.variants.bulk_set_prices", "--idempotency-key", idempotencyKey!, "--input", JSON.stringify({ body: api.state.bulkWrites[0]!.input })])).toBe(0);
    expect(api.state.bulkWrites).toHaveLength(1);
    expect(JSON.parse(replay.stdoutText())).toMatchObject({ meta: { replayed: true } });
  });

  it("a 202 run without --wait prints the running run and where to follow it; --wait polls bulk_runs.get by data.id", async () => {
    const quick = await pairedRuntime();
    expect(await runProgram(quick, ["bulk", "prices", "--filter", "category=Shoes", "--percent", "5", "--yes"])).toBe(0);
    expect(JSON.parse(quick.stdoutText())).toMatchObject({ data: { id: "bulk_aaaa", status: "running" }, meta: { status: 202 } });
    expect(quick.stderrText()).toContain('"id":"bulk_aaaa"');
    expect(api.state.bulkRunReads).toBe(0);

    const waited = await pairedRuntime();
    expect(await runProgram(waited, ["bulk", "prices", "--filter", "category=Shoes", "--percent", "5", "--yes", "--wait"])).toBe(0);
    const reads = toolCalls().filter((call) => call.tool === "scalius_read");
    expect(reads).toHaveLength(2);
    expect(reads[0]!.arguments).toMatchObject({ operationId: "dashboard.resources.bulk_runs.get", input: { path: { id: "bulk_aaaa" } } });
    expect(waited.sleeps).toEqual([2_000, 2_000]);
    // Only the finished run is printed.
    expect(JSON.parse(waited.stdoutText())).toMatchObject({ ok: true, data: { id: "bulk_aaaa", status: "done", processed: 300, failed: 2 } });
  });

  it("--wait on a run that finished in its request prints it without polling", async () => {
    const runtime = await pairedRuntime();
    expect(await runProgram(runtime, ["bulk", "tags", "--ids", "cus_1", "--add", "VIP", "--wait"])).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ data: { id: "bulk_bbbb", status: "done" } });
    expect(api.state.bulkRunReads).toBe(0);
  });
});
