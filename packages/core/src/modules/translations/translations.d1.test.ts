// The store's languages and the translation editor (MARKETS-DESIGN D9) over
// the migrated schema: one language list, a default that is always
// published, per-field digests that mark a translation Outdated, and
// localized handles that never take another resource's.
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  addStoreLanguage,
  getResourceTranslations,
  listStoreLanguages,
  listTranslatableResources,
  removeStoreLanguage,
  saveTranslations,
  setDefaultStoreLanguage,
  setStoreLanguagePublished,
} from "./index";

function store() {
  const { sqlite, db } = createSqliteD1Database();
  sqlite.exec(`
    INSERT INTO products (id, name, description, price_minor, slug, is_active) VALUES
      ('p_tee', 'Tee', '<p>Cotton tee.</p>', 50000, 'tee', 1),
      ('p_cap', 'Cap', NULL, 20000, 'cap', 1);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_tee', 'Size', 'size', 0);
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES ('ov_m', 'opt_size', 'M', 'm', 0);
    DELETE FROM checkout_languages;
    INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default) VALUES
      ('cl_en', 'English', 'en', '{}', '{}', 1, 1), ('cl_bn', 'Bangla', 'bn', '{}', '{}', 0, 0);
  `);
  return { sqlite, db };
}

describe("store languages", () => {
  it("keeps one list: the default language is the root's, always published, and a language in use stays", async () => {
    const { db, sqlite } = store();
    const initial = await listStoreLanguages(db);
    expect(initial.find((language) => language.isDefault)).toMatchObject({ locale: "en", published: true, presences: [""] });

    await addStoreLanguage(db, { locale: "bn" }).catch(() => undefined);
    await setStoreLanguagePublished(db, "bn", true);
    await expect(setStoreLanguagePublished(db, "en", false)).rejects.toThrow(/default language is always published/);

    // Making Bangla the default moves the root and the checkout copy in use.
    await setDefaultStoreLanguage(db, "bn");
    expect(sqlite.prepare("SELECT locale FROM market_presences WHERE market_id = 'mkt_backup'").get()).toEqual({ locale: "bn" });
    expect(sqlite.prepare("SELECT id FROM checkout_languages WHERE is_active = 1").get()).toEqual({ id: "cl_bn" });
    await expect(removeStoreLanguage(db, "bn")).rejects.toThrow(/uses this language/);
    await removeStoreLanguage(db, "en");
    expect((await listStoreLanguages(db)).map((language) => language.locale)).not.toContain("en");
  });
});

describe("the translation editor", () => {
  it("saves a product with its parts, marks a changed source Outdated and lists its status", async () => {
    const { db, sqlite } = store();
    await addStoreLanguage(db, { locale: "bn", published: true }).catch(() => setStoreLanguagePublished(db, "bn", true));

    await saveTranslations(db, {
      locale: "bn",
      entries: [
        { type: "product", id: "p_tee", fields: { name: "টি-শার্ট", description: "<p>সুতির টি-শার্ট</p>" }, slug: "ti-shirt" },
        { type: "product_option", id: "opt_size", fields: { name: "মাপ" } },
        { type: "product_option_value", id: "ov_m", fields: { value: "মাঝারি" } },
      ],
    });
    const view = await getResourceTranslations(db, "product", "p_tee", { locale: "bn" });
    expect(view.resource).toMatchObject({ slug: "ti-shirt", status: "translated", translation: { fields: { name: "টি-শার্ট" }, outdated: [] } });
    expect(view.parts.map((part) => [part.type, part.status])).toEqual([["product_option", "translated"], ["product_option_value", "translated"]]);

    // A source edit marks only the edited field Outdated; the text is still served.
    sqlite.exec("UPDATE products SET name = 'Cotton Tee' WHERE id = 'p_tee'");
    const outdated = await getResourceTranslations(db, "product", "p_tee", { locale: "bn" });
    expect(outdated.resource.status).toBe("outdated");
    expect(outdated.resource.translation?.outdated).toEqual(["name"]);

    const list = await listTranslatableResources(db, "product", { locale: "bn" });
    expect(list.items.map((item) => [item.id, item.status]).sort()).toEqual([["p_cap", "untranslated"], ["p_tee", "outdated"]]);

    // Saving again takes the current source's digest.
    await saveTranslations(db, { locale: "bn", entries: [{ type: "product", id: "p_tee", fields: { name: "সুতির টি-শার্ট" } }] });
    expect((await getResourceTranslations(db, "product", "p_tee", { locale: "bn" })).resource.status).toBe("partial");
  });

  it("refuses a handle another resource uses, a field the type does not have and a market-specific handle", async () => {
    const { db } = store();
    await addStoreLanguage(db, { locale: "bn", published: true }).catch(() => setStoreLanguagePublished(db, "bn", true));
    await expect(saveTranslations(db, { locale: "bn", entries: [{ type: "product", id: "p_tee", fields: {}, slug: "cap" }] }))
      .rejects.toThrow(/uses this web address/);
    await expect(saveTranslations(db, { locale: "bn", entries: [{ type: "product", id: "p_tee", fields: { colour: "x" } }] }))
      .rejects.toThrow(/not a field/);
    await expect(saveTranslations(db, { locale: "bn", marketId: "mkt_backup", entries: [{ type: "product", id: "p_tee", fields: {}, slug: "ti" }] }))
      .rejects.toThrow(/every market/);
    await expect(saveTranslations(db, { locale: "xx", entries: [{ type: "product", id: "p_tee", fields: { name: "x" } }] }))
      .rejects.toThrow();
  });
});
