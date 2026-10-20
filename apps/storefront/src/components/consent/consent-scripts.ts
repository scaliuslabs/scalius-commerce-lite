// The consent banner's two inline scripts (audit spec §3.10, lead decision D6).
//
// CONSENT BOOT (head, before every tag and the Partytown bootstrap): reads the
// buyer's stored choice (`scalius_consent`) and Global Privacy Control, falls
// back to the page market's regime, publishes `window.__scaliusConsent`, gives
// Google its Consent Mode v2 defaults before any tag, and marks <html> when
// the banner must show, so it paints with the page (no flash, no shift).
//
// CONSENT RUNTIME (after the banner): the buttons, the stored choice, Consent
// Mode updates, and the marketing tags. Meta and TikTok snippets are rendered
// inert (`type="text/plain" data-scalius-consent="marketing"`) and start only
// once marketing is granted. Revoking stops them (`fbq('consent','revoke')`,
// `ttq.revokeConsent()`); the next page never loads them.
//
// Both are cached per market: the HTML never depends on the cookie.
import {
  CLICK_ID_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE,
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  type ConsentRegime,
} from "@scalius/shared/tracking-consent";

export const CONSENT_BANNER_ID = "scalius-consent";
export const MARKETING_SCRIPT_ATTRIBUTE = "data-scalius-consent";

/** The head script. `regime` is the page market's; `google` adds Consent Mode defaults. */
export function consentBootScript(regime: ConsentRegime, options: { google: boolean }): string {
  const google = options.google
    ? 'var p=function(v){return v?"granted":"denied"};w.dataLayer=w.dataLayer||[];' +
      'w.gtag=w.gtag||function(){w.dataLayer.push(arguments)};' +
      'w.gtag("consent","default",{ad_storage:p(c.marketing),analytics_storage:p(c.analytics),ad_user_data:p(c.marketing),ad_personalization:p(c.marketing),wait_for_update:500});' +
      'w.gtag("set","ads_data_redaction",!c.marketing);'
    : "";
  return (
    "!function(w,d,R){" +
    `var m=/(?:^|; )${CONSENT_COOKIE}=v1-a([01])-m([01])-s([01])/.exec(d.cookie),` +
    'o=R!=="opt_in",g=w.navigator&&w.navigator.globalPrivacyControl===true,' +
    'c=m?{analytics:m[1]==="1",marketing:m[2]==="1",saleOfData:m[3]==="1",source:"banner"}:{analytics:o,marketing:o,saleOfData:o,source:"default"};' +
    'if(g&&(c.marketing||c.saleOfData)){c.marketing=false;c.saleOfData=false;c.source="gpc"}' +
    "c.regime=R;c.stored=!!m;w.__scaliusConsent=c;" +
    google +
    'if(!m&&R!=="link_only")d.documentElement.setAttribute("data-consent-banner","")' +
    `}(window,document,${JSON.stringify(regime)});`
  );
}

/** The runtime script: buttons, cookie, Consent Mode updates and the marketing tags. */
export const CONSENT_RUNTIME_SCRIPT =
  "!function(w,d){" +
  `var B=d.getElementById(${JSON.stringify(CONSENT_BANNER_ID)});if(!B)return;` +
  'var P=d.getElementById("scalius-consent-choices"),M=d.querySelector("[data-consent-manage]"),' +
  'secure=location.protocol==="https:"?"; Secure":"",' +
  "C=function(){return w.__scaliusConsent||{analytics:false,marketing:false,saleOfData:false}};" +
  // Marketing tags: a Partytown one changes type and wakes Partytown; a main-thread one is recreated.
  "var started=false,start=function(){if(started)return;started=true;var pt=false;" +
  `d.querySelectorAll('script[${MARKETING_SCRIPT_ATTRIBUTE}="marketing"]').forEach(function(s){` +
  'var t=s.getAttribute("data-scalius-type")||"";s.removeAttribute("' + MARKETING_SCRIPT_ATTRIBUTE + '");' +
  'if(t==="text/partytown"){s.setAttribute("type",t);pt=true;return}' +
  'var n=d.createElement("script");for(var i=0;i<s.attributes.length;i++){var a=s.attributes[i];if(a.name!=="type"&&a.name!=="data-scalius-type")n.setAttribute(a.name,a.value)}' +
  'if(t)n.setAttribute("type",t);n.text=s.text;s.replaceWith(n)});' +
  'if(pt)w.dispatchEvent(new CustomEvent("ptupdate"));' +
  // Click ids kept from the landing URL become first-party cookies only now.
  `var k=w.__scaliusClickIds||{};for(var name in k){d.cookie=name+"="+encodeURIComponent(k[name])+"; path=/; max-age=${CLICK_ID_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax"+secure}w.__scaliusClickIds={}};` +
  "var apply=function(c,store){" +
  'c.source="banner";c.regime=C().regime;c.stored=true;' +
  'if(w.navigator&&w.navigator.globalPrivacyControl===true&&(c.marketing||c.saleOfData)){c.marketing=false;c.saleOfData=false;c.source="gpc"}' +
  "w.__scaliusConsent=c;" +
  `if(store)d.cookie="${CONSENT_COOKIE}=v1-a"+(c.analytics?1:0)+"-m"+(c.marketing?1:0)+"-s"+(c.saleOfData?1:0)+"; path=/; max-age=${CONSENT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax"+secure;` +
  'var p=function(v){return v?"granted":"denied"};' +
  'if(typeof w.gtag==="function")w.gtag("consent","update",{ad_storage:p(c.marketing),analytics_storage:p(c.analytics),ad_user_data:p(c.marketing),ad_personalization:p(c.marketing)});' +
  'if(c.marketing){start();try{typeof w.fbq==="function"&&w.fbq("consent","grant");w.ttq&&w.ttq.grantConsent&&w.ttq.grantConsent()}catch(e){}}' +
  'else{try{typeof w.fbq==="function"&&w.fbq("consent","revoke");w.ttq&&w.ttq.revokeConsent&&w.ttq.revokeConsent()}catch(e){}}' +
  'd.documentElement.removeAttribute("data-consent-banner");' +
  'w.dispatchEvent(new CustomEvent("scalius:consent",{detail:c}))};' +
  "var sync=function(){var c=C();if(!P)return;" +
  '["analytics","marketing","saleOfData"].forEach(function(n){var i=P.querySelector("input[name="+n+"]");if(i)i.checked=!!c[n]})};' +
  // The banner's buttons and the footer's "Your privacy choices".
  'd.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("[data-consent-action]");if(!t)return;' +
  'var a=t.getAttribute("data-consent-action");' +
  'if(a==="accept")apply({analytics:true,marketing:true,saleOfData:true},true);' +
  'else if(a==="reject")apply({analytics:false,marketing:false,saleOfData:false},true);' +
  'else if(a==="ok")apply({analytics:C().analytics,marketing:C().marketing,saleOfData:C().saleOfData},true);' +
  'else if(a==="manage"){sync();if(P){P.hidden=!P.hidden;M&&M.setAttribute("aria-expanded",String(!P.hidden));P.hidden||(P.querySelector("input:not([disabled])")||P).focus()}}' +
  'else if(a==="save"&&P){var v=function(n){var i=P.querySelector("input[name="+n+"]");return!!(i&&i.checked)};apply({analytics:v("analytics"),marketing:v("marketing"),saleOfData:v("saleOfData")},true)}' +
  'else if(a==="open"){d.documentElement.setAttribute("data-consent-banner","");sync();if(P){P.hidden=false;M&&M.setAttribute("aria-expanded","true")}var f=B.querySelector("button");f&&f.focus()}});' +
  'd.addEventListener("keydown",function(e){if(e.key==="Escape"&&d.documentElement.hasAttribute("data-consent-banner")&&C().stored)d.documentElement.removeAttribute("data-consent-banner")});' +
  'd.querySelectorAll("[data-consent-action=open]").forEach(function(b){b.hidden=false});' +
  "if(C().marketing)start()" +
  "}(window,document);";
