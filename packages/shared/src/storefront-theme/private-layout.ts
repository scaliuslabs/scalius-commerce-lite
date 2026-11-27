// The theme document's `privatePages`: how the buyer's private pages are
// arranged, worded and given their look (private-anatomy.ts has the parts,
// private-arrangement.ts the rules, private-tokens.ts the tokens).
//
// - `pages`: each page's arrangement of the host's parts and the apps'
//   targets; an absent page draws as the host does.
// - `tokens`: the look of the host parts, as typed values per style target
//   (private-tokens.ts); any token puts the page in token mode, where every
//   colour comes from one table the host writes and checks. A page the theme
//   names (`pages.<page>` or `tokens.<page>`, `privatePageNamed`) is drawn in
//   token mode on the theme's page paint too; a page it does not name never
//   takes a theme-wide field.
// - `controls`: where the store's controls sit on the pages the theme names
//   (the light or dark switch, the market and language forms): the store's
//   checkout header, a strip at the page's end, or none (unset: the header).
// - `labels`, `icons`: host labels the theme changes (a host variant for an
//   action or an amount, its own words per language for the rest), host
//   icons it replaces with its own files.
// - `compiled`: written by the store on every save and publish, never by
//   hand: each page's token CSS (a page with an entry is in token mode), the
//   pages refused on their own with why (`refused`), the checker's version
//   and the anatomy version the arrangements were checked against. A page
//   reads it as it is, so a custom look costs no query and no parse beyond
//   the document's; one an older checker wrote serves nothing until the
//   store compiles it again (a save, or maintenance after a deploy, which
//   refuses only the pages this checker no longer passes and records why for
//   the merchant).
//
// A theme writes no markup and no CSS on these pages in this release: a
// save of a document with a stylesheet, its own chrome, its own search or
// files for a stylesheet, or a content block in an arrangement is refused
// (`not_available`). A stored document holding any of them still reads
// (`readStoredPrivatePages`): they are dropped and its private pages draw
// the store's default look until the next save; nothing on the render path
// draws one.
import { STORE_ACTION_AND_AMOUNT_WORDS, foldStoreWords } from "../store-words";
import { parsePluginSurfaceKey } from "../plugins/storefront";
import { storefrontDarkPalette, type StorefrontThemeTokens } from "./tokens";
import {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_PAGE_KEYS,
  PRIVATE_PAGE_WORDS,
  privateLabelKeys,
  type PrivateControlPlace,
  type PrivateLabelSpec,
  type PrivatePageKey,
} from "./private-keys";
import { PRIVATE_PAGES, type PrivatePageSpec, type PrivateWords } from "./private-anatomy";
import {
  PRIVATE_CHECKER_VERSION,
  PRIVATE_COMPILED_CSS_MAX_BYTES,
  PRIVATE_LOOK_ONLY_PAGES,
  PRIVATE_NOT_AVAILABLE,
  PRIVATE_PAGE_REFUSALS_MAX,
  privateNotAvailable,
  storefrontPrivatePagesDefault,
  type PrivatePageRefusal,
  type PrivatePagesHeld,
  type StorefrontPrivatePages,
} from "./private-schema";

export {
  PRIVATE_CHECKER_VERSION,
  PRIVATE_COMPILED_CSS_MAX_BYTES,
  PRIVATE_LAYOUT_MAX_DEPTH,
  PRIVATE_LOOK_ONLY_PAGES,
  PRIVATE_NOT_AVAILABLE,
  PRIVATE_PAGE_REFUSALS_MAX,
  PRIVATE_WORDS_LIMITS,
  privateAssetRefSchema,
  privateNodeSchema,
  privatePageArrangementSchema,
  readStoredPrivatePages,
  storefrontPrivatePagesDefault,
  storefrontPrivatePagesSchema,
  storefrontPrivatePagesTemplateSchema,
  type PrivatePageRefusal,
  type PrivatePagesHeld,
  type StorefrontPrivatePages,
  type StorefrontPrivatePagesTemplate,
} from "./private-schema";
import {
  compactPrivateArrangement,
  privateCheckoutBlockArrangement,
  fillPrivateArrangement,
  privateArrangementIssues,
  type PrivatePageArrangement,
} from "./private-arrangement";
import {
  compilePrivateTokens,
  privatePalettes,
  type PrivatePalette,
  type PrivateTokenReason,
} from "./private-tokens";

/**
 * Control and invisible characters (direction overrides, zero-width spaces): never part of a theme's words.
 * A joiner (Bangla's conjuncts), a variation selector and an emoji's tag stay.
 */
const HIDDEN_CHARACTERS = /(?![\t\n‌‍\p{Variation_Selector}\u{E0020}-\u{E007F}])[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;


/**
 * Where the store's controls sit on a private page as served: the theme's
 * place on a page the theme names and serves (`privatePageNamed`), else the
 * store's checkout header. A page that joins the model later keeps the
 * header until the theme names it.
 */
export function privateControlsPlace(privatePages: StorefrontPrivatePages, page: PrivatePageKey): PrivateControlPlace {
  const served = servedPrivatePages(privatePages);
  return privatePageNamed(served, page) ? served.controls ?? "header" : "header";
}

/**
 * The theme names this page: it arranges it (other than the store's own
 * arrangement, which stores nothing) or gives it tokens (`tokens.<page>`,
 * an empty set included). Only a page the theme names takes its theme-wide
 * fields (the page paint's token mode, where the controls sit), so a page
 * that joins the model later draws as before under every theme until its
 * author names it.
 */
export function privatePageNamed(privatePages: Pick<StorefrontPrivatePages, "pages" | "tokens">, page: PrivatePageKey): boolean {
  return privatePages.pages[page] !== undefined || privatePages.tokens[page] !== undefined;
}

// ─── Compiling on save ────────────────────────────────────────────────────

/** Why a save of `privatePages` is refused. */
export type PrivatePagesReason =
  | ReturnType<typeof privateArrangementIssues>[number]["reason"]
  | PrivateTokenReason
  | typeof PRIVATE_NOT_AVAILABLE | "too_large"
  | "label_too_long" | "label_variant" | "label_figures" | "markup" | "foreign_asset";

export interface PrivatePagesIssue {
  path: Array<string | number>;
  reason: PrivatePagesReason;
  message: string;
}

/** Text that reads as markup (`<b>`, `</p>`, `<!--`): words here are plain text. */
const MARKUP = /<[A-Za-z!/?]/;
/** A figure in any script (৳, 3, ৩, $): what an amount is written with. */
const FIGURES = /[\p{N}\p{Sc}]/u;

/** The store's amount words a label could pass for (its total, subtotal, what is due), from its own copy (store-words.ts). */
const AMOUNT_KEYS = ["totalText", "subtotalText", "estimatedTotalText", "amountDueText", "dueNowText", "orderReceiptBalanceDueText", "variant:subtotal", "variant:items-total"] as const;

/**
 * Words a heading, title or empty state never holds, per language, as whole
 * words anywhere in it: the store's amount words and the names of money
 * ("Total: free", "BDT ZERO", "টাকা"). Exported so every check of words drawn
 * beside the store's amounts reads one list.
 */
export const PRIVATE_LABEL_AMOUNT_WORDS: Readonly<Record<"en" | "bn", readonly string[]>> = /* @__PURE__ */ (() => ({
  en: [...AMOUNT_KEYS.map((key) => STORE_ACTION_AND_AMOUNT_WORDS[key]!.en), "grand total", "total due", "taka", "tk", "bdt", "usd", "dollar", "dollars", "eur", "euro", "euros", "gbp", "pound", "pounds", "inr", "rupee", "rupees", "aed", "dirham", "dirhams"],
  bn: [...AMOUNT_KEYS.map((key) => STORE_ACTION_AND_AMOUNT_WORDS[key]!.bn), "মোট", "টাকা", "টাকার", "টাকায়", "পরিশোধযোগ্য"],
}))();

/** A text's words as compared: folded (store-words.ts), split into runs of letters, marks and digits. */
const wordsOf = (text: string) => foldStoreWords(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const AMOUNT_PHRASES = /* @__PURE__ */ (() => [...new Set(Object.values(PRIVATE_LABEL_AMOUNT_WORDS).flat())].map(wordsOf))();

/** True when the text holds one of the store's amount words or a name of money, as whole words, in any of its languages. */
export function privateWordsReadAsAmount(text: string): boolean {
  const words = wordsOf(text);
  return AMOUNT_PHRASES.some((phrase) => words.some((_, at) => phrase.every((word, index) => words[at + index] === word)));
}
/** Words without direction overrides or invisible characters. */
export function plainPrivateWords(words: PrivateWords): PrivateWords {
  return Object.fromEntries(Object.entries(words).map(([lang, text]) => [lang, text.replace(HIDDEN_CHARACTERS, "").replace(LONE_TAGS, "$1")]));
}

/**
 * Tag characters drawn by nothing: kept only as a subdivision flag's (a black flag, its tags, the cancel tag);
 * anywhere else they hide words a buyer cannot see.
 */
const LONE_TAGS = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0020}-\u{E007F}]/gu;

function wordsIssues(words: PrivateWords | undefined, path: Array<string | number>, max: number, figures: boolean): PrivatePagesIssue[] {
  if (!words) return [];
  return Object.entries(words).flatMap(([lang, text]): PrivatePagesIssue[] => {
    if (MARKUP.test(text)) return [{ path: [...path, lang], reason: "markup" as const, message: "Plain text only: no HTML." }];
    if (text.length > max) return [{ path: [...path, lang], reason: "label_too_long" as const, message: `At most ${max} characters.` }];
    // A label never reads as an amount: the store writes every amount and names it.
    if (!figures && (FIGURES.test(text) || privateWordsReadAsAmount(text))) return [{ path: [...path, lang], reason: "label_figures" as const, message: "A label holds no digits, currency signs, names of money or the store's amount words (total, subtotal, due): the store writes and names every amount, so a label never reads as one." }];
    return [];
  });
}

/** What the private pages are checked against besides themselves: the palettes buyers see, and the theme's own app. */
export interface PrivatePagesCompileContext {
  palettes: readonly PrivatePalette[];
  /** The app the theme is a template of: its files are the only ones an icon may name (null: no files). */
  themeApp: string | null;
  /** A page's arrangement when the theme sets none (the payment step's, from the theme's `checkout` block). */
  defaults?: Partial<Record<PrivatePageKey, PrivatePageArrangement>>;
}

/** The compile context of a theme document: its palettes and the app its look came from. */
export function privatePagesContextOf(theme: {
  tokens: Pick<StorefrontThemeTokens, "colors" | "darkColors" | "colorScheme" | "colorSchemeToggle"> & Partial<Pick<StorefrontThemeTokens, "pagePaint">>;
  apps?: { template?: string } | undefined;
  blocks?: { checkout?: { summary: string; paymentChoices: string } } | undefined;
}): PrivatePagesCompileContext {
  const checkout = privateCheckoutBlockArrangement(theme.blocks?.checkout);
  return {
    palettes: privatePalettes(theme.tokens, storefrontDarkPalette),
    themeApp: theme.apps?.template ? parsePluginSurfaceKey(theme.apps.template)?.pluginId ?? null : null,
    ...(checkout ? { defaults: { checkout } } : {}),
  };
}

/** The page each label and icon key belongs to (keys are per page: `cart.heading`, `drawer.empty`). */
const KEY_PAGES: ReadonlyMap<string, PrivatePageKey> = /* @__PURE__ */ (() => new Map([
  ...privateLabelKeys().map(({ key, page }) => [key, page] as const),
  ...PRIVATE_PAGE_KEYS.flatMap((page) => PRIVATE_PAGE_WORDS[page].icons.map((key) => [key as string, page] as const)),
]))();

/** A compile's issues as a page records them (`compiled.refused`): the first few, in the save's own shape. */
function pageRefusals(issues: readonly PrivatePagesIssue[]): PrivatePageRefusal[] {
  return issues.slice(0, PRIVATE_PAGE_REFUSALS_MAX).map((issue) => ({ path: issue.path.map(String).join(".").slice(0, 240), reason: issue.reason, message: issue.message.slice(0, 600) }));
}

/**
 * Checks and compiles `privatePages` as a save or a publish does, page by
 * page: every arrangement against its page's anatomy, every token by type
 * and against the contrast floor, every label against its bound, plain text
 * everywhere and icons from the theme's own app only. Defaults are dropped
 * from the arrangements, so a default page stores nothing. The compiled CSS
 * is the host's token rules only: no theme writes CSS here.
 *
 * Every issue belongs to one page. A save refuses on any issue (`ok: false`);
 * `value` is always the compiled source, each page with an issue refused on
 * its own (`compiled.refused`, with its reasons): what the maintenance
 * compile stores when a newer checker refuses a published theme, so only
 * that page draws the store's default look.
 */
export function compileStorefrontPrivatePages(value: StorefrontPrivatePages, context: PrivatePagesCompileContext): { ok: true; value: StorefrontPrivatePages } | { ok: false; issues: PrivatePagesIssue[]; value: StorefrontPrivatePages } {
  const issues: PrivatePagesIssue[] = [];
  const byPage = new Map<PrivatePageKey, PrivatePagesIssue[]>();
  const report = (page: PrivatePageKey, found: readonly PrivatePagesIssue[]) => {
    if (found.length === 0) return;
    issues.push(...found);
    byPage.set(page, [...byPage.get(page) ?? [], ...found]);
  };
  const pages: StorefrontPrivatePages["pages"] = {};
  for (const page of PRIVATE_PAGE_KEYS) {
    const arrangement = value.pages[page];
    if (!arrangement) continue;
    const base = ["privatePages", "pages", page];
    // The receipt and the account take their look from tokens; their parts are not arranged by a theme yet.
    if (PRIVATE_LOOK_ONLY_PAGES.includes(page) && compactPrivateArrangement(page, arrangement)) {
      report(page, [{ path: base, reason: PRIVATE_NOT_AVAILABLE, message: privateNotAvailable(`Arranging the ${page} page`) }]);
      continue;
    }
    report(page, privateArrangementIssues(page, arrangement).map((issue) => ({ ...issue, path: [...base, ...issue.path] })));
    const compact = compactPrivateArrangement(page, arrangement);
    if (compact) pages[page] = compact;
  }
  for (const [key, ref] of Object.entries(value.icons)) {
    if (ref && ref.app !== context.themeApp) report(KEY_PAGES.get(key)!, [{ path: ["privatePages", "icons", key], reason: "foreign_asset", message: `${ref.app}/${ref.file}: a private page names only the theme's own files${context.themeApp ? ` (${context.themeApp})` : ""}.` }]);
  }
  const tokenCss: Partial<Record<PrivatePageKey, string>> = {};
  // A theme's page paint shows behind a private page it names: such a page with no tokens is drawn in token mode
  // anyway, its rows the defaults computed from the paint, so what stands on the paint is checked on it (the
  // drawer has no page of its own: it opens over public pages and takes their look). A page it does not name
  // draws as the store does, on the page colour.
  const painted = context.palettes.some((palette) => palette.pagePaint);
  for (const page of PRIVATE_PAGE_KEYS) {
    const own = value.tokens[page];
    const tokens = Object.keys(own ?? {}).length > 0 ? own! : painted && privatePageHasOwnPage(page) && privatePageNamed({ pages, tokens: value.tokens }, page) ? {} : null;
    if (!tokens) continue;
    const arrangement = privatePageArrangement({ ...value, pages, compiled: { ...value.compiled, anatomy: PRIVATE_ANATOMY_VERSION } }, page) ?? context.defaults?.[page];
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    const compiled = compilePrivateTokens(page, tokens, {
      layout: arrangement?.layout ?? spec.layout,
      items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, arrangement?.items?.[item] ?? spec.items[item]!.layout])),
      palettes: context.palettes,
    });
    report(page, compiled.issues);
    // A page of its own is drawn in token mode wherever its table was written (an empty look included).
    if (privatePageHasOwnPage(page) && compiled.issues.length === 0) tokenCss[page] = compiled.css;
  }
  const specs = new Map(privateLabelKeys().map((entry) => [entry.key, entry.spec]));
  const labels = Object.fromEntries(Object.entries(value.labels).flatMap(([key, words]) => words ? [[key, typeof words === "string" ? words : plainPrivateWords(words)]] : []));
  for (const [key, label] of Object.entries(labels)) {
    const spec = specs.get(key)!;
    const page = KEY_PAGES.get(key)!;
    const path = ["privatePages", "labels", key];
    if (spec.variants) {
      if (typeof label !== "string" || !spec.variants.includes(label)) report(page, [{ path, reason: "label_variant", message: `${key} names an action or an amount: choose one of ${spec.variants.join(", ")}; the store words it in every language.` }]);
    } else if (typeof label === "string") {
      report(page, [{ path, reason: "label_variant", message: `${key} is the theme's own words, per language: { "en": "…", "bn": "…" }.` }]);
    } else {
      report(page, wordsIssues(label, path, spec.max, spec.figures === true));
    }
  }
  // Each page serves only its own look, so each has its own bound: a large cart never costs the payment step its look.
  for (const [page, css] of Object.entries(tokenCss) as Array<[PrivatePageKey, string]>) {
    if (new TextEncoder().encode(css).byteLength > PRIVATE_COMPILED_CSS_MAX_BYTES) {
      report(page, [{ path: ["privatePages", "tokens", page], reason: "too_large", message: `The ${page} page's compiled look is over ${PRIVATE_COMPILED_CSS_MAX_BYTES / 1024} KiB; set fewer tokens there.` }]);
    }
  }
  const refused = Object.fromEntries([...byPage].map(([page, found]) => [page, pageRefusals(found)])) as NonNullable<StorefrontPrivatePages["compiled"]["refused"]>;
  const css = Object.fromEntries(Object.entries(tokenCss).filter(([page]) => !byPage.has(page as PrivatePageKey)));
  const compiled = { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, css, ...(byPage.size > 0 ? { refused } : {}) };
  const out: StorefrontPrivatePages = { ...value, pages, labels, compiled };
  return issues.length > 0 ? { ok: false, issues, value: out } : { ok: true, value: out };
}

/** Each page's arrangement as this build draws it (`privatePageArrangement`): what every write stores, so a newly mandatory part is never missing. */
export function filledPrivatePages(privatePages: StorefrontPrivatePages): StorefrontPrivatePages {
  return {
    ...privatePages,
    pages: Object.fromEntries(PRIVATE_PAGE_KEYS.flatMap((page) => {
      const arrangement = privatePageArrangement(privatePages, page);
      return arrangement ? [[page, arrangement]] : [];
    })),
  };
}

/**
 * The private pages of a stored document that held what a theme cannot set
 * (`readStoredPrivatePages`), refused at this build's versions: their source
 * kept (filled for this anatomy), no look served on a page it reached, each
 * such page drawing the store's default look until the next save compiles
 * them. A content block reaches its own page; a theme-wide field (a
 * stylesheet, the theme's chrome) every page the theme names, and the cart,
 * the page those fields were written for.
 */
export function refusedPrivatePages(privatePages: StorefrontPrivatePages, held: readonly PrivatePagesHeld[]): StorefrontPrivatePages {
  const filled = filledPrivatePages(privatePages);
  const named = PRIVATE_PAGE_KEYS.filter((page) => page === "cart" || privatePageNamed(filled, page));
  const refused: Partial<Record<PrivatePageKey, PrivatePageRefusal[]>> = {};
  for (const { page, label } of held) {
    for (const each of page ? [page] : named) {
      const path = page ? `privatePages.pages.${page}` : "privatePages";
      refused[each] = [...refused[each] ?? [], { path, reason: PRIVATE_NOT_AVAILABLE, message: privateNotAvailable(label) }].slice(0, PRIVATE_PAGE_REFUSALS_MAX);
    }
  }
  const css = Object.fromEntries(Object.entries(privatePagesCompiledCurrent(filled) ? filled.compiled.css : {}).filter(([page]) => !refused[page as PrivatePageKey]));
  return { ...filled, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, css, refused: { ...filled.compiled.refused, ...refused } } };
}

/** Whether `compiled` was written by this build's checker and anatomy (else maintenance compiles it again). */
export function privatePagesCompiledCurrent(privatePages: Pick<StorefrontPrivatePages, "compiled">): boolean {
  return privatePages.compiled.sanitizer === PRIVATE_CHECKER_VERSION && privatePages.compiled.anatomy === PRIVATE_ANATOMY_VERSION;
}

/** The pages this build's compile refused, each with why (none while the compile is not this build's). */
export function privatePagesRefused(privatePages: Pick<StorefrontPrivatePages, "compiled">): Partial<Record<PrivatePageKey, PrivatePageRefusal[]>> {
  return privatePagesCompiledCurrent(privatePages) ? privatePages.compiled.refused ?? {} : {};
}

/**
 * The private pages a buyer's page draws: the theme's when this build
 * compiled them, page by page: a refused page draws the store's default look
 * (its arrangement, words, icons and look), never a half of the theme's
 * design, and every other page keeps the theme's. A compile that is not this
 * build's serves the default look everywhere until maintenance compiles it.
 */
export function servedPrivatePages(privatePages: StorefrontPrivatePages): StorefrontPrivatePages {
  if (!privatePagesCompiledCurrent(privatePages)) return storefrontPrivatePagesDefault();
  const refused = privatePages.compiled.refused;
  if (!refused) return privatePages;
  const kept = (page: string) => !refused[page as PrivatePageKey];
  const keptKey = (key: string) => kept(KEY_PAGES.get(key) ?? "");
  const only = <Entry>(record: Partial<Record<string, Entry>>, keep: (key: string) => boolean) => Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
  return {
    ...privatePages,
    pages: only(privatePages.pages, kept),
    tokens: only(privatePages.tokens, kept),
    labels: only(privatePages.labels, keptKey),
    icons: only(privatePages.icons, keptKey),
    compiled: { ...privatePages.compiled, css: only(privatePages.compiled.css, kept) },
  };
}

// ─── Reading on the page ──────────────────────────────────────────────────

/** A page's arrangement as this build draws it: as stored when it was checked against this anatomy, else filled in. */
export function privatePageArrangement(privatePages: StorefrontPrivatePages, page: PrivatePageKey): PrivatePageArrangement | undefined {
  const arrangement = privatePages.pages[page];
  if (!arrangement) return undefined;
  return privatePages.compiled.anatomy === PRIVATE_ANATOMY_VERSION ? arrangement : fillPrivateArrangement(page, arrangement);
}

/**
 * The look a page may serve (the host's token rules, that page's only): the
 * stored one when this build's checker compiled it, else none (the default
 * look) until the store compiles it again. A buyer's request never compiles.
 */
export function privatePagesCss(privatePages: Pick<StorefrontPrivatePages, "compiled">, page: PrivatePageKey): string {
  // The page writes it into a <style>: the compiler never emits `<`, so a stored look holding one (a row edited by
  // hand, `</style>`) serves nothing, whatever its version says.
  const css = privatePages.compiled.css[page] ?? "";
  return privatePagesCompiledCurrent(privatePages) && !privatePages.compiled.refused?.[page] && !css.includes("<") ? css : "";
}

/**
 * The page is in token mode (the compile wrote its table: the theme set its
 * tokens, or names it and has a page paint): its colours come from its
 * compiled table, the host's palette classes read it. Another page's tokens
 * never put it there, and a page refused on its own is never in it.
 */
export function privatePageTokenMode(privatePages: Pick<StorefrontPrivatePages, "compiled">, page: PrivatePageKey): boolean {
  // A look that serves nothing (a `<` in it) puts no page in token mode: its palette classes would read no rows.
  return privatePageHasOwnPage(page) && privatePagesCompiledCurrent(privatePages) && !privatePages.compiled.refused?.[page] && privatePages.compiled.css[page] !== undefined && !privatePages.compiled.css[page]!.includes("<");
}

/** A page of its own (a `page` style target: the cart), not one drawn over public pages (the drawer, which takes their look). */
function privatePageHasOwnPage(page: PrivatePageKey): boolean {
  return Object.hasOwn(PRIVATE_PAGES[page].styles, "page");
}

/** Words in the page's language: its base language, else English, else the first the theme wrote. */
export function privateWords(words: PrivateWords | undefined, languageCode: string | null | undefined): string | null {
  if (!words) return null;
  const base = (languageCode ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return words[base] ?? words.en ?? Object.values(words)[0] ?? null;
}

/**
 * The labels of one page in one language (what a page sends its browser
 * code): the theme's words for a descriptive label, the store's words for
 * the variant it chose for an action or an amount (`variantWords`, core's
 * copy in the page's language).
 */
export function privatePageLabels(privatePages: Pick<StorefrontPrivatePages, "labels">, page: PrivatePageKey, languageCode: string | null | undefined, variantWords: (variant: string) => string | null): Record<string, string> {
  return Object.fromEntries(Object.entries(PRIVATE_PAGE_WORDS[page].labels as Readonly<Record<string, PrivateLabelSpec>>).flatMap(([key, spec]) => {
    const label = privatePages.labels[key];
    const words = typeof label === "string" ? (spec.variants?.includes(label) ? variantWords(label) : null) : privateWords(label, languageCode);
    return words === null ? [] : [[key, words]];
  }));
}
