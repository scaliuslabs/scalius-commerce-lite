// apps/api/src/runtime/runtime-env.ts
// Composes the request-scoped runtime environment for the API Worker.
//
// Wrangler installs only resource bindings plus two secrets:
//   SCALIUS_SECRET            master secret; every other secret is derived
//   CREDENTIAL_ENCRYPTION_KEY encrypts merchant credentials at rest
// Public origins come from the Platform settings (database, cached in KV).
// Every consumer keeps reading `env.STOREFRONT_URL`, `env.JWT_SECRET`, etc.;
// those fields are filled here, once per invocation, never by Wrangler vars.

import { getDb, type Database } from "@scalius/database/client";
import { deps } from "@scalius/core/cache-deps";
import { getPlatformSettings, resolvePlatformConfig } from "@scalius/core/modules/platform";
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

  return {
    ...env,
    ...(secrets ?? {}),
    ...platformEnvFields(stored, options.requestUrl),
  } as Env;
}

/** The env fields that carry the Platform settings, resolved for one request. */
function platformEnvFields(stored: PlatformConfig, requestUrl: string | undefined): Partial<Env> {
  const requestOrigin = publicRequestOrigin(requestUrl);
  const platform = withLocalDevelopmentDefaults(stored, requestOrigin);
  const apiUrl = platform.apiUrl || requestOrigin || "";
  const resolved: PlatformConfig = { ...platform, apiUrl };
  return {
    PLATFORM_CONFIG: resolved,
    STOREFRONT_URL: optional(resolved.storefrontUrl),
    PUBLIC_API_BASE_URL: optional(resolved.apiUrl),
    BETTER_AUTH_URL: optional(resolved.dashboardUrl),
    R2_PUBLIC_URL: optional(resolved.mediaUrl),
    CDN_DOMAIN_URL: optional(mediaHostFromUrl(resolved.mediaUrl)),
    CUSTOMER_AUTH_COOKIE_DOMAIN: optional(resolved.customerAuthCookieDomain),
    CORS_ALLOWED_ORIGINS: optional(resolved.corsAllowedOrigins.join(",")),
  } as Partial<Env>;
}

/**
 * The Platform-settings read of a public render (CACHE-DESIGN.md section 6.4).
 *
 * Worker entry resolves the platform origins KV-first, and KV may lag the
 * settings row. A render inside a dependency scope must not bake that hint
 * into an entry validated by `set:platform:document`, so it re-reads the row
 * through the tracked settings path (which declares that key) and replaces the
 * platform fields of its env. Outside a scope the env is returned unchanged
 * and nothing is read. An unreadable row keeps the entry-time values and marks
 * the render uncacheable.
 */
export async function withTrackedPlatformEnv(
  env: Env,
  db: Database,
  requestUrl: string,
): Promise<Env> {
  if (!deps.active()) return env;
  try {
    const stored = await getPlatformSettings(db);
    return { ...env, ...platformEnvFields(stored, requestUrl) } as Env;
  } catch {
    deps.uncacheable("platform-settings-unreadable");
    return env;
  }
}

export function hasMasterSecret(env: Env): boolean {
  return readMasterSecret(env) !== null;
}
