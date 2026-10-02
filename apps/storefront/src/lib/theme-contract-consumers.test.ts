// @vitest-environment node
// The theme contract's two promises to a builder (drag-and-drop, AI or a
// plugin section) that mixes blocks freely:
// 1. `template` is a label. No storefront component and not the resolver
//    branches on it; every behaviour is a block, setting or token the
//    document states.
// 2. Every choice does something. Each enum value of every block setting,
//    the listing's and product page's choices, toolbar pieces, product
//    modules and section settings has a consumer: a storefront renderer
//    that names it, or the variant's own `renders` (resolver) mapping.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STOREFRONT_BLOCK_REGISTRY,
  STOREFRONT_LISTING_FILTER_SPECS,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_SECTION_REGISTRY,
  storefrontListingFilterDefaultOrder,
  storefrontThemeBlocksSchema,
  type StorefrontBlockSlot,
} from "@scalius/shared/storefront-theme";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const RESOLVER = fileURLToPath(new URL("../../../../packages/shared/src/storefront-theme/resolve.ts", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sources(path);
    return /\.(astro|ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const RESOLVE_SOURCE = readFileSync(RESOLVER, "utf8");
/**
 * Every renderer plus the resolver and the shared mappings renderers read a
 * choice through (a filter style's measured spec): where a choice can be consumed.
 */
const CORPUS = [...FILES.map((file) => file.text), RESOLVE_SOURCE, JSON.stringify(STOREFRONT_LISTING_FILTER_SPECS)].join("\n");

type ZodNode = { _zod: { def: Record<string, unknown> & { type: string } } };

/** Enum values in a schema, with their path (objects, arrays, optionals and unions walked). */
function enumValues(schema: ZodNode, path: string): Array<{ path: string; value: string }> {
  const def = schema._zod.def;
  switch (def.type) {
    case "object":
      return Object.entries(def.shape as Record<string, ZodNode>).flatMap(([key, child]) => enumValues(child, `${path}.${key}`));
    case "enum":
      return Object.values(def.entries as Record<string, string>).map((value) => ({ path, value }));
    case "optional":
    case "nullable":
    case "default":
      return enumValues(def.innerType as ZodNode, path);
    case "array":
      return enumValues(def.element as ZodNode, path);
    case "union":
      return (def.options as ZodNode[]).flatMap((option) => enumValues(option, path));
    default:
      return [];
  }
}

/** The setting keys of an object schema (variant settings are flat objects). */
function settingKeys(schema: ZodNode): string[] {
  return schema._zod.def.type === "object" ? Object.keys(schema._zod.def.shape as object) : [];
}

const escaped = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
/** Named as a string, or as a key of an exhaustive map (`{ inset: ..., flush: ... }`). */
const quoted = (value: string, text: string) =>
  new RegExp(`["'\`]${escaped(value)}["'\`]`).test(text) || new RegExp(`[{,]\\s*${escaped(value)}:\\s`).test(text);
const named = (key: string, text: string) => new RegExp(`\\b${key}\\b`).test(text);

describe("template is a label", () => {
  it("no storefront component reads the document's template for behaviour", () => {
    const reads = FILES.filter((file) =>
      /\b(?:resolved|theme|document|requestTheme(?:\.resolved)?)\.template\b/.test(file.text)
      || /\btemplate\s*[!=]==/.test(file.text))
      .map((file) => file.path);
    expect(reads).toEqual([]);
  });

  it("the resolver passes the label through and reads it nowhere else", () => {
    expect(RESOLVE_SOURCE.match(/\bdocument\.template\b/g)).toEqual(["document.template"]);
    expect(RESOLVE_SOURCE).toMatch(/template: document\.template,/);
    expect(RESOLVE_SOURCE).not.toMatch(/\btemplate\s*[!=]==/);
    // A filter style's arrangement depends on the style alone.
    expect(storefrontListingFilterDefaultOrder.length).toBe(1);
  });
});

describe("every theme choice has a consumer", () => {
  it("names every block variant setting in a renderer or its variant's resolver mapping", () => {
    const missing: string[] = [];
    for (const [slot, variants] of Object.entries(STOREFRONT_BLOCK_REGISTRY) as unknown as Array<[StorefrontBlockSlot, Record<string, { settings: ZodNode; renders: (settings: never) => unknown }>]>) {
      for (const [id, spec] of Object.entries(variants)) {
        const mapping = spec.renders.toString();
        for (const key of settingKeys(spec.settings)) {
          if (!named(key, CORPUS) && !named(key, mapping)) missing.push(`${slot}.${id}.${key}`);
        }
        for (const { path, value } of enumValues(spec.settings, `${slot}.${id}`)) {
          if (!quoted(value, CORPUS) && !quoted(value, mapping)) missing.push(`${path}=${value}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("consumes every listing, filter, sticky and navigation value the blocks schema allows", () => {
    const blocks = storefrontThemeBlocksSchema as unknown as ZodNode;
    const shape = blocks._zod.def.shape as Record<string, ZodNode>;
    // Variant blocks are covered above; walk the composite choices.
    const values = [
      ...enumValues(shape.listing!, "listing"),
      ...enumValues(shape.product!, "product"),
      ...enumValues(shape.navigation!, "navigation"),
    ].filter(({ path }) => !path.endsWith(".variant"));
    const missing = values.filter(({ value }) => !quoted(value, CORPUS)).map(({ path, value }) => `${path}=${value}`);
    expect(missing).toEqual([]);
  });

  it("renders every toolbar piece and product module", () => {
    const pieces = Object.keys(STOREFRONT_LISTING_TOOLBAR).filter((piece) => !quoted(piece, CORPUS));
    const modules = Object.keys(STOREFRONT_PRODUCT_MODULES).filter((module) => !quoted(module, CORPUS));
    expect({ pieces, modules }).toEqual({ pieces: [], modules: [] });
    // The product page switches over every module (no module waits for a renderer).
    const page = FILES.find((file) => file.path === join("pages", "products", "[slug].astro"))!.text;
    expect(Object.keys(STOREFRONT_PRODUCT_MODULES).filter((module) => !page.includes(`case "${module}":`))).toEqual([]);
  });

  it("consumes every section setting value", () => {
    const missing = Object.entries(STOREFRONT_SECTION_REGISTRY).flatMap(([type, spec]) =>
      enumValues(spec.settings as unknown as ZodNode, type).filter(({ value }) => !quoted(value, CORPUS)).map(({ path, value }) => `${path}=${value}`));
    expect(missing).toEqual([]);
  });
});
