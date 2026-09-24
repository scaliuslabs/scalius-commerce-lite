/**
 * Public API URL for plain browser `fetch` calls. Buyer pages use this instead
 * of the SSR transport (`transport.ts`), which would pull the generated SDK
 * client into every page bundle. Layout.astro injects `__API_BASE_URL__`, and
 * the page's CSP allows exactly that origin, so there is no other origin to
 * fall back to: a page rendered without it (the API was down) fails the call
 * and the caller shows its "try again" message.
 */
export function browserApiUrl(path: string): string {
  const base = window.__API_BASE_URL__;
  if (!base) {
    throw new Error(
      "PUBLIC_API_URL is not configured. Set the API URL in the dashboard under Settings -> System -> Platform.",
    );
  }
  return `${base}${path}`;
}
