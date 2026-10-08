// The plugin cron tick with the bundled loader on the migrated schema: a due
// slot runs once even when two ticks race, slots before activation never
// run, the tick is bounded (run cap), a stale lease is failed, an inactive
// plugin's jobs are skipped, and with no active job a tick reads one index.
import type { DatabaseSync } from "node:sqlite";
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { deactivatePlugin, listPluginLogs, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { runDuePluginCron } from "./cron";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

describe("plugin cron tick", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let activatedAt: number;

  // acme.hello's `tidy` runs at minute 0 of every hour (store time).
  const nextHourAfter = (seconds: number) => (Math.floor(seconds / 3600) + 1) * 3600 * 1000;
  const tick = (nowMs: number, options: { maxRuns?: number } = {}) => runDuePluginCron({ db, env, ctx: pluginTestCtx(), nowMs, ...options });

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    activatedAt = (await installHello(db, sqlite)).activatedAt!;
  });
  afterEach(() => sqlite.close());

  it("runs a due slot exactly once, even when two ticks race for it", async () => {
    const slotMs = nextHourAfter(activatedAt);
    const [left, right] = await Promise.all([tick(slotMs + 5 * 60_000), tick(slotMs + 5 * 60_000)]);
    expect(left.ran + right.ran).toBe(1);
    expect(left.skipped + right.skipped).toBe(1);
    expect(sqlite.prepare("SELECT plugin_id, cron_name, scheduled_for, status FROM plugin_cron_runs").all()).toEqual([
      { plugin_id: "acme.hello", cron_name: "tidy", scheduled_for: slotMs / 1000, status: "succeeded" },
    ]);
    // The next tick inside the same hour finds the slot taken; the next hour runs again.
    expect(await tick(slotMs + 20 * 60_000)).toMatchObject({ due: 1, ran: 0, skipped: 1 });
    expect(await tick(slotMs + 3_600_000)).toMatchObject({ due: 1, ran: 1 });
    expect((await listPluginLogs(db, "acme.hello")).filter((line) => line.source === "cron:tidy")).toHaveLength(2);
  });

  it("never runs a slot from before the plugin's activation, and honours the run cap", async () => {
    expect(await tick((activatedAt - 60) * 1000)).toMatchObject({ due: 0, ran: 0 });
    const slotMs = nextHourAfter(activatedAt);
    expect(await tick(slotMs, { maxRuns: 0 })).toMatchObject({ due: 1, ran: 0, deferred: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_cron_runs").get()).toEqual({ n: 0 });
  });

  it("fails a run whose lease ran out so the job can run again, and skips inactive plugins", async () => {
    const slotMs = nextHourAfter(activatedAt);
    sqlite.prepare(`INSERT INTO plugin_cron_runs (plugin_id, cron_name, scheduled_for, status, claim_id, lease_expires_at)
      VALUES ('acme.hello', 'tidy', ?, 'running', 'pcr_dead', unixepoch() - 1)`).run(slotMs / 1000 - 3600);
    expect(await tick(slotMs)).toMatchObject({ expired: 1, ran: 1 });
    expect(sqlite.prepare("SELECT status, error FROM plugin_cron_runs WHERE claim_id = 'pcr_dead'").get())
      .toEqual({ status: "failed", error: "The run did not finish before its time limit." });

    const hello = await requirePluginInstallation(db, "acme.hello");
    await deactivatePlugin(db, "acme.hello", { expectedRevision: hello.revision });
    expect(await tick(slotMs + 3_600_000)).toEqual({ due: 0, ran: 0, failed: 0, skipped: 0, deferred: 0, expired: 0 });
  });
});
