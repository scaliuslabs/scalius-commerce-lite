// The theme document's `privatePages`: how the buyer's private pages are
// arranged, worded and styled (private-anatomy.ts has the parts, private-
// arrangement.ts the rules, private-css.ts the stylesheet's).
//
// - `chrome`: `core` draws the store's minimal checkout header there;
//   `theme` draws the theme's header and footer, script-free and from the
//   same store projections the public pages use (never a buyer's data).
// - `pages`: each page's arrangement; an absent page draws as the host does.
// - `css`: the theme's stylesheet for these pages, as written.
// - `labels`, `icons`: host words the theme rewords per language, host icons
//   it replaces with its own files.
// - `compiled`: written by the store on every save and publish, never by
//   hand: the checked, scoped stylesheet and the anatomy version the
//   arrangements were checked against. A page reads it as it is, so a custom
//   arrangement costs no query and no parse beyond the document's.
import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "../plugins/ids";
import {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_CONTENT_TONES,
  PRIVATE_HOOK_MAX,
  PRIVATE_LAYOUT_KINDS,
  PRIVATE_PAGES,
  PRIVATE_PAGE_KEYS,
  privateIconKeys,
  privateLabelKeys,
  type PrivateAssetRef,
  type PrivateContentBlock,
  type PrivateNode,
  type PrivatePageKey,
  type PrivateWords,
} from "./private-anatomy";
import {
  compactPrivateArrangement,
  fillPrivateArrangement,
  privateArrangementIssues,
  type PrivatePageArrangement,
} from "./private-arrangement";
import { PRIVATE_COMPILED_CSS_MAX_BYTES, PRIVATE_CSS_MAX_BYTES, compilePrivateCss, type PrivateCssReason } from "./private-css";

export const STOREFRONT_PRIVATE_CHROME = ["core", "theme"] as const;
export type StorefrontPrivateChrome = (typeof STOREFRONT_PRIVATE_CHROME)[number];

/** Bounds of the theme's words on private pages. */
export const PRIVATE_WORDS_LIMITS = { languages: 8, text: 500 } as const;

const language = z.string().regex(/^[a-z]{2,3}$/, "A base language code: en, bn.");
const wordsSchema = z.record(language, z.string().trim().min(1).max(PRIVATE_WORDS_LIMITS.text))
  .refine((words) => Object.keys(words).length >= 1 && Object.keys(words).length <= PRIVATE_WORDS_LIMITS.languages, `Words in 1 to ${PRIVATE_WORDS_LIMITS.languages} languages.`);

/** A file of the theme's app (`public/<file>`). */
export const privateAssetRefSchema = z.object({
  app: z.string().regex(PLUGIN_ID_PATTERN),
  file: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,200}$/).refine((file) => !file.split("/").includes(".."), "A file inside public/."),
}).strict();

const hook = z.string().max(PRIVATE_HOOK_MAX);
const tone = z.enum(PRIVATE_CONTENT_TONES);
/** A store path: one slash, then the path (no host, no scheme). */
const storePath = z.string().max(300).regex(/^\/(?![/\\])[^\s"'<>\\]*$/, "A path on this store (/pages/help).");

export const privateContentBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: wordsSchema, level: z.union([z.literal(2), z.literal(3)]).optional() }).strict(),
  z.object({ kind: z.literal("text"), text: wordsSchema, tone: tone.optional() }).strict(),
  z.object({ kind: z.literal("link"), text: wordsSchema, href: storePath }).strict(),
  z.object({ kind: z.literal("image"), image: privateAssetRefSchema, alt: wordsSchema, width: z.number().int().min(1).max(2000), height: z.number().int().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("banner"), tone, title: wordsSchema.optional(), text: wordsSchema.optional() }).strict(),
  z.object({ kind: z.literal("disclosure"), summary: wordsSchema, text: wordsSchema }).strict(),
  z.object({ kind: z.literal("divider") }).strict(),
]);

const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/** One node of an arrangement (structure only; `privateArrangementIssues` checks the names). */
export const privateNodeSchema: z.ZodType<PrivateNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("layout"), layout: z.enum(PRIVATE_LAYOUT_KINDS), hook: hook.optional(), children: z.array(privateNodeSchema).max(24) }).strict(),
  z.object({ type: z.literal("part"), part: name, variant: name.optional() }).strict(),
  z.object({ type: z.literal("target"), target: name }).strict(),
  z.object({ type: z.literal("content"), content: privateContentBlockSchema, hook: hook.optional() }).strict(),
])).meta({ id: "StorefrontPrivateNode" }) as z.ZodType<PrivateNode>;

export const privatePageArrangementSchema = z.object({
  frame: name.optional(),
  layout: z.array(privateNodeSchema).max(24).optional(),
  items: z.record(z.string().regex(/^[a-z]{1,24}$/), z.array(privateNodeSchema).max(24)).optional(),
}).strict();

const labelKeys = privateLabelKeys().map((entry) => entry.key) as [string, ...string[]];
const iconKeys = privateIconKeys() as [string, ...string[]];

const pagesShape = Object.fromEntries(PRIVATE_PAGE_KEYS.map((page) => [page, privatePageArrangementSchema.optional()])) as Record<PrivatePageKey, z.ZodOptional<typeof privatePageArrangementSchema>>;

const privatePagesFields = {
  chrome: z.enum(STOREFRONT_PRIVATE_CHROME),
  pages: z.object(pagesShape).strict(),
  css: z.string().max(PRIVATE_CSS_MAX_BYTES),
  labels: z.partialRecord(z.enum(labelKeys), wordsSchema),
  icons: z.partialRecord(z.enum(iconKeys), privateAssetRefSchema),
};

/** The document's `privatePages`. */
export const storefrontPrivatePagesSchema = z.object({
  ...privatePagesFields,
  compiled: z.object({
    anatomy: z.number().int().min(1),
    css: z.string().max(PRIVATE_COMPILED_CSS_MAX_BYTES),
  }).strict(),
}).strict();

/** What an app template may set: any of it but the compiled output, which the store writes on save. */
export const storefrontPrivatePagesTemplateSchema = z.object(privatePagesFields).partial().strict();

export interface StorefrontPrivatePages {
  chrome: StorefrontPrivateChrome;
  pages: Partial<Record<PrivatePageKey, PrivatePageArrangement>>;
  css: string;
  labels: Partial<Record<string, PrivateWords>>;
  icons: Partial<Record<string, PrivateAssetRef>>;
  compiled: { anatomy: number; css: string };
}
export type StorefrontPrivatePagesTemplate = Partial<Omit<StorefrontPrivatePages, "compiled">>;

/** The private pages as the host draws them with no theme of its own. */
export function storefrontPrivatePagesDefault(): StorefrontPrivatePages {
  return { chrome: "core", pages: {}, css: "", labels: {}, icons: {}, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, css: "" } };
}

// ─── Compiling on save ────────────────────────────────────────────────────

/** Why a save of `privatePages` is refused. */
export type PrivatePagesReason =
  | ReturnType<typeof privateArrangementIssues>[number]["reason"]
  | PrivateCssReason
  | "label_too_long" | "markup";

export interface PrivatePagesIssue {
  path: Array<string | number>;
  reason: PrivatePagesReason;
  message: string;
}

/** Text that reads as markup (`<b>`, `</p>`, `<!--`): words here are plain text. */
const MARKUP = /<[A-Za-z!/?]/;

function wordsIssues(words: PrivateWords | undefined, path: Array<string | number>, max: number): PrivatePagesIssue[] {
  if (!words) return [];
  return Object.entries(words).flatMap(([lang, text]) => {
    if (MARKUP.test(text)) return [{ path: [...path, lang], reason: "markup" as const, message: "Plain text only: no HTML." }];
    if (text.length > max) return [{ path: [...path, lang], reason: "label_too_long" as const, message: `At most ${max} characters.` }];
    return [];
  });
}

function contentIssues(nodes: readonly PrivateNode[], path: Array<string | number>): PrivatePagesIssue[] {
  return nodes.flatMap((node, index): PrivatePagesIssue[] => {
    const at = [...path, index];
    if (node.type === "layout") return contentIssues(node.children, [...at, "children"]);
    if (node.type !== "content") return [];
    const block: PrivateContentBlock = node.content;
    const fields = Object.entries(block).filter((entry): entry is [string, PrivateWords] => typeof entry[1] === "object" && entry[0] !== "image");
    return fields.flatMap(([field, words]) => wordsIssues(words, [...at, "content", field], PRIVATE_WORDS_LIMITS.text));
  });
}

/**
 * Checks and compiles `privatePages` as a save or a publish does: every
 * arrangement against its page's anatomy, every label against its bound,
 * plain text everywhere, and the stylesheet (checked and scoped). Defaults
 * are dropped from the arrangements, so a default page stores nothing.
 */
export function compileStorefrontPrivatePages(value: StorefrontPrivatePages): { ok: true; value: StorefrontPrivatePages } | { ok: false; issues: PrivatePagesIssue[] } {
  const issues: PrivatePagesIssue[] = [];
  const pages: StorefrontPrivatePages["pages"] = {};
  for (const page of PRIVATE_PAGE_KEYS) {
    const arrangement = value.pages[page];
    if (!arrangement) continue;
    const base = ["privatePages", "pages", page];
    issues.push(...privateArrangementIssues(page, arrangement).map((issue) => ({ ...issue, path: [...base, ...issue.path] })));
    if (arrangement.layout) issues.push(...contentIssues(arrangement.layout, [...base, "layout"]));
    for (const [item, layout] of Object.entries(arrangement.items ?? {})) issues.push(...contentIssues(layout, [...base, "items", item]));
    const compact = compactPrivateArrangement(page, arrangement);
    if (compact) pages[page] = compact;
  }
  const bounds = new Map(privateLabelKeys().map((entry) => [entry.key, entry.max]));
  for (const [key, words] of Object.entries(value.labels)) issues.push(...wordsIssues(words, ["privatePages", "labels", key], bounds.get(key) ?? 0));
  const css = compilePrivateCss(value.css);
  issues.push(...css.issues.map((issue) => ({ path: ["privatePages", "css"], reason: issue.reason, message: `${issue.message} (at character ${issue.at})` })));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...value, pages, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, css: css.css } } };
}

// ─── Reading on the page ──────────────────────────────────────────────────

/** A page's arrangement as this build draws it: as stored when it was checked against this anatomy, else filled in. */
export function privatePageArrangement(privatePages: StorefrontPrivatePages, page: PrivatePageKey): PrivatePageArrangement | undefined {
  const arrangement = privatePages.pages[page];
  if (!arrangement) return undefined;
  return privatePages.compiled.anatomy === PRIVATE_ANATOMY_VERSION ? arrangement : fillPrivateArrangement(page, arrangement);
}

/** Words in the page's language: its base language, else English, else the first the theme wrote. */
export function privateWords(words: PrivateWords | undefined, languageCode: string | null | undefined): string | null {
  if (!words) return null;
  const base = (languageCode ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return words[base] ?? words.en ?? Object.values(words)[0] ?? null;
}

/** The host label `key` in the page's language: the theme's words, else `fallback`. */
export function privateLabel(privatePages: Pick<StorefrontPrivatePages, "labels">, key: string, languageCode: string | null | undefined, fallback: string): string {
  return privateWords(privatePages.labels[key], languageCode) ?? fallback;
}

/** The labels of one page in one language (what a page sends its browser code). */
export function privatePageLabels(privatePages: Pick<StorefrontPrivatePages, "labels">, page: PrivatePageKey, languageCode: string | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.keys(PRIVATE_PAGES[page].labels).flatMap((key) => {
    const words = privateWords(privatePages.labels[key], languageCode);
    return words === null ? [] : [[key, words]];
  }));
}
