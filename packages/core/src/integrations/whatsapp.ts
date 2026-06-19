import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { META_GRAPH_API_VERSION } from "./meta/conversions-api";

export interface SendWhatsAppTemplateMessageInput {
  accessToken: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  languageCode?: string;
  bodyParameters?: string[];
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
    components?: Array<{
      type: "body";
      parameters: Array<{ type: "text"; text: string }>;
    }>;
  };
}

export function normalizeWhatsAppRecipient(input: string): string {
  return validateAndFormatPhone(input).replace(/^\+/, "");
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
