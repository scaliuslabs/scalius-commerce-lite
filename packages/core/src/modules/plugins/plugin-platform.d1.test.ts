// Plugin platform phase 2a persistence on the real migrated schema (D1
// semantics): the event fan-out target and the delivery state machine
// (in-flight cap, backoff, dead letter, retry, release, flush), cron claims
// (a slot runs once, one run per job at a time, expired leases), update and
// approval transitions, and uninstall's keep/delete data choice.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { eventOutbox } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, pluginGrantKey, pluginGrantRequest, type PluginManifestInput } from "@scalius/shared/plugins";
import { eq } from "drizzle-orm";
import { toOutboxEvent, type OutboxEvent } from "../events";
import {
  PLUGIN_DELIVERY_MAX_ATTEMPTS,
  PluginError,
  activatePlugin,
  cancelPluginEventDelivery,
  claimPluginCronRun,
  claimPluginEventDelivery,
  completePluginEventDelivery,
  expireStalePluginCronRuns,
  failPluginEventDelivery,
  finishPluginCronRun,
  listDuePluginEventDeliveries,
  installPlugin,
  latestPluginCronRuns,
  listPluginEventDeliveries,
  markPluginFailed,
  pluginEventFanOutTarget,
  pluginNeedsApproval,
  prunePluginCronRuns,
  releasePluginCronRun,
  releasePluginEventDelivery,
  requirePluginInstallation,
  retryPluginEventDelivery,
  uninstallPlugin,
  updatePluginInstallation,
  writePluginLogs,
} from "./index";

const SHA = "b".repeat(64);
const OTHER_SHA = "c".repeat(64);

function manifest(id: string, overrides: Partial<PluginManifestInput> = {}): PluginManifestInput {
  return {
    id,
    name: `App ${id}`,
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Test app.",
    author: { name: "Acme" },
    scopes: ["read_orders"],
    events: ["order.paid"],
    cron: [{ name: "nightly", schedule: "0 3 * * *" }],
    ...overrides,
  };
}

describe("plugin event deliveries", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let eventSeq = 0;

  async function event(topic = "order.paid", occurredAt: number | null = null): Promise<OutboxEvent> {
    eventSeq += 1;
    const id = `evt_${String(Date.now()).padStart(13, "0")}${String(eventSeq).padStart(12, "0")}`;
    const facts = topic === "order.paid"
      ? { orderId: "ord_1", previousPaymentStatus: "unpaid", paymentStatus: "paid" }
      : { orderId: "ord_1", status: "pending", paymentStatus: "unpaid", channel: "online_store" };
    sqlite.prepare(`INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, occurred_at, status)
      VALUES (?, ?, 'order', 'ord_1', ?, COALESCE(?, unixepoch()), 'processing')`).run(id, topic, JSON.stringify(facts), occurredAt);
    return toOutboxEvent((await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).get())!)!;
  }

  async function activate(id: string, overrides: Partial<PluginManifestInput> = {}) {
    await installPlugin(db, { manifest: manifest(id, overrides), source: "upload", bundleSha256: SHA });
    return activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("does no work when no active plugin subscribes, and fans out once per subscriber whose grant covers the event", async () => {
    expect(await pluginEventFanOutTarget.hasSubscribers(db)).toBe(false);
    await installPlugin(db, { manifest: manifest("gamma.idle"), source: "upload", bundleSha256: SHA });
    expect(await pluginEventFanOutTarget.hasSubscribers(db)).toBe(false);

    await activate("alpha.all", { events: ["order.*"] });
    await activate("beta.paid", { events: ["order.paid"] });
    await activate("delta.customers", { events: ["customer.created"] });
    expect(await pluginEventFanOutTarget.hasSubscribers(db)).toBe(true);

    const paid = await event("order.paid");
    const messages = await pluginEventFanOutTarget.fanOut(db, paid);
    expect(messages).toHaveLength(2);
    expect(sqlite.prepare("SELECT plugin_id, status, topic, resource_id FROM plugin_event_deliveries ORDER BY plugin_id").all()).toEqual([
      { plugin_id: "alpha.all", status: "pending", topic: "order.paid", resource_id: "ord_1" },
      { plugin_id: "beta.paid", status: "pending", topic: "order.paid", resource_id: "ord_1" },
    ]);
    // A redelivered event adds no rows and re-sends only what is still waiting.
    expect(await pluginEventFanOutTarget.fanOut(db, paid)).toHaveLength(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_event_deliveries").get()).toEqual({ n: 2 });

    // An event older than a plugin's activation never reaches it.
    const old = await event("order.paid", 1_000_000);
    expect(await pluginEventFanOutTarget.fanOut(db, old)).toEqual([]);
  });

  it("caps deliveries in flight per plugin, then retries with backoff until the dead letter, and staff can retry", async () => {
    await activate("alpha.all", { events: ["order.*"] });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const [message] = await pluginEventFanOutTarget.fanOut(db, await event());
      ids.push((message as { deliveryId: string }).deliveryId);
    }
    const first = await claimPluginEventDelivery(db, ids[0]!, { maxInFlight: 2 });
    const second = await claimPluginEventDelivery(db, ids[1]!, { maxInFlight: 2 });
    expect([first.status, second.status]).toEqual(["claimed", "claimed"]);
    expect(await claimPluginEventDelivery(db, ids[2]!, { maxInFlight: 2 })).toEqual({ status: "busy", pluginId: "alpha.all" });
    if (first.status !== "claimed" || second.status !== "claimed") throw new Error("unreachable");
    await completePluginEventDelivery(db, first.delivery, first.claimId, { durationMs: 12 });
    expect((await claimPluginEventDelivery(db, ids[2]!, { maxInFlight: 2 })).status).toBe("claimed");
    expect(await claimPluginEventDelivery(db, ids[0]!)).toEqual({ status: "skipped", reason: "not_due" });

    // A thrown handler: backoff from 1 minute, the error masked like the log.
    const failed = await failPluginEventDelivery(db, second.delivery, second.claimId, { error: "Customer rahim@example.com not found", durationMs: 30 });
    expect(failed).toEqual({ status: "failed", retryInSeconds: 60 });
    const row = sqlite.prepare("SELECT status, last_error, next_attempt_at - unixepoch() AS wait FROM plugin_event_deliveries WHERE id = ?").get(ids[1]!) as { status: string; last_error: string; wait: number };
    expect(row).toMatchObject({ status: "failed", last_error: "Customer [email] not found" });
    expect(row.wait).toBeGreaterThanOrEqual(59);

    sqlite.prepare("UPDATE plugin_event_deliveries SET next_attempt_at = unixepoch() - 1, attempts = ? WHERE id = ?").run(PLUGIN_DELIVERY_MAX_ATTEMPTS - 1, ids[1]!);
    const last = await claimPluginEventDelivery(db, ids[1]!);
    if (last.status !== "claimed") throw new Error("expected a claim");
    expect(await failPluginEventDelivery(db, last.delivery, last.claimId, { error: "still failing", durationMs: 1 })).toEqual({ status: "exhausted", retryInSeconds: null });

    const retried = await retryPluginEventDelivery(db, "alpha.all", ids[1]!);
    expect(retried).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(await listDuePluginEventDeliveries(db, 10)).toContain(ids[1]);
    await expect(retryPluginEventDelivery(db, "alpha.all", ids[0]!)).rejects.toMatchObject({ pluginCode: "delivery_not_retryable" });

    const page = await listPluginEventDeliveries(db, "alpha.all", { limit: 2 });
    // Newest first by id (time-sortable; ids minted in one millisecond order by their random tail).
    const newest = [...ids].sort().reverse();
    expect(page.deliveries.map((delivery) => delivery.id)).toEqual(newest.slice(0, 2));
    expect(page.nextCursor).toBe(newest[1]);
  });

  it("releases a delivery without using its attempt, cancels for an inactive plugin, and the drain lists due rows", async () => {
    await activate("alpha.all", { events: ["order.*"] });
    const [message] = await pluginEventFanOutTarget.fanOut(db, await event());
    const deliveryId = (message as { deliveryId: string }).deliveryId;
    const claim = await claimPluginEventDelivery(db, deliveryId);
    if (claim.status !== "claimed") throw new Error("expected a claim");
    await releasePluginEventDelivery(db, claim.delivery, claim.claimId, { delaySeconds: 5, reason: "updated" });
    expect(sqlite.prepare("SELECT status, attempts FROM plugin_event_deliveries WHERE id = ?").get(deliveryId)).toEqual({ status: "failed", attempts: 0 });

    sqlite.prepare("UPDATE plugin_event_deliveries SET next_attempt_at = unixepoch() - 1 WHERE id = ?").run(deliveryId);
    expect(await listDuePluginEventDeliveries(db, 10)).toEqual([deliveryId]);

    const again = await claimPluginEventDelivery(db, deliveryId);
    if (again.status !== "claimed") throw new Error("expected a claim");
    await cancelPluginEventDelivery(db, again.delivery, again.claimId, "The app is not active.");
    expect(sqlite.prepare("SELECT status FROM plugin_event_deliveries WHERE id = ?").get(deliveryId)).toEqual({ status: "cancelled" });
    await markPluginFailed(db, "alpha.all", "broken");
    await expect(retryPluginEventDelivery(db, "alpha.all", deliveryId)).rejects.toMatchObject({ pluginCode: "installation_inactive" });
  });
});

describe("plugin cron claims", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  it("lets exactly one tick claim a slot and never overlaps runs of a job", async () => {
    const slot = { pluginId: "acme.jobs", cronName: "nightly", scheduledFor: 1_790_000_000 };
    const [first, second] = await Promise.all([claimPluginCronRun(db, slot), claimPluginCronRun(db, slot)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const claim = (first ?? second)!;
    // The next slot waits while this run is going.
    expect(await claimPluginCronRun(db, { ...slot, scheduledFor: slot.scheduledFor + 900 })).toBeNull();
    // Another job of the same plugin is independent.
    expect(await claimPluginCronRun(db, { ...slot, cronName: "hourly" })).not.toBeNull();

    await finishPluginCronRun(db, claim, { ok: false, error: "Timed out for owner@shop.test", durationMs: 30_000 });
    expect(await claimPluginCronRun(db, slot)).toBeNull();
    const next = await claimPluginCronRun(db, { ...slot, scheduledFor: slot.scheduledFor + 900 });
    expect(next).not.toBeNull();
    await finishPluginCronRun(db, next!, { ok: true, durationMs: 40 });
    expect((await latestPluginCronRuns(db, "acme.jobs", ["nightly", "never"]))).toEqual({
      nightly: expect.objectContaining({ scheduledFor: slot.scheduledFor + 900, status: "succeeded", durationMs: 40, error: null }),
      never: null,
    });
    expect(sqlite.prepare("SELECT error FROM plugin_cron_runs WHERE scheduled_for = ?").get(slot.scheduledFor)).toEqual({ error: "Timed out for [email]" });
  });

  it("fails runs whose lease ran out, gives released slots back and prunes old history", async () => {
    const claim = (await claimPluginCronRun(db, { pluginId: "acme.jobs", cronName: "nightly", scheduledFor: 100 }))!;
    sqlite.prepare("UPDATE plugin_cron_runs SET lease_expires_at = unixepoch() - 1").run();
    expect(await expireStalePluginCronRuns(db)).toBe(1);
    expect(sqlite.prepare("SELECT status FROM plugin_cron_runs").get()).toEqual({ status: "failed" });
    // A finish after expiry changes nothing.
    await finishPluginCronRun(db, claim, { ok: true, durationMs: 1 });
    expect(sqlite.prepare("SELECT status FROM plugin_cron_runs").get()).toEqual({ status: "failed" });

    const released = (await claimPluginCronRun(db, { pluginId: "acme.jobs", cronName: "nightly", scheduledFor: 200 }))!;
    await releasePluginCronRun(db, released);
    expect(await claimPluginCronRun(db, { pluginId: "acme.jobs", cronName: "nightly", scheduledFor: 200 })).not.toBeNull();

    sqlite.prepare("UPDATE plugin_cron_runs SET started_at = 1000 WHERE scheduled_for = 100").run();
    expect(await prunePluginCronRuns(db)).toBe(1);
    expect(sqlite.prepare("SELECT scheduled_for FROM plugin_cron_runs").all()).toEqual([{ scheduled_for: 200 }]);
  });
});

describe("plugin updates, approval and uninstall", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("waits for approval when an update asks for more, and approves only the request that was shown", async () => {
    await installPlugin(db, { manifest: manifest("acme.loyalty"), source: "bundled", bundleSha256: SHA });
    const oldKey = pluginGrantKey(pluginGrantRequest((await requirePluginInstallation(db, "acme.loyalty")).manifest));
    const active = await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: 1, expectedGrantKey: oldKey });
    expect(pluginNeedsApproval(active)).toBe(false);

    const wider = await updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest("acme.loyalty", { version: "1.1.0", scopes: ["read_orders", "read_customers"] }),
      source: "bundled",
      bundleSha256: OTHER_SHA,
      expectedRevision: active.revision,
    });
    expect(wider).toMatchObject({ status: "installed", version: "1.1.0" });
    expect(wider.grant?.scopes).toEqual(["read_orders"]);
    expect(pluginNeedsApproval(wider)).toBe(true);

    await expect(activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: wider.revision, expectedGrantKey: oldKey }))
      .rejects.toMatchObject({ pluginCode: "installation_grant_changed" });
    const approved = await activatePlugin(db, "acme.loyalty", {
      actorUserId: "owner",
      expectedRevision: wider.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(wider.manifest)),
    });
    expect(approved).toMatchObject({ status: "active" });
    expect(approved.grant?.scopes).toEqual(["read_customers", "read_orders"]);
  });

  it("resumes a failed plugin on an update its grant covers", async () => {
    await installPlugin(db, { manifest: manifest("acme.loyalty"), source: "bundled", bundleSha256: SHA });
    await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: 1 });
    await markPluginFailed(db, "acme.loyalty", "The deployed code is different.");
    const failed = await requirePluginInstallation(db, "acme.loyalty");
    expect(failed.status).toBe("failed");
    const updated = await updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest("acme.loyalty", { version: "1.0.1" }),
      source: "bundled",
      bundleSha256: OTHER_SHA,
      expectedRevision: failed.revision,
    });
    expect(updated).toMatchObject({ status: "active", failureReason: null, version: "1.0.1" });
  });

  it("keeps everything the plugin owns, or deletes all of it including its custom-field namespace", async () => {
    const seed = async () => {
      await installPlugin(db, { manifest: manifest("acme.loyalty"), source: "upload", bundleSha256: SHA });
      const active = await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: 1 });
      sqlite.prepare("INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, status) VALUES ('evt_00000000000010000000000001', 'order.paid', 'order', 'ord_1', '{}', 'dispatched') ON CONFLICT DO NOTHING").run();
      sqlite.prepare("INSERT INTO plugin_event_deliveries (id, plugin_id, event_id, topic, resource_type, resource_id, status) VALUES ('pld_0000000000001aaaaaaaaaaaa', 'acme.loyalty', 'evt_00000000000010000000000001', 'order.paid', 'order', 'ord_1', 'failed')").run();
      await claimPluginCronRun(db, { pluginId: "acme.loyalty", cronName: "nightly", scheduledFor: 1 });
      await writePluginLogs(db, "acme.loyalty", [{ level: "info", source: "host", message: "hello" }]);
      sqlite.prepare("INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES ('cfd_loyalty_tier', 'customer', 'acme.loyalty', 'tier', 'Tier', 'single_line_text')").run();
      sqlite.prepare("INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES ('cfd_merchant_note', 'customer', 'custom', 'tier', 'Tier', 'single_line_text')").run();
      sqlite.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_loyalty_tier', 'customer', 'cus_1', 'gold')").run();
      return active;
    };
    const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    const kept = await seed();
    await uninstallPlugin(db, "acme.loyalty", { keepData: true, expectedRevision: kept.revision });
    expect(sqlite.prepare("SELECT status, last_error FROM plugin_event_deliveries").get()).toEqual({ status: "cancelled", last_error: "The app was uninstalled." });
    expect([count("plugin_cron_runs"), count("plugin_log_entries"), count("custom_field_definitions"), count("custom_field_values")]).toEqual([1, 1, 2, 1]);

    sqlite.prepare("DELETE FROM plugin_event_deliveries").run();
    sqlite.prepare("DELETE FROM plugin_cron_runs").run();
    sqlite.prepare("DELETE FROM custom_field_definitions").run();
    sqlite.prepare("DELETE FROM plugin_log_entries").run();
    const removed = await seed();
    await uninstallPlugin(db, "acme.loyalty", { keepData: false, expectedRevision: removed.revision });
    expect([count("plugin_event_deliveries"), count("plugin_cron_runs"), count("plugin_log_entries"), count("custom_field_values")]).toEqual([0, 0, 0, 0]);
    // Only the plugin's namespace goes; the merchant's own field stays.
    expect(sqlite.prepare("SELECT namespace FROM custom_field_definitions").all()).toEqual([{ namespace: "custom" }]);
    await expect(requirePluginInstallation(db, "acme.loyalty")).rejects.toBeInstanceOf(PluginError);
  });
});
