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
//
// A rule of the store's stylesheet is undone by `css` instead (Tailwind reads the
// stylesheet's imports from disk, past Vite's module hooks): the gallery draws it
// after the store's sheets, and `undoes` names the source text it takes back,
// which must be in its file exactly once, as a rewrite's must.

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
const S8 = "review 4, S8: a 40px wide-tracked title clamped to two lines";
const KINDS = "review 4: every node kind under a dark summary and a dark line, in every state";
const COLUMNS = "review 3: two 480px columns on a phone";
const HEADER = "the store's own header under dark tokens";
const DEPTH = "review 6, B3: the cart unfolded, progress first, at its largest lines";
const PROTECTED = "the customer's cart, protected";
// rc-gate-hygiene's cases (private-pages.properties.browser.mjs `HYGIENE_CASES`).
const WORDS_APART = "Place order's words apart from its dock's";
const SQUARE_ACTIONS = "a theme's square corners on the filled buttons, over the store's rounded button shape";
const DIALOG_WORDS = "the theme's words in both confirmation dialogs";
const EMPTY_LAZY = "an empty cart whose lazy file does not load";
const YELLOW_ACTION = "a yellow action row beside Place order and Confirm in their own look";
const EDGED_BESIDE = "an edged Place order beside an action row with no border";
const DRAWER_BELOW = "the customer's offered cart in the drawer: a line's app block under the line";
const SQUARE_PAYMENT = "a theme of square buttons on soft surfaces: the payment step in the customer's look";
const SQUARE_CART = "a square theme: every button and field of the cart";
const ANATOMY = "packages/shared/src/storefront-theme/private-anatomy.ts";
const DIALOG = "apps/storefront/src/lib/cart/confirm-dialog.ts";
const FOUNDATION = "apps/storefront/src/styles/theme-foundation.css";

const CART = "apps/storefront/src/pages/cart.astro";
const CART_ROOT = '    data-private="cart"\n  >\n';

// ─── The payment step's mutations (page `checkout`) ───
const STEP = "apps/storefront/src/components/checkout/CheckoutPaymentStep.astro";
const CHECKOUT_SCRIPT = "apps/storefront/src/lib/checkout/index.ts";
const CHECKOUT_LIST = "payment step: the reference palettes' look, methods as a list";
const CHECKOUT_MUTATIONS = {
  "P1 Pay hidden": {
    why: "the payment step draws its Pay button hidden",
    rewrites: [rewrite(STEP, '              data-part="pay"\n', '              data-part="pay"\n              style="display:none"\n')],
    cases: [CHECKOUT_LIST],
    expect: /^payment step: Pay is not drawn/,
  },
  "P2 the total hidden": {
    why: "the summary's total row (what is due) is drawn hidden",
    rewrites: [rewrite(CHECKOUT_SCRIPT, '"flex justify-between font-bold text-foreground pt-2 border-t border-border mt-2 mb-2",', '"hidden flex justify-between font-bold text-foreground pt-2 border-t border-border mt-2 mb-2",')],
    cases: [CHECKOUT_LIST],
    expect: /^payment step: the total is not drawn/,
  },
  "P3 Pay weaker than a secondary action": {
    why: "Pay drawn small and light, under the gift card's Apply",
    rewrites: [rewrite(STEP, "min-h-12 w-full rounded-lg bg-primary px-4 py-3 text-base font-semibold", "min-h-12 w-full rounded-lg bg-primary px-4 py-3 text-xs font-normal")],
    cases: [CHECKOUT_LIST],
    expect: /^payment step: Pay is drawn (?:smaller|lighter) than a secondary action/,
  },
  "P4 token mode reaches into the gateway": {
    why: "the payment provider's surface takes the theme's token mode: its paint goes transparent",
    rewrites: [rewrite(TOKENS, ':not(${OWN_LOOK})`)();', "`)();")],
    cases: [CHECKOUT_LIST],
    expect: /^payment step: gateway: the provider's surface is restyled/,
  },
};
// ─── end of the payment step's mutations ───

export const MUTATIONS = {
  ...CHECKOUT_MUTATIONS,
  // The gate's own checks, each shown able to fail.
  "G1 the cart takes no touch pan": {
    why: "touch-action:none on the cart: a phone's swipe moves nothing, and Place order's place is never reached by touch",
    rewrites: [rewrite(CART, CART_ROOT, '    data-private="cart"\n    style="touch-action:none"\n  >\n')],
    cases: [S8],
    expect: /^touch: a touch swipe stops/,
  },
  "G2 the cart starts two screens down": {
    why: "the cart's parts start below the first screen",
    rewrites: [rewrite(CART, CART_ROOT, '    data-private="cart"\n    style="padding-top:2400px"\n  >\n')],
    cases: [S8],
    expect: /^first screen: the page's first part starts at/,
  },
  "G3 Place order first in the Tab order": {
    why: "a positive tabindex on Place order: Tab reaches it before the lines above it",
    rewrites: [rewrite(CART, '          id="submitButton"\n', '          id="submitButton"\n          tabindex="1"\n')],
    cases: [S8],
    expect: /^focus order: focus goes back up the page/,
  },
  "G4 the page draws its light colours always": {
    why: "the page marks its light colours where the store shows its dark ones",
    rewrites: [rewrite("apps/storefront/src/layouts/Layout.astro", "data-color-scheme={htmlColorScheme}", 'data-color-scheme="light"')],
    cases: ["review 5: the store's own page under the marketplace palette's dark colours"],
    expect: /^scheme: the page draws its light colours/,
  },
  "G5 a box's padding a hundredfold": {
    why: "a padding token writes a hundred times its value: the theme adds screens above Place order",
    rewrites: [
      rewrite(TOKENS, "write: (value: number) => `padding:min(${value}px,4vw)`", "write: (value: number) => `padding:${value * 100}px`"),
      rewrite(TOKENS, "declare(false, selectors, `padding:max(min(${value as number}px,4vw),${room}px)`);", "declare(false, selectors, `padding:${(value as number) * 100}px`);"),
    ],
    cases: [DEPTH],
    expect: /^depth: the theme adds \d+px above Place order/,
  },
  "G6 a line's title breaks anywhere": {
    why: "word-break:break-all on the line title: its words break inside themselves at the line's end",
    rewrites: [rewrite("apps/storefront/src/lib/cart/line-html.ts", "line-clamp-2 break-words", "line-clamp-2 break-all")],
    cases: [S8],
    expect: /a word breaks inside itself/,
  },
  "G7 the cart's check answers 503": {
    why: "the fixture store's cart check answers 503: a page drawn over a failing request",
    rewrites: [rewrite("apps/storefront/src/gallery/api.ts", '  if (url.pathname === "/api/v1/orders/cart-validation" && request.method === "POST") {\n', '  if (url.pathname === "/api/v1/orders/cart-validation" && request.method === "POST") return new Response("{}", { status: 503 });\n  if (url.pathname === "/api/v1/orders/cart-validation" && request.method === "PUT") {\n')],
    cases: [S8],
    expect: /^5xx: 503 POST/,
  },
  "G8 the required terms box is hidden": {
    why: "the store asks for its terms and the tick box and its words are not drawn: the buyer cannot accept them",
    rewrites: [rewrite("apps/storefront/src/components/checkout/CheckoutTermsAgreement.astro", '<label for={id} class="flex min-h-11', '<label for={id} class="hidden min-h-11')],
    cases: ["the required terms box, light and dark"],
    expect: /cartTermsAccepted.*(?:not visible|missing)/,
  },
  "G10 an app's words never wrap": {
    why: "an app's nodes keep their words on one line: a 120-letter word runs out of its block",
    rewrites: [rewrite("apps/storefront/src/lib/buyer-ui/index.ts", "  node.className = className;\n", "  node.className = className;\n  node.style.whiteSpace = \"nowrap\";\n")],
    cases: ["120-letter words in an app's blocks and an add-on's title, English and Bangla"],
    expect: /apps fit: .*runs out of/,
  },
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
      rewrite(TOKENS, '...["text-foreground", "text-card-foreground", "text-primary-foreground", "text-destructive-foreground"].map(', '...["text-card-foreground", "text-primary-foreground", "text-destructive-foreground"].map('),
    ],
    cases: [B2],
    expect: /an app's node at cart\.line\.after has no row of its own/,
  },
  "B3 the dialogs read the store's palette": {
    why: "token mode does not reach the store's dialogs: their palette classes keep the palette's colours",
    rewrites: [rewrite(TOKENS, "  ...PRIVATE_SCOPES.map((scope) => `[data-private=\"${scope}\"]`),\n", "  ...PRIVATE_SCOPES.filter((scope) => scope !== \"dialog\").map((scope) => `[data-private=\"${scope}\"]`),\n")],
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
    rewrites: [rewrite(TOKENS, "  ...PRIVATE_SCOPES.map((scope) => `[data-private=\"${scope}\"]`),\n", "  ...PRIVATE_SCOPES.filter((scope) => !scope.startsWith(\"core-\")).map((scope) => `[data-private=\"${scope}\"]`),\n")],
    cases: [HEADER],
    expect: /is none of its row's colours \(chrome:/,
  },
  // M9 once left out, for every nested row, the cells its parent has (`inherited` for controls and fields too). A
  // nested row's element sits inside its parent's (`nested`), so a cell equal to the parent's is the one it inherits:
  // that mutation drew the same page and could not fail (it survived). The property it guarded, a control's palette
  // classes reading its own row's cells and not the row around it, is guarded here on today's code. (Place order's
  // words survive it: its row writes their colour itself; the stepper's edge, a palette class, does not.)
  "M9 a nested control's cells left to the row around it": {
    why: "a nested control's row writes no cells of its own: the stepper's border-border class reads its line's border colour, 1.3:1 on the line",
    rewrites: [rewrite(TOKENS, "    ...CELL_PROPERTIES.map(([cell, property]) => row[cell] && (row[cell] !== inherited?.[cell] || also.has(property)) ? `${property}:${row[cell]}` : \"\"),", "    ...CELL_PROPERTIES.map(([cell, property]) => row[cell] && !(row.nested && row.kind === \"control\") && (row[cell] !== inherited?.[cell] || also.has(property)) ? `${property}:${row[cell]}` : \"\"),")],
    cases: [WORDS_APART],
    expect: /line-quantity: its border reads [\d.]+:1 on what is behind it|"Place order" .*(?:reads [\d.]+:1|is none of its row's colours \(submit)/,
  },
  "M10 a title's clamp on its heading": {
    why: "the line title's heading clips its link's focus ring",
    rewrites: [rewrite("apps/storefront/src/lib/cart/line-html.ts", '<h3 class="text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="line-clamp-2 break-words', '<h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base" data-part="line-title"><a href="${escapeHtml(view.productHref)}" class="break-words')],
    cases: [B4],
    expect: /\[data-part=line-title\]>a: its focus ring reads at/,
  },
  "M11 sizes follow the nearest column, the total unfloored": {
    why: "sizes are 7% of the column a part sits in (the page fit unregistered) and the total has no floor at the sizes it outranks: a total in a 320px column draws under a line price in a wide one",
    rewrites: [
      rewrite(TOKENS, "  const fit = narrow.some((rule) => rule.includes(PAGE_FIT)) ? `${PAGE_FIT_RULE}:where(${root}){--pt-fit:7cqi}` : \"\";", "  const fit = \"\";"),
      rewrite(TOKENS, "declare(false, selectors, `font-size:max(${sizeFloor(spec, tokens, target)}px,min(", "declare(false, selectors, `font-size:max(0px,min("),
    ],
    cases: ["a 28px line price and a 28px total, the summary in a narrow column"],
    expect: /prominence: the line price .* over the total's/,
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
    rewrites: [rewrite(TOKENS, '"sm:hover:bg-muted/60"].map((name) => [name, ["background-color:var(--pt-h)", ":hover"]] as const),', '"sm:hover:bg-muted/60"].map((name) => [name, ["background-color:transparent"]] as const),')],
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
      rewrite("packages/shared/src/storefront-theme/private-layout.ts", "painted && privatePageHasOwnPage(page) && privatePageNamed({ pages, tokens: value.tokens }, page) ? {} : null", "null"),
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
      rewrite(TOKENS, "    if (keys.has(name) || ((style.element || style.within)", "    if (name === \"summary-add-on\" || keys.has(name) || ((style.element || style.within)"),
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
  "F2 an edged action's fill distance unchecked": {
    why: "the save takes an edged Place order whose fill is the dock's own colour: a black frame around nothing a buyer reads as a button",
    rewrites: [rewrite(TOKENS, " && surface.every((point) => storefrontThemeColorDistance(point, back) >= PRIVATE_EDGE_FILL_DISTANCE));\n", ");\n")],
    cases: ["Place order the dock's colour behind a dark edge"],
    expect: /^base: Place order: .*its fill is [\d.]+ from what is behind it, under 40/,
  },
  "F4 Pay's edge accepted thin": {
    why: "the save takes a 1px edge around a Pay whose yellow fill reads 1.4:1 on its white card",
    rewrites: [rewrite(TOKENS, "export const PRIVATE_EDGE_MIN_WIDTH = 2;", "export const PRIVATE_EDGE_MIN_WIDTH = 1;")],
    cases: ["Pay brand fill with a 1px edge"],
    expect: /^payment step: Pay: .*edge is no solid 2px border/,
  },
  "F3 a thin edge accepted": {
    why: "the save takes a 1px edge as what finds an action whose fill does not read",
    rewrites: [rewrite(TOKENS, "export const PRIVATE_EDGE_MIN_WIDTH = 2;", "export const PRIVATE_EDGE_MIN_WIDTH = 1;")],
    cases: ["Place order brand fill with a 1px edge"],
    expect: /^base: Place order: .*edge is no solid 2px border/,
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
  // ─── The receipt and the account (w-p2-after-pages): what a buyer must keep there, hidden ───
  "after-order: the receipt's total hidden": {
    why: "the receipt's total row drawn hidden: a buyer must always read what the order costs",
    rewrites: [rewrite("apps/storefront/src/components/order/ReceiptCard.astro", '<div class="flex justify-between gap-4 border-t border-border pt-3" data-summary-row="total">', '<div class="hidden" data-summary-row="total">')],
    cases: ["the receipt in the customer's look"],
    expect: /^receipt: \[data-summary-row="total"\]: not visible/,
  },
  "after-order: the receipt's order number hidden": {
    why: "the order number drawn hidden: the one fact a buyer quotes to the store",
    rewrites: [rewrite("apps/storefront/src/components/order/ReceiptCard.astro", '<span class="break-all text-end font-medium" data-part="order-number">', '<span class="hidden" data-part="order-number">')],
    cases: ["the receipt in the customer's look"],
    expect: /^receipt: \[data-part="order-number"\]: not visible/,
  },
  "after-order: the account's Sign out hidden": {
    why: "Sign out drawn hidden: a buyer on a shared device must always be able to leave the account",
    rewrites: [rewrite("apps/storefront/src/components/account/AccountShell.astro", 'data-part="sign-out"', 'data-part="sign-out" hidden')],
    cases: ["the account in the customer's look"],
    expect: /^account: \[data-part="sign-out"\]: not visible/,
  },
  // ─── Drawn as the theme wrote it (rc-gate-hygiene): each of this release's fixes, undone ───
  "H-a shape tokens at zero specificity": {
    why: "a private page's shape tokens drop token mode's prefix: the store's button corners (one class) outrank a theme's radius 0 on Place order and Confirm",
    rewrites: [rewrite(TOKENS, ".map((suffix) => `${PRIVATE_TOKEN_MODE} :where(${selector})${suffix}`).join(\",\");", ".map((suffix) => `:where(${selector})${suffix}`).join(\",\");")],
    cases: [SQUARE_ACTIONS],
    expect: /drawn as written: .*corners where its target (?:submit|dialog-confirm|action) says 0px/,
  },
  "H-b Place order's dialog in the store's words": {
    why: "the theme's dialog.confirm and dialog.goBack word the line's dialog only (as before the fix): Place order's decision dialog says Go back and Confirm",
    rewrites: [
      rewrite(DIALOG, '  back.textContent = themeLabel(doc, "dialog.goBack") ?? words.goBack;', "  back.textContent = words.goBack;"),
      rewrite(DIALOG, '  confirm.textContent = themeLabel(doc, "dialog.confirm") ?? words.confirm;', "  confirm.textContent = words.confirm;"),
      rewrite(DIALOG, "    goBack: copy.goBack,\n    confirm: copy.confirm,\n", '    goBack: themeLabel(document, "dialog.goBack") ?? copy.goBack,\n    confirm: themeLabel(document, "dialog.confirm") ?? copy.confirm,\n'),
    ],
    cases: [DIALOG_WORDS],
    expect: /^confirm from Place order: (?:Go back|Confirm) reads "[^"]*", not the theme's/,
  },
  "H-c an empty cart's words left to its lazy file": {
    why: "the empty cart's heading is drawn without its words, which only the lazy file (refused here) would write, as before the fix",
    rewrites: [rewrite(CART, '<h2 class="mt-2 text-lg font-medium text-foreground">{copy.emptyCartText}</h2>', '<h2 class="mt-2 text-lg font-medium text-foreground"></h2>')],
    cases: [EMPTY_LAZY],
    expect: /\[data-part="cart-empty"\] h2: (?:not visible|missing)/,
  },
  "H-d the action row reaches the filled actions": {
    why: "the cart's action row (every .bg-primary) no longer leaves out Place order and Confirm: its yellow gradient paints over their own rows' fill",
    rewrites: [rewrite(ANATOMY, '  styles: actionApart("cart", CART_STYLES),', "  styles: CART_STYLES,")],
    cases: [YELLOW_ACTION],
    expect: /paints an image its row \((?:submit|dialog-confirm)\) does not|(?:Place order|Confirm): its fill reads [\d.]+:1|"(?:Place order|Confirm)[^"]*" .*is none of its row's colours \((?:submit|dialog-confirm)/,
  },
  // With the action row kept apart nothing a theme writes reaches a filled action's border style, so the solid edge's
  // prefix guards in depth: undone alone it draws the same page. Undone with the action row reaching Place order (H-d),
  // the action row's `border-style: none` takes the edge the save passed it by.
  "H-e an edge's solid style at zero specificity, the action row reaching it": {
    why: "an edged Place order's border-style:solid is written at zero specificity and the action row reaches it: its border-style:none takes the edge",
    rewrites: [
      rewrite(TOKENS, 'declare(false, `${PRIVATE_TOKEN_MODE} :where(${selector})`, "border-style:solid");', 'declare(false, `:where(${selector})`, "border-style:solid");'),
      rewrite(ANATOMY, '  styles: actionApart("cart", CART_STYLES),', "  styles: CART_STYLES,"),
    ],
    cases: [EDGED_BESIDE],
    expect: /Place order: .*edge is no solid 2px border/,
  },
  "H-f the drawer's line keeps its app block in its text column": {
    why: "the drawer's own line draws a line's app block beside the image, while the customer's cart page draws it under the whole line",
    rewrites: [rewrite("apps/storefront/src/lib/private-pages/drawer.ts", "  const lineTarget = line ? null : lineTargetPlace(cartLine);", "  const lineTarget = null;")],
    cases: [DRAWER_BELOW],
    expect: /a line's app block is drawn at .*the cart page puts it under the line/,
  },
  "H-g the host's other action buttons keep their surface radius": {
    why: "an outline action button (the payment step's Apply, data-control=\"action\") draws the theme's surface radius, not its square button corners",
    rewrites: [],
    css: ':where([data-control="action"], [data-ui="button"]):where(.rounded-sm, .rounded-md, .rounded-lg, .rounded-xl) { border-radius: revert-layer }',
    undoes: { file: FOUNDATION, find: ':where([data-control="action"], [data-ui="button"]):where(.rounded-lg):where(:not([data-part="gateway"] *)) {' },
    cases: [SQUARE_PAYMENT],
    expect: /corners where the theme's buttons are square/,
  },
  "H-h the radius steps add a pixel to a square theme": {
    why: "rounded-lg and rounded-xl draw the theme's radius plus 1px and 2px: a square theme's fields draw rounded corners",
    rewrites: [],
    // The steps are `@theme inline`: the utilities carry their values, so the old ones are written on the utilities, in
    // their own cascade layer (an unlayered rule would also beat the buttons' own corners, more than this undoes).
    css: "@layer utilities{.rounded-lg{border-radius:calc(var(--radius) + 1px)}.rounded-xl{border-radius:calc(var(--radius) + 2px)}}",
    undoes: { file: FOUNDATION, find: "  --radius-lg: calc(var(--radius) + min(1px, var(--radius) * 1000));" },
    cases: [SQUARE_CART],
    expect: /corners where the theme's fields are square/,
  },
  "H-j a line reads its details before its title": {
    why: "the cart's line keeps a theme's arrangement order in its markup: the options drawn over the title are read (and tabbed to) before it",
    rewrites: [rewrite("apps/storefront/src/lib/cart/line-reading-order.ts", "  if (at <= 0 || nodes.slice(0, at).every(decorative) || nodes.length > LINE_ORDER_CLASSES.length) return children;", "  return children;")],
    cases: ["the customer's cart, its protection offered"],
    expect: /reading order: a line reads \S+ before its title/,
  },
  "H-k the drawer's footer never yields to its lines": {
    why: "the drawer's rows above the total stand outside its scrolling region, however little room they leave the lines",
    rewrites: [rewrite("apps/storefront/src/components/CartFlyout.tsx",
      "{scrollRegion(cart.totalItems === 0 ? emptyState : lineList(true), undefined, cart.totalItems > 0 && extrasBox(<>{summaryRows}{footerTarget}</>))}",
      "{scrollRegion(cart.totalItems === 0 ? emptyState : lineList(true))}{cart.totalItems > 0 && extrasBox(<>{summaryRows}{footerTarget}</>)}")],
    cases: ["five lines in the drawer on a phone", "five lines in the customer's drawer on a phone"],
    expect: /drawer lines: .*whole line|is not wholly on screen/,
  },
  "H-l the drawer's footer blocks in a pane shorter than they are": {
    why: "the rows above the total scroll in a pane of their own that can be shorter than an app's block: the block shows as a sliver",
    rewrites: [rewrite("apps/storefront/src/components/CartFlyout.tsx", '<div className="mt-auto shrink-0 space-y-3 border-t', '<div className="mt-auto shrink-0 max-h-8 overflow-y-auto space-y-3 border-t')],
    cases: ["five lines in the customer's drawer on a phone"],
    expect: /drawer lines: an app block in the drawer's footer .*pane of its own/,
  },
  "H-m a tab's long name ends in an ellipsis": {
    why: "the store's own bar keeps each tab's name on one line, so \"Gaming News\" at 320px is cut to \"Gaming…\"",
    rewrites: [rewrite("apps/storefront/src/components/header/MobileTabBar.astro", "    overflow-wrap: anywhere;\n    white-space: normal;", "    text-overflow: ellipsis;\n    white-space: nowrap;")],
    cases: ["the store's own phone tab bar with the customer's tabs, English and Bangla"],
    expect: /tab bar: the label "[^"]+" is cut/,
  },
  "H-n a tab's icon squeezed inside its chip": {
    why: "the bar's icon box is the icon's size alone, so its chip's room is taken from the glyph",
    rewrites: [rewrite("packages/shared/src/storefront-theme/private-tab-bar.ts", "inline-size:${size + 2 * padding + 2 * edge}px;block-size:${size + 2 * padding + 2 * edge}px", "inline-size:${size}px;block-size:${size}px")],
    cases: ["the phone tab bar in the customer's look, on the account, English and Bangla"],
    expect: /tab bar: a tab's icon is drawn/,
  },
  "H-i the dialog's actions stack with Confirm on top": {
    why: "Confirm comes first in the dialog's markup: where its large Confirm and Go back do not fit side by side, Confirm stacks on top, away from the thumb",
    rewrites: [rewrite(DIALOG, "  actions.append(back, confirm);", "  actions.append(confirm, back);")],
    cases: [DIALOG_WORDS],
    expect: /the actions stack with Confirm on top/,
  },
  // Round three: the after-order draws' forced states.
  "after-order: the account's tabs ring outside the strip": {
    why: "a tab's focus ring drawn outside its edge: the strip that scrolls sideways clips it, and a keyboard buyer loses their place",
    rewrites: [rewrite("apps/storefront/src/components/account/AccountShell.astro", "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", "focus-visible:ring-2 focus-visible:ring-ring")],
    cases: ["the account's account-inbox in a hostile look"],
    expect: /^account focus: control .*nav-item\]: its focus ring reads at 3:1 on \d+ pixels/,
  },
  "after-order: an edit dialog drawn through to its backdrop": {
    why: "a card in the top layer paints nothing where the page beneath paints the same: its words stand on the dialog's backdrop",
    rewrites: [rewrite(TOKENS, "row.paint !== null && (row.opaque || also.has", "row.paint !== null && (also.has")],
    cases: ["the account's account-profile-dialog just above every floor"],
    expect: /^account: ".*" .*editDetails.*reads \d+\.\d+:1 on what is behind it/,
  },
  "after-order: a hover nobody sees": {
    why: "a hover surface a step from a near-white surface: the pointer changes nothing visible, and no underline stands in",
    rewrites: [rewrite(TOKENS, "storefrontThemeColorDistance(point, hover) >= PRIVATE_HOVER_DISTANCE) ? hover", "storefrontThemeColorDistance(point, hover) >= 0) ? hover")],
    cases: ["the account's account-order just above every floor"],
    expect: /^account hover: control .*: shows no hover/,
  },
};

/**
 * The gallery's side of a mutation: a Vite plugin applying its rewrites to
 * the modules it serves, and which files it rewrote and which it could not
 * (the gate asks, and a mutation that tests nothing fails the run).
 */
// ─── A theme's chrome on the buyer's own pages (buyer-chrome.browser.mjs `--mutations`) ───
const CHROME = "apps/storefront/src/components/private/PrivateChrome.astro";
const CHROME_STYLE = "apps/storefront/src/lib/private-pages/chrome-style.ts";
const SHADOW = '<scalius-chrome data-chrome={target}><template shadowrootmode="open"><style is:inline set:html={style}></style><Fragment set:html={chrome.html} /></template></scalius-chrome>';
const CSS = "packages/shared/src/plugins/buyer-chrome-css.ts";
const REBUILD = "packages/shared/src/plugins/inert-html.ts";
/** Each names the check of buyer-chrome.browser.mjs that must fail under it. */
export const CHROME_MUTATIONS = {
  "C1 no shadow root": {
    why: "the chrome is drawn in the page itself: its sheet and its layers reach the page",
    rewrites: [rewrite(CHROME, SHADOW, '<scalius-chrome data-chrome={target}><style is:inline set:html={style}></style><Fragment set:html={chrome.html} /></scalius-chrome>')],
    expect: /^shadow: the (?:header|footer) is drawn without a shadow root|^style: |^covered: /,
  },
  "C2 a form kept": {
    why: "the rebuild keeps a theme's forms and fields",
    rewrites: [
      rewrite("packages/shared/src/plugins/inert-html.ts", '"noscript", "video", "audio", "canvas", "math", "foreignobject", "use", "image", "portal", "form", "input", "select",', '"noscript", "video", "audio", "canvas", "math", "foreignobject", "use", "image", "portal", "select",'),
      rewrite("packages/shared/src/plugins/inert-html.ts", '  "a", "abbr", "address", ', '  "a", "abbr", "address", "form", "input", '),
    ],
    expect: /^markup: /,
  },
  "C3 no paint containment on the host": {
    why: "the guard no longer paint-contains the host (the frame still clips: the gate names the host's own containment)",
    rewrites: [rewrite(CHROME_STYLE, "max-inline-size:100%!important;contain:paint!important;", "max-inline-size:100%!important;")],
    expect: /^containment: /,
  },
  "C4 the theme's sheet unlayered": {
    why: "the store's reading of the theme's sheet is imported outside its layer, so its important rules in a layer it names outrank the guard",
    rewrites: [rewrite(CHROME_STYLE, "theme ? `@import ${cssUrl(theme)} layer(theme);` : \"\",", "theme ? `@import ${cssUrl(theme)};` : \"\",")],
    expect: /^containment: /,
  },
  "C5 no store frame": {
    why: "the shadow host sits in no frame of the store's: the host's own effects and layers paint over the page",
    rewrites: [rewrite(CHROME, "<div data-buyer-chrome-frame={target} style={BUYER_CHROME_FRAME_STYLE[target]}>", "<div data-buyer-chrome-frame={target}>")],
    expect: /^covered: |^containment: /,
  },
  "C6 selectors unchecked": {
    why: "the check lets :host hold, chain or nest under a selector that matches the page around the host",
    rewrites: [rewrite(CSS, "function checkSelector(values: CssComponent[]): void {\n", "function checkSelector(values: CssComponent[]): void {\n  if (values.length > 0) return;\n")],
    expect: /^refusal: /,
  },
  "C7 URLs unchecked": {
    why: "the check lets a sheet's URL reach outside the app's own public files",
    rewrites: [rewrite(CSS, "  if (url.origin !== \"https://store.invalid\" || !url.pathname.startsWith(`${RELEASE}public/`) || url.hash) {", "  if (url.protocol === \"never:\") {")],
    expect: /^refusal: /,
  },
  "C8 a theme popover kept": {
    why: "the rebuild keeps a theme's popover in the theme's region, so a theme element reaches the top layer",
    rewrites: [
      rewrite(REBUILD, '    if (name === "popover" || name === "popovertarget" || name === "popovertargetaction" || name === "data-panel") continue;', '    if (name === "popover" || name === "popovertarget") { out.push([name, name === "popover" ? "auto" : value]); continue; }\n    if (name === "popovertargetaction" || name === "data-panel") continue;'),
      rewrite(REBUILD, '    const panel = POPOVER_TAGS.has(tag) && "popover" in node.attribs ? rebuild.panels.get(node.attribs.id ?? "") : undefined;', "    const panel = undefined as number | undefined;"),
    ],
    // The panel check, or the markup check's own finding: a region's markup that names a popover.
    expect: /^panel: |^covered: |^markup: .*\bpopover(?:target)?>/,
  },
};

/** Each chrome mutation names the check it must fail, and each rewrite's text is in its file exactly once. */
export async function chromeMutationsHold(read) {
  const problems = [];
  for (const [name, mutation] of Object.entries(CHROME_MUTATIONS)) {
    for (const { file, find } of mutation.rewrites) {
      const source = await read(file);
      const at = source.indexOf(find);
      if (at < 0 || source.indexOf(find, at + find.length) >= 0) problems.push(`${name}: ${file} does not hold its text exactly once`);
    }
  }
  return problems;
}

export function galleryMutation(name) {
  const mutation = MUTATIONS[name] ?? CHROME_MUTATIONS[name];
  if (!mutation) throw new Error(`Unknown mutation ${name}: one of ${[...Object.keys(MUTATIONS), ...Object.keys(CHROME_MUTATIONS)].join(", ")}.`);
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
  return { name, plugin, applied, missed, files: [...new Set(mutation.rewrites.map((each) => each.file))], compile: mutation.compile, css: mutation.css };
}

/** Each mutation names the check it must fail, and each rewrite's text is in its file exactly once (checked without a browser). */
export async function mutationsHold(read) {
  const problems = [];
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    if (!(mutation.expect instanceof RegExp)) problems.push(`${name}: names no check that must fail (expect)`);
    if (mutation.css && !mutation.undoes) problems.push(`${name}: undoes a stylesheet rule without naming its source text (undoes)`);
    for (const { file, find } of [...mutation.rewrites, ...(mutation.undoes ? [mutation.undoes] : [])]) {
      const source = await read(file);
      const at = source.indexOf(find);
      if (at < 0 || source.indexOf(find, at + find.length) >= 0) problems.push(`${name}: ${file} does not hold its text exactly once`);
    }
  }
  return problems;
}
