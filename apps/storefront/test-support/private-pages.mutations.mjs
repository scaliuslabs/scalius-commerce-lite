// Known-bad changes the private pages' rendered gate must catch
// (private-pages.properties.browser.mjs `--mutations`). Each rewrites one
// source file as the test gallery's Vite serves it (SCALIUS_GALLERY_MUTATION,
// read only by apps/storefront/scripts/gallery-server.mjs, which refuses to run
// in production): the store's code is never changed and no production path
// reads the variable. A mutation whose text is no longer in its file fails the
// run (it would test nothing), so the list stays true to the code.
//
// `cases` are the named cases (REGRESSIONS) that must fail under it, and `expect`
// the check that must fail: one of the problems the failing draws report must
// match it (a mutation caught by some other failure is not caught).

import { readFileSync } from "node:fs";

/** One rewrite: `find` must occur exactly once in the file. */
const rewrite = (file, find, replace) => ({ file, find, replace });

const TOKENS = "packages/shared/src/storefront-theme/private-tokens.ts";
const PLAN = "apps/storefront/src/lib/private-pages/plan.ts";
const ROW = "export function privateRowDeclarations(row: PrivateTokenRow, parent: PrivateTokenRow | null, also: ReadonlySet<string> = NONE): string {\n";
/** A row of the table that writes only its paint: its words keep whatever colour reaches them. */
const paintOnly = (test) => rewrite(TOKENS, ROW, `${ROW}  if (${test}) return row.paint ? \`background-color:\${row.paint}\` : "";\n`);

const B1 = "review 4, B1: tokens only, a dark lines panel over the default arrangement's summary";
const B2 = "review 4, B2: an app's warning and success badges under a dark line";
const B3 = "review 4, B3: the sign-in dialog under dark dialog tokens";
const B4 = "review 4, B4: tokens only, a dark details form in every state";
const S6 = "review 4, S6: Place order's focus ring on a dark form";
const S8 = "review 4, S8: a 40px wide-tracked title clamped to two lines";
const KINDS = "review 4: every node kind under a dark summary and a dark line, in every state";
const COLUMNS = "review 3: two 480px columns on a phone";
const HEADER = "the store's own header under dark tokens";
const DEPTH = "review 6, B3: the cart unfolded, progress first, at its largest lines";
const PROTECTED = "the customer's cart, protected";

export const MUTATIONS = {
  // The reviews' fixes, each reverted: its named case must fail again.
  "B1 token mode draws the host's own page": {
    why: "the default arrangement's tokens drawn on the host's page, whose summary sits in the lines panel",
    rewrites: [rewrite(PLAN, "const layout = tokens ? [...arrangement?.layout ?? spec.layout] : privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!;", "const layout = privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!;")],
    cases: [B1],
    expect: /reads [\d.]+:1 on what is behind it/,
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
    expect: /an app's node at cart\.line\.after has no row of its own/,
  },
  "B3 the dialogs read the store's palette": {
    why: "token mode does not reach the store's dialogs: their palette classes keep the palette's colours",
    rewrites: [rewrite(TOKENS, `const TOKEN_SCOPE = ['[data-private="cart"]', '[data-private="dialog"]', `, "const TOKEN_SCOPE = ['[data-private=\"cart\"]', ")],
    cases: [B3],
    expect: /^sign-in: .*(?:is none of its row's colours \(dialog|reads [\d.]+:1 on what is behind it)/,
  },
  "B4 (M1) the details form's row writes only its background": {
    why: "the table's CSS paints the details form and drops its words' colours",
    rewrites: [paintOnly('row.key === "details-form"')],
    cases: [B4],
    expect: /reads [\d.]+:1 on what is behind it/,
  },
  "M1 the lines' and the apps' rows write only their background": {
    why: "the table's CSS paints a dark panel and an app's nodes and drops their words' colours",
    rewrites: [paintOnly('row.key === "lines" || row.key.startsWith("ui.")')],
    cases: [B1, B2],
    expect: /is none of its row's colours/,
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
    // The coverage walk's surface check: a palette tint where the table knows none, under words or on a row's own box.
    expect: /paints .*(?:no row of the table claims|where its row \(.*\) paints nothing)/,
  },
  "M8 the store's own chrome outside token mode": {
    why: "the store's header paints its row's dark surface while its words keep the palette's dark colours",
    rewrites: [rewrite(TOKENS, `const TOKEN_SCOPE = ['[data-private="cart"]', '[data-private="dialog"]', '[data-private="core-header"]', '[data-private="core-footer"]'];`, `const TOKEN_SCOPE = ['[data-private="cart"]', '[data-private="dialog"]'];`)],
    cases: [HEADER],
    expect: /is none of its row's colours \(chrome:/,
  },
  "M9 every nested row leaves out what its parent has": {
    why: "Place order inherits its dock's words' colour, but it is also a filled button whose row sets its own",
    rewrites: [rewrite(TOKENS, 'const inherited = row.nested && (row.kind === "box" || row.kind === "text") && !row.key.startsWith("ui.") ? parent : null;', "const inherited = row.nested ? parent : null;")],
    cases: [S6],
    // Its words take the dock's colour, not its own row's: the walk sees it, and the pixels where that colour does not read.
    expect: /"Place order" .*(?:reads [\d.]+:1|is none of its row's colours \(submit)/,
  },
  "M10 a title's clamp on its heading": {
    why: "the line title's heading clips its link's focus ring",
    rewrites: [rewrite("apps/storefront/src/lib/cart/line-html.ts", '<h3 class="text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="line-clamp-2 break-words', '<h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="break-words')],
    cases: [B4],
    expect: /\[data-part=line-title\]>a: its focus ring reads at/,
  },
  "M11 text sizes follow the screen": {
    why: "a 40px wide-tracked title takes 8% of the screen, not of its line: its first word overflows its column",
    rewrites: [rewrite(TOKENS, "font-size:min(${value}px,max(12px,7cqi))", "font-size:min(${value}px,max(12px,8vw))"), rewrite("apps/storefront/src/lib/cart/line-html.ts", "line-clamp-2 break-words", "line-clamp-2")],
    cases: [S8],
    expect: /cut sideways|is cut off at the side/,
  },
  "M12 grid columns at their declared width": {
    why: "a layout node's columns apply whatever the box holding it measures",
    rewrites: [rewrite(TOKENS, "narrow.push(`:where(${root} :has(> ${selector.slice(root.length + 1)})){container-type:inline-size}@container (min-width:${fit}px){${rule}}`);", "narrow.push(rule);")],
    cases: [COLUMNS],
    expect: /outside the viewport/,
  },
  "P1 the page row ignores the theme's page paint": {
    why: "the table checks the page's words on its page colour while the body shows the theme's gradient",
    rewrites: [rewrite(TOKENS, "} else if (place.parent === null && palette.pagePaint) {", "} else if (false) {")],
    cases: ["page words that do not read on the theme's page paint", "a dark page paint under dark tokens"],
    expect: /paints an image its row \(page\) does not|it must be refused \(contrast\)/,
  },
  "T1 a dark row leaves out a cell its light row writes": {
    why: "the dark lines panel leaves its ring to its parent's, so the light panel's dark ring shows on it",
    rewrites: [rewrite(TOKENS, "(row[cell] !== inherited?.[cell] || also.has(property))", "row[cell] !== inherited?.[cell]")],
    cases: ["a dark page under the dark colours"],
    expect: /its focus ring reads at/,
  },
  "U1 the details form's app targets have no rows": {
    why: "an app's blocks inside the details form read the form's row only: a theme's ui.* tokens for them style nothing the table checks",
    rewrites: [rewrite(TOKENS, "    if (targets.length > 0) ui(targets, key);\n", "")],
    cases: ["the apps' blocks in a dark details form, styled by target"],
    expect: /an app's node at checkout\.(?:contact|delivery)\.after has no row of its own/,
  },
  "H1 token mode paints no hover": {
    why: "a hover surface paints nothing in token mode: a control the host gives a hover shows none under the pointer",
    rewrites: [rewrite(TOKENS, '.map((name) => [name, ["background-color:var(--pt-h)", ":hover"]] as const),', '.map((name) => [name, ["background-color:transparent"]] as const),')],
    cases: [B1],
    expect: /shows no hover/,
  },
  "R5-S4 the page paint behind the default look": {
    why: "a cart whose look this build has not compiled serves the default look on the theme's page paint, which no table checked",
    rewrites: [rewrite("apps/storefront/src/layouts/Layout.astro", "themePaint(privateStyle !== undefined && !privateTokens ? { ...storefrontTheme, tokens: unpaintedTokens } : storefrontTheme, resolvedTheme)", "themePaint(storefrontTheme, resolvedTheme)")],
    cases: ["review 5, S4: a page paint behind a look this build has not compiled"],
    expect: /shows a paint of its own/,
  },
  "R5-S6 the public header and its phone tab bar on a private page": {
    why: "a private page draws the public header too, and with it the theme's phone tab bar: surfaces and words no row of the table knows",
    rewrites: [rewrite("apps/storefront/src/layouts/Layout.astro", "        !hideHeader && (\n          <Header", "        (!hideHeader || privateHeader !== undefined) && (\n          <Header")],
    cases: ["review 5, S6: the phone tab bar setting, under a dark page"],
    expect: /paints .* no row of the table claims that surface/,
  },
  "R5-A3 the dark colours' ring is the action colour": {
    why: "the colours' focus ring is the action colour, which shows under 3:1 on a focused field's own border",
    rewrites: [rewrite("packages/shared/src/storefront-theme/tokens.ts", "    ring: storefrontThemeFocusRing(colors),\n", "    ring: colors.primary,\n")],
    cases: ["review 5: the store's own page under the marketplace palette's dark colours"],
    expect: /input#\w+: its focus ring reads at 3:1 on/,
  },
  "R6-S1 a saved colour set serves its stored ring": {
    why: "the store serves the focus ring a colour set was saved with (the action colour), not the one made from its colours",
    rewrites: [
      rewrite("packages/shared/src/storefront-theme/tokens.ts", "    ring: storefrontThemeFocusRing(colors),\n", "    ring: (colors as { ring?: string }).ring ?? storefrontThemeFocusRing(colors),\n"),
      rewrite("packages/shared/src/storefront-theme/upgrade.ts", "  14: (document) => unstoredFocusRing(privatePageLayouts(document)),", "  14: privatePageLayouts,"),
      rewrite("packages/shared/src/storefront-theme/tokens.ts", "  Object.fromEntries(STOREFRONT_THEME_COLOR_KEYS.map((key) => [key, hexColorSchema]))", "  { ...Object.fromEntries(STOREFRONT_THEME_COLOR_KEYS.map((key) => [key, hexColorSchema])), ring: hexColorSchema.optional() }"),
    ],
    cases: ["review 6, S1: a colour set saved with the action colour as its ring, dark"],
    expect: /input#\w+: its focus ring reads at 3:1 on/,
  },
  "R5-A4 a filled button's hover is its colour over the page": {
    why: "the default look's filled-button hover mixes the action colour with the page, as bg-primary/90 did: white words read 4.42:1 on it",
    rewrites: [rewrite("packages/shared/src/storefront-theme/tokens.ts", '"primary-hover": storefrontThemeHoverSurface([colors.primary], [colors["primary-foreground"]]),', '"primary-hover": storefrontThemeMix(colors.primary, colors.background, 0.1),')],
    cases: ["review 5: the store's own page under the marketplace palette's light colours"],
    expect: /hovered: .* reads [\d.]+:1 on what is behind it/,
  },
  "R6-B3a Place order is not docked": {
    why: "Place order stays at the end of the cart: on a phone with many large lines it is screens away",
    rewrites: [rewrite("apps/storefront/src/pages/cart.astro", 'class="sticky bottom-0 z-20 mt-4 hidden', 'class="relative z-20 mt-4 hidden')],
    cases: [DEPTH],
    expect: /^dock: scroll 0: Place order is not on screen/,
  },
  "P2 a page paint with no tokens draws the store's own page": {
    why: "the theme's page paint shows behind the default look, whose rows no table checks on it",
    // With the layout's guard too (review 5, S4), which draws no paint on a cart not in token mode.
    rewrites: [
      rewrite("packages/shared/src/storefront-theme/private-layout.ts", "painted && privatePageHasOwnPage(page) ? {} : null", "null"),
      rewrite("apps/storefront/src/layouts/Layout.astro", "themePaint(privateStyle !== undefined && !privateTokens ? { ...storefrontTheme, tokens: unpaintedTokens } : storefrontTheme, resolvedTheme)", "themePaint(storefrontTheme, resolvedTheme)"),
    ],
    cases: ["a dark page paint, no private tokens"],
    expect: /shows a paint of its own/,
  },
  // This release's model.
  "S1 per-scheme contrast checked in one palette only": {
    why: "the save checks the light colours' table only: a per-scheme colour unreadable in the dark is saved and drawn",
    rewrites: [rewrite(TOKENS, "  for (const table of tables) {\n    const byKey = new Map(table.rows.map((row) => [row.key, row]));\n    for (const pair of privateTablePairs(table)) {", "  for (const table of tables.slice(0, 1)) {\n    const byKey = new Map(table.rows.map((row) => [row.key, row]));\n    for (const pair of privateTablePairs(table)) {")],
    cases: ["per-scheme words that do not read in the dark"],
    expect: /reads [\d.]+:1 on what is behind it/,
  },
  "N1 container nesting off": {
    why: "an app's box that paints holds no rows of its own: a button inside the amber box is checked on the line beneath it",
    rewrites: [rewrite(TOKENS, "      if (!box.style.container || !paints(box.place.sources)) continue;", "      continue;")],
    cases: ["an app's button with white words in a light amber box on a dark line"],
    expect: /"Add now" .*reads [\d.]+:1 on what is behind it/,
  },
  "A1 the add-on bar's row missing from the table": {
    why: "the summary's add-on bar (its <summary>) has no row, and the save's no_row guard is off: it reads the summary rows' row",
    rewrites: [
      rewrite(TOKENS, "      place(name, style, out ? beside! : key);\n", "      if (name === \"summary-add-on\") continue;\n      place(name, style, out ? beside! : key);\n"),
      rewrite(TOKENS, "    if (keys.has(name) || (style.element", "    if (name === \"summary-add-on\" || keys.has(name) || (style.element"),
    ],
    cases: [PROTECTED],
    expect: /the style target summary-add-on names it and no row of the table is its/,
  },
  "PR1 prominence off": {
    why: "the save stops ranking by size and weight: a 12px total under 18px rows, and a 40px label over a 20px amount, are saved and drawn",
    rewrites: [rewrite(TOKENS, "  issues.push(...prominenceIssues(page, valid));\n", "")],
    cases: ["a total drawn smaller than its rows", "a total's label drawn over its amount"],
    expect: /prominence: the total's .* is drawn at [\d.]+px, under (?:the row|its label)/,
  },
  "PR2 the total ranked by size only": {
    why: "the save stops ranking the total by weight and by how strongly its words read: a muted 400 total under rows in the words' colour is saved and drawn",
    rewrites: [
      rewrite(TOKENS, '        if (by === "contrast") continue;\n', '        if (by !== "size") continue;\n'),
      rewrite(TOKENS, '      if (!ranks.includes("contrast")) continue;\n', "      continue;\n"),
    ],
    cases: ["a total drawn lighter and fainter than its rows"],
    expect: /prominence: the total's .* (?:is drawn at weight \d+, under the row|reads [\d.]+:1, under the row)/,
  },
  "PR3 Confirm unranked": {
    why: "the save stops ranking Confirm over Go back: a 12px light Confirm beside a bold Go back is saved and drawn",
    rewrites: [rewrite(TOKENS, "      for (const by of ranks) {\n", '      for (const by of name === "dialog-confirm" ? [] : ranks) {\n')],
    cases: ["Confirm smaller and lighter than Go back"],
    expect: /Confirm is drawn at (?:[\d.]+px|weight \d+), under Go back/,
  },
  "F1 a filled button's fill unchecked": {
    why: "the save stops reading Place order's and Confirm's fill on what is around them: a Place order or a Confirm the colour of its box is saved and drawn as plain words",
    rewrites: [rewrite(TOKENS, '    if (row.boundary === "fill" || (row.boundary === "edge" && !row.bordered)) {\n', '    if (row.boundary === "edge" && !row.bordered) {\n')],
    cases: ["Place order drawn as plain words", "Confirm drawn as Go back"],
    expect: /(?:Place order|Confirm): its fill reads [\d.]+:1 on what is behind it/,
  },
  "E1 an edge read by its border whether drawn or not": {
    why: "the save reads a field's and the stepper's border even where border-width 0 draws none, and never their fill: a borderless field the colour of its form is saved",
    rewrites: [
      rewrite(TOKENS, '    if (row.boundary === "edge" && row.bordered) add(', '    if (row.boundary === "edge") add('),
      rewrite(TOKENS, '    if (row.boundary === "fill" || (row.boundary === "edge" && !row.bordered)) {\n', '    if (row.boundary === "fill") {\n'),
    ],
    cases: ["a borderless field the colour of its card form", "a borderless stepper on its line"],
    expect: /its fill, with no border drawn, reads [\d.]+:1 on what is behind it/,
  },
  "D1 Go back takes a fill": {
    why: "Go back takes a background token again: filled with the action colour it reads as Confirm",
    rewrites: [rewrite("packages/shared/src/storefront-theme/private-anatomy.ts", 'tokens: ["text", "border", "border-width", "radius", "ring", "inset", "weight"], kind: "control", surface: "under", ink: "foreground", on: "dialog", boundary: "edge"', 'tokens: ["background", "text", "border", "border-width", "radius", "ring", "inset", "weight"], kind: "control", surface: "under", ink: "foreground", on: "dialog", boundary: "edge"')],
    cases: ["Go back filled as Confirm"],
    expect: /Go back paints a fill of its own/,
  },
  "C1 the checkout header draws the switch wherever the controls are placed": {
    why: "the store's checkout header draws its light or dark switch even where the theme places the controls nowhere",
    rewrites: [rewrite("apps/storefront/src/components/CheckoutHeader.astro", "{controls && <PrivateSchemeSwitch />}", "<PrivateSchemeSwitch />")],
    cases: ["no store controls on the page, under dark tokens"],
    expect: /\[data-host="scheme"\] button: drawn in the checkout header where the theme places the controls nowhere/,
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

/** Each mutation names the check it must fail, and each rewrite's text is in its file exactly once (checked without a browser). */
export async function mutationsHold(read) {
  const problems = [];
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    if (!(mutation.expect instanceof RegExp)) problems.push(`${name}: names no check that must fail (expect)`);
    for (const { file, find } of mutation.rewrites) {
      const source = await read(file);
      const at = source.indexOf(find);
      if (at < 0 || source.indexOf(find, at + find.length) >= 0) problems.push(`${name}: ${file} does not hold its text exactly once`);
    }
  }
  return problems;
}
