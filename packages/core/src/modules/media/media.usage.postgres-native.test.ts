import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { countMediaUsage, loadMediaUsage } from "./media.usage";
import { MediaDependencyConflictError, permanentlyDeleteMediaFile, trashMediaFile } from "./media.service";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("media usage on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("retains description references and delete guards after the partial-index upgrade", async () => {
    const { db, client } = await createNativePostgres({ label: "media_text_index" });
    const deleted: string[] = [];
    const bucket = { delete: async (key: string) => { deleted.push(key); } } as unknown as R2Bucket;
    await client.query(`
      INSERT INTO media (id,filename,kind,object_key,size,mime_type,status)
        VALUES ('media_text','text.png','image','media/text.png',12,'image/png','ready');
      INSERT INTO products (id,name,slug,description,deleted_at)
        VALUES ('prod_text','Text product','text-product','prefixmedia/text.png suffix',1);
    `);
    expect((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'products_media_text_idx'")).rows)
      .toEqual([{ indexname: "products_media_text_idx" }]);
    expect((await countMediaUsage(db, ["media_text"])).get("media_text")).toEqual({ usageCount: 1, keptForOrders: false });
    const trashed = await trashMediaFile(db, "media_text", 1);
    await expect(permanentlyDeleteMediaFile(db, "media_text", trashed.version, bucket)).rejects.toBeInstanceOf(MediaDependencyConflictError);
    expect(deleted).toEqual([]);
    await client.query("UPDATE products SET description = NULL WHERE id = 'prod_text'");
    expect((await countMediaUsage(db, ["media_text"])).get("media_text")).toEqual({ usageCount: 0, keptForOrders: false });
    await client.query("UPDATE products SET description = '<img src=\"/media/text.png\">' WHERE id = 'prod_text'");
    expect((await loadMediaUsage(db, "media_text")).references)
      .toEqual([{ kind: "product", id: "prod_text", name: "Text product", trashed: true }]);
    await client.query("UPDATE products SET description = 'Plain description' WHERE id = 'prod_text'");
    await permanentlyDeleteMediaFile(db, "media_text", trashed.version, bucket);
    expect(deleted).toContain("media/text.png");
  });

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
