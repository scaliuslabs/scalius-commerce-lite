// What a theme document must pass to be stored: one checker for every place
// that asks. The store's save and publish call it (core
// `serializeThemeSettings`), the app template check applies a template and
// calls it (app-templates.ts), and so `scalius-plugin validate` refuses
// exactly what the store would.

import { storefrontThemeDocumentPolicyIssues, storefrontThemeDocumentSchema, type StorefrontThemeDocument, type StorefrontThemePolicyReason } from "./document";
import { PRIVATE_CHECKER_VERSION, compileStorefrontPrivatePages, privatePagesContextOf, type PrivatePagesReason } from "./private-layout";
import { storefrontThemeAssetIssues, type STOREFRONT_FOREIGN_ASSET } from "./theme-assets";
import { storefrontThemeTranslationProblems } from "./translate";
import { storefrontLabelRefusalReason } from "./read-repair";
import type { STOREFRONT_MOBILE_TAB_REFUSALS } from "./blocks";
import type { STOREFRONT_PRIVATE_TEMPLATE_REASON } from "./pages";
import type { STOREFRONT_PAGE_SLIDE_PRODUCTS_REFUSAL } from "./sections";
import type { STOREFRONT_INVALID_LINK } from "./links";

/** Largest stored theme document: bounds each D1 row and the retained history on Workers Free. */
export const STOREFRONT_THEME_DOCUMENT_MAX_BYTES = 512 * 1024;

/**
 * Every reason a theme save can give (`StorefrontThemeSaveIssue.reason`; a
 * structural refusal that names none gives its words only), sorted: the
 * document's structure, the write policy, translations, files, the private
 * pages' compile, the size, and the two the store adds against its installed
 * apps (`unknown_app` at save, `theme_apps_unavailable` and `theme_app_settings_missing` at publish). A reason
 * a theme can meet is part of the theme contract: a new one is a new refusal
 * at save, so it and the private pages' checker version are sealed by a
 * snapshot (save-reasons.test.ts), and the types below fail to compile when a
 * check gains a reason this list does not hold.
 */
export const STOREFRONT_THEME_SAVE_REASONS = [
  "contrast", "dark_colors_missing", "document_too_large", "duplicate_part", "duplicate_target", "empty_layout",
  "foreign_asset", "invalid_hook", "invalid_link", "label_figures", "label_too_long", "label_variant", "layout_holds", "layout_once",
  "lead_order", "markup", "missing_part", "missing_target", "no_row", "not_available", "part_order", "private_page_template",
  "prominence", "semantic_color", "slide_products_over_limit", "tab_label", "tab_link_external", "tab_repeated",
  "theme_app_settings_missing", "theme_apps_unavailable", "token_value", "too_deep", "too_large", "too_many_nodes", "translation", "unknown_app",
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
  Listed<Exclude<typeof STOREFRONT_PRIVATE_TEMPLATE_REASON | typeof STOREFRONT_PAGE_SLIDE_PRODUCTS_REFUSAL | typeof STOREFRONT_FOREIGN_ASSET | typeof STOREFRONT_INVALID_LINK, StorefrontThemeSaveReason>>,
];

/** One refused value: where it sits in the document, what is wrong and what is allowed, and its machine-readable reason when it has one. */
export interface StorefrontThemeSaveIssue {
  path: string;
  message: string;
  reason: StorefrontThemeSaveReason | null;
}

/** Why a save is refused: the first issue's words and reason, and every issue (`issues`). */
export interface StorefrontThemeSaveRefusal {
  message: string;
  reason: StorefrontThemeSaveReason | null;
  issues: StorefrontThemeSaveIssue[];
}

export type StorefrontThemeSaveCheck =
  | {
    ok: true;
    theme: StorefrontThemeDocument;
    serialized: string;
    /** What the baseline already broke and this write does not touch: stored as it is, never refused (each page's compile refusals are in `compiled.refused`). */
    warnings: StorefrontThemeSaveIssue[];
  }
  | { ok: false; refusal: StorefrontThemeSaveRefusal };

/** A sealed reason, or null: a `params.reason` outside the sealed list is never passed on as one. */
export function storefrontThemeSaveReason(value: unknown): StorefrontThemeSaveReason | null {
  return typeof value === "string" && (STOREFRONT_THEME_SAVE_REASONS as readonly string[]).includes(value) ? value as StorefrontThemeSaveReason : null;
}

function refused(issues: StorefrontThemeSaveIssue[], fallback: string): StorefrontThemeSaveCheck {
  // A refusal that names its reason (a private page's `not_available`) leads with it.
  const first = issues.find((issue) => issue.reason !== null) ?? issues[0];
  return { ok: false, refusal: { message: first?.message ?? fallback, reason: first?.reason ?? null, issues } };
}

const issueKey = (issue: StorefrontThemeSaveIssue) => `${issue.path}\u0000${issue.reason ?? ""}\u0000${issue.message}`;

/**
 * Every write check's issues of a well-formed document, by stage, and its
 * private pages as compiled (a page with an issue refused on its own). The
 * write policy runs here, where a document is written, never where one is
 * read. What a request said was compiled is never kept: the page reads only
 * what the compile wrote.
 */
function writeIssues(document: StorefrontThemeDocument) {
  const path = (segments: ReadonlyArray<string | number>) => segments.map(String).join(".");
  const privatePages = compileStorefrontPrivatePages(document.privatePages, privatePagesContextOf(document));
  return {
    privatePages: privatePages.value,
    issues: {
      policy: storefrontThemeDocumentPolicyIssues(document).map((issue): StorefrontThemeSaveIssue => ({ path: path(issue.path), message: issue.message, reason: issue.reason })),
      translations: storefrontThemeTranslationProblems(document).map((problem): StorefrontThemeSaveIssue => ({ ...problem, reason: "translation" })),
      // Every app file the theme names (private page icons, tab icons) is its own app's.
      foreign: storefrontThemeAssetIssues(document).map((issue): StorefrontThemeSaveIssue => ({ path: path(issue.path), message: issue.message, reason: issue.reason })),
      privatePages: privatePages.ok ? [] : privatePages.issues.map((issue): StorefrontThemeSaveIssue => ({ path: path(issue.path), message: issue.message, reason: issue.reason })),
    },
  };
}

/** Options of a save check. */
export interface StorefrontThemeSaveOptions {
  /**
   * The document the store already holds where this one is written (the draft
   * it replaces, the live theme a discard writes back): an issue it already
   * had, at the same place with the same reason and words, is not this
   * write's to fix, so it is a warning, never a refusal. Writing back what the
   * store holds unchanged is not a save for policy; only what the request
   * changes is checked. Structure and size are always checked.
   */
  baseline?: unknown;
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
 * (private pages compiled, a page refused on its own for a baseline issue) or
 * the refusal.
 */
export function checkStorefrontThemeSave(theme: unknown, options: StorefrontThemeSaveOptions = {}): StorefrontThemeSaveCheck {
  const result = storefrontThemeDocumentSchema.safeParse(theme);
  if (!result.success) {
    return refused(result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
      reason: issue.code === "custom" && issue.params?.reason !== undefined ? storefrontThemeSaveReason(issue.params.reason)
        // A label's value the schema refuses names the label check's reason (a read keeps the store's words there).
        : issue.path[0] === "privatePages" && issue.path[1] === "labels" && issue.path.length >= 3 ? storefrontLabelRefusalReason(issue.code)
          : null,
    })), "The storefront style is not a valid theme document.");
  }
  const document = result.data;
  const stages = writeIssues(document);
  const baseline = options.baseline === undefined ? null : storefrontThemeDocumentSchema.safeParse(options.baseline);
  const known = new Set(baseline?.success ? Object.values(writeIssues(baseline.data).issues).flat().map(issueKey) : []);
  const warnings: StorefrontThemeSaveIssue[] = [];
  /** This write's own issues of one stage; the baseline's go to the warnings. */
  const own = (issues: StorefrontThemeSaveIssue[]) => issues.filter((issue) => {
    if (!known.has(issueKey(issue))) return true;
    warnings.push(issue);
    return false;
  });
  const policy = own(stages.issues.policy);
  if (policy.length > 0) return refused(policy, "The storefront style's colours do not read.");
  const translations = own(stages.issues.translations);
  if (translations.length > 0) return refused(translations, "A translation does not fit.");
  const foreign = own(stages.issues.foreign);
  if (foreign.length > 0) return refused(foreign, "A theme names only its own app's files.");
  const compiled = own(stages.issues.privatePages);
  if (compiled.length > 0) return refused(compiled, "The private pages do not compile.");
  const stored = { ...document, privatePages: stages.privatePages };
  const serialized = JSON.stringify(stored);
  if (new TextEncoder().encode(serialized).byteLength > STOREFRONT_THEME_DOCUMENT_MAX_BYTES) {
    return refused([{ path: "", message: "Storefront style is too large. Shorten page content or remove unused landing pages.", reason: "document_too_large" }], "");
  }
  return { ok: true, theme: stored, serialized, warnings };
}
