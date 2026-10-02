// The jobs queue routes the events pipeline's two id-only messages: an
// `events.dispatch` fans out to webhook deliveries, a `webhooks.deliver`
// POSTs the order's admin representation, and a non-events batch flushes the
// outbox rows its writes produced. The DLQ settles exhausted messages.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createWebhookSubscription } from "@scalius/core/modules/events";
import { handleQueueBatch } from "../queue-consumer";

const ENCRYPTION_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 3)).toString("base64");

type Body = Record<string, unknown> & { type: string };

function batch(queue: string, bodies: Body[]) {
  const messages = bodies.map((body, index) => ({
    id: `msg_${index}`,
    timestamp: new Date(),
    attempts: queue === "jobs-dlq" ? 6 : 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<never>;
}

describe("events pipeline in the jobs queue", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  const sent: Body[] = [];

  beforeEach(async () => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    sent.length = 0;
    env = {
      DB: created.binding,
      CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
      JOBS_QUEUE: {
        send: vi.fn(async (body: Body) => { sent.push(body); }),
        sendBatch: vi.fn(async (messages: Array<{ body: Body }>) => { sent.push(...messages.map((message) => message.body)); }),
      },
    } as unknown as Env;
    await createWebhookSubscription(created.db, { url: "https://erp.example.com/hooks", topics: ["order.created"] }, {
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

  it("dispatches, then delivers the order's admin representation", async () => {
    const eventId = (sqlite.prepare("SELECT id FROM event_outbox").get() as { id: string }).id;
    const dispatch = batch("jobs", [{ type: "events.dispatch", eventId }]);
    await handleQueueBatch(dispatch as never, env);
    expect((dispatch.messages[0] as unknown as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalled();
    const delivery = sqlite.prepare("SELECT id, status FROM webhook_event_deliveries").get() as { id: string; status: string };
    expect(sent).toEqual([{ type: "webhooks.deliver", deliveryId: delivery.id }]);

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleQueueBatch(batch("jobs", [{ type: "webhooks.deliver", deliveryId: delivery.id }]) as never, env);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ id: eventId, topic: "order.created", resource: { type: "order", id: "ord_q" } });
    expect(body.data).toMatchObject({ id: "ord_q", status: "pending", channel: "online_store" });
    expect(sqlite.prepare("SELECT status FROM webhook_event_deliveries").get()).toEqual({ status: "succeeded" });
  });

  it("settles exhausted messages from the dead-letter queue", async () => {
    const eventId = (sqlite.prepare("SELECT id FROM event_outbox").get() as { id: string }).id;
    await handleQueueBatch(batch("jobs-dlq", [{ type: "events.dispatch", eventId }]) as never, env);
    expect(sqlite.prepare("SELECT status FROM event_outbox").get()).toEqual({ status: "dead_lettered" });
  });
});
