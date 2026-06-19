import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppTemplateMessage } from "./whatsapp";

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
});
