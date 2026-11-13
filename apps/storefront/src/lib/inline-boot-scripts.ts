import { SKIN_CHOOSE_CONTROL } from "@/components/product/lib/buy-form";
import { STALE_ASSET_EVENT } from "@/scripts/browser-events";

/**
 * The two classic scripts every page runs inline after its visible HTML and
 * before the deferred modules (Layout.astro), written compactly because they
 * repeat in every cached HTML response. inline-boot-scripts.test.ts runs both.
 *
 * AD_CLICK_ID_SCRIPT: outside a theme preview, a valid ad-click id in the URL
 * (fbclid as Meta's `_fbc` "fb.1.<ms>.<id>"; gclid, gbraid, wbraid, msclkid,
 * ttclid as `scalius_<name>`) is kept 90 days in a first-party cookie and in
 * session storage, and `storefront-cookie-created` is dispatched (the private
 * session prefetch guard listens for it). Ids are trimmed and must match
 * [A-Za-z0-9._~-]{1,512}.
 * Under the consent banner (components/consent) the ids are advertising
 * storage: until marketing is granted they stay in memory only
 * (`window.__scaliusClickIds`), and the banner writes them on consent.
 */
export const AD_CLICK_ID_SCRIPT =
  'if(document.documentElement.dataset.themePreview!=="true")try{' +
  'const q=new URLSearchParams(location.search),' +
  's="; path=/; max-age=7776000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":""),' +
  'r=n=>{const v=(q.get(n)||"").trim();return/^[A-Za-z0-9._~-]{1,512}$/.test(v)?v:""},' +
  'p=(c,k,v)=>{const g=window.__scaliusConsent;if(g&&g.marketing!==true){(window.__scaliusClickIds||(window.__scaliusClickIds={}))[c]=v;return}document.cookie=c+"="+encodeURIComponent(v)+s;dispatchEvent(new CustomEvent("storefront-cookie-created"));try{sessionStorage.setItem(k,v)}catch{}},' +
  'f=r("fbclid");' +
  'f&&p("_fbc","scalius_fbc","fb.1."+Date.now()+"."+f);' +
  'for(const n of["gclid","gbraid","wbraid","msclkid","ttclid"]){const v=r(n);v&&p("scalius_"+n,"scalius_"+n,v)}' +
  '}catch(e){console.warn("Could not process ad click id:",e)}';

/**
 * STALE_ASSET_RECOVERY_SCRIPT: a page cached before a deploy names build
 * files that no longer exist. A failed /_astro/ script or stylesheet, or a
 * failed dynamic import of one that names it, reloads the page once (at
 * most every 30 s, `_ar` in session storage). Safari names no file
 * ("Importing a module script failed."), which an app island's own import
 * may say too, so it is never matched: the store's own lazy scripts report
 * their failure with STALE_ASSET_EVENT instead, and only when a reload
 * loses nothing the buyer typed (product-controller.ts). It stays inline:
 * as a build file it would be the stale asset itself.
 */
export const STALE_ASSET_RECOVERY_SCRIPT =
  '(()=>{const r=sessionStorage.getItem("_ar");if(r&&Date.now()-parseInt(r,10)<3e4)return;' +
  'const g=()=>{sessionStorage.setItem("_ar",Date.now().toString());location.reload()};' +
  'addEventListener("error",e=>{const t=e.target,s=t instanceof HTMLScriptElement;' +
  'if(!s&&!(t instanceof HTMLLinkElement))return;const u=s?t.src:t.href;' +
  'if(u.indexOf("/_astro/")>-1){console.warn("[StaleAsset] 404:",u);g()}},!0);' +
  `addEventListener("${STALE_ASSET_EVENT}",()=>{console.warn("[StaleAsset] Import failed");g()});` +
  'addEventListener("unhandledrejection",e=>{const m=e.reason&&e.reason.message;' +
  'if(m&&m.indexOf("dynamically imported")>-1&&m.indexOf("/_astro/")>-1){console.warn("[StaleAsset] Import failed");g()}})})();';

/**
 * VARIANT_PREPAINT_SCRIPT: a product page is one cached page whatever its
 * `?variant=<sku id>` says (feed rows, shared links). Run by the buy box
 * (ProductSummary.astro) before its first paint, it marks the document
 * `data-variant-pending` when the URL names a SKU, so the opening choice's
 * price, stock and option states never paint; product-controller.ts selects
 * the named SKU and clears the mark. It clears itself after 3 s if the
 * controller never runs.
 */
export const VARIANT_PREPAINT_SCRIPT =
  '(()=>{try{if(!new URLSearchParams(location.search).get("variant"))return;' +
  'const d=document.documentElement;d.dataset.variantPending="";' +
  'setTimeout(()=>{delete d.dataset.variantPending},3e3)}catch{}})();';

/**
 * SKIN_CHOICE_PREPAINT_SCRIPT: the host draws a product_main skin's choice
 * controls (`chooseVariant`) with the SKU the page opens on chosen. Run right
 * after the skin's markup (lib/extensions/purchase-controls.ts), it moves
 * that mark to the SKU a `?variant=<sku id>` link names before the first
 * paint, as VARIANT_PREPAINT_SCRIPT holds the form's own parts;
 * product-controller.ts then keeps it current.
 */
export const SKIN_CHOICE_PREPAINT_SCRIPT =
  '(()=>{try{const v=new URLSearchParams(location.search).get("variant");if(!v)return;' +
  `for(const e of document.querySelectorAll("${SKIN_CHOOSE_CONTROL}")){const s=e.dataset.chooseVariant===v;` +
  'e.dataset.state=s?"selected":"unselected";if(e.tagName==="BUTTON")e.setAttribute("aria-pressed",String(s));' +
  'else if(s)e.setAttribute("aria-current","true");else e.removeAttribute("aria-current")}}catch{}})();';

// The other inline scripts the storefront's pages and components run as they
// are parsed. Each is constant code (lib/inline-script-policy.ts puts its hash
// in every page's policy); a value it needs rides on its own element's
// attributes or in a JSON block beside it, never in its code.

/** On phones, the hero follows the category tiles when the theme asks for it (moved before first paint, back on wide screens). */
export const HOMEPAGE_PHONE_REORDER_SCRIPT = `(() => {
  const root = document.querySelector("[data-home-phone-reorder]");
  if (!root) return;
  const hero = root.querySelector(':scope > [data-home-section="hero"]');
  const categories = root.querySelector(':scope > [data-home-section="category_tiles"]');
  if (!hero || !categories) return;
  const desktopNext = hero.nextElementSibling;
  const phone = matchMedia("(max-width: 767px)");
  const sync = () => {
    if (phone.matches) categories.after(hero);
    else root.insertBefore(hero, desktopNext);
  };
  sync();
  phone.addEventListener("change", sync);
})();`;

/** Measures the account workspace's top before it paints, and keeps it measured. */
export const ACCOUNT_WORKSPACE_MEASURE_SCRIPT = `(() => {
  const shell = document.querySelector('[data-account-workspace="true"]');
  if (!shell) return;
  let frame = 0;
  const measure = () => {
    frame = 0;
    const top = Math.max(0, shell.getBoundingClientRect().top + window.scrollY);
    const value = \`\${top}px\`;
    if (shell.style.getPropertyValue('--account-workspace-top') !== value) shell.style.setProperty('--account-workspace-top', value);
    shell.setAttribute('data-workspace-ready', '');
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const observer = new ResizeObserver(schedule);
  observer.observe(document.body);
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('astro:before-swap', () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); }, { once: true });
  measure();
})();`;

/** A page opened from a link that carries a token: the token stays in the form, not in the address bar or history. */
export const URL_TOKEN_SCRUB_SCRIPT = `// The token stays in the form, not in the address bar or history.
if (location.search) history.replaceState(null, "", location.pathname);`;

/** Right inside the checkout root, before anything below it is parsed: a checkout in progress paints its loading state, and a page without one goes back to the cart. */
export const CHECKOUT_FIRST_PAINT_SCRIPT = `(function () {
  var root = document.getElementById("checkoutPageRoot");
  try {
    var lines = 0;
    try { lines = Object.keys((JSON.parse(localStorage.getItem("cart:v3") || "null") || {}).items || {}).length; } catch (error) {}
    if (sessionStorage.getItem("scalius_checkout_data") || (sessionStorage.getItem("scalius_last_order") && lines === 0)) {
      root.dataset.checkoutState = "loading";
      return;
    }
  } catch (error) {
    // Unreadable storage: the page script names it.
    root.dataset.checkoutState = "loading";
    return;
  }
  root.dataset.checkoutState = "redirect";
  location.replace(location.pathname.replace(/checkout\\/?$/, "cart"));
})();`;

/** Apply pressed before the checkout script has loaded: kept for it, never posted (buyer QA M4). The button's pending words ride on `data-applying`. */
export const GIFT_CARD_EARLY_APPLY_SCRIPT =
  '(function(c){var f=document.getElementById("giftCardForm");if(!f)return;var t=c.getAttribute("data-applying");f.addEventListener("submit",function(e){if(f.dataset.bound==="true")return;e.preventDefault();f.dataset.pending="true";var b=document.getElementById("giftCardApply");if(b)b.textContent=t;});})(document.currentScript);';

/** Footer menus fold on phones and stay open on wide screens. */
export const FOOTER_MENU_FOLD_SCRIPT =
  '(function(){var m=matchMedia("(min-width: 64rem)");var s=function(){document.querySelectorAll(".footer-menu").forEach(function(d){d.open=m.matches})};if(!m.matches)s();m.addEventListener("change",s)})()';

/** Copies the JSON block just before it (components/WindowGlobals.astro) onto `window` as the parser reaches it: page values for the module scripts, with no value in any script's code. */
export const WINDOW_GLOBALS_SCRIPT =
  '(function(s){var d=JSON.parse(s.previousElementSibling.textContent);for(var k in d)window[k]=d[k]})(document.currentScript)';

/** The sign-in hint before first paint: `whenSignedIn()` / `whenSignedOut()` parts never flash (scripts/app-components.ts keeps it current). */
export const SIGNED_IN_HINT_SCRIPT =
  'document.cookie.split(";").some(function(c){return c.trim()==="cs_auth=1"})&&document.documentElement.setAttribute("data-scalius-signed-in","");';

/** `astro dev` only: React Fast Refresh's preamble, before any island module. */
export const REACT_REFRESH_PREAMBLE = `import RefreshRuntime from "/@react-refresh";
if (!window.$RefreshReg$) {
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
}`;
