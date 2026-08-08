import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import type { Database } from "@scalius/database/client";
import { settings, siteSettings } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  encryptCredentials,
  readStoredCredentialStrict,
} from "../utils/credential-encryption";
import { META_GRAPH_API_VERSION } from "./meta/conversions-api";
import { ValidationError } from "../errors";

export interface SendWhatsAppTemplateMessageInput {
  accessToken: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  languageCode?: string;
  bodyParameters?: string[];
  buttonUrlParameter?: string;
}

export interface SendWhatsAppTemplateMessageResult {
  success: boolean;
  providerRef?: string;
  rawStatus: string;
  rawResponse?: string;
  retryable?: boolean;
}

interface WhatsAppMessageResponse {
  messages?: Array<{
    id?: string;
    message_status?: "accepted" | "held_for_quality_assessment" | "paused" | string;
  }>;
}

interface WhatsAppTemplatePayload {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: WhatsAppTemplateComponent[];
  };
}

type WhatsAppTemplateComponent =
  | {
    type: "body";
    parameters: Array<{ type: "text"; text: string }>;
  }
  | {
    type: "button";
    sub_type: "url";
    index: string;
    parameters: Array<{ type: "text"; text: string }>;
  };

export interface WhatsAppCloudApiSettings {
  accessToken?: string;
  accessTokenConfigured: boolean;
  phoneNumberId?: string;
  authTemplateName: string;
  accessTokenSource: "encrypted" | "legacy" | "none";
}

interface WhatsAppCloudApiSettingsOptions {
  migrateLegacy?: boolean;
  /** Must be the dedicated CREDENTIAL_ENCRYPTION_KEY, never the JWT fallback read key. */
  migrationEncryptionKey?: string;
}

const WHATSAPP_SETTINGS_CATEGORY = "whatsapp";
const WHATSAPP_ACCESS_TOKEN_KEY = "access_token";
const ENCRYPTED_VALUE_PREFIX = "enc:";
const PLACEHOLDER_EXACT_VALUES = new Set([
  "000000",
  "111111",
  "123456",
  "123456789",
  "accesstoken",
  "authtoken",
  "changeme",
  "changeit",
  "demo",
  "dummy",
  "example",
  "placeholder",
  "sample",
  "secret",
  "test",
  "testing",
  "token",
  "youraccesstoken",
  "yourphoneid",
  "yourphonenumberid",
  "yourtemplate",
  "yourtoken",
  "yourtokenhere",
]);

const PLACEHOLDER_WORD_VALUES = new Set([
  "changeme",
  "dummy",
  "example",
  "placeholder",
  "sample",
]);

export function normalizeWhatsAppRecipient(input: string): string {
  return validateAndFormatPhone(input).replace(/^\+/, "");
}

export async function getWhatsAppCloudApiSettings(
  db: Database,
  encryptionKey?: string,
  options: WhatsAppCloudApiSettingsOptions = {},
): Promise<WhatsAppCloudApiSettings> {
  const [site, tokenRow] = await Promise.all([
    db.select({
      id: siteSettings.id,
      whatsappAccessToken: siteSettings.whatsappAccessToken,
      whatsappPhoneNumberId: siteSettings.whatsappPhoneNumberId,
      whatsappTemplateName: siteSettings.whatsappTemplateName,
    }).from(siteSettings).limit(1).get(),
    db.select({ value: settings.value })
      .from(settings)
      .where(and(
        eq(settings.category, WHATSAPP_SETTINGS_CATEGORY),
        eq(settings.key, WHATSAPP_ACCESS_TOKEN_KEY),
      ))
      .get(),
  ]);

  const encryptedAccessToken = tokenRow?.value
    ? await readStoredWhatsAppAccessToken(tokenRow.value, encryptionKey)
    : undefined;
  const legacyAccessToken = site?.whatsappAccessToken?.trim() || undefined;
  const rawAccessToken = encryptedAccessToken ?? legacyAccessToken;
  const accessToken = looksLikeWhatsAppPlaceholderCredential(rawAccessToken)
    ? undefined
    : rawAccessToken;
  const accessTokenSource = encryptedAccessToken && accessToken
    ? "encrypted"
    : legacyAccessToken && accessToken
      ? "legacy"
      : "none";
  const rawPhoneNumberId = site?.whatsappPhoneNumberId?.trim() || undefined;
  const phoneNumberId = looksLikeWhatsAppPlaceholderCredential(rawPhoneNumberId)
    ? undefined
    : rawPhoneNumberId;
  const rawTemplateName = site?.whatsappTemplateName?.trim();
  const authTemplateName =
    rawTemplateName === undefined || rawTemplateName === ""
      ? "auth_otp"
      : looksLikeWhatsAppPlaceholderCredential(rawTemplateName)
        ? ""
        : rawTemplateName;

  if (site?.id && legacyAccessToken && options.migrationEncryptionKey && options.migrateLegacy && !tokenRow?.value) {
    await migrateLegacyWhatsAppAccessToken(db, site.id, legacyAccessToken, options.migrationEncryptionKey);
  } else if (site?.id && legacyAccessToken && encryptedAccessToken && options.migrateLegacy && options.migrationEncryptionKey) {
    await clearLegacyWhatsAppAccessToken(db, site.id);
  }

  return {
    accessToken,
    accessTokenConfigured: Boolean(accessToken),
    phoneNumberId,
    authTemplateName,
    accessTokenSource,
  };
}

export async function saveWhatsAppAccessToken(
  db: Database,
  value: string,
  encryptionKey?: string,
  siteSettingsId?: string,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await db.delete(settings).where(and(
      eq(settings.category, WHATSAPP_SETTINGS_CATEGORY),
      eq(settings.key, WHATSAPP_ACCESS_TOKEN_KEY),
    ));
    await clearLegacyWhatsAppAccessToken(db, siteSettingsId);
    return;
  }

  if (!encryptionKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required to store WhatsApp credentials.");
  }

  const placeholderError = firstWhatsAppPlaceholderConfigError([
    ["WhatsApp access token", trimmed],
  ]);
  if (placeholderError) throw new ValidationError(placeholderError);

  const encrypted = `${ENCRYPTED_VALUE_PREFIX}${await encryptCredentials(trimmed, encryptionKey)}`;
  await db.insert(settings)
    .values({
      id: crypto.randomUUID(),
      category: WHATSAPP_SETTINGS_CATEGORY,
      key: WHATSAPP_ACCESS_TOKEN_KEY,
      value: encrypted,
      type: "string",
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value: encrypted, updatedAt: sql`unixepoch()` },
    });
  await clearLegacyWhatsAppAccessToken(db, siteSettingsId);
}

export async function sendWhatsAppTemplateMessage(
  input: SendWhatsAppTemplateMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendWhatsAppTemplateMessageResult> {
  const recipient = normalizeWhatsAppRecipient(input.to);
  const languageCode = input.languageCode?.trim() || "en_US";
  const bodyParameters = input.bodyParameters
    ?.map((value) => String(value).trim())
    .filter((value) => value.length > 0) ?? [];

  const payload: WhatsAppTemplatePayload = {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: {
      name: input.templateName.trim(),
      language: { code: languageCode },
    },
  };

  if (bodyParameters.length > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: bodyParameters.map((text) => ({ type: "text", text })),
      },
    ];
  }

  const buttonUrlParameter = input.buttonUrlParameter?.trim();
  if (buttonUrlParameter) {
    payload.template.components = [
      ...(payload.template.components ?? []),
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: buttonUrlParameter }],
      },
    ];
  }

  const response = await fetchImpl(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${input.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const errorText = summarizeWhatsAppErrorResponse(
      await response.text(),
      response.status,
    );
    return {
      success: false,
      rawStatus: `HTTP ${response.status}`,
      rawResponse: errorText,
      retryable: isRetryableWhatsAppStatus(response.status),
    };
  }

  const responseText = await response.text();
  const parsed = parseWhatsAppResponse(responseText);
  const message = parsed?.messages?.[0];
  if (!message?.id) {
    return {
      success: false,
      rawStatus: "malformed_response",
      rawResponse: JSON.stringify({
        status: response.status,
        error: "missing_message_id",
        responseLength: responseText.length,
      }),
      retryable: true,
    };
  }

  const messageStatus = message?.message_status ?? "accepted";
  const providerRef = message?.id;
  const rawResponse = JSON.stringify({
    messageId: providerRef,
    messageStatus,
  });

  return {
    success: messageStatus !== "paused",
    providerRef,
    rawStatus: messageStatus,
    rawResponse,
    retryable: messageStatus === "paused" ? false : undefined,
  };
}

function parseWhatsAppResponse(responseText: string): WhatsAppMessageResponse | null {
  if (!responseText.trim()) return null;
  try {
    return JSON.parse(responseText) as WhatsAppMessageResponse;
  } catch {
    return null;
  }
}

function summarizeWhatsAppErrorResponse(value: string, status: number): string {
  let providerError: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(value) as { error?: unknown };
    if (parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
      providerError = parsed.error as Record<string, unknown>;
    }
  } catch {
    providerError = undefined;
  }

  const message = typeof providerError?.message === "string"
    ? providerError.message
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240)
    : undefined;
  return JSON.stringify({
    status,
    ...(typeof providerError?.type === "string" ? { type: providerError.type } : {}),
    ...(typeof providerError?.code === "number" ? { code: providerError.code } : {}),
    ...(typeof providerError?.error_subcode === "number"
      ? { errorSubcode: providerError.error_subcode }
      : {}),
    ...(message ? { message } : { error: "provider_request_failed" }),
  });
}

function isRetryableWhatsAppStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function looksLikeWhatsAppPlaceholderCredential(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return false;
  if (PLACEHOLDER_EXACT_VALUES.has(normalized)) return true;
  if (/^([0-9])\1{3,}$/.test(normalized)) return true;
  if (/^1234567890?$/.test(normalized)) return true;

  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => PLACEHOLDER_WORD_VALUES.has(word))) return true;
  if (words.length <= 2 && words.some((word) => word === "test" || word === "demo")) {
    return true;
  }
  if (
    words[0] === "your" &&
    words.some((word) => word === "token" || word === "phone" || word === "template" || word === "id")
  ) {
    return true;
  }

  return false;
}

export function firstWhatsAppPlaceholderConfigError(
  fields: Array<[label: string, value: string | null | undefined]>,
): string | null {
  for (const [label, value] of fields) {
    if (looksLikeWhatsAppPlaceholderCredential(value)) {
      return `${label} looks like a placeholder. Save real Meta WhatsApp Cloud API credentials before enabling WhatsApp.`;
    }
  }
  return null;
}

async function readStoredWhatsAppAccessToken(
  storedValue: string,
  encryptionKey?: string,
): Promise<string | undefined> {
  const result = await readStoredCredentialStrict(
    storedValue,
    encryptionKey,
    "WhatsApp access token",
  );
  if (result.error) {
    console.warn("[WhatsApp] Access token is not ready:", result.error);
    return undefined;
  }
  return result.value || undefined;
}

async function migrateLegacyWhatsAppAccessToken(
  db: Database,
  siteSettingsId: string,
  legacyAccessToken: string,
  encryptionKey: string,
): Promise<void> {
  try {
    await saveWhatsAppAccessToken(db, legacyAccessToken, encryptionKey, siteSettingsId);
  } catch (error: unknown) {
    console.warn(
      "[WhatsApp] Failed to migrate legacy plaintext access token:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function clearLegacyWhatsAppAccessToken(
  db: Database,
  siteSettingsId?: string,
): Promise<void> {
  try {
    const query = db
      .update(siteSettings)
      .set({
        whatsappAccessToken: null,
        updatedAt: sql`unixepoch()`,
      });

    if (siteSettingsId) {
      await query.where(eq(siteSettings.id, siteSettingsId));
    } else {
      await query.where(eq(siteSettings.singletonKey, "default"));
    }
  } catch (error: unknown) {
    console.warn(
      "[WhatsApp] Failed to clear legacy plaintext access token:",
      error instanceof Error ? error.message : error,
    );
  }
}
