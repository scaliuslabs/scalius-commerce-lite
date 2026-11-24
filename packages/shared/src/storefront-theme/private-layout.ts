// The theme document's `privatePages`: how the buyer's private pages are
// arranged, worded and given their look (private-anatomy.ts has the parts,
// private-arrangement.ts the rules, private-tokens.ts the tokens).
//
// - `pages`: each page's arrangement of the host's parts and the apps'
//   targets; an absent page draws as the host does.
// - `tokens`: the look of the host parts, as typed values per style target
//   (private-tokens.ts); any token puts the page in token mode, where every
//   colour comes from one table the host writes and checks.
// - `controls`: where the store's controls sit (the light or dark switch, the
//   market and language forms): the store's checkout header, a strip at the
//   page's end, or none (unset: the header).
// - `labels`, `icons`: host labels the theme changes (a host variant for an
//   action or an amount, its own words per language for the rest), host
//   icons it replaces with its own files.
// - `compiled`: written by the store on every save and publish, never by
//   hand: each page's token CSS (a page with an entry is in token mode), the
//   checker's version and the anatomy version the arrangements were checked
//   against. A page reads it as it is, so a custom
//   look costs no query and no parse beyond the document's; one an older
//   checker wrote serves nothing until the store compiles it again (a save,
//   or maintenance after a deploy).
//
// A theme writes no markup and no CSS on these pages in this release: a
// save of a document with a stylesheet, its own chrome, its own search or
// files for a stylesheet, or a content block in an arrangement is refused
// (`not_available`). A stored document holding any of them still reads
// (`readStoredPrivatePages`): they are dropped and its private pages draw
// the store's default look until the next save; nothing on the render path
// draws one.
import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "../plugins/ids";
import { parsePluginSurfaceKey } from "../plugins/storefront";
import { storefrontDarkPalette, type StorefrontThemeTokens } from "./tokens";
import {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_HOOK_MAX,
  PRIVATE_LAYOUT_KINDS,
  PRIVATE_PAGES,
  PRIVATE_PAGE_KEYS,
  PRIVATE_CONTROL_PLACES,
  privateIconKeys,
  privateLabelKeys,
  type PrivateControlPlace,
  type PrivateAssetRef,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivateWords,
} from "./private-anatomy";
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
  privateTokensSchema,
  type PrivatePalette,
  type PrivateTokenReason,
  type PrivateTokens,
} from "./private-tokens";

/**
 * The checker's version: a page never serves a look an older checker
 * compiled (maintenance compiles the published theme again). Version 6: a
 * theme's stylesheet, chrome and content blocks are not available. Version
 * 7: a filled button's fill and an outlined control's or a field's edge read
 * at 3:1, Place order and Confirm outrank their neighbours, the total by
 * weight and contrast too, and no descriptive label holds a figure. Version 8:
 * the look is compiled per page, and a page is in token mode where it has one.
 */
export const PRIVATE_CHECKER_VERSION = 8;

/** The most compiled token CSS a page stores (each page serves only its own). */
export const PRIVATE_COMPILED_CSS_MAX_BYTES = 64 * 1024;

/**
 * Control and invisible characters (direction overrides, zero-width spaces): never part of a theme's words.
 * A joiner (Bangla's conjuncts), a variation selector and an emoji's tag stay.
 */
const HIDDEN_CHARACTERS = /(?![\t\n‌‍\p{Variation_Selector}\u{E0020}-\u{E007F}])[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/** Bounds of the theme's words on private pages. */
export const PRIVATE_WORDS_LIMITS = { languages: 8, text: 500 } as const;

const language = z.string().regex(/^[a-z]{2,3}$/, "A base language code: en, bn.");
const wordsSchema = z.record(language, z.string().trim().min(1).max(PRIVATE_WORDS_LIMITS.text))
  .refine((words) => Object.keys(words).length >= 1 && Object.keys(words).length <= PRIVATE_WORDS_LIMITS.languages, `Words in 1 to ${PRIVATE_WORDS_LIMITS.languages} languages.`)
  // Named, as the asset and the arrangement are: the contract states each shape once, not at every use.
  .meta({ id: "StorefrontPrivateWords" });

/** A file of the theme's own app (`public/<file>`): the app whose template the theme is. */
export const privateAssetRefSchema = z.object({
  app: z.string().regex(PLUGIN_ID_PATTERN),
  file: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,200}$/).refine((file) => !file.split("/").includes(".."), "A file inside public/."),
}).strict().meta({ id: "StorefrontPrivateAsset" });

const hook = z.string().max(PRIVATE_HOOK_MAX);

const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/** Refused with this reason and plain words: what a theme cannot set on a private page in this release. */
export const PRIVATE_NOT_AVAILABLE = "not_available";
const notAvailable = (what: string) => `${what} is not available yet: a theme arranges the store's parts and gives them tokens.`;

/** One node of an arrangement (structure only; `privateArrangementIssues` checks the names). */
export const privateNodeSchema: z.ZodType<PrivateNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("layout"), layout: z.enum(PRIVATE_LAYOUT_KINDS), hook: hook.optional(), children: z.array(privateNodeSchema).max(24) }).strict(),
  z.object({ type: z.literal("part"), part: name, variant: name.optional() }).strict(),
  z.object({ type: z.literal("target"), target: name }).strict(),
  // A theme's own content block: named only to be refused with its reason, never parsed into a node.
  z.object({ type: z.literal("content") }).passthrough().superRefine((_node, context) => {
    context.addIssue({ code: "custom", message: notAvailable("A content block"), params: { reason: PRIVATE_NOT_AVAILABLE } });
  }),
])).meta({ id: "StorefrontPrivateNode" }) as z.ZodType<PrivateNode>;

/** The deepest a layout tree may nest. */
export const PRIVATE_LAYOUT_MAX_DEPTH = 12;

/** How deep a stored arrangement nests, counted without recursion (so any input answers, never overflows). */
function arrangementDepth(value: unknown): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > PRIVATE_LAYOUT_MAX_DEPTH + 1) return depth;
    deepest = Math.max(deepest, depth);
    if (Array.isArray(node)) for (const child of node) stack.push([child, depth]);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) stack.push([child, key === "children" ? depth + 1 : depth]);
    }
  }
  return deepest;
}

/** Stands in for an arrangement nested too deep, before the recursive parse reaches it (it then fails as an unknown key). */
const TOO_DEEP = { layoutsNestAtMost12Deep: true };

export const privatePageArrangementSchema = z.preprocess(
  (value) => arrangementDepth(value) <= PRIVATE_LAYOUT_MAX_DEPTH ? value : TOO_DEEP,
  z.object({
    frame: name.optional(),
    layout: z.array(privateNodeSchema).max(24).optional(),
    items: z.record(z.string().regex(/^[a-z]{1,24}$/), z.array(privateNodeSchema).max(24)).optional(),
  }).strict(),
).meta({ id: "StorefrontPrivateArrangement" });

/** Each label's value: one of the host's variants for an action or an amount, the theme's words per language for the rest. */
const labelsSchema = z.object(Object.fromEntries(privateLabelKeys().map(({ key, spec }) => [key, spec.variants ? z.enum(spec.variants) : wordsSchema]))).partial().strict();
const iconKeys = privateIconKeys() as [string, ...string[]];

const pagesShape = Object.fromEntries(PRIVATE_PAGE_KEYS.map((page) => [page, privatePageArrangementSchema.optional()])) as Record<PrivatePageKey, z.ZodOptional<typeof privatePageArrangementSchema>>;

const privatePagesFields = {
  controls: z.enum(PRIVATE_CONTROL_PLACES).optional(),
  pages: z.object(pagesShape).strict(),
  tokens: privateTokensSchema,
  labels: labelsSchema,
  icons: z.partialRecord(z.enum(iconKeys), privateAssetRefSchema),
};

/**
 * What a theme cannot set on a private page in this release, each refused
 * with `not_available` when it would draw something: a stylesheet, the
 * theme's own chrome, the store's search in it, files for a stylesheet. The
 * empty values (`chrome: "core"`, `css: ""`, `assets: {}`) say nothing and
 * are dropped, so a document written by an earlier build of this model reads.
 */
const HELD = {
  chrome: { label: "The theme's own header and footer", empty: (value: unknown) => value === "core" },
  search: { label: "The store's search in the theme's header", empty: (value: unknown) => value === undefined },
  css: { label: "A stylesheet for private pages", empty: (value: unknown) => value === "" },
  assets: { label: "Files for a private page's stylesheet", empty: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0 },
} as const;
const heldFields = Object.fromEntries(Object.keys(HELD).map((key) => [key, z.unknown().optional()])) as Record<keyof typeof HELD, z.ZodOptional<z.ZodUnknown>>;

/**
 * A stored document's `privatePages` as this build reads it (the stored
 * document's path only: a save parses `storefrontPrivatePagesSchema` and
 * refuses each with `not_available`): what a theme cannot set here (`HELD`,
 * a content block anywhere in an arrangement) dropped, and `held` true when
 * any of it said something. The reader then marks the private pages' compile
 * refused (`refusedPrivatePages`): they draw the store's default look until
 * the next save, and the rest of the theme stays.
 */
export function readStoredPrivatePages(value: unknown): { value: unknown; held: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { value, held: false };
  let held = false;
  const rest: Record<string, unknown> = { ...value };
  for (const [key, entry] of Object.entries(HELD)) {
    if (!(key in rest)) continue;
    held ||= !entry.empty(rest[key]);
    delete rest[key];
  }
  const record = (each: unknown): each is Record<string, unknown> => typeof each === "object" && each !== null && !Array.isArray(each);
  const nodes = (list: unknown): unknown => Array.isArray(list) ? list.flatMap((node) => {
    if (record(node) && node.type === "content") { held = true; return []; }
    return [record(node) && node.type === "layout" ? { ...node, children: nodes(node.children) } : node];
  }) : list;
  if (record(rest.pages)) {
    rest.pages = Object.fromEntries(Object.entries(rest.pages).map(([page, arrangement]) => [page, record(arrangement) ? {
      ...arrangement,
      ...("layout" in arrangement ? { layout: nodes(arrangement.layout) } : {}),
      ...(record(arrangement.items) ? { items: Object.fromEntries(Object.entries(arrangement.items).map(([item, layout]) => [item, nodes(layout)])) } : {}),
    } : arrangement]));
  }
  return { value: rest, held };
}

function refuseHeld(value: Partial<Record<keyof typeof HELD, unknown>>, context: z.RefinementCtx): void {
  for (const [key, held] of Object.entries(HELD) as Array<[keyof typeof HELD, (typeof HELD)[keyof typeof HELD]]>) {
    if (key in value && !held.empty(value[key])) context.addIssue({ code: "custom", path: [key], message: notAvailable(held.label), params: { reason: PRIVATE_NOT_AVAILABLE } });
  }
}

function withoutHeld<T extends Partial<Record<keyof typeof HELD, unknown>>>(value: T): Omit<T, keyof typeof HELD> {
  const { chrome: _chrome, search: _search, css: _css, assets: _assets, ...rest } = value;
  return rest;
}

/** The document's `privatePages`. */
export const storefrontPrivatePagesSchema = z.object({
  ...privatePagesFields,
  ...heldFields,
  // A version 15 document written before tokens existed reads as having none.
  tokens: privateTokensSchema.optional().transform((tokens): PrivateTokens => tokens ?? {}),
  compiled: z.preprocess(compiledOfAnEarlierChecker, z.object({
    anatomy: z.number().int().min(1),
    /** The checker's version (0: never compiled): a page never serves what an older checker compiled. */
    sanitizer: z.number().int().min(0),
    /**
     * Each page's look, by page: the host's token rules. A page with an entry is drawn in token mode (the theme
     * set its tokens, or has a page paint); a page serves only its own entry.
     */
    css: z.partialRecord(z.enum(PRIVATE_PAGE_KEYS as [PrivatePageKey, ...PrivatePageKey[]]), z.string().max(PRIVATE_COMPILED_CSS_MAX_BYTES)),
    /** The store's maintenance compile refused this source: the pages draw the default look until a save. */
    refused: z.boolean().optional(),
  }).strict()),
}).strict().superRefine(refuseHeld).transform(withoutHeld);

/**
 * What a checker before version 7 wrote (one stylesheet for every page and a
 * token-mode flag): read as never compiled, so no page serves it and
 * maintenance compiles the published theme again.
 */
function compiledOfAnEarlierChecker(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { css, tokenMode: _tokenMode, ...rest } = value as Record<string, unknown>;
  return typeof css === "string" ? { ...rest, sanitizer: 0, css: {} } : value;
}

/** What an app template may set: any of it but the compiled output, which the store writes on save. */
export const storefrontPrivatePagesTemplateSchema = z.object({ ...privatePagesFields, ...heldFields }).partial().strict().superRefine(refuseHeld).transform(withoutHeld);

export interface StorefrontPrivatePages {
  /** Where the store's controls sit (unset: the store's checkout header). */
  controls?: PrivateControlPlace;
  pages: Partial<Record<PrivatePageKey, PrivatePageArrangement>>;
  tokens: PrivateTokens;
  labels: Partial<Record<string, PrivateWords | string>>;
  icons: Partial<Record<string, PrivateAssetRef>>;
  compiled: { anatomy: number; sanitizer: number; css: Partial<Record<PrivatePageKey, string>>; refused?: boolean };
}
export type StorefrontPrivatePagesTemplate = Partial<Omit<StorefrontPrivatePages, "compiled">>;

/** The private pages as the host draws them with no theme of its own. */
export function storefrontPrivatePagesDefault(): StorefrontPrivatePages {
  return { pages: {}, tokens: {}, labels: {}, icons: {}, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, css: {} } };
}

/**
 * Where the store's controls sit on a private page as served: the theme's
 * place (unset: the store's checkout header), or none when the served look
 * is the store's default.
 */
export function privateControlsPlace(privatePages: StorefrontPrivatePages): PrivateControlPlace {
  return servedPrivatePages(privatePages).controls ?? "header";
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
/** Words without direction overrides or invisible characters. */
export function plainPrivateWords(words: PrivateWords): PrivateWords {
  return Object.fromEntries(Object.entries(words).map(([lang, text]) => [lang, text.replace(HIDDEN_CHARACTERS, "")]));
}

function wordsIssues(words: PrivateWords | undefined, path: Array<string | number>, max: number, figures: boolean): PrivatePagesIssue[] {
  if (!words) return [];
  return Object.entries(words).flatMap(([lang, text]): PrivatePagesIssue[] => {
    if (MARKUP.test(text)) return [{ path: [...path, lang], reason: "markup" as const, message: "Plain text only: no HTML." }];
    if (text.length > max) return [{ path: [...path, lang], reason: "label_too_long" as const, message: `At most ${max} characters.` }];
    // A label never reads as an amount: the store writes every amount.
    if (!figures && FIGURES.test(text)) return [{ path: [...path, lang], reason: "label_figures" as const, message: "A label holds no digits or currency signs: the store writes every amount, so a label never reads as one." }];
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

/**
 * Checks and compiles `privatePages` as a save or a publish does: every
 * arrangement against its page's anatomy, every token by type and against
 * the contrast floor, every label against its bound, plain text everywhere
 * and icons from the theme's own app only. Defaults are dropped from the
 * arrangements, so a default page stores nothing. The compiled CSS is the
 * host's token rules only: no theme writes CSS here.
 */
export function compileStorefrontPrivatePages(value: StorefrontPrivatePages, context: PrivatePagesCompileContext): { ok: true; value: StorefrontPrivatePages } | { ok: false; issues: PrivatePagesIssue[] } {
  const issues: PrivatePagesIssue[] = [];
  const pages: StorefrontPrivatePages["pages"] = {};
  for (const page of PRIVATE_PAGE_KEYS) {
    const arrangement = value.pages[page];
    if (!arrangement) continue;
    const base = ["privatePages", "pages", page];
    issues.push(...privateArrangementIssues(page, arrangement).map((issue) => ({ ...issue, path: [...base, ...issue.path] })));
    const compact = compactPrivateArrangement(page, arrangement);
    if (compact) pages[page] = compact;
  }
  const files = Object.entries(value.icons).flatMap(([key, ref]): Array<[Array<string | number>, PrivateAssetRef]> => ref ? [[["privatePages", "icons", key], ref]] : []);
  for (const [path, ref] of files) {
    if (ref.app !== context.themeApp) issues.push({ path, reason: "foreign_asset", message: `${ref.app}/${ref.file}: a private page names only the theme's own files${context.themeApp ? ` (${context.themeApp})` : ""}.` });
  }
  const tokenCss: Partial<Record<PrivatePageKey, string>> = {};
  // A theme's page paint shows behind every private page: a page with no tokens is drawn in token mode
  // anyway, its rows the defaults computed from the paint, so what stands on the paint is checked on it
  // (the drawer has no page of its own: it opens over public pages and takes their look).
  const painted = context.palettes.some((palette) => palette.pagePaint);
  for (const page of PRIVATE_PAGE_KEYS) {
    const tokens = Object.keys(value.tokens[page] ?? {}).length > 0 ? value.tokens[page]! : painted && privatePageHasOwnPage(page) ? {} : null;
    if (!tokens) continue;
    const arrangement = privatePageArrangement({ ...value, pages, compiled: { ...value.compiled, anatomy: PRIVATE_ANATOMY_VERSION } }, page) ?? context.defaults?.[page];
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    const compiled = compilePrivateTokens(page, tokens, {
      layout: arrangement?.layout ?? spec.layout,
      items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, arrangement?.items?.[item] ?? spec.items[item]!.layout])),
      palettes: context.palettes,
    });
    issues.push(...compiled.issues);
    // A page of its own is drawn in token mode wherever its table was written (an empty look included).
    if (privatePageHasOwnPage(page) && compiled.issues.length === 0) tokenCss[page] = compiled.css;
  }
  const specs = new Map(privateLabelKeys().map((entry) => [entry.key, entry.spec]));
  const labels = Object.fromEntries(Object.entries(value.labels).flatMap(([key, words]) => words ? [[key, typeof words === "string" ? words : plainPrivateWords(words)]] : []));
  for (const [key, label] of Object.entries(labels)) {
    const spec = specs.get(key)!;
    const path = ["privatePages", "labels", key];
    if (spec.variants) {
      if (typeof label !== "string" || !spec.variants.includes(label)) issues.push({ path, reason: "label_variant", message: `${key} names an action or an amount: choose one of ${spec.variants.join(", ")}; the store words it in every language.` });
    } else if (typeof label === "string") {
      issues.push({ path, reason: "label_variant", message: `${key} is the theme's own words, per language: { "en": "…", "bn": "…" }.` });
    } else {
      issues.push(...wordsIssues(label, path, spec.max, spec.figures === true));
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  // Each page serves only its own look, so each has its own bound: a large cart never costs the payment step its look.
  const large = (Object.entries(tokenCss) as Array<[PrivatePageKey, string]>).filter(([, css]) => new TextEncoder().encode(css).byteLength > PRIVATE_COMPILED_CSS_MAX_BYTES);
  if (large.length > 0) {
    return { ok: false, issues: large.map(([page]) => ({ path: ["privatePages", "tokens", page], reason: "too_large" as const, message: `The ${page} page's compiled look is over ${PRIVATE_COMPILED_CSS_MAX_BYTES / 1024} KiB; set fewer tokens there.` })) };
  }
  return { ok: true, value: { ...value, pages, labels, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, css: tokenCss } } };
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
 * The private pages with their compile refused at this build's versions:
 * their source kept (filled for this anatomy), no look served, the store's
 * default look drawn until the next save compiles them. What the maintenance
 * compile writes for a theme this checker refuses, and what a read gives a
 * stored document that held what a theme cannot set.
 */
export function refusedPrivatePages(privatePages: StorefrontPrivatePages): StorefrontPrivatePages {
  return { ...filledPrivatePages(privatePages), compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, css: {}, refused: true } };
}

/** Whether `compiled` was written by this build's checker and anatomy (else maintenance compiles it again). */
export function privatePagesCompiledCurrent(privatePages: Pick<StorefrontPrivatePages, "compiled">): boolean {
  return privatePages.compiled.sanitizer === PRIVATE_CHECKER_VERSION && privatePages.compiled.anatomy === PRIVATE_ANATOMY_VERSION;
}

/**
 * The private pages a buyer's page draws: the theme's when this build
 * compiled them and they passed, else the store's default look entirely
 * (arrangement, controls, words, icons and look), never a half of the theme.
 */
export function servedPrivatePages(privatePages: StorefrontPrivatePages): StorefrontPrivatePages {
  return privatePagesCompiledCurrent(privatePages) && !privatePages.compiled.refused ? privatePages : storefrontPrivatePagesDefault();
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
  return privatePagesCompiledCurrent(privatePages) && !privatePages.compiled.refused ? privatePages.compiled.css[page] ?? "" : "";
}

/**
 * The page is in token mode (the compile wrote its table: the theme set its
 * tokens, or has a page paint): its colours come from its compiled table, the
 * host's palette classes read it. Another page's tokens never put it there.
 */
export function privatePageTokenMode(privatePages: Pick<StorefrontPrivatePages, "compiled">, page: PrivatePageKey): boolean {
  return privatePageHasOwnPage(page) && privatePagesCompiledCurrent(privatePages) && !privatePages.compiled.refused && privatePages.compiled.css[page] !== undefined;
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
  return Object.fromEntries(Object.entries(PRIVATE_PAGES[page].labels).flatMap(([key, spec]) => {
    const label = privatePages.labels[key];
    const words = typeof label === "string" ? (spec.variants?.includes(label) ? variantWords(label) : null) : privateWords(label, languageCode);
    return words === null ? [] : [[key, words]];
  }));
}
