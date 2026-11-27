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
//            their slot patterns, the label kinds' reach and the theme's
//            amount words. A new member refuses an app or theme that passes
//            today, so after the lock it is a security entry, never growth.
//
// A table's rule is part of what is sealed: changing it is a break too.
import { WEBHOOK_API_VERSION_HEADER, WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SECRET_PREFIX, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS, WEBHOOK_TOPIC_HEADER } from "../events";
import { LINE_ENTRY_WORDS_BN, LINE_ENTRY_WORDS_EN } from "../line-entry-words";
import { STORE_ACTION_AND_AMOUNT_WORDS, STORE_WORD_LABEL_KINDS, STORE_WORD_SLOT_PATTERNS, STORE_WORDS_REASON } from "../store-words";
import { growOnlyBreaks, loosenOnlyBreaks, refusalListBreaks, type SealedLimit } from "../contract/rules";
import { STOREFRONT_HOST_CSS_VARIABLES, STOREFRONT_HOST_HOOKS } from "../storefront-theme/host-contract";
import { PRIVATE_LABEL_AMOUNT_WORDS } from "../storefront-theme/private-layout";
import { appSealedLimits } from "./app-limits";
import { STOREFRONT_SKIN_HTML_ALLOW_LIST } from "./html";

export type ContractTableRule = "grow" | "loosen" | "refuse";
export interface ContractTable {
  rule: ContractTableRule;
  value: unknown;
}

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
    // HOOK (buyer-page chrome): when plugins/inert-html.ts lands, seal its allow-list here the same way:
    //   inertHtml: table("grow", STOREFRONT_INERT_HTML_ALLOW_LIST),
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
    // What the store draws over an app's label that passed for its word (function-words.ts).
    neutralWords: table("grow", { addOn: { en: LINE_ENTRY_WORDS_EN.lineAddOnText, bn: LINE_ENTRY_WORDS_BN.lineAddOnText }, discount: STORE_ACTION_AND_AMOUNT_WORDS.discountText }),
  };
}

/** The breaking changes between two sealed table sets: none leaves, none changes its rule, each moves only as its rule allows. */
export function contractTableBreaks(before: unknown, after: unknown): string[] {
  const was = (before ?? {}) as Record<string, ContractTable>;
  const now = (after ?? {}) as Record<string, ContractTable>;
  return Object.entries(was).flatMap(([name, entry]) => {
    const next = now[name];
    const path = `tables.${name}`;
    if (!next) return [`${path}: the table was removed.`];
    if (next.rule !== entry.rule) return [`${path}: its rule changed from ${entry.rule} to ${next.rule}.`];
    if (entry.rule === "loosen") return loosenOnlyBreaks(path, entry.value as Record<string, SealedLimit>, next.value as Record<string, SealedLimit>);
    if (entry.rule === "refuse") return refusalListBreaks(path, entry.value, next.value);
    return growOnlyBreaks(path, entry.value, next.value);
  });
}
