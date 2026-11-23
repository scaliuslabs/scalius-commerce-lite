// What a store-page setting takes, in one place for the API's schema and the
// dashboard's form. No imports (the dashboard bundle must not pull zod).

/** What a store-page setting takes, in the merchant's words (the API's save message). */
export const STORE_PAGE_RULE = "Use a page on this store, a path such as /pages/protection, not another site's address.";

/** The longest address a url setting takes. */
export const URL_SETTING_MAX = 2048;

/**
 * A page of this store: a path from the root (one leading slash), no host,
 * query or fragment, no `.` or `..` segment, no encoded slash or dot.
 */
export function isStorePagePath(value: string): boolean {
  return value.length <= URL_SETTING_MAX
    && /^\/(?!\/)[^\\\s?#]*$/u.test(value)
    && !value.split("/").some((part) => part === "." || part === "..")
    && !/%(?:2f|5c|2e)/iu.test(value);
}
