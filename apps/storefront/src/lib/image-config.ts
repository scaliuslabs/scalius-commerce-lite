/**
 * Image Configuration
 * Reads CDN_DOMAIN_URL from wrangler.jsonc vars (the single source of truth).
 * process.env.CDN_DOMAIN_URL is accepted as an explicit build-time override
 * for CI and preview builds.
 *
 * This module is imported by astro.config.mjs (Node.js build time) AND may be
 * bundled into the Cloudflare Workers runtime where `node:fs` is unavailable.
 * A runtime guard ensures we only use Node APIs when they exist.
 */

/**
 * Parse CDN domains from process.env or wrangler.jsonc vars.
 */
const getCdnDomains = (): string[] => {
  // Explicit build-time override for CI/preview builds.
  let cdnDomainUrl: string | undefined;

  try {
    cdnDomainUrl = process.env.CDN_DOMAIN_URL;
  } catch {
    // process.env may not exist in Workers runtime
  }

  // Read from wrangler.jsonc only in Node.js (build time) — node:fs is
  // unavailable in Cloudflare Workers and would throw at import time.
  if (
    !cdnDomainUrl &&
    typeof process !== "undefined" &&
    process.versions?.node
  ) {
    try {
      // Dynamic imports so the Workers bundler never sees node:fs statically
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const wranglerPath = path.resolve(process.cwd(), "wrangler.jsonc");
      const raw = fs.readFileSync(wranglerPath, "utf-8");
      // Strip JSONC comments (// style) for JSON.parse
      const json = raw.replace(/^\s*\/\/.*$/gm, "");
      const config = JSON.parse(json);
      cdnDomainUrl = config.vars?.CDN_DOMAIN_URL;
    } catch {
      // Silently fall through — file may not exist or parse may fail
    }
  }

  if (!cdnDomainUrl) {
    return [];
  }

  return cdnDomainUrl
    .split(",")
    .map((domain: string) => domain.trim())
    .filter((domain: string) => domain.length > 0);
};

// Capture CDN domains at build time
export const CDN_DOMAINS = getCdnDomains();

/**
 * Complete Astro image configuration object
 */
export const imageConfig = {
  // Allowed domains for image optimization
  domains: CDN_DOMAINS,
};

/**
 * Export individual parts for flexibility
 */
export { getCdnDomains };
