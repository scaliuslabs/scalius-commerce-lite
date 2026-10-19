// The theme document's compatibility gate (../storefront-theme.md,
// "Compatibility"). A stored theme is never reset, so:
//
//   1. every golden stored document (compat/v<n>/*.json, never edited once
//      committed) of every readable version reads through the upgrade chain,
//      and the current version's goldens parse with no upgrade at all;
//   2. the goldens place every section type and every block variant, so a
//      section or block change that breaks stored settings fails here;
//   3. the chain has a step for every version from the oldest readable one,
//      and a golden for every readable version;
//   4. compat.snapshot.json equals the contract exactly. Accept an additive
//      change (an optional field, an enum value, a section type) with
//      `vitest run -u` on this file after review. Anything else bumps the
//      document or section version, adds its upgrade step and freezes a
//      golden of the old version.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STOREFRONT_BLOCK_REGISTRY, STOREFRONT_BLOCK_SLOTS, storefrontBlockValue, type StorefrontBlockSlot } from "./blocks";
import { STOREFRONT_THEME_DOCUMENT_VERSION, storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { STOREFRONT_SECTION_REGISTRY, STOREFRONT_SECTION_TYPES, type StorefrontSection } from "./sections";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import {
  STOREFRONT_THEME_DOCUMENT_UPGRADES,
  STOREFRONT_THEME_OLDEST_READABLE_VERSION,
  StorefrontThemeUpgradeError,
  readStoredStorefrontThemeDocument,
  upgradeStorefrontThemeDocument,
  type StorefrontThemeUpgradeChain,
} from "./upgrade";

interface Golden {
  version: number;
  file: string;
  documents: unknown[];
}

/** Every golden document file: `compat/v<n>/<name>.json`, a list of stored documents. */
async function goldens(): Promise<Golden[]> {
  // Runtime specifiers keep Node types out of this Workers package (plugins/assets.test.ts).
  const [{ readFileSync, readdirSync }, { fileURLToPath }] = await Promise.all(
    ["node:fs", "node:url"].map((specifier) => import(/* @vite-ignore */ specifier)),
  ) as [
    { readFileSync(path: string, encoding: "utf8"): string; readdirSync(path: string): string[] },
    { fileURLToPath(url: URL): string },
  ];
  const root = fileURLToPath(new URL("./compat/", import.meta.url));
  return readdirSync(root).filter((dir) => /^v\d+$/.test(dir)).flatMap((dir) => readdirSync(`${root}${dir}`)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ version: Number(dir.slice(1)), file: `${dir}/${file}`, value: JSON.parse(readFileSync(`${root}${dir}/${file}`, "utf8")) as unknown }))
    .filter((entry): entry is { version: number; file: string; value: unknown[] } => Array.isArray(entry.value))
    .map(({ version, file, value }) => ({ version, file, documents: value })));
}

function sectionsOf(document: StorefrontThemeDocument): StorefrontSection[] {
  return [
    ...document.pages.home,
    ...Object.values(document.pages.landing).flatMap((page) => page.sections),
    ...Object.values(document.pages.templates).flatMap((template) => template.sections),
  ];
}

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { unrepresentable: "any", reused: "ref" });

/** What the snapshot seals: the document, and each section type's version and settings. */
function contract() {
  return {
    version: STOREFRONT_THEME_DOCUMENT_VERSION,
    oldestReadable: STOREFRONT_THEME_OLDEST_READABLE_VERSION,
    sections: Object.fromEntries(STOREFRONT_SECTION_TYPES.map((type) => {
      const entry = STOREFRONT_SECTION_REGISTRY[type];
      return [type, { version: entry.version, settings: jsonSchema(entry.settings) }];
    })),
    document: jsonSchema(storefrontThemeDocumentSchema),
  };
}

describe("the theme document's compatibility gate", () => {
  it("reads every golden stored document of every readable version", async () => {
    const all = await goldens();
    expect(all.length).toBeGreaterThan(0);
    for (const { file, documents } of all) {
      documents.forEach((document, index) => {
        const read = readStoredStorefrontThemeDocument(JSON.stringify(document));
        expect(read.ok ? null : read.reason, `${file} #${index}`).toBeNull();
      });
    }
  });

  it("parses the current version's goldens with no upgrade", async () => {
    for (const { file, documents } of (await goldens()).filter((golden) => golden.version === STOREFRONT_THEME_DOCUMENT_VERSION)) {
      documents.forEach((document, index) => {
        const issues = storefrontThemeDocumentSchema.safeParse(document).error?.issues.slice(0, 3) ?? [];
        expect(issues, `${file} #${index}`).toEqual([]);
      });
    }
  });

  it("places every section type and every block variant in the goldens", async () => {
    const types = new Set<string>();
    const variants = new Set<string>();
    for (const { documents } of await goldens()) {
      for (const stored of documents) {
        const read = readStoredStorefrontThemeDocument(stored);
        if (!read.ok) continue;
        for (const section of sectionsOf(read.document)) types.add(section.type);
        for (const slot of STOREFRONT_BLOCK_SLOTS) variants.add(`${slot}:${storefrontBlockValue(read.document.blocks, slot).variant}`);
      }
    }
    expect(STOREFRONT_SECTION_TYPES.filter((type) => !types.has(type))).toEqual([]);
    expect(types.has("app")).toBe(true);
    const every = (Object.keys(STOREFRONT_BLOCK_REGISTRY) as StorefrontBlockSlot[])
      .flatMap((slot) => Object.keys(STOREFRONT_BLOCK_REGISTRY[slot]).map((variant) => `${slot}:${variant}`));
    expect(every.filter((variant) => !variants.has(variant))).toEqual([]);
  });

  it("has a step from every readable version and a golden of each", async () => {
    const versions = new Set((await goldens()).map((golden) => golden.version));
    for (let version = STOREFRONT_THEME_OLDEST_READABLE_VERSION; version <= STOREFRONT_THEME_DOCUMENT_VERSION; version += 1) {
      expect(versions.has(version), `a golden of version ${version}`).toBe(true);
      if (version < STOREFRONT_THEME_DOCUMENT_VERSION) expect(typeof STOREFRONT_THEME_DOCUMENT_UPGRADES[version], `the step from ${version}`).toBe("function");
    }
    expect(Object.keys(STOREFRONT_THEME_DOCUMENT_UPGRADES).map(Number).filter((version) =>
      version < STOREFRONT_THEME_OLDEST_READABLE_VERSION || version >= STOREFRONT_THEME_DOCUMENT_VERSION)).toEqual([]);
    for (const type of STOREFRONT_SECTION_TYPES) {
      const entry = STOREFRONT_SECTION_REGISTRY[type];
      for (let version = 1; version < entry.version; version += 1) {
        expect(typeof (entry.upgrades as Record<number, unknown>)[version], `${type} from ${version}`).toBe("function");
      }
    }
  });

  it("matches the committed contract snapshot (accept an additive change with -u)", async () => {
    await expect(`${JSON.stringify(contract(), null, 1)}\n`).toMatchFileSnapshot("./compat.snapshot.json");
  });
});

describe("the upgrade chain", () => {
  // A synthetic chain: version 10 to 12, where 11 renames `template` to
  // `basedOn` and 12 adds `notes`; `hero` sections went 1 to 2 (`slides` to `frames`).
  const chain: StorefrontThemeUpgradeChain = {
    oldest: 10,
    current: 12,
    documents: {
      10: ({ template, ...rest }) => (template === undefined ? rest : { ...rest, basedOn: template }),
      11: (document) => ({ ...document, notes: [] }),
    },
    section: (type) => type === "hero"
      ? { version: 2, upgrades: { 1: (settings) => { const { slides, ...rest } = settings as { slides: unknown }; return { ...rest, frames: slides }; } } }
      : null,
  };
  const hero = { id: "hero", type: "hero", version: 1, settings: { layout: "split", slides: ["a"] } };
  const app = { id: "app", type: "app", version: 1, settings: { app: "acme.app/x", values: {} } };

  it("runs the document steps from the stored version, then each section's own", () => {
    const stored = { version: 10, template: "boutique", pages: { home: [hero, app], landing: { eid: { title: "Eid", sections: [hero] } }, templates: { product: { sections: [hero], main: 0 } } } };
    const upgraded = upgradeStorefrontThemeDocument(stored, chain);
    expect(upgraded).toEqual({
      version: 12,
      basedOn: "boutique",
      notes: [],
      pages: {
        home: [{ ...hero, version: 2, settings: { layout: "split", frames: ["a"] } }, app],
        landing: { eid: { title: "Eid", sections: [{ ...hero, version: 2, settings: { layout: "split", frames: ["a"] } }] } },
        templates: { product: { sections: [{ ...hero, version: 2, settings: { layout: "split", frames: ["a"] } }], main: 0 } },
      },
    });
    // Pure: the stored value is unchanged.
    expect(stored.template).toBe("boutique");
    expect(stored.pages.home[0]).toBe(hero);
  });

  it("starts where the stored document is and upgrades parts of a document", () => {
    expect(upgradeStorefrontThemeDocument({ version: 11, tokens: {} }, chain)).toEqual({ version: 12, tokens: {}, notes: [] });
    expect(upgradeStorefrontThemeDocument({ version: 12, pages: { home: [{ ...hero, version: 2 }] } }, chain))
      .toEqual({ version: 12, pages: { home: [{ ...hero, version: 2 }] } });
  });

  it("fails closed on a version it cannot read and on a step that throws", () => {
    expect(() => upgradeStorefrontThemeDocument({ version: 9 }, chain)).toThrow(StorefrontThemeUpgradeError);
    expect(() => upgradeStorefrontThemeDocument({ version: 13 }, chain)).toThrow(/newer/);
    expect(() => upgradeStorefrontThemeDocument({ template: "boutique" }, chain)).toThrow(/version/);
    expect(() => upgradeStorefrontThemeDocument({ ...{ version: 10 }, pages: { home: [{ ...hero, version: 0 }] } }, chain)).toThrow(/from version 0/);
    const broken: StorefrontThemeUpgradeChain = { ...chain, documents: { ...chain.documents, 11: () => { throw new TypeError("boom"); } } };
    expect(() => upgradeStorefrontThemeDocument({ version: 10 }, broken)).toThrow("The upgrade from version 11 failed (TypeError).");
  });

  it("reads a stored document of this build strictly, and refuses other versions", () => {
    expect(readStoredStorefrontThemeDocument(JSON.stringify(DEFAULT_STOREFRONT_THEME))).toEqual({ ok: true, document: DEFAULT_STOREFRONT_THEME, storedVersion: 10 });
    expect(readStoredStorefrontThemeDocument(JSON.stringify({ version: 10 })).ok).toBe(false);
    expect(readStoredStorefrontThemeDocument("{").ok).toBe(false);
    expect(readStoredStorefrontThemeDocument(JSON.stringify({ version: 9 }))).toEqual({ ok: false, reason: "Version 9 is older than the oldest readable version (10)." });
  });
});
