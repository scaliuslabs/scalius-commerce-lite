import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import type { Database } from "@scalius/database/client";
import { settings, siteSettings } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  encryptCredentials,
  readStoredCredentialStrict,
} from "../utils/credential-encryption";
import { META_GRAPH_API_VERSION } from "./meta/conversions-api";

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
  const accessToken = encryptedAccessToken ?? legacyAccessToken;
  const accessTokenSource = encryptedAccessToken
    ? "encrypted"
    : legacyAccessToken
      ? "legacy"
      : "none";

  if (site?.id && legacyAccessToken && options.migrationEncryptionKey && options.migrateLegacy && !tokenRow?.value) {
    await migrateLegacyWhatsAppAccessToken(db, site.id, legacyAccessToken, options.migrationEncryptionKey);
  } else if (site?.id && legacyAccessToken && encryptedAccessToken && options.migrateLegacy && options.migrationEncryptionKey) {
    await clearLegacyWhatsAppAccessToken(db, site.id);
  }

  return {
    accessToken,
    accessTokenConfigured: Boolean(accessToken),
    phoneNumberId: site?.whatsappPhoneNumberId ?? undefined,
    authTemplateName: site?.whatsappTemplateName || "auth_otp",
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
    const errorText = truncateProviderResponse(await response.text());
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
      rawResponse: truncateProviderResponse(responseText || "Missing WhatsApp message id"),
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

function truncateProviderResponse(value: string): string {
  return value.length > 1_000 ? `${value.slice(0, 1_000)}...` : value;
}

function isRetryableWhatsAppStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
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
