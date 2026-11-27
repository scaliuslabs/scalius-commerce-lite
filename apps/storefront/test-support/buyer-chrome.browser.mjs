// The rendered gate for a theme's chrome on the buyer's own pages
// (components/private/PrivateChrome.astro; packages/plugin-sdk/docs/private-pages.md).
// Headless Chromium, no network: the fixture gallery (apps/storefront/scripts/gallery-server.mjs)
// draws the real account page (signed out: its sign-in view) three ways: under
// the store's own chrome (the control), under the gallery's theme app for
// buyer pages with the stylesheet a theme writes, and with a hostile one
// (src/gallery/chrome-app-extension.ts). At 320, 390 and 1280 px, light and dark:
//
// - the hostile sheet (aimed at the page's fields and links, its body,
//   `:root:has()`, lifting its host over the page inside the guard's own layer
//   name, the host's own outline, shadow, drop-shadow chain, reflection,
//   border image and clip margin, a tall host, a fixed and an absolute layer)
//   leaves every host control's computed style as under the store's chrome,
//   the page's body unpainted, every host control's pixel the page's own (never
//   a forged colour) and taking a press at its centre, and the header's frame at
//   most half the screen with the account's first control on the first screen;
// - each of those effects alone (`drawn` probes, at 390 and 1280 px) holds the
//   same; with a theme's worst panel sheets (a covering, transitioned content)
//   every panel is the store's own top-layer element, leaves its margin and
//   close button the store's, closes on each, and leaves nothing over the page;
//   each sheet the store refuses (`refused` probes: a url token holding `/*`,
//   an unclosed end, nesting, a URL outside the app's files, a UTF-16 sheet, ...)
//   draws the store's own header and sends no request it names; the theme's
//   sheet is the store's derived file on the store's path, which refuses a
//   wrong hash;
// - each shadow root holds only what the inert rebuild writes: no form, field,
//   label, submit button, handler or tab stop;
// - under a theme's sheet the chrome follows the page's scheme on its host, its
//   light or dark switch flips the page (the store's own switch yields to it),
//   its signed-in and guest versions follow the sign-in hint, its cart count
//   shows the browser's cart, and on a phone its menu drawer opens over the page
//   on a press and closes with Escape;
// - the cart count reads the store's own cart (`cart:v3`) at load, after
//   another tab adds, after a sign-in on the drawn header, and after moving to
//   the next page and back, guest and signed in, at 390 and 1280 px;
// - with JavaScript off (a browser context without it): the theme's signed-in
//   and guest versions follow the server's hint on the host, and the store's
//   own "Menu" button opens the theme's drawer as the store's panel, which
//   Escape closes;
// - no request answers 5xx.
//
// From the repo root (under the lock: it starts a Vite server and a browser):
//   node apps/storefront/test-support/buyer-chrome.browser.mjs
//   node apps/storefront/test-support/buyer-chrome.browser.mjs --mutate "C1 no shadow root"
//   node apps/storefront/test-support/buyer-chrome.browser.mjs --mutations   every known-bad change fails its check
// Exit 0: every draw holds; 1: a draw fails; 2: the gate could not run.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const MUTATE = option("mutate");
const WIDTHS = [320, 390, 1280];
const SCHEMES = ["light", "dark"];

// ─── The gate tests itself ─────────────────────────────────────────────────

if (args.includes("--mutations")) {
  const { CHROME_MUTATIONS, chromeMutationsHold } = await import("./private-pages.mutations.mjs");
  const { readFile } = await import("node:fs/promises");
  const stale = await chromeMutationsHold((file) => readFile(resolve(file), "utf8"));
  if (stale.length > 0) { console.error(stale.join("\n")); process.exit(2); }
  const script = fileURLToPath(import.meta.url);
  const run = (extra) => spawnSync(process.execPath, [script, ...extra], { encoding: "utf8", env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 });
  const baseline = run([]);
  console.log(`${baseline.status === 0 ? "clean    " : "NOT CLEAN"} the unmutated baseline (exit ${baseline.status})`);
  if (baseline.status !== 0) { console.log(`${baseline.stdout}\n${baseline.stderr}`.split("\n").slice(-25).join("\n")); process.exit(1); }
  const survived = [];
  for (const [name, mutation] of Object.entries(CHROME_MUTATIONS)) {
    const result = run(["--mutate", name]);
    const problems = result.stdout.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim());
    const caught = result.status === 1 && problems.some((problem) => mutation.expect.test(problem));
    console.log(`${caught ? "caught   " : "SURVIVED "} ${name}: ${mutation.why}`);
    if (!caught) { survived.push(name); console.log(`${result.stdout}\n${result.stderr}`.split("\n").slice(-15).map((line) => `    ${line}`).join("\n")); }
  }
  process.exit(survived.length === 0 ? 0 : 1);
}

if (MUTATE) process.env.SCALIUS_GALLERY_MUTATION = MUTATE;

// ─── The run ───────────────────────────────────────────────────────────────

/** The gallery in a process of its own. */
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

const gallery = await startGallery().catch(() => startGallery()).catch((error) => {
  console.error("the gate could not run: the gallery did not start, twice:", error);
  process.exit(2);
});
const register = async (id, chrome) => {
  const answer = await fetch(`${gallery.url}/__gallery/buyer-chrome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, chrome }) });
  if (!answer.ok) throw new Error(`the gallery refused the ${chrome} entry (${answer.status})`);
  return (await answer.json()).id;
};
// The rebuild's own checker and what it may write, from the store's code as the gallery serves it.
const { problems: PROBLEMS_SOURCE, markup: INERT_MARKUP, refused: REFUSED, drawn: DRAWN, colours: COLOURS, utf16: UTF16 } = await fetch(`${gallery.url}/__gallery/buyer-chrome`).then((answer) => answer.json());
const registerSheet = async (id, sheet) => {
  const answer = await fetch(`${gallery.url}/__gallery/buyer-chrome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, chrome: "forged", ...sheet }) });
  if (!answer.ok) throw new Error(`the gallery refused the ${id} entry (${answer.status})`);
  return (await answer.json()).id;
};
const ids = { none: await register("buyer-chrome-none", "none"), theme: await register("buyer-chrome-theme", "theme"), forged: await register("buyer-chrome-forged", "forged") };
// A cart in the browser (the gallery's own seed, as the cart page's entries hold it).
const index = await fetch(`${gallery.url}/__gallery/index.json`).then((answer) => answer.json());
const CART = index.entries.find((entry) => entry.storage?.["cart:v3"])?.storage["cart:v3"] ?? null;

const browser = await chromium.launch();
const failures = [];
let draws = 0;
// A page of its own that turns a screenshot into its pixel (the page under test never runs this).
const decoder = await (await browser.newContext()).newPage();
const FORGED = COLOURS.map((colour) => colour.match(/\d+/g).map(Number));
/** Whether a pixel reads as one of the hostile sheet's colours. */
const forgedPixel = (rgb) => FORGED.some((colour) => colour.every((value, at) => Math.abs(value - rgb[at]) <= 40));
const pixelAt = async (page, x, y) => decoder.evaluate(async (b64) => {
  const image = new Image();
  image.src = `data:image/png;base64,${b64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
}, (await page.screenshot({ clip: { x: Math.max(0, Math.floor(x)), y: Math.max(0, Math.floor(y)), width: 1, height: 1 } })).toString("base64"));

/** The page's own controls: links, buttons and fields of its main part, the same under every chrome. */
const MAIN_CONTROLS = "main a[href], main button, main input, main select, main textarea";
/** Every host control a press must reach: the main part's, and the store's strip after a theme's chrome. */
const HOST_CONTROLS = `${MAIN_CONTROLS}, [data-private="core-footer"] button, [data-private="core-footer"] select`;
const STYLE_PROPERTIES = ["display", "visibility", "color", "background-color", "opacity", "pointer-events", "transform", "outline-style", "font-family"];

async function open(id, width, scheme, { signedIn = false, cart = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme });
  const errors = [];
  if (signedIn) await context.addCookies([{ name: "cs_auth", value: "1", url: gallery.url }]);
  const page = await context.newPage();
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  if (cart && CART) await page.addInitScript((value) => localStorage.setItem("cart:v3", value), CART);
  const answer = await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  await page.waitForTimeout(200);
  return { context, page, errors, status: answer?.status() ?? 0 };
}

/** Every main-part control's computed style, in document order. */
const hostStyles = (page) => page.evaluate(([selector, properties]) => Array.from(document.querySelectorAll(selector)).map((element) => {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
}), [MAIN_CONTROLS, STYLE_PROPERTIES]);

/**
 * Each host control a buyer can see that something drawn over it covers: it
 * does not take a press at its centre, or the pixel there reads as one of the
 * hostile sheet's colours (a layer that takes no press still paints over it).
 */
async function coveredControls(page) {
  const covered = [];
  const count = await page.evaluate((selector) => document.querySelectorAll(selector).length, HOST_CONTROLS);
  for (let at = 0; at < count; at += 1) {
    const point = await page.evaluate(async ([selector, index]) => {
      const element = document.querySelectorAll(selector)[index];
      const style = getComputedStyle(element);
      if (style.visibility !== "visible" || style.display === "none" || element.closest("[hidden]")) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return null;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
      const hit = document.elementFromPoint(x, y);
      return { x, y, takesPress: Boolean(hit && (element.contains(hit) || hit.contains(element))), name: `${element.localName}${element.className ? `.${String(element.className).split(" ")[0]}` : ""} "${(element.textContent ?? "").trim().slice(0, 30)}"`, hit: hit?.localName ?? "nothing" };
    }, [HOST_CONTROLS, at]);
    if (!point) continue;
    if (!point.takesPress) covered.push(`${point.name} under <${point.hit}>`);
    const rgb = await pixelAt(page, point.x, point.y);
    if (forgedPixel(rgb)) covered.push(`${point.name} painted over (rgb ${rgb.join(", ")})`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return covered;
}

/**
 * The store's panels for the theme's drawer and dropdown: each opens from the
 * theme's own button as the store's top-layer element (never a theme
 * element), leaves the page's margin unpainted and pressable (a press there
 * closes it), shows the store's close button, which closes it, and closes on
 * Escape; nothing of the theme's is in the top layer at any point.
 */
async function panelProblems(page, width) {
  const problems = [];
  const themeTopLayer = () => page.evaluate(() => Array.from(document.querySelectorAll("scalius-chrome")).some((host) => Array.from(host.shadowRoot?.querySelectorAll("*") ?? []).some((element) => element.matches(":popover-open, :modal"))));
  for (const [kind, opener] of [["drawer", ".gc-menu-button"], ["menu", ".gc-more"]]) {
    for (const close of ["margin", "button", "escape"]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const pressed = await page.locator(`scalius-chrome[data-chrome="header"] ${opener}`).click({ timeout: 3000 }).then(() => true, () => false);
      if (!pressed) { problems.push(`panel: the theme's button for the ${kind} cannot be pressed (something of the theme's covers it)`); break; }
      await page.waitForTimeout(100);
      const panel = await page.evaluate((kind) => {
        const element = document.querySelector(`[data-buyer-chrome-panel="${kind}"]`);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const button = element.querySelector(".buyer-chrome-panel-bar button").getBoundingClientRect();
        return { open: element.matches(":popover-open"), left: box.left, top: box.top, width: box.width, height: box.height, screen: [innerWidth, innerHeight], close: [button.left + button.width / 2, button.top + button.height / 2] };
      }, kind);
      if (!panel?.open) { problems.push(`panel: the store's ${kind} panel does not open from the theme's button`); continue; }
      if (await themeTopLayer()) problems.push(`panel: a theme element is in the top layer with the ${kind} open`);
      const margin = kind === "drawer" ? [panel.screen[0] - 16, panel.screen[1] / 2] : [panel.screen[0] / 2, panel.screen[1] - 8];
      if (kind === "drawer" && panel.width > panel.screen[0] - 64 + 1) problems.push(`panel: the drawer leaves no 4rem margin (${Math.round(panel.width)}px of ${panel.screen[0]})`);
      if (kind === "menu" && (panel.width > panel.screen[0] - 32 + 1 || panel.height > panel.screen[1] * 0.7 + 1 || panel.left < 15)) problems.push(`panel: the menu is not held inside the screen with a margin (${JSON.stringify(panel)})`);
      const marginPixel = await pixelAt(page, margin[0], margin[1]);
      if (forgedPixel(marginPixel)) problems.push(`panel: the page's margin beside the ${kind} is painted over (rgb ${marginPixel.join(", ")})`);
      const closePixel = await pixelAt(page, panel.close[0], panel.close[1]);
      if (forgedPixel(closePixel)) problems.push(`panel: the store's close button on the ${kind} is painted over`);
      const takes = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".buyer-chrome-panel-bar button") !== null, panel.close);
      if (!takes) problems.push(`panel: the store's close button on the ${kind} does not take a press`);
      if (close === "margin") await page.mouse.click(margin[0], margin[1]);
      else if (close === "button") await page.mouse.click(panel.close[0], panel.close[1]);
      else await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      const still = await page.evaluate((kind) => document.querySelector(`[data-buyer-chrome-panel="${kind}"]`).matches(":popover-open"), kind);
      if (still) problems.push(`panel: a press on the ${close === "margin" ? "page's margin" : close === "button" ? "store's close button" : "Escape key"} leaves the ${kind} open`);
    }
  }
  if (await themeTopLayer()) problems.push("panel: a theme element stays in the top layer after the panels closed");
  void width;
  return problems;
}

/** The header frame's height and where the account's first control starts, against the screen. */
const firstScreen = (page) => page.evaluate((selector) => {
  const frame = document.querySelector('[data-buyer-chrome-frame="header"]');
  const first = Array.from(document.querySelectorAll(selector)).find((element) => element.getBoundingClientRect().width > 0);
  return { frame: frame ? frame.getBoundingClientRect().height : 0, first: first ? first.getBoundingClientRect().top : 0, screen: innerHeight };
}, "main a[href], main button, main input");

/** What each chrome shadow root holds that the rebuild never writes (the shadow root's own style aside), and its host's box. */
const chromeShape = (page) => page.evaluate(([problemsSource, markup]) => {
  // The rebuild's own checker, run inside the page.
  const problems = new Function(`return (${problemsSource})`)();
  return Array.from(document.querySelectorAll("scalius-chrome")).map((host) => {
    const root = host.shadowRoot;
    const elements = root ? Array.from(root.querySelectorAll("*")).filter((element, at) => !(at === 0 && element.localName === "style")) : [];
    const box = host.getBoundingClientRect();
    return {
      target: host.getAttribute("data-chrome"),
      shadow: root !== null,
      light: host.children.length,
      problems: problems({ querySelectorAll: () => elements }, markup),
      fields: root ? root.querySelectorAll("form, input, select, textarea, label, button[type=submit], [onclick], [tabindex]").length : -1,
      position: getComputedStyle(host).position,
      contain: getComputedStyle(host).contain,
      top: box.top + scrollY,
      height: box.height,
      frame: host.parentElement?.hasAttribute("data-buyer-chrome-frame") ? getComputedStyle(host.parentElement).contain + " " + getComputedStyle(host.parentElement).overflow : null,
    };
  });
}, [PROBLEMS_SOURCE, INERT_MARKUP]);

const fail = (label, problems) => {
  if (problems.length === 0) return;
  failures.push(label);
  console.log(`✗ ${label}`);
  for (const problem of problems) console.log(`  ${problem}`);
};

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    const label = `${width}px ${scheme}`;
    // ── The control: the store's own chrome.
    const control = await open(ids.none, width, scheme);
    const expected = await hostStyles(control.page);
    const controlBody = await control.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const controlShape = await chromeShape(control.page);
    await control.context.close();
    draws += 1;
    const problems = [];
    if (controlShape.length !== 0) problems.push(`control: the store's own chrome draws a theme's chrome (${controlShape.length})`);
    if (expected.length === 0) problems.push("control: the account draws no host control to measure");

    // ── A hostile theme's sheet.
    const forged = await open(ids.forged, width, scheme);
    draws += 1;
    const shapes = await chromeShape(forged.page);
    if (shapes.filter((shape) => shape.target !== "panel").length !== 2) problems.push(`shadow: the forged theme draws ${shapes.length} chrome regions, not its header and footer`);
    for (const shape of shapes) {
      if (!shape.shadow) problems.push(`shadow: the ${shape.target} is drawn without a shadow root`);
      if (shape.light !== 0) problems.push(`shadow: the ${shape.target}'s host holds ${shape.light} children of its own`);
      if (shape.fields !== 0) problems.push(`markup: the ${shape.target} holds ${shape.fields} forms, fields, labels, submit buttons, handlers or tab stops`);
      for (const problem of shape.problems) problems.push(`markup: the ${shape.target}: ${problem}`);
      if (shape.position !== "static") problems.push(`containment: the ${shape.target}'s host is ${shape.position}, not in the page's flow`);
      if (!/paint/.test(shape.contain)) problems.push(`containment: the ${shape.target}'s host is not paint-contained (${shape.contain})`);
      if (!shape.frame || !/paint/.test(shape.frame) || (shape.target !== "panel" && !/clip/.test(shape.frame))) problems.push(`containment: the ${shape.target} has no store frame that clips it (${shape.frame})`);
    }
    const header = shapes.find((shape) => shape.target === "header");
    if (header && header.top > 4) problems.push(`containment: the header's host starts ${Math.round(header.top)}px down the page`);
    const screen = await firstScreen(forged.page);
    if (screen.frame > screen.screen / 2 + 1) problems.push(`containment: the header's frame is ${Math.round(screen.frame)}px tall on a ${screen.screen}px screen`);
    if (screen.first >= screen.screen) problems.push(`containment: the account's first control starts ${Math.round(screen.first)}px down, below the first screen`);
    const styles = await hostStyles(forged.page);
    if (styles.length !== expected.length) problems.push(`style: ${styles.length} main-part controls under the forged sheet, ${expected.length} under the store's chrome`);
    styles.forEach((style, at) => {
      for (const property of STYLE_PROPERTIES) {
        if (expected[at] && style[property] !== expected[at][property]) problems.push(`style: main-part control ${at}'s ${property} is ${style[property]}, ${expected[at][property]} under the store's chrome`);
      }
    });
    const body = await forged.page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, transform: getComputedStyle(document.body).transform }));
    if (body.background !== controlBody) problems.push(`style: the page's body is ${body.background}, ${controlBody} under the store's chrome`);
    if (body.transform !== "none") problems.push(`style: the page's body is moved (${body.transform})`);
    for (const covered of await coveredControls(forged.page)) problems.push(`covered: ${covered}`);
    problems.push(...forged.errors.map((error) => `request: ${error}`));
    await forged.context.close();
    // The isolation checks stand on their own: a theme stage that cannot run reports, never hides them.
    fail(`${label} (a hostile sheet)`, problems.splice(0));

    // ── A theme's own sheet: its behaviours inside the shadow root.
    const theme = await open(ids.theme, width, scheme, { cart: true });
    try {
      draws += 1;
      const page = theme.page;
        const inside = (selector, read) => page.evaluate(([css, how]) => {
        const host = document.querySelector('scalius-chrome[data-chrome="header"]');
        const element = host?.shadowRoot?.querySelector(css) ?? null;
        if (!element) return null;
        const style = getComputedStyle(element);
        return how === "visible" ? style.display !== "none" && style.visibility === "visible" && element.getBoundingClientRect().width > 0
          : how === "color" ? style.color : how === "text" ? (element.textContent ?? "").trim() : element.getAttribute(how);
      }, [selector, read]);
      const htmlScheme = () => page.evaluate(() => document.documentElement.getAttribute("data-color-scheme"));
      const hostScheme = () => page.evaluate(() => document.querySelector('scalius-chrome[data-chrome="header"]')?.getAttribute("data-color-scheme") ?? null);
      const logo = (value) => (value === "dark" ? "rgb(250, 250, 250)" : "rgb(17, 17, 17)");
      if (await htmlScheme() !== scheme) problems.push(`scheme: the page draws ${await htmlScheme()} on a ${scheme} device`);
      if (await hostScheme() !== await htmlScheme()) problems.push(`scheme: the chrome's host says ${await hostScheme()}, the page ${await htmlScheme()}`);
      if (await inside(".gc-logo", "color") !== logo(scheme)) problems.push(`scheme: the theme's ${scheme} colours do not reach its chrome (${await inside(".gc-logo", "color")})`);
      if (await inside(".gc-sign-in", "visible") !== true || await inside(".gc-account", "visible") !== false) problems.push("signed in: a guest does not see the guest version alone");
      if (CART && !/\d/.test(await inside(".gc-count", "text") ?? "")) problems.push(`cart count: the browser's cart shows no count (${JSON.stringify(await inside(".gc-count", "text"))})`);
      if (!CART) problems.push("cart count: the gallery holds no cart to seed");
      if (await inside(".gc-signout", "class") !== null || await inside(".gc-search", "class") !== null) problems.push("markup: the theme's fake sign-out or its search form is drawn");
      const storeSwitch = await page.evaluate(() => {
        const button = document.querySelector('[data-private="core-footer"] [data-sx-host-color-scheme-toggle]');
        return button ? getComputedStyle(button).display !== "none" && !button.hidden : false;
      });
      if (storeSwitch) problems.push("scheme: the store's switch still shows beside the theme's own");
      if (await page.locator(".buyer-chrome-noscript-bar").count() !== 0) problems.push("no script: the store's no-script menu button is drawn with scripts on");
      // Its own switch flips the page and the chrome.
      await page.evaluate(() => document.querySelector('scalius-chrome[data-chrome="header"]').shadowRoot.querySelector(".gc-scheme").scrollIntoView());
      await page.locator('scalius-chrome[data-chrome="header"] .gc-scheme').click();
      const flipped = scheme === "dark" ? "light" : "dark";
      if (await htmlScheme() !== flipped || await hostScheme() !== flipped) problems.push(`switch: the theme's switch leaves the page ${await htmlScheme()} and its host ${await hostScheme()}`);
      if (await inside(".gc-logo", "color") !== logo(flipped)) problems.push("switch: the chrome keeps its old colours after the switch");
      if (await inside(".gc-scheme", "aria-pressed") !== String(flipped === "dark")) problems.push(`switch: the theme's switch says aria-pressed=${await inside(".gc-scheme", "aria-pressed")}`);
      // Signed in: the hint swaps the versions before first paint (the account page reloads on a sign-in itself).
      await theme.context.addCookies([{ name: "cs_auth", value: "1", url: gallery.url }]);
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(200);
      if (await inside(".gc-sign-in", "visible") !== false || await inside(".gc-account", "visible") !== true) problems.push("signed in: a signed-in buyer does not see the signed-in version alone");
      // The theme's drawer and dropdown open as the store's own panels and close on the store's margin, its close
      // button and Escape (second review, rc.1).
      await page.evaluate(() => window.scrollTo(0, 0));
      problems.push(...await panelProblems(page, width));
    // The store's base under the theme's sheet loads (the shadow root's first import).
      const base = await page.evaluate(() => /@import url\("([^"]+)"\) layer\(scalius-base\)/.exec(document.querySelector("scalius-chrome").shadowRoot.querySelector("style")?.textContent ?? "")?.[1] ?? null);
      const baseText = base ? await page.evaluate(async (href) => (await fetch(href, { headers: { accept: "text/css" } })).text(), base) : "";
      if (!/box-sizing/.test(baseText) || /--theme\(/.test(baseText)) problems.push(`base: the store's base sheet does not load compiled (${base})`);
      // The theme's sheet: the store's reading of it, from the store's own path, as CSS in ASCII (second review, rc.1).
      const themed = await page.evaluate(async () => {
        const href = /@import url\("([^"]+)"\) layer\(theme\)/.exec(document.querySelector("scalius-chrome").shadowRoot.querySelector("style")?.textContent ?? "")?.[1] ?? null;
        if (!href) return { href };
        const answer = await fetch(href);
        const text = await answer.text();
        return {
          href, status: answer.status, type: answer.headers.get("content-type"), ascii: /^[\x20-\x7e]*$/.test(text),
          tampered: (await fetch(href.replace(/[0-9a-f]{64}\.css$/, `${"0".repeat(64)}.css`))).status,
          // Another checker version's path: never this storefront's reading (third review, rc.1).
          otherChecker: (await fetch(href.replace(/\/c[0-9]+\//, "/c0/"))).status,
        };
      });
      if (!/^\/_buyer-chrome\/[^/]+\/[0-9a-f]{64}\/c[0-9]+\/[0-9a-f]{64}\.css$/.test(themed.href ?? "") || themed.status !== 200 || themed.type !== "text/css; charset=utf-8" || !themed.ascii || themed.tampered !== 404 || themed.otherChecker !== 404) problems.push(`sheet: the theme's sheet is not the store's derived file (${JSON.stringify(themed)})`);
    if (width === WIDTHS[0] && scheme === SCHEMES[0]) console.log(`  base sheet: ${baseText.length} characters (dev, unminified)`);
      problems.push(...theme.errors.map((error) => `request: ${error}`));
    } catch (error) {
      problems.push(`theme: the behaviours could not be checked (${String(error?.message ?? error).split("\n")[0]})`);
    }
    await theme.context.close();
    fail(`${label} (a theme's sheet)`, problems);
    if (!failures.some((failure) => failure.startsWith(`${label} `))) console.log(`✓ ${label}`);
  }
}

// ── The cart count against the store's own cart, as the cart changes under a drawn header.
/** The header's count and the store's own (the cart the store keeps in the browser), as the header words it. */
const counts = (page) => page.evaluate(() => {
  const own = JSON.parse(localStorage.getItem("cart:v3") ?? "null")?.totalItems ?? 0;
  const header = document.querySelector('scalius-chrome[data-chrome="header"]')?.shadowRoot?.querySelector(".gc-count")?.textContent?.trim() ?? null;
  return { header, store: own > 0 ? String(own) : "" };
});
/** The seeded cart with one more of each line: a different total, as a sign-in's merge or another tab's add leaves it. */
const MORE = CART ? (() => {
  const cart = JSON.parse(CART);
  for (const item of Object.values(cart.items)) item.quantity += 1;
  cart.totalItems = Object.values(cart.items).reduce((sum, item) => sum + item.quantity, 0);
  return JSON.stringify(cart);
})() : null;
for (const width of [390, 1280]) {
  for (const signedIn of [false, true]) {
    const label = `${width}px ${signedIn ? "signed in" : "guest"} (cart count)`;
    const { context, page, errors } = await open(ids.theme, width, "light", { signedIn });
    draws += 1;
    const problems = [];
    const same = async (when) => {
      await page.waitForTimeout(300);
      const { header, store } = await counts(page);
      if (header !== store) problems.push(`cart count: ${when}, the header reads ${JSON.stringify(header)}, the store's cart ${JSON.stringify(store)}`);
    };
    try {
      if (!CART) throw new Error("the gallery holds no cart to seed");
      await same("an empty cart at load");
      // Another tab adds to the cart.
      const other = await context.newPage();
      await other.goto(`${gallery.url}/__gallery/e/${ids.none}`, { waitUntil: "load" });
      await other.evaluate((value) => localStorage.setItem("cart:v3", value), CART);
      await same("after another tab's add");
      // A sign-in on the drawn header: the hint and the merged cart arrive together.
      if (!signedIn) {
        await context.addCookies([{ name: "cs_auth", value: "1", url: gallery.url }]);
        await other.evaluate((value) => localStorage.setItem("cart:v3", value), MORE);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("customer-login")));
        await same("after a sign-in on the drawn header");
        const versions = await page.evaluate(() => {
          const root = document.querySelector('scalius-chrome[data-chrome="header"]')?.shadowRoot;
          const shown = (css) => { const element = root?.querySelector(css); return Boolean(element) && getComputedStyle(element).display !== "none"; };
          return { account: shown(".gc-account"), signIn: shown(".gc-sign-in") };
        });
        if (!versions.account || versions.signIn) problems.push(`signed in: after a sign-in on the drawn header the theme shows ${JSON.stringify(versions)}`);
      }
      await other.close();
      // Account page to account page, and back to one the cart changed under.
      await page.goto(`${gallery.url}/__gallery/e/${ids.theme}`, { waitUntil: "load" });
      await same("on the next account page");
      await page.goto(`${gallery.url}/__gallery/e/${ids.none}`, { waitUntil: "load" });
      await page.evaluate((value) => localStorage.setItem("cart:v3", value), signedIn ? MORE : CART);
      await page.goBack({ waitUntil: "load" });
      await same("back on an account page after the cart changed");
    } catch (error) {
      problems.push(`cart count: could not be checked (${String(error?.message ?? error).split("\n")[0]})`);
    }
    problems.push(...errors.map((error) => `request: ${error}`));
    await context.close();
    fail(label, problems);
    if (problems.length === 0) console.log(`✓ ${label}`);
  }
}

// ── With JavaScript off: the server's sign-in hint, and the store's own button for the theme's drawer.
for (const signedIn of [false, true]) {
  const label = `390px ${signedIn ? "signed in" : "guest"} (no script)`;
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, javaScriptEnabled: false });
  if (signedIn) await context.addCookies([{ name: "cs_tok", value: "gallery-session", url: gallery.url }, { name: "cs_auth", value: "1", url: gallery.url }]);
  const page = await context.newPage();
  const errors = [];
  const entry = `${gallery.url}/__gallery/e/${ids.theme}`;
  // The signed-in account itself answers 503 here (the entry's fixture holds no account for the session): its
  // chrome is what is checked, so only the page's other requests count.
  page.on("response", (response) => { if (response.status() >= 500 && response.url() !== entry) errors.push(`${response.status()} ${response.url()}`); });
  draws += 1;
  const problems = [];
  try {
    await page.goto(entry, { waitUntil: "load" });
    const seen = await page.evaluate(() => {
      const host = document.querySelector('scalius-chrome[data-chrome="header"]');
      const shown = (css) => { const element = host?.shadowRoot?.querySelector(css); return Boolean(element) && getComputedStyle(element).display !== "none"; };
      return { hint: host?.hasAttribute("data-scalius-signed-in") ?? null, account: shown(".gc-account"), signIn: shown(".gc-sign-in") };
    });
    if (seen.hint !== signedIn || seen.account !== signedIn || seen.signIn === signedIn) problems.push(`no script: signed-in versions follow no server hint (${JSON.stringify(seen)})`);
    const button = page.locator(".buyer-chrome-noscript-bar button");
    if (await button.count() !== 1 || !(await button.isVisible())) problems.push("no script: the store draws no button of its own for the theme's drawer");
    else {
      await button.click();
      await page.waitForTimeout(100);
      if (!await page.evaluate(() => document.querySelector('[data-buyer-chrome-panel="drawer"]')?.matches(":popover-open") === true)) problems.push("no script: the store's button does not open the theme's drawer");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      if (await page.evaluate(() => document.querySelector('[data-buyer-chrome-panel="drawer"]')?.matches(":popover-open") === true)) problems.push("no script: Escape leaves the drawer open");
    }
  } catch (error) {
    problems.push(`no script: could not be checked (${String(error?.message ?? error).split("\n")[0]})`);
  }
  problems.push(...errors.map((error) => `request: ${error}`));
  await context.close();
  fail(label, problems);
  if (problems.length === 0) console.log(`✓ ${label}`);
}

// ── Each effect alone, and the popover that tries to cover the screen.
for (const [name, sheet] of Object.entries(DRAWN)) {
  const id = await registerSheet(`buyer-chrome-drawn-${name}`, { sheet });
  for (const [width, scheme] of [[390, "light"], [1280, "dark"]]) {
    const label = `${width}px ${scheme} (drawn probe ${name})`;
    const probe = await open(id, width, scheme);
    draws += 1;
    const problems = [];
    try {
      const shapes = await chromeShape(probe.page);
      if (shapes.filter((shape) => shape.target !== "panel").length !== 2) problems.push(`shadow: the probe draws ${shapes.length} chrome regions`);
      // Every panel opened and closed first: a theme's styles on its content must leave nothing over the page after.
      if (name.startsWith("panel-")) problems.push(...await panelProblems(probe.page, width));
      for (const covered of await coveredControls(probe.page)) problems.push(`covered: ${covered}`);
      const screen = await firstScreen(probe.page);
      if (screen.frame > screen.screen / 2 + 1) problems.push(`containment: the header's frame is ${Math.round(screen.frame)}px tall on a ${screen.screen}px screen`);
      if (screen.first >= screen.screen) problems.push(`containment: the account's first control starts below the first screen (${Math.round(screen.first)}px)`);
    } catch (error) {
      problems.push(`probe: could not be checked (${String(error?.message ?? error).split("\n")[0]})`);
    }
    await probe.context.close();
    fail(label, problems);
    if (problems.length === 0) console.log(`✓ ${label}`);
  }
}

// ── Sheets the store refuses: its own header draws, and nothing they name is requested.
for (const [name, sheet] of [...Object.entries(REFUSED).map(([key, text]) => [key, { sheet: text }]), ["utf16-bom", { sheetBase64: UTF16 }]]) {
  const id = await registerSheet(`buyer-chrome-refused-${name}`, sheet);
  const label = `390px light (refused probe ${name})`;
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  const named = [];
  page.on("request", (request) => { if (/\/leak\?|evil\.css/.test(request.url())) named.push(request.url().replace(gallery.url, "")); });
  await page.goto(`${gallery.url}/__gallery/e/${id}`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  draws += 1;
  const problems = [];
  const drawn = await page.evaluate(() => document.querySelectorAll("scalius-chrome").length);
  if (drawn !== 0) problems.push(`refusal: the store draws the probe's chrome (${drawn} regions) from a sheet it must refuse`);
  for (const request of [...new Set(named)]) problems.push(`refusal: the page requests ${request}`);
  await context.close();
  fail(label, problems);
  if (problems.length === 0) console.log(`✓ ${label}`);
}

await browser.close();
await gallery.close();
console.log(`${draws} draws, ${failures.length} failing: ${failures.length === 0 ? "every draw holds" : failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
