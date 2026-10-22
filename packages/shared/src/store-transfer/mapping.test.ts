import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures/fixture";
import { parseImportText } from "./detect";
import { mapShopifyProducts } from "./shopify-products";
import { mapWooCommerceProducts } from "./woocommerce-products";
import { mapCustomers } from "./customers";
import { inventoryItemsFromProducts, mapInventory } from "./inventory";
import { productImportItemSchema, compareAtDiscount } from "./products";
import { buildFailedRowsCsv, buildImportIssuesCsv } from "./issues";
import { parseCsv } from "./csv";

const BDT = { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 };
const FIXTURES = ["shopify-products.csv", "woocommerce-products.csv", "shopify-customers.csv", "woocommerce-customers.csv"];
const fixtures = new Map(await Promise.all(FIXTURES.map(async (name) => [name, await readFixture(name)] as const)));
const file = (name: string) => parseImportText(fixtures.get(name)!);

describe("format detection", () => {
  it("names each fixture's format", () => {
    expect(file("shopify-products.csv").detection.format).toBe("shopify_products");
    expect(file("woocommerce-products.csv").detection.format).toBe("woocommerce_products");
    expect(file("shopify-customers.csv").detection.format).toBe("shopify_customers");
    expect(file("woocommerce-customers.csv").detection.format).toBe("woocommerce_customers");
    expect(parseImportText("SKU,Location code,On hand\nA-1,MAIN,3\n").detection.format).toBe("scalius_inventory");
    expect(parseImportText("Handle,Title,Option1 Name,Option1 Value,SKU,Location,On hand\nmug,Mug,,,MUG-1,Shop,4\n").detection.format).toBe("shopify_inventory");
  });

  it("reports the closest format's missing columns for an unknown file", () => {
    const detection = parseImportText("Handle,Price\nmug,4\n").detection;
    expect(detection.format).toBeNull();
    expect(detection.missing).toContain("Title");
  });
});

describe("Shopify product CSV", () => {
  const { table } = file("shopify-products.csv");
  const result = mapShopifyProducts(table, { currency: BDT });
  const byRef = new Map(result.items.map((item) => [item.ref, item]));

  it("groups rows by handle into products with options, variants and images", () => {
    const tee = byRef.get("classic-cotton-tee")!;
    expect(tee.options).toEqual([{ name: "Color", values: ["Navy", "Maroon"] }, { name: "Size", values: ["M", "L", "XL"] }]);
    expect(tee.variants).toHaveLength(6);
    expect(tee.images.map((image) => image.url)).toEqual([
      "https://cdn.shopify.com/s/files/1/0000/0001/products/tee-navy.jpg",
      "https://cdn.shopify.com/s/files/1/0000/0001/products/tee-maroon.jpg",
      "https://cdn.shopify.com/s/files/1/0000/0001/products/tee-detail.jpg",
    ]);
    expect(tee.categoryPath).toEqual(["Men", "T-Shirts"]);
    expect(tee.brand).toBe("Deshi Threads");
    expect(tee.descriptionHtml).toContain("\"true\" to size");
    const navyM = tee.variants.find((variant) => variant.sku === "DT-TEE-NAV-M")!;
    expect(navyM).toMatchObject({ price: 650, compareAtPrice: 800, stock: 12, trackInventory: true, weightGrams: 180, requiresShipping: true });
    expect(compareAtDiscount(navyM)).toEqual({ basePrice: 800, discountAmount: 150 });
    expect(navyM.imageUrl).toContain("tee-navy.jpg");
  });

  it("treats Title / Default Title as a product without options", () => {
    const mug = byRef.get("ceramic-mug")!;
    expect(mug.options).toEqual([]);
    expect(mug.variants).toEqual([expect.objectContaining({ optionValues: [], sku: "MC-MUG-350", barcode: "4006381333931", stock: 25 })]);
  });

  it("keeps Bangla titles, option names and categories", () => {
    const kantha = byRef.get("nakshi-kantha-throw")!;
    expect(kantha.title).toBe("নকশী কাঁথা থ্রো");
    expect(kantha.options[0]).toEqual({ name: "রং", values: ["লাল", "নীল"] });
    expect(kantha.categoryPath).toEqual(["ঘর সাজানো", "কাঁথা"]);
  });

  it("imports gift cards as digital, untracked denominations", () => {
    const card = byRef.get("store-gift-card")!;
    expect(card.isGiftCard).toBe(true);
    expect(card.variants.every((variant) => !variant.trackInventory && !variant.requiresShipping)).toBe(true);
  });

  it("imports archived products as drafts and reports it", () => {
    expect(byRef.get("old-straw-hat")!.status).toBe("draft");
    expect(result.unsupported.find((entry) => entry.code === "archived")?.count).toBe(1);
  });

  it("fails only the broken product, with its line and column", () => {
    expect(byRef.has("broken-price-lamp")).toBe(false);
    const issue = result.issues.find((entry) => entry.code === "price_invalid")!;
    expect(issue).toMatchObject({ severity: "error", subject: "MC-LAMP-1", column: "Variant Price" });
    expect(issue.line).toBe(table.rows.find((row) => row.cells[0] === "broken-price-lamp")!.line);
    expect(result.stats.failedProducts).toBe(1);
  });

  it("summarizes what it can't import", () => {
    const codes = result.unsupported.map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["product_tags", "market_prices", "google_shopping_columns", "unit_price", "tax_codes", "extra_option"]));
    // Cost per item is stored on each SKU (cost_minor), so it is imported, not reported.
    expect(codes).not.toContain("sku_cost");
    expect(byRef.get("classic-cotton-tee")!.variants.map((variant) => variant.cost)).toEqual(Array(6).fill(310));
    expect(result.unsupported.find((entry) => entry.code === "product_tags")!.count).toBe(3);
  });

  describe("Option3", () => {
    it("keeps a third option by default (Scalius has up to five)", () => {
      const saree = byRef.get("jamdani-saree")!;
      expect(saree.options.map((option) => option.name)).toEqual(["Color", "Size", "Fabric"]);
      expect(saree.variants).toHaveLength(8);
      expect(result.stats.productsWithExtraOptions).toBe(1);
    });

    it("skip: drops the third option and keeps the first of each remaining combination", () => {
      const skipped = mapShopifyProducts(table, { currency: BDT, extraOptions: "skip" });
      const saree = skipped.items.find((item) => item.ref === "jamdani-saree")!;
      expect(saree.options.map((option) => option.name)).toEqual(["Color", "Size"]);
      expect(saree.variants).toHaveLength(4);
      expect(saree.variants.every((variant) => variant.sku!.endsWith("S"))).toBe(true);
      expect(skipped.issues.filter((issue) => issue.code === "variant_dropped_option3")).toHaveLength(4);
    });

    it("fold: one product per third-option value, titled with it", () => {
      const folded = mapShopifyProducts(table, { currency: BDT, extraOptions: "fold" });
      const sarees = folded.items.filter((item) => item.ref.startsWith("jamdani-saree"));
      expect(sarees.map((item) => [item.title, item.handle, item.variants.length])).toEqual([
        ["Jamdani Saree - Silk", "jamdani-saree-silk", 4],
        ["Jamdani Saree - Cotton", "jamdani-saree-cotton", 4],
      ]);
      expect(sarees[0]!.variants.every((variant) => variant.price === 9500)).toBe(true);
    });
  });

  it("fails fractional taka prices unless rounding is chosen", () => {
    const text = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price\nsoap,Neem Soap,Title,Default Title,SOAP-1,99.50\n";
    const { table: soapTable } = parseImportText(text);
    const strict = mapShopifyProducts(soapTable, { currency: BDT });
    expect(strict.items).toHaveLength(0);
    expect(strict.issues[0]).toMatchObject({ code: "price_not_whole_taka", line: 2 });
    const rounded = mapShopifyProducts(soapTable, { currency: BDT, roundPrices: true });
    expect(rounded.items[0]!.variants[0]!.price).toBe(100);
    expect(mapShopifyProducts(soapTable, { currency: { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 } }).items[0]!.variants[0]!.price).toBe(99.5);
    // A BDT store that prices in paisa imports paisa.
    expect(mapShopifyProducts(soapTable, { currency: { ...BDT, priceIncrementMinor: 1 } }).items[0]!.variants[0]!.price).toBe(99.5);
  });

  it("says in the preview when two products of the file share a SKU, and imports non-shipping rows as digital", () => {
    const text = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Requires Shipping\n"
      + "soap,Neem Soap,Title,Default Title,SOAP-1,99,TRUE\n"
      + "soap-2,Neem Soap 2,Title,Default Title,soap-1 ,120,TRUE\n"
      + "ebook,Soap Guide,Title,Default Title,BOOK-1,50,FALSE\n";
    const mapped = mapShopifyProducts(parseImportText(text).table, { currency: BDT });
    expect(mapped.items.map((item) => item.ref)).toEqual(["soap", "ebook"]);
    expect(mapped.issues).toEqual([expect.objectContaining({ code: "sku_duplicate_in_file", line: 3 })]);
    expect(mapped.stats.failedProducts).toBe(1);
    expect(mapped.items[1]!.variants[0]!.requiresShipping).toBe(false);
  });

  it("produces items the API schema accepts", () => {
    for (const item of result.items) expect(productImportItemSchema.safeParse(item).success).toBe(true);
  });
});

describe("WooCommerce product export", () => {
  const { table } = file("woocommerce-products.csv");
  const result = mapWooCommerceProducts(table, { currency: BDT });
  const byRef = new Map(result.items.map((item) => [item.ref, item]));

  it("builds a variable product from its variations; non-variation attributes become specs", () => {
    const panjabi = byRef.get("PJ-EID")!;
    expect(panjabi.options).toEqual([{ name: "Color", values: ["White", "Sky Blue"] }, { name: "Size", values: ["40", "42"] }]);
    expect(panjabi.attributes).toEqual([{ name: "Material", value: "Cotton" }]);
    expect(panjabi.variants.find((variant) => variant.sku === "PJ-EID-WH-40")).toMatchObject({
      optionValues: ["White", "40"], price: 1450, compareAtPrice: 1650, stock: 8, trackInventory: true, weightGrams: 350,
    });
    expect(panjabi.variants.find((variant) => variant.sku === "PJ-EID-SB-42")).toMatchObject({ price: 1650, compareAtPrice: null });
    expect(panjabi.brand).toBe("Deshi Threads");
    expect(panjabi.handle).toBe("eid-cotton-panjabi");
    expect(panjabi.handleIsIdentity).toBe(false);
    expect(panjabi.descriptionHtml).toBe("<p>Breathable cotton for Eid.</p><p>Hand-finished collar.</p><p>Machine wash cold.</p>");
  });

  it("reads category hierarchy, escaped commas and only the first category", () => {
    expect(byRef.get("PJ-EID")!.categoryPath).toEqual(["Clothing", "Men", "Panjabi"]);
    expect(byRef.get("TEA-500")!.categoryPath).toEqual(["Grocery", "Tea, Coffee"]);
    expect(result.unsupported.find((entry) => entry.code === "multiple_categories")?.examples).toEqual(["PJ-EID"]);
  });

  it("maps simple, virtual and unpublished products", () => {
    const tea = byRef.get("TEA-500")!;
    expect(tea.title).toBe("সিলেটের চা পাতা ৫০০ গ্রাম");
    expect(tea.handle).toBe("sileter-cha-pata-500-gram");
    expect(tea.variants[0]).toMatchObject({ price: 380, compareAtPrice: 420, barcode: "4006381333931", stock: 40 });
    expect(tea.attributes).toEqual([{ name: "Origin", value: "Sylhet" }]);
    expect(byRef.get("CONSULT-30")!.variants[0]).toMatchObject({ requiresShipping: false, trackInventory: false, stock: null });
    expect(byRef.get("DRAFT-BAG")!.status).toBe("draft");
  });

  it("reports grouped and external products instead of importing them", () => {
    expect(result.items).toHaveLength(4);
    const codes = result.unsupported.map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["grouped_products", "external_products", "product_tags", "meta_columns"]));
  });

  it("refuses an \"Any\" variation with a clear reason", () => {
    const text = [
      "ID,Type,SKU,Name,Published,Regular price,Parent,Attribute 1 name,Attribute 1 value(s)",
      "1,variable,SHOE,Canvas Shoe,1,,,Size,\"40, 41\"",
      "2,variation,SHOE-40,Canvas Shoe - 40,1,1200,id:1,Size,40",
      "3,variation,SHOE-ANY,Canvas Shoe,1,1200,id:1,Size,",
    ].join("\n");
    const mapped = mapWooCommerceProducts(parseImportText(text).table, { currency: BDT });
    expect(mapped.items).toHaveLength(0);
    expect(mapped.issues[0]).toMatchObject({ code: "variation_any_value", line: 4 });
  });
});

describe("customer CSVs", () => {
  it("normalizes phones, maps consent only from yes, and dedupes by phone and email", () => {
    const result = mapCustomers(file("shopify-customers.csv").table, "shopify_customers");
    expect(result.items.map((item) => item.phone)).toEqual(["+8801712345678", "+8801812345678", "+8801912345678"]);
    const [rahim, karim, nusrat] = result.items;
    expect(rahim).toMatchObject({ name: "রহিম উদ্দিন", email: "rahim@example.com", tags: ["vip", "dhaka"], marketing: { email: true, sms: true, whatsapp: false } });
    expect(rahim!.consentEvidence).toBe("Shopify customer export: Accepts Email Marketing = yes; Accepts SMS Marketing = yes");
    expect(rahim!.address).toEqual({
      countryCode: "BD", company: null, line1: "House 12, Road 5", line2: null, locality: "Dhaka", adminArea: null, postalCode: "1209",
    });
    expect(karim!.marketing).toEqual({ email: false, sms: false, whatsapp: false });
    // Consent to e-mail without an e-mail address is not consent to anything.
    expect(nusrat!.marketing.email).toBe(false);
    expect(result.issues.map((issue) => [issue.line, issue.code])).toEqual([
      [5, "phone_invalid"],
      [6, "phone_missing"],
      [7, "duplicate_phone"],
      [8, "phone_scientific"],
    ]);
    expect(result.unsupported.map((entry) => entry.code)).toEqual(expect.arrayContaining(["customer_notes", "order_history"]));
  });

  it("reads WooCommerce billing columns with Bangla digits", () => {
    const result = mapCustomers(file("woocommerce-customers.csv").table, "woocommerce_customers");
    expect(result.items.map((item) => [item.name, item.phone, item.marketing.email])).toEqual([
      ["Farhana Akter", "+8801711223344", false],
      ["Tanvir Hasan", "+8801611223344", false],
    ]);
    expect(result.unsupported.map((entry) => entry.code)).toContain("wordpress_logins");
  });

  it("round-trips our own customer export's consent columns", () => {
    const text = "Customer ID,Name,Phone,Email,Type,City,Zone,Orders,Amount spent,First order,Last order,Tags,Email marketing,SMS marketing,WhatsApp marketing,Customer since\n"
      + "cust_1,Rina,+8801555123456,rina@example.com,merchant,Dhaka,Mirpur,0,0,,,\"vip, eid\",subscribed,pending,subscribed,2026-01-01T00:00:00.000Z\n";
    const { table, detection } = parseImportText(text);
    expect(detection.format).toBe("scalius_customers");
    const [rina] = mapCustomers(table, "scalius_customers").items;
    expect(rina).toMatchObject({ phone: "+8801555123456", tags: ["vip", "eid"], marketing: { email: true, sms: false, whatsapp: true } });
  });
});

describe("inventory counts", () => {
  it("reads SKU, location and on-hand, refusing duplicates and bad numbers", () => {
    const text = "SKU,Location code,On hand\nA-1,MAIN,4\nA-1,SHOP,2\nA-1,MAIN,5\nB-2,,x\nC-3,,7\n";
    const result = mapInventory(parseImportText(text).table);
    expect(result.items.map((item) => [item.sku, item.location, item.onHand])).toEqual([["A-1", "MAIN", 4], ["A-1", "SHOP", 2], ["C-3", null, 7]]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["duplicate_count", "quantity_invalid"]);
  });

  it("turns a product file's quantities into default-location counts", () => {
    const products = mapShopifyProducts(file("shopify-products.csv").table, { currency: BDT });
    const counts = inventoryItemsFromProducts(products.items, products.variantLines);
    expect(counts.find((count) => count.sku === "MC-MUG-350")).toMatchObject({ onHand: 25, location: null });
    expect(counts.some((count) => count.sku.startsWith("GC-"))).toBe(false);
  });
});

describe("issue reports", () => {
  it("writes an error CSV and a failed-rows CSV that parse back", () => {
    const { table } = file("shopify-products.csv");
    const result = mapShopifyProducts(table, { currency: BDT });
    const report = parseCsv(buildImportIssuesCsv(result.issues)).records;
    expect(report[0]!.fields).toEqual(["Line", "Severity", "Subject", "Column", "Problem", "Code"]);
    const failed = parseCsv(buildFailedRowsCsv(table.headers, table.rows, result.issues)).records;
    expect(failed).toHaveLength(2);
    expect(failed[1]!.fields[0]).toContain("is not a number");
    expect(failed[1]!.fields[1]).toBe("broken-price-lamp");
  });
});
