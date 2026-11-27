// The storefront theme document (version 15): the template it is based on
// (a label: no renderer reads it), the tokens, one variant per block (plus
// the shared navigation source, the listing's filter style and page chrome,
// and the presentation of the buyer's private pages not yet drawn from
// parts), the page sections and the page templates' sections, and how the
// cart page and drawer are arranged, worded and styled (`privatePages`). The dashboard
// and a future builder write it; the storefront renders it. Contract:
// ../storefront-theme.md. `storefrontThemeDocumentSchema` is the only way in:
// its structure on every read, and the write policy
// (`storefrontThemeDocumentPolicyIssues`) on every write (save.ts).
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
import { storefrontAppValuesSchema, storefrontSkinRefSchemaOf, storefrontThemeAppsSchemaOf } from "./apps";
import { storefrontThemeBrandSchema } from "./brand";
import { storefrontProductSourceSchema, storefrontSectionListSchemaOf } from "./sections";
import { storefrontSettingBindingsSchema } from "./bindings";
import { storefrontLandingPageSchemaOf, storefrontLandingPagesSchemaOf, storefrontPageTemplateSchemaOf, storefrontPageTemplatesSchemaOf } from "./pages";
import {
  buildStorefrontTokenCss,
  listStorefrontPagePaintContrastProblems,
  storefrontTokensWithReadablePaint,
  storefrontDarkColorsMissing,
  storefrontDarkPalette,
  storefrontThemeColorsSchema,
  storefrontThemeShowsDarkColors,
  storefrontThemeTokensSchemaOf,
  type StorefrontThemeColorSet,
  type StorefrontThemeTokens,
} from "./tokens";
import { storefrontThemeTranslationsSchema } from "./text";
import { storefrontPrivatePagesSchema } from "./private-schema";

export const STOREFRONT_THEME_DOCUMENT_VERSION = 16 as const;

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
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone" | "colorScheme" | "darkColors" | "colorSchemeToggle"> & Partial<Pick<StorefrontThemeTokens, "pagePaint">>;
  blocks: StorefrontThemeBlocks;
}>(document: Document): Document {
  const { darkColors } = document.tokens;
  const readable = !darkColors || !storefrontThemeShowsDarkColors(document.tokens) || (listStorefrontThemeDocumentContrastProblems(document, "darkColors").length === 0
    && listStorefrontThemeSemanticColorProblems(darkColors).length === 0);
  const tokens = readable ? document.tokens : { ...document.tokens, darkColors: storefrontDarkPalette(document.tokens.colors) };
  // A page paint the look's colours cannot read on goes: the page colour paints.
  const painted = storefrontTokensWithReadablePaint(tokens);
  return painted === document.tokens ? document : { ...document, tokens: painted };
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
  // An app's setting values: one shape for its sections, skins and product blocks.
  const appValues = name("StorefrontAppSettingValues", storefrontAppValuesSchema);
  const skin = name("StorefrontSkinRef", storefrontSkinRefSchemaOf(appValues, bindings));
  const sections = name("StorefrontSectionList", storefrontSectionListSchemaOf(skin, bindings, productSource, appValues));
  const landingPage = name("StorefrontLandingPage", storefrontLandingPageSchemaOf(sections));
  const pageTemplate = name("StorefrontPageTemplate", storefrontPageTemplateSchemaOf(sections));
  const tokens = storefrontThemeTokensSchemaOf(name("StorefrontThemeColors", storefrontThemeColorsSchema));
  const document = z.object({
    version: z.literal(STOREFRONT_THEME_DOCUMENT_VERSION),
    /**
     * The template the document is based on; it stays when blocks or tokens
     * change. A label only: every behaviour is a block, setting or token, so
     * blocks from any template (or a builder) mix freely.
     */
    template: z.enum(STOREFRONT_TEMPLATE_IDS),
    tokens,
    /** The logo, its width, the footer logo and the tab icon (media ids). */
    brand: storefrontThemeBrandSchema,
    blocks: storefrontThemeBlocksSchemaOf(bindings, appValues),
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
    /**
     * The buyer's private pages drawn from named parts (private-layout.ts):
     * their arrangement, typed tokens, words and icons there (no theme markup
     * or CSS), and the CSS the store compiled from the tokens on save.
     */
    privatePages: name("StorefrontPrivatePages", storefrontPrivatePagesSchema),
  }).strict();
  return { document, sections, landingPage, pageTemplate };
}

/**
 * The complete, strict theme document schema: its structure (shapes, closed
 * lists, the bounds the renderer relies on). Reads use it alone, so a stored
 * theme never stops reading because a later build checks more; a write also
 * runs `storefrontThemeDocumentPolicyIssues` (save.ts), which may grow.
 */
export const storefrontThemeDocumentSchema = buildStorefrontThemeDocumentSchemas().document;

export type StorefrontThemeDocument = z.infer<typeof storefrontThemeDocumentSchema>;
export type StorefrontThemePages = StorefrontThemeDocument["pages"];

/** Why a write refuses a well-formed document: a policy the store holds every theme to when it is written. */
export const STOREFRONT_THEME_POLICY_REASONS = ["dark_colors_missing", "contrast", "semantic_color"] as const;
export type StorefrontThemePolicyReason = (typeof STOREFRONT_THEME_POLICY_REASONS)[number];

export interface StorefrontThemePolicyIssue {
  path: Array<string | number>;
  message: string;
  reason: StorefrontThemePolicyReason;
}

/**
 * What a write refuses in a well-formed document: dark colours wherever a
 * scheme or the switch shows them, readable text (AA) in each colour set
 * buyers see for the blocks chosen and every variant they fall back to, a
 * neutral helper text apart from the error colour, and the store's page
 * text on every colour the page paint shows. Never run on a read: a stored
 * document a later, stricter policy refuses still reads and draws as it
 * was saved, and is refused only when it is saved again.
 */
export function storefrontThemeDocumentPolicyIssues(document: Pick<StorefrontThemeDocument, "tokens" | "blocks">): StorefrontThemePolicyIssue[] {
  const issues: StorefrontThemePolicyIssue[] = [];
  const { tokens } = document;
  if (storefrontDarkColorsMissing(tokens)) {
    issues.push({ path: ["tokens", "darkColors"], reason: "dark_colors_missing", message: "A dark or device colour scheme, or the buyer's switch, needs the dark colours." });
  }
  // The dark colours meet the same rules as the colours while buyers can see them.
  const sets: StorefrontThemeColorSet[] = storefrontThemeShowsDarkColors(tokens) ? ["colors", "darkColors"] : ["colors"];
  for (const set of sets) {
    const colors = tokens[set];
    if (!colors) continue;
    for (const { text, surface, ratio } of listStorefrontThemeDocumentContrastProblems(document, set)) {
      issues.push({
        path: ["tokens", set, storefrontContrastRoleToken(text, tokens, set)],
        reason: "contrast",
        message: `${text} on ${surface} has contrast ${ratio.toFixed(2)}:1; it needs at least 4.5:1.`,
      });
    }
    for (const problem of listStorefrontThemeSemanticColorProblems(colors)) {
      issues.push({ path: ["tokens", set, "muted-foreground"], reason: "semantic_color", message: problem });
    }
    // The page's paint is the surface of the store's page text: it reads on every colour the paint shows.
    for (const { text, surface, ratio } of listStorefrontPagePaintContrastProblems(tokens.pagePaint, colors)) {
      issues.push({
        path: ["tokens", "pagePaint"],
        reason: "contrast",
        message: `${text} on the page paint (${set === "darkColors" ? "dark colours, " : ""}${surface}) has contrast ${ratio.toFixed(2)}:1; it needs at least 4.5:1.`,
      });
    }
  }
  return issues;
}

/** JSON Schema of the document (structure only; the write policy is `storefrontThemeDocumentPolicyIssues`). */
export function storefrontThemeDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(storefrontThemeDocumentSchema, { unrepresentable: "any" }) as Record<string, unknown>;
}

/** CSS custom properties for a document: only constants and validated hex colours. */
export function buildStorefrontThemeTokens(document: Pick<StorefrontThemeDocument, "tokens">): Record<string, string> {
  return buildStorefrontTokenCss(document.tokens);
}
