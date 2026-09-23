// apps/api/src/runtime/runtime-env.ts
// Composes the request-scoped runtime environment for the API Worker.
//
// Wrangler installs only resource bindings plus two secrets:
//   SCALIUS_SECRET            master secret; every other secret is derived
//   CREDENTIAL_ENCRYPTION_KEY encrypts merchant credentials at rest
// Public origins come from the Platform settings (database, cached in KV).
// Every consumer keeps reading `env.STOREFRONT_URL`, `env.JWT_SECRET`, etc.;
// those fields are filled here, once per invocation, never by Wrangler vars.

import { getDb } from "@scalius/database/client";
import { resolvePlatformConfig } from "@scalius/core/modules/settings/platform-settings.service";
import {
  deriveRuntimeSecretsFromEnv,
  readMasterSecret,
} from "@scalius/shared/runtime-secrets";
import {
  emptyPlatformConfig,
  mediaHostFromUrl,
  publicRequestOrigin,
  withLocalDevelopmentDefaults,
  type PlatformConfig,
} from "@scalius/shared/platform-config";

export interface ComposeRuntimeEnvOptions {
  /** Incoming request URL; absent for queue and cron invocations. */
  requestUrl?: string;
}

function optional(value: string): string | undefined {
  return value || undefined;
}

/**
 * Returns a new env object with derived secrets and resolved platform origins.
 * Bindings are passed through by reference; nothing is retained in globals.
 */
export async function composeApiRuntimeEnv(
  env: Env,
  options: ComposeRuntimeEnvOptions = {},
): Promise<Env> {
  const [secrets, stored] = await Promise.all([
    deriveRuntimeSecretsFromEnv(env),
    resolvePlatformConfig({ getDb: () => getDb(env), kv: env.CACHE }).catch(
      (): PlatformConfig => emptyPlatformConfig(),
    ),
  ]);

  const requestOrigin = publicRequestOrigin(options.requestUrl);
  const platform = withLocalDevelopmentDefaults(stored, requestOrigin);
  const apiUrl = platform.apiUrl || requestOrigin || "";
  const resolved: PlatformConfig = { ...platform, apiUrl };

  return {
    ...env,
    ...(secrets ?? {}),
    PLATFORM_CONFIG: resolved,
    STOREFRONT_URL: optional(resolved.storefrontUrl),
    PUBLIC_API_BASE_URL: optional(resolved.apiUrl),
    BETTER_AUTH_URL: optional(resolved.dashboardUrl),
    R2_PUBLIC_URL: optional(resolved.mediaUrl),
    CDN_DOMAIN_URL: optional(mediaHostFromUrl(resolved.mediaUrl)),
    CUSTOMER_AUTH_COOKIE_DOMAIN: optional(resolved.customerAuthCookieDomain),
    CORS_ALLOWED_ORIGINS: optional(resolved.corsAllowedOrigins.join(",")),
  } as Env;
}

export function hasMasterSecret(env: Env): boolean {
  return readMasterSecret(env) !== null;
}
