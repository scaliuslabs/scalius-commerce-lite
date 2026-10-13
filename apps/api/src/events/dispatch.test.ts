// The tick's event drain: a due event fans out to webhook deliveries and the
// delivery POSTs the order's admin representation in the same drain. A failed
// delivery backs off in its row and the next due tick sends it again; a drain
// never takes more than the plan's share.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createWebhookSubscription } from "@scalius/core/modules/events";
import type { Database } from "@scalius/database/client";
import { runScheduledEventMaintenance } from "./dispatch";

const ENCRYPTION_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 3)).toString("base64");

describe("the scheduled event drain", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

  beforeEach(async () => {
    const created = createSqliteD1Database();
    ({ sqlite, db } = created);
    env = { DB: created.binding, CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env;
    await createWebhookSubscription(db, { url: "https://erp.example.com/hooks", topics: ["order.created"] }, {
      actorId: null,
      encryptionKey: ENCRYPTION_KEY,
    });
    sqlite.exec("UPDATE webhook_subscriptions SET created_at = created_at - 60");
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name, status)
      VALUES ('ord_q', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'Dhaka', 'Mirpur', 'pending')`);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it("dispatches, then delivers the order's admin representation in the same drain", async () => {
    const eventId = (sqlite.prepare("SELECT id FROM event_outbox").get() as { id: string }).id;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const drained = await runScheduledEventMaintenance(db, env, ctx);

    expect(drained).toMatchObject({ events: { scanned: 1, dispatched: 1 }, deliveries: 1, pluginDeliveries: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ id: eventId, topic: "order.created", resource: { type: "order", id: "ord_q" } });
    expect(body.data).toMatchObject({ id: "ord_q", status: "pending", channel: "online_store" });
    expect(sqlite.prepare("SELECT status FROM event_outbox").get()).toEqual({ status: "dispatched" });
    expect(sqlite.prepare("SELECT status FROM webhook_event_deliveries").get()).toEqual({ status: "succeeded" });
  });

  it("retries a failed delivery from its row once it is due", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await runScheduledEventMaintenance(db, env, ctx);
    expect(sqlite.prepare("SELECT status, attempts FROM webhook_event_deliveries").get()).toEqual({ status: "failed", attempts: 1 });

    // Not due: the next tick sends nothing.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runScheduledEventMaintenance(db, env, ctx)).resolves.toMatchObject({ deliveries: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    sqlite.exec("UPDATE webhook_event_deliveries SET next_attempt_at = unixepoch() - 1");
    await expect(runScheduledEventMaintenance(db, env, ctx)).resolves.toMatchObject({ deliveries: 1 });
    expect(sqlite.prepare("SELECT status, attempts FROM webhook_event_deliveries").get()).toEqual({ status: "succeeded", attempts: 2 });
  });
});
