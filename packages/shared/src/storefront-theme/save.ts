// What a theme document must pass to be stored: one checker for every place
// that asks. The store's save and publish call it (core
// `serializeThemeSettings`), the app template check applies a template and
// calls it (app-templates.ts), and so `scalius-plugin validate` refuses
// exactly what the store would.

import { storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { compileStorefrontPrivatePages, privatePagesContextOf } from "./private-layout";
import { storefrontThemeTranslationProblems } from "./translate";

/** Largest stored theme document: bounds each D1 row and the retained history on Workers Free. */
export const STOREFRONT_THEME_DOCUMENT_MAX_BYTES = 512 * 1024;

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
 * (palette contrast for each colour set buyers can see, the muted and error
 * colours, the page paint, dark colours where a scheme shows them), the
 * translations against their places' limits, the private pages compiled
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
  const translations = storefrontThemeTranslationProblems(result.data);
  if (translations.length > 0) return refused(translations.map((problem) => ({ ...problem, reason: null })), "A translation does not fit.");
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
