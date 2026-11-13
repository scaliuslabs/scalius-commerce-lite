import type { SafeHtml } from "@scalius/shared/html-sanitize";

/** `T` itself, or `never` when `T` is `any`: an `any` argument then fails to type-check instead of passing silently. */
type NotAny<T> = 0 extends 1 & T ? never : T;

/**
 * The one way the dashboard inserts HTML (`dangerouslySetInnerHTML`): only
 * what sanitizeHtml wrote (scripts/check-source-policies.mjs). The parameter
 * refuses `any` as well as a plain string.
 */
export function innerHtml<T extends SafeHtml>(html: NotAny<T>): { __html: string } {
  return { __html: html };
}
