// Rendered property tests for the buyer's private pages: the safety net under
// the private-page model (packages/plugin-sdk/docs/private-pages.md). Run from
// the repo root: `pnpm test:private-pages` (fast seed set, the gate), or
// `pnpm test:private-pages --seeds 200 --from 1000` for a longer run, or
// `--seed <n>` to replay one. Headless Chromium, no network: the fixture
// gallery (apps/storefront/scripts/gallery-server.mjs) draws the real cart
// page (two lines, apps' blocks at their targets) through Vite with the
// store's real CSS, and compiles each document with the store's compiler.
//
// Each seed generates a LEGAL theme document (an arrangement with layouts,
// content blocks before, between and after the parts; tokens at their bounds
// and at random; free-region CSS from the properties the compiler accepts,
// hostile ones from every security review included). A document the save
// refuses is not drawn. Each accepted one is drawn at 320, 390 and 1280 px,
// light and dark, and must hold, for every mandatory part and every text the
// host draws there:
// - inside the viewport horizontally, the page with no horizontal overflow;
// - reachable by scrolling, within a bounded distance from the top;
// - of a non-trivial size;
// - not covered by anything from a free region (sampled with elementFromPoint);
// - its text at the contrast floor against the pixels actually behind it.
// A failing seed prints its document. The reviews' concrete breaks are named
// cases, run first.
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const ONLY = flag("seed", null);
const SEEDS = flag("seeds", 6);
const FROM = flag("from", 1);
const WIDTHS = [320, 390, 1280];
const SCHEMES = ["light", "dark"];
/** How far below the top a mandatory part may sit (24rem header, 3 blocks of 30rem, the host's own page). */
const MAX_DEPTH_PX = 9000;

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

function generate(seed) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const colour = () => next() < 0.6 ? pick(ROLES) : `#${Math.floor(next() * 0xffffff).toString(16).padStart(6, "0")}`;
  const hooks = [];
  const block = () => {
    const hook = `block-${hooks.length}`;
    hooks.push(hook);
    const words = next() < 0.4 ? LONG : "Free delivery on every order this week";
    const kind = pick(["text", "heading", "banner"]);
    const content = kind === "banner" ? { kind, tone: pick(["neutral", "warning", "critical"]), title: { en: words } } : { kind, text: { en: words } };
    return { type: "content", hook, content };
  };
  const layoutHooks = [];
  const wrap = (children) => {
    const hook = `wrap-${layoutHooks.length}`;
    layoutHooks.push(hook);
    return { type: "layout", layout: pick(["stack", "columns", "grid", "group"]), hook, children };
  };
  // The cart's parts in a legal arrangement: the fold holds the cart, the details form stays outside it.
  const cart = [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, ...(next() < 0.5 ? [{ type: "part", part: "discount" }] : []), { type: "target", target: "cart.page.summary" }];
  const side = [{ type: "layout", layout: "fold", children: cart }, { type: "target", target: "cart.page.below" }];
  const before = Array.from({ length: int(0, 3) }, block);
  const between = Array.from({ length: int(0, 2) }, block);
  const after = Array.from({ length: int(0, 3) }, block);
  const main = next() < 0.5 ? [wrap([wrap(side), ...between, { type: "part", part: "details" }])] : [...side, ...between, { type: "part", part: "details" }];
  const layout = [{ type: "part", part: "notices" }, ...before, ...main, ...after];
  const line = next() < 0.5 ? undefined : [
    wrap([{ type: "part", part: "image" }, wrap([{ type: "part", part: "title" }, { type: "part", part: "details" }, { type: "part", part: "inputs" }, { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" }]), wrap([{ type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove" }])]),
    { type: "target", target: "cart.line.after" },
  ];
  const lineHooks = line ? layoutHooks.slice(-3) : [];
  const tokens = {};
  const set = (target, values) => { tokens[target] = { ...tokens[target], ...values }; };
  const tracks = () => Array.from({ length: int(1, 4) }, () => pick([int(24, 480), 480, "1fr", "2fr", "auto", "min-content"]));
  for (const hook of [...layoutHooks]) if (next() < 0.5) set(`@${hook}`, { columns: tracks(), gap: pick([0, 48, int(0, 48)]), ...(next() < 0.3 ? { "columns-wide": tracks() } : {}) });
  // Text and its surface chosen together (the save refuses an unreadable pair; most still pass).
  const pairs = [["card", "card-foreground"], ["background", "foreground"], ["#1e1831", "#f4f1ff"], ["#ffffff", "#111111"], ["#111111", "#ffffff"]];
  for (const target of ["lines", "summary", "details-form", "line", "page"]) {
    if (next() < 0.4) {
      const [background, text] = pick(pairs);
      // The page and a line keep the host's own text: their paint stays light (a dark page needs a dark palette).
      set(target, target === "line" || target === "page" ? { background: pick(["background", "card", "#ffffff", "#f8f5ff"]) } : { background, text, muted: text, link: text, error: text, radius: pick([0, 32, int(0, 32)]), padding: pick([0, 48]), shadow: pick(["none", "lg"]) });
      // Fields beside a dark box keep a ring and an error border that read on light and dark.
      if (background.startsWith("#1") || background === "#111111") set("input", { ring: "#8b5cf6", invalid: "#e11d48" });
    }
  }
  if (next() < 0.5) set("line-image", { width: pick([40, 240]), height: pick([40, 320]), "width-wide": pick([40, 240]) });
  if (next() < 0.5) set("summary-total", { size: pick([12, 40]), weight: "800" });
  if (next() < 0.5) set("submit", { background: "#7c3aed", text: "#ffffff", radius: pick([0, 32]), case: "uppercase", size: pick([12, 40]) });
  if (next() < 0.3) set("frame", { "max-width": pick([480, 1600]) });
  if (next() < 0.3) set("ui.banner", { background: "#fffbeb", text: "#111111", border: colour() });
  if (next() < 0.3) set("ui.button", { background: "#10b981", text: "#04130d", radius: 0 });
  const css = [...hooks, "header"].flatMap((anchor) => next() < 0.8
    ? [`${anchor === "header" ? '[data-free="header"]' : `[data-hook="${anchor}"]`} ${pick(["*", "p", "h2", "div", "*::before"])} { ${Array.from({ length: int(1, 3), }, () => pick(HOSTILE_CSS)).join(";")}${next() < 0.3 ? ';content:"Delivery phone number (required)"' : ""} }`]
    : []).join("\n");
  return { chrome: next() < 0.5 ? "theme" : "core", pages: { cart: { layout, ...(line ? { items: { line } } : {}) } }, tokens: { cart: tokens }, css, labels: {} };
}

/** The reviews' concrete breaks, as legal documents (each must now hold when drawn, or be refused). */
const REGRESSIONS = {
  "review 3: a block widens the page": { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "intro", content: { kind: "text", text: { en: LONG } } }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }] }, { type: "part", part: "details" }] }] } }, css: '[data-hook="intro"] p { min-inline-size: 5000px; white-space: nowrap }' },
  "review 3: a dark form's text reaches its fields": { tokens: { cart: { "details-form": { background: "#111111", text: "#ffffff", muted: "#cccccc", link: "#a78bfa", error: "#f87171" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } },
  "review 3: two 480px columns on a phone": { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "layout", layout: "grid", hook: "two", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }, { type: "part", part: "details" }] }] } }, tokens: { cart: { "@two": { columns: [480, 480], gap: 48 } } } },
  "review 2: shadows, outlines and covers from a block": { pages: { cart: { layout: [{ type: "part", part: "notices" }, { type: "content", hook: "promo", content: { kind: "text", text: { en: "Free delivery" } } }, { type: "layout", layout: "columns", children: [{ type: "layout", layout: "stack", children: [{ type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] }, { type: "target", target: "cart.page.below" }] }, { type: "part", part: "details" }] }] } }, css: '[data-hook="promo"] p { outline: 100vmax solid #fff; box-shadow: 0 0 0 100vmax #fff; text-shadow: 0 900px 0 #fff } [data-hook="promo"] p::after { content: "990"; position: absolute; inset: -100vmax; z-index: 2147483647; background: #fff }' },
  "review 3: the header's search disguised as a checkout field": { chrome: "theme", css: '[data-free="header"] form::before { content: "Delivery phone number (required)" } [data-free="header"] button::after { content: "Confirm order" } [data-free="header"] * { white-space: nowrap; min-inline-size: 3000px }' },
  // Review 4: what the contrast check modelled and the CSS did not draw.
  "review 4, B1: tokens only, a dark lines panel over the default arrangement's summary": { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" }, input: { ring: "#8b5cf6", invalid: "#e11d48" } } } },
  "review 4, B2: an app's warning and success badges under a dark line": { tokens: { cart: { lines: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } },
  "review 4, B3: the sign-in dialog under dark dialog tokens": { tokens: { cart: { dialog: { background: "#111111", text: "#ffffff", muted: "#d4d4d4", link: "#ffffff", error: "#ffffff" } } } },
  "review 4, S3: the theme's header styling the store's search from its region": { chrome: "theme", search: "after", css: '[data-free="header"] div { visibility: hidden; pointer-events: none; font-size: 60px; direction: rtl }' },
};

// ─── PNG pixels (Chromium's 8-bit RGB or RGBA screenshots) ────────────────

function pixels(png) {
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
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      out[y * stride + x] = (value + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
    }
  }
  const list = [];
  for (let index = 0; index < out.length; index += channels) list.push([out[index], out[index + 1], out[index + 2]]);
  return list;
}

const luminance = ([r, g, b]) => [r, g, b].map((channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

// ─── The checks, in the page ───────────────────────────────────────────────

const MANDATORY = ['[data-part="lines"]', '[data-part="line-title"]', '[data-part="line-price"]', '[data-part="line-quantity"]', '[data-part="line-remove"]', '[data-part="summary"]', "#subtotal", "#total", '[data-part="details-form"]', '[data-part="contact"]', '[data-part="details-submit"]'];

async function inspect(page) {
  return page.evaluate(({ MANDATORY, MAX_DEPTH_PX }) => {
    const problems = [];
    const width = innerWidth;
    if (document.documentElement.scrollWidth > width + 1) problems.push(`the page scrolls sideways: ${document.documentElement.scrollWidth}px at ${width}px`);
    const texts = [];
    for (const selector of MANDATORY) {
      const element = document.querySelector(`[data-private="cart"] ${selector}`);
      if (!element) { problems.push(`${selector}: missing`); continue; }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const box = element.getBoundingClientRect();
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || box.width < 8 || box.height < 8) { problems.push(`${selector}: not visible (${Math.round(box.width)}×${Math.round(box.height)})`); continue; }
      if (box.left < -1 || box.right > width + 1) problems.push(`${selector}: outside the viewport (${Math.round(box.left)}..${Math.round(box.right)} of ${width})`);
      if (box.top + scrollY > MAX_DEPTH_PX) problems.push(`${selector}: ${Math.round(box.top + scrollY)}px down`);
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]]) {
        const x = Math.min(width - 1, Math.max(0, box.left + box.width * fx));
        const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height * fy));
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest("[data-free]") && !element.contains(hit)) { problems.push(`${selector}: covered by a free region at ${Math.round(x)},${Math.round(y)}`); break; }
      }
      // Leaf texts the host draws in the part.
      for (const node of [element, ...element.querySelectorAll("*")]) {
        if (texts.length >= 30 || node.closest("[data-free]")) continue;
        const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim());
        if (!own || [...node.children].some((child) => child.textContent.trim())) continue;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4 || !node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || node.closest(":disabled,[aria-disabled=true],[aria-hidden=true]")) continue;
        if (Number(style.opacity) < 1 || /rgba\([^)]*,\s*0?\.\d+\)/.test(style.color)) continue;
        node.dataset.ptCheck = String(texts.length);
        const size = Number.parseFloat(style.fontSize);
        texts.push({ index: texts.length, selector, text: node.textContent.trim().slice(0, 30), color: style.color, large: size >= 24 || (size >= 18.6 && Number(style.fontWeight) >= 700) });
      }
    }
    return { problems, texts };
  }, { MANDATORY, MAX_DEPTH_PX });
}

/** Each text's contrast against the pixels behind it: the text hidden, its box photographed. */
async function textContrast(page, texts) {
  const problems = [];
  for (const text of texts) {
    const node = page.locator(`[data-pt-check="${text.index}"]`);
    if ((await node.count()) !== 1) continue;
    await node.evaluate((element) => { element.scrollIntoView({ block: "center" }); element.style.setProperty("color", "transparent", "important"); element.style.setProperty("text-shadow", "none", "important"); });
    const box = await node.boundingBox();
    if (box && box.width > 6 && box.height > 6) {
      const clip = { x: Math.max(0, box.x + 2), y: Math.max(0, box.y + 2), width: Math.max(2, box.width - 4), height: Math.max(2, box.height - 4) };
      const shot = await page.screenshot({ clip, animations: "disabled" });
      const ink = text.color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const ratios = pixels(shot).map((pixel) => contrast(ink, pixel)).sort((a, b) => a - b);
      const worst = ratios[Math.floor(ratios.length * 0.05)] ?? 21;
      const floor = text.large ? 3 : 4.5;
      if (worst < floor - 0.05) problems.push(`${text.selector} "${text.text}": ${text.color} reads ${worst.toFixed(2)}:1 on what is behind it`);
    }
    await node.evaluate((element) => { element.style.removeProperty("color"); element.style.removeProperty("text-shadow"); }).catch(() => {});
  }
  return problems;
}

// ─── The run ───────────────────────────────────────────────────────────────

const { startStorefrontGallery } = await import(pathToFileURL(resolve("apps/storefront/scripts/gallery-server.mjs")).href);
const gallery = await startStorefrontGallery({ port: 0, quiet: true });
const browser = await chromium.launch();
const failures = [];
let drawn = 0;
let refused = 0;
const reasons = {};
try {
  const cases = [
    ...Object.entries(REGRESSIONS).map(([name, document]) => ({ name, document })),
    ...(ONLY !== null ? [ONLY] : Array.from({ length: SEEDS }, (_, index) => FROM + index)).map((seed) => ({ name: `seed ${seed}`, document: generate(seed) })),
  ];
  for (const [index, { name, document }] of cases.entries()) {
    const id = `pp-${index}`;
    const answer = await fetch(`${gallery.url}/__gallery/private-theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, privatePages: document }) });
    if (answer.status === 422) {
      refused += 1;
      const issue = (await answer.json()).issues[0];
      reasons[issue?.reason ?? "?"] = (reasons[issue?.reason ?? "?"] ?? 0) + 1;
      if (name.startsWith("review") || ONLY !== null) console.log(`${name}: refused at save (${issue?.reason}: ${issue?.message})`);
      continue;
    }
    assert.equal(answer.status, 200, `${name}: the gallery did not take the document`);
    const { storage } = await answer.json();
    drawn += 1;
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
      await context.addInitScript((entries) => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, storage);
      const page = await context.newPage();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
        await page.waitForSelector('[data-private="cart"][data-cart-state="items"]', { timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        // On a phone the cart folds behind its bar: open it, as a buyer does.
        const toggle = page.locator('[data-part="fold-toggle"]');
        if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
        await page.waitForTimeout(150);
        const { problems, texts } = await inspect(page);
        problems.push(...await textContrast(page, texts));
        if (problems.length > 0) failures.push({ name, scheme, width, problems: problems.slice(0, 8), document });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await gallery.close();
}
for (const failure of failures) {
  console.error(`\n✗ ${failure.name} at ${failure.width}px, ${failure.scheme}:\n  ${failure.problems.join("\n  ")}\n  document: ${JSON.stringify(failure.document)}`);
}
console.log(`private pages, rendered: ${drawn} documents drawn (${refused} refused at save: ${JSON.stringify(reasons)}) at ${WIDTHS.join(", ")} px, light and dark: ${failures.length} failures`);
process.exitCode = failures.length > 0 ? 1 : 0;
