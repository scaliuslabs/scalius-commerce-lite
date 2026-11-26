// Rendered property tests for the buyer's private pages: the safety net under
// the private-page model (packages/plugin-sdk/docs/private-pages.md). Headless
// Chromium, no network: the fixture gallery (apps/storefront/scripts/gallery-server.mjs)
// draws the real cart page through Vite with the store's real CSS, compiles
// each document with the store's compiler, and answers as a store that
// delivers (Place order is on), with an app block of every node kind and tone
// in the summary, below the cart, under a line and inside the details form.
//
// From the repo root:
//   pnpm test:private-pages                       the gate: the named cases and a fast seed set
//   pnpm test:private-pages --seeds 30 --from 100 a longer run (--no-named: seeds only; --all-states: every state of each)
//   pnpm test:private-pages --seed 7              replay one seed (its document is printed on failure)
//   pnpm test:private-pages --case "review 4, B4" only the named cases whose name holds this text
//   pnpm test:private-pages --mutate <name>       run under one known-bad change (private-pages.mutations.mjs)
//   pnpm test:private-pages --mutations           the unmutated cases draw clean, and every known-bad change fails the check it names
//   --all-problems prints every problem of a failing draw; --jobs <n> cases at once (4); --profile where the time goes; PT_SHOTS=<dir> keeps the screen a
//   failing text was measured on. Exit 0: every draw holds; 1: a draw fails; 2: the gate could not run.
//
// A theme here arranges the store's parts and gives them typed tokens: it
// writes no markup and no CSS. Each document is a LEGAL theme (or a named
// break the save must refuse, or a stored document forged past the save,
// which the store reads with what it held dropped and its private pages'
// compile refused).
// A named document the save refuses fails the gate unless it names the
// reason it must be refused for; a seed's refused draft is counted, and its
// next draft drawn (a seed with no draft taken fails). Each
// accepted one is drawn in its states (a store that delivers; a line asking
// for a decision, a store kit with an add-on once per kit and an app's offer
// row, and a sold-out line; an empty cart; long Bangla titles; an Arabic
// right-to-left presence; the customer's game cart offered its protection or
// protected) at 320, 390 and 1280 px, light and dark, and with validation
// errors showing, the sign-in dialog open and the confirmation dialog open.
// Every draw must hold:
// - every mandatory part inside the viewport, not tiny; the page never
//   scrolls sideways; the store's controls (its light or dark switch, its
//   market and language forms) where the theme places them and nowhere else;
//   no free region, and none of a forged document's words or CSS;
// - Place order with its total on screen and taking a click at scroll 0 and at
//   three scroll positions down the cart (docked at the bottom edge while its
//   place is not in view); one of the page's lead parts starting inside the
//   first screen at scroll 0; and what the theme adds above Place order (its
//   place under the theme less its place under the default look, same cart)
//   at most THEME_DEPTH_PX and LINE_DEPTH_PX a line;
// - the coverage walk, with every add-on row opened: every text and every
//   focusable control the host draws belongs to a row of the page's colour
//   table (in token mode its words are one of the row's colours, no surface
//   the table does not know lies between them and the row, and every element
//   a style target names is drawn by a row of that target); with no tokens,
//   to a surface the anatomy names, and the page shows no paint of its own;
// - every text at its contrast floor against its worst pixel behind it, no
//   budget (the text hidden, the page photographed); a field's value or
//   placeholder at its 5th-percentile pixel less 0.05 (its box holds its ring);
// - every text whole: nothing cut sideways, no glyph cut by a clip, no word
//   broken inside itself that fits whole on a line of its box; an app's
//   words and an add-on row's title inside their boxes, the title clear of
//   its amount; the lines, summary and details form at their floor;
// - the summary's total drawn no smaller than any other summary row, its
//   amount no smaller than its label, no lighter and no fainter than a row;
// - under a theme's tokens: Place order's and Confirm's fill at 3:1 on what
//   is behind them, Place order never smaller or lighter than another filled
//   button, Go back with no fill of its own and Confirm never smaller or
//   lighter than it, and every field, the stepper, the fold's bar and Go back
//   found by a border at 3:1 or, drawing none, by their own fill;
// - every control takes a click at its centre, is reached by Tab in document
//   order, shows a focus ring at 3:1 against what is around it, and under the
//   pointer still reads (and shows its hover where the host draws one);
// - on a phone, the page scrolls by touch from the top to the details form's
//   end, Place order's own place (docked, Place order is on screen at once);
// - under the customer's look: the offer row's mark, sentence, price and Add
//   Now on one line at 1280 and on at most two at 390, the status box on its
//   tone's own surface, the add-on row opening to its three detail lines in
//   order with its amount shown once;
// - no request answers 5xx.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const number = (name, fallback) => (option(name) === undefined ? fallback : Number(option(name)));
const ONLY = number("seed", null);
const SEEDS = number("seeds", 4);
const FROM = number("from", 1);
const CASE = option("case");
const ALL_STATES = args.includes("--all-states");
const NO_SEEDS = args.includes("--no-seeds");
const MUTATE = option("mutate");
const BAIL = args.includes("--bail");
let bailed = false;
/** Cases drawn at once (each in its own browser contexts). */
const JOBS = number("jobs", 4);
const WIDTHS = [320, 390, 1280];
const SCHEMES = ["light", "dark"];
/** The states a seed or `states: "all"` draws; a named case may ask for others (`states: ["many"]`: twenty lines). */
const STATES = ["base", "lines", "decide", "empty", "bn", "ar", "customer", "customer-protected"];
/**
 * What a theme may add above Place order, against the default look holding the same cart (both with the
 * phone's fold open). A theme writes no markup here, so only its arrangement, tokens and variants add depth:
 * one column on a wide screen, which brings what the default look draws beside the form above it (in the
 * gallery's cart the summary and the below-cart target each hold an app block of every node kind: 2000px);
 * its layouts' padding and gaps and its tokens' larger type (1000px); the heading above the lines with a
 * two-line intro, the summary's heading and Items row (200px): 3200px. And per line, its tokens (a 320px
 * image for the default's 96px, 48px padding each side, a 40px title on three lines for two of 20px): 448px.
 */
const THEME_DEPTH_PX = 3200;
const LINE_DEPTH_PX = 448;
/** The states drawn on a phone's short screen and two wider ones: one line, twenty and ninety-nine. */
const LENGTHS = ["one", "many", "max"];
const LENGTH_VIEWPORTS = [[390, 700, "light"], [768, 1024, "dark"], [1280, 800, "light"]];

// ─── The gate tests itself ─────────────────────────────────────────────────

if (args.includes("--mutations")) {
  const { MUTATIONS, mutationsHold } = await import("./private-pages.mutations.mjs");
  const { readFile } = await import("node:fs/promises");
  const stale = await mutationsHold((file) => readFile(resolve(file), "utf8"));
  if (stale.length > 0) { console.error(stale.join("\n")); process.exit(2); }
  const script = fileURLToPath(import.meta.url);
  const gate = (extra, cases) => spawnSync(process.execPath, [script, "--no-seeds", ...extra, ...cases.flatMap((each) => ["--case", each])], { encoding: "utf8", env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 });
  // The problems the failing draws reported (each `  <problem>` line under a `✗ ` draw), never the rest of the output.
  const problemsOf = (output) => output.split("\n").filter((line) => line.startsWith("  ") && !line.startsWith("  document: ")).map((line) => line.trim());
  // The baseline first, in the same run: every case a mutation names draws clean unmutated, so a mutation's
  // failure is the mutation's.
  const cases = [...new Set(Object.values(MUTATIONS).flatMap((mutation) => mutation.cases))];
  const begun = Date.now();
  const baseline = gate([], cases);
  console.log(`${baseline.status === 0 ? "clean    " : "NOT CLEAN"} the unmutated baseline, ${cases.length} cases (${Math.round((Date.now() - begun) / 1000)}s, exit ${baseline.status})`);
  if (baseline.status !== 0) {
    console.log(`${baseline.stdout}\n${baseline.stderr}`.split("\n").filter((line) => line.trim()).slice(-25).map((line) => `    ${line}`).join("\n"));
    process.exit(1);
  }
  const survived = [];
  const broken = [];
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    const started = Date.now();
    // A run that could not run (exit 2: a crash, a gallery that would not start) is run once more; twice is no answer.
    let run = gate(["--mutate", name, "--bail"], mutation.cases);
    if (run.status === 2) run = gate(["--mutate", name, "--bail"], mutation.cases);
    const output = `${run.stdout}\n${run.stderr}`;
    if (run.status === 2) {
      broken.push(name);
      console.log(`COULD NOT RUN ${name} (${Math.round((Date.now() - started) / 1000)}s, exit 2, twice): neither caught nor survived`);
      console.log(output.split("\n").filter((line) => line.trim()).slice(-12).map((line) => `    ${line}`).join("\n"));
      continue;
    }
    // Caught: the gate ran and reported a failing draw (not a crash, exit 2), and the check the mutation names failed.
    const caught = run.status === 1 && /\n✗ /.test(output) && problemsOf(output).some((problem) => mutation.expect.test(problem));
    console.log(`${caught ? "caught  " : "SURVIVED"} ${name} (${Math.round((Date.now() - started) / 1000)}s, exit ${run.status}): ${mutation.why}`);
    // What caught it: the first problem of the check it names.
    if (caught) console.log(`    ${problemsOf(output).find((problem) => mutation.expect.test(problem)).slice(0, 220)}`);
    if (!caught) {
      survived.push(name);
      console.log(output.split("\n").filter((line) => line.trim()).slice(-25).map((line) => `    ${line}`).join("\n"));
    }
  }
  console.log(`private pages gate, mutations: ${Object.keys(MUTATIONS).length - survived.length - broken.length} of ${Object.keys(MUTATIONS).length} caught${survived.length ? `; survived: ${survived.join(", ")}` : ""}${broken.length ? `; could not run: ${broken.join(", ")}` : ""}`);
  process.exit(broken.length > 0 ? 2 : survived.length > 0 ? 1 : 0);
}
if (MUTATE) process.env.SCALIUS_GALLERY_MUTATION = MUTATE;

// ─── A seeded generator ────────────────────────────────────────────────────

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = ["background", "foreground", "card", "card-foreground", "primary", "primary-foreground", "muted", "muted-foreground", "border", "input", "secondary"];
const LONG = "Supercalifragilisticexpialidocious".repeat(8);
const PALETTES = ["retail", "marketplace", "boutique", "fresh", "beauty", "heritage", "midnight"];
const TONES = ["neutral", "info", "success", "warning", "critical"];
const UI_TARGETS = ["cart.page.summary", "cart.page.below", "cart.line.after", "checkout.contact.after", "checkout.delivery.after"];
const APPS = ["acme.kinds", "acme.protection", "acme.loyalty", "gameghor.protection"];
/** A colour per scheme (`{ light, dark }`): what each palette's row resolves on its own. */
const SCHEMED = (light, dark) => ({ light, dark });
/**
 * Text and its surface chosen together (the save refuses an unreadable pair; most still pass), one colour or
 * one per scheme (a light box in the light colours, a dark one in the dark).
 */
const PAIRS = [
  ["card", "card-foreground"], ["background", "foreground"], ["#1e1831", "#f4f1ff"], ["#ffffff", "#111111"], ["#111111", "#ffffff"], ["#0f2a1d", "#ecfdf5"],
  [SCHEMED("#ffffff", "#111111"), SCHEMED("#111111", "#f4f4f5")], [SCHEMED("card", "#1e1831"), SCHEMED("card-foreground", "#f4f1ff")], [SCHEMED("#f2ebd9", "#35282c"), SCHEMED("#000000", "#fef3c6")],
];
/** The theme's own files the generator names: the gallery draws any `pp/<name>.svg` of the theme's app. */
const NOOR = "scalius.noor";

function generate(seed) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const colour = () => chance(0.6) ? pick(ROLES) : `#${Math.floor(next() * 0xffffff).toString(16).padStart(6, "0")}`;
  // A theme's own files exist only with a theme app: Noor installed brings one.
  const noor = chance(0.2);
  const layoutHooks = [];
  const wrap = (children) => {
    const hook = `wrap-${layoutHooks.length}`;
    layoutHooks.push(hook);
    return { type: "layout", layout: pick(["stack", "columns", "grid", "group"]), hook, children };
  };
  const variant = (list) => chance(0.5) ? { variant: pick(list) } : {};
  // The default arrangement (tokens only) a third of the time; else the cart's parts in a legal arrangement, with their variants.
  const arranged = chance(0.67);
  let pages = {};
  if (arranged) {
    const cart = [{ type: "part", part: "lines", ...variant(["heading-inside", "heading-above"]) }, { type: "part", part: "summary", ...variant(["totals", "with-items"]) }, ...(chance(0.5) ? [{ type: "part", part: "discount" }] : []), { type: "target", target: "cart.page.summary" }];
    const side = [{ type: "layout", layout: "fold", children: cart }, { type: "target", target: "cart.page.below" }];
    const main = chance(0.5) ? [wrap([wrap(side), { type: "part", part: "details" }])] : [...side, { type: "part", part: "details" }];
    const layout = [...(chance(0.3) ? [{ type: "part", part: "progress" }] : []), { type: "part", part: "notices" }, ...main];
    const details = { type: "part", part: "details", ...variant(["lines", "values", "chips"]) };
    const remove = { type: "part", part: "remove", ...variant(["icon", "words"]) };
    const line = chance(0.4) ? undefined : [
      wrap([{ type: "part", part: "image" }, wrap([{ type: "part", part: "title" }, details, { type: "part", part: "inputs" }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }]), wrap([{ type: "part", part: "price" }, { type: "part", part: "quantity" }, remove])]),
      { type: "target", target: "cart.line.after" },
    ];
    pages = { cart: { ...(chance(0.25) ? { frame: "narrow" } : {}), layout, ...(line ? { items: { line } } : {}) } };
  } else if (chance(0.3)) {
    pages = { cart: { frame: "narrow" } };
  }
  const tokens = {};
  const set = (target, values) => { tokens[target] = { ...tokens[target], ...values }; };
  const tracks = () => Array.from({ length: int(1, 4) }, () => pick([int(24, 480), 480, "1fr", "2fr", "auto", "min-content"]));
  for (const hook of [...layoutHooks]) {
    if (chance(0.5)) set(`@${hook}`, { columns: tracks(), gap: pick([0, 48, int(0, 48)]), ...(chance(0.3) ? { "columns-wide": tracks() } : {}), ...(chance(0.2) ? { background: pick(["card", "muted", "#f8f5ff", SCHEMED("#f8f5ff", "#1e1831")]), radius: int(0, 32), padding: pick([0, 24, 48]) } : {}) });
  }
  const dark = (value) => [value?.light ?? value, value?.dark ?? value].some((one) => typeof one === "string" && /^#[01]/.test(one));
  for (const target of ["lines", "summary", "details-form", "line", "page", "notice", "dialog", "dialog-text", "dialog-agree", "summary-add-on-detail", "line-chip"]) {
    if (!chance(0.35)) continue;
    const [background, text] = pick(PAIRS);
    const gradient = chance(0.2) && ["lines", "summary", "details-form", "page"].includes(target);
    // A line keeps the host's own text: its paint stays light in the light colours and dark in the dark.
    if (target === "line") set(target, { background: pick(["background", "card", "#ffffff", "#f8f5ff", SCHEMED("#ffffff", "#111111")]), radius: int(0, 32), padding: pick([0, 12, 48]), "border-width": int(0, 4), "border-style": pick(["solid", "dashed", "dotted", "none"]) });
    else if (target === "page") set(target, gradient ? { gradient: { shape: pick(["linear", "radial"]), angle: int(0, 360), from: pick(["#ffffff", SCHEMED("#ffffff", "#2b2d6e")]), to: pick(["#f3eefe", SCHEMED("#f3eefe", "background")]) } } : { background: pick(["background", "card", "#ffffff", "#f8f5ff", SCHEMED("#ffffff", "#111111")]) });
    else if (target === "notice") set(target, { background, text, muted: text, link: text, error: text, radius: int(0, 32), border: colour(), "border-width": int(0, 4) });
    else if (target === "line-chip") set(target, { background, text, radius: int(0, 32), "border-width": int(0, 2) });
    else if (target === "dialog-agree") set(target, { background, text, radius: int(0, 32), padding: pick([0, 16]), "border-width": int(0, 2) });
    else if (target === "dialog-text" || target === "summary-add-on-detail") set(target, { background, text, muted: text, radius: int(0, 32), padding: pick([0, 16]), "border-width": int(0, 2), ...(target === "summary-add-on-detail" && chance(0.5) ? { size: int(12, 14), font: pick(["body", "mono"]) } : {}) });
    else set(target, { ...(gradient ? { gradient: { shape: "linear", angle: int(0, 360), from: background, to: background } } : { background }), text, muted: text, link: text, error: text, radius: pick([0, 32, int(0, 32)]), ...(target === "dialog" ? {} : { padding: pick([0, 48]) }), shadow: pick(["none", "sm", "md", "lg"]) });
    // Fields beside a dark box keep a ring and an error border that read on light and dark.
    if (dark(background)) set("input", { ring: "#8b5cf6", invalid: "#e11d48" });
  }
  // Every other style target, now and then, with values of its types.
  const text = () => ({ ...(chance(0.5) ? { size: pick([12, 40, int(12, 40)]) } : {}), ...(chance(0.4) ? { weight: pick(["400", "500", "600", "700", "800"]) } : {}), ...(chance(0.3) ? { case: pick(["none", "uppercase"]) } : {}), ...(chance(0.3) ? { tracking: pick(["normal", "wide", "wider"]) } : {}), ...(chance(0.3) ? { font: pick(["body", "heading", "mono"]) } : {}), ...(chance(0.3) ? { leading: pick(["tight", "snug", "normal", "relaxed"]) } : {}) });
  const maybe = (target, values) => { if (chance(0.3)) set(target, values); };
  maybe("lines-heading", text());
  maybe("lines-intro", { size: int(12, 18), weight: pick(["400", "500"]), leading: pick(["snug", "relaxed"]) });
  maybe("line-title", { ...text(), ...(chance(0.6) ? { clamp: pick(["none", "2", "3"]) } : {}) });
  maybe("line-details", { size: int(12, 20) });
  maybe("line-price", { size: int(12, 28), weight: pick(["400", "700"]), align: pick(["start", "center", "end"]) });
  // The stepper, the fold's bar and a field are found by their edge: a seed draws one (none and its fill is a named break).
  maybe("line-quantity", { radius: int(0, 32), "border-width": int(1, 4), "border-style": pick(["solid", "dashed"]), ring: "#7c3aed" });
  maybe("line-remove", { radius: int(0, 32), ring: "#7c3aed", size: int(12, 18), weight: pick(["400", "600"]) });
  maybe("line-image", { width: pick([40, 240]), height: pick([40, 320]), "width-wide": pick([40, 240]), radius: int(0, 32), fit: pick(["contain", "cover"]) });
  maybe("fold-toggle", { radius: int(0, 32), shadow: pick(["none", "md"]), "border-width": int(1, 4) });
  // The total outranks every other summary row (the save refuses a smaller one): rows to 18px, the total from 20.
  maybe("summary-heading", { ...text(), size: int(14, 24) });
  maybe("summary-rows", { size: int(12, 18) });
  maybe("summary-total", { ...text(), size: int(20, 40), weight: "800" });
  // No money figure outsizes the total: a line price over the total's size raises the total to it.
  const price = tokens["line-price"]?.size;
  if (price !== undefined && price > (tokens["summary-total"]?.size ?? 20)) set("summary-total", { size: price, weight: "800" });
  maybe("summary-total-label", { ...text(), size: int(18, 20) });
  maybe("summary-add-on", { radius: int(0, 12), ring: "#7c3aed" });
  maybe("section-heading", text());
  maybe("field-label", { size: int(12, 16), weight: pick(["500", "600"]), case: pick(["none", "uppercase"]), tracking: pick(["normal", "wide"]) });
  maybe("dialog-title", { ...text(), size: int(18, 28) });
  maybe("legal", { size: int(12, 18), align: pick(["start", "center", "end"]) });
  // Place order is never smaller than the other filled buttons (14px with no token, or the action's size).
  maybe("submit", { background: "#7c3aed", text: "#ffffff", radius: pick([0, 32]), case: "uppercase", size: pick([16, 40]), tracking: pick(["normal", "wider"]) });
  maybe("action", { radius: int(0, 32), weight: "700" });
  maybe("input", { radius: int(0, 32), "border-width": int(1, 4) });
  maybe("frame", { "max-width": pick([480, 1600]) });
  // Confirm is never lighter than Go back.
  maybe("dialog-back", { radius: int(0, 32), weight: "500" });
  maybe("dialog-confirm", { background: "#7c3aed", text: "#ffffff", radius: int(0, 32), weight: "600" });
  maybe("cart-empty", { text: "foreground" });
  // The apps' nodes by kind, narrowed by tone, app and target.
  for (let count = int(0, 5); count > 0; count -= 1) {
    const kind = pick(["banner", "badge", "button", "text", "heading", "disclosure", "row", "stack", "mark", "link", "keyvalue"]);
    const tone = ["banner", "badge", "stack", "mark", "text"].includes(kind) && chance(0.6) ? `.${pick(TONES)}` : "";
    const key = `ui.${kind}${tone}${chance(0.4) ? `@${pick(APPS)}` : ""}${chance(0.4) ? `/${pick(UI_TARGETS)}` : ""}`;
    const values = kind === "row" ? { gap: int(0, 48) }
      : kind === "text" || kind === "heading" ? { size: int(12, 24), weight: pick(["400", "700"]) }
        : kind === "link" || kind === "keyvalue" ? { size: int(12, 18), weight: pick(["500", "700"]) }
          : kind === "mark" ? { size: int(12, 18) }
            : kind === "button" ? { background: "#10b981", text: "#04130d", radius: int(0, 32), weight: "700", inset: int(8, 24) }
              : kind === "badge" ? { background: "#fffbeb", text: "#111111", radius: int(0, 32) }
                : kind === "stack" ? { background: pick(["#fffbeb", SCHEMED("#f2ebd9", "#35282c")]), text: pick(["#111111", SCHEMED("#000000", "#fef3c6")]), radius: int(0, 12), padding: int(0, 16), gap: int(0, 16) }
                  : { background: "#fffbeb", text: "#111111", border: colour(), radius: int(0, 32) };
    set(key, values);
  }
  const labels = {
    ...(chance(0.3) ? { "cart.continue": pick(["continue-shopping", "keep-shopping", "back-to-store"]) } : {}),
    ...(chance(0.3) ? { "cart.subtotal": pick(["subtotal", "items-total"]) } : {}),
    ...(chance(0.3) ? { "cart.showSummary": pick(["show-summary", "show-cart"]), "cart.hideSummary": pick(["hide-summary", "hide-cart"]) } : {}),
    ...(chance(0.3) ? { "dialog.goBack": pick(["go-back", "cancel"]), "dialog.confirm": pick(["confirm", "continue-checkout", "agree-and-continue"]) } : {}),
    ...(chance(0.3) ? { "cart.heading": { en: chance(0.5) ? "Your bag, ready when you are" : "Cart", bn: "আপনার কার্ট" } } : {}),
    ...(chance(0.3) ? { "cart.intro": { en: chance(0.3) ? LONG : "Review your items before checkout.", bn: "চেকআউটের আগে পণ্যগুলো দেখে নিন।" } } : {}),
    ...(chance(0.3) ? { "cart.summaryHeading": { en: "Order Summary", bn: "অর্ডারের সারাংশ" } } : {}),
    ...(chance(0.3) ? { "cart.empty": { en: "Nothing here yet" }, "cart.emptyText": { en: "Your bag is waiting for something lovely." } } : {}),
  };
  const icons = noor && chance(0.5) ? { "cart.empty": { app: NOOR, file: "pp/bag.svg" } } : {};
  return {
    request: { noor, palette: chance(0.5) ? pick(PALETTES) : undefined, scheme: pick(["system", "system", "light", "dark"]), toggle: chance(0.3), localization: chance(0.2) },
    privatePages: { ...(chance(0.4) ? { controls: pick(["header", "footer", "none"]) } : {}), pages, tokens: Object.keys(tokens).length ? { cart: tokens } : {}, labels, icons },
  };
}

// ─── The named cases ──────────────────────────────────────────────────────

const LEGAL_COLUMNS = [{ type: "part", part: "notices" }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }] }, { type: "part", part: "details" }] }];
const DARK = { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#c4b5fd", error: "#fca5a5" };
/** Light in the light colours, dark in the dark: every colour of a box, per scheme. */
const BY_SCHEME = { background: SCHEMED("#ffffff", "#111111"), text: SCHEMED("#111111", "#ffffff"), muted: SCHEMED("#4b5563", "#d4d4d4"), link: SCHEMED("#5b21b6", "#c4b5fd"), error: SCHEMED("#b91c1c", "#fca5a5") };
/** The cart line's default arrangement (private-anatomy.ts). */
const DEFAULT_LINE = [{ type: "part", part: "image" }, { type: "layout", layout: "stack", children: [{ type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "part", part: "title" }, { type: "part", part: "details" }, { type: "part", part: "inputs" }, { type: "target", target: "cart.line.after" }] }, { type: "part", part: "remove" }] }, { type: "layout", layout: "columns", children: [{ type: "part", part: "quantity" }, { type: "part", part: "price" }] }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }] }];
/**
 * The largest a line's tokens make it: a 320px image, 48px padding, a 40px title on three lines and a 28px price,
 * with the total raised to the price (no money figure outsizes the total, so the save takes the largest line only so).
 */
const LARGEST_LINE = { line: { padding: 48, "border-width": 4 }, "line-image": { width: 240, height: 320, "width-wide": 240, "height-wide": 320 }, "line-title": { size: 40, tracking: "wider", clamp: "3" }, "line-price": { size: 28 }, "summary-total": { size: 28, weight: "800" } };
const PAINT = { kind: "linear", angle: 160, stops: ["background", "muted", "secondary"] };
const DARK_PAINT = { kind: "radial", at: "top", stops: ["muted", "background", "secondary"] };
/** What a stored document forged past the save carries (none of it may draw): its words and its stylesheet's mark. */
const FORGED_WORDS = "Forged words 7Q, call 01700000000";
const FORGED_MARK = "forged-7q";
const FORGED_BLOCK = (hook) => ({ type: "content", hook, content: { kind: "text", text: { en: FORGED_WORDS } } });
/** The customer's protected cart's add-on lines (apps/storefront/src/gallery/api.ts `customerAddOns`), in order. */
const CUSTOMER_DETAILS = [
  "Protection ID will be given after order completion.",
  "Grand Theft Auto V: Premium Edition #1 · ৳350 · Protection ID XXX-XXX-XXX",
  "Grand Theft Auto V: Premium Edition #2 · ৳350 · Protection ID XXX-XXX-XXX",
];
/** The customer's look (packages/shared/src/storefront-theme/private-reference.fixture.ts): its palettes and privatePages. */
const REFERENCE = { reference: true, toggle: true, scheme: "system" };

// ─── The payment step's cases (page `checkout`) ───
/** A yellow action with black words, framed by a 2px black edge (its fill reads 1.4:1 on white; its edge 18.9:1). */
const EDGED_ACTION = { background: "#fed700", text: "#111111", border: "#111111", "border-width": 2, "border-style": "solid", radius: 0, weight: "700" };
const CHECKOUT_LIST = "payment step: the reference palettes' look, methods as a list";
const CHECKOUT_TILES = "payment step: the reference palettes' look, a narrow frame and tiles";
const CHECKOUT_FORGED = "payment step: a stored document forged with a stylesheet";
/** The payment step's look in palette roles: the summary and the methods as cards, Pay filled, the chosen method muted, the total large. */
const CHECKOUT_TOKENS = {
  page: { gradient: { shape: "radial", from: { light: "background", dark: "#2b2d6e" }, to: "background" } },
  summary: { background: "card", radius: 0, padding: 20 },
  "summary-total": { size: 20, weight: "600", text: "foreground" },
  "payment-method": { background: "card", radius: 0 },
  "payment-chosen": { background: "muted", text: "foreground", muted: "muted-foreground" },
  submit: { background: "primary", text: "primary-foreground", radius: 0, weight: "600" },
  "gift-card": { background: "card", radius: 0 },
};
const CHECKOUT_TILES_LAYOUT = [
  { type: "part", part: "progress" }, { type: "part", part: "empty" },
  { type: "layout", layout: "columns", children: [
    { type: "layout", layout: "stack", children: [{ type: "part", part: "summary", variant: "folded" }] },
    { type: "layout", layout: "stack", children: [{ type: "part", part: "heading" }, { type: "part", part: "notices" }, { type: "part", part: "gift-card" }, { type: "part", part: "payment", variant: "tiles" }, { type: "target", target: "checkout.payment.after" }, { type: "target", target: "checkout.actions.before" }] },
  ] },
];
// ─── end of the payment step's cases ───

/**
 * The named cases: the reviews' concrete breaks and this release's surfaces.
 * Each must hold when drawn (in the states it names, all of them with
 * `states: "all"`), or be refused at save with the reason it names
 * (`refused`). `privatePages` absent with `request.reference`: the customer's.
 */
const REGRESSIONS = {
  "review 3: a dark form's text reaches its fields": { privatePages: { tokens: { cart: { "details-form": { background: "#111111", text: "#ffffff", muted: "#cccccc", link: "#a78bfa", error: "#f87171" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } } },
  "review 3: two 480px columns on a phone": { privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "layout", layout: "grid", hook: "two", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }, { type: "part", part: "details" }] }] } }, tokens: { cart: { "@two": { columns: [480, 480], gap: 48 } } } } },
  // Review 4: what the contrast check modelled and the CSS did not draw.
  // A palette whose cards differ from its page: a summary drawn inside the dark panel would paint its own card there.
  "review 4, B1: tokens only, a dark lines panel over the default arrangement's summary": { request: { palette: "heritage" }, privatePages: { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } } },
  "review 4, B2: an app's warning and success badges under a dark line": { privatePages: { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } } },
  "review 4, B3: the sign-in dialog under dark dialog tokens": { privatePages: { tokens: { cart: { dialog: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } } },
  // Review 4, B4: the gate could not see the details form; a dark one, tokens only, in every state.
  "review 4, B4: tokens only, a dark details form in every state": { states: "all", privatePages: { tokens: { cart: { "details-form": DARK } } } },
  // The apps' blocks inside the details form stand on its row, and a theme styles them there by `ui.*`.
  "the apps' blocks in a dark details form, styled by target": { privatePages: { tokens: { cart: { "details-form": DARK, "ui.banner.warning/checkout.delivery.after": { background: "#3a2a0a", text: "#fde68a", border: "#f59e0b" }, "ui.button/checkout.contact.after": { background: "#7c3aed", text: "#ffffff", radius: 12 } } } } },
  // Place order sits in the dock (review 6, B3): a dark form and a dark dock around it.
  "review 4, S6: Place order's focus ring on a dark form": { privatePages: { tokens: { cart: { "details-form": DARK, dock: DARK, submit: { background: "#7c3aed", text: "#ffffff", radius: 0 } } } } },
  "review 4, S8: a 40px wide-tracked title clamped to two lines": { privatePages: { tokens: { cart: { "line-title": { size: 40, tracking: "wider", clamp: "2" } } } } },
  "review 4: every node kind under a dark summary and a dark line, in every state": { states: "all", privatePages: { tokens: { cart: { summary: DARK, lines: DARK, "ui.banner.warning/cart.line.after": { background: "#3a2a0a", text: "#fde68a", border: "#f59e0b" } } } } },
  // A dark page in a theme that shows dark colours: the dark rows write every cell the light rows write (else the
  // light lines panel's dark focus ring reads on the dark one).
  "a dark page under the dark colours": { request: { scheme: "system" }, privatePages: { tokens: { cart: { page: DARK } } } },
  "the store's own header under dark tokens": { privatePages: { tokens: { cart: { chrome: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#c4b5fd" } } } } },
  "the store's own page, no theme, in every state": { states: "all", privatePages: {} },
  // The theme's page paint (tokens.pagePaint) shows on private pages: behind the store's own page, and under tokens
  // that paint no page surface, where the table checks every word along the gradient.
  "the theme's page paint behind the store's own page": { request: { paint: PAINT }, privatePages: {} },
  "the theme's page paint under a dark summary": { request: { paint: PAINT, scheme: "light" }, privatePages: { tokens: { cart: { summary: DARK, page: { text: "#000000" } } } } },
  // A dark page paint (the dark colours' own stops): with no tokens the page is drawn in token mode, its default rows
  // computed from the paint; with tokens, those that paint no page surface stand on it too.
  "a dark page paint, no private tokens": { states: "all", request: { palette: "retail", scheme: "dark", paint: DARK_PAINT }, privatePages: {} },
  "a dark page paint under dark tokens": { request: { palette: "retail", scheme: "dark", paint: DARK_PAINT }, privatePages: { tokens: { cart: { summary: DARK, lines: DARK } } } },
  // Review 5, S4: between a deploy and the maintenance compile the default look is served: it stands on the page colour,
  // never on the theme's page paint, which no table checked it on.
  "review 5, S4: a page paint behind a look this build has not compiled": { request: { paint: PAINT, scheme: "light", stale: true }, privatePages: { tokens: { cart: { summary: DARK } } } },
  // Review 5, S5: what a line's tokens add repeats with every line. Twenty and ninety-nine lines at their largest:
  // Place order is still within reach.
  "review 5, S5: twenty and ninety-nine lines at their largest": { states: ["many", "max"], privatePages: { tokens: { cart: LARGEST_LINE } } },
  // Review 5, S6: a theme whose phone navigation is the tab bar draws none on a private page (it is the public header's).
  "review 5, S6: the phone tab bar setting, under a dark page": { request: { tabs: true }, privatePages: { tokens: { cart: { page: DARK } } } },
  // Review 5: the default look under a palette whose action colour is a mid tone. A field's focus turns its border
  // the ring colour, which must read at 3:1 on the field's own border, in the derived dark colours too.
  "review 5: the store's own page under the marketplace palette's dark colours": { request: { palette: "marketplace", scheme: "dark" }, privatePages: {} },
  // Review 6, S1: the same colours as a store saved them at version 14, its focus ring the action colour (1.6 to 2.3:1
  // on a field's border in three templates): the ring is made when the colours are read, never served from the save.
  "review 6, S1: a colour set saved with the action colour as its ring, dark": { request: { palette: "marketplace", scheme: "dark", saved: true }, privatePages: {} },
  // A filled button's hover once mixed its colour with the page (`bg-primary/90`): white on it read 4.42:1.
  "review 5: the store's own page under the marketplace palette's light colours": { request: { palette: "marketplace", scheme: "light" }, privatePages: {} },
  // Review 6, B3: the cart's parts unfolded on a phone, progress first, at one, twenty and ninety-nine lines on a 390×700
  // phone, a tablet and a laptop. Place order with its total is on screen at every scroll, the cart starts inside the
  // first screen, and the theme adds a bounded depth.
  "review 6, B3: the cart unfolded, progress first, at its largest lines": { states: LENGTHS, privatePages: { pages: { cart: {
    layout: [{ type: "part", part: "progress" }, { type: "part", part: "notices" }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "part", part: "lines", variant: "heading-above" }, { type: "part", part: "summary", variant: "with-items" }, { type: "part", part: "discount" }, { type: "target", target: "cart.page.summary" }, { type: "target", target: "cart.page.below" }, { type: "part", part: "empty" }] }, { type: "part", part: "details" }] }],
  } }, tokens: { cart: LARGEST_LINE }, labels: { "cart.intro": { en: "Review your items before checkout." }, "cart.summaryHeading": { en: "Order Summary" } } } },
  "the store's own page with one, twenty and ninety-nine lines": { states: LENGTHS, privatePages: {} },
  // An app's block on a line and in the summary, and an add-on row, each holding a 120-letter English word and a Bangla
  // one: they wrap or break inside their boxes, and the add-on's title never lies over its amount.
  "120-letter words in an app's blocks and an add-on's title, English and Bangla": { states: ["long-words"], privatePages: {} },
  "the customer's look with one, twenty and ninety-nine lines": { states: LENGTHS, request: REFERENCE },
  // The cart drawer over a public page, in the theme's arrangement: its parts on screen, its words whole and readable.
  "the theme's arrangement of the drawer, on a public page": { request: { page: "home" }, privatePages: { pages: { cartDrawer: { layout: [
    { type: "part", part: "header" },
    { type: "layout", layout: "scroll", children: [{ type: "part", part: "lines" }] },
    { type: "part", part: "undo" },
    { type: "layout", layout: "group", children: [{ type: "part", part: "summary" }, { type: "target", target: "cart_drawer.footer" }, { type: "part", part: "actions" }] },
  ] } } } },
  "the customer's protected cart in the drawer, its add-on row opened": { states: ["customer-protected"], request: { ...REFERENCE, page: "home" } },
  // Per-scheme colours (one value for the light colours, one for the dark): each palette's row resolves its own, each
  // scheme draws its own, and each is checked on its own.
  "per-scheme colours: light boxes in the light colours, dark in the dark": { request: { scheme: "system", toggle: true }, privatePages: { tokens: { cart: {
    page: { background: SCHEMED("#f8f5ff", "#0b0a12") }, lines: BY_SCHEME, summary: BY_SCHEME, "details-form": BY_SCHEME, dock: BY_SCHEME, dialog: BY_SCHEME,
    input: { ring: SCHEMED("#6d28d9", "#a78bfa"), invalid: SCHEMED("#b91c1c", "#f87171") },
    "ui.stack.warning/cart.line.after": { background: SCHEMED("#f2ebd9", "#35282c"), text: SCHEMED("#000000", "#fef3c6") },
  } } } },
  // This release's parts: the heading above the lines with its intro, the summary's heading and Items row, the details
  // as values and as chips, the word Remove, the dialogs' own targets and the field labels.
  "the cart's variants, labels and new style targets": { states: ["base", "lines"], privatePages: { pages: { cart: {
    layout: [{ type: "part", part: "notices" }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines", variant: "heading-above" }, { type: "part", part: "summary", variant: "with-items" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }] }, { type: "part", part: "details" }] }],
    items: { line: [{ type: "part", part: "image" }, { type: "layout", layout: "stack", children: [{ type: "part", part: "details", variant: "chips" }, { type: "part", part: "title" }, { type: "part", part: "inputs" }, { type: "target", target: "cart.line.after" }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }] }, { type: "layout", layout: "stack", children: [{ type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove", variant: "words" }] }] },
  } }, tokens: { cart: {
    "lines-heading": { size: 32, weight: "700", leading: "tight" }, "lines-intro": { size: 14, leading: "relaxed" }, "summary-heading": { size: 20, weight: "600", font: "heading" },
    "summary-total-label": { size: 16, weight: "600", case: "uppercase", tracking: "wide" }, "summary-total": { size: 24, weight: "800" },
    "line-chip": { background: SCHEMED("#ede9fe", "#2e1065"), text: SCHEMED("#2e1065", "#ede9fe"), radius: 12, "border-width": 1 }, "line-remove": { size: 14, weight: "600" },
    "field-label": { size: 12, weight: "600", case: "uppercase", tracking: "wide" }, "summary-add-on-detail": { font: "mono", size: 12, background: SCHEMED("#f5f3ff", "#1e1831"), text: SCHEMED("#111111", "#f4f1ff"), muted: SCHEMED("#3f3f46", "#d4d4d8"), padding: 8 },
    "dialog-title": { size: 24, weight: "800", leading: "tight" }, "dialog-text": { background: SCHEMED("#f5f3ff", "#110d1e"), text: SCHEMED("#111111", "#d4d4d8"), muted: SCHEMED("#3f3f46", "#d4d4d8"), padding: 16 }, "dialog-agree": { background: SCHEMED("#ede9fe", "#241b39"), text: SCHEMED("#111111", "#e4e4e7"), padding: 16 },
  } }, labels: { "cart.heading": { en: "Your Cart", bn: "আপনার কার্ট" }, "cart.intro": { en: "Review your items before checkout.", bn: "চেকআউটের আগে পণ্যগুলো দেখে নিন।" }, "cart.summaryHeading": { en: "Order Summary", bn: "অর্ডারের সারাংশ" } } } },
  "a line's details as its values on one line": { privatePages: { pages: { cart: { items: { line: [{ type: "part", part: "image" }, { type: "layout", layout: "stack", children: [{ type: "part", part: "details", variant: "values" }, { type: "part", part: "title" }, { type: "part", part: "inputs" }, { type: "target", target: "cart.line.after" }, { type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove" }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }] }] } } } } },
  // Where the theme places the store's controls (`privatePages.controls`), in a store with the light or dark switch
  // and two markets: in its checkout header, in a strip at the page's end, or not at all.
  "the store's controls in its checkout header, no tokens": { request: { toggle: true, localization: true, scheme: "system" }, privatePages: { controls: "header" } },
  "the store's controls at the page's end, under per-scheme tokens": { request: { toggle: true, localization: true, scheme: "system" }, privatePages: { controls: "footer", tokens: { cart: {
    page: { background: SCHEMED("#ffffff", "#111111") }, chrome: { background: SCHEMED("#f5f3ff", "#1e1831"), text: SCHEMED("#111111", "#ffffff"), muted: SCHEMED("#3f3f46", "#d4d4d8"), link: SCHEMED("#5b21b6", "#c4b5fd") },
    scheme: { ring: SCHEMED("#5b21b6", "#c4b5fd") }, localization: { text: SCHEMED("#111111", "#ffffff") },
  } } } },
  // A store that asks for its terms: the required tick box and its words on screen, reached by Tab, its ring and its
  // words readable, in the light colours and the dark, on a dark details form.
  "the required terms box, light and dark": { request: { terms: true, scheme: "system", toggle: true }, privatePages: { tokens: { cart: { "details-form": BY_SCHEME, input: { ring: SCHEMED("#6d28d9", "#a78bfa"), invalid: SCHEMED("#b91c1c", "#f87171") } } } } },
  "no store controls on the page, under dark tokens": { request: { toggle: true, localization: true, scheme: "system" }, privatePages: { controls: "none", tokens: { cart: { page: DARK } } } },
  // The customer's cart (private-look.md 2.1, 2.2, 3) in its own look, light and dark, at 390 and 1280: offered its
  // protection, and protected on two accounts with the add-on row opened.
  "the customer's cart, its protection offered": { states: ["customer"], request: REFERENCE },
  "the customer's cart, protected": { states: ["customer-protected"], request: REFERENCE },
  // Review P1: lines, summary and details in one `columns` with twenty empty groups beside them. Refused at save, or
  // drawn with every part at its floor (never twenty-four squeezed tracks).
  "review P1: a wide columns layout of twenty-four tracks": { mayRefuse: /columns|track|layout/i, privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "layout", layout: "columns", children: [
    { type: "layout", layout: "stack", children: [{ type: "part", part: "lines" }] }, { type: "layout", layout: "stack", children: [{ type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] },
    { type: "layout", layout: "stack", children: [{ type: "part", part: "details" }] }, { type: "target", target: "cart.page.below" }, ...Array.from({ length: 20 }, () => ({ type: "layout", layout: "group", children: [] })),
  ] }] } }, tokens: { cart: { "summary-total": { size: 20 } } } } },
  // A stored document forged past the save (a row edited by hand): content blocks in the page and the line, a
  // stylesheet, the theme's chrome and its search. The store reads it with all of that dropped and its private pages'
  // compile refused: the theme stays (its light or dark switch is drawn), its cart draws the default look with no
  // free region, none of its words and none of its CSS, and every check holds.
  "a stored document forged past the save": { request: { toggle: true, scheme: "system", forged: {
    pages: { cart: { layout: [FORGED_BLOCK("forged-page"), ...LEGAL_COLUMNS], items: { line: [...DEFAULT_LINE, FORGED_BLOCK("forged-line")] } } },
    css: `/*${FORGED_MARK}*/[data-part="summary"]{display:none}body::after{content:"${FORGED_WORDS}"}`, chrome: "theme", search: "after", assets: { "pp/a.svg": "x" },
  } }, privatePages: { tokens: { cart: { summary: DARK } } } },
  // What the save must refuse (under a mutation that lets one through, the drawing must fail).
  "a theme's stylesheet, chrome, search and blocks": { refused: "not_available", privatePages: { css: '[data-part="summary"] { display: none }', chrome: "theme", search: "after", pages: { cart: { layout: [FORGED_BLOCK("intro"), ...LEGAL_COLUMNS] } } } },
  "summary rows that do not read on their summary": { refused: "contrast", refusedFor: /summary-rows/, privatePages: { tokens: { cart: { "summary-rows": { text: "#eeeeee" }, summary: { background: "#ffffff" } } } } },
  // #757575 reads on retail's white page (4.6:1) but not where the paint reaches its muted colour (3.9:1).
  "page words that do not read on the theme's page paint": { refused: "contrast", request: { palette: "retail", scheme: "light", paint: PAINT }, privatePages: { tokens: { cart: { page: { text: "#757575" } } } } },
  // Per scheme: readable in the light colours (the total's own #1d1c1a, so the rows never outread the total), #333333
  // on #111111 (1.66:1) in the dark: refused for that pair alone.
  "per-scheme words that do not read in the dark": { refused: "contrast", refusedFor: /summary-rows.*#333333 on #111111.*dark colours/, request: { scheme: "system", toggle: true }, privatePages: { tokens: { cart: { summary: { background: SCHEMED("#ffffff", "#111111") }, "summary-rows": { text: SCHEMED("#1d1c1a", "#333333") } } } } },
  // A button with no surface of its own in an app's amber box under a dark line: white words read on the line
  // (18.9:1), not on the amber (1.3:1). Its row stands on the box.
  "an app's button with white words in a light amber box on a dark line": { refused: "contrast", refusedFor: /ui\.button\/cart\.line\.after.*#ffffff on #fde68a/, privatePages: { tokens: { cart: { lines: DARK, "ui.stack.warning/cart.line.after": { background: "#fde68a", text: "#111111" }, "ui.button/cart.line.after": { text: "#ffffff" } } } } },
  // The total outranks every other summary row: a 12px total under 18px rows is refused (`prominence`).
  "a total drawn smaller than its rows": { refused: "prominence", refusedFor: /summary-total/, privatePages: { tokens: { cart: { "summary-total": { size: 12 }, "summary-rows": { size: 18 } } } } },
  // Nor lighter or fainter: the amount muted at normal weight under rows in the words' colour, and a 40px label over it.
  "a total drawn lighter and fainter than its rows": { refused: "prominence", refusedFor: /summary-total/, privatePages: { tokens: { cart: { "summary-total": { weight: "400", text: "muted-foreground" }, "summary-rows": { text: "foreground" } } } } },
  "a total's label drawn over its amount": { refused: "prominence", refusedFor: /summary-total-label is drawn at 40px|summary-total is drawn at 20px, under summary-total-label/, privatePages: { tokens: { cart: { "summary-total-label": { size: 40 } } } } },
  // Place order as plain words: filled with the dock's own colour, small and light beside the store's filled buttons.
  "Place order drawn as plain words": { refused: "contrast", refusedFor: /submit: its fill/, privatePages: { tokens: { cart: { submit: { background: "background", text: "foreground" } } } } },
  "Place order smaller and lighter than the other filled buttons": { refused: "prominence", refusedFor: /submit is drawn at/, privatePages: { tokens: { cart: { submit: { size: 12, weight: "400" } } } } },
  // The decision's buttons swapped: Confirm drawn as Go back (its fill the dialog's, muted, smaller), in the dialog.
  "Confirm drawn as Go back": { refused: "contrast", refusedFor: /dialog-confirm: its fill/, states: ["lines"], privatePages: { tokens: { cart: { "dialog-confirm": { background: "card", text: "muted-foreground", "border-width": 0 } } } } },
  "Go back filled as Confirm": { refused: "unknown_token", refusedFor: /dialog-back takes/, states: ["lines"], privatePages: { tokens: { cart: { "dialog-back": { background: "primary", text: "primary-foreground" } } } } },
  "Confirm smaller and lighter than Go back": { refused: "prominence", refusedFor: /dialog-confirm is drawn at/, states: ["lines"], privatePages: { tokens: { cart: { "dialog-back": { weight: "700" }, "dialog-confirm": { size: 12, weight: "400" } } } } },
  // A field or the stepper that draws no border and fills itself with its box's colour: nothing shows where it is.
  "a borderless field the colour of its card form": { refused: "contrast", refusedFor: /input .*its fill, with no border drawn/, privatePages: { tokens: { cart: { "details-form": { background: "card" }, input: { "border-width": 0, background: "card" } } } } },
  "a borderless stepper on its line": { refused: "contrast", refusedFor: /line-quantity: its fill, with no border drawn/, privatePages: { tokens: { cart: { "line-quantity": { "border-width": 0 } } } } },
  // A filled action found by a drawn edge (WCAG 1.4.11 by its boundary): a yellow fill reading under 3:1 on a white dock,
  // framed by a 2px #111111 border. Drawn as Place order, as Confirm in the dialog and as Pay on the payment step's card.
  "Place order brand fill with a drawn edge": { request: { scheme: "light" }, states: ["base", "lines"], privatePages: { tokens: { cart: { dock: { background: "#ffffff" }, submit: EDGED_ACTION, dialog: { background: "#ffffff" }, "dialog-confirm": EDGED_ACTION } } } },
  "Pay brand fill with a drawn edge": { request: { ...REFERENCE, scheme: "light", page: "sample-checkout" }, states: ["base"], privatePages: { tokens: { checkout: { ...CHECKOUT_TOKENS, "payment-details": { background: "#ffffff" }, submit: EDGED_ACTION } } } },
  // Refused: an edge around the dock's own colour (nothing inside the frame reads as a button), and a 1px edge.
  "Place order the dock's colour behind a dark edge": { refused: "contrast", refusedFor: /submit/, request: { scheme: "light" }, privatePages: { tokens: { cart: { dock: { background: "#ffffff" }, submit: { ...EDGED_ACTION, background: "#ffffff" } } } } },
  "Pay brand fill with a 1px edge": { refused: "contrast", refusedFor: /submit/, request: { ...REFERENCE, scheme: "light", page: "sample-checkout" }, states: ["base"], privatePages: { tokens: { checkout: { ...CHECKOUT_TOKENS, "payment-details": { background: "#ffffff" }, submit: { ...EDGED_ACTION, "border-width": 1 } } } } },
  "Place order brand fill with a 1px edge": { refused: "contrast", refusedFor: /submit/, request: { scheme: "light" }, privatePages: { tokens: { cart: { dock: { background: "#ffffff" }, submit: { ...EDGED_ACTION, "border-width": 1 } } } } },
  // ─── The payment step (page `checkout`): drawn as the editor's sample checkout draws it, as buyers get it ───
  [CHECKOUT_LIST]: { request: { ...REFERENCE, page: "sample-checkout" }, privatePages: { tokens: { checkout: CHECKOUT_TOKENS } }, states: ["base"] },
  [CHECKOUT_TILES]: { request: { ...REFERENCE, page: "sample-checkout" }, privatePages: { pages: { checkout: { frame: "narrow", layout: CHECKOUT_TILES_LAYOUT } }, tokens: { checkout: CHECKOUT_TOKENS } }, states: ["base"] },
  [CHECKOUT_FORGED]: { request: { page: "sample-checkout", forged: { css: `[data-private="checkout"] *{color:transparent} /* ${FORGED_MARK} */` } }, states: ["base"] },
  // ─── end of the payment step ───
};

// ─── The receipt and the account (w-p2-after-pages) ───────────────────────
// Their look by tokens, their parts in the store's order, drawn on the theme
// editor's sample receipt and sample account: the receipt's components and the account shell with its order cards.
// The customer's palettes, its card surfaces and its emerald total in the dark, light and dark, at 390 and 1280.

/** Each after-order page: its gallery page, its key, its root and what a buyer must see there. */
const AFTER_ORDER_PAGES = {
  "sample-receipt": {
    page: "receipt", root: '[data-private="receipt"]',
    mandatory: ['[data-part="status-title"]', '[data-part="order-number"]', '[data-summary-row="total"]', '[data-part="delivery-contact"]', '[data-part="lines"]'],
  },
  "sample-account": {
    page: "account", root: '[data-private="account"]',
    mandatory: ['[data-part="navigation"]', '[data-part="sign-out"]', '[data-part="heading-title"]', '[data-part="card"]'],
  },
};
const CARD_LOOK = { background: "card", radius: 0, "border-width": 0, shadow: "lg" };
const EMERALD_TOTAL = { text: "foreground", size: 20, weight: "600" };
const RECEIPT_LOOK = {
  order: CARD_LOOK, delivery: CARD_LOOK, lines: CARD_LOOK, "summary-total": EMERALD_TOTAL,
  "summary-total-label": { text: "foreground", size: 16, weight: "600" }, "status-badge": { radius: 0 }, "status-title": { size: 30, weight: "600" },
};
const ACCOUNT_LOOK = {
  card: CARD_LOOK, "nav-current": { text: "foreground", weight: "600" }, "sign-out": { background: "muted", radius: 0, weight: "600" },
  "heading-title": { size: 24, weight: "600" }, "status-badge": { radius: 0 }, "summary-total": EMERALD_TOTAL,
};
const AFTER_ORDER_CASES = {
  "the receipt in the customer's look": { request: { ...REFERENCE, page: "sample-receipt" }, privatePages: { tokens: { receipt: RECEIPT_LOOK } } },
  "the account in the customer's look": { request: { ...REFERENCE, page: "sample-account" }, privatePages: { tokens: { account: ACCOUNT_LOOK } } },
  // A receipt document forged past the save: a stylesheet hiding the total and a content block. None of it draws.
  "the receipt forged past the save": { request: { toggle: true, scheme: "system", page: "sample-receipt", forged: {
    pages: { receipt: { layout: [FORGED_BLOCK("forged-page")] } },
    css: `/*${FORGED_MARK}*/[data-summary-row="total"]{display:none}body::after{content:"${FORGED_WORDS}"}`, chrome: "theme",
  } }, privatePages: { tokens: { receipt: RECEIPT_LOOK } } },
  // What the save must refuse: an arrangement of a page that keeps the store's order, and a total under its rows.
  "an arrangement of the receipt": { refused: "not_available", request: { page: "sample-receipt" }, privatePages: { pages: { receipt: { layout: [{ type: "part", part: "summary" }, { type: "part", part: "status" }] } } } },
  "a receipt total drawn smaller than its rows": { refused: "prominence", refusedFor: /summary-total/, request: { page: "sample-receipt" }, privatePages: { tokens: { receipt: { "summary-total": { size: 14 } } } } },
};
Object.assign(REGRESSIONS, AFTER_ORDER_CASES);

// ─── PNG pixels (Chromium's 8-bit RGB or RGBA screenshots) ────────────────

function decode(png) {
  let at = 8;
  let width = 0, height = 0, type = 0;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9]; }
    if (kind === "IDAT") data.push(body);
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const channels = type === 6 ? 4 : 3;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    const here = y * stride;
    const above = here - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[row + x];
      const left = x >= channels ? out[here + x - channels] : 0;
      const up = y > 0 ? out[above + x] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const corner = x >= channels && y > 0 ? out[above + x - channels] : 0;
        const p = left + up - corner;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      out[here + x] = (value + predicted) & 255;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * A text's contrast is its worst pixel behind it, with no budget (measured: three runs of a named case and a page
 * paint case found no text under its floor at the minimum that passed at the 5th percentile). A field's value or
 * placeholder alone is read at its 5th-percentile pixel less 0.05: its box is the field's padding box, which also
 * holds the field's own drawing (its inset ring and edge), read at 1.0 to 2.2:1 at the minimum.
 */
const FIELD_QUANTILE = 0.05;
const FIELD_BUDGET = 0.05;
const pixelAt = (image, x, y) => {
  const at = (y * image.width + x) * image.channels;
  return [image.data[at], image.data[at + 1], image.data[at + 2]];
};

const LINEAR = Array.from({ length: 256 }, (_, channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const luminance = ([r, g, b]) => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const rgb = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

// ─── In the page ───────────────────────────────────────────────────────────

const MANDATORY = ['[data-part="lines"]', '[data-part="line-title"]', '[data-part="line-price"]', '[data-part="line-quantity"]', '[data-part="line-remove"]', '[data-part="summary"]', "#subtotal", "#total", '[data-part="details-form"]', '[data-part="contact"]', '[data-part="details-submit"]'];
const EMPTY_MANDATORY = ['[data-part="lines"]', '[data-part="cart-empty"]'];
/** The lines state's cart also holds a store kit (one line, its add-on once per kit) and an app's offer row under it. */
const KIT_LINE = '[data-part="line"][data-line-key="line:v3:prod_7:variant:var_kit_7:p:none"]';
const LINES_MANDATORY = [...MANDATORY, KIT_LINE, `${KIT_LINE} [data-buyer-ui-app="acme.offers"] [data-ui="button"]`];

/**
 * Not the store's buyer-facing page: the gallery's own scaffolding and text no
 * buyer sees (scripts, styles, templates). Listed here and nowhere else.
 */
const EXEMPT = "script,style,template,noscript,#gallery-page-end,vite-error-overlay";

/**
 * The walk over the page (or one open dialog): marks every text and control
 * the host draws, checks each against the colour table (or, with no tokens,
 * the anatomy's style targets) and returns them for the pixel checks.
 */
function walk({ rows, anatomy, uiKinds, mandatory, scope, exempt, styleTargets }) {
  const problems = [];
  const width = innerWidth;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { problems: [`${scope}: not open`], texts: [], controls: [] };
  if (document.documentElement.scrollWidth > width + 1) problems.push(`the page scrolls sideways: ${document.documentElement.scrollWidth}px at ${width}px`);
  // A theme writes no markup here: nothing on the page is a theme's free region.
  for (const region of document.querySelectorAll("[data-free]")) problems.push(`[data-free="${region.dataset.free}"]: a theme's free region is drawn`);
  const name = (element) => {
    const bits = [];
    for (let at = element; at && at !== document.body && bits.length < 3; at = at.parentElement) {
      bits.unshift(`${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}${at.dataset.part ? `[data-part=${at.dataset.part}]` : ""}${at.dataset.ui ? `[data-ui=${at.dataset.ui}]` : ""}`);
    }
    return bits.join(">");
  };
  for (const old of document.querySelectorAll("[data-pt-text],[data-pt-control]")) { old.removeAttribute("data-pt-text"); old.removeAttribute("data-pt-control"); }
  // Mandatory parts: on screen, within reach, of a size, uncovered at their centre.
  for (const selector of mandatory) {
    const element = root.querySelector(selector);
    if (!element) { problems.push(`${selector}: missing`); continue; }
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const box = element.getBoundingClientRect();
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || box.width < 8 || box.height < 8) { problems.push(`${selector}: not visible (${Math.round(box.width)}×${Math.round(box.height)})`); continue; }
    if (box.left < -1 || box.right > width + 1) problems.push(`${selector}: outside the viewport (${Math.round(box.left)}..${Math.round(box.right)} of ${width})`);
    const [x, y] = [Math.min(width - 1, Math.max(0, box.left + box.width / 2)), Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2))];
    const hit = document.elementFromPoint(x, y);
    if (hit && !element.contains(hit) && !hit.contains(element)) problems.push(`${selector}: covered at its centre by ${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${hit.dataset.part ? `[data-part=${hit.dataset.part}]` : ""}`);
  }
  // The rows: each element its last matching row (the table's CSS is in row order at one specificity).
  const rowOf = new Map();
  for (const row of rows) for (const element of document.querySelectorAll(row.selector)) rowOf.set(element, row);
  const claimOf = new Map();
  for (const target of anatomy) for (const element of document.querySelectorAll(target.selector)) if (!claimOf.has(element)) claimOf.set(element, target.name);
  const tokenMode = rows.length > 0;
  // Every element a style target names is drawn by a row of that target (its own, or one the table places it at:
  // `input/details-form`, `ui.button/… in …`), never only by the row of the box around it.
  if (tokenMode) {
    for (const target of styleTargets) {
      for (const element of document.querySelectorAll(target.selector)) {
        if (element.closest(exempt) || !element.checkVisibility()) continue;
        const own = rowOf.get(element);
        const names = styleTargets.filter((each) => element.matches(each.selector)).map((each) => each.name);
        const ownTarget = own?.key.split(/\/| in /)[0];
        if (!own || !names.includes(ownTarget)) problems.push(`${name(element)}: the style target ${target.name} names it and no row of the table is its (${own ? `it reads ${own.key}` : "it has no row"})`);
      }
    }
  }
  const nearestRow = (element) => { for (let at = element; at; at = at.parentElement) if (rowOf.has(at)) return at; return null; };
  const nearestClaim = (element) => { for (let at = element; at; at = at.parentElement) if (claimOf.has(at)) return at; return null; };
  const paints = (element) => { const style = getComputedStyle(element); return !/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(style.backgroundColor) || style.backgroundImage !== "none"; };
  const parse = (value) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
    return hex ? `rgb(${parseInt(hex[1].slice(0, 2), 16)}, ${parseInt(hex[1].slice(2, 4), 16)}, ${parseInt(hex[1].slice(4), 16)})` : value.trim();
  };
  // A row's words' colours as the table resolved them, never as the CSS wrote them (a rule that leaves a cell out
  // must not make the words it leaves look right). A row that writes only some cells (an app's node, a label) takes
  // the others from the row its element stands in, as the CSS inherits them.
  const cellsOf = (row) => ["text", "muted", "link", "error"].map((cell) => {
    for (let at = row; at; at = at.parentElement) {
      const cells = rowOf.get(at);
      if (cells && (!cells.writes || cells.writes.includes(cell))) return parse(cells[cell] ?? "");
    }
    return "";
  });
  const claimed = new Set();
  // A row's own element paints its row's paint or nothing (a nested row shows its parent's): a palette class
  // that paints over the table's surface is a surface the table does not know.
  const painted = new Set();
  const checkPaint = (element) => {
    if (painted.has(element)) return;
    painted.add(element);
    const row = rowOf.get(element);
    const style = getComputedStyle(element);
    const clear = /^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(style.backgroundColor);
    if (!clear && !row.gradient && style.backgroundColor !== parse(row.paint ?? "")) problems.push(`${name(element)}: paints ${style.backgroundColor} where its row (${row.key}) paints ${row.paint ?? "nothing"}`);
    if (style.backgroundImage !== "none" && !row.gradient) problems.push(`${name(element)}: paints an image its row (${row.key}) does not`);
  };
  // The page itself: in token mode its row paints the body (the theme's page paint included); with no
  // tokens nothing may paint it but the page colour, or what stands on it would go unchecked at save.
  if (tokenMode && rowOf.has(document.body)) checkPaint(document.body);
  if (!tokenMode) {
    const body = getComputedStyle(document.body);
    const page = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
    if (body.backgroundImage !== "none" || (/^#[0-9a-f]{6}$/i.test(page) && body.backgroundColor !== parse(page))) {
      problems.push(`the page shows a paint of its own (${body.backgroundImage !== "none" ? body.backgroundImage.slice(0, 60) : body.backgroundColor}) and no colour table checks what stands on it`);
    }
  }
  /** The coverage walk for one element that draws text or takes focus. */
  const claim = (element, what) => {
    if (claimed.has(element)) return true;
    claimed.add(element);
    if (!tokenMode) {
      if (!nearestClaim(element)) { problems.push(`${what} ${name(element)}: no style target claims it`); return false; }
      return true;
    }
    const row = nearestRow(element);
    if (!row) { problems.push(`${what} ${name(element)}: no row of the colour table claims it`); return false; }
    checkPaint(row);
    // An app's node of a kind a theme styles (`ui.<kind>…/<target>`) is claimed by its own row at its target, never
    // only by the box its block sits in (else the theme's tokens for it would style nothing the table checks).
    const node = element.closest(uiKinds.join(","));
    const mount = node?.closest("[data-buyer-ui-target]");
    if (node && mount && !mount.contains(row)) { problems.push(`${what} ${name(element)}: an app's node at ${mount.dataset.buyerUiTarget} has no row of its own (it reads ${rowOf.get(row).key})`); return false; }
    for (let at = element; at && at !== row; at = at.parentElement) {
      if (paints(at) && !at.matches("input,select,textarea")) { problems.push(`${what} ${name(element)}: ${name(at)} paints ${getComputedStyle(at).backgroundColor} under it and no row of the table claims that surface (its row: ${rowOf.get(row).key})`); return false; }
    }
    return true;
  };
  const hidden = (element) => element.closest(exempt) || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  // Every text: per text node, in the page or the open dialog (kept for the pixel pass, which reads its boxes afresh).
  const texts = [];
  window.__ptTexts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const element = node.parentElement;
    if (!element || hidden(element)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((rect) => rect.width >= 2 && rect.height >= 4);
    if (rects.length === 0) continue;
    const style = getComputedStyle(element);
    // Visually hidden (sr-only) words are read out, not seen.
    if (style.clipPath !== "none" || style.clip !== "auto" || element.closest(".sr-only:not(:focus,:focus-within)")) continue;
    if (!claim(element, `text "${node.textContent.trim().slice(0, 30)}"`)) continue;
    if (tokenMode) {
      const row = nearestRow(element);
      const cells = cellsOf(row);
      if (!cells.includes(style.color) && !element.closest(":disabled,[aria-disabled=true]")) problems.push(`text "${node.textContent.trim().slice(0, 30)}" ${name(element)}: ${style.color} is none of its row's colours (${rowOf.get(row).key}: ${cells.join(" ")})`);
    }
    if (element.closest(":disabled,[aria-disabled=true]")) continue;
    const id = texts.length;
    const size = Number.parseFloat(style.fontSize);
    texts.push({ id, label: `"${node.textContent.trim().slice(0, 30)}" ${name(element)}`, color: style.color, large: size >= 24 || (size >= 18.6 && Number(style.fontWeight) >= 700) });
    window.__ptTexts.push({ node, element });
    if (!element.dataset.ptText) element.dataset.ptText = String(id);
  }
  // Fields draw their value or placeholder as text too.
  for (const field of root.querySelectorAll('input:not([type=hidden],[type=checkbox],[type=radio],[type=file]),textarea,select')) {
    if (hidden(field) || field.disabled) continue;
    const box = field.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    claim(field, "field");
    const style = getComputedStyle(field);
    const shows = field.tagName === "SELECT" ? field.selectedOptions[0]?.textContent?.trim() : field.value || field.placeholder;
    if (!shows) continue;
    const placeholder = field.tagName !== "SELECT" && !field.value;
    const color = placeholder ? getComputedStyle(field, "::placeholder").color : style.color;
    texts.push({ id: texts.length, label: `${placeholder ? "placeholder" : "value"} of ${name(field)}`, color, large: false, field: true });
    window.__ptTexts.push({ field, element: field });
  }
  // Every control a buyer can reach.
  const controls = [];
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])';
  for (const control of root.querySelectorAll(FOCUSABLE)) {
    if (control.disabled || control.closest("[inert],fieldset:disabled") || control.closest(exempt)) continue;
    let target = control;
    const box = control.getBoundingClientRect();
    if (box.width < 4 || box.height < 4 || !control.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      // A visually hidden box or radio drawn by its label: the label takes the click.
      const label = control.labels?.[0];
      if (!control.matches("input[type=checkbox],input[type=radio]") || !label || !label.checkVisibility()) continue;
      target = label;
    }
    if (!claim(control, "control")) continue;
    if (tokenMode && control === target && paints(control) && !rowOf.has(control) && !control.matches("input,select,textarea")) {
      problems.push(`control ${name(control)}: paints ${getComputedStyle(control).backgroundColor} and no row of the table claims it`);
    }
    const id = controls.length;
    control.dataset.ptControl = String(id);
    if (target !== control) target.dataset.ptControlLabel = String(id);
    const row = tokenMode ? nearestRow(control) : null;
    controls.push({ id, label: name(control), viaLabel: target !== control, field: control.matches("input,select,textarea"), radio: control.matches("input[type=radio]") ? control.name : null, group: `${row ? rowOf.get(row).key : ""}|${nearestRow(control.parentElement ?? control) ? rowOf.get(nearestRow(control.parentElement ?? control)).key : ""}|${control.tagName}|${control.className}|${control.type ?? ""}` });
  }
  return { problems, texts, controls };
}

/** Every text whole: nothing cut sideways, no glyph cut by a clip, no word broken inside itself. */
function wholeTexts() {
  const problems = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const word = /[\p{L}\p{N}\p{M}]/u;
  const clipOf = (element) => {
    for (let at = element; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX !== "visible" || style.overflowY !== "visible" || /paint|strict|content/.test(style.contain)) {
        return { element: at, scrolls: /auto|scroll/.test(style.overflowX + style.overflowY), box: at.getBoundingClientRect() };
      }
    }
    return null;
  };
  // A word wider than the box it is set in (a 120-letter word on a phone) can only break inside itself: allowed.
  const widerThanItsBox = (node, at, element) => {
    const text = node.textContent;
    let [start, end] = [at, at];
    while (start > 0 && word.test(text[start - 1])) start -= 1;
    while (end < text.length && word.test(text[end])) end += 1;
    let box = element;
    while (box.parentElement && getComputedStyle(box).display.startsWith("inline")) box = box.parentElement;
    const room = box.clientWidth - Number.parseFloat(getComputedStyle(box).paddingLeft) - Number.parseFloat(getComputedStyle(box).paddingRight);
    // The word's own width: the widths of the pieces it is drawn in, end to end.
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return [...range.getClientRects()].reduce((sum, rect) => sum + rect.width, 0) > room + 1;
  };
  const seen = new Set();
  for (const element of document.querySelectorAll("[data-pt-text]")) {
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const label = `"${node.textContent.trim().slice(0, 30)}"`;
      const clip = clipOf(element);
      if (clip && !clip.scrolls && !seen.has(clip.element)) {
        seen.add(clip.element);
        if (clip.element.scrollWidth > clip.element.clientWidth + 1 && getComputedStyle(clip.element).overflowX !== "visible") problems.push(`${label}: cut sideways (${clip.element.scrollWidth}px of text in ${clip.element.clientWidth}px)`);
      }
      const range = document.createRange();
      let previous = null;
      let offset = 0;
      for (const { segment } of segmenter.segment(node.textContent)) {
        range.setStart(node, offset);
        range.setEnd(node, offset + segment.length);
        offset += segment.length;
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // A line a clamp hides lies wholly outside its clip: not drawn, nothing a buyer reads (its words, as Chrome lays
        // out a clamped box's hidden lines, may break anywhere).
        if (clip && !clip.scrolls && (rect.top >= clip.box.bottom - 1 || rect.bottom <= clip.box.top + 1)) { previous = null; continue; }
        if (clip && !clip.scrolls) {
          const sideways = rect.left < clip.box.left - 1 || rect.right > clip.box.right + 1;
          const cut = (rect.top < clip.box.top - 1 && rect.bottom > clip.box.top + 1) || (rect.top < clip.box.bottom - 1 && rect.bottom > clip.box.bottom + 1);
          if (sideways && rect.bottom > clip.box.top && rect.top < clip.box.bottom) { problems.push(`${label}: "${segment}" is cut off at the side`); break; }
          if (cut) { problems.push(`${label}: "${segment}" is cut through by its box`); break; }
        }
        if (previous && word.test(previous.segment) && word.test(segment) && rect.top >= previous.rect.bottom - 2 && !widerThanItsBox(node, offset - segment.length, element)) {
          problems.push(`${label}: a word breaks inside itself ("${previous.segment}|${segment}")`);
          break;
        }
        previous = { segment, rect };
      }
    }
  }
  return problems;
}

/** Each control takes a click at its centre (the topmost element there is it, or inside it). */
function clicks() {
  const problems = [];
  for (const control of document.querySelectorAll("[data-pt-control]")) {
    const target = document.querySelector(`[data-pt-control-label="${control.dataset.ptControl}"]`) ?? control;
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    // A link that wraps is clicked on its longest line's words.
    const box = [...target.getClientRects()].sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? target.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) { problems.push(`control ${control.tagName.toLowerCase()}#${control.id}: its centre is off screen`); continue; }
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(target.contains(hit) || hit.contains(target) && hit.closest("label") === target)) {
      problems.push(`control ${control.tagName.toLowerCase()}${control.id ? `#${control.id}` : ""}[${control.dataset.part ?? control.textContent.trim().slice(0, 20)}]: a click at its centre lands on ${hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}` : "nothing"}`);
    }
  }
  return problems;
}

/**
 * An app's words and an add-on row stay in their boxes: every text under an app's block lies inside the block, and
 * an add-on row's title lies inside its bar and clear of its amount (a 120-letter word wraps or breaks, never runs out).
 */
function appsFit() {
  const problems = [];
  const rectsOf = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || !node.parentElement?.checkVisibility() || node.parentElement.closest(".sr-only")) continue;
      // Word by word: a space at a line's end may hang past the box (CSS lets it), a word may not.
      for (const word of node.textContent.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        for (const rect of range.getClientRects()) if (rect.width >= 1) out.push({ text: word[0].slice(0, 24), rect });
      }
    }
    return out;
  };
  const inside = (rect, box) => rect.left >= box.left - 1 && rect.right <= box.right + 1;
  for (const block of document.querySelectorAll('[data-private="cart"] [data-buyer-ui-app]')) {
    if (!block.checkVisibility()) continue;
    const box = block.getBoundingClientRect();
    const out = rectsOf(block).find(({ rect }) => !inside(rect, box));
    if (out) problems.push(`"${out.text}" in ${block.dataset.buyerUiApp}'s block runs out of it (${Math.round(out.rect.left)}..${Math.round(out.rect.right)} in ${Math.round(box.left)}..${Math.round(box.right)})`);
  }
  for (const row of document.querySelectorAll('[data-private="cart"] [data-summary-row="add-on"]')) {
    const bar = row.matches("details") ? row.querySelector(":scope > summary") : row;
    if (!bar?.checkVisibility()) continue;
    const [title, amount] = [bar.firstElementChild, bar.lastElementChild];
    if (!title || !amount || title === amount) continue;
    const box = bar.getBoundingClientRect();
    const money = amount.getBoundingClientRect();
    for (const { text, rect } of rectsOf(title)) {
      if (!inside(rect, box)) { problems.push(`the add-on row's title "${text}" runs out of its bar`); break; }
      if (rect.left < money.right - 1 && rect.right > money.left + 1 && rect.top < money.bottom - 1 && rect.bottom > money.top + 1) { problems.push(`the add-on row's title "${text}" lies over its amount`); break; }
    }
    if (!inside(money, box)) problems.push("the add-on row's amount runs out of its bar");
  }
  return problems;
}

/**
 * Every part of the page at its floor: the lines, the summary and the details form each at least as wide as a page
 * track's floor (20rem) or the cart's own width where that is less, as the columns promise.
 */
function partsAtFloor() {
  const cart = document.querySelector('[data-private="cart"]');
  if (!cart) return [];
  const style = getComputedStyle(cart);
  const room = cart.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  // 8px of slack: a part's own margin or border inside the cart's width.
  const floor = Math.min(320, room) - 8;
  const problems = [];
  for (const part of ["lines", "summary", "details-form"]) {
    const element = cart.querySelector(`[data-part="${part}"]`);
    if (!element?.checkVisibility()) continue;
    const width = element.getBoundingClientRect().width;
    if (width < floor) problems.push(`[data-part=${part}] is drawn ${Math.round(width)}px wide, under its floor of ${Math.round(floor + 8)}px less 8`);
  }
  return problems;
}

/** The page's lead parts: one of them starts inside the first screen at scroll 0 (a folded cart shows its bar). */
const LEAD = ['[data-part="fold-toggle"]', '[data-part="lines"]', '[data-part="summary"]', '[data-part="details-form"]', '[data-part="cart-empty"]'];

/** At scroll 0: the first lead part the page shows starts inside the first screen. */
function firstScreen(lead) {
  const shown = lead.map((selector) => document.querySelector(`[data-private="cart"] ${selector}`)).filter((element) => element?.checkVisibility({ visibilityProperty: true }));
  const top = Math.min(...shown.map((element) => element.getBoundingClientRect().top));
  return shown.length === 0 ? ["the page shows none of its lead parts"]
    : top < innerHeight - 24 ? [] : [`the page's first part starts at ${Math.round(top)}px, below the ${innerHeight}px screen`];
}

/**
 * Place order with its total, at this scroll: on screen whole, the topmost thing at its centre and its
 * total's words, and taking no cover (the docked bar is the host's: nothing paints over it).
 */
function actionOnScreen(where) {
  const action = document.querySelector('[data-part="details-submit"]');
  const total = document.querySelector("#submitButtonTotal");
  if (!action) return [`${where}: Place order is missing`];
  const box = action.getBoundingClientRect();
  const problems = [];
  if (box.top < -1 || box.bottom > innerHeight + 1 || box.height < 8) problems.push(`${where}: Place order is not on screen (${Math.round(box.top)}..${Math.round(box.bottom)} of ${innerHeight}px)`);
  else {
    for (const element of [action, total?.querySelector("[data-amount]")].filter(Boolean)) {
      const at = element.getBoundingClientRect();
      const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
      if (!hit || !action.contains(hit)) problems.push(`${where}: a click on Place order${element === action ? "" : "'s total"} lands on ${hit ? hit.tagName.toLowerCase() : "nothing"}`);
    }
  }
  if (!total || total.hidden || !/\p{Nd}/u.test(total.textContent ?? "")) problems.push(`${where}: Place order shows no total`);
  return problems;
}

/** Where Place order sits in the page's flow (its docked bar's own place), and the cart's line count. */
function actionInFlow() {
  const dock = document.querySelector('[data-part="dock"]');
  const action = document.querySelector('[data-part="details-submit"]');
  if (!dock || !action) return null;
  const previous = dock.style.position;
  dock.style.position = "static";
  const top = action.getBoundingClientRect().top + scrollY;
  dock.style.position = previous;
  return { top, lines: document.querySelectorAll('[data-private="cart"] [data-part="line"]').length };
}

/**
 * The total outranks every other summary row: no word of the total's row is drawn smaller than any word of
 * another row (an add-on row's lines included), so no look makes a subtotal read as the total; its amount is drawn
 * no smaller than its own label, no lighter than any row's word and reads no fainter on what is behind it than any
 * row's word (an add-on's app lines, ranked by size only, aside).
 */
function prominence(scope) {
  const problems = [];
  const linear = (channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const rgb = (value) => { const found = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/.exec(value); return found ? { channels: [found[1], found[2], found[3]].map(Number), alpha: found[4] === undefined ? 1 : Number.parseFloat(found[4]) / (found[4].endsWith("%") ? 100 : 1) } : null; };
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const behind = (element) => { for (let at = element; at; at = at.parentElement) { const back = rgb(getComputedStyle(at).backgroundColor); if (back && back.alpha > 0.99) return back.channels; } return [255, 255, 255]; };
  for (const summary of document.querySelectorAll(scope)) {
    const words = (elements) => elements.flatMap((element) => {
      const out = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.textContent.trim() || !parent?.checkVisibility() || parent.closest(".sr-only")) continue;
        const style = getComputedStyle(parent);
        const colour = rgb(style.color)?.channels ?? [0, 0, 0];
        out.push({ text: node.textContent.trim().slice(0, 24), size: Number.parseFloat(style.fontSize), weight: Number(style.fontWeight), contrast: ratio(colour, behind(parent)), app: parent.closest('[data-part="add-on-detail"]') !== null, label: parent.closest('[data-part="summary-total-label"]') !== null });
      }
      return out;
    });
    const total = words([...summary.querySelectorAll('[data-summary-row="total"]')]);
    const others = words([...summary.querySelectorAll('[data-summary-row]:not([data-summary-row="total"])')]);
    if (total.length === 0) continue;
    const amount = total.filter((word) => !word.label);
    const label = total.filter((word) => word.label);
    const most = (list, key) => list.reduce((a, b) => (b[key] > a[key] ? b : a));
    const least = (list, key) => list.reduce((a, b) => (b[key] < a[key] ? b : a));
    if (others.length > 0) {
      const [small, big] = [least(total, "size"), most(others, "size")];
      if (small.size < big.size - 0.25) problems.push(`the total's "${small.text}" is drawn at ${small.size.toFixed(1)}px, under the row "${big.text}" at ${big.size.toFixed(1)}px`);
    }
    if (amount.length > 0 && label.length > 0 && least(amount, "size").size < most(label, "size").size - 0.25) problems.push(`the total's amount "${least(amount, "size").text}" is drawn at ${least(amount, "size").size.toFixed(1)}px, under its label "${most(label, "size").text}" at ${most(label, "size").size.toFixed(1)}px`);
    const rows = others.filter((word) => !word.app);
    if (amount.length > 0 && rows.length > 0) {
      const [light, heavy] = [least(amount, "weight"), most(rows, "weight")];
      if (light.weight < heavy.weight) problems.push(`the total's "${light.text}" is drawn at weight ${light.weight}, under the row "${heavy.text}" at weight ${heavy.weight}`);
      const [faint, strong] = [least(amount, "contrast"), most(rows, "contrast")];
      if (faint.contrast < strong.contrast - 0.05) problems.push(`the total's "${faint.text}" reads ${faint.contrast.toFixed(2)}:1, under the row "${strong.text}" at ${strong.contrast.toFixed(2)}:1`);
    }
  }
  return problems;
}

/**
 * Installed in every page before its scripts: whether a filled action (Place order, Pay, Confirm) is found on what is
 * behind it (WCAG 1.4.11), as the save's `boundary: "fill"` rows are: by its fill at 3:1, or by a drawn edge, every
 * side solid and at least 2px (1.95 computed), the border at 3:1 on what is behind it, over a fill at least 40 away
 * from it in CIE76 (contrast.ts `storefrontThemeColorDistance`). `window.__ptActionLost(element, behind)`: null when
 * found, else the words of the problem.
 */
function installActionFound() {
  const parse = (value) => { const found = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/.exec(value ?? ""); return found ? { channels: [found[1], found[2], found[3]].map(Number), alpha: found[4] === undefined ? 1 : Number.parseFloat(found[4]) / (found[4].endsWith("%") ? 100 : 1) } : null; };
  const linear = (channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const lab = (colour) => {
    const [r, g, b] = colour.map(linear);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const distance = (a, b) => { const [p, q] = [lab(a), lab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  window.__ptActionLost = (element, behind) => {
    const style = getComputedStyle(element);
    const own = parse(style.backgroundColor);
    const fill = own && own.alpha > 0.99 ? own.channels : behind;
    const reads = ratio(fill, behind);
    if (reads >= 2.95) return null;
    const sides = ["Top", "Right", "Bottom", "Left"];
    const thin = sides.find((side) => !(Number.parseFloat(style[`border${side}Width`]) >= 1.95 && style[`border${side}Style`] === "solid"));
    const edges = sides.map((side) => parse(style[`border${side}Color`])?.channels ?? behind);
    const edgeReads = Math.min(...edges.map((edge) => ratio(edge, behind)));
    const apart = distance(fill, behind);
    if (!thin && edgeReads >= 2.95 && apart >= 40) return null;
    return `its fill reads ${reads.toFixed(2)}:1 on what is behind it, under 3:1, and ${thin ? `its ${thin.toLowerCase()} edge is no solid 2px border` : edgeReads < 2.95 ? `its border reads ${edgeReads.toFixed(2)}:1` : `its fill is ${apart.toFixed(1)} from what is behind it, under 40`}: a buyer does not see a button`;
  };
}

/**
 * How a buyer finds the page's actions and fields (WCAG 1.4.11), measured under a theme's tokens (the colour
 * table's look): Place order's fill reads at 3:1 on what is behind it and it is never smaller or lighter than another
 * filled button on the page; in a dialog Go back paints no fill of its own, Confirm's fill reads at 3:1 on the
 * dialog and it is never smaller or lighter than Go back; a field, the stepper, the fold's bar and Go back show their
 * border at 3:1 on what is behind them or, drawing none, their own fill.
 */
function boundaries(scope) {
  const problems = [];
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return problems;
  const linear = (channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const rgb = (value) => { const found = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/.exec(value); return found ? { channels: [found[1], found[2], found[3]].map(Number), alpha: found[4] === undefined ? 1 : Number.parseFloat(found[4]) / (found[4].endsWith("%") ? 100 : 1) } : null; };
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const own = (element) => { const back = rgb(getComputedStyle(element).backgroundColor); return back && back.alpha > 0.99 ? back.channels : null; };
  const behind = (element) => { for (let at = element.parentElement; at; at = at.parentElement) { const back = own(at); if (back) return back; } return [255, 255, 255]; };
  const shown = (element) => element.checkVisibility() && element.getBoundingClientRect().width > 0 && !element.closest(".sr-only");
  const type = (element) => { const style = getComputedStyle(element); return { size: Number.parseFloat(style.fontSize), weight: Number(style.fontWeight) }; };
  const name = (element) => element.dataset.part ?? (element.id ? `#${element.id}` : element.tagName.toLowerCase());
  // Found by its fill, or by a drawn edge over a fill apart from what is behind it (installActionFound).
  const filled = (element, what) => {
    const lost = window.__ptActionLost(element, behind(element));
    if (lost) problems.push(`${what}: ${lost}`);
  };
  const outranks = (element, other, what, whom) => {
    const [mine, theirs] = [type(element), type(other)];
    if (mine.size < theirs.size - 0.5) problems.push(`${what} is drawn at ${mine.size.toFixed(1)}px, under ${whom} at ${theirs.size.toFixed(1)}px`);
    if (mine.weight < theirs.weight) problems.push(`${what} is drawn at weight ${mine.weight}, under ${whom} at weight ${theirs.weight}`);
  };
  const submit = scope ? null : document.querySelector('[data-part="details-submit"]');
  if (submit && shown(submit)) {
    filled(submit, "Place order");
    for (const other of document.querySelectorAll('[data-private="cart"] .bg-primary')) if (other !== submit && shown(other)) outranks(submit, other, "Place order", `the filled button "${other.textContent.trim().slice(0, 24)}"`);
  }
  for (const dialog of scope ? [root] : document.querySelectorAll('[data-private="dialog"]')) {
    const [back, confirm] = ['[data-part="dialog-back"]', '[data-part="dialog-confirm"]'].map((selector) => [...dialog.querySelectorAll(selector)].find(shown));
    if (back) {
      const fill = own(back);
      if (fill && ratio(fill, behind(back)) > 1.1) problems.push(`Go back paints a fill of its own (${ratio(fill, behind(back)).toFixed(2)}:1 on the dialog): it would read as Confirm`);
    }
    if (confirm) filled(confirm, "Confirm");
    if (back && confirm) outranks(confirm, back, "Confirm", "Go back");
  }
  // A field drawn as a box around its input (`data-field`) is that box.
  const edged = [...root.querySelectorAll('input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field],[data-part="line-quantity"],[data-part="fold-toggle"],[data-part="dialog-back"]')];
  for (const element of edged) {
    if (!shown(element)) continue;
    const style = getComputedStyle(element);
    const bordered = Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none";
    const back = behind(element);
    const edge = bordered ? rgb(style.borderTopColor)?.channels ?? back : own(element) ?? back;
    const reads = ratio(edge, back);
    if (reads < 2.95) problems.push(`${name(element)}: its ${bordered ? "border" : "fill, with no border drawn,"} reads ${reads.toFixed(2)}:1 on what is behind it, under 3:1: a buyer does not find it`);
  }
  return problems;
}

/**
 * The store's controls where the theme places them (`privatePages.controls`): the light or dark switch where the
 * store offers it, the market and language forms where it sells in several, inside its checkout header
 * (`header`), its strip at the page's end (`footer`), or nowhere (`none`), and never anywhere else.
 */
function controlsPlaced({ place, scheme, localization }) {
  const problems = [];
  const roots = { header: '[data-private="core-header"]', footer: '[data-private="core-footer"]' };
  for (const [control, wanted] of [['[data-host="scheme"] button', scheme], ['[data-host="localization"] select', localization]]) {
    const all = [...document.querySelectorAll(control)];
    const inPlace = place === "none" ? [] : all.filter((element) => element.closest(roots[place]));
    if (wanted && place !== "none" && inPlace.length === 0) problems.push(`${control}: not in the store's ${place === "header" ? "checkout header" : "strip at the page's end"} (${all.length} elsewhere)`);
    for (const element of all) if (!inPlace.includes(element)) problems.push(`${control}: drawn ${element.closest(roots.header) ? "in the checkout header" : element.closest(roots.footer) ? "at the page's end" : "outside the store's chrome"} where the theme places the controls ${place === "none" ? "nowhere" : `in the ${place}`}`);
  }
  return problems;
}

/** Nothing of a document forged past the save draws: none of its words, none of its stylesheet. */
function forgedAbsent({ words, mark }) {
  const problems = [];
  if (document.body.innerText.includes(words)) problems.push(`the forged document's words are drawn ("${words}")`);
  for (const sheet of document.styleSheets) {
    let text = "";
    try { text = [...sheet.cssRules].map((rule) => rule.cssText).join(""); } catch { continue; }
    if (text.includes(mark) || text.includes(words)) problems.push(`the forged document's stylesheet is on the page (${sheet.ownerNode?.outerHTML.slice(0, 60)})`);
  }
  if ([...document.querySelectorAll("style")].some((style) => style.textContent.includes(mark))) problems.push("the forged document's stylesheet is in a <style> of the page");
  return problems;
}

/**
 * The customer's cart under its own look (private-look.md 2.1, 2.2, 3), measured: the offer row's pieces (their
 * boxes) in one band at 1280 and in at most two at 390 (the sentence's own words may wrap inside its box: beside
 * the details form the lines column is 572px at 1280, not the prototype's 1440 page); the status box painting its tone's
 * surface (its row's paint, not the summary's); the add-on row opened to its three lines in order, its amount once.
 */
function customerChecks({ state, rows, details }) {
  const problems = [];
  const root = document.querySelector('[data-private="cart"]');
  if (state === "customer") {
    const row = root?.querySelector('[data-buyer-ui-target="cart.line.after"] [data-ui="stack"][data-tone="warning"]');
    if (!row) problems.push("the offer row is not drawn under the account line");
    else {
      const texts = [...row.querySelectorAll('[data-ui="text"]')];
      const pieces = {
        mark: row.querySelector('[data-ui="mark"]'),
        sentence: texts.find((element) => element.textContent.includes("Add GAMEGHOR Protection")),
        price: texts.find((element) => element.textContent.trim() === "৳350"),
        "Add Now": [...row.querySelectorAll("a,button")].find((element) => element.textContent.trim() === "Add Now"),
      };
      const missing = Object.entries(pieces).filter(([, element]) => !element?.checkVisibility()).map(([piece]) => piece);
      if (missing.length > 0) problems.push(`the offer row draws no ${missing.join(", ")}`);
      else {
        // The pieces' boxes in bands of vertical overlap: each band one line of the row.
        const boxes = Object.entries(pieces).map(([piece, element]) => ({ piece, box: element.getBoundingClientRect() })).sort((a, b) => a.box.top - b.box.top);
        const bands = [];
        for (const each of boxes) {
          const band = bands.find((one) => each.box.top < one.bottom - 2 && each.box.bottom > one.top + 2);
          if (band) { band.pieces.push(each.piece); band.top = Math.min(band.top, each.box.top); band.bottom = Math.max(band.bottom, each.box.bottom); }
          else bands.push({ top: each.box.top, bottom: each.box.bottom, pieces: [each.piece] });
        }
        const range = document.createRange();
        range.selectNodeContents(pieces.sentence);
        const sentenceLines = new Set([...range.getClientRects()].filter((rect) => rect.width > 2).map((rect) => Math.round(rect.top))).size;
        const shown = bands.map((band) => band.pieces.join(" + ")).join(" / ");
        if (innerWidth >= 1280 && bands.length !== 1) problems.push(`the offer row's pieces lie on ${bands.length} lines (${shown}; the sentence's words on ${sentenceLines}): one line at ${innerWidth}px`);
        if (innerWidth < 1280 && bands.length > 2) problems.push(`the offer row's pieces lie on ${bands.length} lines (${shown}): at most two at ${innerWidth}px`);
      }
    }
  }
  const tone = state === "customer" ? "warning" : "success";
  const box = root?.querySelector(`[data-buyer-ui-target="cart.page.summary"] [data-ui="stack"][data-tone="${tone}"]`);
  const own = rows.find((row) => row.key === `ui.stack.${tone}@gameghor.protection/cart.page.summary`);
  const summary = rows.find((row) => row.key === "summary");
  if (!box) problems.push(`the ${tone} status box is not drawn in the summary`);
  else if (!own?.paint || own.paint === summary?.paint) problems.push(`the ${tone} status box has no surface of its own in the table (${own?.paint ?? "no row"})`);
  else {
    const hex = /^#([0-9a-f]{6})$/i.exec(own.paint);
    const expected = hex ? `rgb(${[0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16)).join(", ")})` : own.paint;
    const drawn = getComputedStyle(box).backgroundColor;
    if (drawn !== expected) problems.push(`the ${tone} status box paints ${drawn}, not its tone's ${own.paint}`);
  }
  if (state === "customer-protected") {
    const addOn = root?.querySelector('[data-part="summary"] [data-part="add-on-details"]');
    if (!addOn) problems.push("the add-on row is not drawn in the summary");
    else {
      if (!addOn.open) problems.push("the add-on row did not open");
      const lines = [...addOn.querySelectorAll('[data-part="add-on-detail"]')];
      const drawn = lines.filter((line) => line.checkVisibility()).map((line) => line.textContent.replace(/\s+/g, " ").trim());
      if (JSON.stringify(drawn) !== JSON.stringify(details)) problems.push(`the add-on row opens to ${JSON.stringify(drawn)}, not ${JSON.stringify(details)}`);
      const tops = lines.map((line) => line.getBoundingClientRect().top);
      if (tops.some((top, index) => index > 0 && top <= tops[index - 1])) problems.push("the add-on row's lines are not drawn top to bottom in order");
      const amounts = addOn.textContent.split("৳700").length - 1;
      if (amounts !== 1) problems.push(`the add-on row shows its amount ৳700 ${amounts} times`);
    }
    const totals = root?.querySelectorAll('[data-part="summary"] [data-summary-row="total"]').length ?? 0;
    if (totals !== 1) problems.push(`the summary shows ${totals} totals`);
  }
  return problems;
}

// ─── The checks, from outside ─────────────────────────────────────────────

/**
 * Each text's contrast against the pixels behind it: every text hidden, the
 * page photographed screen by screen (each text's boxes read afresh at each
 * scroll, so a fixed dialog or a sticky bar is where it is drawn).
 */
async function textContrast(page, texts) {
  const problems = [];
  if (texts.length === 0) return problems;
  await page.addStyleTag({ content: "*,*::before,*::after,*::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}" }).then((handle) => handle.evaluate((style) => style.setAttribute("data-pt-hide", "")));
  // No focus ring of an earlier check lies over a text.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && !document.activeElement.closest("dialog,[role=dialog]") && document.activeElement.blur());
  const pending = new Map(texts.map((text) => [text.id, text]));
  // A screen at a time: as many as a long cart's texts need.
  for (let guard = 0, most = Math.max(80, texts.length + 20); pending.size > 0 && guard < most; guard += 1) {
    const first = pending.keys().next().value;
    // Scroll the first text left to the middle; every pending text's boxes now, and whether it is drawn on top there.
    const boxes = await page.evaluate(({ first, ids }) => {
      // The page was replaced since the walk (a navigation): nothing left to measure here.
      if (!window.__ptTexts?.[first]) return null;
      const boxesOf = (id) => {
        const { node, field, element } = window.__ptTexts[id];
        if (field) {
          const box = field.getBoundingClientRect();
          const style = getComputedStyle(field);
          const pad = (side) => Number.parseFloat(style[`padding${side}`]) + Number.parseFloat(style[`border${side}Width`]);
          return { element, rects: [{ x: box.left + pad("Left"), y: box.top + pad("Top"), w: box.width - pad("Left") - pad("Right") - (field.tagName === "SELECT" ? 24 : 0), h: box.height - pad("Top") - pad("Bottom") }].filter((rect) => rect.w >= 4 && rect.h >= 4) };
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        // Only what is drawn: each line cut to the boxes that clip it (a clamped title's hidden lines are not words a buyer reads).
        const clips = [];
        for (let at = element; at && at !== document.body; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(at.getBoundingClientRect());
        }
        return {
          element,
          rects: [...range.getClientRects()].map((rect) => {
            let [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom];
            for (const clip of clips) [left, top, right, bottom] = [Math.max(left, clip.left), Math.max(top, clip.top), Math.min(right, clip.right), Math.min(bottom, clip.bottom)];
            return { x: left, y: top, w: right - left, h: bottom - top };
          }).filter((rect) => rect.w >= 2 && rect.h >= 4),
        };
      };
      window.__ptTexts[first].element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return ids.flatMap((id) => {
        const { element, rects } = boxesOf(id);
        if (rects.length === 0) return id === first ? [{ id, rects, whole: false, top: false }] : [];
        const whole = rects.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= innerWidth && rect.y + rect.h <= innerHeight);
        // Drawn on top all over (a docked bar or a sticky header over part of it is not what it is read on).
        const top = whole && rects.every((rect) => [[0.5, 0.5], [0.05, 0.03], [0.95, 0.03], [0.05, 0.97], [0.95, 0.97]].every(([fx, fy]) => {
          const hit = document.elementFromPoint(rect.x + rect.w * fx, rect.y + rect.h * fy);
          return !hit || element.contains(hit) || hit.contains(element);
        }));
        return whole || id === first ? [{ id, rects, whole, top }] : [];
      });
    }, { first, ids: [...pending.keys()] });
    if (boxes === null) { problems.push(`the page navigated away (${page.url()}) while its texts were measured`); break; }
    // The boxes were read after the scroll; if it is still moving, read them again once it is still.
    if (!(await page.evaluate(() => { const at = `${scrollX},${scrollY}`; return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(at === `${scrollX},${scrollY}`)))); }))) {
      await still(page);
      continue;
    }
    const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
    const image = decode(shot);
    let kept = false;
    for (const { id, rects, whole, top } of boxes) {
      if (id !== first && !top) continue;
      pending.delete(id);
      if (!whole && rects.length === 0) continue;
      const text = texts[id];
      const ink = rgb(text.color);
      const ratios = [];
      for (const rect of rects) {
        const [x0, x1] = [Math.max(0, Math.floor(rect.x + 1)), Math.min(image.width - 1, Math.ceil(rect.x + rect.w - 1))];
        const [y0, y1] = [Math.max(0, Math.floor(rect.y + 1)), Math.min(image.height - 1, Math.ceil(rect.y + rect.h - 1))];
        for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) ratios.push(contrast(ink, pixelAt(image, x, y)));
      }
      if (ratios.length === 0) continue;
      ratios.sort((a, b) => a - b);
      const worst = ratios[text.field ? Math.floor(ratios.length * FIELD_QUANTILE) : 0];
      const floor = text.large ? 3 : 4.5;
      if (worst < floor - (text.field ? FIELD_BUDGET : 0)) {
        problems.push(`${text.label}: ${text.color} reads ${worst.toFixed(2)}:1 on what is behind it`);
        // `PT_SHOTS=<dir>`: keep the screen a failing text was measured on (its words hidden), to look at.
        if (process.env.PT_SHOTS && !kept) {
          kept = true;
          const file = resolve(process.env.PT_SHOTS, `${Date.now()}-${problems.length}.png`);
          writeFileSync(file, shot);
          problems.push(`  (screen kept: ${file}; the text at ${JSON.stringify(rects[0])})`);
        }
      }
    }
  }
  if (pending.size > 0) problems.push(`${pending.size} texts were never on screen to measure`);
  await page.evaluate(() => document.querySelector("style[data-pt-hide]")?.remove());
  return problems;
}

/**
 * Tab from the top reaches every control, in document order (a radio group
 * once): the page's focus order is its reading order.
 */
async function focusOrder(page, controls) {
  const problems = [];
  await page.evaluate(() => {
    window.__ptFocus = [];
    document.addEventListener("focusin", (event) => window.__ptFocus.push(event.target instanceof Element ? Number(event.target.closest("[data-pt-control]")?.getAttribute("data-pt-control") ?? -1) : -1), true);
    document.activeElement?.blur();
    scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
  // Enough presses for every focusable on the page.
  const presses = await page.evaluate(() => document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])').length);
  for (let press = 0; press < presses + 4; press += 1) await page.keyboard.press("Tab");
  const all = await page.evaluate(() => { document.activeElement?.blur(); return window.__ptFocus; });
  // Past the last control, Tab wraps to the top: the order ends there.
  const wrap = all.findIndex((id, index) => id >= 0 && all.indexOf(id) < index);
  const order = wrap < 0 ? all : all.slice(0, wrap);
  const reached = new Set(order.filter((id) => id >= 0));
  const groups = new Map();
  for (const control of controls) if (control.radio) groups.set(control.radio, [...(groups.get(control.radio) ?? []), control.id]);
  for (const control of controls) {
    if (control.radio ? groups.get(control.radio).some((id) => reached.has(id)) : reached.has(control.id)) continue;
    problems.push(`control ${control.label}: Tab never reaches it`);
  }
  let last = -1;
  for (const id of order) {
    if (id < 0) continue;
    if (id < last) { problems.push(`focus goes back up the page: ${controls[last]?.label} then ${controls[id]?.label}`); break; }
    last = id;
  }
  return problems;
}

/**
 * Each kind of control shows a focus ring that reads at 3:1: focused, the
 * pixels around and on its edge that changed must differ from what was there
 * by 3:1, along at least its perimeter (WCAG 2.4.13's area, 1px all round).
 */
async function focusRings(page, controls) {
  const problems = [];
  // Keyboard modality first, so a focus moved by script shows :focus-visible.
  await page.evaluate(() => {
    const sentinel = Object.assign(document.createElement("button"), { textContent: "sentinel" });
    sentinel.dataset.ptSentinel = "";
    sentinel.style.cssText = "position:fixed;left:-500px;top:0";
    document.body.append(sentinel);
  });
  await page.locator("[data-pt-sentinel]").focus();
  await page.keyboard.press("Shift+Tab");
  await page.locator("[data-pt-sentinel]").focus();
  const groups = new Set();
  const viewport = page.viewportSize();
  for (const control of controls) {
    if (control.viaLabel || groups.has(control.group)) continue;
    groups.add(control.group);
    const box = await page.evaluate((id) => {
      document.querySelector("[data-pt-sentinel]").focus({ preventScroll: true });
      const element = document.querySelector(`[data-pt-control="${id}"]`);
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      // A link that wraps draws its ring round each line: its perimeter is theirs.
      const perimeter = [...element.getClientRects()].reduce((sum, each) => sum + 2 * (each.width + each.height), 0);
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, perimeter };
    }, control.id);
    const pad = 6;
    const clip = { x: Math.max(0, Math.floor(box.x - pad)), y: Math.max(0, Math.floor(box.y - pad)) };
    clip.width = Math.min(viewport.width, Math.ceil(box.x + box.w + pad)) - clip.x;
    clip.height = Math.min(viewport.height, Math.ceil(box.y + box.h + pad)) - clip.y;
    if (clip.width < 4 || clip.height < 4) continue;
    const before = decode(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    const visible = await page.evaluate((id) => {
      const element = document.querySelector(`[data-pt-control="${id}"]`);
      element.focus({ preventScroll: true });
      return document.activeElement === element && element.matches(":focus-visible");
    }, control.id);
    if (!visible) { problems.push(`control ${control.label}: takes no keyboard focus`); continue; }
    const after = decode(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    let ring = 0;
    for (let y = 0; y < Math.min(before.height, after.height); y += 1) {
      for (let x = 0; x < Math.min(before.width, after.width); x += 1) {
        // The ring's band: from 3px inside the edge to the clip's edge.
        const inside = x > box.x - clip.x + 3 && x < box.x - clip.x + box.w - 3 && y > box.y - clip.y + 3 && y < box.y - clip.y + box.h - 3;
        if (!inside && contrast(pixelAt(before, x, y), pixelAt(after, x, y)) >= 3) ring += 1;
      }
    }
    // Three quarters of the perimeter: a rounded corner draws fewer pixels than its box.
    if (ring < box.perimeter * 0.75) problems.push(`control ${control.label}: its focus ring reads at 3:1 on ${ring} pixels, under three quarters of its perimeter (${Math.round(box.perimeter)})`);
  }
  await page.evaluate(() => document.querySelector("[data-pt-sentinel]")?.remove());
  return problems;
}

/**
 * Under the pointer, each kind of control still reads: its words at their
 * floor on what is behind them while hovered, and a control the host gives a
 * hover surface (a `hover:bg-*` class) shows it (a quarter of its box changes).
 */
async function hovers(page, controls) {
  const problems = [];
  const groups = new Set();
  const viewport = page.viewportSize();
  const hide = "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important}";
  for (const control of controls) {
    if (control.viaLabel || control.field || groups.has(control.group)) continue;
    groups.add(control.group);
    await page.mouse.move(0, 0);
    const box = await page.evaluate((id) => {
      const element = document.querySelector(`[data-pt-control="${id}"]`);
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, surfaced: [...element.classList].some((name) => /(^|:)hover:bg-/.test(name)) };
    }, control.id);
    const clip = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)) };
    clip.width = Math.min(viewport.width, Math.ceil(box.x + box.w)) - clip.x;
    clip.height = Math.min(viewport.height, Math.ceil(box.y + box.h)) - clip.y;
    if (clip.width < 8 || clip.height < 8) continue;
    const hidden = await page.addStyleTag({ content: hide });
    const before = decode(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    await hidden.evaluate((style) => style.remove());
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    // The words as they are drawn under the pointer: their colours, and their boxes inside the control.
    const words = await page.evaluate(({ id, clip }) => {
      // A colour transition (the hover's, or the words coming back from hidden) drawn to its end.
      for (const animation of document.getAnimations()) animation.finish();
      const element = document.querySelector(`[data-pt-control="${id}"]`);
      const out = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.textContent.trim() || !parent || parent.closest(".sr-only") || getComputedStyle(parent).clipPath !== "none") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const style = getComputedStyle(parent);
        const size = Number.parseFloat(style.fontSize);
        const rects = [...range.getClientRects()].map((rect) => ({ x: rect.left - clip.x, y: rect.top - clip.y, w: rect.width, h: rect.height })).filter((rect) => rect.w >= 2 && rect.h >= 4);
        if (rects.length > 0) out.push({ text: node.textContent.trim().slice(0, 30), color: style.color, large: size >= 24 || (size >= 18.6 && Number(style.fontWeight) >= 700), rects });
      }
      return out;
    }, { id: control.id, clip });
    const covered = await page.addStyleTag({ content: hide });
    const after = decode(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
    await covered.evaluate((style) => style.remove());
    for (const word of words) {
      const ink = rgb(word.color);
      const ratios = [];
      for (const rect of word.rects) {
        for (let y = Math.max(0, Math.floor(rect.y + 1)); y <= Math.min(after.height - 1, Math.ceil(rect.y + rect.h - 1)); y += 1) {
          for (let x = Math.max(0, Math.floor(rect.x + 1)); x <= Math.min(after.width - 1, Math.ceil(rect.x + rect.w - 1)); x += 1) ratios.push(contrast(ink, pixelAt(after, x, y)));
        }
      }
      if (ratios.length === 0) continue;
      ratios.sort((a, b) => a - b);
      const worst = ratios[0];
      if (worst < (word.large ? 3 : 4.5)) problems.push(`control ${control.label} hovered: "${word.text}" ${word.color} reads ${worst.toFixed(2)}:1 on what is behind it`);
    }
    if (box.surfaced) {
      let changed = 0;
      for (let y = 0; y < Math.min(before.height, after.height); y += 1) {
        for (let x = 0; x < Math.min(before.width, after.width); x += 1) {
          const [a, b] = [pixelAt(before, x, y), pixelAt(after, x, y)];
          if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) >= 6) changed += 1;
        }
      }
      if (changed < before.width * before.height * 0.25) problems.push(`control ${control.label}: shows no hover (${changed} of ${before.width * before.height} pixels change under the pointer)`);
    }
  }
  await page.mouse.move(0, 0);
  return problems;
}

/**
 * On a phone: swiping from the top reaches the end of the details form, where Place order's own place is
 * (nothing on the way takes the gesture). Never Place order's docked bar: it is on screen from the start.
 */
async function touchScroll(page) {
  const selector = '[data-part="details-form"]';
  const session = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  const x = Math.round(viewport.width / 2);
  const touch = (type, y) => session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: Math.round(y) }] });
  await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: "instant" }));
  try {
    let last = -1;
    let stuck = 0;
    for (let swipe = 0; swipe < 60; swipe += 1) {
      // The form's end in the page's flow; reached once it is on screen (or the page can scroll no further).
      const { bottom, y, end } = await page.evaluate((selector) => ({ bottom: document.querySelector(selector)?.getBoundingClientRect().bottom ?? null, y: Math.round(scrollY), end: document.documentElement.scrollHeight - innerHeight }), selector);
      if (bottom === null) return [`${selector}: missing for the touch scroll`];
      if (swipe === 0 && bottom <= viewport.height) return [];
      if (bottom <= viewport.height || y >= end - 1) return swipe > 0 ? [] : [`${selector}: its end lies below the screen and the page cannot scroll`];
      const top = bottom;
      // Three swipes in a row that move nothing: something on the way takes the gesture.
      stuck = y === last ? stuck + 1 : 0;
      if (stuck >= 3) return [`a touch swipe stops at ${y}px, ${Math.round(top - viewport.height)}px above ${selector}`];
      if (stuck > 0) await page.waitForTimeout(150);
      last = y;
      // A finger dragged up most of the screen, slowly enough that nothing flings.
      await touch("touchStart", viewport.height * 0.85);
      for (let step = 1; step <= 6; step += 1) await touch("touchMove", viewport.height * (0.85 - 0.12 * step));
      await touch("touchEnd", 0);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    }
    return [`${selector}: not reached after 60 touch swipes`];
  } finally {
    await session.detach().catch(() => {});
  }
}

// ─── The run ───────────────────────────────────────────────────────────────

/** The gallery in a process of its own: its renders and fixture answers never wait on this one's pixel work. */
async function startGallery() {
  const child = spawn(process.execPath, [resolve("apps/storefront/scripts/gallery-server.mjs"), "--port", "0", "--quiet"], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  process.once("exit", () => child.kill("SIGKILL"));
  const url = await new Promise((done, fail) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const match = /Storefront gallery: (http:\/\/[^/\s]+)/.exec(text);
      if (match) done(match[1]);
    });
    child.once("exit", (code) => fail(new Error(`the gallery exited (${code}) before it listened`)));
  });
  const close = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
  return { url, close };
}
// A gallery that does not start is started once more; twice, the gate could not run (exit 2, never a failing draw).
const gallery = await startGallery().catch(() => startGallery()).catch((error) => {
  console.error("the gate could not run: the gallery did not start, twice:", error);
  process.exit(2);
});
const { styles, ui: UI_KINDS } = await fetch(`${gallery.url}/__gallery/private-anatomy`).then((answer) => answer.json());
/** Each style target of the cart page with its whole selector (the page's own, `page`, is the body). */
const STYLE_TARGETS = Object.entries(styles).map(([name, style]) => ({ name, selector: style.absolute ? style.selector : `[data-private="cart"] ${style.selector}`.trim() }));
/**
 * With no tokens (the store's own colours, no table) the walk claims by the
 * anatomy: everything the host draws must sit inside a surface it names (the
 * page's root, a style target, a dialog, the store's checkout header and its
 * strip at the page's end). The body (`page`) holds everything, so it claims
 * only the skip link.
 */
const ANATOMY = STYLE_TARGETS.filter(({ name }) => name !== "page").concat([{ name: "the skip link", selector: 'a[href="#main-content"]' }]);
const browser = await chromium.launch();
const failures = [];
let drawn = 0;
let draws = 0;
let refused = 0;
const reasons = {};
/** The drafts a seed tries before one the save takes, and the refused drafts (counted, never drawn). */
const SEED_DRAFTS = 8;
let draftsRefused = 0;
const draftReasons = {};
const started = Date.now();
/** The most a draw's theme added above Place order, against its bound (printed with the run's result). */
let deepest = null;
/** Where a run's time goes (`--profile`). */
const PROFILE = {};
const timed = async (label, work) => {
  const begin = Date.now();
  try { return await work(); } finally { PROFILE[label] = (PROFILE[label] ?? 0) + Date.now() - begin; }
};

/** The draws of one state: its widths and schemes, and which checks each runs. */
function drawsOf(state) {
  // The base cart at every width and scheme; focus rings and Tab order on a phone in both schemes and the
  // wide page once; the errors and the dialogs on a phone and the wide page, each scheme once.
  if (state === "base") {
    return WIDTHS.flatMap((width) => SCHEMES.map((scheme) => ({
      width, scheme,
      focus: width === 390 || (width === 1280 && scheme === "dark"),
      // Under a mouse pointer (a touch screen has no hover): the wide page, dark.
      hover: width === 1280 && scheme === "dark",
      interact: (width === 390 && scheme === "light") || (width === 1280 && scheme === "dark"),
    })));
  }
  // The confirmation dialog in the same way; the other states on a phone and the wide page, crossed over the schemes.
  if (state === "lines") return [[390, "dark"], [1280, "light"]].map(([width, scheme]) => ({ width, scheme, focus: false, interact: true }));
  if (state === "decide") return [[390, "light"], [1280, "dark"]].map(([width, scheme]) => ({ width, scheme, focus: false, interact: true }));
  if (LENGTHS.includes(state)) return LENGTH_VIEWPORTS.map(([width, height, scheme]) => ({ width, height, scheme, focus: false, interact: false }));
  // The customer's cart on a phone and the wide page, light and dark; its controls' rings on the phone light and the
  // wide page dark, under the pointer on the wide page dark.
  if (state === "customer" || state === "customer-protected") {
    return [390, 1280].flatMap((width) => SCHEMES.map((scheme) => ({ width, scheme, focus: (width === 390) === (scheme === "light"), hover: width === 1280 && scheme === "dark", interact: false })));
  }
  return [[320, "light"], [1280, "dark"]].map(([width, scheme]) => ({ width, scheme, focus: false, interact: false }));
}

/**
 * Every running animation and transition finished (a dialog fading in is not yet what a buyer reads). The dev
 * server may reload a page once as it first serves a dependency (Vite's optimizer): a reload of the same URL is
 * waited out and settled again; a page that went anywhere else is a failure of the draw.
 */
async function settle(page) {
  const at = page.url();
  try {
    await settleOnce(page);
  } catch (error) {
    if (!/Execution context was destroyed|navigation/i.test(String(error?.message))) throw error;
    await page.waitForLoadState("load");
    if (page.url() !== at) throw new Error(`the page navigated from ${at} to ${page.url()} while it settled`);
    console.error(`(the dev server reloaded ${new URL(at).pathname}; settled again)`);
    await page.waitForSelector('[data-private="cart"][data-cart-state="items"],[data-private="cart"][data-cart-state="empty"],[data-cart-open],#cart-button', { timeout: 20_000 }).catch(() => {});
    await settleOnce(page);
  }
}

/**
 * A check that the dev server's one-time reload (Vite's optimizer, as `settle` meets it) cut short: once the same URL
 * has loaded and settled, run again. A page that went anywhere else fails as before.
 */
async function reloadSafe(page, work) {
  const at = page.url();
  try {
    return await work();
  } catch (error) {
    if (!/Execution context was destroyed|navigation/i.test(String(error?.message))) throw error;
    await page.waitForLoadState("load");
    if (page.url() !== at) throw new Error(`the page navigated from ${at} to ${page.url()} during a check`);
    console.error(`(the dev server reloaded ${new URL(at).pathname} during a check; ran it again)`);
    await settle(page);
    return work();
  }
}

async function settleOnce(page) {
  // No pointer rests on a control (a hover colour is not what the page draws).
  await page.mouse.move(0, 0);
  // The page has stopped redrawing: 250ms with no element added, removed or reworded (the cart's check,
  // its total and the apps' blocks arrive after the first paint), at most 6 seconds.
  const busy = await page.evaluate(() => new Promise((done) => {
    const last = [];
    const finish = () => { observer.disconnect(); clearTimeout(cap); clearTimeout(quiet); done(last.slice(-3)); };
    let quiet = setTimeout(finish, 250);
    const cap = setTimeout(finish, 6000);
    const observer = new MutationObserver((records) => {
      for (const record of records.slice(0, 2)) last.push(`${record.type} ${record.target.nodeType === 3 ? `text in ${record.target.parentElement?.id}` : record.target.id || record.target.tagName}`);
      clearTimeout(quiet);
      quiet = setTimeout(finish, 250);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }));
  if (process.env.PT_DEBUG_SETTLE) console.error(`settle: ${busy.join(" | ")}`);
  await page.evaluate(() => Promise.race([
    Promise.all([
      document.fonts.ready,
      // A lazy image off screen never loads: only the ones the browser is fetching.
      ...[...document.images].map((image) => image.complete || image.loading === "lazy" ? null : image.decode().catch(() => {})),
      // Finite ones only: a spinner or a bouncing hint never finishes.
      ...document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => {})),
    ]),
    new Promise((done) => setTimeout(done, 3000)),
  ]));
  await still(page);
}

/** The page is not scrolling (a smooth scroll to a field's error is not over when its click returns). */
function still(page) {
  return page.evaluate(() => new Promise((done) => {
    let last = `${scrollX},${scrollY}`;
    let calm = 0;
    let frames = 0;
    const tick = () => {
      const now = `${scrollX},${scrollY}`;
      calm = now === last ? calm + 1 : 0;
      last = now;
      frames += 1;
      if (calm >= 3 || frames > 120) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function open(context, id, width, server5xx, height = 900) {
  const page = await context.newPage();
  page.on("response", (answer) => { if (answer.status() >= 500) server5xx.push(`${answer.status()} ${answer.request().method()} ${new URL(answer.url()).pathname}`); });
  await page.setViewportSize({ width, height });
  const answer = await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  if (answer && answer.status() >= 500) server5xx.push(`${answer.status()} the page`);
  await page.waitForSelector('[data-private="cart"][data-cart-state="items"],[data-private="cart"][data-cart-state="empty"]', { timeout: 20_000 }).catch(() => {});
  return page;
}

/** One draw: the page in one state at one width and scheme, with its interactions. */
async function draw({ context, id, state, width, height, focus, hover, interact, rows, controls, request, drawn }) {
  const problems = [];
  const server5xx = [];
  if (request?.page === "home") return drawDrawer({ context, id, width, problems, server5xx, rows, state });
  if (request?.page === "sample-checkout") return drawCheckout({ context, id, width, height, request });
  if (AFTER_ORDER_PAGES[request?.page]) return drawAfterOrder({ context, id, width, rows, request, drawn });
  const page = await timed("load", () => open(context, id, width, server5xx, height));
  // The store's own checkout header, and its controls where the theme places them.
  // A store that asks for its terms: the required box and its words, wherever the cart is not empty.
  const terms = request?.terms && state !== "empty" ? ["#cartTermsAccepted", 'label[for="cartTermsAccepted"]'] : [];
  const mandatory = [...(state === "empty" ? EMPTY_MANDATORY : state === "lines" ? LINES_MANDATORY : MANDATORY), '[data-private="core-header"]', ...terms];
  const at = (label, list) => problems.push(...list.map((problem) => `${label}: ${problem}`));
  const check = async (label, scope, list, { controls: wantControls = true } = {}) => {
    await timed("settle", () => settle(page));
    const walked = await timed("walk", () => page.evaluate(walk, { rows, anatomy: ANATOMY, uiKinds: UI_KINDS, mandatory: list, scope, exempt: EXEMPT, styleTargets: STYLE_TARGETS }));
    at(label, walked.problems);
    if (request?.forged) at(label, await page.evaluate(forgedAbsent, { words: FORGED_WORDS, mark: FORGED_MARK }));
    // Under a theme's tokens, the table's look: every action and field is found where it stands.
    if (rows.length > 0) at(label, await page.evaluate(boundaries, scope));
    at(label, await timed("whole", () => page.evaluate(wholeTexts)));
    at(label, await timed("contrast", () => textContrast(page, walked.texts)));
    if (wantControls) at(label, await timed("clicks", () => page.evaluate(clicks)));
    return walked;
  };
  await timed("settle", () => settle(page));
  // As a buyer arrives, before anything is clicked: one unit the dev server's one-time reload runs again whole.
  problems.push(...await reloadSafe(page, async () => {
    const found = [];
    const add = (label, list) => found.push(...list.map((problem) => `${label}: ${problem}`));
    if (drawn) {
      const shown = await page.evaluate(() => document.documentElement.dataset.colorScheme ?? "light");
      if (shown !== drawn) found.push(`scheme: the page draws its ${shown} colours where the store shows its ${drawn} ones`);
    }
    // The first screen and Place order, as a buyer arrives: at scroll 0, then down the cart.
    add("first screen", await page.evaluate(firstScreen, LEAD));
    if (state !== "empty") add("dock", await timed("dock", () => dockChecks(page)));
    // Phones: Tab order and the touch scroll run before anything is clicked.
    if (width < 1280 && state !== "empty") add("touch", await timed("touch", () => touchScroll(page)));
    if (focus) {
      const { controls } = await page.evaluate(walk, { rows, anatomy: ANATOMY, uiKinds: UI_KINDS, mandatory: [], scope: null, exempt: EXEMPT, styleTargets: [] });
      add("focus order", await timed("tab", () => focusOrder(page, controls)));
    }
    return found;
  }));
  // On a phone the cart folds behind its bar: open it, as a buyer does; and open every add-on row to its lines.
  const toggle = page.locator('[data-part="fold-toggle"][aria-expanded="false"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
  await openAddOns(page, '[data-private="cart"]');
  await page.waitForTimeout(150);
  // Docked with the fold open too (a phone's cart unfolded is the longest page).
  if (state !== "empty" && width < 1280) at("dock, fold open", await timed("dock", () => reloadSafe(page, () => dockChecks(page))));
  const page0 = await check(state, null, mandatory);
  at(state, await page.evaluate(controlsPlaced, controls));
  at(`${state} prominence`, await page.evaluate(prominence, '[data-private="cart"] [data-part="summary"]'));
  at(`${state} apps fit`, await page.evaluate(appsFit));
  at(`${state} floors`, await page.evaluate(partsAtFloor));
  if (request?.reference && (state === "customer" || state === "customer-protected")) at(`${state} customer`, await page.evaluate(customerChecks, { state, rows, details: CUSTOMER_DETAILS }));
  // What the theme adds above Place order, against the default look with the same cart (the fold open in both).
  if (state !== "empty") {
    const here = await page.evaluate(actionInFlow);
    const before = await timed("default", () => defaultInFlow(request, state, width, height));
    // A baseline that cannot be measured is a failure, never a skipped check.
    if (!here || !before) problems.push(`depth: Place order's place cannot be measured (${!here ? "under the theme" : "under the default look"})`);
    else {
      const added = here.top - before.top;
      const allowed = THEME_DEPTH_PX + LINE_DEPTH_PX * here.lines;
      if (!deepest || added / allowed > deepest.added / deepest.allowed) deepest = { added: Math.round(added), allowed, lines: here.lines };
      if (added > allowed) problems.push(`depth: the theme adds ${Math.round(added)}px above Place order (${here.lines} lines: at most ${allowed}px)`);
    }
  }
  if (focus) at(`${state} focus`, await timed("rings", () => focusRings(page, page0.controls)));
  if (hover) at(`${state} hover`, await timed("hover", () => hovers(page, page0.controls)));
  if (interact && state === "base") {
    // Place order with nothing filled in: every field says what it needs.
    await page.locator('[data-part="details-submit"]').click().catch(() => {});
    await page.waitForSelector('[aria-invalid="true"]', { timeout: 5_000 }).catch(() => problems.push("errors: Place order showed no field error"));
    await page.waitForTimeout(100);
    await check("errors", null, mandatory, { controls: false });
    // The sign-in dialog.
    await page.locator("[data-open-auth]").first().click().catch(() => {});
    const dialog = await page.waitForSelector('[data-private="dialog"][data-part="sign-in"]', { state: "visible", timeout: 8_000 }).catch(() => null);
    if (!dialog) problems.push("sign-in: the dialog did not open");
    else {
      await settle(page);
      const walked = await check("sign-in", '[data-private="dialog"][data-part="sign-in"]', []);
      if (focus) at("sign-in focus", await focusRings(page, walked.controls));
      await page.keyboard.press("Escape");
    }
  }
  if (interact && state === "lines") {
    // Declining the app's protection asks for the buyer's agreement.
    const select = page.locator('[data-part="line-inputs"] select').first();
    if (!(await select.count())) problems.push("confirm: the line's decision is not drawn");
    else {
      await select.selectOption("declined").catch(() => {});
      const dialog = await page.waitForSelector("dialog[data-cart-line-confirm][open]", { timeout: 8_000 }).catch(() => null);
      if (!dialog) problems.push("confirm: the confirmation dialog did not open");
      else {
        await settle(page);
        const walked = await check("confirm", "dialog[data-cart-line-confirm][open]", ['[data-part="dialog-back"]', '[data-part="dialog-confirm"]', '[data-part="dialog-title"]']);
        if (focus) at("confirm focus", await focusRings(page, walked.controls));
        await page.keyboard.press("Escape");
      }
    }
  }
  if (interact && state === "decide") {
    // Place order with every field filled and a line still undecided: the store asks for the decision in its dialog.
    const filled = await fillDetails(page);
    if (filled) problems.push(`confirm from Place order: ${filled}`);
    else {
      await page.locator('[data-part="details-submit"]').click().catch(() => {});
      const dialog = await page.waitForSelector("dialog[data-cart-line-confirm][open]", { timeout: 8_000 }).catch(() => null);
      if (!dialog) problems.push("confirm from Place order: the confirmation dialog did not open");
      else {
        await settle(page);
        await check("confirm from Place order", "dialog[data-cart-line-confirm][open]", ['[data-part="dialog-back"]', '[data-part="dialog-confirm"]', '[data-part="dialog-title"]']);
        await page.keyboard.press("Escape");
      }
    }
  }
  at("5xx", server5xx);
  await page.close();
  return problems;
}

/** Each after-order page's style targets with their whole selectors (`/__gallery/private-anatomy?page=`), read once. */
const AFTER_ORDER_TARGETS = {};
async function afterOrderTargets(page) {
  if (!AFTER_ORDER_TARGETS[page]) {
    const { styles: pageStyles } = await fetch(`${gallery.url}/__gallery/private-anatomy?page=${page}`).then((answer) => answer.json());
    AFTER_ORDER_TARGETS[page] = Object.entries(pageStyles).map(([name, style]) => ({ name, selector: style.absolute ? style.selector : `[data-private="${page}"] ${style.selector}`.trim() }));
  }
  return AFTER_ORDER_TARGETS[page];
}

/**
 * The receipt or the account (the theme editor's sample pages, drawn by the same components as a buyer's): what a
 * buyer must see there on screen and uncovered, every add-on row opened, the coverage walk inside the page's root
 * (its colour table in token mode, its anatomy without), every word whole and at its floor, every control taking a
 * click, the total no smaller than its rows, the scheme the store shows, and none of a forged document.
 */
async function drawAfterOrder({ context, id, width, rows, request, drawn }) {
  const problems = [];
  const server5xx = [];
  const spec = AFTER_ORDER_PAGES[request.page];
  const at = (label, list) => problems.push(...list.map((problem) => `${label}: ${problem}`));
  const page = await context.newPage();
  page.on("response", (answer) => { if (answer.status() >= 500) server5xx.push(`${answer.status()} ${answer.request().method()} ${new URL(answer.url()).pathname}`); });
  await page.setViewportSize({ width, height: 900 });
  const answer = await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  if (answer && answer.status() >= 500) server5xx.push(`${answer.status()} the page`);
  if (!(await page.waitForSelector(spec.root, { timeout: 20_000 }).catch(() => null))) problems.push(`${spec.page}: ${spec.root} is not drawn`);
  await timed("settle", () => settle(page));
  if (drawn) {
    const shown = await page.evaluate(() => document.documentElement.dataset.colorScheme ?? "light");
    if (shown !== drawn) problems.push(`scheme: the page draws its ${shown} colours where the store shows its ${drawn} ones`);
  }
  await openAddOns(page, spec.root);
  await page.waitForTimeout(150);
  const targets = await afterOrderTargets(spec.page);
  const anatomy = targets.filter(({ name }) => name !== "page").concat([{ name: `the ${spec.page}`, selector: spec.root }]);
  const walked = await timed("walk", () => page.evaluate(walk, { rows, anatomy, uiKinds: UI_KINDS, mandatory: spec.mandatory, scope: spec.root, exempt: EXEMPT, styleTargets: targets }));
  at(spec.page, walked.problems);
  if (request?.forged) at(spec.page, await page.evaluate(forgedAbsent, { words: FORGED_WORDS, mark: FORGED_MARK }));
  if (rows.length > 0) at(spec.page, await page.evaluate(boundaries, spec.root));
  at(spec.page, await timed("whole", () => page.evaluate(wholeTexts)));
  at(spec.page, await timed("contrast", () => textContrast(page, walked.texts)));
  at(spec.page, await timed("clicks", () => page.evaluate(clicks)));
  at(`${spec.page} prominence`, await page.evaluate(prominence, `${spec.root} [data-part="summary"]`));
  at("5xx", server5xx);
  await page.close();
  return problems;
}

/** The drawer's parts a buyer must see and use. */
const DRAWER_MANDATORY = ['[data-part="drawer-header"]', '[data-part="drawer-lines"]', '[data-part="drawer-total"]', '[data-part="drawer-checkout"]'];

/**
 * The cart drawer over a public page, in the theme's arrangement: opened as a buyer opens it, every add-on row
 * opened, its parts on screen and uncovered, its words whole and at their floor, its controls taking a click. Its
 * look is the public page's (no colour table): the drawer claims what it draws.
 */
// ─── The payment step (page `checkout`) ───

/**
 * What a buyer must see and do on the payment step, read in the page: Pay and the total drawn, on screen when
 * scrolled to and taking a click at their centre; Pay never smaller, lighter or fainter than the step's secondary
 * action (the gift card's Apply) and its words readable on its fill; the total never smaller than another money
 * row and readable on what is behind it; the payment provider's own surface (`data-part="gateway"`) painted as the
 * store paints it, whatever the theme set.
 */
function checkoutChecks() {
  const problems = [];
  const linear = (channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const rgba = (value) => { const found = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/.exec(value); return found ? { channels: [found[1], found[2], found[3]].map(Number), alpha: found[4] === undefined ? 1 : Number.parseFloat(found[4]) / (found[4].endsWith("%") ? 100 : 1) } : null; };
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const behind = (element) => { for (let at = element; at; at = at.parentElement) { const back = rgba(getComputedStyle(at).backgroundColor); if (back && back.alpha > 0.99) return back.channels; } return [255, 255, 255]; };
  const drawn = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0.1 && box.width >= 8 && box.height >= 8;
  };
  const reachable = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.top >= 0 && box.bottom <= innerHeight && hit !== null && (hit === element || element.contains(hit));
  };
  const pay = document.getElementById("payButton");
  const totals = [...document.querySelectorAll('[data-private="checkout"] [data-summary-row="total"]')];
  if (!drawn(pay)) problems.push("Pay is not drawn");
  else if (!reachable(pay)) problems.push("Pay is not on screen or does not take a click at its centre");
  // Found on its card as Place order is: by its fill, or by a drawn edge (installActionFound).
  const lost = drawn(pay) ? window.__ptActionLost(pay, behind(pay.parentElement)) : null;
  if (lost) problems.push(`Pay: ${lost}`);
  if (totals.length === 0 || !totals.every(drawn)) problems.push("the total is not drawn");
  else if (!totals.every(reachable)) problems.push("the total is not on screen or is covered");
  for (const [name, element] of [["the summary", document.querySelector('[data-private="checkout"] [data-part="summary"]')], ["the payment methods", document.querySelector("#paymentMethods .payment-method-card")]]) {
    if (!drawn(element)) problems.push(`${name} is not drawn`);
  }
  const apply = document.getElementById("giftCardApply");
  if (pay && apply && drawn(pay)) {
    const [mine, theirs] = [getComputedStyle(pay), getComputedStyle(apply)];
    if (Number.parseFloat(mine.fontSize) < Number.parseFloat(theirs.fontSize)) problems.push(`Pay is drawn smaller than a secondary action (${mine.fontSize} under Apply's ${theirs.fontSize})`);
    if (Number(mine.fontWeight) < Number(theirs.fontWeight)) problems.push(`Pay is drawn lighter than a secondary action (${mine.fontWeight} under Apply's ${theirs.fontWeight})`);
    const fill = rgba(mine.backgroundColor);
    if (!fill || fill.alpha < 0.99) problems.push("Pay is drawn with no fill of its own: weaker than the store's filled actions");
    else if (ratio(rgba(mine.color).channels, fill.channels) < 4.5) problems.push(`Pay's words read ${ratio(rgba(mine.color).channels, fill.channels).toFixed(2)}:1 on its fill`);
  }
  const rows = [...document.querySelectorAll('[data-private="checkout"] [data-summary-row]')];
  for (const total of totals.filter(drawn)) {
    const size = Number.parseFloat(getComputedStyle(total).fontSize);
    const larger = rows.filter((row) => !["total", "due"].includes(row.dataset.summaryRow) && drawn(row) && Number.parseFloat(getComputedStyle(row).fontSize) > size);
    if (larger.length > 0) problems.push(`the total is drawn smaller than the ${larger[0].dataset.summaryRow} row`);
    const words = rgba(getComputedStyle(total).color);
    if (words && ratio(words.channels, behind(total)) < 4.5) problems.push(`the total reads ${ratio(words.channels, behind(total)).toFixed(2)}:1 on what is behind it`);
  }
  // The provider's surface against the same element outside every private page: the store's paint, untouched.
  const gateway = document.querySelector('[data-private="checkout"] [data-part="gateway"]');
  if (gateway) {
    const probe = document.createElement("div");
    probe.className = gateway.className;
    document.body.parentElement.appendChild(probe);
    for (const property of ["backgroundColor", "borderTopColor", "borderTopWidth", "borderTopLeftRadius", "padding"]) {
      if (getComputedStyle(gateway)[property] !== getComputedStyle(probe)[property]) problems.push(`gateway: the provider's surface is restyled (${property} ${getComputedStyle(gateway)[property]}, the store's ${getComputedStyle(probe)[property]})`);
    }
    probe.remove();
  } else problems.push("gateway: the provider's surface is not drawn in the payment part");
  return problems;
}

/** One draw of the payment step: the sample checkout settled, a method chosen, the summary open, then its checks. */
async function drawCheckout({ context, id, width, height = 900, request }) {
  const problems = [];
  const server5xx = [];
  const page = await context.newPage();
  page.on("response", (answer) => { if (answer.status() >= 500) server5xx.push(`${answer.status()} ${answer.request().method()} ${new URL(answer.url()).pathname}`); });
  await page.setViewportSize({ width, height });
  const answer = await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  if (answer && answer.status() >= 500) server5xx.push(`${answer.status()} the page`);
  const methods = await page.waitForSelector("#paymentMethods .payment-method-card", { timeout: 20_000 }).catch(() => null);
  if (!methods) problems.push("payment: no payment method was drawn");
  await page.locator(".payment-method-control").first().click({ timeout: 5_000 }).catch(() => {});
  if (await page.locator("#summaryPanel.hidden").count() > 0) await page.click("#orderSummaryToggle", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  problems.push(...(await page.evaluate(checkoutChecks)).map((problem) => `payment step: ${problem}`));
  if (request?.forged) problems.push(...(await page.evaluate(forgedAbsent, { words: FORGED_WORDS, mark: FORGED_MARK })).map((problem) => `forged: ${problem}`));
  problems.push(...server5xx.map((line) => `server: ${line}`));
  await page.close();
  return problems;
}
// ─── end of the payment step ───

async function drawDrawer({ context, id, width, problems, server5xx, state }) {
  const at = (label, list) => problems.push(...list.map((problem) => `${label}: ${problem}`));
  const page = await timed("load", () => open(context, id, width, server5xx));
  await page.waitForSelector("[data-cart-open], #cart-button", { timeout: 20_000 }).catch(() => {});
  await settle(page);
  await page.locator("[data-cart-open], #cart-button").filter({ visible: true }).first().click().catch(() => {});
  const drawer = await page.waitForSelector('[data-private="cart-drawer"]', { state: "visible", timeout: 10_000 }).catch(() => null);
  if (!drawer) at("drawer", ["the drawer did not open"]);
  else {
    // The drawer reads its suggestions once open: their rail lands before anything is measured, so no line moves under a reading.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await settle(page);
    const scope = '[data-private="cart-drawer"]';
    if (state === "customer-protected") {
      await page.waitForSelector(`${scope} [data-part="add-on-details"]`, { timeout: 10_000 }).catch(() => at("drawer", ["the add-on row is not drawn"]));
      await openAddOns(page, scope);
      const lines = await page.evaluate((scope) => [...document.querySelectorAll(`${scope} [data-part="add-on-detail"]`)].filter((line) => line.checkVisibility()).map((line) => line.textContent.replace(/\s+/g, " ").trim()), scope);
      if (JSON.stringify(lines) !== JSON.stringify(CUSTOMER_DETAILS)) at("drawer", [`the add-on row opens to ${JSON.stringify(lines)}, not its three lines in order`]);
      await settle(page);
    }
    const walked = await page.evaluate(walk, { rows: [], anatomy: [{ name: "the drawer", selector: scope }], uiKinds: UI_KINDS, mandatory: DRAWER_MANDATORY, scope, exempt: EXEMPT, styleTargets: [] });
    at("drawer", walked.problems);
    at("drawer", await page.evaluate(wholeTexts));
    at("drawer", await textContrast(page, walked.texts));
    at("drawer", await page.evaluate(clicks));
  }
  at("5xx", server5xx);
  await page.close();
  return problems;
}

/** Every add-on row in `scope` opened as a buyer opens it: a click on its bar (`<summary>`). */
async function openAddOns(page, scope) {
  const bars = page.locator(`${scope} [data-part="add-on-details"]:not([open]) > summary`);
  for (let index = (await bars.count()) - 1; index >= 0; index -= 1) {
    const bar = bars.nth(index);
    if (await bar.isVisible().catch(() => false)) await bar.click().catch(() => {});
  }
}

/** Place order on screen at scroll 0 and at three places down the cart (while the cart still meets the screen's bottom). */
async function dockChecks(page) {
  const problems = [];
  const end = await page.evaluate(() => Math.max(0, (document.querySelector('[data-private="cart"]')?.getBoundingClientRect().bottom ?? 0) + scrollY - innerHeight));
  for (const [index, fraction] of [0, 1 / 3, 2 / 3, 1].entries()) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), Math.round(end * fraction));
    await still(page);
    problems.push(...await page.evaluate(actionOnScreen, index === 0 ? "scroll 0" : `scroll ${Math.round(end * fraction)}px`));
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return problems;
}

/** Place order's place under the default look, for the same store and cart at this size (measured once each). */
const defaults = new Map();
function defaultInFlow(request = {}, state, width, height = 900) {
  const { noor, localization, tabs, toggle, reference, terms } = request;
  const shape = { noor, localization, tabs, toggle, reference, terms };
  const key = `${JSON.stringify(shape)}|${state}|${width}|${height}`;
  if (!defaults.has(key)) {
    defaults.set(key, (async () => {
      const id = `pp-default-${defaults.size}`;
      const answer = await fetch(`${gallery.url}/__gallery/private-theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, state, ...shape, privatePages: {} }) });
      if (answer.status !== 200) return null;
      const { storage } = await answer.json();
      const context = await browser.newContext({ viewport: { width, height } });
      try {
        await context.addInitScript((entries) => { for (const [name, value] of Object.entries(entries)) localStorage.setItem(name, value); }, storage);
        const page = await open(context, id, width, [], height);
        await settle(page);
        const toggle = page.locator('[data-part="fold-toggle"][aria-expanded="false"]');
        if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
        await page.waitForTimeout(150);
        await settle(page);
        return await page.evaluate(actionInFlow);
      } finally {
        await context.close();
      }
    })());
  }
  return defaults.get(key);
}

/** The details form filled as a buyer does (name, phone, address, city and thana from their lists, a delivery option); a problem, or null. */
async function fillDetails(page) {
  try {
    await page.fill("#customerName", "Anika Rahman");
    await page.fill("#customerPhone-input", "01712345678");
    await page.fill("#shippingAddress", "House 12, Road 5, Dhanmondi");
    for (const [field, text] of [["city", "Dhaka"], ["zone", "Dhan"]]) {
      await page.waitForFunction((id) => document.getElementById(id) && !document.getElementById(id).disabled, `checkout-${field}`, { timeout: 8_000 });
      await page.click(`#checkout-${field}`);
      // On a phone the list opens to pick from (the field is read-only); else the buyer types to narrow it.
      if (!(await page.locator(`#checkout-${field}`).getAttribute("readonly").then((value) => value !== null))) await page.fill(`#checkout-${field}`, text);
      await page.locator(`#checkout-${field}-list [role=option]`).filter({ hasText: text }).first().click({ timeout: 8_000 });
    }
    await page.locator("[data-shipping-options] input[type=radio]").first().check({ force: true, timeout: 8_000 });
    await page.waitForTimeout(300);
    return null;
  } catch (error) {
    return `the details could not be filled in (${String(error.message).split("\n")[0].slice(0, 120)})`;
  }
}

try {
  const named = Object.entries(REGRESSIONS)
    .filter(([name]) => !CASE || args.flatMap((value, index) => args[index - 1] === "--case" ? [value] : []).some((needle) => name.includes(needle)))
    .map(([name, entry]) => ({ name, ...entry }));
  const seeds = NO_SEEDS || (CASE && ONLY === null) ? [] : (ONLY !== null ? [ONLY] : Array.from({ length: SEEDS }, (_, index) => FROM + index));
  // Each seed draws a look the save takes: its first draft the save refuses gives way to the next of the seed's
  // drafts (the same ones in every run, so `--seed` replays it), each refusal counted. A seed none of whose
  // SEED_DRAFTS the save takes fails the gate: the drawn count is the seed count.
  const accepted = await Promise.all(seeds.map(async (seed) => {
    for (let draft = 0; draft < SEED_DRAFTS; draft += 1) {
      const generated = generate(draft === 0 ? seed : seed + draft * 100_003);
      const answer = await fetch(`${gallery.url}/__gallery/private-theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: `pp-draft-${seed}-${draft}`, state: "base", ...generated.request, privatePages: generated.privatePages }) });
      if (answer.status === 200) return { name: `seed ${seed}${draft ? ` (draft ${draft})` : ""}`, seed, ...generated };
      const issue = answer.status === 422 ? (await answer.json()).issues[0] : null;
      draftsRefused += 1;
      draftReasons[issue?.reason ?? `status ${answer.status}`] = (draftReasons[issue?.reason ?? `status ${answer.status}`] ?? 0) + 1;
    }
    failures.push({ index: -1, name: `seed ${seed}`, where: "save", problems: [`none of its ${SEED_DRAFTS} drafts is taken by the save: the gate draws fewer looks than it says`], document: generate(seed) });
    return null;
  }));
  const cases = [...(ONLY !== null || args.includes("--no-named") ? [] : named), ...accepted.filter(Boolean)];
  /** One case: its document saved, then drawn in each of its states. */
  const runCase = async (entry, index) => {
    const states = entry.states === "all" || ALL_STATES ? STATES : Array.isArray(entry.states) ? entry.states : entry.seed !== undefined ? ["base", STATES[1 + (entry.seed % (STATES.length - 1))]] : ["base"];
    for (const state of states) {
      const id = `pp-${index}-${state}`;
      const answer = await fetch(`${gallery.url}/__gallery/private-theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, state, ...entry.request, ...(entry.privatePages ? { privatePages: entry.privatePages } : {}) }) });
      if (answer.status === 422) {
        const issue = (await answer.json()).issues[0];
        if (state === states[0]) { refused += 1; reasons[issue?.reason ?? "?"] = (reasons[issue?.reason ?? "?"] ?? 0) + 1; }
        if (entry.refused && issue?.reason !== entry.refused) failures.push({ index, name: entry.name, where: "save", problems: [`refused for ${issue?.reason}, not ${entry.refused}: ${issue?.message}`], document: entry });
        // Refused for the break it names (`refusedFor`: the pair or key in the refusal's words), not for another.
        else if (entry.refusedFor && !entry.refusedFor.test(issue?.message ?? "")) failures.push({ index, name: entry.name, where: "save", problems: [`refused for another break: ${issue?.message}`], document: entry });
        // A named document meant to draw is legal: the save refusing it is a failure (it would test nothing).
        // Refused or drawn whole (`mayRefuse`: the refusal's reason and words it may be refused with).
        else if (entry.mayRefuse && entry.mayRefuse.test(`${issue?.reason}: ${issue?.message}`)) return;
        else if (!entry.refused && entry.seed === undefined && state === states[0]) failures.push({ index, name: entry.name, where: "save", problems: [`refused at save (${issue?.reason}: ${issue?.message}); a legal document must be taken`], document: entry });
        return;
      }
      assert.equal(answer.status, 200, `${entry.name}: the gallery did not take the document`);
      if (entry.refused && state === states[0]) failures.push({ index, name: entry.name, where: "save", problems: [`the save took it; it must be refused (${entry.refused})`], document: entry });
      const { storage, tables, degraded, refused: compileRefused } = await answer.json();
      if (state === states[0]) drawn += 1;
      // Every stored document reads (one the storefront cannot read draws the default theme and tests nothing); a forged
      // one reads with what it held dropped and its private pages' compile refused, a legal one never refused.
      if (degraded && state === states[0]) failures.push({ index, name: entry.name, where: "read", problems: ["the storefront cannot read the saved document: it draws the default theme"], document: entry });
      if (compileRefused !== Boolean(entry.request?.forged) && state === states[0]) failures.push({ index, name: entry.name, where: "read", problems: [compileRefused ? "the read refused a legal document's private pages" : "the read kept the private pages of a document holding what a theme cannot set"], document: entry });
      // Where the store's controls are drawn: the theme's place (the customer's: the header), the switch where the store
      // offers it, the market forms where it sells in two markets. A forged document's private pages draw the default
      // look's place (the header) under its own theme's switch.
      const controls = {
        place: degraded || compileRefused ? "header" : entry.request?.reference && !entry.privatePages ? "header" : entry.privatePages?.controls ?? "header",
        scheme: !degraded && entry.request?.toggle === true,
        localization: entry.request?.localization === true,
      };
      for (const scheme of SCHEMES) {
        // The colours the page draws in a browser that prefers `scheme`: the store's own where it shows one (a switch
        // starts there too), the browser's where it follows the system. Its rows are that palette's.
        const drawn = degraded ? null : entry.request?.scheme === "light" || entry.request?.scheme === "dark" ? entry.request.scheme : scheme;
        const rows = tables.find((table) => table.scheme === drawn)?.rows ?? tables[0]?.rows ?? [];
        for (const touch of [true, false]) {
          const plan = (AFTER_ORDER_PAGES[entry.request?.page] ? [{ width: 390, scheme: "light" }, { width: 390, scheme: "dark" }, { width: 1280, scheme: "light" }, { width: 1280, scheme: "dark" }] : entry.request?.page === "home" ? [{ width: 390, scheme: "light" }, { width: 1280, scheme: "dark" }] : drawsOf(state)).filter((each) => each.scheme === scheme && (each.width < 1280) === touch);
          if (plan.length === 0) continue;
          const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 }, hasTouch: touch });
          await context.addInitScript(installActionFound);
          await context.addInitScript((entries) => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, storage);
          for (const each of plan) {
            if (bailed) { await context.close(); return; }
            draws += 1;
            const problems = await draw({ context, id, state, ...each, rows, request: entry.request, controls, drawn });
            if (problems.length > 0) {
              failures.push({ index, name: entry.name, where: `${state} at ${each.width}px, ${scheme}`, problems, document: entry });
              // `--bail` (the mutations' runs): one failing draw is the answer.
              if (BAIL) bailed = true;
            }
          }
          await context.close();
        }
      }
    }
  };
  // A few cases at once: the gallery answers while each browser page draws.
  const queue = [...cases.entries()];
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await runCase(next[1], next[0]);
  }));
  failures.sort((a, b) => a.index - b.index);
  if (MUTATE) {
    const { files, applied, missed } = await fetch(`${gallery.url}/__gallery/mutation`).then((answer) => answer.json());
    const unapplied = files.filter((file) => !applied.includes(file) || missed.includes(file));
    if (unapplied.length > 0) { console.error(`mutation ${MUTATE}: not applied to ${unapplied.join(", ")} (it would test nothing)`); process.exitCode = 2; }
  }
} catch (error) {
  // A crash is not a failing draw: exit 2, so a mutation that breaks the harness is never counted as caught.
  console.error("the gate could not run:", error);
  process.exitCode = 2;
} finally {
  await browser.close();
  await gallery.close();
}
for (const failure of failures) {
  // Under a mutation every problem is printed: the run looks for the one its check names.
  const shown = MUTATE || args.includes("--all-problems") ? failure.problems.length : 12;
  console.error(`\n✗ ${failure.name}, ${failure.where}:\n  ${failure.problems.slice(0, shown).join("\n  ")}${failure.problems.length > shown ? `\n  … and ${failure.problems.length - shown} more` : ""}\n  document: ${JSON.stringify({ request: failure.document.request, privatePages: failure.document.privatePages })}`);
}
if (args.includes("--profile")) console.log(`time (s): ${Object.entries(PROFILE).map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}`).join(", ")}`);
console.log(`private pages, rendered: ${drawn} documents drawn in ${draws} draws (${refused} refused at save: ${JSON.stringify(reasons)}; seeds' drafts refused before one was taken: ${draftsRefused} ${JSON.stringify(draftReasons)}) at ${WIDTHS.join(", ")} px, light and dark, in ${Math.round((Date.now() - started) / 1000)}s: ${failures.length} failures${MUTATE ? ` (under mutation ${MUTATE})` : ""}${deepest ? `; the most a theme added above Place order: ${deepest.added}px with ${deepest.lines} lines (bound ${deepest.allowed}px)` : ""}`);
if (process.exitCode !== 2) process.exitCode = failures.length > 0 ? 1 : 0;
