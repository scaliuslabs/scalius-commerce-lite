import { metaConversionsSettings } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";
import { encryptCredentials, ENCRYPTED_CREDENTIAL_PREFIX } from "../../utils/credential-encryption";
import { getHomepageData, getLayoutData } from "./storefront.service";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("storefront layout data", () => {
  it("enables Meta CAPI browser dispatch only after a strict credential read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createSqliteD1Database();
    await db.insert(metaConversionsSettings).values({
      id: "singleton",
      pixelId: "123456",
      accessToken: `${ENCRYPTED_CREDENTIAL_PREFIX}${await encryptCredentials("token-value", KEY)}`,
      isEnabled: true,
    });

    expect((await getLayoutData(db, { credentialEncryptionKey: KEY })).metaCapi).toEqual({ browserEventsEnabled: true });
    expect((await getLayoutData(db, { credentialEncryptionKey: OTHER_KEY })).metaCapi).toEqual({ browserEventsEnabled: false });
    expect((await getLayoutData(db)).metaCapi).toEqual({ browserEventsEnabled: false });
  });

  it("normalizes an unsupported saved currency to the platform default", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO settings (id, key, value, category, type)
      VALUES ('set_currency', 'currency_code', 'ZZZ', 'currency', 'text')`);

    const layout = await getLayoutData(db);
    const fallback = await getLayoutData(createSqliteD1Database().db);
    expect(layout.currency.code).toBe(fallback.currency.code);
    expect(layout.currency.code).not.toBe("ZZZ");
  });
});

describe("storefront homepage data", () => {
  it("resolves only collections explicitly placed on the homepage", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO products (id, name, price, slug) VALUES ('p_1', 'Visible', 10, 'visible');
      INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_1', 'p_1', 'VIS-1', 10, 0, 0, 1, 0);
      INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
        ('col_home', 'Home', 'grid', '{"source":"manual","productIds":["p_1"],"showOnHomepage":true}', 0),
        ('col_hidden', 'Hidden', 'grid', '{"source":"manual","productIds":["p_1"],"showOnHomepage":false}', 1);
    `);

    const homepage = await getHomepageData(db);
    expect(homepage.collections.map((collection) => collection?.id)).toEqual(["col_home"]);
  });
});
