// src/modules/settings/platform-settings.service.ts
// Storage and resolution for the deployment's public origins.
//
// The storefront origin is the existing `site_settings.storefront_url` column
// (already merchant-editable). The API, dashboard, and media origins plus the
// cookie domain and extra CORS origins live in the `settings` table under the
// `platform` category. Workers read the resolved config through KV.

import { siteSettings, settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, inArray } from "drizzle-orm";
import {
  EMPTY_PLATFORM_CONFIG,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  normalizeCookieDomain,
  normalizeCorsOrigins,
  normalizeMediaBaseUrl,
  normalizePlatformConfig,
  normalizePlatformOriginUrl,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import { ValidationError } from "@scalius/core/errors";
import { upsertSetting } from "../payments/gateway-settings";
import { saveStorefrontUrl } from "./site-settings.service";

export const PLATFORM_SETTINGS_CATEGORY = "platform";
export const PLATFORM_CONFIG_CACHE_KEY = "platform:config:v1";
const PLATFORM_CONFIG_CACHE_TTL_SECONDS = 300;

const PLATFORM_SETTING_KEYS = {
  apiUrl: "api_url",
  dashboardUrl: "dashboard_url",
  mediaUrl: "media_url",
  customerAuthCookieDomain: "customer_auth_cookie_domain",
  corsAllowedOrigins: "cors_allowed_origins",
} as const;

type StoredPlatformKey = keyof typeof PLATFORM_SETTING_KEYS;

interface PlatformKv {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Reads the stored platform configuration (no cache). */
export async function getPlatformSettings(db: Database): Promise<PlatformConfig> {
  const [storefrontRow, rows] = await Promise.all([
    db
      .select({ storefrontUrl: siteSettings.storefrontUrl })
      .from(siteSettings)
      .limit(1)
      .then((result) => result[0] ?? null),
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.category, [PLATFORM_SETTINGS_CATEGORY])),
  ]);

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const cors = byKey.get(PLATFORM_SETTING_KEYS.corsAllowedOrigins);
  let corsAllowedOrigins: unknown = [];
  if (cors) {
    try {
      corsAllowedOrigins = JSON.parse(cors) as unknown;
    } catch {
      corsAllowedOrigins = cors;
    }
  }

  return normalizePlatformConfig({
    storefrontUrl: storefrontRow?.storefrontUrl ?? "",
    apiUrl: byKey.get(PLATFORM_SETTING_KEYS.apiUrl) ?? "",
    dashboardUrl: byKey.get(PLATFORM_SETTING_KEYS.dashboardUrl) ?? "",
    mediaUrl: byKey.get(PLATFORM_SETTING_KEYS.mediaUrl) ?? "",
    customerAuthCookieDomain:
      byKey.get(PLATFORM_SETTING_KEYS.customerAuthCookieDomain) ?? "",
    corsAllowedOrigins,
  });
}

export type PlatformSettingsPatch = Partial<{
  storefrontUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
  customerAuthCookieDomain: string;
  corsAllowedOrigins: string[] | string;
}>;

function requireOrigin(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const origin = normalizePlatformOriginUrl(trimmed);
  if (!origin) {
    throw new ValidationError(
      `${label} must be an HTTPS origin without credentials, path, query, or fragment. HTTP is limited to loopback development.`,
    );
  }
  return origin;
}

/**
 * Validates and stores a partial update. Empty strings clear a value, except
 * `storefrontUrl`, which is required and rejects an empty value. Every field
 * in the patch is validated before the first write.
 * Returns the full stored configuration after the write.
 */
export async function savePlatformSettings(
  db: Database,
  patch: PlatformSettingsPatch,
): Promise<PlatformConfig> {
  const writes: Array<[StoredPlatformKey, string]> = [];

  if (patch.apiUrl !== undefined) {
    writes.push(["apiUrl", requireOrigin("API URL", patch.apiUrl)]);
  }
  if (patch.dashboardUrl !== undefined) {
    writes.push(["dashboardUrl", requireOrigin("Dashboard URL", patch.dashboardUrl)]);
  }
  if (patch.mediaUrl !== undefined) {
    const trimmed = patch.mediaUrl.trim();
    const mediaUrl = trimmed ? normalizeMediaBaseUrl(trimmed) : "";
    if (trimmed && !mediaUrl) {
      throw new ValidationError(
        "Media URL must be an HTTPS base URL without credentials, query, or fragment. HTTP is limited to loopback development.",
      );
    }
    writes.push(["mediaUrl", mediaUrl]);
  }
  if (patch.customerAuthCookieDomain !== undefined) {
    const trimmed = patch.customerAuthCookieDomain.trim();
    const domain = trimmed ? normalizeCookieDomain(trimmed) : "";
    if (trimmed && !domain) {
      throw new ValidationError(
        "Customer cookie domain must be a bare hostname such as example.com.",
      );
    }
    writes.push(["customerAuthCookieDomain", domain]);
  }
  if (patch.corsAllowedOrigins !== undefined) {
    const raw = Array.isArray(patch.corsAllowedOrigins)
      ? patch.corsAllowedOrigins
      : patch.corsAllowedOrigins.split(/[\s,]+/);
    const candidates = raw.map((value) => value.trim()).filter(Boolean);
    const invalid = candidates.filter((value) => !normalizePlatformOriginUrl(value));
    if (invalid.length > 0) {
      throw new ValidationError(
        "Every extra CORS origin must be an HTTPS origin without a path. HTTP is limited to loopback development.",
      );
    }
    const distinct = new Set(candidates.map((value) => normalizePlatformOriginUrl(value)));
    if (distinct.size > PLATFORM_CORS_ORIGINS_MAX_COUNT) {
      throw new ValidationError(
        `At most ${PLATFORM_CORS_ORIGINS_MAX_COUNT} extra CORS origins can be configured.`,
      );
    }
    writes.push(["corsAllowedOrigins", JSON.stringify(normalizeCorsOrigins(candidates))]);
  }

  if (patch.storefrontUrl !== undefined) {
    // Reuses the existing site-settings storefront origin validation. The
    // storefront origin is required, so it cannot be cleared here either.
    await saveStorefrontUrl(db, patch.storefrontUrl);
  }

  for (const [key, value] of writes) {
    await upsertSetting(db, PLATFORM_SETTINGS_CATEGORY, PLATFORM_SETTING_KEYS[key], value);
  }

  return getPlatformSettings(db);
}

export async function readCachedPlatformConfig(
  kv: PlatformKv | null | undefined,
): Promise<PlatformConfig | null> {
  if (!kv) return null;
  try {
    const cached = await kv.get(PLATFORM_CONFIG_CACHE_KEY, { cacheTtl: 60 });
    if (!cached) return null;
    return normalizePlatformConfig(JSON.parse(cached) as unknown);
  } catch (error: unknown) {
    console.warn(
      "[Platform] KV read failed for platform config:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function cachePlatformConfig(
  kv: PlatformKv | null | undefined,
  config: PlatformConfig,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(PLATFORM_CONFIG_CACHE_KEY, JSON.stringify(config), {
      expirationTtl: PLATFORM_CONFIG_CACHE_TTL_SECONDS,
    });
  } catch (error: unknown) {
    console.warn(
      "[Platform] KV write failed for platform config:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function invalidatePlatformConfigCache(
  kv: PlatformKv | null | undefined,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(PLATFORM_CONFIG_CACHE_KEY);
  } catch (error: unknown) {
    console.warn(
      "[Platform] KV delete failed for platform config:",
      error instanceof Error ? error.message : error,
    );
  }
}

export interface ResolvePlatformConfigOptions {
  /** Lazily opens the relational database; only called on a cache miss. */
  getDb: () => Database;
  kv?: PlatformKv | null;
}

/**
 * KV-first resolution used at Worker entry. A database failure returns the
 * empty configuration so callers fail closed on missing origins instead of
 * crashing every request.
 */
export async function resolvePlatformConfig(
  options: ResolvePlatformConfigOptions,
): Promise<PlatformConfig> {
  const cached = await readCachedPlatformConfig(options.kv);
  if (cached) return cached;

  try {
    const config = await getPlatformSettings(options.getDb());
    await cachePlatformConfig(options.kv, config);
    return config;
  } catch (error: unknown) {
    console.error(
      "[Platform] DB read failed for platform config:",
      error instanceof Error ? error.message : error,
    );
    return { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] };
  }
}

/** Storefront URL alone, for callers that only need the store origin. */
export async function getConfiguredStorefrontUrl(db: Database): Promise<string> {
  const [row] = await db
    .select({ storefrontUrl: siteSettings.storefrontUrl })
    .from(siteSettings)
    .where(eq(siteSettings.singletonKey, "default"))
    .limit(1);
  return normalizePlatformOriginUrl(row?.storefrontUrl ?? "");
}
