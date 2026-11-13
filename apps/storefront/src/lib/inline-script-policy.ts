/**
 * Every inline script the storefront's own code can emit, and their hashes:
 * the `script-src` of every page policy (middleware-helper/csp-handler.ts).
 *
 * An inline script is constant code. A value it needs rides on its own
 * element (`document.currentScript`) or in a JSON block beside it
 * (components/WindowGlobals.astro), never in its code, so the set below is
 * fixed per build and the policy is known before the page body is rendered,
 * streamed or cached. A function that builds a script from a value is listed
 * with each of its few possible results. A script added to a page without
 * being listed here is blocked by the browser, and the page render test
 * (route-tests/content-security-policy.render.test.ts) fails.
 *
 * The store's own analytics snippets are not here: their hashes come from the
 * saved settings, per request (lib/analytics-csp.ts).
 */
import { cspHashSource } from "@scalius/shared/http-security";
import { CONSENT_REGIMES } from "@scalius/shared/tracking-consent";
import islandScript from "astro/runtime/server/astro-island.prebuilt.js";
import islandScriptDev from "astro/runtime/server/astro-island.prebuilt-dev.js";
import loadDirective from "astro/runtime/client/load.prebuilt.js";
import { CART_COLUMN_PLACE_SCRIPT, CART_EARLY_CONTROLS_SCRIPT, CART_FIRST_PAINT_SCRIPT, CART_LOADING_LINES_SCRIPT, CART_PICKUP_CHOICE_SCRIPT, CART_QUICK_BUY_NOTICE_SCRIPT, CART_SUMMARY_FOLD_SCRIPT } from "./cart/cart-page-scripts";
import { CATALOG_SHELF_VIEW_RESTORE_SCRIPT, CATALOG_VIEW_RESTORE_SCRIPT } from "./catalog-paging";
import { colorSchemeBootScript } from "./color-scheme";
import {
  ACCOUNT_WORKSPACE_MEASURE_SCRIPT,
  AD_CLICK_ID_SCRIPT,
  CHECKOUT_FIRST_PAINT_SCRIPT,
  FOOTER_MENU_FOLD_SCRIPT,
  GIFT_CARD_EARLY_APPLY_SCRIPT,
  HOMEPAGE_PHONE_REORDER_SCRIPT,
  REACT_REFRESH_PREAMBLE,
  SIGNED_IN_HINT_SCRIPT,
  SKIN_CHOICE_PREPAINT_SCRIPT,
  STALE_ASSET_RECOVERY_SCRIPT,
  URL_TOKEN_SCRUB_SCRIPT,
  VARIANT_PREPAINT_SCRIPT,
  WINDOW_GLOBALS_SCRIPT,
} from "./inline-boot-scripts";
import { PARTYTOWN_BOOTSTRAP_SCRIPT } from "./partytown-config";
import { RECENTLY_VIEWED_RECORD_SCRIPT, RECENTLY_VIEWED_RENDER_SCRIPT } from "./recently-viewed";
import { LIBRARY_PREVIEW_SCRIPT } from "./theme-preview-library";
import { THEME_PREVIEW_BRIDGE_SCRIPT } from "./theme-preview-bridge";
import { CONSENT_RUNTIME_SCRIPT, consentBootScript } from "@/components/consent/consent-scripts";

/** The `client:` directives the storefront's islands use; each adds Astro's directive script. */
export const ISLAND_DIRECTIVES = ["load"] as const;

const BOOLEANS = [true, false] as const;

/** Every inline script the storefront's own code can emit (the dev-only ones under `astro dev`). */
export function storefrontInlineScripts(development = import.meta.env.DEV): string[] {
  return [
    AD_CLICK_ID_SCRIPT,
    STALE_ASSET_RECOVERY_SCRIPT,
    VARIANT_PREPAINT_SCRIPT,
    SKIN_CHOICE_PREPAINT_SCRIPT,
    SIGNED_IN_HINT_SCRIPT,
    WINDOW_GLOBALS_SCRIPT,
    HOMEPAGE_PHONE_REORDER_SCRIPT,
    ACCOUNT_WORKSPACE_MEASURE_SCRIPT,
    URL_TOKEN_SCRUB_SCRIPT,
    CHECKOUT_FIRST_PAINT_SCRIPT,
    GIFT_CARD_EARLY_APPLY_SCRIPT,
    FOOTER_MENU_FOLD_SCRIPT,
    CART_FIRST_PAINT_SCRIPT,
    CART_EARLY_CONTROLS_SCRIPT,
    CART_QUICK_BUY_NOTICE_SCRIPT,
    CART_LOADING_LINES_SCRIPT,
    CART_PICKUP_CHOICE_SCRIPT,
    CART_COLUMN_PLACE_SCRIPT,
    CART_SUMMARY_FOLD_SCRIPT,
    CATALOG_SHELF_VIEW_RESTORE_SCRIPT,
    CATALOG_VIEW_RESTORE_SCRIPT,
    RECENTLY_VIEWED_RECORD_SCRIPT,
    RECENTLY_VIEWED_RENDER_SCRIPT,
    PARTYTOWN_BOOTSTRAP_SCRIPT,
    THEME_PREVIEW_BRIDGE_SCRIPT,
    LIBRARY_PREVIEW_SCRIPT,
    CONSENT_RUNTIME_SCRIPT,
    ...CONSENT_REGIMES.flatMap((regime) => BOOLEANS.map((google) => consentBootScript(regime, { google }))),
    ...BOOLEANS.flatMap((toggle) => BOOLEANS.map((remember) => colorSchemeBootScript({ scheme: "system", toggle }, remember))),
    // Astro's island runtime (its development build where Node runs Astro in development) and the directives the islands use.
    islandScript,
    islandScriptDev,
    loadDirective,
    ...(development ? [REACT_REFRESH_PREAMBLE] : []),
  ].filter(Boolean);
}

let hashes: Promise<string[]> | null = null;

/** The hash sources of every listed inline script, computed once per isolate. */
export function storefrontInlineScriptHashes(): Promise<string[]> {
  hashes ??= Promise.all(storefrontInlineScripts().map(cspHashSource)).then((sources) => [...new Set(sources)]);
  return hashes;
}
