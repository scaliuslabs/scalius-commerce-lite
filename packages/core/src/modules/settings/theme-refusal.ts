// The one details shape of every theme refusal, shared by the store's theme
// checks (site-settings.service.ts, theme-bindings.ts).
import { ValidationError } from "@scalius/core/errors";
import type { StorefrontThemeSaveIssue, StorefrontThemeSaveReason } from "@scalius/shared/storefront-theme";

/**
 * The one details shape of every theme refusal (a save, a publish, a reference the store does not have): its
 * reason (no key when only words name it) and its first issues, each with its path, words and reason; a refusal
 * that names more (the apps) adds it beside them.
 */
export function themeRefusalDetails(issues: readonly StorefrontThemeSaveIssue[]): { reason?: StorefrontThemeSaveReason; issues: Array<{ path: string; message: string; reason?: StorefrontThemeSaveReason }> } {
  const reason = issues.find((issue) => issue.reason !== null)?.reason;
  return {
    ...(reason ? { reason } : {}),
    // A reason is said where there is one; none is no key (the declared details hold strings only).
    issues: issues.slice(0, 20).map(({ path, message, reason: why }) => ({ path, message, ...(why ? { reason: why } : {}) })),
  };
}

/** A theme refusal as a validation error, in the one details shape (`themeRefusalDetails`). */
export function themeRefusal(message: string, issues: readonly StorefrontThemeSaveIssue[], extra: Record<string, unknown> = {}): ValidationError {
  return new ValidationError(message, { ...themeRefusalDetails(issues), ...extra });
}
