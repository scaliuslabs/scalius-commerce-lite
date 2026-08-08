/**
 * Transport-agnostic SDK client factory.
 *
 * Two modes:
 * - Service Binding: Worker-to-Worker requests through a caller-provided binding
 * - HTTP: standard fetch for local development and first-party consumers
 */
import { createClient, createConfig, type Client, type Config } from "./generated/client";

interface ServiceBindingOptions {
  /** Cloudflare Service Binding-compatible fetcher. */
  serviceBinding: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  /** Headers accepted by the target operation; the factory does not mint credentials. */
  headers?: Record<string, string>;
}

interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

/**
 * Create an SDK client routed through a Cloudflare Service Binding.
 * Authentication remains the caller's responsibility.
 */
export function createServiceBindingClient(options: ServiceBindingOptions): Client {
  return createClient(
    createConfig({
      baseUrl: "https://api.internal",
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
