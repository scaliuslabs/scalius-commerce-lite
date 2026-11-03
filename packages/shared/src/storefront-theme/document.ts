// The storefront theme document (version 13): the template it is based on
// (a label: no renderer reads it), the tokens, one variant per block (plus
// the shared navigation source, the listing's filter style and page chrome),
// the page sections and the page templates' sections. The dashboard
// and a future builder write it; the storefront renders it. Contract:
// ../storefront-theme.md. `storefrontThemeDocumentSchema` is the only way in.
import { z } from "zod";
import {
  STOREFRONT_THEME_TEXT_PAIRS,
  listStorefrontThemeContrastProblems,
  listStorefrontThemeSemanticColorProblems,
  storefrontHeaderToneColors,
  type StorefrontThemeColorKey,
  type StorefrontThemeContrastPair,
  type StorefrontThemeContrastProblem,
  type StorefrontThemeContrastRole,
} from "./contrast";
import {
  STOREFRONT_BLOCK_SLOTS,
  storefrontBlockValue,
  storefrontThemeBlocksSchemaOf,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontThemeBlocks,
} from "./blocks";
import { storefrontSkinRefSchema, storefrontThemeAppsSchemaOf } from "./apps";
import { storefrontThemeBrandSchema } from "./brand";
import { storefrontProductSourceSchema, storefrontSectionListSchemaOf } from "./sections";
import { storefrontSettingBindingsSchema } from "./bindings";
import { storefrontLandingPageSchemaOf, storefrontLandingPagesSchemaOf, storefrontPageTemplateSchemaOf, storefrontPageTemplatesSchemaOf } from "./pages";
import {
  buildStorefrontTokenCss,
  storefrontDarkColorsMissing,
  storefrontDarkPalette,
  storefrontThemeShowsDarkColors,
  storefrontThemeTokensSchema,
  type StorefrontThemeColorSet,
  type StorefrontThemeTokens,
} from "./tokens";
import { storefrontThemeTranslationsSchema } from "./text";

export const STOREFRONT_THEME_DOCUMENT_VERSION = 13 as const;

/**
 * The five presets of one design system ("Scalius Base"), named by
 * archetype: Department (the default), Boutique, Marketplace, Essentials
 * and Landing. Each is a set of token values and block choices, never a
 * look of its own.
 */
export const STOREFRONT_TEMPLATE_IDS = [
  "department-mall",
  "boutique",
  "marketplace",
  "daily-essentials",
  "showcase-landing",
] as const;
export type StorefrontTemplateId = (typeof STOREFRONT_TEMPLATE_IDS)[number];

/**
 * A variant and every variant it can fall back to: the resolver picks one
 * of them per store, so contrast is checked on all of them.
 */
export function storefrontVariantChain(slot: StorefrontBlockSlot, id: string): string[] {
  const chain: string[] = [];
  for (let current: string | null = id; current !== null && !chain.includes(current);) {
    chain.push(current);
    current = storefrontVariantSpec(slot, current).fallback;
  }
  return chain;
}

/** Every text/surface pair the document's blocks can paint: the base set plus each variant's own. */
export function storefrontThemeContrastPairs(blocks: StorefrontThemeBlocks): StorefrontThemeContrastPair[] {
  const pairs: StorefrontThemeContrastPair[] = [...STOREFRONT_THEME_TEXT_PAIRS];
  for (const slot of STOREFRONT_BLOCK_SLOTS) {
    for (const id of storefrontVariantChain(slot, storefrontBlockValue(blocks, slot).variant)) {
      pairs.push(...storefrontVariantSpec(slot, id).contrastPairs);
    }
  }
  return pairs;
}

/**
 * Pairs below AA for one colour set of a document (the colours, or the dark
 * colours), its blocks and header tone. No dark colours: no problems.
 */
export function listStorefrontThemeDocumentContrastProblems(document: {
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone"> & Partial<Pick<StorefrontThemeTokens, "darkColors">>;
  blocks: StorefrontThemeBlocks;
}, set: StorefrontThemeColorSet = "colors"): StorefrontThemeContrastProblem[] {
  const colors = document.tokens[set];
  if (!colors) return [];
  return listStorefrontThemeContrastProblems(colors, storefrontThemeContrastPairs(document.blocks), document.tokens.headerTone);
}

/**
 * The document with dark colours buyers can read: dark colours a new look's
 * blocks or header tone leave below the rules are made again from the
 * colours, so applying a template never opens a draft with a setting to fix.
 */
export function storefrontThemeWithReadableDarkColors<Document extends {
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone" | "colorScheme" | "darkColors" | "colorSchemeToggle">;
  blocks: StorefrontThemeBlocks;
}>(document: Document): Document {
  const { darkColors } = document.tokens;
  if (!darkColors || !storefrontThemeShowsDarkColors(document.tokens)) return document;
  const readable = listStorefrontThemeDocumentContrastProblems(document, "darkColors").length === 0
    && listStorefrontThemeSemanticColorProblems(darkColors).length === 0;
  return readable ? document : { ...document, tokens: { ...document.tokens, darkColors: storefrontDarkPalette(document.tokens.colors) } };
}

/** The colour token behind a contrast role in one colour set (header roles follow the header tone). */
export function storefrontContrastRoleToken(
  role: StorefrontThemeContrastRole,
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone"> & Partial<Pick<StorefrontThemeTokens, "darkColors">>,
  set: StorefrontThemeColorSet = "colors",
): StorefrontThemeColorKey {
  const header = storefrontHeaderToneColors(tokens.headerTone, tokens[set] ?? tokens.colors);
  if (role === "header-background") return header.background;
  if (role === "header-foreground") return header.foreground;
  return role;
}

/**
 * What `/` shows: the homepage sections, or one product's page (a single
 * product store, the BD F-commerce shape). `product` answers `/` with a
 * redirect to that product's own URL (its canonical), so the page has one
 * address; while the product is not public, `/` renders the sections.
 */
export const storefrontHomeModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sections") }).strict(),
  z.object({ kind: z.literal("product"), productId: z.string().trim().min(1).max(64) }).strict(),
]);
export type StorefrontHomeMode = z.infer<typeof storefrontHomeModeSchema>;

/**
 * Names a shared part of the document schema. The API names each part
 * (`.openapi(name)`), so its contract states the section list and the
 * landing page once and refers to them; everywhere else they stay unnamed.
 */
export type StorefrontSchemaNamer = <Schema extends z.ZodType>(name: string, schema: Schema) => Schema;

/** The document schema and its shared parts, each part named by `name`. */
export function buildStorefrontThemeDocumentSchemas(name: StorefrontSchemaNamer = (_name, schema) => schema) {
  const bindings = name("StorefrontSettingBindings", storefrontSettingBindingsSchema);
  const productSource = name("StorefrontProductSource", storefrontProductSourceSchema);
  const skin = name("StorefrontSkinRef", storefrontSkinRefSchema);
  const sections = name("StorefrontSectionList", storefrontSectionListSchemaOf(skin, bindings, productSource));
  const landingPage = name("StorefrontLandingPage", storefrontLandingPageSchemaOf(sections));
  const pageTemplate = name("StorefrontPageTemplate", storefrontPageTemplateSchemaOf(sections));
  const document = z.object({
    version: z.literal(STOREFRONT_THEME_DOCUMENT_VERSION),
    /**
     * The template the document is based on; it stays when blocks or tokens
     * change. A label only: every behaviour is a block, setting or token, so
     * blocks from any template (or a builder) mix freely.
     */
    template: z.enum(STOREFRONT_TEMPLATE_IDS),
    tokens: storefrontThemeTokensSchema,
    /** The logo, its width, the footer logo and the tab icon (media ids). */
    brand: storefrontThemeBrandSchema,
    blocks: storefrontThemeBlocksSchemaOf(bindings),
    /**
     * The units app skins draw (header, footer, product card, product page,
     * listing) and the app template the look came from. Absent: core draws
     * every unit.
     */
    apps: storefrontThemeAppsSchemaOf(skin).optional(),
    /**
     * Section pages: the homepage and landing pages (`/pages/<slug>`), and the
     * sections around the product, listing, cart and CMS pages' fixed parts.
     * A fixed part's own structure is `blocks`.
     */
    pages: z.object({
      home: sections,
      /** What `/` shows: the sections, or one product's page. */
      homeMode: storefrontHomeModeSchema,
      landing: storefrontLandingPagesSchemaOf(landingPage),
      templates: storefrontPageTemplatesSchemaOf(pageTemplate),
    }).strict(),
    /**
     * The words of sections, skins, the announcement, the footer and landing
     * pages in the store's other languages, keyed by the source words
     * (text.ts). Absent: the theme shows its words in every language.
     */
    translations: storefrontThemeTranslationsSchema.optional(),
  }).strict().superRefine((value, context) => {
    // The dark colours meet the same rules as the colours while buyers can see them.
    const sets: StorefrontThemeColorSet[] = storefrontThemeShowsDarkColors(value.tokens) ? ["colors", "darkColors"] : ["colors"];
    if (storefrontDarkColorsMissing(value.tokens)) {
      context.addIssue({ code: "custom", path: ["tokens", "darkColors"], message: "A dark or device colour scheme, or the buyer's switch, needs the dark colours." });
    }
    for (const set of sets) {
      const colors = value.tokens[set];
      if (!colors) continue;
      for (const { text, surface, ratio } of listStorefrontThemeDocumentContrastProblems(value, set)) {
        context.addIssue({
          code: "custom",
          path: ["tokens", set, storefrontContrastRoleToken(text, value.tokens, set)],
          message: `${text} on ${surface} has contrast ${ratio.toFixed(2)}:1; it needs at least 4.5:1.`,
        });
      }
      for (const problem of listStorefrontThemeSemanticColorProblems(colors)) {
        context.addIssue({ code: "custom", path: ["tokens", set, "muted-foreground"], message: problem });
      }
    }
  });
  return { document, sections, landingPage, pageTemplate };
}

/** The complete, strict theme document schema. Writes and reads both use it. */
export const storefrontThemeDocumentSchema = buildStorefrontThemeDocumentSchemas().document;

export type StorefrontThemeDocument = z.infer<typeof storefrontThemeDocumentSchema>;
export type StorefrontThemePages = StorefrontThemeDocument["pages"];

/** JSON Schema of the document (structure only; contrast lives in the Zod schema). */
export function storefrontThemeDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(storefrontThemeDocumentSchema, { unrepresentable: "any" }) as Record<string, unknown>;
}

/** CSS custom properties for a document: only constants and validated hex colours. */
export function buildStorefrontThemeTokens(document: Pick<StorefrontThemeDocument, "tokens">): Record<string, string> {
  return buildStorefrontTokenCss(document.tokens);
}
