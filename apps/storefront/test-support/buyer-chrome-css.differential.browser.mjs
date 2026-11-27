// The buyer-page sheet check against Chromium's own CSS parser
// (packages/shared/src/plugins/buyer-chrome-css.ts). Seeded adversarial sheets
// (url tokens holding comment openers, strings, escapes, comments, bad urls,
// unbalanced blocks, `:host` forms, nested at-rules) are each checked by the
// store, and every sheet it accepts is written as the store writes it
// (`@layer theme{...}` in a shadow root's style element) into headless Chromium.
// Then, from the CSSOM:
// - the style element holds one top-level rule, the `theme` layer block: no
//   text left it;
// - no rule is an at-rule off the store's list (no import, font face,
//   property, counter style, namespace, page, ...);
// - every pseudo-class Chromium parsed is a name in the store's token stream,
//   none is `:host-context`, and `:host` holds only attribute selectors and is
//   chained with no pseudo-class.
// So a sheet the store passes is read by the browser as the store read it.
//
//   node apps/storefront/test-support/buyer-chrome-css.differential.browser.mjs [--sheets 3000] [--seed 1]
// Exit 0: the parsers agree on every sheet; 1: a disagreement (printed); 2: the test could not run.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buyerChromeCssProblem, cssTokens, BUYER_CHROME_CSS_AT_RULES } from "../../../packages/shared/src/plugins/buyer-chrome-css.ts";

const require = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)));
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const SHEETS = option("sheets", 3000);
const SEED = option("seed", 1);

const FRAGMENTS = [
  "url(/*)", "url( /* )", 'url("/*")', "url('/*')", "url(a b)", 'url(a"b)', "url(\\)/*)", "url(", "/* c */", "/*", "*/", "\\/*", "'/*'", '"\\"/*"',
  "\\68 ost", ":host", ":host(", ":host-context(", ":h\\ost-context(", ":\\68 ost(", ":host:", "::before", ":is(", ":has(", ":where(", ":not(",
  "[data-color-scheme=\"dark\"]", "[data-x]", "body", "*", "~", ">", "+", ".a", "#b", "main input",
  "@import url(x.css);", "@\\69mport url(x.css);", "@media (min-width:1px){", "@supports (display:grid){", "@layer x{", "@layer scalius-guard{", "@container (min-width:1px){",
  "@font-face{font-family:x}", "@property --x{syntax:'*';inherits:false}", "@counter-style x{system:cyclic}", "@namespace x url(y);", "@page{}", "@keyframes k{to{color:red}}", "@scope (.a){",
  "{", "}", "(", ")", "[", "]", "{color:red}", "{contain:none!important}", ",", ";", ":", "\n", "\t", " ", "\\\n", "\\", '"unterminated', "'u\nv'", "<!--", "-->", "\\0", "\u0000", "\u00e9", "\u{1f600}",
  "--x:1", "color:red", "!important", "a{b:url(/*)}", "x url(/*){}", "/**/",
];

function prng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

const random = prng(SEED);
const sheets = [];
for (let n = 0; n < SHEETS; n += 1) {
  const length = 2 + Math.floor(random() * 12);
  let text = "";
  for (let m = 0; m < length; m += 1) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
  sheets.push(text);
}
// The review's own cases, and the reference shapes a theme writes.
sheets.push(
  "a{background:url(/*)}:host-context(body) .gc-logo{background-image:url(/apps/x/leak)}/**/",
  "x url(/*){} @import url(/evil.css); /**/",
  "@layer a{b{c:url(/*)}} @import url(/evil.css);/**/",
  ":host(:is(body *)) .x{color:red}",
  ':root,:host{--a:1}:host([data-color-scheme="dark"]) .logo{display:none}.h:has(.m :focus-visible){top:0}',
  "} @layer scalius-guard{:host(:not(#a#b)){contain:none!important}} .x{",
);

const accepted = sheets.filter((text) => buyerChromeCssProblem(text) === null);
let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error("the test could not run: Chromium did not start:", error);
  process.exit(2);
}
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
const facts = await page.evaluate((texts) => texts.map((text) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `@layer theme{${text}}`;
  root.append(style);
  const sheet = style.sheet;
  const out = { top: [], kinds: [], pseudo: [], hosts: [] };
  const walk = (rules) => {
    for (const rule of rules) {
      out.kinds.push(rule.constructor.name);
      if ("selectorText" in rule && typeof rule.selectorText === "string") {
        for (const match of rule.selectorText.matchAll(/(?<!:):([a-zA-Z-]+)/g)) out.pseudo.push(match[1].toLowerCase());
        for (const match of rule.selectorText.matchAll(/:host(?![-\w])(\((?:[^()]|\([^()]*\))*\))?(:?)(:?)/g)) out.hosts.push({ argument: match[1] ?? null, chained: match[2] === ":" && match[3] !== ":" });
      }
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const rule of sheet.cssRules) out.top.push(`${rule.constructor.name}:${rule.name ?? ""}`);
  walk(sheet.cssRules);
  host.remove();
  return out;
}), accepted);

const ALLOWED_KINDS = new Set(["CSSLayerBlockRule", "CSSLayerStatementRule", "CSSStyleRule", "CSSMediaRule", "CSSSupportsRule", "CSSContainerRule", "CSSKeyframesRule", "CSSKeyframeRule", "CSSScopeRule", "CSSStartingStyleRule", "CSSNestedDeclarations"]);
const disagreements = [];
accepted.forEach((text, index) => {
  const fact = facts[index];
  const names = new Set(cssTokens(text).flatMap((token) => (token.type === "ident" || token.type === "function" || token.type === "at-keyword" ? [token.value.toLowerCase()] : [])));
  const problems = [];
  if (fact.top.length !== 1 || fact.top[0] !== "CSSLayerBlockRule:theme") problems.push(`text left the theme layer: top-level rules ${JSON.stringify(fact.top)}`);
  for (const kind of fact.kinds) if (!ALLOWED_KINDS.has(kind)) problems.push(`Chromium made a ${kind}`);
  for (const pseudo of fact.pseudo) {
    if (pseudo === "host-context") problems.push("Chromium parsed :host-context");
    if (!names.has(pseudo)) problems.push(`Chromium parsed :${pseudo}, which the store's tokens do not name`);
  }
  for (const host of fact.hosts) {
    if (host.chained) problems.push("Chromium parsed :host chained with a pseudo-class");
    if (host.argument !== null && !/^\(\s*(?:\[[^\]]*\]\s*)+\)$/.test(host.argument)) problems.push(`Chromium parsed :host${host.argument}`);
  }
  if (problems.length > 0) disagreements.push({ text, problems: [...new Set(problems)] });
});
await browser.close();
console.log(`${sheets.length} sheets (seed ${SEED}), ${accepted.length} accepted by the store and read by Chromium, ${disagreements.length} disagreements; at-rules allowed: ${BUYER_CHROME_CSS_AT_RULES.join(", ")}`);
for (const { text, problems } of disagreements.slice(0, 20)) console.log(`✗ ${JSON.stringify(text)}\n  ${problems.join("\n  ")}`);
process.exit(disagreements.length === 0 ? 0 : 1);
