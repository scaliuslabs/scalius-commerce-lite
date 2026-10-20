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
 * failed dynamic import of one, reloads the page once (at most every 30 s,
 * `_ar` in session storage). It stays inline: as a build file it would be the
 * stale asset itself.
 */
export const STALE_ASSET_RECOVERY_SCRIPT =
  '(()=>{const r=sessionStorage.getItem("_ar");if(r&&Date.now()-parseInt(r,10)<3e4)return;' +
  'const g=()=>{sessionStorage.setItem("_ar",Date.now().toString());location.reload()};' +
  'addEventListener("error",e=>{const t=e.target,s=t instanceof HTMLScriptElement;' +
  'if(!s&&!(t instanceof HTMLLinkElement))return;const u=s?t.src:t.href;' +
  'if(u.indexOf("/_astro/")>-1){console.warn("[StaleAsset] 404:",u);g()}},!0);' +
  'addEventListener("unhandledrejection",e=>{const m=e.reason&&e.reason.message;' +
  'if(m&&m.indexOf("dynamically imported")>-1&&m.indexOf("/_astro/")>-1){console.warn("[StaleAsset] Import failed");g()}})})();';
