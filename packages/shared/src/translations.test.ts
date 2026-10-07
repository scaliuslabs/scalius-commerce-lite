import { describe, expect, it } from "vitest";
import {
  isLocalizedSlug,
  normalizeTranslationFields,
  outdatedTranslationFields,
  presenceLocale,
  resolveTranslatedField,
  resolveTranslatedRecord,
  sourceTextDigest,
  translatableField,
  translationChain,
  translationFieldIssues,
  translationSourceDigest,
  type TranslationRow,
} from "./translations";

const row = (locale: string, marketId: string | null, fields: Record<string, string>): TranslationRow => ({ locale, marketId, fields });

describe("the fallback chain (market locale → store default locale → source)", () => {
  const rows = [
    row("en", null, { name: "Default English", description: "English text" }),
    row("bn", null, { name: "বাংলা নাম" }),
    row("bn", "mkt_in", { name: "ভারতের নাম" }),
    row("en", "mkt_in", { description: "Indian English text" }),
  ];

  it("puts the page's market-specific row first, then its locale, then the default locale's", () => {
    expect(translationChain(rows, { locale: "bn", marketId: "mkt_in", defaultLocale: "en" }).map((each) => `${each.locale}:${each.marketId}`))
      .toEqual(["bn:mkt_in", "bn:null", "en:mkt_in", "en:null"]);
    expect(translationChain(rows, { locale: "bn", marketId: null, defaultLocale: "en" }).map((each) => `${each.locale}:${each.marketId}`))
      .toEqual(["bn:null", "en:null"]);
    // The default locale's page: one locale in the chain.
    expect(translationChain(rows, { locale: "en", marketId: "mkt_in", defaultLocale: "en" }).map((each) => `${each.locale}:${each.marketId}`))
      .toEqual(["en:mkt_in", "en:null"]);
  });

  it("resolves each field on its own and falls back to the source, never to a blank", () => {
    const chain = translationChain(rows, { locale: "bn", marketId: "mkt_in", defaultLocale: "en" });
    expect(resolveTranslatedField(chain, "name", "Source")).toBe("ভারতের নাম");
    expect(resolveTranslatedField(chain, "description", "Source text")).toBe("Indian English text");
    expect(resolveTranslatedField(chain, "metaTitle", null)).toBeNull();
    const blank = translationChain([row("bn", null, { name: "  " })], { locale: "bn", marketId: null, defaultLocale: "en" });
    expect(resolveTranslatedField(blank, "name", "Source")).toBe("Source");
  });

  it("returns the same record when nothing is translated, so an untranslated read keeps its bytes", () => {
    const record = { name: "Tee", slug: "tee" };
    expect(resolveTranslatedRecord(record, [], ["name"])).toBe(record);
    expect(resolveTranslatedRecord(record, [row("bn", null, { description: "x" })], ["name"])).toBe(record);
    expect(resolveTranslatedRecord(record, [row("bn", null, { name: "টি" })], ["name"])).toEqual({ name: "টি", slug: "tee" });
  });
});

describe("Outdated markers", () => {
  it("marks a translated field Outdated when its source changed since", () => {
    const source = { name: "Tee", description: "Soft cotton" };
    const digest = translationSourceDigest(source, ["name", "description"]);
    expect(JSON.parse(digest)).toEqual({ description: sourceTextDigest("Soft cotton"), name: sourceTextDigest("Tee") });
    const translated = { name: "টি", description: "নরম সুতি" };
    expect(outdatedTranslationFields(translated, digest, source)).toEqual([]);
    expect(outdatedTranslationFields(translated, digest, { ...source, description: "Soft organic cotton" })).toEqual(["description"]);
    // No recorded digest: every translated field is Outdated.
    expect(outdatedTranslationFields(translated, "{}", source)).toEqual(["name", "description"]);
    expect(sourceTextDigest("a")).not.toBe(sourceTextDigest("b"));
    expect(sourceTextDigest("")).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("translatable fields", () => {
  it("knows each resource's fields, a menu's links and their limits", () => {
    expect(translatableField("product", "name")).toEqual({ key: "name", kind: "line", max: 255 });
    expect(translatableField("product", "sku")).toBeNull();
    expect(translatableField("menu", "item:it_123")?.kind).toBe("line");
    expect(translatableField("menu", "item:")).toBeNull();
    expect(translationFieldIssues("product", { name: "x".repeat(256), sku: "A", description: 3 as unknown as string })).toEqual([
      { field: "name", code: "too_long", max: 255 },
      { field: "sku", code: "unknown_field" },
      { field: "description", code: "not_text" },
    ]);
    expect(normalizeTranslationFields("product", { name: "  টি  ", description: "", metaTitle: "  " })).toEqual({ name: "টি" });
  });

  it("checks localized handles and presence locales", () => {
    expect(isLocalizedSlug("lal-shari")).toBe(true);
    for (const slug of ["Lal", "lal--shari", "-lal", "লাল", ""]) expect(isLocalizedSlug(slug), slug).toBe(false);
    expect(presenceLocale("bn-bd")).toBe("bn");
    expect(presenceLocale("")).toBeNull();
    expect(presenceLocale("../x")).toBeNull();
  });
});
