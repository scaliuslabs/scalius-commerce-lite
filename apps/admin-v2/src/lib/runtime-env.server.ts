/**
 * Request-scoped runtime environment for the dashboard Worker.
 *
 * Wrangler installs only resource bindings plus two secrets
 * (`SCALIUS_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`). `src/server.ts` derives
 * `BETTER_AUTH_SECRET` and resolves the platform origins for every request,
 * then runs the TanStack handler inside `runWithRuntimeEnv`. Every server-side
 * consumer reads that composed env through `getRuntimeEnv()` instead of the
 * raw `cloudflare:workers` module env.
 *
 * Server-only: keep this import inside .server.ts files or server handlers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { env as moduleEnv } from "cloudflare:workers";
import {
  EMPTY_PLATFORM_CONFIG,
  INTERNAL_SERVICE_ORIGIN,
  LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
  PLATFORM_CONFIG_PUBLIC_PATH,
  normalizePlatformConfig,
  withLocalDevelopmentDefaults,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import {
  deriveRuntimeSecretsFromEnv,
  readMasterSecret,
} from "@scalius/shared/runtime-secrets";

const runtimeEnvStorage = new AsyncLocalStorage<Env>();

/** Runs `callback` with `env` as the request-scoped runtime environment. */
export function runWithRuntimeEnv<T>(env: Env, callback: () => T): T {
  return runtimeEnvStorage.run(env, callback);
}

/**
 * The composed env of the current request. Outside a request (tests, build
 * time prerendering) only the raw module env exists.
 */
export function getRuntimeEnv(): Env {
  return runtimeEnvStorage.getStore() ?? moduleEnv;
}

/**
 * `vite dev` runs the dashboard and the API in separate Miniflare processes,
 * so the API service binding cannot be used there.
 */
export function isLocalDevelopment(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * Sends `path` to the API Worker: the `API` service binding in production,
 * plain HTTP to the fixed local port during `vite dev`.
 */
export async function fetchApi(
  env: Pick<Env, "API">,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (isLocalDevelopment()) {
    return fetch(`${LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl}${path}`, init);
  }
  if (!env.API) {
    throw new Error("API service binding is not configured");
  }
  return env.API.fetch(`${INTERNAL_SERVICE_ORIGIN}${path}`, init);
}

/**
 * Reads the public platform origins from the API. Any failure yields the
 * empty config: the dashboard then falls back to its own request origin and
 * leaves the other origins unset, and the Platform settings page reports them
 * as missing.
 */
export async function fetchPlatformConfig(env: Pick<Env, "API">): Promise<PlatformConfig> {
  try {
    const response = await fetchApi(env, PLATFORM_CONFIG_PUBLIC_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      console.warn("Platform origins unavailable from API", { status: response.status });
      return { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] };
    }
    const body = (await response.json()) as { success?: boolean; data?: unknown };
    if (body.success !== true) {
      return { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] };
    }
    return normalizePlatformConfig(body.data);
  } catch (error) {
    console.warn("Platform origins could not be read from API", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] };
  }
}

function optional(value: string): string | undefined {
  return value || undefined;
}

export function hasMasterSecret(env: Env): boolean {
  return readMasterSecret(env) !== null;
}

export interface ComposedAdminRuntimeEnv {
  env: Env;
  /** False when `SCALIUS_SECRET` is not installed; callers must fail closed. */
  hasMasterSecret: boolean;
}

/**
 * Builds the request-scoped env: derived `BETTER_AUTH_SECRET` plus the
 * platform origins. The dashboard's own request origin is the fallback for
 * `BETTER_AUTH_URL` when no dashboard URL has been configured yet, so the
 * first admin can sign in and configure the platform.
 */
export async function composeAdminRuntimeEnv(
  env: Env,
  request: Request,
): Promise<ComposedAdminRuntimeEnv> {
  const [secrets, stored] = await Promise.all([
    deriveRuntimeSecretsFromEnv(env),
    fetchPlatformConfig(env),
  ]);
  const requestOrigin = new URL(request.url).origin;
  const platform = withLocalDevelopmentDefaults(stored, requestOrigin);

  const composed: Env = {
    ...env,
    BETTER_AUTH_SECRET: secrets?.BETTER_AUTH_SECRET ?? "",
    PLATFORM_CONFIG: platform,
    BETTER_AUTH_URL: platform.dashboardUrl || requestOrigin,
    PUBLIC_API_BASE_URL: optional(platform.apiUrl),
    STOREFRONT_URL: optional(platform.storefrontUrl),
    R2_PUBLIC_URL: optional(platform.mediaUrl),
  };
  return { env: composed, hasMasterSecret: secrets !== null };
}
