// How the app-component host reaches the API: the BACKEND_API service
// binding on a deployed Worker, and plain HTTP to this stack's API port under
// `astro dev` (scripts/dev-ports.mjs), the same rule as lib/api/transport.ts
// (which the gateway does not load). A dev stack on its own ports has no
// service binding to its API, so the binding alone would leave uploaded
// apps' parts unreadable locally.

import { INTERNAL_SERVICE_ORIGIN } from "@scalius/shared/platform-config";

/** `astro dev` only: this stack's API origin (a Vite define), else null. */
function devApiOrigin(): string | null {
  if (!import.meta.env.DEV) return null;
  return typeof __SCALIUS_DEV_API_ORIGIN__ === "string" && __SCALIUS_DEV_API_ORIGIN__ ? __SCALIUS_DEV_API_ORIGIN__ : null;
}

/** One API request (`path` starts with /api/v1), or null when this Worker cannot reach the API. */
export function backendFetch(env: { BACKEND_API?: Fetcher }, path: string, init?: RequestInit): Promise<Response> | null {
  const dev = devApiOrigin();
  if (dev) return fetch(new Request(`${dev}${path}`, init));
  if (!env.BACKEND_API) return null;
  return env.BACKEND_API.fetch(new Request(`${INTERNAL_SERVICE_ORIGIN}${path}`, init));
}
