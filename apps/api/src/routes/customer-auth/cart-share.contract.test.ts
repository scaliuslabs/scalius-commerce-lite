import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as productComposition from "../../utils/conversation-products";
import {
  createConversationHarness,
  OTHER_SESSION,
  OWNER_SESSION,
  RECEIPT_TOKEN,
  type Harness,
} from "../__tests__/conversation-harness";

let harness: Harness;
const line = { productId: "product_shared", skuId: "sku_shared", quantity: 1 };
const storePath = "/customer-auth/conversations/cnv_cart_store_owner/cart-share";
const ownedPath = "/customer-auth/orders/ORDEROWNED000001/conversation/cart-share";
const receiptPath = "/orders/receipt/ORDERGUEST000001/conversation/cart-share";
const json = (value: unknown) => JSON.stringify(value);
const put = (lines: unknown[] = [line], expectedVersion = 0) => ({ method: "PUT", body: json({ lines, expectedVersion }) });
const remove = (expectedVersion: number) => ({ method: "DELETE", body: json({ expectedVersion }) });

beforeEach(async () => {
  harness = await createConversationHarness();
  harness.sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor)
      VALUES ('product_shared', 'Shared product', 'shared-product', 125000);
    INSERT INTO product_variants (id, product_id, sku, price_minor, is_default, track_inventory)
      VALUES ('sku_shared', 'product_shared', 'SHARED', 125000, 1, 0);
    INSERT INTO conversations (id, subject_type, customer_id, status, closed_at)
      VALUES ('cnv_cart_store_owner', 'store', 'cust_owner', 'closed', unixepoch());
  `);
});
afterEach(() => {
  vi.restoreAllMocks();
  harness.sqlite.close();
});

describe("buyer cart sharing routes", () => {
  it("reads absent shares without creating order threads and returns 404 when withdrawing a missing thread", async () => {
    for (const [path, auth] of [
      [ownedPath, { session: OWNER_SESSION }],
      [receiptPath, { receipt: true }],
      [storePath, { session: OWNER_SESSION }],
    ] as const) {
      const response = await harness.request(path, auth);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ data: { cartShare: null } });
    }
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversations WHERE subject_type = 'order'").get()).toEqual({ n: 0 });
    expect((await harness.request(ownedPath, { ...remove(1), session: OWNER_SESSION })).status).toBe(404);
    expect((await harness.request(receiptPath, { ...remove(1), receipt: true })).status).toBe(404);
  });

  it.each([
    ["store thread", storePath, { session: OWNER_SESSION }],
    ["owned order", ownedPath, { session: OWNER_SESSION }],
    ["receipt order", receiptPath, { receipt: true }],
  ] as const)("shares, updates, withdraws and explicitly re-shares a %s", async (_name, path, auth) => {
    const response = await harness.request(path, { ...put([line, { ...line, quantity: 2 }]), ...auth });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const first = await response.json() as { data: { cartShare: { lines: unknown[]; products: unknown[]; version: number } } };
    expect(first.data.cartShare.lines).toEqual([{ ...line, quantity: 3 }]);
    expect(first.data.cartShare.products).toEqual([expect.objectContaining({
      productId: line.productId, skuId: line.skuId, title: "Shared product", variantLabel: null, status: "available",
    })]);
    expect(first.data.cartShare.version).toBe(1);
    expect((await harness.request(path, { ...put([line], 0), ...auth })).status).toBe(409);
    expect((await harness.request(path, { ...put([line], 1), ...auth })).status).toBe(200);
    expect((await harness.request(path, { ...remove(1), ...auth })).status).toBe(409);
    const withdrawn = await harness.request(path, { ...remove(2), ...auth });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({ data: { cartShare: {
      lines: [], products: [], withdrawnAt: expect.any(Number), version: 3,
    } } });
    expect((await harness.request(path, { ...put([line], 2), ...auth })).status).toBe(409);
    const sharedEmpty = await harness.request(path, { ...put([], 3), ...auth });
    expect(sharedEmpty.status).toBe(200);
    expect(await sharedEmpty.json()).toMatchObject({ data: { cartShare: {
      lines: [], products: [], withdrawnAt: null, version: 4,
    } } });
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 0 });
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox").get()).toEqual({ n: 0 });
    expect(harness.sqlite.prepare("SELECT status, last_seq FROM conversations WHERE id='cnv_cart_store_owner'").get())
      .toEqual({ status: "closed", last_seq: 0 });
  });

  it("retains the actual shared item labels across reload and catalog changes without accepting buyer-supplied labels", async () => {
    const forged = await harness.request(storePath, { ...put([{ ...line, title: "Forged name" }]), session: OWNER_SESSION });
    expect(forged.status).toBe(400);
    expect((await harness.request(storePath, { ...put(), session: OWNER_SESSION })).status).toBe(200);
    harness.sqlite.exec("UPDATE products SET is_active=0, name='Private renamed product' WHERE id='product_shared'");
    const response = await harness.request(storePath, { session: OWNER_SESSION });
    expect(await response.json()).toMatchObject({ data: { cartShare: {
      lines: [line], products: [{ title: "Shared product", status: "unavailable", price: null, pdpUrl: null, imageUrl: null }], version: 1,
    } } });
    expect((await harness.request(ownedPath, { ...put(), session: OWNER_SESSION })).status).toBe(400);
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversations WHERE subject_type = 'order'").get()).toEqual({ n: 0 });
  });

  it("denies foreign accounts and missing or wrong receipts before consulting the catalog", async () => {
    const validate = vi.spyOn(productComposition, "validateConversationCartProductRefs");
    const project = vi.spyOn(productComposition, "projectConversationProductCards");
    for (const [path, auth] of [
      [storePath, { session: OTHER_SESSION }],
      [ownedPath, { session: OTHER_SESSION }],
      [receiptPath, {}],
      ["/orders/receipt/ORDEROWNED000001/conversation/cart-share", { receipt: true }],
    ] as const) {
      for (const request of [{}, put(), remove(1)]) {
        expect((await harness.request(path, { ...request, ...auth })).status).toBe(404);
      }
    }
    expect((await harness.request(`${receiptPath}?token=${RECEIPT_TOKEN}`, put())).status).toBe(404);
    expect((await harness.request(receiptPath, {
      method: "PUT", body: json({ lines: [line], expectedVersion: 0, token: RECEIPT_TOKEN }),
    })).status).toBe(400);
    expect(validate).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversation_cart_shares").get()).toEqual({ n: 0 });
  });

  it("merges raw duplicates before catalog validation and rejects malformed or excessive input before writes", async () => {
    const validate = vi.spyOn(productComposition, "validateConversationCartProductRefs");
    expect((await harness.request(storePath, { ...put([line, line]), session: OWNER_SESSION })).status).toBe(200);
    expect(validate.mock.calls[0]?.[1]).toEqual([{ ...line, quantity: 2 }]);
    for (const lines of [
      [line, { ...line, productId: "different_product" }],
      [line, { ...line, quantity: 99 }],
      [{ ...line, quantity: 0 }],
      [{ ...line, quantity: 1.5 }],
      [{ ...line, skuId: "invalid/sku" }],
      Array.from({ length: 991 }, () => line),
    ]) {
      expect((await harness.request(storePath, { ...put(lines, 1), session: OWNER_SESSION })).status).toBe(400);
    }
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [storePath, { session: OWNER_SESSION }],
    [ownedPath, { session: OWNER_SESSION }],
    [receiptPath, { receipt: true }],
  ] as const)("fails closed on denied and missing limiters for %s", async (path, auth) => {
    // Create first so DELETE exercises the write limiter rather than the absent-thread guard.
    expect((await harness.request(path, { ...put(), ...auth })).status).toBe(200);
    const validate = vi.spyOn(productComposition, "validateConversationCartProductRefs");
    for (const [missing, expectedStatus] of [[false, 429], [true, 503]] as const) {
      harness.limiter.allow = false;
      harness.limiter.missing = missing;
      expect((await harness.request(path, { ...put([line], 1), ...auth })).status).toBe(expectedStatus);
      expect((await harness.request(path, { ...remove(1), ...auth })).status).toBe(expectedStatus);
    }
    expect(validate).not.toHaveBeenCalled();
    expect(harness.sqlite.prepare("SELECT version, withdrawn_at FROM conversation_cart_shares").get())
      .toEqual({ version: 1, withdrawn_at: null });
  });
});
