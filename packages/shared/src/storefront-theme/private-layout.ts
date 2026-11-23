// The theme document's `privatePages`: how the buyer's private pages are
// arranged, worded and styled (private-anatomy.ts has the parts, private-
// arrangement.ts the rules, private-css.ts the stylesheet's).
//
// - `chrome`: `core` draws the store's minimal checkout header there;
//   `theme` draws the theme's header and footer, script-free and from the
//   same store projections the public pages use (never a buyer's data).
// - `pages`: each page's arrangement; an absent page draws as the host does.
// - `tokens`: the look of the host parts, as typed values per style target
//   (private-tokens.ts); the host writes the CSS.
// - `css`: the theme's stylesheet for its free regions, as written.
// - `labels`, `icons`: host words the theme rewords per language, host icons
//   it replaces with its own files.
// - `compiled`: written by the store on every save and publish, never by
//   hand: the token CSS and the checked stylesheet, the checker's version
//   and the anatomy version the arrangements were checked against. A page
//   reads it as it is, so a custom look costs no query and no parse beyond
//   the document's; one an older checker wrote serves nothing until the
//   store compiles it again (a save, or maintenance after a deploy).
import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "../plugins/ids";
import { parsePluginSurfaceKey } from "../plugins/storefront";
import type { StorefrontThemeColors } from "./contrast";
import { storefrontDarkPalette, type StorefrontThemeTokens } from "./tokens";
import {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_CONTENT_LIMITS,
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
  type PrivatePageSpec,
  type PrivateWords,
} from "./private-anatomy";
import {
  compactPrivateArrangement,
  fillPrivateArrangement,
  privateArrangementIssues,
  type PrivatePageArrangement,
} from "./private-arrangement";
import {
  PRIVATE_ASSET_KEY,
  PRIVATE_COMPILED_CSS_MAX_BYTES,
  PRIVATE_CSS_MAX_BYTES,
  PRIVATE_CSS_SANITIZER_VERSION,
  compilePrivateCss,
  type PrivateCssContext,
  type PrivateCssReason,
} from "./private-css";
import { withoutHiddenCharacters } from "./private-css-syntax";
import {
  privateTokenCss,
  privateTokenIssues,
  privatePalettes,
  privateTokensSchema,
  type PrivateTokenReason,
  type PrivateTokens,
} from "./private-tokens";

export const STOREFRONT_PRIVATE_CHROME = ["core", "theme"] as const;
export type StorefrontPrivateChrome = (typeof STOREFRONT_PRIVATE_CHROME)[number];

/** Bounds of the theme's words on private pages. */
export const PRIVATE_WORDS_LIMITS = { languages: 8, text: 500 } as const;

const language = z.string().regex(/^[a-z]{2,3}$/, "A base language code: en, bn.");
const wordsSchema = z.record(language, z.string().trim().min(1).max(PRIVATE_WORDS_LIMITS.text))
  .refine((words) => Object.keys(words).length >= 1 && Object.keys(words).length <= PRIVATE_WORDS_LIMITS.languages, `Words in 1 to ${PRIVATE_WORDS_LIMITS.languages} languages.`);

/** A file of the theme's own app (`public/<file>`): the app whose template the theme is. */
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
);

const labelKeys = privateLabelKeys().map((entry) => entry.key) as [string, ...string[]];
const iconKeys = privateIconKeys() as [string, ...string[]];

const pagesShape = Object.fromEntries(PRIVATE_PAGE_KEYS.map((page) => [page, privatePageArrangementSchema.optional()])) as Record<PrivatePageKey, z.ZodOptional<typeof privatePageArrangementSchema>>;

const privatePagesFields = {
  chrome: z.enum(STOREFRONT_PRIVATE_CHROME),
  pages: z.object(pagesShape).strict(),
  tokens: privateTokensSchema,
  css: z.string().max(PRIVATE_CSS_MAX_BYTES),
  labels: z.partialRecord(z.enum(labelKeys), wordsSchema),
  icons: z.partialRecord(z.enum(iconKeys), privateAssetRefSchema),
  /** The theme's files its stylesheet names (`url(<key>)`), at most 16. */
  assets: z.record(z.string().regex(PRIVATE_ASSET_KEY), privateAssetRefSchema)
    .refine((assets) => Object.keys(assets).length <= 16, "At most 16 assets."),
};

/** The document's `privatePages`. */
export const storefrontPrivatePagesSchema = z.object({
  ...privatePagesFields,
  // A version 15 document written before tokens existed reads as having none.
  tokens: privateTokensSchema.optional().transform((tokens): PrivateTokens => tokens ?? {}),
  compiled: z.object({
    anatomy: z.number().int().min(1),
    /** The checker's version (0: never compiled): a page never serves what an older checker compiled. */
    sanitizer: z.number().int().min(0),
    css: z.string().max(PRIVATE_COMPILED_CSS_MAX_BYTES),
  }).strict(),
}).strict();

/** What an app template may set: any of it but the compiled output, which the store writes on save. */
export const storefrontPrivatePagesTemplateSchema = z.object(privatePagesFields).partial().strict();

export interface StorefrontPrivatePages {
  chrome: StorefrontPrivateChrome;
  pages: Partial<Record<PrivatePageKey, PrivatePageArrangement>>;
  tokens: PrivateTokens;
  css: string;
  labels: Partial<Record<string, PrivateWords>>;
  icons: Partial<Record<string, PrivateAssetRef>>;
  assets: Record<string, PrivateAssetRef>;
  compiled: { anatomy: number; sanitizer: number; css: string };
}
export type StorefrontPrivatePagesTemplate = Partial<Omit<StorefrontPrivatePages, "compiled">>;

/** The private pages as the host draws them with no theme of its own. */
export function storefrontPrivatePagesDefault(): StorefrontPrivatePages {
  return { chrome: "core", pages: {}, tokens: {}, css: "", labels: {}, icons: {}, assets: {}, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CSS_SANITIZER_VERSION, css: "" } };
}

// ─── Compiling on save ────────────────────────────────────────────────────

/** Why a save of `privatePages` is refused. */
export type PrivatePagesReason =
  | ReturnType<typeof privateArrangementIssues>[number]["reason"]
  | PrivateCssReason
  | PrivateTokenReason
  | "label_too_long" | "markup" | "foreign_asset" | "content_limit";

export interface PrivatePagesIssue {
  path: Array<string | number>;
  reason: PrivatePagesReason;
  message: string;
}

/** Text that reads as markup (`<b>`, `</p>`, `<!--`): words here are plain text. */
const MARKUP = /<[A-Za-z!/?]/;
/** Words without direction overrides or invisible characters. */
export function plainPrivateWords(words: PrivateWords): PrivateWords {
  return Object.fromEntries(Object.entries(words).map(([lang, text]) => [lang, withoutHiddenCharacters(text)]));
}

function plainContent(nodes: readonly PrivateNode[]): PrivateNode[] {
  return nodes.map((node): PrivateNode => {
    if (node.type === "layout") return { ...node, children: plainContent(node.children) };
    if (node.type !== "content") return node;
    const content = Object.fromEntries(Object.entries(node.content).map(([field, value]) =>
      [field, field !== "image" && typeof value === "object" && value !== null ? plainPrivateWords(value as PrivateWords) : value])) as PrivateContentBlock;
    return { ...node, content };
  });
}

/** What the stylesheet is checked against: the theme's listed assets. */
export function privateCssContext(value: Pick<StorefrontPrivatePages, "assets">): PrivateCssContext {
  return { assets: new Set(Object.keys(value.assets)) };
}

function wordsIssues(words: PrivateWords | undefined, path: Array<string | number>, max: number): PrivatePagesIssue[] {
  if (!words) return [];
  return Object.entries(words).flatMap(([lang, text]): PrivatePagesIssue[] => {
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

/** What the private pages are checked against besides themselves: the palettes buyers see, and the theme's own app. */
export interface PrivatePagesCompileContext {
  palettes: readonly StorefrontThemeColors[];
  /** The app the theme is a template of: its files are the only ones an asset or icon may name (null: no files). */
  themeApp: string | null;
}

/** The compile context of a theme document: its palettes and the app its look came from. */
export function privatePagesContextOf(theme: {
  tokens: Pick<StorefrontThemeTokens, "colors" | "darkColors" | "colorScheme" | "colorSchemeToggle">;
  apps?: { template?: string } | undefined;
}): PrivatePagesCompileContext {
  return {
    palettes: privatePalettes(theme.tokens, storefrontDarkPalette),
    themeApp: theme.apps?.template ? parsePluginSurfaceKey(theme.apps.template)?.pluginId ?? null : null,
  };
}

/**
 * Checks and compiles `privatePages` as a save or a publish does: every
 * arrangement against its page's anatomy, every token by type and against
 * the contrast floor, every label against its bound, plain text everywhere,
 * files from the theme's own app only, and the stylesheet (checked and
 * scoped to its free regions). Defaults are dropped from the arrangements,
 * so a default page stores nothing. The compiled CSS is the host's token
 * rules, then the stylesheet.
 */
export function compileStorefrontPrivatePages(value: StorefrontPrivatePages, context: PrivatePagesCompileContext): { ok: true; value: StorefrontPrivatePages } | { ok: false; issues: PrivatePagesIssue[] } {
  const issues: PrivatePagesIssue[] = [];
  const pages: StorefrontPrivatePages["pages"] = {};
  for (const page of PRIVATE_PAGE_KEYS) {
    const arrangement = value.pages[page];
    if (!arrangement) continue;
    const base = ["privatePages", "pages", page];
    issues.push(...privateArrangementIssues(page, arrangement).map((issue) => ({ ...issue, path: [...base, ...issue.path] })));
    if (arrangement.layout) issues.push(...contentIssues(arrangement.layout, [...base, "layout"]));
    issues.push(...contentLimitIssues(page, arrangement, base));
    for (const [item, layout] of Object.entries(arrangement.items ?? {})) issues.push(...contentIssues(layout, [...base, "items", item]));
    const compact = compactPrivateArrangement(page, arrangement);
    if (compact) {
      pages[page] = {
        ...compact,
        ...(compact.layout ? { layout: plainContent(compact.layout) } : {}),
        ...(compact.items ? { items: Object.fromEntries(Object.entries(compact.items).map(([item, nodes]) => [item, plainContent(nodes)])) } : {}),
      };
    }
  }
  const files: Array<[Array<string | number>, PrivateAssetRef]> = [
    ...Object.entries(value.assets).map(([key, ref]): [Array<string | number>, PrivateAssetRef] => [["privatePages", "assets", key], ref]),
    ...Object.entries(value.icons).flatMap(([key, ref]): Array<[Array<string | number>, PrivateAssetRef]> => ref ? [[["privatePages", "icons", key], ref]] : []),
    ...Object.entries(value.pages).flatMap(([page, arrangement]) => [
      ...imageRefs(arrangement?.layout ?? [], ["privatePages", "pages", page, "layout"]),
      ...Object.entries(arrangement?.items ?? {}).flatMap(([item, nodes]) => imageRefs(nodes, ["privatePages", "pages", page, "items", item])),
    ]),
  ];
  for (const [path, ref] of files) {
    if (ref.app !== context.themeApp) issues.push({ path, reason: "foreign_asset", message: `${ref.app}/${ref.file}: a private page names only the theme's own files${context.themeApp ? ` (${context.themeApp})` : ""}.` });
  }
  const tokenCss: string[] = [];
  for (const page of PRIVATE_PAGE_KEYS) {
    const tokens = value.tokens[page];
    if (!tokens) continue;
    const arrangement = privatePageArrangement({ ...value, pages, compiled: { ...value.compiled, anatomy: PRIVATE_ANATOMY_VERSION } }, page);
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    const found = privateTokenIssues(page, tokens, {
      layout: arrangement?.layout ?? spec.layout,
      items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, arrangement?.items?.[item] ?? spec.items[item]!.layout])),
      palettes: context.palettes,
    });
    issues.push(...found);
    const unitHooks = new Set<string>();
    const collect = (nodes: readonly PrivateNode[]) => { for (const node of nodes) if (node.type === "layout") { if (node.hook) unitHooks.add(node.hook); collect(node.children); } };
    for (const item of Object.keys(spec.items)) collect(arrangement?.items?.[item] ?? []);
    if (found.length === 0) tokenCss.push(privateTokenCss(page, tokens, unitHooks));
  }
  const bounds = new Map(privateLabelKeys().map((entry) => [entry.key, entry.max]));
  const labels = Object.fromEntries(Object.entries(value.labels).flatMap(([key, words]) => words ? [[key, plainPrivateWords(words)]] : []));
  for (const [key, words] of Object.entries(labels)) issues.push(...wordsIssues(words, ["privatePages", "labels", key], bounds.get(key) ?? 0));
  const css = compilePrivateCss(value.css, privateCssContext(value));
  issues.push(...css.issues.map((issue) => ({ path: ["privatePages", "css"], reason: issue.reason, message: issue.message })));
  if (issues.length > 0) return { ok: false, issues };
  const compiled = `${tokenCss.join("")}${css.css}`;
  if (new TextEncoder().encode(compiled).byteLength > PRIVATE_COMPILED_CSS_MAX_BYTES) {
    return { ok: false, issues: [{ path: ["privatePages", "css"], reason: "too_large", message: `The compiled look is over ${PRIVATE_COMPILED_CSS_MAX_BYTES / 1024} KiB; shorten the stylesheet.` }] };
  }
  return { ok: true, value: { ...value, pages, labels, compiled: { anatomy: PRIVATE_ANATOMY_VERSION, sanitizer: PRIVATE_CSS_SANITIZER_VERSION, css: compiled } } };
}

/**
 * Content blocks may not bury what a buyer must reach: at most
 * PRIVATE_CONTENT_LIMITS.perPage on a page, and at most `beforeLastMandatory`
 * before its last mandatory part in reading order (each at most 30rem tall),
 * at most 2 in a repeated unit.
 */
function contentLimitIssues(page: PrivatePageKey, arrangement: PrivatePageArrangement, base: Array<string | number>): PrivatePagesIssue[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const order: PrivateNode[] = [];
  const flatten = (nodes: readonly PrivateNode[]) => { for (const node of nodes) node.type === "layout" ? flatten(node.children) : order.push(node); };
  flatten(arrangement.layout ?? spec.layout);
  const issues: PrivatePagesIssue[] = [];
  const blocks = order.filter((node) => node.type === "content").length;
  const last = order.reduce((at, node, index) => node.type === "part" && spec.parts[node.part]?.mandatory ? index : at, -1);
  const before = order.slice(0, last).filter((node) => node.type === "content").length;
  if (blocks > PRIVATE_CONTENT_LIMITS.perPage) issues.push({ path: [...base, "layout"], reason: "content_limit", message: `At most ${PRIVATE_CONTENT_LIMITS.perPage} content blocks on a page.` });
  if (before > PRIVATE_CONTENT_LIMITS.beforeLastMandatory) issues.push({ path: [...base, "layout"], reason: "content_limit", message: `At most ${PRIVATE_CONTENT_LIMITS.beforeLastMandatory} content blocks before the page's last part a buyer must reach.` });
  for (const [item, nodes] of Object.entries(arrangement.items ?? {})) {
    const inside: PrivateNode[] = [];
    const walk = (list: readonly PrivateNode[]) => { for (const node of list) node.type === "layout" ? walk(node.children) : inside.push(node); };
    walk(nodes);
    if (inside.filter((node) => node.type === "content").length > 2) issues.push({ path: [...base, "items", item], reason: "content_limit", message: "At most 2 content blocks in a repeated unit." });
  }
  return issues;
}

function imageRefs(nodes: readonly PrivateNode[], path: Array<string | number>): Array<[Array<string | number>, PrivateAssetRef]> {
  return nodes.flatMap((node, index): Array<[Array<string | number>, PrivateAssetRef]> => {
    if (node.type === "layout") return imageRefs(node.children, [...path, index, "children"]);
    return node.type === "content" && node.content.kind === "image" ? [[[...path, index, "content", "image"], node.content.image]] : [];
  });
}

/** Whether `compiled` was written by this build's checker and anatomy (else maintenance compiles it again). */
export function privatePagesCompiledCurrent(privatePages: Pick<StorefrontPrivatePages, "compiled">): boolean {
  return privatePages.compiled.sanitizer === PRIVATE_CSS_SANITIZER_VERSION;
}

// ─── Reading on the page ──────────────────────────────────────────────────

/** A page's arrangement as this build draws it: as stored when it was checked against this anatomy, else filled in. */
export function privatePageArrangement(privatePages: StorefrontPrivatePages, page: PrivatePageKey): PrivatePageArrangement | undefined {
  const arrangement = privatePages.pages[page];
  if (!arrangement) return undefined;
  return privatePages.compiled.anatomy === PRIVATE_ANATOMY_VERSION ? arrangement : fillPrivateArrangement(page, arrangement);
}

/**
 * The look a page may serve (token rules and the stylesheet): the stored
 * one when this build's checker compiled it, else none (the default look)
 * until the store compiles it again. A buyer's request never compiles.
 */
export function privatePagesCss(privatePages: Pick<StorefrontPrivatePages, "compiled">): string {
  return privatePagesCompiledCurrent(privatePages) ? privatePages.compiled.css : "";
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
