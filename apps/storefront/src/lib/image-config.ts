/**
 * Image Configuration
 * Reads CDN_DOMAIN_URL from wrangler.jsonc vars (the single source of truth).
 * Falls back to process.env for backwards compatibility.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse CDN domains from wrangler.jsonc vars or process.env.
 */
const getCdnDomains = (): string[] => {
  // Try process.env first (manual override)
  let cdnDomainUrl = process.env.CDN_DOMAIN_URL;

  // Read from wrangler.jsonc if not in process.env
  if (!cdnDomainUrl) {
    try {
      const wranglerPath = resolve(process.cwd(), 'wrangler.jsonc');
      const raw = readFileSync(wranglerPath, 'utf-8');
      // Strip JSONC comments (// style) for JSON.parse
      const json = raw.replace(/^\s*\/\/.*$/gm, '');
      const config = JSON.parse(json);
      cdnDomainUrl = config.vars?.CDN_DOMAIN_URL;
    } catch {
      // Silently fall through
    }
  }

  if (!cdnDomainUrl) {
    return ['cdn.scalius.com'];
  }

  const domains = cdnDomainUrl
    .split(',')
    .map((domain: string) => domain.trim())
    .filter((domain: string) => domain.length > 0);

  return domains.length > 0 ? domains : ['cdn.scalius.com'];
};

// Capture CDN domains at build time
export const CDN_DOMAINS = getCdnDomains();

/**
 * Complete Astro image configuration object
 */
export const imageConfig = {
  // Allowed domains for image optimization
  domains: CDN_DOMAINS,


  // Cache calculated dimensions to improve performance
  remotePatterns: [{ protocol: "https" as const }],
};

/**
 * Export individual parts for flexibility
 */
export { getCdnDomains };
