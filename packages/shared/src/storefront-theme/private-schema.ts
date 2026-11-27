// The theme document's `privatePages` as a schema reads it (private-layout.ts
// says what each field means): the arrangements' shape, the token, label and
// icon records, what a release holds back, and the empty value. It reads the
// page keys and words (private-keys.ts), never the anatomy's spec table or the
// compiler, so a bundle that parses a document (the dashboard's draft check)
// carries neither. private-layout.ts and private-tokens.ts re-export it.
import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "../plugins/ids";
import type { PrivateAssetRef, PrivateNode, PrivateTokenName, PrivateWords } from "./private-anatomy";
import {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_CONTROL_PLACES,
  PRIVATE_HOOK_MAX,
  PRIVATE_LAYOUT_KINDS,
  PRIVATE_PAGE_KEYS,
  privateIconKeys,
  privateLabelKeys,
  type PrivateControlPlace,
  type PrivatePageKey,
} from "./private-keys";
import type { PrivatePageArrangement } from "./private-arrangement";

/** `privatePages.tokens`: per page, per style target (`@<layout hook>`, `ui.<kind>…`), per token, a value. */
// Names are checked by the compile (`unknown_style`, `unknown_token`) so the schema stays small.
export const privateTokensSchema = z.record(
  z.string().regex(/^[a-zA-Z]{1,24}$/),
  z.record(z.string().regex(/^(?:@[a-z][a-z0-9-]{0,40}|[a-z][a-z0-9-]{0,40}|ui\.[a-z]{1,12}(?:\.[a-z]{1,12})?(?:@[a-z0-9][a-z0-9.-]{0,63})?(?:\/[a-z_.]{1,64})?)$/), z.record(z.string().regex(/^[a-z][a-z-]{0,23}$/), z.unknown())),
).refine((tokens) => Object.keys(tokens).every((page) => (PRIVATE_PAGE_KEYS as readonly string[]).includes(page)), "Tokens are set per private page: cart.") as unknown as z.ZodType<PrivateTokens>;
export type PrivateTokens = Partial<Record<PrivatePageKey, Record<string, Partial<Record<PrivateTokenName, unknown>>>>>;

/**
 * The checker's version: a page never serves a look an older checker
 * compiled (maintenance compiles the published theme again). Version 6: a
 * theme's stylesheet, chrome and content blocks are not available. Version
 * 7: the look is compiled per page, and a page is in token mode where it has
 * one; a filled button's fill and an outlined control's or a field's edge read
 * at 3:1, Place order and Confirm outrank their neighbours, the total by
 * weight and contrast too, and no descriptive label holds a figure. Version 8:
 * the look is compiled per page, and a page is in token mode where it has one.
 * Version 9: a `size` scales with the page's width, not its column's.
 * Version 10: a refusal is per page (that page draws the store's default
 * look, the others keep theirs) and records why; a page joins token mode
 * only when the theme names it (`pages.<page>` or `tokens.<page>`), a page
 * paint alone no longer puts it there.
 */
export const PRIVATE_CHECKER_VERSION = 10;

/**
 * Two versions of the private pages' compile, because they fail differently:
 *
 * - `PRIVATE_CHECKER_VERSION` (stored as `sanitizer`), the compiler's: what
 *   CSS it writes and how (the host's rules, token mode, the anatomy it reads).
 *   A compile an older compiler made is never served: the pages draw the
 *   store's default look until this build compiles them. Bump it only for a
 *   change to what is written, or a safety fix to it.
 * - `PRIVATE_POLICY_VERSION` (stored as `policy`), the checks': which values a
 *   save refuses (a floor, a rank, a word rule, a new reason). A compile an
 *   older policy passed keeps being served (it is still the host's own rules
 *   from typed values, and it passed the policy of its day) until the
 *   maintenance compile replaces it, refusing only the pages this policy no
 *   longer passes. Bump it for a stricter or new check.
 */
export const PRIVATE_POLICY_VERSION = 1;

/** The most compiled token CSS a page stores (each page serves only its own). */
export const PRIVATE_COMPILED_CSS_MAX_BYTES = 64 * 1024;

/** The most reasons a refused page records (the first ones a save would give). */
export const PRIVATE_PAGE_REFUSALS_MAX = 8;

/** Why a page's compile was refused: the save's own issue (its path in the document, reason code and words). */
export interface PrivatePageRefusal {
  path: string;
  reason: string;
  message: string;
}

const privatePageRefusalSchema = z.object({
  path: z.string().max(240),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  message: z.string().max(600),
}).strict().meta({ id: "StorefrontPrivatePageRefusal" });

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

/**
 * The pages a theme gives a look (tokens) but does not arrange yet: the
 * receipt and the account draw their parts in the store's order; an
 * arrangement other than the default is refused (`not_available`).
 */
export const PRIVATE_LOOK_ONLY_PAGES: readonly PrivatePageKey[] = ["receipt", "account"];

/** Refused with this reason and plain words: what a theme cannot set on a private page in this release. */
export const PRIVATE_NOT_AVAILABLE = "not_available";
/** The words of a `not_available` refusal: what a theme cannot set yet. */
export const privateNotAvailable = (what: string) => `${what} is not available yet: a theme arranges the store's parts and gives them tokens.`;

/** One node of an arrangement (structure only; `privateArrangementIssues` checks the names). */
export const privateNodeSchema: z.ZodType<PrivateNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("layout"), layout: z.enum(PRIVATE_LAYOUT_KINDS), hook: hook.optional(), children: z.array(privateNodeSchema).max(24) }).strict(),
  z.object({ type: z.literal("part"), part: name, variant: name.optional() }).strict(),
  z.object({ type: z.literal("target"), target: name }).strict(),
  // A theme's own content block: named only to be refused with its reason, never parsed into a node.
  z.object({ type: z.literal("content") }).passthrough().superRefine((_node, context) => {
    context.addIssue({ code: "custom", message: privateNotAvailable("A content block"), params: { reason: PRIVATE_NOT_AVAILABLE } });
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


export const privatePageArrangementSchema = z.preprocess(
  // Refused before the recursive parse reaches it, with its reason.
  (value, context) => {
    if (arrangementDepth(value) <= PRIVATE_LAYOUT_MAX_DEPTH) return value;
    context.addIssue({ code: "custom", message: `Layouts nest at most ${PRIVATE_LAYOUT_MAX_DEPTH} deep in a stored arrangement.`, params: { reason: "too_deep" } });
    return z.NEVER;
  },
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

/** What a stored document held that a theme cannot set: on one page (a content block in its arrangement), or theme-wide (null). */
export interface PrivatePagesHeld {
  page: PrivatePageKey | null;
  label: string;
}

/**
 * A stored document's `privatePages` as this build reads it (the stored
 * document's path only: a save parses `storefrontPrivatePagesSchema` and
 * refuses each with `not_available`): what a theme cannot set here (`HELD`,
 * a content block anywhere in an arrangement) dropped, and `held` naming
 * each that said something. The reader then refuses the pages it reached
 * (`refusedPrivatePages`): they draw the store's default look until the next
 * save, and the rest of the theme stays.
 */
export function readStoredPrivatePages(value: unknown): { value: unknown; held: PrivatePagesHeld[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { value, held: [] };
  const held: PrivatePagesHeld[] = [];
  const rest: Record<string, unknown> = { ...value };
  for (const [key, entry] of Object.entries(HELD)) {
    if (!(key in rest)) continue;
    if (!entry.empty(rest[key])) held.push({ page: null, label: entry.label });
    delete rest[key];
  }
  const record = (each: unknown): each is Record<string, unknown> => typeof each === "object" && each !== null && !Array.isArray(each);
  const nodes = (list: unknown, page: string): unknown => Array.isArray(list) ? list.flatMap((node) => {
    if (record(node) && node.type === "content") {
      if ((PRIVATE_PAGE_KEYS as readonly string[]).includes(page) && !held.some((each) => each.page === page)) held.push({ page: page as PrivatePageKey, label: "A content block" });
      return [];
    }
    return [record(node) && node.type === "layout" ? { ...node, children: nodes(node.children, page) } : node];
  }) : list;
  if (record(rest.pages)) {
    rest.pages = Object.fromEntries(Object.entries(rest.pages).map(([page, arrangement]) => [page, record(arrangement) ? {
      ...arrangement,
      ...("layout" in arrangement ? { layout: nodes(arrangement.layout, page) } : {}),
      ...(record(arrangement.items) ? { items: Object.fromEntries(Object.entries(arrangement.items).map(([item, layout]) => [item, nodes(layout, page)])) } : {}),
    } : arrangement]));
  }
  return { value: rest, held };
}

function refuseHeld(value: Partial<Record<keyof typeof HELD, unknown>>, context: z.RefinementCtx): void {
  for (const [key, held] of Object.entries(HELD) as Array<[keyof typeof HELD, (typeof HELD)[keyof typeof HELD]]>) {
    if (key in value && !held.empty(value[key])) context.addIssue({ code: "custom", path: [key], message: privateNotAvailable(held.label), params: { reason: PRIVATE_NOT_AVAILABLE } });
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
    /**
     * The pages this source was refused on, each with why (the save's own issues: path, reason, words): each
     * draws the store's default look until a save, the others serve theirs. The merchant is shown them.
     */
    refused: z.partialRecord(z.enum(PRIVATE_PAGE_KEYS as [PrivatePageKey, ...PrivatePageKey[]]), z.array(privatePageRefusalSchema).min(1).max(PRIVATE_PAGE_REFUSALS_MAX)).optional(),
    /** The checks' version (`PRIVATE_POLICY_VERSION`; absent: before it was stored): an older one is still served, and maintenance compiles again. */
    policy: z.number().int().min(0).optional(),
    /**
     * A fingerprint of the source and of this compile (`privatePagesDigest`): a read serves the compile only
     * while it matches, so a stored look edited apart from its source (a row written by hand) is never served.
     */
    digest: z.string().regex(/^[a-z0-9]{1,32}$/).optional(),
  }).strict()),
}).strict().superRefine(refuseHeld).transform(withoutHeld);

/**
 * What a checker before version 7 wrote (one stylesheet for every page and a
 * token-mode flag), or before version 10 (one refusal for every page, with no
 * reason): read as never compiled, so no page serves it and maintenance
 * compiles the published theme again.
 */
function compiledOfAnEarlierChecker(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { css, tokenMode: _tokenMode, refused, ...rest } = value as Record<string, unknown>;
  return typeof css === "string" || typeof refused === "boolean" ? { ...rest, sanitizer: 0, css: {} } : value;
}

/** What an app template may set: any of it but the compiled output, which the store writes on save. */
export const storefrontPrivatePagesTemplateSchema = z.object({ ...privatePagesFields, ...heldFields }).partial().strict().superRefine(refuseHeld).transform(withoutHeld);

export interface StorefrontPrivatePages {
  /** Where the store's controls sit on the pages the theme names (unset: the store's checkout header). */
  controls?: PrivateControlPlace;
  pages: Partial<Record<PrivatePageKey, PrivatePageArrangement>>;
  tokens: PrivateTokens;
  labels: Partial<Record<string, PrivateWords | string>>;
  icons: Partial<Record<string, PrivateAssetRef>>;
  compiled: { anatomy: number; sanitizer: number; css: Partial<Record<PrivatePageKey, string>>; refused?: Partial<Record<PrivatePageKey, PrivatePageRefusal[]>>; policy?: number; digest?: string };
}
export type StorefrontPrivatePagesTemplate = Partial<Omit<StorefrontPrivatePages, "compiled">>;

/** The private pages as the host draws them with no theme of its own. */
export function storefrontPrivatePagesDefault(): StorefrontPrivatePages {
  return { pages: {}, tokens: {}, labels: {}, icons: {}, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CHECKER_VERSION, policy: PRIVATE_POLICY_VERSION, css: {} } };
}
