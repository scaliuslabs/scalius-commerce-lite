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
  };
}
