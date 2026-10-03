// The storage helpers the runtime builds over the bridge (the same code in
// both loaders), run against the test harness: revisions and conditional
// writes, lost-update-free merges, bounded increments that never overspend
// under interleaved callers, all-or-nothing batches and KV compare-and-set.
import { describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";
import type { PluginContext } from "./context";
import { createPluginTestHarness } from "./testing";

type Job = (ctx: PluginContext) => Promise<unknown>;

/** A plugin whose admin route runs the job the test hands it. */
function harnessFor() {
  const jobs = new Map<string, Job>();
  const module = {
    default: {
      manifest: {
        id: "acme.points",
        name: "Points",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        description: "Points.",
        author: { name: "Acme" },
        routes: { admin: [{ name: "run", methods: ["POST"] }] },
        storage: { balances: {}, ledger: { unique: ["ref"] } },
      },
      routes: {
        admin: {
          run: async (request: { query: Record<string, string> }, ctx: PluginContext) => {
            try {
              return { body: { ok: true, value: await jobs.get(request.query.job!)!(ctx) } };
            } catch (error) {
              return { body: { ok: false, code: (error as { code?: string }).code ?? null } };
            }
          },
        },
      },
    },
  };
  const harness = createPluginTestHarness(module);
  let next = 0;
  const run = async (job: Job) => {
    const name = `job${next += 1}`;
    jobs.set(name, job);
    const result = await harness.route("admin", "run", { method: "POST", query: { job: name } });
    return (result.value as { body: { ok: boolean; value?: unknown; code?: string | null } }).body;
  };
  return { harness, run };
}

describe("plugin storage helpers", () => {
  it("writes conditionally on the revision read", async () => {
    const { run } = harnessFor();
    expect(await run((ctx) => ctx.storage.balances!.put("c1", { points: 10 }, { expectedRevision: null }))).toEqual({ ok: true, value: { revision: 1 } });
    expect(await run((ctx) => ctx.storage.balances!.put("c1", { points: 11 }, { expectedRevision: null }))).toEqual({ ok: false, code: "storage.conflict" });
    expect(await run((ctx) => ctx.storage.balances!.getVersion("c1"))).toEqual({ ok: true, value: { data: { points: 10 }, revision: 1 } });
    expect(await run((ctx) => ctx.storage.balances!.put("c1", { points: 12 }, { expectedRevision: 1 }))).toEqual({ ok: true, value: { revision: 2 } });
    expect(await run((ctx) => ctx.storage.balances!.delete("c1", { expectedRevision: 1 }))).toEqual({ ok: false, code: "storage.conflict" });
    expect(await run((ctx) => ctx.storage.balances!.delete("c1"))).toEqual({ ok: true, value: true });
    expect(await run((ctx) => ctx.storage.balances!.delete("c1"))).toEqual({ ok: true, value: false });
  });

  it("merges updates without losing a concurrent one and honours a pinned revision", async () => {
    const { run } = harnessFor();
    await run((ctx) => ctx.storage.balances!.put("c1", { points: 1, tier: "bronze" }));
    await Promise.all([
      run((ctx) => ctx.storage.balances!.update("c1", { tier: "silver" })),
      run((ctx) => ctx.storage.balances!.update("c1", { nickname: "Ana" })),
    ]);
    expect(await run((ctx) => ctx.storage.balances!.getVersion("c1")))
      .toEqual({ ok: true, value: { data: { points: 1, tier: "silver", nickname: "Ana" }, revision: 3 } });
    expect(await run((ctx) => ctx.storage.balances!.update("c1", { tier: "gold" }, { expectedRevision: 2 }))).toEqual({ ok: false, code: "storage.conflict" });
    expect(await run((ctx) => ctx.storage.balances!.update("c9", { tier: "gold" }))).toEqual({ ok: false, code: "storage.not_found" });
  });

  it("never spends a balance twice when debits race", async () => {
    const { run } = harnessFor();
    await run((ctx) => ctx.storage.balances!.put("c1", { points: 100 }));
    const debits = await Promise.all(Array.from({ length: 5 }, () =>
      run((ctx) => ctx.storage.balances!.increment("c1", "points", -40, { min: 0 }))));
    expect(debits.filter((debit) => debit.ok)).toHaveLength(2);
    expect(debits.filter((debit) => !debit.ok).every((debit) => debit.code === "storage.out_of_range")).toBe(true);
    expect(await run((ctx) => ctx.storage.balances!.get("c1"))).toEqual({ ok: true, value: { points: 20 } });
    expect(await run((ctx) => ctx.storage.balances!.increment("c2", "points", 5))).toEqual({ ok: true, value: { value: 5, revision: 1 } });
  });

  it("writes a batch across collections all-or-nothing", async () => {
    const { run, harness } = harnessFor();
    await run((ctx) => ctx.storage.balances!.put("c1", { points: 100 }));
    const earn = (ctx: PluginContext) => ctx.storage.batch([
      { op: "put", collection: "ledger", id: "earn:o1", record: { ref: "o1", points: 50 }, expectedRevision: null },
      { op: "put", collection: "balances", id: "c1", record: { points: 150 }, expectedRevision: 1 },
    ]);
    expect(await run(earn)).toEqual({ ok: true, value: { revisions: [1, 2] } });
    // Redelivered: the ledger entry exists, so nothing changes.
    expect(await run(earn)).toEqual({ ok: false, code: "storage.conflict" });
    expect(harness.records.get("balances")!.get("c1")).toEqual({ points: 150 });
    expect(await run((ctx) => ctx.storage.batch([
      { op: "put", collection: "balances", id: "c1", record: { points: 0 } },
      { op: "put", collection: "ledger", id: "earn:o2", record: { ref: "o1" } },
    ]))).toEqual({ ok: false, code: "storage.unique_violation" });
    expect(harness.records.get("balances")!.get("c1")).toEqual({ points: 150 });
  });

  it("compare-and-sets KV entries", async () => {
    const { run } = harnessFor();
    expect(await run((ctx) => ctx.kv.compareAndSet("lock", null, "a"))).toEqual({ ok: true, value: { revision: 1 } });
    expect(await run((ctx) => ctx.kv.compareAndSet("lock", null, "b"))).toEqual({ ok: false, code: "kv.conflict" });
    expect(await run((ctx) => ctx.kv.getVersion("lock"))).toEqual({ ok: true, value: { value: "a", revision: 1 } });
    expect(await run((ctx) => ctx.kv.set("lock", "c"))).toEqual({ ok: true, value: { revision: 2 } });
    expect(await run((ctx) => ctx.kv.get("lock"))).toEqual({ ok: true, value: "c" });
  });
});
