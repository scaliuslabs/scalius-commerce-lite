import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withPublicMediaUrl } from "../../integrations/storage";
import { getPublicSkuCards } from "./public-sku-cards";
import { startMarketPricing, type MarketPricing } from "../price-lists";
import { addStoreLanguage, saveTranslations, setStoreLanguagePublished } from "../translations";

let sqlite: DatabaseSync;
let db: Database;
let queries: string[];
function simple(id: string, kind = "physical") {
  sqlite.prepare("INSERT INTO products(id,name,slug,price_minor) VALUES(?,?,?,100000)").run(id, `Product ${id}`, id);
  sqlite.prepare("INSERT INTO product_variants(id,product_id,sku,price_minor,is_default,track_inventory,fulfillment_kind) VALUES(?,?,?,100000,1,0,?)").run(`sku_${id}`, id, `code_${id}`, kind);
  return { productId: id, skuId: `sku_${id}` };
}

describe("exact public SKU cards", () => {
  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
  });
  afterEach(() => sqlite.close());

  it("keeps requested identity/order, private facts out and query count constant", async () => {
    const a = simple("alpha");
    const b = simple("beta", "digital");
    const cards = await getPublicSkuCards(db, [b, a]);
    expect(cards.map((card) => card.skuId)).toEqual([b.skuId, a.skuId]);
    expect(cards[0]).toEqual({ ...b, title: "Product beta", variantLabel: null, priceMinor: 100000, currencyCode: "BDT", availableForSale: true, imageUrl: null, pdpUrl: "/products/beta?variant=sku_beta" });
    expect(queries).toHaveLength(3);
  });

  it("rejects wrong-product, hidden, deleted and unpublished identities", async () => {
    const a = simple("alpha");
    const b = simple("beta");
    expect(await getPublicSkuCards(db, [{ ...a, skuId: b.skuId }])).toEqual([]);
    sqlite.exec("UPDATE products SET is_active=0 WHERE id='alpha'");
    expect(await getPublicSkuCards(db, [a])).toEqual([]);
    sqlite.exec("UPDATE products SET is_active=1,deleted_at=1 WHERE id='alpha'");
    expect(await getPublicSkuCards(db, [a])).toEqual([]);
    sqlite.exec("UPDATE products SET deleted_at=NULL WHERE id='alpha'; UPDATE product_channel_publications SET unpublished_at=unixepoch() WHERE product_id='alpha' AND channel_id='sc_online_store'");
    expect(await getPublicSkuCards(db, [a])).toEqual([]);
    sqlite.exec("UPDATE product_variants SET deleted_at=1 WHERE id='sku_beta'");
    expect(await getPublicSkuCards(db, [b])).toEqual([]);
  });

  it("keeps sold-out products public and uses exact SKU discounts over product discounts", async () => {
    const ref = simple("alpha");
    sqlite.exec("UPDATE products SET discount_type='percentage',discount_bps=1000 WHERE id='alpha'; UPDATE product_variants SET track_inventory=1,stock=0 WHERE id='sku_alpha'");
    expect((await getPublicSkuCards(db, [ref]))[0]).toMatchObject({ availableForSale: false, priceMinor: 90000 });
    sqlite.exec("UPDATE product_variants SET discount_type='flat',discount_amount_minor=25000 WHERE id='sku_alpha'");
    expect((await getPublicSkuCards(db, [ref]))[0]).toMatchObject({ availableForSale: false, priceMinor: 75000 });
  });

  it("does not recommend a hidden default when options exist and labels the exact SKU", async () => {
    const hidden = simple("alpha");
    sqlite.exec(`
      INSERT INTO product_option_definitions(id,product_id,name,normalized_name,position) VALUES('axis','alpha','Finish','finish',0);
      INSERT INTO product_option_values(id,option_definition_id,value,normalized_value,position) VALUES('value','axis','Matt','matt',0);
      INSERT INTO product_variants(id,product_id,sku,price_minor,is_default,track_inventory,option_combination_key) VALUES('sku_matt','alpha','MATT',125000,0,0,'value');
      INSERT INTO product_variant_option_values(variant_id,option_definition_id,option_value_id) VALUES('sku_matt','axis','value');
    `);
    expect(await getPublicSkuCards(db, [hidden])).toEqual([]);
    expect((await getPublicSkuCards(db, [{ productId: "alpha", skuId: "sku_matt" }]))[0]).toMatchObject({ variantLabel: "Finish: Matt", priceMinor: 125000 });
  });

  it("uses the online store's locations instead of total stock", async () => {
    const ref = simple("alpha");
    sqlite.exec(`
      INSERT INTO inventory_locations(id,name,code,status,position) VALUES('loc_other','Other','OTHER','active',1);
      UPDATE product_variants SET track_inventory=1,stock=5 WHERE id='sku_alpha';
      UPDATE inventory_levels SET on_hand=0 WHERE variant_id='sku_alpha' AND location_id='loc_default';
      INSERT INTO inventory_levels(variant_id,location_id,on_hand) VALUES('sku_alpha','loc_other',5);
      DELETE FROM sales_channel_locations WHERE channel_id='sc_online_store' AND location_id='loc_other';
    `);
    expect((await getPublicSkuCards(db, [ref]))[0]?.availableForSale).toBe(false);
  });

  it("uses a published language's name and real handle", async () => {
    const ref = simple("alpha");
    await addStoreLanguage(db, { locale: "bn", published: true }).catch(() => setStoreLanguagePublished(db, "bn", true));
    await saveTranslations(db, { locale: "bn", entries: [{ type: "product", id: ref.productId, fields: { name: "নতুন পণ্য" }, slug: "notun-ponno" }] });
    sqlite.exec("UPDATE products SET canonical_path='/products/alpha' WHERE id='alpha'");
    const card = (await getPublicSkuCards(db, [ref], startMarketPricing(db, "bn")))[0];
    expect(card).toMatchObject({ title: "নতুন পণ্য", currencyCode: "BDT", pdpUrl: "/bn/products/notun-ponno?variant=sku_alpha" });
  });

  it("uses current market currency and never applies native product discounts twice", async () => {
    const ref = simple("alpha");
    sqlite.exec("UPDATE products SET discount_type='percentage',discount_bps=1000 WHERE id='alpha'");
    const pricing: MarketPricing = { presence: "en-kw", context: Promise.resolve({
      marketId: "mkt_kuwait", currencyCode: "KWD", decimalPlaces: 3, incrementMinor: 1,
      shopCurrencyCode: "BDT", shopIncrementMinor: 100, listed: false, money: null, atSeconds: 1,
      fx: { policy: { rate: "0.0025", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, fromDecimalPlaces: 2, toDecimalPlaces: 3, incrementMinor: 1 },
    }) };
    expect((await getPublicSkuCards(db, [ref], pricing))[0]).toMatchObject({ priceMinor: 2250, currencyCode: "KWD", pdpUrl: "/en-kw/products/alpha?variant=sku_alpha" });
    sqlite.exec("UPDATE products SET discount_type='flat',discount_bps=0,discount_amount_minor=20000 WHERE id='alpha'");
    expect((await getPublicSkuCards(db, [ref], pricing))[0]?.priceMinor).toBe(2000);
    sqlite.exec("UPDATE product_variants SET discount_type='flat',discount_amount_minor=25000 WHERE id='sku_alpha'");
    expect((await getPublicSkuCards(db, [ref], pricing))[0]?.priceMinor).toBe(1875);
  });

  it("uses market list prices without applying product or SKU discounts again", async () => {
    const ref = simple("alpha");
    sqlite.exec(`
      INSERT INTO markets(id,handle,name,status) VALUES('mkt_in','india','India','active');
      INSERT INTO market_presences(id,market_id,kind,value,locale) VALUES('mkp_in','mkt_in','subfolder','en-in','en');
      INSERT INTO price_lists(id,name,kind,market_id,status) VALUES('pl_india','India prices','market','mkt_in','active');
      INSERT INTO price_list_prices(price_list_id,variant_id,currency_code,amount_minor,compare_at_minor) VALUES('pl_india','sku_alpha','BDT',60000,90000);
      UPDATE products SET discount_type='flat',discount_amount_minor=20000 WHERE id='alpha';
    `);
    expect((await getPublicSkuCards(db, [ref], startMarketPricing(db, "en-in")))[0]?.priceMinor).toBe(60000);
    sqlite.exec("UPDATE product_variants SET discount_type='flat',discount_amount_minor=25000 WHERE id='sku_alpha'");
    expect((await getPublicSkuCards(db, [ref], startMarketPricing(db, "en-in")))[0]?.priceMinor).toBe(60000);
  });

  it("uses the SKU photo, falls back to primary and never deep-links a different canonical product", async () => {
    const ref = simple("alpha");
    sqlite.exec(`
      INSERT INTO media(id,filename,kind,object_key,size,mime_type,status) VALUES
        ('primary','primary.webp','image','products/primary.webp',1,'image/webp','ready'),
        ('exact','exact.webp','image','products/exact.webp',1,'image/webp','ready');
      INSERT INTO product_media(id,product_id,media_id,is_primary,sort_order) VALUES
        ('pmed_primary','alpha','primary',1,0),('pmed_exact','alpha','exact',0,1);
      UPDATE product_variants SET image_id='pmed_exact' WHERE id='sku_alpha';
      UPDATE products SET canonical_path='/products/another-product' WHERE id='alpha';
    `);
    const read = () => withPublicMediaUrl("https://media.example.com", () => getPublicSkuCards(db, [ref]));
    expect((await read())[0]).toMatchObject({ imageUrl: "https://media.example.com/products/exact.webp", pdpUrl: "/products/alpha?variant=sku_alpha" });
    sqlite.exec("UPDATE product_variants SET image_id=NULL WHERE id='sku_alpha'");
    expect((await read())[0]?.imageUrl).toBe("https://media.example.com/products/primary.webp");
  });

  it("bounds SQL parameters at 90 references and refuses larger batches before reads", async () => {
    const refs = Array.from({ length: 90 }, (_, i) => simple(`product-${i}`));
    const cards = await getPublicSkuCards(db, refs);
    expect(cards).toHaveLength(90);
    expect(queries).toHaveLength(3);
    queries.length = 0;
    await expect(getPublicSkuCards(db, [...refs, refs[0]!])).rejects.toThrow("at most 90");
    expect(queries).toHaveLength(0);
  });
});
