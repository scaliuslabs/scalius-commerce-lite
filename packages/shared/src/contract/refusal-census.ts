// The refusal census: every place an app or theme is checked and can be
// refused, with the reason codes it gives and a digest of the constants its
// rule reads (limits, word lists, patterns). A snapshot of shapes cannot see
// a check that starts refusing more with the same shape; this can: a new
// reason or a changed digest moves `refusal-census.snapshot.json`, and from
// the contract lock on that needs a typed entry in contract.breaks.json
// (security for a tightening, growth for a reviewed loosening).
//
// What it cannot see: logic that tightens without touching a listed
// constant (a new branch in a check), and checks whose reasons are free text.
// The docs' "What is not covered" names those.
import { STOREFRONT_THEME_SAVE_REASONS, STOREFRONT_THEME_SAVE_REFUSALS } from "../storefront-theme/save";
import { STOREFRONT_THEME_DOCUMENT_VERSION } from "../storefront-theme/document";
import { STOREFRONT_THEME_OLDEST_READABLE_VERSION } from "../storefront-theme/upgrade";
import { PRIVATE_COMPILED_CSS_MAX_BYTES, PRIVATE_LAYOUT_MAX_DEPTH, PRIVATE_PAGE_REFUSALS_MAX, PRIVATE_WORDS_LIMITS } from "../storefront-theme/private-schema";
import { PRIVATE_CONTRAST_FLOOR, PRIVATE_EDGE_MIN_WIDTH, PRIVATE_MARK_CONTRAST_FLOOR, PRIVATE_TOKEN_LIMITS } from "../storefront-theme/private-tokens";
import { PRIVATE_LABEL_AMOUNT_WORDS } from "../storefront-theme/private-layout";
import { STOREFRONT_MOBILE_TAB_LIMITS } from "../storefront-theme/blocks";
import { STOREFRONT_MAX_SECTIONS, STOREFRONT_PAGE_SLIDE_PRODUCTS_LIMIT } from "../storefront-theme/sections";
import { STOREFRONT_MAX_LANDING_PAGES } from "../storefront-theme/pages";
import { STOREFRONT_THEME_TRANSLATION_LIMITS } from "../storefront-theme/text";
import { STORE_ACTION_AND_AMOUNT_WORDS, STORE_WORD_LABEL_KINDS, STORE_WORD_SLOT_PATTERNS, STORE_WORDS_REASON } from "../store-words";
import { STOREFRONT_APP_TEMPLATE_MAX_BYTES } from "../plugins/storefront-components";
import { PLUGIN_UI_LIMITS, PLUGIN_UI_SURFACES } from "../plugins/ui";
import { BUYER_UI_BLOCKS_MAX, BUYER_UI_LINES_MAX_BYTES, BUYER_UI_RESPONSE_MAX_BYTES } from "../plugins/buyer-ui";
import { STOREFRONT_COMPONENT_LIMITS, STOREFRONT_STYLE_FUNCTIONS } from "../plugins/storefront-protocol";
import { STOREFRONT_SKIN_HTML_ALLOW_LIST, STOREFRONT_SKIN_HTML_BOUNDS } from "../plugins/html";
import { appSealedLimits } from "../plugins/app-limits";
import { sha256Hex } from "./lock";
import { refusalListBreaks } from "./rules";

/** One check site: who passes through it, the reasons it gives, and the constants its rule reads. */
export interface CensusSite {
  /** Where it runs, in words. */
  at: string;
  reasons: readonly string[];
  constants: Record<string, unknown>;
}

/** Text the digest reads: regular expressions as their source, keys in definition order. */
const canonical = (value: unknown) => JSON.stringify(value, (_, entry) => (entry instanceof RegExp ? `/${entry.source}/${entry.flags}` : entry));

/**
 * The sites whose reasons and constants are data here. Pack and validate
 * (`scalius-plugin validate`, `pnpm plugin pack`) run the store's own checks
 * through its contract (`loadPluginContract`: manifest parse and policy,
 * handlers, listing images, the storefront build and the theme templates)
 * and its own package sizes; refusal-census.test.ts lists them from the source.
 */
export function refusalCensusSites(): Record<string, CensusSite> {
  const storeWords = { words: STORE_ACTION_AND_AMOUNT_WORDS, kinds: STORE_WORD_LABEL_KINDS, slots: STORE_WORD_SLOT_PATTERNS };
  return {
    themeSave: {
      at: "a theme saved or published (checkStorefrontThemeSave), its private pages compiled",
      reasons: STOREFRONT_THEME_SAVE_REASONS,
      constants: {
        refusals: STOREFRONT_THEME_SAVE_REFUSALS, privateTokens: PRIVATE_TOKEN_LIMITS, privateWords: PRIVATE_WORDS_LIMITS,
        labelAmountWords: PRIVATE_LABEL_AMOUNT_WORDS, compiledCssBytes: PRIVATE_COMPILED_CSS_MAX_BYTES, refusalsMax: PRIVATE_PAGE_REFUSALS_MAX,
        layoutDepth: PRIVATE_LAYOUT_MAX_DEPTH, contrast: PRIVATE_CONTRAST_FLOOR, markContrast: PRIVATE_MARK_CONTRAST_FLOOR, edgeWidth: PRIVATE_EDGE_MIN_WIDTH,
        mobileTabs: STOREFRONT_MOBILE_TAB_LIMITS, sections: STOREFRONT_MAX_SECTIONS, landingPages: STOREFRONT_MAX_LANDING_PAGES,
        slideProducts: STOREFRONT_PAGE_SLIDE_PRODUCTS_LIMIT, translations: STOREFRONT_THEME_TRANSLATION_LIMITS,
      },
    },
    appTemplates: {
      at: "an app's templates and page presets at install, in the theme library and when applied (checkStorefrontAppTemplateTheme, then the theme save)",
      reasons: STOREFRONT_THEME_SAVE_REASONS,
      constants: { templateBytes: STOREFRONT_APP_TEMPLATE_MAX_BYTES, documentVersion: STOREFRONT_THEME_DOCUMENT_VERSION, oldestReadable: STOREFRONT_THEME_OLDEST_READABLE_VERSION },
    },
    manifestPolicy: {
      at: "an app release installed, updated, packed or validated (pluginManifestPolicyIssues)",
      reasons: [STORE_WORDS_REASON],
      constants: storeWords,
    },
    buyerUi: {
      at: "each buyer UI extension's answer (parsePluginUiDocument on the buyer surface: a refused answer draws nothing)",
      reasons: ["version", "invalid", "too_large", STORE_WORDS_REASON],
      constants: { ui: PLUGIN_UI_LIMITS, surface: PLUGIN_UI_SURFACES.buyer, responseBytes: BUYER_UI_RESPONSE_MAX_BYTES, lineBlocksBytes: BUYER_UI_LINES_MAX_BYTES, blocks: BUYER_UI_BLOCKS_MAX, storeWords },
    },
    functionOutput: {
      at: "each function's answer (its sealed output schema, then the store's words give way: function-words.ts)",
      reasons: [],
      constants: { limits: appSealedLimits(), storeWords },
    },
    storefrontOutput: {
      at: "each storefront render's markup (sanitizePluginHtml) and its bundle at upload",
      reasons: ["too_large", "too_complex"],
      constants: { allowList: STOREFRONT_SKIN_HTML_ALLOW_LIST, bounds: STOREFRONT_SKIN_HTML_BOUNDS, styleFunctions: STOREFRONT_STYLE_FUNCTIONS, limits: STOREFRONT_COMPONENT_LIMITS },
    },
  };
}

/** The census as sealed: each site's reasons and the digest of its constants. */
export async function refusalCensus(sites: Record<string, CensusSite> = refusalCensusSites()): Promise<Record<string, { at: string; reasons: string[]; constants: string }>> {
  const census: Record<string, { at: string; reasons: string[]; constants: string }> = {};
  for (const [name, site] of Object.entries(sites)) {
    census[name] = { at: site.at, reasons: [...new Set(site.reasons)].sort(), constants: (await sha256Hex(canonical(site.constants))).slice(0, 16) };
  }
  return census;
}

/** A site never leaves the census, gives no new reason, and its constants' digest stays: a change is reviewed. */
export function refusalCensusBreakingChanges(before: unknown, after: unknown): string[] {
  const was = (before ?? {}) as Record<string, { reasons?: string[]; constants?: string }>;
  const now = (after ?? {}) as Record<string, { reasons?: string[]; constants?: string }>;
  return Object.entries(was).flatMap(([name, site]) => {
    const next = now[name];
    if (!next) return [`${name}: the check site left the census.`];
    return [
      ...refusalListBreaks(`${name}.reasons`, site.reasons ?? [], next.reasons ?? []),
      ...(site.constants !== next.constants ? [`${name}: its rule constants moved (digest ${site.constants} → ${next.constants}): say what it refuses now.`] : []),
    ];
  });
}
