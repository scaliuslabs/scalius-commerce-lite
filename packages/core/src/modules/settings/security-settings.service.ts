// src/modules/settings/security-settings.service.ts
// The merchant-managed storefront CSP allow-list.
//
// The stored row and the KV mirror stay a bare comma-separated source list:
// the storefront CSP handler and the Partytown proxy read that KV key
// directly, so the raw codec keeps both byte-identical while storage,
// validation, cache, and invalidation are declared once.

import { z } from "zod";
import {
  defineSettingsDocument,
  rawStringSettingsCodec,
} from "./settings-store";

export const SECURITY_SETTINGS_CATEGORY = "security";
export const CSP_ALLOWED_DOMAINS_SETTING_KEY = "csp_allowed_domains";

/** KV key holding the merchant-managed CSP sources saved from the dashboard. */
export const CSP_ALLOWED_DOMAINS_CACHE_KEY = "security:csp_allowed_domains";

export interface SecuritySettings extends Record<string, unknown> {
  /** Comma-separated merchant CSP sources, exactly as the readers expect. */
  cspAllowedDomains: string;
}

/**
 * The mirror is written without an expiration: it is the read path for the
 * storefront CSP handler and the Partytown proxy, and a save rewrites it.
 */
export const securitySettingsDocument = defineSettingsDocument<SecuritySettings>({
  category: SECURITY_SETTINGS_CATEGORY,
  key: CSP_ALLOWED_DOMAINS_SETTING_KEY,
  label: "storefront security policy",
  schema: z.object({ cspAllowedDomains: z.string() }),
  defaults: { cspAllowedDomains: "" },
  codec: rawStringSettingsCodec("cspAllowedDomains"),
  cache: { key: CSP_ALLOWED_DOMAINS_CACHE_KEY, ttlSeconds: 0 },
  invalidationGroups: ["layout"],
});
