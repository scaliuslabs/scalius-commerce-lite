import type { SafeHtml } from "@scalius/shared/html-sanitize";

/**
 * The one way the dashboard inserts HTML (`dangerouslySetInnerHTML`): only
 * what sanitizeHtml wrote (scripts/check-source-policies.mjs).
 */
export function innerHtml(html: SafeHtml): { __html: string } {
  return { __html: html };
}
