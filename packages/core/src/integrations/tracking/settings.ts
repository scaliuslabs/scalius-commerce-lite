// Tracking settings documents (audit spec §3.10): the consent banner of
// markets outside the EEA/UK/CH, GA4 Measurement Protocol and the TikTok
// Events API. Secrets (the GA4 API secret, the TikTok access token) are
// encrypted with CREDENTIAL_ENCRYPTION_KEY and read strictly, like Meta's.
// Every settings write advances the checkout authority revision, so a
// checkout commit never misses a destination enabled under it.

import { z } from "zod";
import {
  CONSENT_REGIMES,
  DEFAULT_TRACKING_CONSENT_SETTINGS,
  type TrackingConsentSettings,
} from "@scalius/shared/tracking-consent";
import { defineSettingsDocument, type SettingsDocumentReadResult } from "../../settings-store";

export const trackingConsentDocument = defineSettingsDocument<TrackingConsentSettings>({
  key: "tracking_consent",
  schema: z.object({ otherRegions: z.enum(CONSENT_REGIMES as [TrackingConsentSettings["otherRegions"], ...TrackingConsentSettings["otherRegions"][]]) }),
  defaults: DEFAULT_TRACKING_CONSENT_SETTINGS,
});

const PLACEHOLDER = /^(?:x{4,}|dummy|test|example|placeholder|changeme|your[_ -]?.*|secret|token|g-x+|1234567?8?)$/i;

/** Obvious dummy credentials read as not configured (AGENTS.md). */
export function isPlaceholderTrackingSecret(value: string): boolean {
  return PLACEHOLDER.test(value.trim().replace(/\s+/g, ""));
}

export interface Ga4MeasurementSettings {
  isEnabled: boolean;
  /** `G-XXXXXXX` of the web data stream. */
  measurementId: string;
  /** Admin > Data streams > Measurement Protocol API secrets. */
  apiSecret: string;
  /** Sends to the validation endpoint (`/debug/mp/collect`) instead of collecting. */
  debugMode: boolean;
}

export const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;

export const ga4MeasurementDocument = defineSettingsDocument<Ga4MeasurementSettings>({
  key: "ga4_measurement",
  schema: z.object({
    isEnabled: z.boolean(),
    measurementId: z.string().max(32),
    apiSecret: z.string().max(256),
    debugMode: z.boolean(),
  }),
  defaults: { isEnabled: false, measurementId: "", apiSecret: "", debugMode: false },
  secretFields: { apiSecret: "GA4 Measurement Protocol API secret" },
  isPlaceholderSecret: isPlaceholderTrackingSecret,
});

export interface TikTokEventsSettings {
  isEnabled: boolean;
  /** The pixel code (`event_source_id`), e.g. `C4ABCDEF0123456789`. */
  pixelCode: string;
  /** Events Manager > Settings > Generate access token. */
  accessToken: string;
  /** Events Manager > Test events; empty sends live events. */
  testEventCode: string;
}

export const TIKTOK_PIXEL_CODE = /^[A-Z0-9]{10,32}$/;

export const tiktokEventsDocument = defineSettingsDocument<TikTokEventsSettings>({
  key: "tiktok_events",
  schema: z.object({
    isEnabled: z.boolean(),
    pixelCode: z.string().max(64),
    accessToken: z.string().max(4096),
    testEventCode: z.string().max(64),
  }),
  defaults: { isEnabled: false, pixelCode: "", accessToken: "", testEventCode: "" },
  secretFields: { accessToken: "TikTok Events API access token" },
  isPlaceholderSecret: isPlaceholderTrackingSecret,
});

/** The settings documents checkout and the senders read beside Meta's, in one statement. */
export const TRACKING_SETTINGS_DOCUMENTS = [trackingConsentDocument, ga4MeasurementDocument, tiktokEventsDocument] as const;

/**
 * Whether a destination is on: enabled with its ids and a stored secret. A
 * stored secret this isolate cannot decrypt still counts (the sender does
 * the strict read and skips), so checkout never drops a delivery it owes.
 */
export function ga4ServerEnabled(read: SettingsDocumentReadResult<Ga4MeasurementSettings>): boolean {
  const value = read.value;
  return value.isEnabled
    && GA4_MEASUREMENT_ID.test(value.measurementId.trim())
    && (value.apiSecret.trim().length > 0 || Boolean(read.secretErrors.apiSecret));
}

export function tiktokServerEnabled(read: SettingsDocumentReadResult<TikTokEventsSettings>): boolean {
  const value = read.value;
  return value.isEnabled
    && TIKTOK_PIXEL_CODE.test(value.pixelCode.trim())
    && (value.accessToken.trim().length > 0 || Boolean(read.secretErrors.accessToken));
}
