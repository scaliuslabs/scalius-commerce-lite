import { describe, expect, it } from "vitest";
import { PRESENCE_PREFIXES, canEditPresence, presenceEditMask, presenceKeyPrefix, presenceKeyTopic, realtimeTopicsFor } from "./realtime";

describe("editor presence permissions", () => {
  it.each([
    ["customer:cus_1", "customers", "customers.view"],
    ["discount:disc_1", "discounts", "discounts.view"],
    ["gift-card:gc_1", "gift_cards", "gift_cards.view"],
    ["purchase-order:po_1", "inventory", "inventory.view"],
    ["transfer:tr_1", "inventory", "inventory.view"],
    ["supplier:sup_1", "inventory", "inventory.view"],
    ["brand:brand_1", "categories", "categories.view"],
    ["conversation:cnv_1", "inbox", "conversations.view"],
    ["price-list:pl_1", "products", "products.view"],
    ["media:med_1", "media", "media.view"],
    ["attribute:attr_1", "attributes", "attributes.view"],
    ["menu:menu_1", "navigation", "settings.header.edit"],
  ])("registers %s only under the resource's read permission", (key, topic, permission) => {
    expect(presenceKeyTopic(key)).toBe(topic);
    expect(realtimeTopicsFor([permission])).toContain(topic);
    expect(realtimeTopicsFor([])).not.toContain(topic);
    expect(realtimeTopicsFor(["settings.general.edit"])).not.toContain(topic);
  });

  it("keeps hibernating socket grant positions stable and within a positive integer mask", () => {
    expect(PRESENCE_PREFIXES).toEqual(["order", "product", "category", "collection", "page", "theme", "settings", "customer", "discount", "gift-card", "purchase-order", "transfer", "supplier", "brand", "conversation", "price-list", "media", "attribute", "menu"]);
    expect(PRESENCE_PREFIXES.length).toBeLessThanOrEqual(31);
  });

  it("separates viewers from editing hints using existing mutation permissions", () => {
    const viewer = presenceEditMask(["orders.view", "products.view", "customers.view", "gift_cards.view", "settings.general.view"]);
    expect(viewer).toBe(0);
    const editor = presenceEditMask(["orders.change_status", "categories.edit", "settings.seo.edit", "conversations.reply", "media.upload"]);
    for (const prefix of ["order", "category", "brand", "theme", "settings", "media"] as const) expect(canEditPresence(editor, prefix)).toBe(true);
    for (const prefix of ["conversation", "customer", "product", "menu"] as const) expect(canEditPresence(editor, prefix)).toBe(false);
    expect(canEditPresence(presenceEditMask(["settings.header.edit"]), "menu")).toBe(true);
  });

  it.each(["customer:someone@example.test", "discount:code with spaces", "supplier:", "unknown:x", "gift-card:a:b", `customer:${"a".repeat(81)}`])("refuses malformed keys: %s", (key) => {
    expect(presenceKeyPrefix(key)).toBeNull();
    expect(presenceKeyTopic(key)).toBeNull();
  });
});
