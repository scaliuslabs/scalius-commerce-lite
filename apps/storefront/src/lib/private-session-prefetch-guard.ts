/**
 * Builds the small, request-aware bootstrap that runs before Astro's deferred
 * prefetch module. Public anonymous pages keep Astro's normal prefetch policy;
 * any request that bypasses the public cache suppresses speculative navigation
 * work for the rest of the document lifetime.
 *
 * Once active (at once when `initiallySuppressed`, else on `customer-login` or
 * `storefront-cookie-created`) every anchor without an explicit
 * `data-astro-prefetch="false"`, including anchors added later, gets
 * `data-astro-prefetch="false"` and `data-storefront-session-prefetch`, and a
 * capturing `mouseenter` listener stops hover handlers on those anchors.
 * Written compactly: it is inline in every page.
 */
export function buildPrivateSessionPrefetchGuardScript(
  initiallySuppressed: boolean,
): string {
  return '(()=>{const p="data-astro-prefetch",w=new WeakSet;let a=!1;' +
    'const m=e=>{e.getAttribute(p)==="false"||w.has(e)||(w.add(e),e.setAttribute(p,"false"),e.setAttribute("data-storefront-session-prefetch",""))},' +
    't=e=>{e instanceof HTMLAnchorElement&&m(e);typeof e.querySelectorAll=="function"&&e.querySelectorAll("a").forEach(m)},' +
    'v=()=>{if(a)return;a=!0;t(document);new MutationObserver(r=>{for(const c of r)for(const n of c.addedNodes)n instanceof Element&&t(n)})' +
    '.observe(document.documentElement,{childList:!0,subtree:!0})};' +
    'document.addEventListener("mouseenter",e=>{if(!a||!(e.target instanceof Element))return;const n=e.target.closest("a");n&&w.has(n)&&e.stopImmediatePropagation()},!0);' +
    'window.addEventListener("customer-login",v);window.addEventListener("storefront-cookie-created",v);' +
    `${initiallySuppressed ? "v()" : ""}})();`;
}
