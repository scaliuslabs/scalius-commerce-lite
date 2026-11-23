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
//   --jobs <n> cases at once (4); --profile where the time goes; PT_SHOTS=<dir> keeps the screen a
//   failing text was measured on. Exit 0: every draw holds; 1: a draw fails; 2: the gate could not run.
//
// Each document is a LEGAL theme (or a named break the save must refuse). A
// document the save refuses is not drawn. Each accepted one is drawn in its
// states (a store that delivers; a line asking for a decision, a store kit
// with an add-on once per kit and an app's offer row, and a sold-out line; an empty cart; long Bangla titles; an Arabic right-to-left
// presence) at 320, 390 and 1280 px, light and dark, and with validation
// errors showing, the sign-in dialog open and the confirmation dialog open.
// Every draw must hold:
// - every mandatory part inside the viewport, at most MAX_DEPTH_PX down, not
//   tiny, not covered by a free region; the page never scrolls sideways;
// - the coverage walk: every text and every focusable control the host draws
//   belongs to a row of the page's colour table (in token mode its words are
//   one of the row's colours and no surface the table does not know lies
//   between them and the row); with no tokens, to a surface the anatomy names,
//   and the page shows no paint of its own (a theme's page paint puts the page
//   in token mode, so the table checks what stands on it);
//   every free region sealed and holding inert markup only (no form, field, submit, host control or embed);
// - every text, with no budget, at its contrast floor against the pixels
//   behind it (the text hidden, the page photographed);
// - every text whole: nothing cut sideways, no glyph cut by a clip, no word
//   broken inside itself;
// - every control takes a click at its centre, is reached by Tab in document
//   order, shows a focus ring at 3:1 against what is around it, and under the
//   pointer still reads (and shows its hover where the host draws one);
// - on a phone, the page scrolls by touch from the top to Place order;
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
const STATES = ["base", "lines", "decide", "empty", "bn", "ar"];
/**
 * How far below the top a mandatory part may sit (24rem header, 3 blocks of 30rem, the host's own page with
 * two lines): a longer cart's own lines do not count, the theme's blocks inside them do (they repeat with
 * every line, so a line's blocks are short).
 */
const MAX_DEPTH_PX = 9000;

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
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    const started = Date.now();
    const run = gate(["--mutate", name, "--bail"], mutation.cases);
    const output = `${run.stdout}\n${run.stderr}`;
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
  console.log(`private pages gate, mutations: ${Object.keys(MUTATIONS).length - survived.length} of ${Object.keys(MUTATIONS).length} caught${survived.length ? `; survived: ${survived.join(", ")}` : ""}`);
  process.exit(survived.length > 0 ? 1 : 0);
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
const HOSTILE_CSS = [
  "min-inline-size:5000px", "white-space:nowrap", "inline-size:5000px", "width:200vw", "margin:-500px", "margin-block:5000px",
  "position:absolute;inset:-100vmax;z-index:2147483647;background:#ffffff", "outline:100vmax solid #ffffff", "outline-offset:-60px",
  "box-shadow:0 0 0 100vmax #ffffff", "text-shadow:0 900px 0 #ff0000", "transform:scale(30)", "transform:translateY(-2000px)",
  "font-size:200px", "letter-spacing:100px", "padding:5000px", "block-size:10000px", "display:grid;grid-template-columns:5000px",
  "vertical-align:-9999px", "float:left;inline-size:4000px", "text-decoration:line-through 3em #ffffff", "word-spacing:3000px",
];
const LONG = "Supercalifragilisticexpialidocious".repeat(8);
const PALETTES = ["retail", "marketplace", "boutique", "fresh", "beauty", "heritage", "midnight"];
const TONES = ["neutral", "info", "success", "warning", "critical"];
const UI_TARGETS = ["cart.page.summary", "cart.page.below", "cart.line.after", "checkout.contact.after", "checkout.delivery.after"];
/** Text and its surface chosen together (the save refuses an unreadable pair; most still pass). */
const PAIRS = [["card", "card-foreground"], ["background", "foreground"], ["#1e1831", "#f4f1ff"], ["#ffffff", "#111111"], ["#111111", "#ffffff"], ["#0f2a1d", "#ecfdf5"]];
/** The theme's own files the generator names: the gallery draws any `pp/<name>.svg` of the theme's app. */
const NOOR = "scalius.noor";

function generate(seed) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const colour = () => chance(0.6) ? pick(ROLES) : `#${Math.floor(next() * 0xffffff).toString(16).padStart(6, "0")}`;
  const chrome = chance(0.4) ? "theme" : "core";
  // A theme's own files exist only with a theme app: Noor's chrome brings one.
  const noor = chrome === "theme" || chance(0.2);
  const hooks = [];
  const words = () => chance(0.3) ? LONG : "Free delivery on every order this week";
  const block = () => {
    const hook = `block-${hooks.length}`;
    hooks.push(hook);
    const kinds = ["text", "heading", "banner", "link", "disclosure", "divider", ...(noor ? ["image"] : [])];
    const kind = pick(kinds);
    const content = kind === "banner" ? { kind, tone: pick(TONES), title: { en: words(), bn: "এই সপ্তাহে ফ্রি ডেলিভারি" } }
      : kind === "link" ? { kind, text: { en: "Read our delivery terms" }, href: "/pages/terms" }
        : kind === "disclosure" ? { kind, summary: { en: "How delivery works" }, text: { en: words() } }
          : kind === "divider" ? { kind }
            : kind === "image" ? { kind, image: { app: NOOR, file: "pp/banner.svg" }, alt: { en: "A banner" }, width: 640, height: 160 }
              : { kind, text: { en: words(), bn: "এই সপ্তাহে প্রতিটি অর্ডারে ফ্রি ডেলিভারি" } };
    return { type: "content", hook, content };
  };
  const layoutHooks = [];
  const wrap = (children) => {
    const hook = `wrap-${layoutHooks.length}`;
    layoutHooks.push(hook);
    return { type: "layout", layout: pick(["stack", "columns", "grid", "group"]), hook, children };
  };
  // The default arrangement (tokens only) a third of the time; else the cart's parts in a legal arrangement.
  const arranged = chance(0.67);
  let pages = {};
  if (arranged) {
    const cart = [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, ...(chance(0.5) ? [{ type: "part", part: "discount" }] : []), { type: "target", target: "cart.page.summary" }];
    const side = [{ type: "layout", layout: "fold", children: cart }, { type: "target", target: "cart.page.below" }];
    const before = Array.from({ length: int(0, 3) }, block);
    const between = Array.from({ length: int(0, 2) }, block);
    const after = Array.from({ length: int(0, 3) }, block);
    const main = chance(0.5) ? [wrap([wrap(side), ...between, { type: "part", part: "details" }])] : [...side, ...between, { type: "part", part: "details" }];
    const layout = [{ type: "part", part: "notices" }, ...before, ...main, ...after];
    const line = chance(0.5) ? undefined : [
      wrap([{ type: "part", part: "image" }, wrap([{ type: "part", part: "title" }, { type: "part", part: "details" }, { type: "part", part: "inputs" }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }]), wrap([{ type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove" }])]),
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
    if (chance(0.5)) set(`@${hook}`, { columns: tracks(), gap: pick([0, 48, int(0, 48)]), ...(chance(0.3) ? { "columns-wide": tracks() } : {}), ...(chance(0.2) ? { background: pick(["card", "muted", "#f8f5ff"]), radius: int(0, 32), padding: pick([0, 24, 48]) } : {}) });
  }
  const darkBox = (background) => background.startsWith("#1") || background.startsWith("#0") || background === "#111111";
  for (const target of ["lines", "summary", "details-form", "line", "page", "notice", "dialog"]) {
    if (!chance(0.35)) continue;
    const [background, text] = pick(PAIRS);
    const gradient = chance(0.2) && ["lines", "summary", "details-form", "page"].includes(target);
    // The page and a line keep the host's own text: their paint stays light (a dark page needs a dark palette).
    if (target === "line") set(target, { background: pick(["background", "card", "#ffffff", "#f8f5ff"]), radius: int(0, 32), padding: pick([0, 12, 48]), "border-width": int(0, 4), "border-style": pick(["solid", "dashed", "dotted", "none"]) });
    else if (target === "page") set(target, gradient ? { gradient: { shape: pick(["linear", "radial"]), angle: int(0, 360), from: "#ffffff", to: "#f3eefe" } } : { background: pick(["background", "card", "#ffffff", "#f8f5ff"]) });
    else if (target === "notice") set(target, { background, text, muted: text, link: text, error: text, radius: int(0, 32), border: colour(), "border-width": int(0, 4) });
    else set(target, { ...(gradient ? { gradient: { shape: "linear", angle: int(0, 360), from: background, to: background } } : { background }), text, muted: text, link: text, error: text, radius: pick([0, 32, int(0, 32)]), ...(target === "dialog" ? {} : { padding: pick([0, 48]) }), shadow: pick(["none", "sm", "md", "lg"]) });
    // Fields beside a dark box keep a ring and an error border that read on light and dark.
    if (darkBox(background)) set("input", { ring: "#8b5cf6", invalid: "#e11d48" });
  }
  // Every other style target, now and then, with values of its types.
  const text = () => ({ ...(chance(0.5) ? { size: pick([12, 40, int(12, 40)]) } : {}), ...(chance(0.4) ? { weight: pick(["400", "500", "600", "700", "800"]) } : {}), ...(chance(0.3) ? { case: pick(["none", "uppercase"]) } : {}), ...(chance(0.3) ? { tracking: pick(["normal", "wide", "wider"]) } : {}), ...(chance(0.3) ? { font: pick(["body", "heading"]) } : {}) });
  const maybe = (target, values) => { if (chance(0.3)) set(target, values); };
  maybe("lines-heading", text());
  maybe("line-title", { ...text(), ...(chance(0.6) ? { clamp: pick(["none", "2", "3"]) } : {}) });
  maybe("line-details", { size: int(12, 20) });
  maybe("line-price", { size: int(12, 28), weight: pick(["400", "700"]), align: pick(["start", "center", "end"]) });
  maybe("line-quantity", { radius: int(0, 32), "border-width": int(0, 4), "border-style": pick(["solid", "dashed"]), ring: "#7c3aed" });
  maybe("line-remove", { radius: int(0, 32), ring: "#7c3aed" });
  maybe("line-image", { width: pick([40, 240]), height: pick([40, 320]), "width-wide": pick([40, 240]), radius: int(0, 32), fit: pick(["contain", "cover"]) });
  maybe("fold-toggle", { radius: int(0, 32), shadow: pick(["none", "md"]), "border-width": int(0, 4) });
  maybe("summary-rows", { size: int(12, 24) });
  maybe("summary-total", { ...text(), weight: "800" });
  maybe("section-heading", text());
  maybe("legal", { size: int(12, 18), align: pick(["start", "center", "end"]) });
  maybe("submit", { background: "#7c3aed", text: "#ffffff", radius: pick([0, 32]), case: "uppercase", size: pick([12, 40]), tracking: pick(["normal", "wider"]) });
  maybe("action", { radius: int(0, 32), weight: "700" });
  maybe("input", { radius: int(0, 32), "border-width": int(0, 4) });
  maybe("frame", { "max-width": pick([480, 1600]) });
  maybe("dialog-back", { radius: int(0, 32), weight: "600" });
  maybe("dialog-confirm", { background: "#7c3aed", text: "#ffffff", radius: int(0, 32) });
  maybe("cart-empty", { text: "foreground" });
  if (chrome === "theme") maybe("search", { radius: int(0, 32), "border-width": int(1, 4) });
  // The apps' nodes by kind, narrowed by tone, app and target.
  for (let count = int(0, 4); count > 0; count -= 1) {
    const kind = pick(["banner", "badge", "button", "text", "heading", "disclosure", "row"]);
    const tone = ["banner", "badge"].includes(kind) && chance(0.6) ? `.${pick(TONES)}` : "";
    const key = `ui.${kind}${tone}${chance(0.4) ? `@${pick(["acme.kinds", "acme.protection", "acme.loyalty"])}` : ""}${chance(0.4) ? `/${pick(UI_TARGETS)}` : ""}`;
    const values = kind === "row" ? { gap: int(0, 48) }
      : kind === "text" || kind === "heading" ? { size: int(12, 24), weight: pick(["400", "700"]) }
        : kind === "button" ? { background: "#10b981", text: "#04130d", radius: int(0, 32), weight: "700" }
          : kind === "badge" ? { background: "#fffbeb", text: "#111111", radius: int(0, 32) }
            : { background: "#fffbeb", text: "#111111", border: colour(), radius: int(0, 32) };
    set(key, values);
  }
  const labels = {
    ...(chance(0.3) ? { "cart.continue": pick(["continue-shopping", "keep-shopping", "back-to-store"]) } : {}),
    ...(chance(0.3) ? { "cart.subtotal": pick(["subtotal", "items-total"]) } : {}),
    ...(chance(0.3) ? { "cart.showSummary": pick(["show-summary", "show-cart"]), "cart.hideSummary": pick(["hide-summary", "hide-cart"]) } : {}),
    ...(chance(0.3) ? { "dialog.goBack": pick(["go-back", "cancel"]), "dialog.confirm": pick(["confirm", "continue-checkout", "agree-and-continue"]) } : {}),
    ...(chance(0.3) ? { "cart.heading": { en: chance(0.5) ? "Your bag, ready when you are" : "Cart", bn: "আপনার কার্ট" } } : {}),
    ...(chance(0.3) ? { "cart.empty": { en: "Nothing here yet" }, "cart.emptyText": { en: "Your bag is waiting for something lovely." } } : {}),
  };
  const icons = noor && chance(0.5) ? { "cart.empty": { app: NOOR, file: "pp/bag.svg" } } : {};
  const css = [...hooks, ...(chrome === "theme" ? ["header", "footer"] : [])].flatMap((anchor) => chance(0.8)
    ? [`${anchor === "header" || anchor === "footer" ? `[data-free="${anchor}"]` : `[data-hook="${anchor}"]`} ${pick(["*", "p", "h2", "div", "a", "*::before"])} { ${Array.from({ length: int(1, 3) }, () => pick(HOSTILE_CSS)).join(";")}${chance(0.3) ? ';content:"Delivery phone number (required)"' : ""} }`]
    : []).join("\n");
  return {
    request: { noor, palette: chance(0.5) ? pick(PALETTES) : undefined, scheme: pick(["system", "system", "light", "dark"]), toggle: chance(0.3) },
    privatePages: { chrome, ...(chrome === "theme" && chance(0.7) ? { search: pick(["before", "after"]) } : {}), pages, tokens: Object.keys(tokens).length ? { cart: tokens } : {}, css, labels, icons },
  };
}

// ─── The named cases ──────────────────────────────────────────────────────

const LEGAL_COLUMNS = [{ type: "part", part: "notices" }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }] }, { type: "part", part: "details" }] }];
const DARK = { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#c4b5fd", error: "#fca5a5" };
/** The cart line's default arrangement (private-anatomy.ts), and the largest image block a line may hold. */
const DEFAULT_LINE = [{ type: "part", part: "image" }, { type: "layout", layout: "stack", children: [{ type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "part", part: "title" }, { type: "part", part: "details" }, { type: "part", part: "inputs" }, { type: "target", target: "cart.line.after" }] }, { type: "part", part: "remove" }] }, { type: "layout", layout: "columns", children: [{ type: "part", part: "quantity" }, { type: "part", part: "price" }] }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }] }];
const LINE_IMAGE = (hook) => ({ type: "content", hook, content: { kind: "image", image: { app: NOOR, file: "pp/banner.svg" }, alt: { en: "A banner" }, width: 2000, height: 2000 } });
const PAINT = { kind: "linear", angle: 160, stops: ["background", "muted", "secondary"] };
const DARK_PAINT = { kind: "radial", at: "top", stops: ["muted", "background", "secondary"] };

/**
 * The reviews' concrete breaks: each must hold when drawn (in the states it
 * names, all of them with `states: "all"`), or be refused at save with the
 * reason it names (`refused`).
 */
const REGRESSIONS = {
  "review 3: a block widens the page": { privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "intro", content: { kind: "text", text: { en: LONG } } }, ...LEGAL_COLUMNS.slice(1)] } }, css: '[data-hook="intro"] p { min-inline-size: 5000px; white-space: nowrap }' } },
  "review 3: a dark form's text reaches its fields": { privatePages: { tokens: { cart: { "details-form": { background: "#111111", text: "#ffffff", muted: "#cccccc", link: "#a78bfa", error: "#f87171" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } } },
  "review 3: two 480px columns on a phone": { privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "layout", layout: "grid", hook: "two", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }, { type: "part", part: "details" }] }] } }, tokens: { cart: { "@two": { columns: [480, 480], gap: 48 } } } } },
  "review 2: shadows, outlines and covers from a block": { privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "promo", content: { kind: "text", text: { en: "Free delivery" } } }, ...LEGAL_COLUMNS.slice(1)] } }, css: '[data-hook="promo"] p { outline: 100vmax solid #fff; box-shadow: 0 0 0 100vmax #fff; text-shadow: 0 900px 0 #fff } [data-hook="promo"] p::after { content: "990"; position: absolute; inset: -100vmax; z-index: 2147483647; background: #fff }' } },
  "review 3: the header's search disguised as a checkout field": { request: { noor: true }, privatePages: { chrome: "theme", search: "after", css: '[data-free="header"] form::before { content: "Delivery phone number (required)" } [data-free="header"] button::after { content: "Confirm order" } [data-free="header"] * { white-space: nowrap; min-inline-size: 3000px }' } },
  // Review 4: what the contrast check modelled and the CSS did not draw.
  // A palette whose cards differ from its page: a summary drawn inside the dark panel would paint its own card there.
  "review 4, B1: tokens only, a dark lines panel over the default arrangement's summary": { request: { palette: "heritage" }, privatePages: { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } } },
  "review 4, B2: an app's warning and success badges under a dark line": { privatePages: { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } } },
  "review 4, B3: the sign-in dialog under dark dialog tokens": { privatePages: { tokens: { cart: { dialog: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } } },
  "review 4, S3: the theme's header styling the store's search from its region": { request: { noor: true }, privatePages: { chrome: "theme", search: "after", css: '[data-free="header"] div { visibility: hidden; pointer-events: none; font-size: 60px; direction: rtl }' } },
  // Review 4, B4: the gate could not see the details form; a dark one, tokens only, in every state.
  "review 4, B4: tokens only, a dark details form in every state": { states: "all", privatePages: { tokens: { cart: { "details-form": DARK } } } },
  // The apps' blocks inside the details form stand on its row, and a theme styles them there by `ui.*`.
  "the apps' blocks in a dark details form, styled by target": { privatePages: { tokens: { cart: { "details-form": DARK, "ui.banner.warning/checkout.delivery.after": { background: "#3a2a0a", text: "#fde68a", border: "#f59e0b" }, "ui.button/checkout.contact.after": { background: "#7c3aed", text: "#ffffff", radius: 12 } } } } },
  "review 4, S6: Place order's focus ring on a dark form": { privatePages: { tokens: { cart: { "details-form": DARK, submit: { background: "#7c3aed", text: "#ffffff", radius: 0 } } } } },
  "review 4, S8: a 40px wide-tracked title clamped to two lines": { privatePages: { tokens: { cart: { "line-title": { size: 40, tracking: "wider", clamp: "2" } } } } },
  "review 4: every node kind under a dark summary and a dark line, in every state": { states: "all", privatePages: { tokens: { cart: { summary: DARK, lines: DARK, "ui.banner.warning/cart.line.after": { background: "#3a2a0a", text: "#fde68a", border: "#f59e0b" } } } } },
  // A dark page in a theme that shows dark colours: the dark rows write every cell the light rows write (else the
  // light lines panel's dark focus ring reads on the dark one).
  "a dark page under the dark colours": { request: { scheme: "system" }, privatePages: { tokens: { cart: { page: DARK } } } },
  "the store's own header under dark tokens": { privatePages: { tokens: { cart: { chrome: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#c4b5fd" } } } } },
  "the store's own page, no theme, in every state": { states: "all", privatePages: {} },
  // The theme's chrome with no header skin: the store's own checkout header draws, in token mode like the rest.
  "the theme's chrome with no header skin, under a dark page": { request: { noor: true, headerSkin: false }, privatePages: { chrome: "theme", tokens: { cart: { page: DARK } } } },
  "the theme's chrome with no header skin, no tokens": { request: { noor: true, headerSkin: false, scheme: "dark" }, privatePages: { chrome: "theme" } },
  // The theme's page paint (tokens.pagePaint) shows on private pages: behind the store's own page, and under tokens
  // that paint no page surface, where the table checks every word along the gradient.
  "the theme's page paint behind the store's own page": { request: { paint: PAINT }, privatePages: {} },
  "the theme's page paint under a dark summary": { request: { paint: PAINT, scheme: "light" }, privatePages: { tokens: { cart: { summary: DARK, page: { text: "#000000" } } } } },
  // A dark page paint (the dark colours' own stops): with no tokens the page is drawn in token mode, its default rows
  // computed from the paint; with tokens, those that paint no page surface stand on it too.
  "a dark page paint, no private tokens": { states: "all", request: { palette: "retail", scheme: "dark", paint: DARK_PAINT }, privatePages: {} },
  "a dark page paint under dark tokens": { request: { palette: "retail", scheme: "dark", paint: DARK_PAINT }, privatePages: { tokens: { cart: { summary: DARK, lines: DARK } } } },
  // Review 5, B1: the theme's chrome and a large image block, with no stylesheet, tokens or paint: the seal is the host's.
  "review 5, B1: the theme's chrome and a 2000px image block with no look of its own": { request: { noor: true }, privatePages: { chrome: "theme", pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "big", content: { kind: "image", image: { app: NOOR, file: "pp/banner.svg" }, alt: { en: "A banner" }, width: 2000, height: 2000 } }, ...LEGAL_COLUMNS.slice(1)] } } } },
  // Review 5, B2: the store's controls (the colour scheme switch, the market and language forms) once drew inside the
  // theme's header and footer, where its stylesheet reaches; the regions now hold inert markup only.
  // The store draws them beside the regions (`privatePages.controls`), where the colour table covers them.
  "review 5, B2: the theme's header and footer in a store with a scheme switch and two markets": { request: { noor: true, toggle: true, localization: true }, privatePages: { chrome: "theme", search: "after", css: '[data-free="footer"] select { opacity: 0; position: absolute; inset: 0 } [data-free="header"] button { opacity: 0 }' } },
  "review 5, B2: the store's controls before the regions, under dark tokens": { request: { noor: true, toggle: true, localization: true, scheme: "system" }, privatePages: { chrome: "theme", controls: "before", tokens: { cart: { page: DARK, scheme: { text: "#ffffff", ring: "#c4b5fd" }, localization: { text: "#ffffff" } } } } },
  // Review 5, S4: between a deploy and the maintenance compile the default look is served: it stands on the page colour,
  // never on the theme's page paint, which no table checked it on.
  "review 5, S4: a page paint behind a look this build has not compiled": { request: { paint: PAINT, scheme: "light", stale: true }, privatePages: { tokens: { cart: { summary: DARK } } } },
  // Review 5, S5: a line's blocks repeat with every line. Twenty lines, each with the two largest legal blocks, and the
  // page's one block before the form: Place order is still within reach.
  "review 5, S5: twenty lines, each with two 2000px image blocks": { states: ["many"], request: { noor: true }, privatePages: { pages: { cart: {
    layout: [{ type: "part", part: "notices" }, { type: "content", hook: "lead", content: { kind: "image", image: { app: NOOR, file: "pp/banner.svg" }, alt: { en: "A banner" }, width: 2000, height: 2000 } }, ...LEGAL_COLUMNS.slice(1)],
    items: { line: [LINE_IMAGE("line-top"), ...DEFAULT_LINE, LINE_IMAGE("line-end")] },
  } } } },
  // Review 5, S6: the theme's phone tab bar (`bottom-tabs`) under the theme's chrome, drawn outside token scope.
  "review 5, S6: the theme's chrome with the phone tab bar, under a dark page": { request: { noor: true, tabs: true }, privatePages: { chrome: "theme", tokens: { cart: { page: DARK } } } },
  "review 5, S6: the theme's chrome with the phone tab bar, no tokens": { request: { noor: true, tabs: true, scheme: "dark" }, privatePages: { chrome: "theme" } },
  // Review 5: the default look under a palette whose action colour is a mid tone. A field's focus turns its border
  // the ring colour, which must read at 3:1 on the field's own border, in the derived dark colours too.
  "review 5: the store's own page under the marketplace palette's dark colours": { request: { palette: "marketplace", scheme: "dark" }, privatePages: {} },
  // A filled button's hover once mixed its colour with the page (`bg-primary/90`): white on it read 4.42:1.
  "review 5: the store's own page under the marketplace palette's light colours": { request: { palette: "marketplace", scheme: "light" }, privatePages: {} },
  // Review 6, B1: a header skin draws its own light or dark switch (and the host sign-in's account link), and its
  // stylesheet hides that switch in dark colours and on a phone. The region keeps no host behaviour, so the store's
  // switch never yields to it: it shows at every width, in both schemes.
  "review 6, B1: the theme's header draws its own scheme switch and hides it": { request: { noor: true, toggle: true, skinSwitch: true, scheme: "system" }, privatePages: { chrome: "theme", css: ':root[data-color-scheme="dark"] [data-free="header"] button { display: none } @media (max-width: 500px) { [data-free="header"] button { visibility: hidden } }' } },
  // What the save must refuse (under a mutation that lets one through, the drawing must fail).
  "a stylesheet hiding a host part": { refused: "unscoped_selector", privatePages: { css: '[data-part="summary"] * { display: none } [data-part="details-submit"] * { visibility: hidden }' } },
  // Review 6, B2: a block shown or hidden by how far down it sits, which is the cart's length (a view timeline).
  "a block whose look follows the page": { refused: "unknown_property", privatePages: { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "ready", content: { kind: "text", text: { en: "x" } } }, ...LEGAL_COLUMNS.slice(1)] } }, css: '[data-hook="ready"] p { view-timeline: --t-v block; animation: t-few linear both; animation-timeline: --t-v; animation-range: cover 0% cover 1% } [data-hook="ready"] p::after { content: "Your order qualifies for free delivery" } @keyframes few { from { visibility: hidden } to { visibility: visible } }' } },
  "summary rows that do not read on their summary": { refused: "contrast", privatePages: { tokens: { cart: { "summary-rows": { text: "#eeeeee" }, summary: { background: "#ffffff" } } } } },
  // #757575 reads on retail's white page (4.6:1) but not where the paint reaches its muted colour (3.9:1).
  "page words that do not read on the theme's page paint": { refused: "contrast", request: { palette: "retail", scheme: "light", paint: PAINT }, privatePages: { tokens: { cart: { page: { text: "#757575" } } } } },
};

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
 * Not the store's buyer-facing page: the gallery's own scaffolding, the theme's
 * free regions (its own words, which its stylesheet owns), and text no buyer
 * sees (scripts, styles, templates). Listed here and nowhere else.
 */
const EXEMPT = "script,style,template,noscript,[data-free],#gallery-page-end,vite-error-overlay";

/**
 * The walk over the page (or one open dialog): marks every text and control
 * the host draws, checks each against the colour table (or, with no tokens,
 * the anatomy's style targets) and returns them for the pixel checks.
 */
function walk({ rows, anatomy, uiKinds, mandatory, scope, maxDepth, exempt }) {
  const problems = [];
  const width = innerWidth;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { problems: [`${scope}: not open`], texts: [], controls: [] };
  if (document.documentElement.scrollWidth > width + 1) problems.push(`the page scrolls sideways: ${document.documentElement.scrollWidth}px at ${width}px`);
  // Every free region is sealed by the host, whatever the theme's look holds: its own containing block, paint
  // contained and clipped, a bounded height.
  for (const region of document.querySelectorAll("[data-free]")) {
    const style = getComputedStyle(region);
    if (!/paint|content|strict/.test(style.contain) || style.overflowY === "visible" || style.maxBlockSize === "none" || style.position === "static") {
      problems.push(`[data-free="${region.dataset.free}"]: not sealed (contain: ${style.contain}, overflow: ${style.overflowY}, max-block-size: ${style.maxBlockSize})`);
    }
  }
  const name = (element) => {
    const bits = [];
    for (let at = element; at && at !== document.body && bits.length < 3; at = at.parentElement) {
      bits.unshift(`${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}${at.dataset.part ? `[data-part=${at.dataset.part}]` : ""}${at.dataset.ui ? `[data-ui=${at.dataset.ui}]` : ""}`);
    }
    return bits.join(">");
  };
  for (const old of document.querySelectorAll("[data-pt-text],[data-pt-control]")) { old.removeAttribute("data-pt-text"); old.removeAttribute("data-pt-control"); }
  // The host's own height of each line past the second (the line less the theme's blocks in it): not the theme's depth.
  const ownLines = [...document.querySelectorAll('[data-private="cart"] [data-part="line"]')].slice(2).map((line) => ({
    line,
    own: line.getBoundingClientRect().height - [...line.querySelectorAll("[data-free]")].reduce((sum, region) => sum + region.getBoundingClientRect().height, 0),
  }));
  // Mandatory parts: on screen, within reach, of a size, uncovered.
  for (const selector of mandatory) {
    const element = root.querySelector(selector);
    if (!element) { problems.push(`${selector}: missing`); continue; }
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const box = element.getBoundingClientRect();
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || box.width < 8 || box.height < 8) { problems.push(`${selector}: not visible (${Math.round(box.width)}×${Math.round(box.height)})`); continue; }
    if (box.left < -1 || box.right > width + 1) problems.push(`${selector}: outside the viewport (${Math.round(box.left)}..${Math.round(box.right)} of ${width})`);
    const depth = box.top + scrollY - ownLines.reduce((sum, { line, own }) => sum + (line.getBoundingClientRect().bottom <= box.top && !line.contains(element) ? own : 0), 0);
    if (depth > maxDepth) problems.push(`${selector}: ${Math.round(depth)}px down (the cart's own lines past the second not counted)`);
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]]) {
      const x = Math.min(width - 1, Math.max(0, box.left + box.width * fx));
      const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height * fy));
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest("[data-free]") && !element.contains(hit)) { problems.push(`${selector}: covered by a free region at ${Math.round(x)},${Math.round(y)}`); break; }
    }
  }
  // The rows: each element its last matching row (the table's CSS is in row order at one specificity).
  const rowOf = new Map();
  for (const row of rows) for (const element of document.querySelectorAll(row.selector)) rowOf.set(element, row);
  const claimOf = new Map();
  for (const target of anatomy) for (const element of document.querySelectorAll(target.selector)) if (!claimOf.has(element)) claimOf.set(element, target.name);
  const tokenMode = rows.length > 0;
  const nearestRow = (element) => { for (let at = element; at; at = at.parentElement) if (rowOf.has(at)) return at; return null; };
  const nearestClaim = (element) => { for (let at = element; at; at = at.parentElement) if (claimOf.has(at)) return at; return null; };
  const paints = (element) => { const style = getComputedStyle(element); return !/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(style.backgroundColor) || style.backgroundImage !== "none"; };
  const parse = (value) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
    return hex ? `rgb(${parseInt(hex[1].slice(0, 2), 16)}, ${parseInt(hex[1].slice(2, 4), 16)}, ${parseInt(hex[1].slice(4), 16)})` : value.trim();
  };
  const cellsOf = (row) => { const style = getComputedStyle(row); return ["--pt-t", "--pt-m", "--pt-l", "--pt-e"].map((cell) => parse(style.getPropertyValue(cell))); };
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
    texts.push({ id: texts.length, label: `${placeholder ? "placeholder" : "value"} of ${name(field)}`, color, large: false });
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
        if (clip && !clip.scrolls) {
          const sideways = rect.left < clip.box.left - 1 || rect.right > clip.box.right + 1;
          const cut = (rect.top < clip.box.top - 1 && rect.bottom > clip.box.top + 1) || (rect.top < clip.box.bottom - 1 && rect.bottom > clip.box.bottom + 1);
          if (sideways && rect.bottom > clip.box.top && rect.top < clip.box.bottom) { problems.push(`${label}: "${segment}" is cut off at the side`); break; }
          if (cut) { problems.push(`${label}: "${segment}" is cut through by its box`); break; }
        }
        if (previous && word.test(previous.segment) && word.test(segment) && rect.top >= previous.rect.bottom - 2) {
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
      problems.push(`control ${control.tagName.toLowerCase()}${control.id ? `#${control.id}` : ""}[${control.dataset.part ?? control.textContent.trim().slice(0, 20)}]: a click at its centre lands on ${hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${hit.closest("[data-free]") ? " in a free region" : ""}` : "nothing"}`);
    }
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
  for (let guard = 0; pending.size > 0 && guard < 80; guard += 1) {
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
        const top = whole && rects.every((rect) => {
          const hit = document.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
          return !hit || element.contains(hit) || hit.contains(element);
        });
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
      const worst = ratios[Math.floor(ratios.length * 0.05)];
      const floor = text.large ? 3 : 4.5;
      if (worst < floor - 0.05) {
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
  // Enough presses for every focusable on the page, the theme's regions' own links included.
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
      const worst = ratios[Math.floor(ratios.length * 0.05)];
      if (worst < (word.large ? 3 : 4.5) - 0.05) problems.push(`control ${control.label} hovered: "${word.text}" ${word.color} reads ${worst.toFixed(2)}:1 on what is behind it`);
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

/** On a phone: swiping from the top reaches Place order (nothing on the way takes the gesture). */
async function touchScroll(page, selector) {
  const session = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  const x = Math.round(viewport.width / 2);
  const touch = (type, y) => session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: Math.round(y) }] });
  await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: "instant" }));
  try {
    let last = -1;
    let stuck = 0;
    for (let swipe = 0; swipe < 60; swipe += 1) {
      const { top, y } = await page.evaluate((selector) => ({ top: document.querySelector(selector)?.getBoundingClientRect().top ?? null, y: Math.round(scrollY) }), selector);
      if (top === null) return [`${selector}: missing for the touch scroll`];
      if (top < viewport.height - 48) return [];
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
const gallery = await startGallery();
const { styles, ui: UI_KINDS, inert: INERT } = await fetch(`${gallery.url}/__gallery/private-anatomy`).then((answer) => answer.json());
/**
 * Nothing but inert markup inside a free region, by construction: every element there is one the inert
 * rebuild writes, with only the attributes it writes (plugins/inert-html.ts `inertMarkupProblems`, the
 * very function, run in the page). No form, field, submit button, host control or embed can hide there.
 */
const INERT_CHECK = `[...document.querySelectorAll("[data-free]")].flatMap((region) => (${INERT.check})(region, ${JSON.stringify(INERT.markup)}).map((problem) => \`[data-free="\${region.dataset.free}"] \${problem}\`))`;
/**
 * With no tokens (the store's own colours, no table) the walk claims by the
 * anatomy: everything the host draws must sit inside a surface it names (the
 * page's root, a style target, a dialog, the store's header, the theme's
 * chrome frame, the host's search). The body (`page`) holds everything, so it
 * claims only the skip link.
 */
const ANATOMY = Object.entries(styles)
  .filter(([name]) => name !== "page")
  .map(([name, style]) => ({ name, selector: style.absolute ? style.selector : `[data-private="cart"] ${style.selector}`.trim() }))
  .concat([{ name: "the theme's chrome frame", selector: '[data-private="header"],[data-private="footer"]' }, { name: "the skip link", selector: 'a[href="#main-content"]' }]);
const browser = await chromium.launch();
const failures = [];
let drawn = 0;
let draws = 0;
let refused = 0;
const reasons = {};
const started = Date.now();
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
  return [[320, "light"], [1280, "dark"]].map(([width, scheme]) => ({ width, scheme, focus: false, interact: false }));
}

/** Every running animation and transition finished (a dialog fading in is not yet what a buyer reads). */
async function settle(page) {
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

async function open(context, id, width, server5xx) {
  const page = await context.newPage();
  page.on("response", (answer) => { if (answer.status() >= 500) server5xx.push(`${answer.status()} ${answer.request().method()} ${new URL(answer.url()).pathname}`); });
  await page.setViewportSize({ width, height: 900 });
  const answer = await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  if (answer && answer.status() >= 500) server5xx.push(`${answer.status()} the page`);
  await page.waitForSelector('[data-private="cart"][data-cart-state="items"],[data-private="cart"][data-cart-state="empty"]', { timeout: 20_000 }).catch(() => {});
  return page;
}

/** One draw: the page in one state at one width and scheme, with its interactions. */
async function draw({ context, id, state, width, focus, hover, interact, rows, chrome, search, controls }) {
  const problems = [];
  const server5xx = [];
  const page = await timed("load", () => open(context, id, width, server5xx));
  // With the theme's chrome its header region is drawn (else the seed tests nothing of the chrome), and the host's search where it says.
  // The store's controls beside the theme's regions where it draws them: the switch, and the market and language forms.
  const chromeParts = [...(chrome ? ['[data-free="header"]'] : ['[data-private="core-header"]']), ...(search ? ['[data-host="search"]'] : []), ...(controls ?? [])];
  const mandatory = [...(state === "empty" ? EMPTY_MANDATORY : state === "lines" ? LINES_MANDATORY : MANDATORY), ...chromeParts];
  const at = (label, list) => problems.push(...list.map((problem) => `${label}: ${problem}`));
  const check = async (label, scope, list, { controls: wantControls = true } = {}) => {
    await timed("settle", () => settle(page));
    const walked = await timed("walk", () => page.evaluate(walk, { rows, anatomy: ANATOMY, uiKinds: UI_KINDS, mandatory: list, scope, maxDepth: MAX_DEPTH_PX, exempt: EXEMPT }));
    at(label, walked.problems);
    at(label, await page.evaluate(INERT_CHECK));
    at(label, await timed("whole", () => page.evaluate(wholeTexts)));
    at(label, await timed("contrast", () => textContrast(page, walked.texts)));
    if (wantControls) at(label, await timed("clicks", () => page.evaluate(clicks)));
    return walked;
  };
  await timed("settle", () => settle(page));
  // Phones: Tab order and the touch scroll run before anything is clicked.
  if (width < 1280 && state !== "empty") at("touch", await timed("touch", () => touchScroll(page, '[data-part="details-submit"]')));
  if (focus) {
    const { controls } = await page.evaluate(walk, { rows, anatomy: ANATOMY, uiKinds: UI_KINDS, mandatory: [], scope: null, maxDepth: MAX_DEPTH_PX, exempt: EXEMPT });
    at("focus order", await timed("tab", () => focusOrder(page, controls)));
  }
  // On a phone the cart folds behind its bar: open it, as a buyer does.
  const toggle = page.locator('[data-part="fold-toggle"][aria-expanded="false"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
  await page.waitForTimeout(150);
  const page0 = await check(state, null, mandatory);
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
  const cases = [...(ONLY !== null || args.includes("--no-named") ? [] : named), ...seeds.map((seed) => ({ name: `seed ${seed}`, seed, ...generate(seed) }))];
  /** One case: its document saved, then drawn in each of its states. */
  const runCase = async (entry, index) => {
    const states = entry.states === "all" || ALL_STATES ? STATES : Array.isArray(entry.states) ? entry.states : entry.seed !== undefined ? ["base", STATES[1 + (entry.seed % (STATES.length - 1))]] : ["base"];
    for (const state of states) {
      const id = `pp-${index}-${state}`;
      const answer = await fetch(`${gallery.url}/__gallery/private-theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, state, ...entry.request, privatePages: entry.privatePages }) });
      if (answer.status === 422) {
        const issue = (await answer.json()).issues[0];
        if (state === states[0]) { refused += 1; reasons[issue?.reason ?? "?"] = (reasons[issue?.reason ?? "?"] ?? 0) + 1; }
        if (entry.refused && issue?.reason !== entry.refused) failures.push({ index, name: entry.name, where: "save", problems: [`refused for ${issue?.reason}, not ${entry.refused}: ${issue?.message}`], document: entry });
        else if (!entry.refused && entry.seed === undefined) console.log(`${entry.name}: refused at save (${issue?.reason}: ${issue?.message})`);
        return;
      }
      assert.equal(answer.status, 200, `${entry.name}: the gallery did not take the document`);
      if (entry.refused && state === states[0]) failures.push({ index, name: entry.name, where: "save", problems: [`the save took it; it must be refused (${entry.refused})`], document: entry });
      const { storage, tables } = await answer.json();
      if (state === states[0]) drawn += 1;
      for (const scheme of SCHEMES) {
        const rows = tables.find((table) => table.scheme === scheme)?.rows ?? tables[0]?.rows ?? [];
        for (const touch of [true, false]) {
          const plan = drawsOf(state).filter((each) => each.scheme === scheme && (each.width < 1280) === touch);
          if (plan.length === 0) continue;
          const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 }, hasTouch: touch });
          await context.addInitScript((entries) => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, storage);
          for (const each of plan) {
            if (bailed) { await context.close(); return; }
            draws += 1;
            const themeChrome = entry.privatePages.chrome === "theme" && entry.privatePages.controls !== "none";
            const controls = [
              ...(themeChrome && entry.request?.headerSkin !== false && entry.request?.toggle ? ['[data-host="scheme"] button'] : []),
              ...(themeChrome && entry.request?.localization ? ['[data-host="localization"] select'] : []),
            ];
            const problems = await draw({ context, id, state, ...each, rows, chrome: entry.privatePages.chrome === "theme" && entry.request?.headerSkin !== false, search: entry.privatePages.chrome === "theme" && entry.privatePages.search, controls });
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
  console.error(`\n✗ ${failure.name}, ${failure.where}:\n  ${failure.problems.slice(0, 12).join("\n  ")}${failure.problems.length > 12 ? `\n  … and ${failure.problems.length - 12} more` : ""}\n  document: ${JSON.stringify({ request: failure.document.request, privatePages: failure.document.privatePages })}`);
}
if (args.includes("--profile")) console.log(`time (s): ${Object.entries(PROFILE).map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}`).join(", ")}`);
console.log(`private pages, rendered: ${drawn} documents drawn in ${draws} draws (${refused} refused at save: ${JSON.stringify(reasons)}) at ${WIDTHS.join(", ")} px, light and dark, in ${Math.round((Date.now() - started) / 1000)}s: ${failures.length} failures${MUTATE ? ` (under mutation ${MUTATE})` : ""}`);
if (process.exitCode !== 2) process.exitCode = failures.length > 0 ? 1 : 0;
