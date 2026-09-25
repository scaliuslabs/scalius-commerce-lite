// The storefront theme document (version 5): the template it is based on,
// the tokens, one variant per block (plus the shared navigation source and
// the listing's filter style) and the page sections. The dashboard
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
  storefrontThemeBlocksSchema,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontThemeBlocks,
} from "./blocks";
import { storefrontSectionListSchema } from "./sections";
import { buildStorefrontTokenCss, storefrontThemeTokensSchema, type StorefrontThemeTokens } from "./tokens";

export const STOREFRONT_THEME_DOCUMENT_VERSION = 5 as const;

/** Templates are named by archetype, never by the site they were measured on. */
export const STOREFRONT_TEMPLATE_IDS = [
  "boutique",
  "heritage-editorial",
  "fashion-value",
  "spec-catalogue",
  "rounded-tech",
  "marketplace",
  "mass-retail",
  "department-mall",
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

/** Pairs below AA for the colours, blocks and header tone of a document. */
export function listStorefrontThemeDocumentContrastProblems(document: {
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone">;
  blocks: StorefrontThemeBlocks;
}): StorefrontThemeContrastProblem[] {
  return listStorefrontThemeContrastProblems(
    document.tokens.colors,
    storefrontThemeContrastPairs(document.blocks),
    document.tokens.headerTone,
  );
}

/** The colour token behind a contrast role (header roles follow the header tone). */
export function storefrontContrastRoleToken(
  role: StorefrontThemeContrastRole,
  tokens: Pick<StorefrontThemeTokens, "colors" | "headerTone">,
): StorefrontThemeColorKey {
  const header = storefrontHeaderToneColors(tokens.headerTone, tokens.colors);
  if (role === "header-background") return header.background;
  if (role === "header-foreground") return header.foreground;
  return role;
}

/** The complete, strict theme document schema. Writes and reads both use it. */
export const storefrontThemeDocumentSchema = z.object({
  version: z.literal(STOREFRONT_THEME_DOCUMENT_VERSION),
  /** The template the document is based on; it stays when blocks or tokens change. */
  template: z.enum(STOREFRONT_TEMPLATE_IDS),
  tokens: storefrontThemeTokensSchema,
  blocks: storefrontThemeBlocksSchema,
  /**
   * Page sections. Only the homepage has sections today; a landing page
   * joins when a route renders it (each page inlines the whole section
   * registry into the API contract, so pages are added only with a renderer).
   */
  pages: z.object({
    home: storefrontSectionListSchema,
  }).strict(),
}).strict().superRefine((document, context) => {
  for (const { text, surface, ratio } of listStorefrontThemeDocumentContrastProblems(document)) {
    context.addIssue({
      code: "custom",
      path: ["tokens", "colors", storefrontContrastRoleToken(text, document.tokens)],
      message: `${text} on ${surface} has contrast ${ratio.toFixed(2)}:1; it needs at least 4.5:1.`,
    });
  }
  for (const problem of listStorefrontThemeSemanticColorProblems(document.tokens.colors)) {
    context.addIssue({ code: "custom", path: ["tokens", "colors", "muted-foreground"], message: problem });
  }
});

export type StorefrontThemeDocument = z.infer<typeof storefrontThemeDocumentSchema>;
export type StorefrontThemePages = StorefrontThemeDocument["pages"];

/** JSON Schema of the document (structure only; contrast lives in the Zod schema). */
export function storefrontThemeDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(storefrontThemeDocumentSchema, { unrepresentable: "any" }) as Record<string, unknown>;
}

/**
 * Parses a stored document strictly. Returns null for anything that is not a
 * valid current-version document; callers decide what that means (the
 * dashboard fails closed, the storefront renders the default theme).
 */
export function parseStoredStorefrontThemeDocument(value: string | null | undefined): StorefrontThemeDocument | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = storefrontThemeDocumentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** CSS custom properties for a document: only constants and validated hex colours. */
export function buildStorefrontThemeTokens(document: Pick<StorefrontThemeDocument, "tokens">): Record<string, string> {
  return buildStorefrontTokenCss(document.tokens);
}
