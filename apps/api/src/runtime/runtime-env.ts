// apps/api/src/runtime/runtime-env.ts
// Composes the request-scoped runtime environment for the API Worker.
//
// Wrangler installs only resource bindings plus two secrets:
//   SCALIUS_SECRET            master secret; every other secret is derived
//   CREDENTIAL_ENCRYPTION_KEY encrypts merchant credentials at rest
// Public origins come from the Platform settings (database, mirrored per colo in the Cache API).
// Every consumer keeps reading `env.STOREFRONT_URL`, `env.JWT_SECRET`, etc.;
// those fields are filled here, never by Wrangler vars: the origins once per
// invocation, each derived secret on its first read.

import { getDb, type Database } from "@scalius/database/client";
import { deps } from "@scalius/core/cache-deps";
import { getPlatformSettings, resolvePlatformConfig } from "@scalius/core/modules/platform";
import { settingsMirror } from "@scalius/core/settings-store";
import { preloadedPlatformSettings } from "./public-render-context";
import { hkdfSync } from "node:crypto";
import {
  RUNTIME_SECRET_BYTES,
  RUNTIME_SECRET_HKDF_SALT,
  RUNTIME_SECRET_PURPOSES,
  encodeBase64Url,
  readMasterSecret,
  type RuntimeSecretName,
} from "@scalius/shared/runtime-secrets";
import {
  emptyPlatformConfig,
  mediaHostFromUrl,
  publicRequestOrigin,
  withLocalDevelopmentDefaults,
  type PlatformConfig,
} from "@scalius/shared/platform-config";

export interface ComposeRuntimeEnvOptions {
  /** Incoming request URL; absent for cron invocations. */
  requestUrl?: string;
}

function optional(value: string): string | undefined {
  return value || undefined;
}

/**
 * One per-purpose secret, synchronously: HKDF-SHA256 over the master secret
 * with the same salt, purpose label and length as `deriveRuntimeSecret`
 * (`@scalius/shared/runtime-secrets`), so the value is identical.
 */
export function deriveRuntimeSecretSync(master: string, purpose: string): string {
  return encodeBase64Url(new Uint8Array(
    hkdfSync("sha256", master, RUNTIME_SECRET_HKDF_SALT, purpose, RUNTIME_SECRET_BYTES),
  ));
}

const RUNTIME_SECRET_NAMES = Object.keys(RUNTIME_SECRET_PURPOSES) as RuntimeSecretName[];

/**
 * Installs the derived secrets on `env` as getters: each purpose is derived on
 * its first read and remembered for this env (a public cache hit or a request
 * that never authenticates derives none). An assignment replaces the value.
 * Copy such an env with `withEnvFields`, which keeps the getters lazy; a
 * spread reads (and so derives) every one.
 */
function defineLazyRuntimeSecrets(env: Env, master: string): void {
  for (const name of RUNTIME_SECRET_NAMES) {
    let value: string | undefined;
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      get: () => (value ??= deriveRuntimeSecretSync(master, RUNTIME_SECRET_PURPOSES[name])),
      set: (next: string) => {
        value = next;
      },
    });
  }
}

/** A copy of `env` with `fields` replaced; lazily derived secrets stay lazy. */
export function withEnvFields(env: Env, fields: Partial<Env>): Env {
  const copy = Object.create(Object.getPrototypeOf(env), Object.getOwnPropertyDescriptors(env)) as Env;
  return Object.assign(copy, fields);
}

/**
 * Returns a new env object with derived secrets and resolved platform origins.
 * Bindings are passed through by reference; nothing is retained in globals.
 */
export async function composeApiRuntimeEnv(
  env: Env,
  options: ComposeRuntimeEnvOptions = {},
): Promise<Env> {
  const stored = await resolvePlatformConfig({ getDb: () => getDb(env), kv: settingsMirror(env) }).catch(
    (): PlatformConfig => emptyPlatformConfig(),
  );
  const composed = { ...env, ...platformEnvFields(stored, options.requestUrl) } as Env;
  const master = readMasterSecret(env);
  if (master) defineLazyRuntimeSecrets(composed, master);
  return composed;
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
 * Worker entry resolves the platform origins mirror-first, and the mirror may lag the
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
  // The part reader read the row with its clock statement (public-render-context.ts).
  const preloaded = preloadedPlatformSettings();
  if (preloaded) {
    deps.settings("platform", "document");
    return withEnvFields(env, platformEnvFields(preloaded, requestUrl));
  }
  try {
    const stored = await getPlatformSettings(db);
    return withEnvFields(env, platformEnvFields(stored, requestUrl));
  } catch {
    deps.uncacheable("platform-settings-unreadable");
    return env;
  }
}

export function hasMasterSecret(env: Env): boolean {
  return readMasterSecret(env) !== null;
}
