// The `plugins.deliver` consumer with the bundled loader on the migrated
// schema: an outbox event reaches the subscribed plugin exactly once per
// delivery row; a throwing handler is retried with backoff and dead-lettered;
// a deactivated plugin's deliveries are cancelled; a plugin at its in-flight
// cap is deferred; an installation behind the deployed build is updated in
// place without using the delivery's attempt. The event pipeline end to end:
// dispatch → fan-out (webhooks + plugins) → delivery.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { eventOutbox } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { processEventDispatch, toOutboxEvent } from "@scalius/core/modules/events";
import {
  activatePlugin,
  deactivatePlugin,
  getPluginKv,
  installPlugin,
  pluginEventFanOutTarget,
  requirePluginInstallation,
} from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { eq } from "drizzle-orm";
import { API_EVENT_FAN_OUT_TARGETS } from "../events/targets";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { processPluginEventDelivery } from "./event-delivery";
import { BundledLoader } from "./loaders/bundled";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const FLAKY_SHA = "f".repeat(64);
const flakyManifest = {
  id: "acme.flaky",
  name: "Flaky",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Fails on purpose.",
  author: { name: "Acme" },
  events: ["order.created"],
};
const flakyModule = {
  default: {
    manifest: flakyManifest,
    events: {
      "order.created": async () => {
        throw new Error("Upstream for owner@shop.test is down");
      },
    },
  },
};

// The first delivery loads the admin app for ctx.api; give cold starts room on a busy machine.
describe("plugin event delivery", { timeout: 30_000 }, () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let loader: BundledLoader;
  let seq = 0;

  async function outboxEvent(topic: "order.created" | "order.paid" = "order.created") {
    seq += 1;
    const id = `evt_${String(Date.now()).padStart(13, "0")}${String(seq).padStart(12, "0")}`;
    const facts = topic === "order.paid"
      ? { orderId: "ord_hello1", previousPaymentStatus: "unpaid", paymentStatus: "paid" }
      : { orderId: "ord_hello1", status: "pending", paymentStatus: "unpaid", channel: "online_store" };
    sqlite.prepare(`INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, status)
      VALUES (?, ?, 'order', 'ord_hello1', ?, 'queued')`).run(id, topic, JSON.stringify(facts));
    return toOutboxEvent((await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).get())!)!;
  }

  async function deliveriesFor(pluginId: string, topic: "order.created" | "order.paid" = "order.created") {
    const messages = await pluginEventFanOutTarget.fanOut(db, await outboxEvent(topic));
    const ids = messages.map((message) => (message as { deliveryId: string }).deliveryId);
    const rows = sqlite.prepare(`SELECT id FROM plugin_event_deliveries WHERE plugin_id = ? AND id IN (${ids.map(() => "?").join(",") || "''"})`).all(pluginId, ...ids) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  const deliver = (deliveryId: string) => processPluginEventDelivery({ db, env, ctx: pluginTestCtx(), deliveryId, loaderFor: () => loader });
  const row = (id: string) => sqlite.prepare("SELECT status, attempts, last_error FROM plugin_event_deliveries WHERE id = ?").get(id);

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    await installHello(db, sqlite);
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_hello1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed')`).run();
    await installPlugin(db, { manifest: flakyManifest, source: "bundled", bundleSha256: FLAKY_SHA });
    await activatePlugin(db, "acme.flaky", { actorUserId: "owner", expectedRevision: 1 });
    loader = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {
      ...BUNDLED_PLUGINS,
      "acme.flaky": { version: "1.0.0", sha256: FLAKY_SHA, load: async () => flakyModule },
    });
  });
  afterEach(() => sqlite.close());

  it("dispatches an event to every subscribed plugin and delivers it once", async () => {
    const event = await outboxEvent("order.paid");
    const outcome = await processEventDispatch({ db, eventId: event.id, targets: API_EVENT_FAN_OUT_TARGETS, queue: env.JOBS_QUEUE as never });
    expect(outcome).toMatchObject({ status: "dispatched", messages: [{ type: "plugins.deliver" }] });
    const [message] = (outcome as { messages: Array<{ deliveryId: string }> }).messages;
    expect(await deliver(message!.deliveryId)).toEqual({ status: "succeeded", deliveryId: message!.deliveryId, retryInSeconds: null });
    expect(row(message!.deliveryId)).toEqual({ status: "succeeded", attempts: 1, last_error: null });
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(1);
    // The same message again (at-least-once queue) does nothing.
    expect(await deliver(message!.deliveryId)).toEqual({ status: "skipped", deliveryId: message!.deliveryId, reason: "not_due" });
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(1);
  });

  it("retries a throwing handler with backoff, masks its error and dead-letters it after the last attempt", async () => {
    const [id] = await deliveriesFor("acme.flaky");
    const first = await deliver(id!);
    expect(first).toEqual({ status: "failed", deliveryId: id, retryInSeconds: 60 });
    expect(row(id!)).toEqual({ status: "failed", attempts: 1, last_error: "Error: Upstream for [email] is down" });
    expect(env.JOBS_QUEUE!.send).toHaveBeenCalledWith({ type: "plugins.deliver", deliveryId: id }, { delaySeconds: 60 });

    sqlite.prepare("UPDATE plugin_event_deliveries SET attempts = 7, next_attempt_at = unixepoch() - 1 WHERE id = ?").run(id!);
    expect(await deliver(id!)).toEqual({ status: "exhausted", deliveryId: id, retryInSeconds: null });
    expect(row(id!)).toMatchObject({ status: "exhausted", attempts: 8 });
  });

  it("cancels deliveries of a deactivated plugin and defers a plugin at its in-flight cap", async () => {
    const [cancelled] = await deliveriesFor("acme.flaky");
    const flaky = await requirePluginInstallation(db, "acme.flaky");
    await deactivatePlugin(db, "acme.flaky", { expectedRevision: flaky.revision });
    expect(await deliver(cancelled!)).toMatchObject({ status: "cancelled" });
    expect(row(cancelled!)).toMatchObject({ status: "cancelled", last_error: "The app is not active or no longer receives this event." });

    const ids = [...await deliveriesFor("acme.hello"), ...await deliveriesFor("acme.hello")];
    sqlite.prepare("UPDATE plugin_event_deliveries SET status = 'processing', claim_id = 'held', claim_expires_at = unixepoch() + 60 WHERE id = ?").run(ids[0]!);
    for (let index = 0; index < 3; index += 1) {
      sqlite.prepare(`INSERT INTO plugin_event_deliveries (id, plugin_id, topic, resource_type, resource_id, status, claim_id, claim_expires_at)
        VALUES (?, 'acme.hello', 'order.created', 'order', 'x', 'processing', 'held', unixepoch() + 60)`).run(`pld_000000000000${index}busybusybusy`);
    }
    const send = env.JOBS_QUEUE!.send as ReturnType<typeof vi.fn>;
    send.mockClear();
    expect(await deliver(ids[1]!)).toEqual({ status: "busy", deliveryId: ids[1], retryInSeconds: 15 });
    expect(row(ids[1]!)).toMatchObject({ status: "pending", attempts: 0 });
    expect(send).toHaveBeenCalledWith({ type: "plugins.deliver", deliveryId: ids[1] }, { delaySeconds: 15 });
  });

  it("updates an installation behind the deployed build in place without using the delivery's attempt", async () => {
    const [id] = await deliveriesFor("acme.hello");
    sqlite.prepare("UPDATE plugin_installations SET bundle_sha256 = ? WHERE plugin_id = 'acme.hello'").run("0".repeat(64));
    expect(await deliver(id!)).toEqual({ status: "released", deliveryId: id, retryInSeconds: 5 });
    expect(row(id!)).toMatchObject({ status: "failed", attempts: 0 });
    expect((await requirePluginInstallation(db, "acme.hello")).bundleSha256).toBe(BUNDLED_PLUGINS["acme.hello"]!.sha256);
    sqlite.prepare("UPDATE plugin_event_deliveries SET next_attempt_at = unixepoch() - 1 WHERE id = ?").run(id!);
    expect(await deliver(id!)).toMatchObject({ status: "succeeded" });
    expect(await getPluginKv(db, "acme.hello", "created_count")).toBe(1);
  });
});
