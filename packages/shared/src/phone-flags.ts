// src/phone-flags.ts
// Resolves the flag icon URL for react-phone-number-input.
// Uses the deployer's CDN domain if configured, falls back to the
// library's default GitHub-hosted flags.

const GITHUB_DEFAULT = "https://purecatamphetamine.github.io/country-flag-icons/3x2/{XX}.svg";

/**
 * Get the flagUrl for react-phone-number-input's PhoneInput component.
 *
 * If a CDN domain is available (from wrangler.jsonc `CDN_DOMAIN_URL`),
 * flags are served from `https://{cdn}/flags/{XX}.svg` — fast, edge-cached,
 * no external dependency.
 *
 * If no CDN is configured, falls back to the library's default GitHub Pages
 * URL. This ensures the component works out of the box for new deployments
 * without any configuration.
 *
 * @param cdnDomain - The CDN domain (e.g., "cloud.scalius.com") or empty/undefined
 */
export function getFlagUrl(cdnDomain?: string | null): string {
  if (cdnDomain) {
    const domain = cdnDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${domain}/flags/{XX}.svg`;
  }
  return GITHUB_DEFAULT;
}
