// The refusal census: every place an app or theme is checked and can be
// refused, with the reason codes it gives and the sealed tables and snapshots
// that hold the constants its rule reads (limits, word lists, patterns, the
// checker's versions), each under its own direction rule. A snapshot of shapes
// cannot see a check that starts refusing more with the same shape: a new
// reason moves `refusal-census.snapshot.json`, and a tightened constant moves
// the table that holds it; from the contract lock on either needs a typed
// entry (security for a tightening).
//
// What it cannot see: logic that tightens without touching a listed
// constant (a new branch in a check), and checks whose reasons are free text.
// The docs' "What is not covered" names those.
import { STOREFRONT_THEME_SAVE_REASONS } from "../storefront-theme/save";
import { STORE_WORDS_REASON } from "../store-words";

/** One check site: who passes through it, the reasons it gives, and where the constants its rule reads are sealed. */
export interface CensusSite {
  /** Where it runs, in words. */
  at: string;
  reasons: readonly string[];
  /** The sealed tables (`tables.<name>` of the protocol seal), protocol constants (`storefront.<NAME>`) and snapshots that hold its constants. */
  governedBy: readonly string[];
}

/**
 * The sites whose reasons are data here. Pack and validate
 * (`scalius-plugin validate`, `pnpm plugin pack`) run the store's own checks
 * through its contract (`loadPluginContract`: manifest parse and policy,
 * handlers, listing images, the storefront build and the theme templates)
 * and its own package sizes; refusal-census.test.ts lists them from the source.
 */
export function refusalCensusSites(): Record<string, CensusSite> {
  const words = ["tables.storeWords", "tables.storeWordSlots", "tables.storeWordKinds", "tables.storeWordOwn"];
  return {
    themeSave: {
      at: "a theme saved or published (checkStorefrontThemeSave), its private pages compiled",
      reasons: STOREFRONT_THEME_SAVE_REASONS,
      governedBy: ["tables.limits", "tables.themeLabelAmountWords", "tables.landingHandlesNeverValid", "tables.marketSubfolderPattern", "save-reasons.snapshot.json", "private-anatomy.snapshot.txt", "private-compile.golden.json", "read-bounds.snapshot.json"],
    },
    appTemplates: {
      at: "an app's templates and page presets at install, in the theme library and when applied (checkStorefrontAppTemplateTheme, then the theme save)",
      reasons: STOREFRONT_THEME_SAVE_REASONS,
      governedBy: ["tables.limits", "compat.snapshot.json", "save-reasons.snapshot.json"],
    },
    manifestPolicy: {
      at: "an app release installed, updated, packed or validated (pluginManifestPolicyIssues)",
      reasons: [STORE_WORDS_REASON],
      governedBy: [...words, "abi.manifest.snapshot.json"],
    },
    buyerUi: {
      at: "each buyer UI extension's answer (parsePluginUiDocument on the buyer surface: a refused answer draws nothing)",
      reasons: ["version", "invalid", "too_large", STORE_WORDS_REASON],
      governedBy: ["tables.limits", ...words, "abi.protocol.snapshot.json"],
    },
    functionOutput: {
      at: "each function's answer (its sealed output schema, then the store's words give way: function-words.ts)",
      reasons: [],
      governedBy: ["tables.limits", ...words, "tables.neutralWords", "abi.protocol.snapshot.json"],
    },
    storefrontOutput: {
      at: "each storefront render's markup (sanitizePluginHtml) and its bundle at upload",
      reasons: ["too_large", "too_complex"],
      governedBy: ["tables.skinHtml", "tables.limits", "storefront.STOREFRONT_STYLE_FUNCTIONS", "storefront.STOREFRONT_COMPONENT_LIMITS"],
    },
  };
}

/** The census as sealed: each site's reasons and what holds its constants, sorted. */
export function refusalCensus(sites: Record<string, CensusSite> = refusalCensusSites()): Record<string, { at: string; reasons: string[]; governedBy: string[] }> {
  return Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, { at: site.at, reasons: [...new Set(site.reasons)].sort(), governedBy: [...new Set(site.governedBy)].sort() }]));
}
