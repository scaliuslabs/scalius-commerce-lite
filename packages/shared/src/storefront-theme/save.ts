// What a theme document must pass to be stored: one checker for every place
// that asks. The store's save and publish call it (core
// `serializeThemeSettings`), the app template check applies a template and
// calls it (app-templates.ts), and so `scalius-plugin validate` refuses
// exactly what the store would.

import { storefrontThemeDocumentPolicyIssues, storefrontThemeDocumentSchema, type StorefrontThemeDocument, type StorefrontThemePolicyReason } from "./document";
import { PRIVATE_CHECKER_VERSION, compileStorefrontPrivatePages, privatePagesContextOf, type PrivatePagesReason } from "./private-layout";
import { storefrontThemeAssetIssues, type STOREFRONT_FOREIGN_ASSET } from "./theme-assets";
import { storefrontThemeTranslationProblems } from "./translate";
import type { STOREFRONT_MOBILE_TAB_REFUSALS } from "./blocks";
import type { STOREFRONT_PRIVATE_TEMPLATE_REASON } from "./pages";
import type { STOREFRONT_PAGE_SLIDE_PRODUCTS_REFUSAL } from "./sections";

/** Largest stored theme document: bounds each D1 row and the retained history on Workers Free. */
export const STOREFRONT_THEME_DOCUMENT_MAX_BYTES = 512 * 1024;

/**
 * Every reason a theme save can give (`StorefrontThemeSaveIssue.reason`; a
 * structural refusal that names none gives its words only), sorted: the
 * document's structure, the write policy, translations, files, the private
 * pages' compile, the size, and the two the store adds against its installed
 * apps (`unknown_app` at save, `theme_apps_unavailable` at publish). A reason
 * a theme can meet is part of the theme contract: a new one is a new refusal
 * at save, so it and the private pages' checker version are sealed by a
 * snapshot (save-reasons.test.ts), and the types below fail to compile when a
 * check gains a reason this list does not hold.
 */
export const STOREFRONT_THEME_SAVE_REASONS = [
  "contrast", "dark_colors_missing", "document_too_large", "duplicate_part", "duplicate_target", "empty_layout",
  "foreign_asset", "invalid_hook", "label_figures", "label_too_long", "label_variant", "layout_holds", "layout_once",
  "lead_order", "markup", "missing_part", "missing_target", "no_row", "not_available", "part_order", "private_page_template",
  "prominence", "semantic_color", "slide_products_over_limit", "tab_label", "tab_link_external", "tab_repeated",
  "theme_apps_unavailable", "token_value", "too_deep", "too_large", "too_many_nodes", "translation", "unknown_app",
  "unknown_frame", "unknown_item", "unknown_layout", "unknown_part", "unknown_style", "unknown_target", "unknown_token",
  "unknown_variant",
] as const;
export type StorefrontThemeSaveReason = (typeof STOREFRONT_THEME_SAVE_REASONS)[number];

/** The sealed refusals: the reasons and the private pages' checker version that gives them (save-reasons.snapshot.json). */
export const STOREFRONT_THEME_SAVE_REFUSALS = { checker: PRIVATE_CHECKER_VERSION, reasons: STOREFRONT_THEME_SAVE_REASONS } as const;

/** Compiles only while every check's reasons are in the list (a new reason is added there, and the snapshot shows it). */
type Listed<Missing extends never> = Missing;
export type StorefrontThemeSaveReasonsListed = [
  Listed<Exclude<PrivatePagesReason, StorefrontThemeSaveReason>>,
  Listed<Exclude<StorefrontThemePolicyReason, StorefrontThemeSaveReason>>,
  Listed<Exclude<(typeof STOREFRONT_MOBILE_TAB_REFUSALS)[keyof typeof STOREFRONT_MOBILE_TAB_REFUSALS], StorefrontThemeSaveReason>>,
  Listed<Exclude<typeof STOREFRONT_PRIVATE_TEMPLATE_REASON | typeof STOREFRONT_PAGE_SLIDE_PRODUCTS_REFUSAL | typeof STOREFRONT_FOREIGN_ASSET, StorefrontThemeSaveReason>>,
];

/** One refused value: where it sits in the document, what is wrong and what is allowed, and its machine-readable reason when it has one. */
export interface StorefrontThemeSaveIssue {
  path: string;
  message: string;
  reason: string | null;
}

/** Why a save is refused: the first issue's words and reason, and every issue (`issues`). */
export interface StorefrontThemeSaveRefusal {
  message: string;
  reason: string | null;
  issues: StorefrontThemeSaveIssue[];
}

export type StorefrontThemeSaveCheck =
  | { ok: true; theme: StorefrontThemeDocument; serialized: string }
  | { ok: false; refusal: StorefrontThemeSaveRefusal };

function refused(issues: StorefrontThemeSaveIssue[], fallback: string): StorefrontThemeSaveCheck {
  // A refusal that names its reason (a private page's `not_available`) leads with it.
  const first = issues.find((issue) => issue.reason !== null) ?? issues[0];
  return { ok: false, refusal: { message: first?.message ?? fallback, reason: first?.reason ?? null, issues } };
}

/**
 * Every check a save runs on a theme document, in order: the strict schema
 * (structure), the write policy (`storefrontThemeDocumentPolicyIssues`:
 * palette contrast for each colour set buyers can see, the muted and error
 * colours, the page paint, dark colours where a scheme shows them), the
 * translations against their places' limits, the app files it names (its own
 * app's only), the private pages compiled
 * against the document's palettes and its own app (arrangements, tokens,
 * words, icons), and the stored size. Returns the document as it is stored
 * (private pages compiled) or the refusal.
 */
export function checkStorefrontThemeSave(theme: unknown): StorefrontThemeSaveCheck {
  const result = storefrontThemeDocumentSchema.safeParse(theme);
  if (!result.success) {
    return refused(result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
      reason: issue.code === "custom" && typeof issue.params?.reason === "string" ? issue.params.reason : null,
    })), "The storefront style is not a valid theme document.");
  }
  // The write policy: checked here, where a document is written, never where one is read.
  const policy = storefrontThemeDocumentPolicyIssues(result.data);
  if (policy.length > 0) return refused(policy.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message, reason: issue.reason })), "The storefront style's colours do not read.");
  const translations = storefrontThemeTranslationProblems(result.data);
  if (translations.length > 0) return refused(translations.map((problem) => ({ ...problem, reason: "translation" })), "A translation does not fit.");
  // Every app file the theme names (private page icons, tab icons) is its own app's.
  const foreign = storefrontThemeAssetIssues(result.data);
  if (foreign.length > 0) return refused(foreign.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message, reason: issue.reason })), "A theme names only its own app's files.");
  // What the request said was compiled is never kept: the page reads only what this wrote.
  const privatePages = compileStorefrontPrivatePages(result.data.privatePages, privatePagesContextOf(result.data));
  if (!privatePages.ok) {
    return refused(privatePages.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message, reason: issue.reason })), "The private pages do not compile.");
  }
  const stored = { ...result.data, privatePages: privatePages.value };
  const serialized = JSON.stringify(stored);
  if (new TextEncoder().encode(serialized).byteLength > STOREFRONT_THEME_DOCUMENT_MAX_BYTES) {
    return refused([{ path: "", message: "Storefront style is too large. Shorten page content or remove unused landing pages.", reason: "document_too_large" }], "");
  }
  return { ok: true, theme: stored, serialized };
}
