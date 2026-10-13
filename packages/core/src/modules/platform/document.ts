// src/modules/platform/document.ts
// The `platform` settings document: the deployment's public origins, CORS,
// identity handoff (Settings -> Platform) and the store defaults every
// invocation may need (time zone, units; Settings -> Store details). Read at
// Worker entry through its per-colo mirror, so it lives here, beside its services,
// rather than in the settings domain.

import { z } from "zod";
import {
  emptyPlatformConfig,
  normalizePlatformConfig,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import { defineSettingsDocument } from "../../settings-store";

export const platformDocument = defineSettingsDocument<PlatformConfig>({
  key: "platform",
  schema: z
    .object({
      storefrontUrl: z.string(),
      apiUrl: z.string(),
      dashboardUrl: z.string(),
      mediaUrl: z.string(),
      customerAuthCookieDomain: z.string(),
      // A pre-document comma-separated list is normalized like an array.
      corsAllowedOrigins: z.union([
        z.array(z.string()).max(PLATFORM_CORS_ORIGINS_MAX_COUNT),
        z.string(),
      ]),
      setupTokenRequired: z.boolean(),
      identityHandoff: z.object({
        enabled: z.boolean().default(false),
        issuer: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH).default(""),
        audience: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH).default(""),
        jwksUrl: z.string().default(""),
        localLoginDisabled: z.boolean().default(false),
      }),
      // Store defaults: an unknown value reads as the default, never as an invalid document.
      timeZone: z.unknown(),
      unitSystem: z.unknown(),
      weightUnit: z.unknown(),
    })
    .transform((value) => normalizePlatformConfig(value)),
  defaults: emptyPlatformConfig(),
  cacheKey: "settings:platform",
});
