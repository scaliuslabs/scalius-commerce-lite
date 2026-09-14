/**
 * Resolves where same-origin proxy routes send API requests.
 *
 * Production: the BACKEND_API service binding with the fixed internal origin.
 * Local `astro dev`: each Worker runs in its own miniflare process, so the
 * binding cannot reach the API; plain HTTP to the fixed local API port is used
 * instead. There is no public-URL fallback: a production Worker without the
 * binding fails closed.
 */
import { env as cfEnv } from "cloudflare:workers";
import {
  INTERNAL_SERVICE_ORIGIN,
  LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
} from "@scalius/shared/platform-config";

export interface BackendTarget {
  /** Absolute URL to request. */
  url: string;
  /** Transport bound to the target; honors a stubbed global fetch in tests. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  viaServiceBinding: boolean;
}

/** The BACKEND_API binding from the Worker env, or undefined outside Wrangler. */
export function readBackendApiBinding(): Fetcher | undefined {
  try {
    const binding = (cfEnv as Partial<Env> | null | undefined)?.BACKEND_API;
    return binding && typeof binding.fetch === "function" ? binding : undefined;
  } catch {
    // Local Astro development can run without Wrangler bindings.
    return undefined;
  }
}

export function resolveBackendTarget(
  apiPath: string,
  backendApi: Fetcher | undefined = readBackendApiBinding(),
): BackendTarget | null {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (import.meta.env.DEV) {
    return {
      url: `${LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl}${path}`,
      fetch: (input, init) => fetch(input, init),
      viaServiceBinding: false,
    };
  }
  if (!backendApi) return null;
  return {
    url: `${INTERNAL_SERVICE_ORIGIN}${path}`,
    fetch: (input, init) => backendApi.fetch(input, init),
    viaServiceBinding: true,
  };
}
