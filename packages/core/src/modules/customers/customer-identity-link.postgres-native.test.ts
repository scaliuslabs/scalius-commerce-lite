import { afterAll, describe, expect, it } from "vitest";
import { safeBatch } from "@scalius/database/client";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { buildVerifiedContactOrderLink } from "./customer-identity";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("verified contact linking on native PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("links two proven contacts once, preserves unrelated ownership, and carries only an eligible guest's consent", async () => {
    const { db, client } = await createNativePostgres({ label: "contact_link" });
    await client.query(`
      INSERT INTO customers (id,name,phone,account_claimed_at) VALUES
        ('account','Account','account-phone',100), ('other','Other','other-phone',100),
        ('guest','Guest','guest-phone',NULL), ('shared','Shared','shared-phone',NULL);
      INSERT INTO orders (id,customer_id,customer_name,customer_phone,customer_email,shipping_address,city,zone,total_amount_minor,account_owner_customer_id) VALUES
        ('email','guest','Guest','unproven','buyer@example.test','House','City','Zone',100,NULL),
        ('phone','guest','Guest','+8801712345678',NULL,'House','City','Zone',100,NULL),
        ('both','guest','Guest','+8801712345678','buyer@example.test','House','City','Zone',100,NULL),
        ('shared_match','shared','Shared','unproven','buyer@example.test','House','City','Zone',100,NULL),
        ('unrelated','shared','Shared','unrelated',NULL,'House','City','Zone',100,NULL),
        ('owned','other','Other','unproven','buyer@example.test','House','City','Zone',100,'other');
      INSERT INTO customer_marketing_consents (customer_id,channel,state,contact,source,actor,subscribed_at,created_at,updated_at) VALUES
        ('guest','email','subscribed','buyer@example.test','checkout','buyer',100,100,100),
        ('shared','email','subscribed','buyer@example.test','checkout','buyer',300,300,300);
    `);
    const link = () => safeBatch(db, buildVerifiedContactOrderLink(db, {
      customerId: "account", email: "buyer@example.test", phone: "+8801712345678",
    }) as unknown as Parameters<typeof safeBatch>[1]);
    await link();
    expect((await client.query("SELECT id FROM orders WHERE account_owner_customer_id='account' ORDER BY id")).rows)
      .toEqual([{ id: "both" }, { id: "email" }, { id: "phone" }, { id: "shared_match" }]);
    expect((await client.query("SELECT id FROM customers WHERE merged_into_customer_id='account'")).rows).toEqual([{ id: "guest" }]);
    expect((await client.query("SELECT account_owner_customer_id FROM orders WHERE id='owned'")).rows).toEqual([{ account_owner_customer_id: "other" }]);
    expect((await client.query("SELECT subscribed_at FROM customer_marketing_consents WHERE customer_id='account'")).rows).toEqual([{ subscribed_at: 100 }]);
    const history = (await client.query("SELECT count(*)::integer AS n FROM customer_history WHERE change_type='order_moved_in'")).rows;
    expect(history).toEqual([{ n: 4 }]);
    await link();
    expect((await client.query("SELECT count(*)::integer AS n FROM customer_history WHERE change_type='order_moved_in'")).rows).toEqual(history);
  });
});
