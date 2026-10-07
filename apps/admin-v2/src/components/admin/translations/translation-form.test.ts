import { describe, expect, it } from "vitest";
import type { ResourceTranslationsView } from "~/lib/api-query-options/translations";
import { draftKey, initialDraft, isDirty, saveBody, translationRows } from "./translation-form";

type Resource = ResourceTranslationsView["resource"];

const resource = (overrides: Partial<Resource>): Resource => ({
  type: "product",
  id: "p_tee",
  title: "Tee",
  subtitle: null,
  source: {},
  sourceSlug: null,
  translation: null,
  slug: null,
  status: "untranslated",
  ...overrides,
} as Resource);

const VIEW: ResourceTranslationsView = {
  resource: resource({
    source: { name: "Tee", description: "<p>Cotton.</p>", metaTitle: "", metaDescription: null },
    sourceSlug: "tee",
    translation: { locale: "bn", marketId: null, fields: { name: "টি" }, outdated: ["name"], updatedAt: null },
    slug: "ti",
    status: "outdated",
  }),
  parts: [
    resource({ type: "product_option", id: "opt_size", title: "Size", source: { name: "Size" } }),
    resource({ type: "product_option_value", id: "ov_m", title: "M", subtitle: "opt_size", source: { value: "M" } }),
  ],
} as ResourceTranslationsView;

describe("the translation editor's form", () => {
  it("lists the fields with source text, marks the outdated ones and groups each value under its option", () => {
    const rows = translationRows(VIEW);
    expect(rows.map((row) => [row.entry, row.field, row.outdated])).toEqual([
      ["product:p_tee", "name", true],
      ["product:p_tee", "description", false],
      ["product_option:opt_size", "name", false],
      ["product_option_value:ov_m", "value", false],
    ]);
    expect(rows[1]!.kind).toBe("html");
  });

  it("saves the resource's fields and handle, and only the parts that changed", () => {
    const draft = initialDraft(VIEW);
    expect(isDirty(VIEW, draft, "ti")).toBe(false);
    draft[draftKey({ entry: "product_option_value:ov_m", field: "value" })] = "মাঝারি";
    draft[draftKey({ entry: "product:p_tee", field: "description" })] = "  ";
    expect(isDirty(VIEW, draft, "ti")).toBe(true);
    expect(saveBody(VIEW, draft, { locale: "bn", marketId: null, slug: "ti" })).toEqual({
      locale: "bn",
      marketId: null,
      fields: { name: "টি" },
      slug: "ti",
      parts: [{ type: "product_option_value", id: "ov_m", fields: { value: "মাঝারি" } }],
    });
    // A market adaptation has no handle of its own.
    expect(saveBody(VIEW, draft, { locale: "bn", marketId: "mkt_in", slug: "ti" })).not.toHaveProperty("slug");
  });
});

describe("the languages a merchant can add", () => {
  it("are two-letter codes, the store locale grammar", async () => {
    const { LANGUAGE_CODES } = await import("./translation-form");
    expect(LANGUAGE_CODES.filter((code) => !/^[a-z]{2}$/.test(code))).toEqual([]);
  });
});
