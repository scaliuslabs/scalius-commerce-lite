import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { countMediaUsage, loadMediaUsage } from "./media.usage";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("media usage on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("retains named references, counts and order flags through the production proxy", async () => {
    const { db, client } = await createNativePostgres({ label: "media_usage" });
    await client.query(`
      INSERT INTO media (id,filename,kind,object_key,size,mime_type,status) VALUES
        ('media_proxy','proxy.png','image','media/proxy.png',12,'image/png','ready'),
        ('media_unused','unused.png','image','media/unused.png',12,'image/png','ready');
      INSERT INTO products (id,name,price_minor,slug) VALUES ('prod_proxy','Proxy product',100,'proxy-product');
      INSERT INTO product_media (id,product_id,media_id,sort_order) VALUES ('pmed_proxy','prod_proxy','media_proxy',0);
      INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone)
        VALUES ('ord_proxy','Buyer','+8801700000001','Address','city','zone');
      INSERT INTO order_items (id,order_id,product_id,quantity,product_image_media_id)
        VALUES ('item_proxy','ord_proxy','prod_proxy',1,'media_proxy');
    `);
    expect([...await countMediaUsage(db, ["media_proxy", "media_unused"])]).toEqual([
      ["media_proxy", { usageCount: 1, keptForOrders: true }],
      ["media_unused", { usageCount: 0, keptForOrders: false }],
    ]);
    expect(await loadMediaUsage(db, "media_proxy")).toEqual({
      count: 1, orderCount: 1,
      references: [{ kind: "product", id: "prod_proxy", name: "Proxy product", trashed: false }],
    });
  });
});
