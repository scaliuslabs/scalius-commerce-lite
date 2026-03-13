import { env as cfEnv } from "cloudflare:workers";

/**
 * Safely extracts the storefront URL from the Cloudflare environment
 * or Vite build-time env vars.
 *
 * Uses `import { env } from 'cloudflare:workers'` for Cloudflare Workers,
 * then falls back to import.meta.env for standard Astro dev setups.
 */
export function getRuntimeStorefrontUrl(): string {
    let workerUrl: string | undefined;
    try {
        const env = cfEnv as unknown as Env;
        workerUrl = env?.STOREFRONT_URL as string | undefined;
    } catch {
        // Not running in Cloudflare Workers
    }

    const envUrl = workerUrl || import.meta.env.STOREFRONT_URL || '';
    return envUrl.replace(/\/$/, '');
}
