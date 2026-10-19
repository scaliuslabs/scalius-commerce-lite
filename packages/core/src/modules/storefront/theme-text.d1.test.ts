// Theme text in a presence's language (packages/shared/src/storefront-theme.md,
// Compatibility): the layout and homepage reads fold the presence's
// translation context into the theme statement they already run, resolve the
// document's own translations with the one fallback chain, declare
// `tr:locales`, and serve the theme in the page's words without its
// translations. The root reads exactly as before.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  DEFAULT_STOREFRONT_THEME,
  storefrontSectionDefault,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
  type StorefrontThemeDocument,
  type StorefrontThemeTranslation,
} from "@scalius/shared/storefront-theme";
import { withDependencyScope } from "../../cache-deps";
import { startMarketPricing } from "../price-lists/market-pricing";
import { createMarket } from "../markets/markets.service";
import { addStoreLanguage, setStoreLanguagePublished } from "../translations/store-languages.service";
import { getHomepageData, getLandingPageData, getLayoutData } from "./storefront.service";

let sqlite: DatabaseSync;
let db: Database;
let statements = 0;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database({ onQuery: () => { statements += 1; } }));
});
afterEach(() => sqlite.close());

const faq: StorefrontSection = {
  ...storefrontSectionDefault("faq", "faq"),
  settings: { heading: "Questions", items: [{ question: "Cash on delivery?", answer: "Yes." }] },
};

function store(translations?: StorefrontThemeTranslation[]): StorefrontThemeDocument {
  const theme = storefrontThemeDocumentSchema.parse({
    ...DEFAULT_STOREFRONT_THEME,
    blocks: { ...DEFAULT_STOREFRONT_THEME.blocks, topBar: { variant: "announcement", settings: { text: "Free delivery", link: null } } },
    pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: [faq], landing: { eid: { title: "Eid sale", description: "", sections: [faq] } } },
    ...(translations ? { translations } : {}),
  });
  sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1) ON CONFLICT (id) DO UPDATE SET colors = excluded.colors")
    .run(JSON.stringify(theme));
  return theme;
}

const heading = (theme: StorefrontThemeDocument) => (theme.pages.home[0] as Extract<StorefrontSection, { type: "faq" }>).settings.heading;
const announcement = (theme: StorefrontThemeDocument) => (theme.blocks.topBar.settings as { text: string }).text;

async function count<T>(read: () => Promise<T>): Promise<number> {
  statements = 0;
  await read();
  return statements;
}

describe("theme text at a presence", () => {
  it("serves the theme in the presence's words, the market's own first, and the root as stored", async () => {
    await addStoreLanguage(db, { locale: "bn", published: true });
    const india = await createMarket(db, { name: "Bangla India", status: "active", countries: ["IN"], presence: { value: "bn-in", locale: "bn" } });
    store([
      { locale: "bn", marketId: null, fields: { Questions: "প্রশ্ন", "Free delivery": "ফ্রি ডেলিভারি", "Eid sale": "ঈদ সেল" } },
      { locale: "bn", marketId: india.id, fields: { Questions: "জিজ্ঞাসা" } },
    ]);

    const root = await getLayoutData(db);
    expect(root.theme.translations).toBeUndefined();
    expect(heading(root.theme)).toBe("Questions");

    const bangla = await withDependencyScope(() => getLayoutData(db, { presence: "bn" }));
    expect(heading(bangla.value.theme)).toBe("প্রশ্ন");
    expect(announcement(bangla.value.theme)).toBe("ফ্রি ডেলিভারি");
    expect(bangla.value.theme.translations).toBeUndefined();
    expect(bangla.dependencies.keys).toEqual(expect.arrayContaining(["tr:locales"]));

    const inIndia = await getLayoutData(db, { presence: "bn-in" });
    expect(heading(inIndia.theme)).toBe("জিজ্ঞাসা");
    expect(announcement(inIndia.theme)).toBe("ফ্রি ডেলিভারি");

    // A landing page's title in its language, from the landing read.
    const landing = await getLandingPageData(db, "eid", { pricing: startMarketPricing(db, "bn") });
    expect(landing?.landing.title).toBe("ঈদ সেল");

    // An unpublished language is not served: its subfolder reads the source words.
    await setStoreLanguagePublished(db, "bn", false);
    expect(heading((await getLayoutData(db, { presence: "bn" })).theme)).toBe("Questions");
  });

  it("folds into the statements the reads already run", async () => {
    await addStoreLanguage(db, { locale: "bn", published: true });
    store();
    const layout = await count(() => getLayoutData(db, { presence: "bn" }));
    const home = await count(() => getHomepageData(db, { pricing: startMarketPricing(db, "bn") }));
    store([{ locale: "bn", marketId: null, fields: { Questions: "প্রশ্ন" } }]);
    expect(await count(() => getLayoutData(db, { presence: "bn" }))).toBe(layout);
    expect(await count(() => getHomepageData(db, { pricing: startMarketPricing(db, "bn") }))).toBe(home);
    expect(await count(() => getLayoutData(db))).toBe(layout);
  });
});
