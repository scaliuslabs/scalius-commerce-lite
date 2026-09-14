/**
 * Builds the per-request ApiContext seeded by the middleware.
 *
 * Secrets: API_TOKEN and PURGE_TOKEN are derived from SCALIUS_SECRET on every
 * request (HKDF is cheap; nothing is retained in module globals).
 * Origins: fetched from the API's public /api/v1/platform endpoint through the
 * service binding (local dev: HTTP to the fixed local API port). The API
 * KV-caches that response, so the read is one bounded sub-request. Nothing is
 * cached here across requests. When the read fails, no API URL is seeded and
 * API callers fail closed; the storefront origin falls back to the request
 * origin so discovery output stays absolute.
 */
import {
  mediaHostFromUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
  PLATFORM_CONFIG_PUBLIC_PATH,
  publicRequestOrigin,
} from "@scalius/shared/platform-config";
import {
  deriveRuntimeSecret,
  readMasterSecret,
  RUNTIME_SECRET_PURPOSES,
  type MasterSecretEnvironment,
} from "@scalius/shared/runtime-secrets";

import { resolveBackendTarget } from "./backend-target";
import type { ApiContext } from "./context";

export const PLATFORM_CONFIG_FETCH_TIMEOUT_MS = 1_500;

export interface RequestContextEnv extends MasterSecretEnvironment {
  BACKEND_API?: Fetcher;
}

interface PublicPlatformOrigins {
  storefrontUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlatformEnvelope(payload: unknown): PublicPlatformOrigins | null {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  return {
    storefrontUrl: normalizePlatformOriginUrl(data.storefrontUrl),
    apiUrl: normalizePlatformOriginUrl(data.apiUrl),
    dashboardUrl: normalizePlatformOriginUrl(data.dashboardUrl),
    mediaUrl: normalizeMediaBaseUrl(data.mediaUrl),
  };
}

async function fetchPlatformOrigins(
  env: RequestContextEnv | null | undefined,
): Promise<PublicPlatformOrigins | null> {
  const target = resolveBackendTarget(PLATFORM_CONFIG_PUBLIC_PATH, env?.BACKEND_API);
  if (!target) return null;
  try {
    const response = await target.fetch(target.url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PLATFORM_CONFIG_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parsePlatformEnvelope(await response.json());
  } catch {
    return null;
  }
}

async function deriveRequestSecrets(
  env: RequestContextEnv | null | undefined,
): Promise<Pick<ApiContext, "API_TOKEN" | "PURGE_TOKEN">> {
  const master = readMasterSecret(env);
  if (!master) return {};
  const [API_TOKEN, PURGE_TOKEN] = await Promise.all([
    deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.API_TOKEN),
    deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.PURGE_TOKEN),
  ]);
  return { API_TOKEN, PURGE_TOKEN };
}

function optional(value: string | null | undefined): string | undefined {
  return value || undefined;
}

export async function createRequestApiContext(
  request: Request,
  env: RequestContextEnv | null | undefined,
): Promise<ApiContext> {
  const [platform, secrets] = await Promise.all([
    fetchPlatformOrigins(env),
    deriveRequestSecrets(env),
  ]);
  const apiUrl = optional(platform?.apiUrl);
  const mediaUrl = optional(platform?.mediaUrl);

  return {
    BACKEND_API: env?.BACKEND_API,
    STOREFRONT_URL: optional(platform?.storefrontUrl) ?? optional(publicRequestOrigin(request.url)),
    PUBLIC_API_BASE_URL: apiUrl,
    PUBLIC_API_URL: apiUrl ? `${apiUrl}/api/v1` : undefined,
    DASHBOARD_URL: optional(platform?.dashboardUrl),
    MEDIA_URL: mediaUrl,
    CDN_DOMAIN_URL: mediaUrl ? optional(mediaHostFromUrl(mediaUrl)) : undefined,
    ...secrets,
    inflightReads: new Map<string, Promise<unknown>>(),
    apiJwt: { token: null, expiresAt: null, refresh: null },
  };
}
