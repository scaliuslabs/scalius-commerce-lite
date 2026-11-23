// Known-bad changes the private pages' rendered gate must catch
// (private-pages.properties.browser.mjs `--mutations`). Each rewrites one
// source file as the test gallery's Vite serves it (SCALIUS_GALLERY_MUTATION,
// read only by apps/storefront/scripts/gallery-server.mjs, which refuses to run
// in production): the store's code is never changed and no production path
// reads the variable. A mutation whose text is no longer in its file fails the
// run (it would test nothing), so the list stays true to the code.
//
// `cases` are the named cases (REGRESSIONS) that must fail under it.

import { readFileSync } from "node:fs";

/** One rewrite: `find` must occur exactly once in the file. */
const rewrite = (file, find, replace) => ({ file, find, replace });

const TOKENS = "packages/shared/src/storefront-theme/private-tokens.ts";
const PLAN = "apps/storefront/src/lib/private-pages/plan.ts";
const MARKUP = "apps/storefront/src/components/private/PrivateMarkup.astro";
const SEAL = "overflow:hidden;overflow:clip;contain:layout paint style;";
const ROW = "export function privateRowDeclarations(row: PrivateTokenRow, parent: PrivateTokenRow | null, also: ReadonlySet<string> = NONE): string {\n";
/** A row of the table that writes only its paint: its words keep whatever colour reaches them. */
const paintOnly = (test) => rewrite(TOKENS, ROW, `${ROW}  if (${test}) return row.paint ? \`background-color:\${row.paint}\` : "";\n`);

const B1 = "review 4, B1: tokens only, a dark lines panel over the default arrangement's summary";
const B2 = "review 4, B2: an app's warning and success badges under a dark line";
const B3 = "review 4, B3: the sign-in dialog under dark dialog tokens";
const B4 = "review 4, B4: tokens only, a dark details form in every state";
const S3 = "review 4, S3: the theme's header styling the store's search from its region";
const S6 = "review 4, S6: Place order's focus ring on a dark form";
const S8 = "review 4, S8: a 40px wide-tracked title clamped to two lines";
const KINDS = "review 4: every node kind under a dark summary and a dark line, in every state";
const WIDE = "review 3: a block widens the page";
const COVERS = "review 2: shadows, outlines and covers from a block";
const COLUMNS = "review 3: two 480px columns on a phone";
const HEADER = "the store's own header under dark tokens";

export const MUTATIONS = {
  // The reviews' fixes, each reverted: its named case must fail again.
  "B1 token mode draws the host's own page": {
    why: "the default arrangement's tokens drawn on the host's page, whose summary sits in the lines panel",
    rewrites: [rewrite(PLAN, "layout: tokens ? [...arrangement?.layout ?? spec.layout] : privateLayoutIsDefault", "layout: privateLayoutIsDefault")],
    cases: [B1],
  },
  // Three guards each keep an app's node readable in a dark line: its own rows (which write its colours), the
  // words inheriting their row's colour, and the palette classes reading the nearest row. Before the fix it had none.
  "B2 an app's nodes have no rows and keep the palette's words": {
    why: "no row for an app's node kinds and tones, no inherited words, and text-foreground keeps the palette's colour: dark words in a dark line",
    rewrites: [
      rewrite(TOKENS, "        ui([node.target], parent);\n", "\n"),
      rewrite(TOKENS, "{color:inherit;--focus-ring-color:var(--pt-r)}", "{--focus-ring-color:var(--pt-r)}"),
      rewrite(TOKENS, '...["text-foreground", "text-card-foreground", "text-primary-foreground"].map(', '...["text-card-foreground", "text-primary-foreground"].map('),
    ],
    cases: [B2],
  },
  "B3 the dialogs read the store's palette": {
    why: "token mode does not reach the store's dialogs: their palette classes keep the palette's colours",
    rewrites: [rewrite(TOKENS, `const TOKEN_SCOPE = ['[data-private="cart"]', '[data-private="dialog"]', `, "const TOKEN_SCOPE = ['[data-private=\"cart\"]', ")],
    cases: [B3],
  },
  "B4 (M1) the details form's row writes only its background": {
    why: "the table's CSS paints the details form and drops its words' colours",
    rewrites: [paintOnly('row.key === "details-form"')],
    cases: [B4],
  },
  "M1 the lines' and the apps' rows write only their background": {
    why: "the table's CSS paints a dark panel and an app's nodes and drops their words' colours",
    rewrites: [paintOnly('row.key === "lines" || row.key.startsWith("ui.")')],
    cases: [B1, B2],
  },
  // Paint containment clips too: without overflow clipping alone the seal still holds, so this takes both.
  "M2 the seal clips nothing": {
    why: "the free-region seal loses overflow:hidden, overflow:clip and paint containment",
    rewrites: [rewrite(PLAN, SEAL, "contain:layout style;")],
    cases: [COVERS, WIDE],
  },
  "M4 the stylesheet may select a host part": {
    why: "the compiler stops refusing [data-part=…] selectors (scoping off)",
    rewrites: [rewrite("packages/shared/src/storefront-theme/private-css.ts", "  if (attr.op !== \"=\") return null;\n", "  if (attr.op !== \"=\") return null;\n  if (attr.name === \"data-part\") return `[data-part=\"${attr.value}\"]`;\n")],
    cases: ["a stylesheet hiding a host part"],
    // The drawing must fail, not only the refusal.
    expect: /not visible|missing|reads [\d.]+:1/,
  },
  // The gate's own.
  "M5 the host's search inside the theme's region": {
    why: "the header draws the store's search inside the theme's sealed region, where its stylesheet reaches",
    rewrites: [rewrite("apps/storefront/src/components/header/header.astro", "<PrivateMarkup markup={privateMarkup} /></div>{privateSearch?.place === \"after\" && <PrivateSearch {...privateSearch.form} />}", "<PrivateMarkup markup={privateMarkup} />{privateSearch?.place === \"after\" && <PrivateSearch {...privateSearch.form} />}</div>")],
    cases: [S3],
    expect: /\[data-free="header"\] <(?:form|input|button)[ >]/,
  },
  "R5-B2 the skin's slots draw the store's controls inside its region": {
    why: "the theme's header and footer draw their slots on a private page: the scheme switch and the market and language forms sit inside the regions",
    rewrites: [
      rewrite(MARKUP, "const { markup } = Astro.props;\n---\n\n{markup.parts.map((part) => part.kind === \"html\" && <Fragment set:html={part.html} />)}",
        "const { markup, embeds = {} } = Astro.props as { markup: AppMarkup; embeds?: import(\"@/lib/extensions/embeds\").EmbedRenderers };\n"
        + "type AnyComponent = (props: Record<string, unknown>) => unknown;\n"
        + "const parts = markup.parts.map((part) => part.kind === \"html\" ? part : { kind: \"embed\" as const, rendered: embeds[part.embed]?.({ data: part.data, index: part.index }) ?? null, embed: part.embed });\n---\n\n"
        + "{parts.map((part) => part.kind === \"html\" ? <Fragment set:html={part.html} /> : part.rendered && (() => { const Embed = part.rendered.component as unknown as AnyComponent; return <div class=\"contents\" data-sx-embed={part.embed}><Embed {...part.rendered.props} /></div>; })())}"),
      rewrite("apps/storefront/src/components/header/header.astro", "<div data-free=\"header\"><PrivateMarkup markup={privateMarkup} /></div>", "<div data-free=\"header\"><PrivateMarkup markup={privateMarkup} embeds={embeds} /></div>"),
      rewrite("apps/storefront/src/components/Footer.astro", "<div data-free=\"footer\"><PrivateMarkup markup={privateMarkup} /></div>", "<div data-free=\"footer\"><PrivateMarkup markup={privateMarkup} embeds={embeds} /></div>"),
    ],
    cases: ["review 5, B2: the theme's header and footer in a store with a scheme switch and two markets"],
    expect: /\[data-free="(?:header|footer)"\] <(?:div data-sx-embed|form|select|button data-sx-host-color-scheme-toggle)>/,
  },
  "M6 the save skips one row's contrast": {
    why: "the table's check skips the summary rows, so unreadable rows are saved",
    rewrites: [rewrite(TOKENS, "if (ratio >= pair.floor) continue;", "if (ratio >= pair.floor || pair.key === \"summary-rows\") continue;")],
    cases: ["summary rows that do not read on their summary"],
    expect: /reads [\d.]+:1 on what is behind it/,
  },
  "M7 no surface reset": {
    why: "token mode no longer makes the store's palette surfaces transparent (a tint paints inside a dark panel)",
    rewrites: [rewrite(PLAN, '${tokens ? PRIVATE_TOKEN_MODE_CSS.before : ""}', "")],
    cases: [KINDS],
  },
  "M8 the store's own header outside token mode": {
    why: "the store's header paints its row's dark surface while its words keep the palette's dark colours",
    rewrites: [rewrite(TOKENS, `, '[data-host="search"]', '[data-private="core-header"]'];`, `, '[data-host="search"]'];`)],
    cases: [HEADER],
  },
  "M9 every nested row leaves out what its parent has": {
    why: "Place order inherits its form's words' colour, but it is also a filled button whose row sets its own",
    rewrites: [rewrite(TOKENS, 'const inherited = row.nested && (row.kind === "box" || row.kind === "text") && !row.key.startsWith("ui.") ? parent : null;', "const inherited = row.nested ? parent : null;")],
    cases: [S6],
  },
  "M10 a title's clamp on its heading": {
    why: "the line title's heading clips its link's focus ring",
    rewrites: [rewrite("apps/storefront/src/lib/cart/line-html.ts", '<h3 class="text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="line-clamp-2 break-words', '<h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="break-words')],
    cases: [B4],
  },
  "M11 text sizes follow the screen": {
    why: "a 40px wide-tracked title takes 8% of the screen, not of its line: its first word overflows its column",
    rewrites: [rewrite(TOKENS, "font-size:min(${value}px,max(12px,7cqi))", "font-size:min(${value}px,max(12px,8vw))"), rewrite("apps/storefront/src/lib/cart/line-html.ts", "line-clamp-2 break-words", "line-clamp-2")],
    cases: [S8],
  },
  "M12 grid columns at their declared width": {
    why: "a layout node's columns apply whatever the box holding it measures",
    rewrites: [rewrite(TOKENS, "narrow.push(`:where(${root} :has(> ${selector.slice(root.length + 1)})){container-type:inline-size}@container (min-width:${fit}px){${rule}}`);", "narrow.push(rule);")],
    cases: [COLUMNS],
  },
  // S10: `contain: inline-size` once sat in the seal; without it no case failed, so it is gone. What keeps a
  // block from widening its column is this pair.
  "S10 the seal without its width bounds": {
    why: "the free-region seal loses min-inline-size:0 and max-inline-size:100%",
    rewrites: [rewrite(PLAN, "min-inline-size:0;max-inline-size:100%;", "")],
    cases: [WIDE],
  },
  "P1 the page row ignores the theme's page paint": {
    why: "the table checks the page's words on its page colour while the body shows the theme's gradient",
    rewrites: [rewrite(TOKENS, "} else if (place.parent === null && palette.pagePaint) {", "} else if (false) {")],
    cases: ["page words that do not read on the theme's page paint", "a dark page paint under dark tokens"],
  },
  "T1 a dark row leaves out a cell its light row writes": {
    why: "the dark lines panel leaves its ring to its parent's, so the light panel's dark ring shows on it",
    rewrites: [rewrite(TOKENS, "(row[cell] !== inherited?.[cell] || also.has(property))", "row[cell] !== inherited?.[cell]")],
    cases: ["a dark page under the dark colours"],
  },
  "C1 the theme's chrome with no header draws the store's full header": {
    why: "a theme chrome with no header skin draws the public header, whose surfaces and words no row of the table knows",
    rewrites: [rewrite("apps/storefront/src/components/header/header.astro", '<slot name="private-fallback" />', "<CoreHeader {...props} />")],
    cases: ["the theme's chrome with no header skin, under a dark page"],
  },
  "U1 the details form's app targets have no rows": {
    why: "an app's blocks inside the details form read the form's row only: a theme's ui.* tokens for them style nothing the table checks",
    rewrites: [rewrite(TOKENS, "    if (targets.length > 0) ui(targets, key);\n", "")],
    cases: ["the apps' blocks in a dark details form, styled by target"],
  },
  "H1 token mode paints no hover": {
    why: "a hover surface paints nothing in token mode: a control the host gives a hover shows none under the pointer",
    rewrites: [rewrite(TOKENS, '.map((name) => [name, ["background-color:var(--pt-h)", ":hover"]] as const),', '.map((name) => [name, ["background-color:transparent"]] as const),')],
    cases: [B1],
    expect: /shows no hover/,
  },
  "R5-B1 the seal follows the theme's look": {
    why: "the layout seals the free regions only when the theme compiled a look: its chrome and blocks with none draw unsealed",
    rewrites: [rewrite(PLAN, '  return served.chrome === "theme" || PRIVATE_PAGE_KEYS.some((page) => {', '  return Boolean(privatePagesCss(theme.privatePages)) && PRIVATE_PAGE_KEYS.some((page) => {')],
    cases: ["review 5, B1: the theme's chrome and a 2000px image block with no look of its own"],
    expect: /not sealed/,
  },
  "R5-S4 the page paint behind the default look": {
    why: "a cart whose look this build has not compiled serves the default look on the theme's page paint, which no table checked",
    rewrites: [rewrite("apps/storefront/src/layouts/Layout.astro", "themePaint(privateStyle !== undefined && !privateTokens ? { ...storefrontTheme, tokens: unpaintedTokens } : storefrontTheme, resolvedTheme)", "themePaint(storefrontTheme, resolvedTheme)")],
    cases: ["review 5, S4: a page paint behind a look this build has not compiled"],
    expect: /shows a paint of its own/,
  },
  "P2 a page paint with no tokens draws the store's own page": {
    why: "the theme's page paint shows behind the default look, whose rows no table checks on it",
    rewrites: [rewrite("packages/shared/src/storefront-theme/private-layout.ts", "painted && privatePageHasOwnPage(page) ? {} : null", "null")],
    cases: ["a dark page paint, no private tokens"],
  },
};

/**
 * The gallery's side of a mutation: a Vite plugin applying its rewrites to
 * the modules it serves, and which files it rewrote and which it could not
 * (the gate asks, and a mutation that tests nothing fails the run).
 */
export function galleryMutation(name) {
  const mutation = MUTATIONS[name];
  if (!mutation) throw new Error(`Unknown mutation ${name}: one of ${Object.keys(MUTATIONS).join(", ")}.`);
  const applied = new Set();
  const missed = new Set();
  // The source is rewritten as it is read from disk, before any compiler (TypeScript, Astro) sees it.
  const plugin = {
    name: "private-pages-gate-mutation",
    enforce: "pre",
    load(id) {
      if (id.includes("?")) return undefined;
      const rewrites = mutation.rewrites.filter(({ file }) => id.endsWith(file));
      if (rewrites.length === 0) return undefined;
      let code = readFileSync(id, "utf8");
      for (const { file, find, replace } of rewrites) {
        const at = code.indexOf(find);
        if (at < 0 || code.indexOf(find, at + find.length) >= 0) { missed.add(file); continue; }
        code = code.slice(0, at) + replace + code.slice(at + find.length);
        applied.add(file);
      }
      return code;
    },
  };
  return { name, plugin, applied, missed, files: [...new Set(mutation.rewrites.map((each) => each.file))], compile: mutation.compile };
}

/** Each rewrite's text is in its file exactly once (checked without a browser). */
export async function mutationsHold(read) {
  const problems = [];
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    for (const { file, find } of mutation.rewrites) {
      const source = await read(file);
      const at = source.indexOf(find);
      if (at < 0 || source.indexOf(find, at + find.length) >= 0) problems.push(`${name}: ${file} does not hold its text exactly once`);
    }
  }
  return problems;
}
