import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { ConflictError } from "@scalius/core/errors";
import type { CreateOrderInput } from "./orders.validation";
import {
  buildAdminOrderCreateAttemptCommit,
  buildAdminOrderCreateAttemptIdentity,
  claimAdminOrderCreateAttempt,
  markAdminOrderCreateAttemptFailed,
  resolveAdminOrderCreateAttempt,
} from "./admin-order-create-attempts";

type AttemptRow = {
  id: string;
  actorId: string | null;
  requestKeyHash: string;
  requestHash: string;
  orderId: string;
  status: string;
  responsePayload: string | null;
  attempts: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

describe("admin order create attempts", () => {
  it("scopes request identities to the actor while normalizing equivalent details", async () => {
    const requestKey = crypto.randomUUID();
    const input = buildInput({ requestKey, customerName: "  Test Customer  " });
    const normalized = buildInput({ requestKey, customerName: "Test Customer" });

    const first = await buildAdminOrderCreateAttemptIdentity(input, "admin_1");
    const equivalent = await buildAdminOrderCreateAttemptIdentity(normalized, "admin_1");
    const otherActor = await buildAdminOrderCreateAttemptIdentity(normalized, "admin_2");

    expect(first.requestHash).toBe(equivalent.requestHash);
    expect(first.requestKeyHash).toBe(equivalent.requestKeyHash);
    expect(otherActor.requestKeyHash).not.toBe(first.requestKeyHash);
  });

  it("replays a committed response without making another order claim", async () => {
    const fake = createFakeAttemptDb();
    const identity = await buildAdminOrderCreateAttemptIdentity(buildInput(), "admin_1");
    const first = await claimAdminOrderCreateAttempt<{ id: string }>(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await buildAdminOrderCreateAttemptCommit(fake.db, first.attempt, {
      id: first.attempt.orderId,
    });

    await expect(claimAdminOrderCreateAttempt(fake.db, identity)).resolves.toEqual({
      status: "replay",
      response: { id: first.attempt.orderId },
    });
    await expect(resolveAdminOrderCreateAttempt(fake.db, identity)).resolves.toEqual({
      status: "replay",
      response: { id: first.attempt.orderId },
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("returns processing while the first claim lease is active", async () => {
    const fake = createFakeAttemptDb();
    const identity = await buildAdminOrderCreateAttemptIdentity(buildInput(), "admin_1");
    const first = await claimAdminOrderCreateAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await expect(claimAdminOrderCreateAttempt(fake.db, identity)).resolves.toEqual({
      status: "processing",
      orderId: first.attempt.orderId,
    });
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("reclaims a failed request with the original order identity", async () => {
    const fake = createFakeAttemptDb();
    const identity = await buildAdminOrderCreateAttemptIdentity(buildInput(), "admin_1");
    const first = await claimAdminOrderCreateAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await markAdminOrderCreateAttemptFailed(fake.db, first.attempt, new Error("write failed"));
    const second = await claimAdminOrderCreateAttempt(fake.db, identity);

    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") throw new Error("expected reclaimed attempt");
    expect(second.attempt.orderId).toBe(first.attempt.orderId);
    expect(fake.rows[0]?.attempts).toBe(2);
    expect(fake.rows[0]?.lastError).toBeNull();
  });

  it("rejects reuse of a request key for changed order details", async () => {
    const fake = createFakeAttemptDb();
    const requestKey = crypto.randomUUID();
    const first = await buildAdminOrderCreateAttemptIdentity(
      buildInput({ requestKey }),
      "admin_1",
    );
    const changed = await buildAdminOrderCreateAttemptIdentity(
      buildInput({ requestKey, shippingCharge: 80 }),
      "admin_1",
    );
    await claimAdminOrderCreateAttempt(fake.db, first);

    await expect(claimAdminOrderCreateAttempt(fake.db, changed)).rejects.toBeInstanceOf(ConflictError);
    await expect(resolveAdminOrderCreateAttempt(fake.db, changed)).rejects.toBeInstanceOf(ConflictError);
    expect(fake.rows).toHaveLength(1);
  });
});

function buildInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    requestKey: crypto.randomUUID(),
    customerName: "Test Customer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "123 Test Street, Dhaka",
    city: "city_dhaka",
    zone: "zone_gulshan",
    area: null,
    notes: null,
    items: [{
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
    }],
    discountAmount: null,
    shippingCharge: 60,
    ...overrides,
  };
}

function createFakeAttemptDb(): { db: Database; rows: AttemptRow[] } {
  const rows: AttemptRow[] = [];
  const now = () => Math.floor(Date.now() / 1_000);

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.some((row) => row.requestKeyHash === values.requestKeyHash)) return [];
            const createdAt = now();
            const row: AttemptRow = {
              id: String(values.id),
              actorId: (values.actorId as string | null | undefined) ?? null,
              requestKeyHash: String(values.requestKeyHash),
              requestHash: String(values.requestHash),
              orderId: String(values.orderId),
              status: String(values.status),
              responsePayload: (values.responsePayload as string | null | undefined) ?? null,
              attempts: Number(values.attempts ?? 0),
              claimId: (values.claimId as string | null | undefined) ?? null,
              claimExpiresAt: createdAt + 300,
              lastError: (values.lastError as string | null | undefined) ?? null,
              createdAt,
              updatedAt: createdAt,
            };
            rows.push(row);
            return [{
              id: row.id,
              actorId: row.actorId,
              requestKeyHash: row.requestKeyHash,
              requestHash: row.requestHash,
              orderId: row.orderId,
            }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => rows[0],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const applyUpdate = () => {
            const row = rows[0];
            if (!row) return [];
            if (
              values.status === "processing" &&
              row.status === "processing" &&
              (row.claimExpiresAt ?? 0) > now()
            ) return [];
            Object.assign(row, materializeUpdate(values, row));
            return [{
              id: row.id,
              actorId: row.actorId,
              requestKeyHash: row.requestKeyHash,
              requestHash: row.requestHash,
              orderId: row.orderId,
            }];
          };
          return {
            returning: async () => applyUpdate(),
            then: (resolve: (value: unknown) => void) => resolve(applyUpdate()),
          };
        },
      }),
    }),
  } as unknown as Database;

  return { db, rows };
}

function materializeUpdate(
  values: Record<string, unknown>,
  row: AttemptRow,
): Partial<AttemptRow> {
  const next: Partial<AttemptRow> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "attempts") next.attempts = row.attempts + 1;
    else if (key === "claimExpiresAt") {
      next.claimExpiresAt = value === null ? null : Math.floor(Date.now() / 1_000) + 300;
    } else if (key === "updatedAt") next.updatedAt = Math.floor(Date.now() / 1_000);
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}
