// src/modules/platform/platform-settings.service.ts
// Validation and resolution for the deployment's public origins. Storage is
// the `platform` settings document; Workers read it through its KV mirror.

import type { Database } from "@scalius/database/client";
import {
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  emptyPlatformConfig,
  normalizeCookieDomain,
  normalizeCorsOrigins,
  normalizeDashboardUrl,
  normalizeIdentityHandoffConfig,
  normalizeJwksUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
  type IdentityHandoffConfig,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { ValidationError } from "@scalius/core/errors";
import type { SettingsDocumentWriteResult, SettingsStoreKv } from "../settings/settings-store";
import type { SettingsSaveOptions } from "../settings/site-settings.service";
import { platformDocument } from "../settings/documents";

type PlatformKv = SettingsStoreKv;

/** Reads the stored platform configuration (no cache). */
export async function getPlatformSettings(db: Database): Promise<PlatformConfig> {
  return (await getPlatformSettingsDocument(db)).value;
}

/** The stored origins and the revision a save must send back. */
export async function getPlatformSettingsDocument(
  db: Database,
): Promise<SettingsDocumentWriteResult<PlatformConfig>> {
  const { value, revision } = await platformDocument.readDetailed(db, {}, { skipCache: true });
  return { value, revision };
}

export type PlatformSettingsPatch = Partial<{
  storefrontUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
  customerAuthCookieDomain: string;
  corsAllowedOrigins: string[] | string;
  setupTokenRequired: boolean;
  identityHandoff: Partial<IdentityHandoffConfig>;
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

function requireDashboardUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = normalizeDashboardUrl(trimmed);
  if (!url) {
    throw new ValidationError(
      "Dashboard URL must be an HTTPS origin, optionally followed by a lowercase path prefix such as /dashboard, without credentials, query, or fragment. HTTP is limited to loopback development.",
    );
  }
  return url;
}

function requireClaimValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = normalizeIdentityHandoffConfig({
    enabled: true,
    issuer: trimmed,
    audience: trimmed,
  });
  if (!normalized.issuer) {
    throw new ValidationError(
      `${label} must be a single value of at most ${IDENTITY_HANDOFF_CLAIM_MAX_LENGTH} characters without spaces or control characters.`,
    );
  }
  return normalized.issuer;
}

/**
 * Validates a partial identity-handoff patch against the currently stored
 * configuration so the combined state is always consistent: enabling needs an
 * issuer and an audience, and password sign-in can be disabled only while the
 * handoff is enabled.
 */
function mergeIdentityHandoffPatch(
  current: IdentityHandoffConfig,
  patch: Partial<IdentityHandoffConfig>,
): IdentityHandoffConfig {
  const issuer = patch.issuer === undefined
    ? current.issuer
    : requireClaimValue("Identity handoff issuer", patch.issuer);
  const audience = patch.audience === undefined
    ? current.audience
    : requireClaimValue("Identity handoff audience", patch.audience);
  let jwksUrl = current.jwksUrl;
  if (patch.jwksUrl !== undefined) {
    const trimmed = patch.jwksUrl.trim();
    jwksUrl = trimmed ? normalizeJwksUrl(trimmed) : "";
    if (trimmed && !jwksUrl) {
      throw new ValidationError(
        "Identity handoff JWKS URL must be an HTTPS URL without credentials or fragment. HTTP is limited to loopback development.",
      );
    }
  }
  const enabled = patch.enabled ?? current.enabled;
  if (enabled && (!issuer || !audience)) {
    throw new ValidationError(
      "Identity handoff needs an issuer and an audience before it can be enabled.",
    );
  }
  const localLoginDisabled = patch.localLoginDisabled ?? current.localLoginDisabled;
  // Disabling the handoff silently restores password sign-in; asking to
  // disable password sign-in without a handoff would lock every admin out.
  if (patch.localLoginDisabled === true && !enabled) {
    throw new ValidationError(
      "Password sign-in can only be disabled while identity handoff is enabled.",
    );
  }
  return normalizeIdentityHandoffConfig({
    enabled,
    issuer,
    audience,
    jwksUrl,
    localLoginDisabled,
  });
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
  /** Written through so Worker-entry readers see the new origins at once. */
  kv?: PlatformKv | null,
  /** The revision the editor loaded; a stale one is a 409 conflict. */
  options: { expectedRevision?: number } = {},
): Promise<SettingsDocumentWriteResult<PlatformConfig>> {
  const documentPatch: Partial<PlatformConfig> = {};

  if (patch.apiUrl !== undefined) {
    documentPatch.apiUrl = requireOrigin("API URL", patch.apiUrl);
  }
  if (patch.dashboardUrl !== undefined) {
    documentPatch.dashboardUrl = requireDashboardUrl(patch.dashboardUrl);
  }
  if (patch.setupTokenRequired !== undefined) {
    documentPatch.setupTokenRequired = patch.setupTokenRequired === true;
  }
  if (patch.identityHandoff !== undefined) {
    const current = await getPlatformSettings(db);
    documentPatch.identityHandoff = mergeIdentityHandoffPatch(
      current.identityHandoff,
      patch.identityHandoff,
    );
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
    // The storefront origin is required, so it cannot be cleared.
    const storefrontUrl = normalizeStorefrontOrigin(patch.storefrontUrl);
    if (!storefrontUrl) {
      throw new ValidationError(
        "Enter the HTTPS origin of the public store. Local development may use an HTTP loopback origin.",
      );
    }
    documentPatch.storefrontUrl = storefrontUrl;
  }

  return platformDocument.write(db, documentPatch, { kv }, options);
}

export async function readCachedPlatformConfig(
  kv: PlatformKv | null | undefined,
): Promise<PlatformConfig | null> {
  return platformDocument.readCached({ kv });
}

export async function cachePlatformConfig(
  kv: PlatformKv | null | undefined,
  config: PlatformConfig,
): Promise<void> {
  await platformDocument.writeCached({ kv }, config);
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
  const ctx = { kv: options.kv };
  const cached = await platformDocument.readCached(ctx);
  if (cached) return cached;

  try {
    return (await platformDocument.readDetailed(options.getDb(), ctx, { skipCache: true })).value;
  } catch (error: unknown) {
    console.error(
      "[Platform] DB read failed for platform config:",
      error instanceof Error ? error.message : error,
    );
    return emptyPlatformConfig();
  }
}

/** Storefront URL alone, for callers that only need the store origin. */
export async function getConfiguredStorefrontUrl(db: Database): Promise<string> {
  return (await getPlatformSettings(db)).storefrontUrl;
}

// ─────────────────────────────────────────
// Storefront URL (the platform document's storefront origin)
// ─────────────────────────────────────────

export async function getStorefrontUrlSetting(db: Database) {
  return { storefrontUrl: (await getPlatformSettings(db)).storefrontUrl };
}

export async function saveStorefrontUrl(
  db: Database,
  url: string,
  kv?: Parameters<typeof savePlatformSettings>[2],
  options: SettingsSaveOptions = {},
) {
  return savePlatformSettings(db, { storefrontUrl: url }, kv, options);
}
