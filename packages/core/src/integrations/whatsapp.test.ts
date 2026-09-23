import { describe, expect, it, vi } from "vitest";
import {
  getWhatsAppCloudApiSettings,
  sendWhatsAppTemplateMessage,
} from "./whatsapp";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { whatsappDocument } from "../modules/settings/documents";

describe("WhatsApp Cloud API integration", () => {
  it("sends template messages with normalized recipients and body parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [{ id: "wamid.order.1", message_status: "accepted" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "order_status_update",
      languageCode: "en_US",
      bodyParameters: ["Buyer", "order_1", "Order Shipped", "TRACK123"],
    }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/phone_id_1/messages"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer wa_token",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      messaging_product: "whatsapp",
      to: "8801712345678",
      type: "template",
      template: {
        name: "order_status_update",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Buyer" },
              { type: "text", text: "order_1" },
              { type: "text", text: "Order Shipped" },
              { type: "text", text: "TRACK123" },
            ],
          },
        ],
      },
    });
    expect(result).toEqual({
      success: true,
      providerRef: "wamid.order.1",
      rawStatus: "accepted",
      rawResponse: JSON.stringify({
        messageId: "wamid.order.1",
        messageStatus: "accepted",
      }),
    });
  });

  it("sends auth OTP templates with only the body code parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [{ id: "wamid.otp.1", message_status: "accepted" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "auth_otp",
      bodyParameters: ["654321"],
    }, fetchMock);

    const payload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload).toMatchObject({
      template: {
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "654321" }],
          },
        ],
      },
    });
    expect(payload.template.components).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain('"button"');
  });

  it("includes URL button parameters when explicitly provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [{ id: "wamid.order.link.1", message_status: "accepted" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "order_status_with_tracking_link",
      bodyParameters: ["TRACK123"],
      buttonUrlParameter: "TRACK123",
    }, fetchMock);

    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      template: {
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "TRACK123" }],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "TRACK123" }],
          },
        ],
      },
    });
  });

  it("treats paused template responses as failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [{ id: "wamid.order.2", message_status: "paused" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "order_status_update",
    }, fetchMock);

    expect(result.success).toBe(false);
    expect(result.providerRef).toBe("wamid.order.2");
    expect(result.rawStatus).toBe("paused");
    expect(result.retryable).toBe(false);
  });

  it("does not accept malformed success responses without a message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messaging_product: "whatsapp" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "order_status_update",
    }, fetchMock);

    expect(result.success).toBe(false);
    expect(result.rawStatus).toBe("malformed_response");
    expect(result.retryable).toBe(true);
  });

  it("marks provider validation errors as non-retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid template" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendWhatsAppTemplateMessage({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "order_status_update",
    }, fetchMock);

    expect(result.success).toBe(false);
    expect(result.rawStatus).toBe("HTTP 400");
    expect(result.retryable).toBe(false);
  });

  it("reads the stored credentials strictly and treats placeholders as not configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = Buffer.alloc(32, 30).toString("base64");
    const { db } = createSqliteD1Database();
    await whatsappDocument.write(db, { accessToken: "EAAG-real-token", phoneNumberId: "109876543210987" }, { encryptionKey: key });

    await expect(getWhatsAppCloudApiSettings(db, key)).resolves.toEqual({
      accessToken: "EAAG-real-token",
      accessTokenConfigured: true,
      phoneNumberId: "109876543210987",
      authTemplateName: "auth_otp",
    });
    // An encrypted token is never used without the dedicated key.
    await expect(getWhatsAppCloudApiSettings(db)).resolves.toMatchObject({
      accessToken: undefined,
      accessTokenConfigured: false,
    });
    await expect(getWhatsAppCloudApiSettings(db, Buffer.alloc(32, 31).toString("base64")))
      .resolves.toMatchObject({ accessTokenConfigured: false });

    await whatsappDocument.write(db, { accessToken: "dummy", phoneNumberId: "123456", authTemplateName: "test" }, { encryptionKey: key });
    await expect(getWhatsAppCloudApiSettings(db, key)).resolves.toEqual({
      accessToken: undefined,
      accessTokenConfigured: false,
      phoneNumberId: undefined,
      authTemplateName: "",
    });
  });
});
