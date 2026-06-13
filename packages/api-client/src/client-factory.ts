/**
 * Transport-agnostic SDK client factory.
 *
 * Two modes:
 * - Service Binding: zero-latency RPC inside Cloudflare Workers (admin env.API, storefront env.BACKEND_API)
 * - HTTP: standard fetch for dev mode or external consumers
 */
import { createClient, createConfig, type Client, type Config } from "./generated/client";

interface ServiceBindingOptions {
  /** Cloudflare Service Binding (env.API or env.BACKEND_API) */
  serviceBinding: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  headers?: Record<string, string>;
}

interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

/**
 * Create an SDK client routed through a Cloudflare Service Binding.
 * Used by admin (env.API) and storefront (env.BACKEND_API) in production.
 */
export function createServiceBindingClient(options: ServiceBindingOptions): Client {
  return createClient(
    createConfig({
      baseUrl: "http://api.internal",
      headers: options.headers,
      fetch: (input, init) => options.serviceBinding.fetch(input, init),
    }),
  );
}

/**
 * Create an SDK client using standard HTTP fetch.
 * Used in dev mode and by external consumers.
 */
export function createHttpClient(options: HttpOptions): Client {
  return createClient(
    createConfig({
      baseUrl: options.baseUrl,
      headers: options.headers,
    }),
  );
}

export { createClient, createConfig };
export type { Client, Config, ServiceBindingOptions, HttpOptions };
