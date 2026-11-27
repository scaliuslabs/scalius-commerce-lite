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
//   name, a fixed layer, a screen-wide shadow) leaves every host control's
//   computed style as under the store's chrome, the page's body unpainted, and
//   every host control taking a press at its centre (nothing covers it);
// - each shadow root holds only what the inert rebuild writes: no form, field,
//   label, submit button, handler or tab stop;
// - under a theme's sheet the chrome follows the page's scheme on its host, its
//   light or dark switch flips the page (the store's own switch yields to it),
//   its signed-in and guest versions follow the sign-in hint, its cart count
//   shows the browser's cart, and on a phone its menu drawer opens over the page
//   on a press and closes with Escape;
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
const { problems: PROBLEMS_SOURCE, markup: INERT_MARKUP } = await fetch(`${gallery.url}/__gallery/buyer-chrome`).then((answer) => answer.json());
const ids = { none: await register("buyer-chrome-none", "none"), theme: await register("buyer-chrome-theme", "theme"), forged: await register("buyer-chrome-forged", "forged") };
// A cart in the browser (the gallery's own seed, as the cart page's entries hold it).
const index = await fetch(`${gallery.url}/__gallery/index.json`).then((answer) => answer.json());
const CART = index.entries.find((entry) => entry.storage?.["cart:v3"])?.storage["cart:v3"] ?? null;

const browser = await chromium.launch();
const failures = [];
let draws = 0;

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

/** Each host control a buyer can see that does not take a press at its centre (something drawn over it). */
const coveredControls = (page) => page.evaluate(async (selector) => {
  const covered = [];
  for (const element of document.querySelectorAll(selector)) {
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none" || element.closest("[hidden]")) continue;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (!element.contains(hit) && !hit.contains(element))) covered.push(`${element.localName}${element.className ? `.${String(element.className).split(" ")[0]}` : ""} "${(element.textContent ?? "").trim().slice(0, 30)}" under <${hit?.localName ?? "nothing"}>`);
  }
  window.scrollTo(0, 0);
  return covered;
}, HOST_CONTROLS);

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
    if (shapes.length !== 2) problems.push(`shadow: the forged theme draws ${shapes.length} chrome regions, not its header and footer`);
    for (const shape of shapes) {
      if (!shape.shadow) problems.push(`shadow: the ${shape.target} is drawn without a shadow root`);
      if (shape.light !== 0) problems.push(`shadow: the ${shape.target}'s host holds ${shape.light} children of its own`);
      if (shape.fields !== 0) problems.push(`markup: the ${shape.target} holds ${shape.fields} forms, fields, labels, submit buttons, handlers or tab stops`);
      for (const problem of shape.problems) problems.push(`markup: the ${shape.target}: ${problem}`);
      if (shape.position !== "static") problems.push(`containment: the ${shape.target}'s host is ${shape.position}, not in the page's flow`);
      if (!/paint/.test(shape.contain)) problems.push(`containment: the ${shape.target}'s host is not paint-contained (${shape.contain})`);
    }
    const header = shapes.find((shape) => shape.target === "header");
    if (header && header.top > 4) problems.push(`containment: the header's host starts ${Math.round(header.top)}px down the page`);
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

    // ── A theme's own sheet: its behaviours inside the shadow root.
    const theme = await open(ids.theme, width, scheme, { cart: true });
    draws += 1;
    const page = theme.page;
    if (process.env.CHROME_GATE_DUMP) console.log(await page.evaluate(() => Array.from(document.querySelectorAll("scalius-chrome")).map((host) => host.shadowRoot?.innerHTML ?? host.outerHTML).join("\n\n")));
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
    // The menu drawer on a phone: opens over the page on a press, closes with Escape.
    if (width < 1024) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('scalius-chrome[data-chrome="header"] .gc-menu-button').click();
      const drawer = await page.evaluate(() => {
        const element = document.querySelector('scalius-chrome[data-chrome="header"]').shadowRoot.querySelector("[data-menu-drawer]");
        const box = element.getBoundingClientRect();
        const hit = element.getRootNode().elementFromPoint(box.left + box.width / 2, box.top + 20);
        return { open: element.matches(":popover-open"), width: box.width, height: box.height, onTop: element.contains(hit) };
      });
      if (!drawer.open || drawer.width < 100 || drawer.height < 100) problems.push(`drawer: the menu drawer does not open on a press (${JSON.stringify(drawer)})`);
      else if (!drawer.onTop) problems.push("drawer: the open menu drawer is held under the page");
      await page.keyboard.press("Escape");
      if (await page.evaluate(() => document.querySelector('scalius-chrome[data-chrome="header"]').shadowRoot.querySelector("[data-menu-drawer]").matches(":popover-open"))) problems.push("drawer: Escape leaves the menu drawer open");
    }
    // The store's base under the theme's sheet loads (the shadow root's first import).
    const base = await page.evaluate(() => /@import url\("([^"]+)"\) layer\(scalius-base\)/.exec(document.querySelector("scalius-chrome").shadowRoot.querySelector("style")?.textContent ?? "")?.[1] ?? null);
    const baseText = base ? await page.evaluate(async (href) => (await fetch(href, { headers: { accept: "text/css" } })).text(), base) : "";
    if (!/box-sizing/.test(baseText)) problems.push(`base: the store's base sheet does not load as CSS (${base})`);
    problems.push(...theme.errors.map((error) => `request: ${error}`));
    await theme.context.close();
    fail(label, problems);
    if (problems.length === 0) console.log(`✓ ${label}`);
  }
}

await browser.close();
await gallery.close();
console.log(`${draws} draws, ${failures.length} failing: ${failures.length === 0 ? "every draw holds" : failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
