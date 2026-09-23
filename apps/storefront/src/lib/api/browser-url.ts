/**
 * Public API URL for plain browser `fetch` calls. Buyer pages use this instead
 * of the SSR transport (`transport.ts`), which would pull the generated SDK
 * client into every page bundle. Layout.astro injects `__API_BASE_URL__`.
 */
export function browserApiUrl(path: string): string {
  const base =
    window.__API_BASE_URL__ ||
    (import.meta.env.DEV ? "http://localhost:8787/api/v1" : "");
  if (!base) {
    throw new Error(
      "PUBLIC_API_URL is not configured. Set the API URL in the dashboard under Settings -> System -> Platform.",
    );
  }
  return `${base}${path}`;
}
