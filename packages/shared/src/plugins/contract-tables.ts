// What themes and apps depend on beyond schemas and declarations, as sealed
// tables of the plugin protocol seal (`protocolSeal().tables`,
// abi.protocol.snapshot.json). Each table carries its rule (contract/rules.ts):
//
//   grow     names a theme or app uses: the host CSS variables, the hooks on
//            the store's markup, the skin HTML allow-list, the delivery
//            headers and signature, the neutral words the store writes over
//            a refused label;
//   loosen   the limits an app is built against (app-limits.ts);
//   refuse   lists a check refuses by: the store's action and amount words,
//            their slot patterns, the label kinds' reach, the theme's
//            amount words, and the handles and subfolder form a stored
//            landing page is read against. A new member refuses an app or theme that passes
//            today, so after the lock it is a security entry, never growth.
//
//   fixed    which routes each private page key reaches (private-keys.ts):
//            a new key is growth; a key never starts or stops reaching a route.
//
// A table's rule is part of what is sealed: changing it is a break too.
import { WEBHOOK_API_VERSION_HEADER, WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SECRET_PREFIX, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS, WEBHOOK_TOPIC_HEADER } from "../events";
import { LINE_ENTRY_WORDS_BN, LINE_ENTRY_WORDS_EN } from "../line-entry-words";
import { STORE_ACTION_AND_AMOUNT_WORDS, STORE_WORD_LABEL_KINDS, STORE_WORD_SLOT_PATTERNS, STORE_WORDS_REASON } from "../store-words";
import type { ContractTable, ContractTableRule } from "../contract/rules";
import { PRIVATE_PAGE_ROUTES, PRIVATE_STORE_LOOK_ROUTES, PRIVATE_UNTHEMED_ROUTES } from "../storefront-theme/private-keys";
import { STOREFRONT_HOST_CSS_VARIABLES, STOREFRONT_HOST_HOOKS } from "../storefront-theme/host-contract";
import { PRIVATE_LABEL_AMOUNT_WORDS } from "../storefront-theme/private-layout";
import { LANDING_HANDLES_NEVER_VALID } from "../storefront-theme/pages";
import { MARKET_SUBFOLDER_PATTERN } from "../markets";
import { appSealedLimits } from "./app-limits";
import { STOREFRONT_SKIN_HTML_ALLOW_LIST } from "./html";
import { INERT_BEHAVIOURS, INERT_MARKUP, INERT_PANEL_KINDS } from "./inert-html";
import { BUYER_CHROME_CSS_AT_RULES } from "./buyer-chrome-css";

/**
 * The store's path of a release's derived buyer-chrome sheet (apps/storefront lib/extensions files.ts
 * `buyerChromeSheetPath`): the sheet's `./public/...` URLs resolve against it, so its shape is sealed.
 */
export const BUYER_CHROME_SHEET_PATH = "/_buyer-chrome/{app}/{release}/c{checker}/{sha256}.css";


/**
 * One signature the delivery scheme makes (`signWebhookPayload`): the
 * scheme is `t=<unix seconds>,v1=<hex HMAC-SHA256 keyed by the whole secret
 * over "<t>.<raw body>">`. contract-tables.test.ts signs this again; a
 * receiver's verifier is built on it, so it never changes.
 */
export const WEBHOOK_SIGNATURE_VECTOR = {
  secret: "whsec_contract",
  timestamp: 1_767_225_600,
  body: '{"id":"evt_1"}',
  signature: "t=1767225600,v1=3fdcd7d595087653789b28db0cfa1f04448600ce85de5bb605bfcd368e59fafd",
} as const;

const table = (rule: ContractTableRule, value: unknown): ContractTable => ({ rule, value });

/** Every sealed table, by name. */
export function contractTables(): Record<string, ContractTable> {
  return {
    hostCssVariables: table("grow", STOREFRONT_HOST_CSS_VARIABLES),
    hostHooks: table("grow", STOREFRONT_HOST_HOOKS),
    skinHtml: table("grow", STOREFRONT_SKIN_HTML_ALLOW_LIST),
    // A theme's header and footer on a buyer's own page (skins with `buyerPages: true`): the markup the
    // rebuild keeps, the host behaviours it may trigger, the panels a popover is lifted as and the
    // attributes that open and close them, the at-rules its sheet may hold, and the store's path of
    // that sheet (its `./public/...` URLs resolve against it). What the sheet refuses is sealed by its
    // verdicts (buyer-chrome-css.verdicts.json) and its checker's version (buyer-chrome-css.version.json).
    inertMarkup: table("grow", INERT_MARKUP),
    inertBehaviours: table("grow", INERT_BEHAVIOURS),
    buyerChromePanels: table("grow", { kinds: INERT_PANEL_KINDS, opensWith: ["popovertarget"], marks: ["data-panel", "data-menu-drawer"], hostHooks: ["data-buyer-panel-open", "data-buyer-panel-close"] }),
    buyerChromeCssAtRules: table("grow", BUYER_CHROME_CSS_AT_RULES),
    buyerChromePath: table("grow", BUYER_CHROME_SHEET_PATH),
    delivery: table("grow", {
      headers: { eventId: WEBHOOK_EVENT_ID_HEADER, topic: WEBHOOK_TOPIC_HEADER, apiVersion: WEBHOOK_API_VERSION_HEADER, signature: WEBHOOK_SIGNATURE_HEADER },
      secretPrefix: WEBHOOK_SECRET_PREFIX,
      signatureToleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      signatureVector: WEBHOOK_SIGNATURE_VECTOR,
    }),
    limits: table("loosen", appSealedLimits()),
    storeWords: table("refuse", STORE_ACTION_AND_AMOUNT_WORDS),
    storeWordSlots: table("refuse", STORE_WORD_SLOT_PATTERNS),
    storeWordKinds: table("refuse", Object.fromEntries(Object.entries(STORE_WORD_LABEL_KINDS).map(([kind, scope]) => [kind, scope.reach]))),
    // A kind's own words are exemptions: they only grow.
    storeWordOwn: table("grow", Object.fromEntries(Object.entries(STORE_WORD_LABEL_KINDS).map(([kind, scope]) => [kind, "own" in scope ? scope.own : []]))),
    storeWordsReason: table("grow", STORE_WORDS_REASON),
    themeLabelAmountWords: table("refuse", PRIVATE_LABEL_AMOUNT_WORDS),
    // What a stored landing page's handle is read against (read-lists.test.ts): a new handle or a wider form fails a stored theme's read.
    landingHandlesNeverValid: table("refuse", [...LANDING_HANDLES_NEVER_VALID].sort()),
    marketSubfolderPattern: table("refuse", MARKET_SUBFOLDER_PATTERN.source),
    // Which routes each private page key reaches, the store's look and no theme at all (private-keys.ts): a key never starts or stops reaching a route.
    privateRoutes: table("fixed", { ...PRIVATE_PAGE_ROUTES, "store-look": PRIVATE_STORE_LOOK_ROUTES, "no-theme": PRIVATE_UNTHEMED_ROUTES }),
    // What the store draws over an app's label that passed for its word (function-words.ts).
    neutralWords: table("grow", { addOn: { en: LINE_ENTRY_WORDS_EN.lineAddOnText, bn: LINE_ENTRY_WORDS_BN.lineAddOnText }, discount: STORE_ACTION_AND_AMOUNT_WORDS.discountText }),
  };
}
