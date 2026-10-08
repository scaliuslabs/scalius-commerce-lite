#!/usr/bin/env node
/**
 * pnpm quality:storefront: the storefront quality audit (docs/STOREFRONT-QUALITY.md).
 *
 * For every gallery entry at 390, 768, 1280 and 1440 px, in headless
 * Chromium (Playwright): axe-core WCAG 2.2 AA, keyboard reachability and
 * visible focus, horizontal overflow, layout shift, images without
 * dimensions, contrast under a dark colour-scheme preference, and the page's
 * lang and dir. It saves a screenshot per entry and width, compares it with
 * a baseline when one exists, and writes results.json plus an HTML report.
 *
 * Modes:
 *   (default)         starts the fixture gallery itself: no API, no secrets.
 *   --base-url <url>  audits a gallery that already runs there
 *                     (`pnpm gallery:storefront`); with --paths, audits those
 *                     real storefront pages instead (a running `pnpm dev`).
 *
 *   pnpm quality:storefront [--only <id-part>[,...]] [--family <prefix>[,...]]
 *     [--widths 390,768,1280,1440] [--out .quality/storefront] [--concurrency 4]
 *     [--baseline <dir>] [--update-baseline] [--base-url <url>] [--paths /,/cart]
 *
 * Exit code 1 on any axe "serious" or "critical" violation, horizontal
 * overflow, or a page that does not render, unless the entry and rule are in
 * scripts/storefront-quality/allowlist.json (each with a reason).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeQualityReport } from "./storefront-quality/report.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const DEFAULT_WIDTHS = [390, 768, 1280, 1440];
const VIEWPORT_HEIGHT = 900;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const GATING_IMPACTS = new Set(["serious", "critical"]);
const IMPACT_WEIGHT = { critical: 10, serious: 5, moderate: 2, minor: 1 };
const DIFF_THRESHOLD = 0.005;

function parseArgs(argv) {
  const args = { widths: DEFAULT_WIDTHS, out: join(ROOT, ".quality/storefront"), concurrency: 4, only: [], family: [], paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--base-url") args.baseUrl = value().replace(/\/$/, "");
    else if (flag === "--only") args.only = value().split(",").filter(Boolean);
    else if (flag === "--family") args.family = value().split(",").filter(Boolean);
    else if (flag === "--widths") args.widths = value().split(",").map(Number).filter((width) => width > 0);
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number(value()) || 1);
    else if (flag === "--baseline") args.baseline = resolve(value());
    else if (flag === "--update-baseline") args.updateBaseline = true;
    else if (flag === "--paths") args.paths = value().split(",").filter(Boolean);
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  args.baseline ??= join(ROOT, ".quality/storefront-baseline");
  return args;
}

function loadAllowlist() {
  const file = join(ROOT, "scripts/storefront-quality/allowlist.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  for (const item of list) {
    if (!item.entry || !item.rule || !item.reason?.trim()) throw new Error(`Allowlist items need entry, rule and a reason: ${JSON.stringify(item)}`);
  }
  return list;
}

const globMatch = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);

function allowed(allowlist, entryId, rule, width) {
  return allowlist.find((item) => globMatch(item.entry, entryId) && globMatch(item.rule, rule) && (!item.widths || item.widths.includes(width))) ?? null;
}

// ─── In-page checks (run in the browser) ──────────────────────────────────

/**
 * Collects layout shifts from navigation start (CLS without the session
 * window: the total, which is the stricter number for a short page load).
 */
const CLS_INIT = () => {
  window.__galleryCls = 0;
  window.__galleryShifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__galleryCls += entry.value;
        const source = entry.sources?.[0]?.node;
        if (source && window.__galleryShifts.length < 5) {
          window.__galleryShifts.push(source.nodeType === 1 ? source.tagName.toLowerCase() + (source.id ? `#${source.id}` : "") + (source.className && typeof source.className === "string" ? `.${source.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "") : "text");
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // No layout-shift support: CLS reads as 0.
  }
};

/** The harness's own checks in the focus region; returns findings without width/gating. */
function pageChecks({ focus, locale, dir }) {
  const findings = [];
  const describe = (element) => {
    if (!element || element.nodeType !== 1) return String(element);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${part}#${current.id}`);
        break;
      }
      const classes = typeof current.className === "string" ? current.className.trim().split(/\s+/).filter((name) => name && !name.includes(":")).slice(0, 2) : [];
      if (classes.length) part += `.${classes.join(".")}`;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const roots = focus.include.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const excluded = (focus.exclude ?? []).flatMap((selector) => [...document.querySelectorAll(selector)]);
  const inFocus = (element) => roots.some((root) => root.contains(element)) && !excluded.some((root) => root.contains(element));
  const visible = (element) => {
    if (!element.isConnected) return false;
    if (element.closest("[inert],[aria-hidden='true'],[hidden]")) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const push = (rule, impact, message, nodes) => {
    if (nodes.length) findings.push({ rule, source: "harness", impact, message, count: nodes.length, nodes: nodes.slice(0, 10).map(describe) });
  };

  if (roots.length === 0) {
    findings.push({ rule: "focus-missing", source: "harness", impact: "serious", message: `Nothing on the page matches the entry's region (${focus.include.join(", ")}): the variant rendered nothing.`, count: 1, nodes: focus.include });
    return { findings, metrics: {} };
  }

  // Horizontal overflow: the page scrolls sideways; name the elements past the edge.
  const width = document.documentElement.clientWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  // Horizontal overflow. The storefront clips the root (`html, body {
  // overflow-x: clip }`), so content past the edge is cut off rather than
  // scrolled: look for it directly, not only at the scroll width.
  const clipped = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.position === "fixed") return true;
      if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
        const rect = parent.getBoundingClientRect();
        if (rect.right <= width + 1 && rect.left >= -1) return true;
      }
    }
    return false;
  };
  const offenders = [...document.body.querySelectorAll("*")].filter((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1 || (rect.right <= width + 1 && rect.left >= -1)) return false;
    return getComputedStyle(element).position !== "fixed" && visible(element) && !clipped(element);
  });
  if (scrollWidth > width + 1 || offenders.length) {
    // The outermost offenders only.
    const outer = offenders.filter((element) => !offenders.includes(element.parentElement));
    const focused = outer.filter(inFocus);
    const widest = Math.max(scrollWidth, ...outer.map((element) => Math.ceil(element.getBoundingClientRect().right)));
    findings.push({
      rule: focused.length || outer.length === 0 ? "overflow" : "overflow-outside-focus",
      source: "harness",
      impact: "serious",
      message: scrollWidth > width + 1
        ? `The page scrolls sideways: ${scrollWidth}px of content in a ${width}px viewport.`
        : `Content reaches ${widest}px in a ${width}px viewport and is cut off at the edge (the root clips it).`,
      count: Math.max(1, (focused.length ? focused : outer).length),
      nodes: (focused.length ? focused : outer).slice(0, 10).map(describe),
    });
  }

  const interactiveSelector = "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=slider],[contenteditable=true]";
  const interactive = [...document.querySelectorAll(interactiveSelector)].filter((element) => inFocus(element) && visible(element));

  // Keyboard: every visible control can take focus (roving tab stops count once per group).
  const unreachable = interactive.filter((element) => {
    // A focus target (a skip link's <main tabindex="-1">) is not a control.
    if (!element.matches("a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=slider]")) return false;
    if (element.matches(":disabled,[aria-disabled='true']")) return false;
    // A roving tab stop: one sibling takes Tab, arrows move between them.
    const roving = element.parentElement?.querySelector(":scope > [tabindex='0']");
    if (roving) return false;
    return element.tabIndex < 0;
  });
  // Elements that look clickable (pointer cursor) but are not controls and hold none.
  const pointerOnly = [...document.querySelectorAll("div,span,li,img,svg,label,p")].filter((element) => {
    if (!inFocus(element) || !visible(element)) return false;
    if (element.closest(interactiveSelector) || element.querySelector(interactiveSelector)) return false;
    if (element.tagName === "LABEL" && element.control) return false;
    return getComputedStyle(element).cursor === "pointer" && getComputedStyle(element.parentElement ?? element).cursor !== "pointer";
  });
  push("keyboard-unreachable", "serious", "A visible control cannot take keyboard focus (tabindex -1 or not a control).", [...unreachable, ...pointerOnly]);

  // Images without intrinsic dimensions reserve no space while they load.
  const images = [...document.querySelectorAll("img")].filter((image) => inFocus(image) && visible(image) && !(image.getAttribute("width") && image.getAttribute("height")) && getComputedStyle(image).aspectRatio === "auto");
  push("img-dimensions", "moderate", "An image has no width and height attributes or CSS aspect-ratio, so it can shift the layout as it loads.", images);

  // Language of the page and of its parts.
  const html = document.documentElement;
  const pageLang = (html.getAttribute("lang") ?? "").toLowerCase();
  if (!pageLang.startsWith(locale)) push("lang", "serious", `The page language is "${pageLang || "(none)"}"; this entry renders "${locale}".`, [html]);
  const pageDir = (html.getAttribute("dir") ?? "ltr").toLowerCase();
  if (pageDir !== dir) push("dir", "serious", `The page direction is "${pageDir}"; "${locale}" reads ${dir}.`, [html]);
  // Letters and digits only: the taka sign (U+09F2, U+09F3) is a currency
  // symbol, not a passage in Bangla, so a price needs no lang (WCAG 3.1.2).
  const scripts = [["bn", /[\u0980-\u09F1\u09F4-\u09FF]/], ["ar", /[؀-ۿ]/]];
  const mislabelled = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !inFocus(parent) || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
    const text = node.textContent ?? "";
    for (const [language, pattern] of scripts) {
      if (!pattern.test(text)) continue;
      const declared = (parent.closest("[lang]")?.getAttribute("lang") ?? "").toLowerCase();
      if (!declared.startsWith(language)) mislabelled.add(parent);
    }
  }
  push("lang-of-parts", "minor", "Bangla or Arabic text sits in an element whose language says otherwise (WCAG 3.1.2: add lang to the part).", [...mislabelled]);

  // Up to 40 focusable controls for the visible-focus check that follows.
  for (const element of interactive.filter((each) => each.tabIndex >= 0 && !each.matches(":disabled")).slice(0, 40)) {
    element.setAttribute("data-quality-focus", "");
  }
  return { findings, metrics: { scrollWidth, clientWidth: width, interactive: interactive.length } };
}

/** Focus each marked control by script after a Tab press and compare its look with and without focus. */
function focusVisibleCheck() {
  const keys = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderTopColor", "borderBottomColor", "borderTopWidth", "backgroundColor", "color", "textDecorationLine"];
  const ringKeys = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow"];
  // The control and its pseudo-elements, its two nearest ancestors fully, and
  // rings up to six levels up (a card draws a stretched link's ring).
  const snapshot = (element) => {
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const style = getComputedStyle(node);
      parts.push((depth < 3 ? keys : ringKeys).map((key) => style[key]).join("|"));
      if (depth === 0) {
        for (const pseudo of ["::before", "::after"]) {
          const decoration = getComputedStyle(node, pseudo);
          parts.push(`${decoration.outlineStyle}|${decoration.boxShadow}|${decoration.borderTopColor}|${decoration.backgroundColor}|${decoration.opacity}`);
        }
      }
    }
    return parts.join("||");
  };
  const missing = [];
  let judged = 0;
  for (const element of document.querySelectorAll("[data-quality-focus]")) {
    element.blur();
    const before = snapshot(element);
    element.focus({ preventScroll: true });
    if (document.activeElement !== element) continue;
    if (!element.matches(":focus-visible")) continue;
    judged += 1;
    const after = snapshot(element);
    if (before === after) missing.push(element);
    element.blur();
  }
  const describe = (element) => element.tagName.toLowerCase() + (element.id ? `#${element.id}` : "") + (element.getAttribute("aria-label") ? `[aria-label="${element.getAttribute("aria-label")}"]` : element.textContent?.trim() ? ` "${element.textContent.trim().slice(0, 40)}"` : "");
  return { judged, missing: missing.slice(0, 10).map(describe), count: missing.length };
}

// ─── Screenshots and diffs ────────────────────────────────────────────────

/**
 * The entry's region (a section, the footer), the top of the page for the
 * header region, or the whole page; clipped from a full-page capture, so a
 * running carousel never blocks it.
 */
async function screenshot(page, entry, file) {
  const width = page.viewportSize().width;
  const options = { path: file, type: "jpeg", quality: 72, animations: "disabled", caret: "hide", timeout: 30_000 };
  const focus = entry.focus;
  const selector = focus.include.length === 1 && !focus.exclude && !["body", "#main-content"].includes(focus.include[0]) ? focus.include[0] : null;
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (selector) {
    const box = await page.evaluate((query) => {
      const element = document.querySelector(query);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { y: rect.top + window.scrollY, height: rect.height };
    }, selector);
    if (box && box.height > 0) {
      const y = Math.max(0, Math.floor(box.y) - 16);
      const height = Math.min(Math.ceil(box.height) + 32, pageHeight - y, 6_000);
      await page.screenshot({ ...options, fullPage: true, clip: { x: 0, y, width, height } });
      return;
    }
  }
  if (focus.exclude) {
    await page.screenshot({ ...options, clip: { x: 0, y: 0, width, height: VIEWPORT_HEIGHT } });
    return;
  }
  await page.screenshot({ ...options, fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(pageHeight, 12_000) } });
}

/** Pixel difference of two images, computed in the browser (no image library). */
async function diffImages(browser, baselineFile, currentFile, diffFile) {
  const page = await browser.newPage();
  try {
    const toData = (file) => `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`;
    const result = await page.evaluate(async ({ a, b }) => {
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
      const [left, right] = await Promise.all([load(a), load(b)]);
      const width = Math.max(left.width, right.width);
      const height = Math.max(left.height, right.height);
      const draw = (image) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height);
      };
      const one = draw(left);
      const two = draw(right);
      const out = new ImageData(width, height);
      let changed = 0;
      for (let index = 0; index < one.data.length; index += 4) {
        const delta = Math.abs(one.data[index] - two.data[index]) + Math.abs(one.data[index + 1] - two.data[index + 1]) + Math.abs(one.data[index + 2] - two.data[index + 2]);
        const differs = delta > 96;
        if (differs) changed += 1;
        out.data[index] = differs ? 255 : two.data[index] * 0.3 + 178;
        out.data[index + 1] = differs ? 0 : two.data[index + 1] * 0.3 + 178;
        out.data[index + 2] = differs ? 60 : two.data[index + 2] * 0.3 + 178;
        out.data[index + 3] = 255;
      }
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(out, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { ratio: changed / (width * height), png: btoa(binary), sizeChanged: left.width !== right.width || left.height !== right.height };
    }, { a: toData(baselineFile), b: toData(currentFile) });
    mkdirSync(dirname(diffFile), { recursive: true });
    writeFileSync(diffFile, Buffer.from(result.png, "base64"));
    return { ratio: result.ratio, sizeChanged: result.sizeChanged };
  } finally {
    await page.close();
  }
}

// ─── One entry ────────────────────────────────────────────────────────────

/**
 * One browser context per worker: entries share its HTTP cache (the dev
 * server's modules), and every navigation starts with empty storage, so a
 * page never shows what an earlier entry stored (recently viewed, the cart).
 */
async function workerContext(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: DEFAULT_WIDTHS[0], height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Storage is off: nothing to clear.
    }
  });
  await context.addInitScript(CLS_INIT);
  // The audit stays on the audited origin: nothing leaves the machine.
  await context.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  return context;
}

async function auditEntry({ browser, context, axeSource, baseUrl, entry, widths, out, baseline, allowlist }) {
  const result = {
    id: entry.id, family: entry.family, title: entry.title, page: entry.page, locale: entry.locale, dir: entry.dir,
    url: `${baseUrl}${entry.path}`, failing: false, allowlisted: false, allowReason: null, error: null, widths: {},
    fallbacks: entry.fallbacks ?? [], unanswered: [],
  };
  await context.clearCookies();
  const consoleErrors = [];
  let page = null;
  try {
    for (const width of widths) {
      consoleErrors.length = 0;
      // A fresh page per width: a click on the previous width (an open
      // drawer) can leave a navigation running.
      await page?.close().catch(() => {});
      page = await context.newPage();
      // The cart lives in the browser: a seeded cart is written after the context cleared storage, before the page's scripts read it.
      if (entry.cartSeed) await page.addInitScript((cart) => { try { localStorage.setItem("cart:v3", cart); } catch { /* storage is off */ } }, JSON.stringify(entry.cartSeed));
      page.on("console", (message) => {
        if (message.type() === "error" && !/WebSocket|\[vite\]/.test(message.text())) consoleErrors.push(message.text().slice(0, 200));
      });
      page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error.message ?? error).slice(0, 200)}`));
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      const response = await page.goto(result.url, { waitUntil: "load", timeout: 60_000 });
      if (!response || response.status() >= 400) {
        const status = response?.status() ?? 0;
        result.widths[width] = { screenshot: null, diff: null, metrics: {}, findings: [{ rule: "render", source: "harness", impact: "critical", gating: true, message: `The page answered ${status}.`, help: null, count: 1, nodes: [] }] };
        continue;
      }
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      for (const action of entry.interact ?? []) {
        if (action.maxWidth && width >= action.maxWidth) continue;
        const target = page.locator(action.click).first();
        if ((await target.count()) && (await target.isVisible())) await target.click({ timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(400);
      const cls = await page.evaluate(() => ({ value: window.__galleryCls ?? 0, sources: window.__galleryShifts ?? [] }));

      const findings = [];
      const checks = await page.evaluate(pageChecks, { focus: entry.focus, locale: entry.locale, dir: entry.dir });
      findings.push(...checks.findings);
      if (cls.value > 0.1) {
        findings.push({ rule: "layout-shift", source: "harness", impact: cls.value > 0.25 ? "serious" : "moderate", message: `Layout shift while loading: CLS ${cls.value.toFixed(3)} (good is 0.1 or less).`, count: 1, nodes: cls.sources });
      }

      if (!findings.some((finding) => finding.rule === "focus-missing")) {
        // axe-core, scoped to the entry's region.
        if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ content: axeSource });
        const axe = await page.evaluate(async ({ focus, tags }) => {
          const results = await window.axe.run({ include: focus.include.map((selector) => [selector]), exclude: (focus.exclude ?? []).map((selector) => [selector]) }, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations", "incomplete"] });
          const violations = results.violations.map((violation) => ({
            rule: violation.id, source: "axe", impact: violation.impact ?? "minor", message: violation.help, help: violation.helpUrl,
            count: violation.nodes.length, nodes: violation.nodes.slice(0, 10).map((node) => node.target.join(" ")),
          }));
          // Text axe cannot judge (over a photo or a gradient) is listed for a person to check.
          const review = results.incomplete.filter((item) => item.id === "color-contrast").map((item) => ({
            rule: "color-contrast-review", source: "harness", impact: "minor", message: "Text over an image, gradient or overlap: axe cannot measure its contrast; check it by eye.", help: item.helpUrl,
            count: item.nodes.length, nodes: item.nodes.slice(0, 10).map((node) => node.target.join(" ")),
          }));
          return [...violations, ...review];
        }, { focus: entry.focus, tags: AXE_TAGS });
        findings.push(...axe);

        // Visible focus: a Tab press sets keyboard modality, then each marked control is focused.
        await page.keyboard.press("Tab");
        const focusResult = await page.evaluate(focusVisibleCheck);
        if (focusResult.count) {
          findings.push({ rule: "focus-visible", source: "harness", impact: "serious", message: `${focusResult.count} of ${focusResult.judged} controls look the same focused and unfocused (WCAG 2.4.7).`, count: focusResult.count, nodes: focusResult.missing });
        }

        // The same page under a dark colour-scheme preference must stay readable.
        if (width === 1280 || (widths.length === 1 && width === widths[0])) {
          await page.emulateMedia({ colorScheme: "dark" });
          const dark = await page.evaluate(async ({ focus }) => {
            const results = await window.axe.run({ include: focus.include.map((selector) => [selector]), exclude: (focus.exclude ?? []).map((selector) => [selector]) }, { runOnly: { type: "rule", values: ["color-contrast"] }, resultTypes: ["violations"] });
            return results.violations.flatMap((violation) => violation.nodes.map((node) => node.target.join(" ")));
          }, { focus: entry.focus });
          await page.emulateMedia({ colorScheme: "light" });
          const light = new Set(findings.filter((finding) => finding.rule === "color-contrast").flatMap((finding) => finding.nodes));
          const extra = dark.filter((node) => !light.has(node));
          if (extra.length) findings.push({ rule: "contrast-dark-preference", source: "harness", impact: "serious", message: "Text fails contrast only when the browser prefers a dark colour scheme.", count: extra.length, nodes: extra.slice(0, 10) });
        }
      }
      if (consoleErrors.length) findings.push({ rule: "console-error", source: "harness", impact: "minor", message: "The page logged errors.", count: consoleErrors.length, nodes: consoleErrors.slice(0, 10) });

      // Screenshot, and the diff against the baseline.
      const shot = `shots/${entry.id}/${width}.jpg`;
      mkdirSync(join(out, "shots", entry.id), { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      // A full-page capture does not paint `content-visibility: auto` regions
      // below the fold (the deferred footer); paint them for the picture only,
      // after every check has run.
      await page.addStyleTag({ content: "*{content-visibility:visible!important}" }).catch(() => {});
      let screenshotPath = shot;
      await screenshot(page, entry, join(out, shot)).catch((error) => {
        screenshotPath = null;
        findings.push({ rule: "screenshot", source: "harness", impact: "minor", message: `No screenshot: ${String(error.message).slice(0, 160)}`, count: 1, nodes: [] });
      });
      let diff = null;
      const baselineFile = join(baseline, shot);
      if (screenshotPath && existsSync(baselineFile)) {
        const diffPath = `diffs/${entry.id}/${width}.png`;
        const compared = await diffImages(browser, baselineFile, join(out, shot), join(out, diffPath));
        diff = { ratio: compared.ratio, image: diffPath, baseline: pathToFileURL(baselineFile).href };
        if (compared.ratio > DIFF_THRESHOLD || compared.sizeChanged) {
          findings.push({ rule: "visual-diff", source: "harness", impact: "moderate", message: `${(compared.ratio * 100).toFixed(2)}% of pixels differ from the baseline${compared.sizeChanged ? " (size changed)" : ""}.`, count: 1, nodes: [] });
        }
      }

      for (const finding of findings) {
        finding.help ??= null;
        const gating = finding.rule === "render" || finding.rule === "overflow" || (finding.source === "axe" && GATING_IMPACTS.has(finding.impact));
        const allow = gating ? allowed(allowlist, entry.id, finding.rule, width) : null;
        finding.gating = gating && !allow;
        if (allow) {
          finding.allowlisted = allow.reason;
          result.allowlisted = true;
          result.allowReason = allow.reason;
        }
      }
      result.widths[width] = { screenshot: screenshotPath, diff, metrics: { ...checks.metrics, cls: Number(cls.value.toFixed(4)) }, findings };
    }
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 2000);
  } finally {
    await page?.close().catch(() => {});
  }
  result.failing = Boolean(result.error) || Object.values(result.widths).some((width) => width.findings.some((finding) => finding.gating));
  return result;
}

// ─── Summary ──────────────────────────────────────────────────────────────

function summarize(results) {
  const byRule = {};
  const byFamily = {};
  let gatingFindings = 0;
  for (const entry of results) {
    const family = (byFamily[entry.family] ??= { entries: 0, failingEntries: 0, findings: 0 });
    family.entries += 1;
    if (entry.failing) family.failingEntries += 1;
    const rulesSeen = new Set();
    for (const width of Object.values(entry.widths)) {
      for (const finding of width.findings) {
        const rule = (byRule[finding.rule] ??= { findings: 0, entries: 0, impact: finding.impact, gating: false, source: finding.source });
        rule.findings += finding.count;
        if (IMPACT_WEIGHT[finding.impact] > IMPACT_WEIGHT[rule.impact]) rule.impact = finding.impact;
        if (finding.gating) {
          rule.gating = true;
          gatingFindings += 1;
        }
        if (!rulesSeen.has(finding.rule)) {
          rulesSeen.add(finding.rule);
          rule.entries += 1;
        }
        family.findings += finding.count;
      }
    }
  }
  const score = (entry) => Object.values(entry.widths).reduce((total, width) => total + width.findings
    .filter((finding) => !["visual-diff", "screenshot"].includes(finding.rule))
    .reduce((sum, finding) => sum + (IMPACT_WEIGHT[finding.impact] ?? 1) * Math.min(finding.count, 10), 0), 0) + (entry.error ? 50 : 0);
  const worst = results
    .map((entry) => ({ id: entry.id, family: entry.family, score: score(entry), findings: Object.values(entry.widths).reduce((total, width) => total + width.findings.length, 0) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 15);
  return {
    entries: results.length,
    failingEntries: results.filter((entry) => entry.failing).length,
    gatingFindings,
    byRule: Object.fromEntries(Object.entries(byRule).sort((left, right) => right[1].findings - left[1].findings)),
    byFamily: Object.fromEntries(Object.entries(byFamily).sort((left, right) => right[1].findings - left[1].findings)),
    worst,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function loadEntries(args, baseUrl) {
  if (args.paths.length) {
    return args.paths.map((path) => ({
      id: path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home",
      family: "page:live", title: `Live page ${path}`, page: "live", locale: "", dir: "ltr",
      path, focus: { include: ["body"] }, interact: [], fallbacks: [], live: true,
    }));
  }
  const response = await fetch(`${baseUrl}/__gallery/index.json`);
  if (!response.ok) throw new Error(`No gallery at ${baseUrl}/__gallery/index.json (${response.status})`);
  const { entries } = await response.json();
  return entries.filter((entry) =>
    (args.only.length === 0 || args.only.some((part) => entry.id.includes(part)))
    && (args.family.length === 0 || args.family.some((prefix) => entry.family.startsWith(prefix))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 25).join("\n"));
    return 0;
  }
  const allowlist = loadAllowlist();
  const { chromium } = await import("playwright");
  const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

  let gallery = null;
  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    const { startStorefrontGallery } = await import(pathToFileURL(join(ROOT, "apps/storefront/scripts/gallery-server.mjs")).href);
    gallery = await startStorefrontGallery({ port: 0, quiet: true });
    baseUrl = gallery.url;
    console.log(`Fixture gallery at ${baseUrl}/__gallery/`);
  }
  const browser = await chromium.launch();
  const stop = async () => {
    await browser.close().catch(() => {});
    await gallery?.close().catch(() => {});
  };
  process.once("SIGINT", () => stop().then(() => process.exit(130)));
  try {
    const entries = await loadEntries(args, baseUrl);
    if (args.paths.length) {
      // Real pages: the locale is whatever the page declares.
      for (const entry of entries) entry.locale = "";
    }
    console.log(`Auditing ${entries.length} entries at ${args.widths.join(", ")} px (${args.concurrency} at a time)`);
    rmSync(join(args.out, "shots"), { recursive: true, force: true });
    rmSync(join(args.out, "diffs"), { recursive: true, force: true });
    mkdirSync(args.out, { recursive: true });
    const results = new Array(entries.length);
    let next = 0;
    let done = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: Math.min(args.concurrency, entries.length) }, async () => {
      const context = await workerContext(browser, baseUrl);
      while (next < entries.length) {
        const index = next++;
        results[index] = await auditEntry({ browser, context, axeSource, baseUrl, entry: entries[index], widths: args.widths, out: args.out, baseline: args.baseline, allowlist });
        done += 1;
        const entry = results[index];
        if (entry.failing || done % 25 === 0) {
          console.log(`[${done}/${entries.length}] ${entry.failing ? "FAIL" : "ok  "} ${entry.id}${entry.error ? ` (error: ${entry.error.split("\n")[0]})` : ""}`);
        }
      }
    }));
    if (!args.paths.length) {
      // What each page asked the fixture API for and did not get.
      const index = await (await fetch(`${baseUrl}/__gallery/index.json`)).json().catch(() => ({ entries: [] }));
      const unanswered = new Map(index.entries.map((entry) => [entry.id, entry.unanswered]));
      for (const result of results) result.unanswered = unanswered.get(result.id) ?? [];
    }
    const summary = summarize(results);
    const report = { generatedAt: new Date().toISOString(), baseUrl, mode: gallery ? "fixture" : "base-url", widths: args.widths, durationSeconds: Math.round((Date.now() - started) / 1000), summary, entries: results };
    writeFileSync(join(args.out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    const reportFile = writeQualityReport(args.out, report);
    if (args.updateBaseline) {
      rmSync(args.baseline, { recursive: true, force: true });
      cpSync(join(args.out, "shots"), join(args.baseline, "shots"), { recursive: true });
      console.log(`Baseline updated: ${args.baseline}`);
    }
    console.log(`\n${summary.entries} entries, ${summary.failingEntries} failing, ${summary.gatingFindings} gating findings (${report.durationSeconds}s)`);
    for (const [rule, value] of Object.entries(summary.byRule).slice(0, 12)) {
      console.log(`  ${rule.padEnd(28)} ${String(value.findings).padStart(6)} findings in ${String(value.entries).padStart(4)} entries${value.gating ? "  (gating)" : ""}`);
    }
    console.log(`Report: ${reportFile}`);
    return summary.failingEntries > 0 ? 1 : 0;
  } finally {
    await stop();
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(error);
  process.exit(2);
});
