import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hydrateConversationProducts, projectConversationProductCards, validateConversationCartProductRefs, validateConversationProductRefs } from "./conversation-products";

let sqlite: DatabaseSync;
let db: Database;
let reads = 0;
const ref = { productId: "product_alpha", skuId: "sku_alpha" };
const snapshot = { ...ref, title: "Name when sent", variantLabel: null };
describe("conversation product API composition", () => {
  beforeEach(() => {
    reads = 0;
    ({ sqlite, db } = createSqliteD1Database({ onQuery: () => { reads += 1; } }));
    sqlite.exec(`
      INSERT INTO products(id,name,slug,price_minor) VALUES('product_alpha','Current name','alpha',125000);
      INSERT INTO product_variants(id,product_id,sku,price_minor,is_default,track_inventory) VALUES('sku_alpha','product_alpha','ALPHA',125000,1,0);
    `);
  });
  afterEach(() => sqlite.close());

  it("writes only labels/identities and returns current prices at the HTTP edge", async () => {
    expect(await validateConversationProductRefs(db, [ref])).toEqual([{ ...ref, title: "Current name", variantLabel: null }]);
    expect(await projectConversationProductCards(db, [snapshot])).toEqual([{
      ...ref, title: "Current name", variantLabel: null, status: "available",
      price: { amount: 1250, currency: "BDT" }, imageUrl: null, pdpUrl: "/products/alpha?variant=sku_alpha",
    }]);
    sqlite.exec("UPDATE product_variants SET price_minor=90000,track_inventory=1,stock=0 WHERE id='sku_alpha'");
    expect((await projectConversationProductCards(db, [snapshot]))[0]).toMatchObject({ status: "sold_out", price: { amount: 900, currency: "BDT" } });
  });

  it("invalidates the whole send but keeps safe historical labels after unpublishing", async () => {
    await expect(validateConversationProductRefs(db, [ref, { productId: "missing", skuId: "missing" }])).rejects.toThrow("no longer available");
    sqlite.exec("UPDATE products SET is_active=0 WHERE id='product_alpha'");
    expect(await projectConversationProductCards(db, [snapshot])).toEqual([{
      ...snapshot, status: "unavailable", price: null, imageUrl: null, pdpUrl: null,
    }]);
  });

  it("rejects duplicate and oversize sends before database reads", async () => {
    await expect(validateConversationProductRefs(db, [])).rejects.toThrow("between 1 and 3");
    await expect(validateConversationProductRefs(db, [ref, ref])).rejects.toThrow("only once");
    await expect(validateConversationProductRefs(db, [ref, ref, ref, ref])).rejects.toThrow("between 1 and 3");
    expect(reads).toBe(0);
  });

  it("bounds archived Unicode labels without storing live facts", async () => {
    sqlite.prepare("UPDATE products SET name=? WHERE id='product_alpha'").run("😀".repeat(180));
    const [saved] = await validateConversationProductRefs(db, [ref]);
    expect([...saved!.title]).toHaveLength(160);
    expect(saved!.title.endsWith("…")).toBe(true);
    expect((await projectConversationProductCards(db, [saved!]))[0]?.title).toBe("😀".repeat(180));
  });

  it("hydrates all messages together, preserves body and ignores unrelated or malformed events", async () => {
    const thread = { orderId: null, messages: [
      { id: "1", body: null, eventKind: "product_reply", eventData: { v: 1, cards: [snapshot] } },
      { id: "2", body: "Take a look", eventKind: "product_reply", eventData: { v: 1, cards: [snapshot] } },
      { id: "3", body: null, eventKind: "status_changed", eventData: { v: 1, cards: [snapshot] } },
      { id: "4", body: null, eventKind: "product_reply", eventData: { v: 1, cards: [{ title: "Broken" }] } },
    ] };
    const hydrated = await hydrateConversationProducts(db, thread);
    expect(hydrated.messages[0]).toMatchObject({ products: [{ ...ref, status: "available" }] });
    expect(hydrated.messages[1]).toMatchObject({ body: "Take a look", products: [{ ...ref, status: "available" }] });
    expect(hydrated.messages[2]).not.toHaveProperty("products");
    expect(hydrated.messages[3]).not.toHaveProperty("products");
    expect(thread.messages[0]).not.toHaveProperty("products");
    expect(reads).toBe(3);
  });

  it("does not silently use root prices when the order market cannot be resolved", async () => {
    expect((await projectConversationProductCards(db, [snapshot], { orderId: "missing_order" }))[0]).toMatchObject({ status: "unavailable", price: null, pdpUrl: null });
    await expect(validateConversationProductRefs(db, [ref], { orderId: "missing_order" })).rejects.toThrow("market is unavailable");
  });

  it.each([null, "mkt_backup"])("resolves root order prices for saved market %s", async (marketId) => {
    sqlite.prepare(`INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,subtotal_amount_minor,status,market_id)
      VALUES('order_alpha','Local buyer','+8801711111111','Local address','c','z',10000,10000,'confirmed',?)`).run(marketId);
    expect((await projectConversationProductCards(db, [snapshot], { orderId: "order_alpha" }))[0]).toMatchObject({ status: "available", price: { amount: 1250, currency: "BDT" } });
    expect(await validateConversationProductRefs(db, [ref], { orderId: "order_alpha" })).toHaveLength(1);
  });

  it("uses sequential bounded batches for shared carts", async () => {
    const refs = Array.from({ length: 99 }, (_, i) => ({ productId: `product_${i}`, skuId: `sku_${i}` }));
    for (const item of refs) {
      sqlite.prepare("INSERT INTO products(id,name,slug,price_minor) VALUES(?,?,?,10000)").run(item.productId, item.productId, item.productId.replaceAll("_", "-"));
      sqlite.prepare("INSERT INTO product_variants(id,product_id,sku,price_minor,is_default,track_inventory) VALUES(?,?,?,10000,1,0)").run(item.skuId, item.productId, item.skuId);
    }
    expect(await validateConversationCartProductRefs(db, refs)).toHaveLength(99);
    expect(reads).toBe(6);
  });
});
