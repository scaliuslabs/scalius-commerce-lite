import { lazy } from "react";
import type { getApiV1AdminSettingsBusiness, getApiV1AdminSettingsPlatform } from "@scalius/api-client/sdk";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { ApiResult } from "~/lib/api";
import { getLocale } from "~/i18n";

// What the Store details cards and their dialogs' fields (StoreSettingsFields,
// loaded right after the page) both read.

export type Business = Omit<ApiResult<typeof getApiV1AdminSettingsBusiness>, "revision">;
export type SocialLink = Business["socialLinks"][number];
export type Platform = Omit<ApiResult<typeof getApiV1AdminSettingsPlatform>, "revision">;

export function useCanEditStore() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

// The collapsible loads when the section is drawn, not with the page's first download.
export const SettingsAdvanced = lazy(() => import("./SettingsAdvanced").then((module) => ({ default: module.SettingsAdvanced })));

export const URL_KEYS = ["storefrontUrl", "dashboardUrl", "apiUrl", "mediaUrl"] as const;
export type UrlKey = (typeof URL_KEYS)[number];
/** What every store sets; the other two are a developer's, behind "Advanced". */
export const MAIN_URL_KEYS = ["storefrontUrl", "dashboardUrl"] as const;
export const ADVANCED_URL_KEYS = ["apiUrl", "mediaUrl"] as const;

export const URL_LABELS = {
  storefrontUrl: ["storeUrl", "storeUrlHelp"],
  dashboardUrl: ["dashboardUrl", "dashboardUrlHelp"],
  apiUrl: ["apiUrl", "apiUrlHelp"],
  mediaUrl: ["mediaUrl", "mediaUrlHelp"],
} as const;

export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}
