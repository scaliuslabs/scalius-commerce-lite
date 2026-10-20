// Settings > Tracking (audit spec S4): the consent banner of markets outside
// the EEA, the UK and Switzerland (those are always opt-in), GA4 Measurement
// Protocol and the TikTok Events API. Secrets (the GA4 API secret, the TikTok
// access token) are encrypted with CREDENTIAL_ENCRYPTION_KEY and never leave
// the API: a GET masks them, and a masked or omitted value keeps the stored
// one. Test mode is readable: GA4 `debugMode`, TikTok `testEventCode`.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import {
  GA4_MEASUREMENT_ID,
  ga4MeasurementDocument,
  isPlaceholderTrackingSecret,
  TIKTOK_PIXEL_CODE,
  tiktokEventsDocument,
  trackingConsentDocument,
} from "@scalius/core/integrations/tracking/settings";
import { CONSENT_REGIMES } from "@scalius/shared/tracking-consent";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../../schemas/responses";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { clearTikTokBrowserCircuit } from "../../../utils/tiktok-events-circuit";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const regime = z.enum(CONSENT_REGIMES as ["opt_in", "notice", "link_only"]);

const trackingSettingsSchema = z.object({
  consent: z.object({
    otherRegions: regime.openapi({
      description: "The banner of markets that sell to no EEA, UK or Swiss country: `notice` (default; tags run until the buyer refuses), `opt_in` (nothing runs until the buyer agrees) or `link_only` (no banner, only the footer's \"Your privacy choices\"). EEA, UK and Swiss markets are always opt-in.",
    }),
    revision: z.number().int().nonnegative(),
  }),
  ga4: z.object({
    isEnabled: z.boolean(),
    measurementId: z.string().nullable(),
    apiSecret: z.string().nullable().openapi({ description: "Masked when saved; null when none." }),
    debugMode: z.boolean().openapi({ description: "Send to the Measurement Protocol validation server (nothing is recorded)." }),
    revision: z.number().int().nonnegative(),
  }),
  tiktok: z.object({
    isEnabled: z.boolean(),
    pixelCode: z.string().nullable(),
    accessToken: z.string().nullable().openapi({ description: "Masked when saved; null when none." }),
    testEventCode: z.string().nullable().openapi({ description: "Events go to Events Manager > Test events while set." }),
    revision: z.number().int().nonnegative(),
  }),
});

async function readTrackingSettings(db: Database, env: Env) {
  const ctx = { encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>) };
  const [consent, ga4, tiktok] = await Promise.all([
    trackingConsentDocument.readDetailed(db, ctx),
    ga4MeasurementDocument.readDetailed(db, ctx),
    tiktokEventsDocument.readDetailed(db, ctx),
  ]);
  return {
    consent,
    ga4,
    tiktok,
    ga4SecretStored: Boolean(ga4.value.apiSecret || ga4.secretErrors.apiSecret),
    tiktokTokenStored: Boolean(tiktok.value.accessToken || tiktok.secretErrors.accessToken),
  };
}

function view(stored: Awaited<ReturnType<typeof readTrackingSettings>>): z.infer<typeof trackingSettingsSchema> {
  return {
    consent: { otherRegions: stored.consent.value.otherRegions, revision: stored.consent.revision },
    ga4: {
      isEnabled: stored.ga4.value.isEnabled,
      measurementId: stored.ga4.value.measurementId || null,
      apiSecret: stored.ga4SecretStored ? MASKED_VALUE : null,
      debugMode: stored.ga4.value.debugMode,
      revision: stored.ga4.revision,
    },
    tiktok: {
      isEnabled: stored.tiktok.value.isEnabled,
      pixelCode: stored.tiktok.value.pixelCode || null,
      accessToken: stored.tiktokTokenStored ? MASKED_VALUE : null,
      testEventCode: stored.tiktok.value.testEventCode || null,
      revision: stored.tiktok.revision,
    },
  };
}

const getRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.tracking.get",
  tags: ["Admin - Tracking"],
  summary: "Get tracking consent, GA4 Measurement Protocol and TikTok Events API settings",
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: successEnvelope(trackingSettingsSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getRoute, async (c) => ok(c, view(await readTrackingSettings(c.get("db"), c.env))));

const secretInput = z.string().max(4096).optional().openapi({ description: "Omitted or masked keeps the stored value; empty clears it." });
const saveSchema = z.object({
  consent: z.object({ otherRegions: regime, expectedRevision: z.number().int().nonnegative() }).strict().optional(),
  ga4: z.object({
    isEnabled: z.boolean().optional(),
    measurementId: z.string().trim().max(32).optional(),
    apiSecret: secretInput,
    debugMode: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
  }).strict().optional(),
  tiktok: z.object({
    isEnabled: z.boolean().optional(),
    pixelCode: z.string().trim().max(64).optional(),
    accessToken: secretInput,
    testEventCode: z.string().trim().max(64).optional(),
    expectedRevision: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

const saveRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.tracking.update",
  tags: ["Admin - Tracking"],
  summary: "Save tracking consent, GA4 Measurement Protocol or TikTok Events API settings",
  description: "Each section saves at its own `expectedRevision` (409 when stale). Enabling GA4 needs a `G-` measurement ID and an API secret; enabling TikTok needs a pixel code and an access token. Placeholder values are refused.",
  request: { body: { required: true, content: { "application/json": { schema: saveSchema } } } },
  responses: {
    200: { description: "Settings saved", content: { "application/json": { schema: successEnvelope(trackingSettingsSchema) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

/** The secret a save writes: undefined keeps the stored one (omitted or masked), "" clears it. */
function secretPatch(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === MASKED_VALUE) return undefined;
  if (trimmed && isPlaceholderTrackingSecret(trimmed)) {
    throw new ValidationError(`The ${label} looks like a placeholder. Paste the real value.`);
  }
  return trimmed;
}

app.openapi(saveRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const env = c.env as unknown as Record<string, unknown>;
  const existing = await readTrackingSettings(db, c.env);

  if (body.consent) {
    await trackingConsentDocument.write(db, { otherRegions: body.consent.otherRegions }, {}, { expectedRevision: body.consent.expectedRevision });
  }

  if (body.ga4) {
    const measurementId = (body.ga4.measurementId ?? existing.ga4.value.measurementId).toUpperCase();
    const apiSecret = secretPatch(body.ga4.apiSecret, "GA4 API secret");
    const isEnabled = body.ga4.isEnabled ?? existing.ga4.value.isEnabled;
    if (measurementId && !GA4_MEASUREMENT_ID.test(measurementId)) {
      throw new ValidationError("The GA4 measurement ID looks like G-XXXXXXXXXX (Admin > Data streams).");
    }
    const hasSecret = apiSecret === undefined ? existing.ga4SecretStored : Boolean(apiSecret);
    if (isEnabled && (!measurementId || !hasSecret)) {
      throw new ValidationError("GA4 Measurement Protocol needs a measurement ID and an API secret before it can be enabled.");
    }
    await ga4MeasurementDocument.write(db, {
      isEnabled,
      measurementId,
      ...(apiSecret !== undefined ? { apiSecret } : {}),
      debugMode: body.ga4.debugMode ?? existing.ga4.value.debugMode,
    }, { encryptionKey: apiSecret ? requireEncryptionKey(env) : getCredentialEncryptionKey(env) }, { expectedRevision: body.ga4.expectedRevision });
  }

  if (body.tiktok) {
    const pixelCode = (body.tiktok.pixelCode ?? existing.tiktok.value.pixelCode).toUpperCase();
    const accessToken = secretPatch(body.tiktok.accessToken, "TikTok access token");
    const isEnabled = body.tiktok.isEnabled ?? existing.tiktok.value.isEnabled;
    if (pixelCode && !TIKTOK_PIXEL_CODE.test(pixelCode)) {
      throw new ValidationError("The TikTok pixel code is the code from Events Manager (letters and digits).");
    }
    const hasToken = accessToken === undefined ? existing.tiktokTokenStored : Boolean(accessToken);
    if (isEnabled && (!pixelCode || !hasToken)) {
      throw new ValidationError("TikTok Events API needs a pixel code and an access token before it can be enabled.");
    }
    await tiktokEventsDocument.write(db, {
      isEnabled,
      pixelCode,
      ...(accessToken !== undefined ? { accessToken } : {}),
      testEventCode: body.tiktok.testEventCode ?? existing.tiktok.value.testEventCode,
    }, { encryptionKey: accessToken ? requireEncryptionKey(env) : getCredentialEncryptionKey(env) }, { expectedRevision: body.tiktok.expectedRevision });
    await clearTikTokBrowserCircuit(db, c.env);
  }

  return ok(c, view(await readTrackingSettings(db, c.env)));
});

export { app as trackingSettingsRoutes };
