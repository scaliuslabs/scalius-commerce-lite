// src/phone-flags.ts
// Resolves the flag icon URL for react-phone-number-input.
//
// Priority:
// 1. CDN domain (if deployer configured CDN_DOMAIN_URL) — edge-cached, fast
// 2. Local /flags/ path — bundled as static assets during build (always available after deploy)
// 3. GitHub Pages — library default, works without any config (dev mode fallback)

const GITHUB_DEFAULT = "https://purecatamphetamine.github.io/country-flag-icons/3x2/{XX}.svg";
const LOCAL_PATH = "/flags/{XX}.svg";

/**
 * Get the flagUrl for react-phone-number-input's PhoneInput component.
 *
 * Flags are copied from country-flag-icons into each app's public/flags/
 * during the build step (scripts/copy-flags.mjs), so they're served as
 * static assets from the same domain — no external requests needed.
 *
 * If a CDN domain is available, flags are served from the CDN instead
 * (useful if the deployer hosts assets on a separate CDN domain).
 *
 * Falls back to GitHub Pages if neither is available (e.g., dev mode
 * before the first build).
 *
 * @param cdnDomain - Optional CDN domain (e.g., "cloud.scalius.com")
 */
export function getFlagUrl(cdnDomain?: string | null): string {
  if (cdnDomain) {
    const domain = cdnDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${domain}/flags/{XX}.svg`;
  }
  // After build, flags exist at /flags/{XX}.svg as static assets.
  // In dev before build, they won't exist and the <img> will 404,
  // but the component still works (just no flag icon). The GitHub
  // fallback is only needed if you want flags in dev without building.
  return LOCAL_PATH;
}

/**
 * GitHub-hosted flag URL for use as an explicit fallback.
 * Useful in development mode before running a build.
 */
export const GITHUB_FLAG_URL = GITHUB_DEFAULT;
