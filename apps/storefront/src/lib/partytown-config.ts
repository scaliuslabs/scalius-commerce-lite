/**
 * Partytown configuration.
 *
 * The runtime is opt-in per page: Layout.astro renders the bootstrap only when
 * an enabled analytics script actually runs in Partytown, and forwards only
 * the globals those scripts define. Pages without such a script never load
 * the worker, and `fbq`/`gtag`/`ttq` stay undefined so storefront analytics
 * calls are no-ops (or reach a main-thread script) instead of being forwarded
 * into a worker that has no receiver.
 */
import type { AnalyticsConfig } from "@/lib/api/types";

/**
 * Proxies known third-party analytics scripts through the same-origin
 * /api/ptproxy endpoint so the Partytown web worker can fetch them without
 * CORS issues. A plain function, so CSP needs no 'unsafe-eval'.
 */
function resolveUrl(url: URL, location: Location, type: string): URL {
  if (
    type === "script" &&
    (url.hostname === "connect.facebook.net" ||
      url.hostname === "analytics.tiktok.com" ||
      url.hostname === "www.googletagmanager.com" ||
      url.hostname === "www.google-analytics.com")
  ) {
    const proxyUrl = new URL("/api/ptproxy", location.origin);
    proxyUrl.searchParams.set("url", url.href);
    return proxyUrl;
  }

  return url;
}

/**
 * Build-time loader configuration. `forward` is intentionally absent: the
 * page bootstrap supplies `window.partytown.forward` for its own scripts.
 */
export const partytownConfig = {
  resolveUrl,
  debug: false as boolean,
  logCalls: false as boolean,
  logGetters: false as boolean,
  logSetters: false as boolean,
  logImageRequests: false as boolean,
  logMainAccess: false as boolean,
  logSendBeaconRequests: false as boolean,
  logStackTraces: false as boolean,
  logScriptExecution: false as boolean,
};

const FORWARD_RULES: ReadonlyArray<{
  forward: readonly string[];
  types: readonly string[];
  pattern: RegExp;
}> = [
  {
    forward: ["dataLayer.push"],
    types: ["google_analytics", "google_tag_manager"],
    pattern: /\bdataLayer\b|\bgtag\s*\(|googletagmanager\.com/,
  },
  { forward: ["gtag"], types: ["google_analytics"], pattern: /\bgtag\s*\(/ },
  { forward: ["ga"], types: [], pattern: /\bga\s*\(|google-analytics\.com\/analytics\.js/ },
  {
    forward: ["fbq"],
    types: ["facebook_pixel"],
    pattern: /\bfbq\s*\(|connect\.facebook\.net/,
  },
  {
    forward: ["ttq.load", "ttq.page", "ttq.track"],
    types: ["tiktok_pixel"],
    pattern: /\bttq\.|analytics\.tiktok\.com/,
  },
];

/** Globals to forward for the scripts that run in Partytown on this page. */
export function partytownForwardFor(
  scripts: readonly Pick<AnalyticsConfig, "type" | "usePartytown" | "config">[],
): string[] {
  const workerScripts = scripts.filter((script) => script.usePartytown);
  return FORWARD_RULES.filter((rule) =>
    workerScripts.some(
      (script) =>
        rule.types.includes(script.type.trim().toLowerCase()) ||
        rule.pattern.test(script.config),
    ),
  ).flatMap((rule) => rule.forward);
}

/**
 * Inline head bootstrap: installs `window.partytown.forward`, queues calls to
 * the forwarded globals, and loads the Partytown loader after `load` plus two
 * frames (or on first interaction, or after 4 s) so it never competes with
 * first paint. Queued calls replay into Partytown's own forwarding stubs.
 * `dataLayer.push` keeps its array behaviour while queued.
 */
export function buildPartytownBootstrap(
  forward: readonly string[],
  loaderPath: string,
): string {
  return `!function(w,d,p,a){(w.partytown=w.partytown||{}).forward=a.slice();var q=w.__scaliusPtq=w.__scaliusPtq||[],x=function(n){for(var s=n.split('.'),o=w,i=0;i<s.length-1;i++)o=o[s[i]]||(o[s[i]]=s[i+1]==='push'?[]:{});var k=s[s.length-1],f=o[k];o[k]=function(){var r=[].slice.call(arguments);q.push([n,r]);if(n==='dataLayer.push'&&typeof f==='function')return f.apply(o,r)}};a.forEach(x);var l=0,h=function(){if(l)return;l=1;var s=d.createElement('script');s.src=p;s.async=true;s.onload=function(){var b=q.splice(0);b.forEach(function(e){for(var s=e[0].split('.'),o=w,i=0;i<s.length-1;i++)o=o&&o[s[i]];var f=o&&o[s[s.length-1]];if(typeof f==='function')f.apply(o,e[1])})};d.head.appendChild(s)},r=w.requestAnimationFrame||function(f){return setTimeout(f,16)},g=function(){r(function(){r(h)})};d.readyState==='complete'?g():w.addEventListener('load',g,{once:true});['pointerdown','keydown','touchstart'].forEach(function(e){w.addEventListener(e,h,{once:true,passive:true})});setTimeout(h,4000)}(window,document,${JSON.stringify(
    loaderPath,
  )},${JSON.stringify(forward)});`;
}
