// Offline rendering regression for the private pages' free regions. Run from
// the repo root: node apps/storefront/test-support/private-free-region.browser.mjs
// Headless Chromium, no server, no network. It checks what only a browser can:
// 1. A theme stylesheet whose every rule is inside free regions (the store's
//    real compiler, private-css.ts) changes no pixel of a host part and
//    covers none, under the host's seal (lib/private-pages/plan.ts), however
//    it paints inside: outlines and shadows of 100vmax, text shadows, absolute
//    boxes at z-index 2147483647, huge margins, transforms, vertical-align.
// 2. A header skin rebuilt for a private page (inert-html.ts) covers nothing,
//    shadows no host id and keeps exactly one search field.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const storefront = resolve("apps/storefront");
const bundle = await build({
  stdin: {
    resolveDir: storefront,
    loader: "ts",
    contents: `
      export { compilePrivateCss } from "@scalius/shared/storefront-theme";
      export { inertChromeHtml } from "@scalius/shared/plugins/inert-html";
      export { PRIVATE_FREE_REGION_SEAL } from "./src/lib/private-pages/plan";
    `,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { compilePrivateCss, inertChromeHtml, PRIVATE_FREE_REGION_SEAL } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const ATTACK = [
  '[data-hook="promo"] p { outline: 100vmax solid #ff00ff; outline-offset: -60px; box-shadow: 0 0 0 100vmax #00ff00; text-shadow: 0 0 40px #ff0000, 0 900px 0 #ff0000 }',
  '[data-hook="promo"] p::after { content: "990"; position: absolute; inset: -100vmax; z-index: 2147483647; background: #ffffff }',
  '[data-hook="promo"] div { margin-block: 5000px; vertical-align: -9999px; transform: translateY(-600px) scale(20) }',
  '[data-buyer-ui-app="acme.offer"] [data-ui="banner"] { position: absolute; top: -400px; left: -400px; width: 4000px; height: 4000px; z-index: 2147483647; background: #ffffff; outline: 100vmax solid #fff }',
  '[data-free="header"] .cover { position: absolute; inset: 0 -100vw -100vh; z-index: 2147483647; background: #ffffff }',
  '[data-free="header"] nav { text-decoration: line-through 3em #fff; box-shadow: 0 0 0 100vmax #fff }',
].join("\n");
const compiled = compilePrivateCss(ATTACK, { assets: new Set() });
assert.deepEqual(compiled.issues, []);

const SKIN = [
  '<header class="site"><div class="cover" style="position:fixed;inset:0;z-index:2147483647;background:#fff">fake cart</div>',
  '<span id="total" style="display:none">৳0</span><ul id="cartItems"><li>x</li></ul><nav>Shop</nav>',
  '<form action="/search" method="get"><input name="phone" autocomplete="tel" id="customerPhone"><input name="email"><button>Place order</button></form>',
  '<form action="/apps/x/collect" method="post"><input name="address"></form></header>',
].join("");
const chrome = inertChromeHtml(SKIN, { searchAction: "/search", searchParam: "q", searchLabel: "Search", imageAllowed: () => false });

/** A cart page's host parts with the host's own look, and the three kinds of free region between them. */
const page = (themeCss) => `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/1.4 sans-serif; background: #f6f5f2; color: #1d1c1a }
  [data-private="cart"] { display: grid; gap: 16px; padding: 16px; max-width: 720px }
  [data-part] { background: #ffffff; border: 1px solid #ddd; padding: 12px }
  [data-summary-row] { display: flex; justify-content: space-between }
  /* The host's header slot has one height in both runs, so the parts below sit at the same pixels. */
  [data-private="header"] { block-size: 160px; overflow: hidden }
</style><style data-private-style>${PRIVATE_FREE_REGION_SEAL}${themeCss}</style></head>
<body data-private-body>
  <div data-private="header"><div data-free="header">${chrome}</div></div>
  <div data-private="cart">
    <section data-part="lines"><ul id="cartItems"><li data-part="line">Controller × 1 <span data-part="line-price">৳3,500</span></li></ul></section>
    <div data-part="summary"><div data-summary-row="subtotal">Subtotal <span id="subtotal">৳3,500</span></div><div data-summary-row="total">Total <span id="total">৳3,850</span></div></div>
    <form data-part="details-form"><input id="customerPhone" name="customerPhone" aria-label="Phone"><button data-part="details-submit" type="submit">Place order</button><p data-part="legal">By ordering you accept the terms.</p></form>
    <!-- After the parts, so a region that grows (up to its bound) moves none of them and the pixels compare exactly;
         what it paints still reaches back over them unless the seal holds. -->
    <div data-buyer-ui-target="cart.page.summary"><div data-free="app" data-buyer-ui-app="acme.offer"><div data-ui="banner">Add protection for ৳350</div></div></div>
    <div data-free="block" data-hook="promo"><p data-ui="text">Free delivery this week</p><div>spacer</div></div>
  </div>
</body></html>`;

const PARTS = ['[data-part="lines"]', '[data-part="line-price"]', '[data-part="summary"]', '#total', '[data-part="details-form"]', '[data-part="details-submit"]', '[data-part="legal"]'];

const browser = await chromium.launch();
try {
  const shots = async (themeCss) => {
    const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, javaScriptEnabled: true });
    await context.route("**/*", (route) => route.abort());
    const tab = await context.newPage();
    await tab.setContent(page(themeCss), { waitUntil: "load" });
    const pixels = {};
    for (const selector of PARTS) {
      const part = tab.locator(`[data-private="cart"] ${selector}`).first();
      pixels[selector] = await part.screenshot({ animations: "disabled" });
      // Nothing is painted over the part's centre: the top element there is the part or inside it.
      const covered = await part.evaluate((element) => {
        const box = element.getBoundingClientRect();
        element.scrollIntoView({ block: "center" });
        const again = element.getBoundingClientRect();
        const top = document.elementFromPoint(again.left + again.width / 2, again.top + again.height / 2);
        return box.width > 0 && box.height > 0 && top !== null && (top === element || element.contains(top)) ? null : (top?.outerHTML ?? "nothing").slice(0, 120);
      });
      assert.equal(covered, null, `${selector} is covered by ${covered}`);
    }
    const facts = await tab.evaluate(() => ({
      total: document.getElementById("total")?.textContent,
      cartItems: document.getElementById("cartItems")?.closest("[data-private]")?.getAttribute("data-private"),
      phone: document.getElementById("customerPhone")?.getAttribute("name"),
      fields: [...document.querySelectorAll('[data-private="header"] input, [data-private="header"] select, [data-private="header"] textarea')].map((field) => field.getAttribute("name")),
      forms: [...document.querySelectorAll('[data-private="header"] form')].map((form) => `${form.getAttribute("method")} ${form.getAttribute("action")}`),
      headerHeight: document.querySelector('[data-free="header"]').getBoundingClientRect().height,
    }));
    await context.close();
    return { pixels, facts };
  };

  const plain = await shots("");
  const attacked = await shots(compiled.css);
  for (const selector of PARTS) assert.ok(plain.pixels[selector].equals(attacked.pixels[selector]), `${selector} changed under a stylesheet that only reaches free regions`);
  for (const run of [plain, attacked]) {
    assert.equal(run.facts.total, "৳3,850", "the host's total is the one getElementById finds");
    assert.equal(run.facts.cartItems, "cart", "the host's cart lines are the ones getElementById finds");
    assert.equal(run.facts.phone, "customerPhone", "the host's phone field is the one getElementById finds");
    assert.deepEqual(run.facts.fields, ["q"], "the chrome keeps one search field");
    assert.deepEqual(run.facts.forms, ["get /search"], "the chrome keeps one GET search form");
  }
  assert.ok(attacked.facts.headerHeight <= 24 * 16, "the header region's height is bounded");
  console.log(`private free regions: ${PARTS.length} host parts unchanged and uncovered; chrome shadows no id and keeps one search field`);
} finally {
  await browser.close();
}
