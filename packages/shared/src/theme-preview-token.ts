/** Cookie-only theme preview bearer shape. Browser routes must never accept it
 * from a URL, form, message channel, or JSON body. */
export function isThemePreviewToken(value: unknown): value is string {
  return typeof value === "string" && /^tpv_[A-Za-z0-9_-]{48}$/.test(value);
}
