import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";

/**
 * Stable issue codes from `NAVIGATION_READINESS_CODES`
 * (packages/core/src/modules/settings/site-settings.service.ts). Every screen
 * matches on these codes instead of the API's merchant copy, so wording can
 * change without breaking the header/footer editors.
 */
export const NAVIGATION_READINESS_CODES = {
  legacyNormalized: "navigation.legacy_normalized",
  invalid: "navigation.invalid",
} as const;

function hasIssue(
  readiness: NavigationConfigSectionReadiness | undefined,
  code: string,
): boolean {
  return (readiness?.issues ?? []).some((issue) => issue.code === code);
}

/** The saved section could not be read, so editing must stay locked. */
export function isNavigationConfigUnreadable(
  readiness?: NavigationConfigSectionReadiness,
): boolean {
  return hasIssue(readiness, NAVIGATION_READINESS_CODES.invalid);
}

/** Legacy links were converted in memory and need one explicit save. */
export function navigationConfigNeedsNormalizationSave(
  readiness?: NavigationConfigSectionReadiness,
): boolean {
  return hasIssue(readiness, NAVIGATION_READINESS_CODES.legacyNormalized);
}
