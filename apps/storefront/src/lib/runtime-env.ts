import type { APIContext } from "astro";

/**
 * Safely extracts the storefront URL from the Cloudflare environment
 * or Node environment vars during the Astro build/runtime.
 *
 * It checks locals.runtime.env first for Cloudflare Workers compatibility,
 * then falls back to import.meta.env for Node or standard Astro dev setups.
 */
export function getRuntimeStorefrontUrl(locals: APIContext['locals']): string {
    const envUrl =
        (locals.runtime?.env?.STOREFRONT_URL as string) ||
        import.meta.env.STOREFRONT_URL ||
        '';

    return envUrl.replace(/\/$/, '');
}
