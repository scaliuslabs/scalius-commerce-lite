// The limits an app is built against, as one sealed table (the plugin
// protocol seal, contract-tables.ts): each with the way it may move. A
// maximum, a budget or a size only rises; a minimum only falls. A limit that
// tightens refuses or cuts an app that works today, so it is a security
// change or a new contract version, never a routine release. The numbers stay
// where they are defined (each module owns its own); this file only names
// them, plus the two checkout budgets the API runs functions under.
import { PLAN_LIMITS, type WorkersPlan } from "../plan-limits";
import { PLUGIN_UI_LIMITS } from "./ui";
import { BUYER_UI_BLOCKS_MAX, BUYER_UI_LINES_MAX_BYTES, BUYER_UI_RESPONSE_MAX_BYTES, CHECKOUT_ATTRIBUTES_MAX_BYTES } from "./buyer-ui";
import { PLUGIN_PAGE_PROPS_MAX_BYTES } from "./storefront";
import { FUNCTION_READ_BYTES_MAX, FUNCTION_READ_KEYS_PER_READ_MAX, FUNCTION_READS_MAX } from "./function-reads";
import { OBJECT_OPERATION_RESPONSE_MAX_BYTES, OBJECT_RECORD_MAX_BYTES } from "./objects";
import { PLUGIN_JOB_INPUT_MAX_BYTES, PLUGIN_JOB_STATE_MAX_BYTES } from "./jobs";
import { PLUGIN_MESSAGE_LIMITS } from "./messaging";
import { PROVIDER_CHECKOUT_DEADLINE_MS } from "./provider-deadline";
import { PLUGIN_UPLOAD_READ_MAX_BYTES } from "./uploads";
import { STOREFRONT_APP_TEMPLATE_MAX_BYTES } from "./storefront-components";
import { STOREFRONT_SKIN_HTML_BOUNDS } from "./html";
import { PLUGIN_PACKAGE_FILE_MAX_BYTES, PLUGIN_PACKAGE_MAX_BYTES, PLUGIN_PACKAGE_MAX_ENTRIES } from "./package-limits";
import { BUYER_CHROME_FRAME_MAX_SVH } from "./buyer-chrome-frame";
import { INERT_MARKUP_MAX_BYTES } from "./inert-html";
import { PRIVATE_COMPILED_CSS_MAX_BYTES, PRIVATE_LAYOUT_MAX_DEPTH, PRIVATE_WORDS_LIMITS } from "../storefront-theme/private-schema";
import { PRIVATE_CONTRAST_FLOOR, PRIVATE_EDGE_MIN_WIDTH, PRIVATE_MARK_CONTRAST_FLOOR, PRIVATE_TOKEN_LIMITS } from "../storefront-theme/private-tokens";
import { STOREFRONT_MOBILE_TAB_LIMITS } from "../storefront-theme/blocks";
import { PRIVATE_TAB_BAR_LIMITS } from "../storefront-theme/private-tab-bar";
import { STOREFRONT_MAX_SECTIONS, STOREFRONT_PAGE_SLIDE_PRODUCTS_LIMIT } from "../storefront-theme/sections";
import { STOREFRONT_MAX_LANDING_PAGES } from "../storefront-theme/pages";
import { STOREFRONT_THEME_TRANSLATION_LIMITS } from "../storefront-theme/text";
import { WEBHOOK_TOPICS_MAX } from "../events";
import type { SealedLimit } from "../contract/rules";

/** Functions sit on checkout's path: their wall time is capped below the manifest's (ms). */
export const PLUGIN_FUNCTION_WALL_MS = 1_500;

/**
 * What one checkout request may spend on apps across all its points, end to end
 * (ms). A buyer reviewing a total waits for it on top of the platform's own work:
 * one slow app can still use its own cap (`PLUGIN_FUNCTION_WALL_MS`) and the
 * rest share what is left. Far inside the Worker's own limits (no wall limit on
 * a request, 30 s after the response).
 */
export const CHECKOUT_APP_BUDGET_MS = 3_000;

const up = (value: number | null): SealedLimit => ({ value, loosens: "up" });
/** A floor a theme must reach (a contrast ratio, a border's width): it loosens as it falls. */
const down = (value: number | null): SealedLimit => ({ value, loosens: "down" });

/** The numbers a theme is saved against: its private pages' tokens, words and compiled look, the contrast floors, its sections and tabs. */
function themeLimits(): Record<string, SealedLimit> {
  return {
    ...Object.fromEntries(Object.entries(PRIVATE_TOKEN_LIMITS).map(([name, value]) => [`theme.privateTokens.${name}`, up(value)])),
    ...Object.fromEntries(Object.entries(PRIVATE_WORDS_LIMITS).map(([name, value]) => [`theme.privateWords.${name}`, up(value)])),
    "theme.privateCompiledCssBytes": up(PRIVATE_COMPILED_CSS_MAX_BYTES),
    "theme.privateLayoutDepth": up(PRIVATE_LAYOUT_MAX_DEPTH),
    "theme.contrastFloor": down(PRIVATE_CONTRAST_FLOOR),
    "theme.markContrastFloor": down(PRIVATE_MARK_CONTRAST_FLOOR),
    "theme.edgeMinWidth": down(PRIVATE_EDGE_MIN_WIDTH),
    // The phone tab bar's look: what a blurred bar lets through, a label's floor, the current tab's cues (each a floor).
    ...Object.fromEntries(Object.entries(PRIVATE_TAB_BAR_LIMITS).map(([name, value]) => [`theme.tabBar.${name}`, down(value)])),
    "theme.mobileTabs.max": up(STOREFRONT_MOBILE_TAB_LIMITS.max),
    "theme.mobileTabs.min": down(STOREFRONT_MOBILE_TAB_LIMITS.min),
    "theme.mobileTabs.label": up(STOREFRONT_MOBILE_TAB_LIMITS.label),
    "theme.sections": up(STOREFRONT_MAX_SECTIONS),
    "theme.landingPages": up(STOREFRONT_MAX_LANDING_PAGES),
    "theme.slideProducts": up(STOREFRONT_PAGE_SLIDE_PRODUCTS_LIMIT),
    ...Object.fromEntries(Object.entries(STOREFRONT_THEME_TRANSLATION_LIMITS).map(([name, value]) => [`theme.translations.${name}`, up(value as number)])),
  };
}

/** One plan's per-app quotas (plan-limits.ts `plugins`, apps.md "Quotas") and the buyer uploads an app may declare. */
function planLimits(plan: WorkersPlan): Record<string, SealedLimit> {
  const limits = PLAN_LIMITS[plan];
  return {
    ...Object.fromEntries(Object.entries(limits.plugins).map(([name, value]) => [`plan.${plan}.${name}`, up(value)])),
    [`plan.${plan}.uploads.maxBytes`]: up(limits.uploads.maxBytes),
    [`plan.${plan}.uploads.maxFiles`]: up(limits.uploads.maxFiles),
  };
}

/** Every sealed limit by name. The storefront component limits are sealed with the protocol's constants (`STOREFRONT_COMPONENT_LIMITS`: they only rise). */
export function appSealedLimits(): Record<string, SealedLimit> {
  return {
    ...planLimits("free"),
    ...planLimits("paid"),
    "functions.wallMs": up(PLUGIN_FUNCTION_WALL_MS),
    "functions.checkoutBudgetMs": up(CHECKOUT_APP_BUDGET_MS),
    "functions.reads": up(FUNCTION_READS_MAX),
    "functions.readKeys": up(FUNCTION_READ_KEYS_PER_READ_MAX),
    "functions.readBytes": up(FUNCTION_READ_BYTES_MAX),
    "providers.checkoutDeadlineMs": up(PROVIDER_CHECKOUT_DEADLINE_MS),
    ...Object.fromEntries(Object.entries(PLUGIN_UI_LIMITS).map(([name, value]) => [`ui.${name}`, up(value)])),
    "buyerUi.responseBytes": up(BUYER_UI_RESPONSE_MAX_BYTES),
    "buyerUi.lineBlocksBytes": up(BUYER_UI_LINES_MAX_BYTES),
    "buyerUi.blocks": up(BUYER_UI_BLOCKS_MAX),
    "checkout.attributesBytes": up(CHECKOUT_ATTRIBUTES_MAX_BYTES),
    "storefront.pagePropsBytes": up(PLUGIN_PAGE_PROPS_MAX_BYTES),
    "storefront.templateBytes": up(STOREFRONT_APP_TEMPLATE_MAX_BYTES),
    "storefront.htmlAttributeChars": up(STOREFRONT_SKIN_HTML_BOUNDS.attributeValue),
    "storefront.htmlClassTokens": up(STOREFRONT_SKIN_HTML_BOUNDS.classTokens),
    "objects.recordBytes": up(OBJECT_RECORD_MAX_BYTES),
    "objects.responseBytes": up(OBJECT_OPERATION_RESPONSE_MAX_BYTES),
    "jobs.inputBytes": up(PLUGIN_JOB_INPUT_MAX_BYTES),
    "jobs.stateBytes": up(PLUGIN_JOB_STATE_MAX_BYTES),
    ...Object.fromEntries(Object.entries(PLUGIN_MESSAGE_LIMITS).map(([name, value]) => [`messages.${name}`, up(value)])),
    "uploads.readBytes": up(PLUGIN_UPLOAD_READ_MAX_BYTES),
    "package.bytes": up(PLUGIN_PACKAGE_MAX_BYTES),
    "package.fileBytes": up(PLUGIN_PACKAGE_FILE_MAX_BYTES),
    "package.files": up(PLUGIN_PACKAGE_MAX_ENTRIES),
    "webhooks.topics": up(WEBHOOK_TOPICS_MAX),
    ...themeLimits(),
    "buyerChrome.headerMaxSvh": up(BUYER_CHROME_FRAME_MAX_SVH.header),
    "buyerChrome.footerMaxSvh": up(BUYER_CHROME_FRAME_MAX_SVH.footer),
    "buyerChrome.markupBytes": up(INERT_MARKUP_MAX_BYTES),
  };
}
