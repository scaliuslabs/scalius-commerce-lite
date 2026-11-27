// The store's reading of a buyer-page sheet against Chromium's own CSS parser
// (packages/shared/src/plugins/buyer-chrome-css.ts). Seeded adversarial sheets
// (url tokens holding comment openers, strings, escapes, comments, unclosed
// ends, unbalanced blocks, nesting, `:host` forms, URLs of every kind, nested
// at-rules, non-ASCII) are each parsed and checked by the store; for every one
// it accepts, the file it writes (`checkedBuyerChromeSheet(...).text`, what
// `/_buyer-chrome/...` serves) is loaded into headless Chromium as a sheet of
// its own, and from the CSSOM:
// - the file is ASCII and Chromium reads exactly the store's rules: the
//   sheet's rules, by their `cssText`, are the store's rules each read alone,
//   in order, none merged, split or added (a rule Chromium rejects on its own,
//   an unknown selector, is left out of both);
// - no rule is an at-rule off the store's list;
// - every `url()` Chromium kept is the app's own public file (`./public/...`)
//   or a fragment;
// - `:host` stands only at a selector's start, alone or with attribute
//   selectors, and no selector holds `:host-context`.
//
//   node apps/storefront/test-support/buyer-chrome-css.differential.browser.mjs [--sheets 3000] [--seed 1]
// Exit 0: the parsers agree on every sheet; 1: a disagreement (printed); 2: the test could not run.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkedBuyerChromeSheet, writtenCss, BUYER_CHROME_CSS_AT_RULES } from "../../../packages/shared/src/plugins/buyer-chrome-css.ts";

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
  "url(/*)", "url( /* )", 'url("/*")', "url(public/a.png)", "url('./public/b.svg')", "url(#f)", "url(../public/c.png)", "url(/apps/x)", "url(data:x)", "url(a b)", 'url(a"b)', "url(\\)/*)", "url(",
  "image-set('public/a.png' 1x)", "image-set(var(--x) 1x)", "src('public/a.png')",
  "/* c */", "/*", "*/", "\\/*", "'/*'", '"\\"/*"', "\\68 ost", ":host", ":host(", ":host-context(", ":h\\ost-context(", ":\\68 ost(", ":host:", "::before", ":is(", ":has(", ":where(", ":not(",
  "[data-color-scheme=\"dark\"]", "[data-x]", "body", "*", "~", ">", "+", ".a", "#b", "main input", "&", ":scope", ".\\9ae", ".মূল", "'৳'",
  "@import url(x.css);", "@\\69mport url(x.css);", "@media (min-width:1px){", "@supports (display:grid){", "@layer x{", "@layer a, b;", "@layer scalius-guard{", "@container (min-width:1px){",
  "@font-face{font-family:x}", "@property --x{syntax:'*';inherits:false}", "@keyframes k{to{color:red}}", "@scope (.a){", "@starting-style{",
  "{", "}", "(", ")", "[", "]", "{color:red}", "{contain:none!important}", "{margin:0 -1px .5em}", "{--x:1e3px}", "{content:'a  b'}", ",", ";", ":", "\n", "\t", " ", "\\\n", "\\", '"unterminated', "'u\nv'", "<!--", "-->", "\u0000", "\u00e9", "\u{1f600}",
  "--x:1", "color:red", "!important", "a{b:url(/*)}", "x url(/*){}", "/**/", ".a{.b{c:d}}", ":host{&:has(~ *){c:d}}",
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
const pick = (list) => list[Math.floor(random() * list.length)];
// Shaped sheets, half the run: rules a theme could write, with adversarial pieces in every slot.
const SELECTORS = [".a", "#b", "nav > a", "li + li", "a ~ b", ":host", ":host([data-color-scheme=\"dark\"]) .logo", ":host::before", ":root", ":root, :host", ".x:has(.y :focus-visible)", ".x:not(.y)", ":is(.a, .b) c", ".\\31 0", ".মূল", ".a/**/.b", ".a\\:hover", "[data-x='a b']", "[data-x=\"\\\"\"]", ".a::after", "*", ":host(:is(body *))", ":is(:host) .a", ".x :host", ":host:hover", "& .a", ":scope .a", ":host-context(body)"];
const PROPERTIES = ["color", "margin", "background", "background-image", "content", "--x", "--y", "filter", "grid-template-areas", "font-family", "width", "cursor", "transition"];
const VALUES = ["red", "0 auto", "-1px .5em 1e3px", "url(public/a.png)", "url('public/b.svg')", "url(#f)", "url(../public/c.png)", "url(./public/d/../e.png?v=1)", "url(/apps/x)", "url(//evil.example)", "url(data:x)", "image-set('public/a.png' 1x, url(public/b.png) 2x)", "image-set(var(--x) 1x)", "'a  b'", "\"৳ দাম\"", "'\\'/*'", "calc(100% - 2px)", "var(--x, 1px)", "\"Inter\", sans-serif", "'a b' \"c d\"", "rgb(0 0 0 / .5)", "display 1s allow-discrete", "1px/**/2px", "\\9ae", "attr(data-x)"];
const shaped = (depth = 0) => {
  const count = 1 + Math.floor(random() * 4);
  let text = "";
  for (let n = 0; n < count; n += 1) {
    const roll = random();
    if (depth < 2 && roll < 0.12) text += `@media (min-width:${Math.floor(random() * 900)}px){${shaped(depth + 1)}}`;
    else if (depth < 2 && roll < 0.2) text += `@layer ${pick(["a", "b.c", "scalius-guard", "theme"])}{${shaped(depth + 1)}}`;
    else if (depth < 2 && roll < 0.25) text += `@supports (display:${pick(["grid", "flex"])}){${shaped(depth + 1)}}`;
    else if (roll < 0.3) text += `@keyframes k${n}{from{${pick(PROPERTIES)}:${pick(VALUES)}}to{opacity:1}}`;
    else {
      const declarations = Array.from({ length: 1 + Math.floor(random() * 3) }, () => `${pick(PROPERTIES)}:${pick(VALUES)}${random() < 0.15 ? "!important" : ""}`).join(";");
      text += `${pick(SELECTORS)}${random() < 0.3 ? `,${pick(SELECTORS)}` : ""}{${declarations}}`;
    }
    if (random() < 0.08) text += pick(FRAGMENTS);
  }
  return text;
};
const sheets = [];
for (let n = 0; n < SHEETS; n += 1) {
  if (n % 2 === 0) { sheets.push(shaped()); continue; }
  const length = 2 + Math.floor(random() * 12);
  let text = "";
  for (let m = 0; m < length; m += 1) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
  sheets.push(text);
}
// The reviews' own cases, and the shapes a theme writes.
sheets.push(
  "a{background:url(/*)}:host-context(body) .gc-logo{background-image:url(/apps/x/leak)}/**/",
  "x url(/*){} @import url(/evil.css); /**/",
  "a{color:red} /*", 'a{color:red} "x', "a{color:red}\\",
  ":host{&:has(~ script) .gc-logo{color:red}}",
  ':root,:host{--a:1}:host([data-color-scheme="dark"]) .logo{display:none}.h:has(.m :focus-visible){top:0}@media(min-width:64rem){.x{gap:1rem}}',
  ".a{background:url(public/a.svg)}.b{background-image:image-set('public/b.png' 1x,url(public/c.png) 2x)}.c{filter:url(#glow)}.মূল{content:'৳ দাম'}",
);

const accepted = [];
for (const text of sheets) {
  const checked = checkedBuyerChromeSheet(new TextEncoder().encode(text));
  if (checked.ok) accepted.push({ text, written: checked.text, alone: checked.rules.map((rule) => writtenCss([rule])) });
}
let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error("the test could not run: Chromium did not start:", error);
  process.exit(2);
}
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
const facts = await page.evaluate((cases) => {
  const read = (text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet;
  };
  return cases.map(({ written, alone }) => {
    const sheet = read(written);
    const kinds = [];
    const urls = [];
    const hosts = [];
    const walk = (rules) => {
      for (const rule of rules) {
        kinds.push(rule.constructor.name);
        for (const match of rule.cssText.matchAll(/url\("([^"]*)"\)/g)) urls.push(match[1]);
        if ("selectorText" in rule && typeof rule.selectorText === "string") hosts.push(rule.selectorText);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(sheet.cssRules);
    return {
      actual: Array.from(sheet.cssRules, (rule) => rule.cssText),
      expected: alone.flatMap((text) => Array.from(read(text).cssRules, (rule) => rule.cssText)),
      kinds, urls, selectors: hosts,
    };
  });
}, accepted.map(({ written, alone }) => ({ written, alone })));

const ALLOWED_KINDS = new Set(["CSSLayerBlockRule", "CSSLayerStatementRule", "CSSStyleRule", "CSSMediaRule", "CSSSupportsRule", "CSSContainerRule", "CSSKeyframesRule", "CSSKeyframeRule", "CSSStartingStyleRule"]);
const disagreements = [];
accepted.forEach(({ text, written }, index) => {
  const fact = facts[index];
  const problems = [];
  if (!/^[\x20-\x7e]*$/.test(written)) problems.push("the store's file is not ASCII");
  if (JSON.stringify(fact.actual) !== JSON.stringify(fact.expected)) problems.push(`Chromium reads other rules than the store's: ${JSON.stringify(fact.actual).slice(0, 300)} vs ${JSON.stringify(fact.expected).slice(0, 300)}`);
  for (const kind of fact.kinds) if (!ALLOWED_KINDS.has(kind)) problems.push(`Chromium made a ${kind}`);
  for (const url of fact.urls) if (!/^(?:\.\/public\/|#)/.test(url)) problems.push(`Chromium kept url(${url})`);
  for (const selector of fact.selectors) {
    if (/:host-context/i.test(selector)) problems.push(`Chromium parsed ${selector}`);
    // A pseudo-class's colon, never an escaped one (`\\:host` is a type selector).
    for (const match of selector.matchAll(/(?<![\\:]):host(?![-\w])/gi)) {
      const before = selector.slice(0, match.index).replace(/.*,\s*/s, "");
      const after = selector.slice(match.index + match[0].length);
      const argument = /^\(((?:[^()]|\([^()]*\))*)\)/.exec(after);
      const rest = argument ? after.slice(argument[0].length) : after;
      if (before.trim() !== "") problems.push(`Chromium parsed :host after something in ${selector}`);
      if (argument && !/^\s*(?:\[[^\]]*\]\s*)+$/.test(argument[1])) problems.push(`Chromium parsed :host(${argument[1]})`);
      if (/^:(?!:)/.test(rest)) problems.push(`Chromium parsed :host chained in ${selector}`);
    }
  }
  if (problems.length > 0) disagreements.push({ text, problems: [...new Set(problems)] });
});
await browser.close();
console.log(`${sheets.length} sheets (seed ${SEED}), ${accepted.length} accepted by the store and read by Chromium from the store's file, ${disagreements.length} disagreements; at-rules allowed: ${BUYER_CHROME_CSS_AT_RULES.join(", ")}`);
for (const { text, problems } of disagreements.slice(0, 20)) console.log(`✗ ${JSON.stringify(text)}\n  ${problems.join("\n  ")}`);
process.exit(disagreements.length === 0 ? 0 : 1);
