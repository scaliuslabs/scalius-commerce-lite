// src/modules/settings/platform-settings.service.ts
// Storage and resolution for the deployment's public origins.
//
// The storefront origin is the existing `site_settings.storefront_url` column
// (already merchant-editable). The API, dashboard, and media origins plus the
// cookie domain and extra CORS origins live in the `settings` table. Workers
// read the resolved config through KV.
//
// Storage, validation, cache, and invalidation are declared once as a settings
// document; the exported functions below are thin wrappers so the API routes,
// `apps/api/src/runtime/runtime-env.ts`, and the other Workers keep working.

import { z } from "zod";
import { settings, siteSettings } from "@scalius/database/schema";
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
import {
  defineSettingsDocument,
  type SettingsDocumentContext,
  type SettingsStoreKv,
} from "./settings-store";
import { saveStorefrontUrl } from "./site-settings.service";

export const PLATFORM_SETTINGS_CATEGORY = "platform";
export const PLATFORM_CONFIG_CACHE_KEY = "platform:config:v1";
// Read on every API and storefront request. Every save deletes the key, so an
// expiring entry only adds one KV write per Worker every five minutes; the
// document store treats 0 as "no expiration".
const PLATFORM_CONFIG_CACHE_TTL_SECONDS = 0;
const PLATFORM_DOCUMENT_KEY = "config";

/** Pre-document per-key rows, still the source of truth until first read. */
const LEGACY_PLATFORM_SETTING_KEYS = {
  apiUrl: "api_url",
  dashboardUrl: "dashboard_url",
  mediaUrl: "media_url",
  customerAuthCookieDomain: "customer_auth_cookie_domain",
  corsAllowedOrigins: "cors_allowed_origins",
} as const;

type PlatformKv = SettingsStoreKv;

const platformConfigSchema = z
  .object({
    storefrontUrl: z.string(),
    apiUrl: z.string(),
    dashboardUrl: z.string(),
    mediaUrl: z.string(),
    customerAuthCookieDomain: z.string(),
    corsAllowedOrigins: z.array(z.string()).max(PLATFORM_CORS_ORIGINS_MAX_COUNT),
  })
  .transform((value) => normalizePlatformConfig(value));

/**
 * The deployment's public origins. `storefrontUrl` stays in the wide
 * `site_settings` singleton row and is exposed through the same interface by
 * the column adapter; the remaining origins are one JSON document.
 */
export const platformSettingsDocument = defineSettingsDocument<PlatformConfig>({
  category: PLATFORM_SETTINGS_CATEGORY,
  key: PLATFORM_DOCUMENT_KEY,
  label: "platform origins",
  schema: platformConfigSchema,
  defaults: { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] },
  cache: { key: PLATFORM_CONFIG_CACHE_KEY, ttlSeconds: PLATFORM_CONFIG_CACHE_TTL_SECONDS },
  // Origins feed layout HTML, CSP, discovery XML, and checkout callbacks.
  invalidationGroups: ["layout", "homepage", "discovery", "checkout"],
  columns: {
    fields: ["storefrontUrl"],
    async read(db) {
      const [row] = await db
        .select({ storefrontUrl: siteSettings.storefrontUrl })
        .from(siteSettings)
        .limit(1);
      return { storefrontUrl: row?.storefrontUrl ?? "" };
    },
    async write(db, patch) {
      if (typeof patch.storefrontUrl === "string") {
        // Reuses the existing site-settings storefront origin validation. The
        // storefront origin is required, so it cannot be cleared here either.
        await saveStorefrontUrl(db, patch.storefrontUrl);
      }
    },
  },
  legacy: {
    async read(db) {
      const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(inArray(settings.category, [PLATFORM_SETTINGS_CATEGORY]));
      const byKey = new Map(rows.map((row) => [row.key, row.value]));
      const legacyKeys = Object.values(LEGACY_PLATFORM_SETTING_KEYS);
      if (!legacyKeys.some((key) => byKey.has(key))) return null;

      const cors = byKey.get(LEGACY_PLATFORM_SETTING_KEYS.corsAllowedOrigins);
      let corsAllowedOrigins: string[] = [];
      if (cors) {
        try {
          corsAllowedOrigins = normalizeCorsOrigins(JSON.parse(cors) as unknown);
        } catch {
          corsAllowedOrigins = normalizeCorsOrigins(cors);
        }
      }

      return {
        document: {
          apiUrl: byKey.get(LEGACY_PLATFORM_SETTING_KEYS.apiUrl) ?? "",
          dashboardUrl: byKey.get(LEGACY_PLATFORM_SETTING_KEYS.dashboardUrl) ?? "",
          mediaUrl: byKey.get(LEGACY_PLATFORM_SETTING_KEYS.mediaUrl) ?? "",
          customerAuthCookieDomain:
            byKey.get(LEGACY_PLATFORM_SETTING_KEYS.customerAuthCookieDomain) ?? "",
          corsAllowedOrigins,
        },
        // Platform origins hold no secrets, so the document always supersedes.
        migrate: true,
      };
    },
  },
});

/** Reads the stored platform configuration (no cache). */
export async function getPlatformSettings(db: Database): Promise<PlatformConfig> {
  return platformSettingsDocument.read(db, {}, { skipCache: true });
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
  const documentPatch: Partial<PlatformConfig> = {};

  if (patch.apiUrl !== undefined) {
    documentPatch.apiUrl = requireOrigin("API URL", patch.apiUrl);
  }
  if (patch.dashboardUrl !== undefined) {
    documentPatch.dashboardUrl = requireOrigin("Dashboard URL", patch.dashboardUrl);
  }
  if (patch.mediaUrl !== undefined) {
    const trimmed = patch.mediaUrl.trim();
    const mediaUrl = trimmed ? normalizeMediaBaseUrl(trimmed) : "";
    if (trimmed && !mediaUrl) {
      throw new ValidationError(
        "Media URL must be an HTTPS base URL without credentials, query, or fragment. HTTP is limited to loopback development.",
      );
    }
    documentPatch.mediaUrl = mediaUrl;
  }
  if (patch.customerAuthCookieDomain !== undefined) {
    const trimmed = patch.customerAuthCookieDomain.trim();
    const domain = trimmed ? normalizeCookieDomain(trimmed) : "";
    if (trimmed && !domain) {
      throw new ValidationError(
        "Customer cookie domain must be a bare hostname such as example.com.",
      );
    }
    documentPatch.customerAuthCookieDomain = domain;
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
    documentPatch.corsAllowedOrigins = normalizeCorsOrigins(candidates);
  }

  if (patch.storefrontUrl !== undefined) {
    documentPatch.storefrontUrl = patch.storefrontUrl;
  }

  await platformSettingsDocument.write(db, documentPatch);
  return getPlatformSettings(db);
}

export async function readCachedPlatformConfig(
  kv: PlatformKv | null | undefined,
): Promise<PlatformConfig | null> {
  return platformSettingsDocument.readCached({ kv });
}

export async function cachePlatformConfig(
  kv: PlatformKv | null | undefined,
  config: PlatformConfig,
): Promise<void> {
  await platformSettingsDocument.writeCached({ kv }, config);
}

export async function invalidatePlatformConfigCache(
  kv: PlatformKv | null | undefined,
): Promise<void> {
  await platformSettingsDocument.invalidate({ kv });
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
  const ctx: SettingsDocumentContext = { kv: options.kv };
  const cached = await platformSettingsDocument.readCached(ctx);
  if (cached) return cached;

  try {
    return await platformSettingsDocument.read(options.getDb(), ctx, { skipCache: true });
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
