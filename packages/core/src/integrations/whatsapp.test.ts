import { describe, expect, it, vi } from "vitest";
import { getWhatsAppCloudApiSettings, sendWhatsAppTemplateMessage } from "./whatsapp";
import { decryptCredentials, encryptCredentials } from "../utils/credential-encryption";

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

  it("includes URL button parameters when provided", async () => {
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
      buttonUrlParameter: "654321",
    }, fetchMock);

    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      template: {
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "654321" }],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "654321" }],
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

  it("does not report encrypted tokens as configured when no key is available", async () => {
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: null,
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: { value: "enc:not-decrypted-without-key" },
    });

    const result = await getWhatsAppCloudApiSettings(db);

    expect(result).toMatchObject({
      accessToken: undefined,
      accessTokenConfigured: false,
      phoneNumberId: "phone_id_1",
      accessTokenSource: "none",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not use bare encrypted legacy tokens as plaintext when the key is wrong", async () => {
    const key = Buffer.alloc(32, 31).toString("base64");
    const wrongKey = Buffer.alloc(32, 32).toString("base64");
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: null,
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: { value: await encryptCredentials("encrypted_token", key) },
    });

    const result = await getWhatsAppCloudApiSettings(db, wrongKey);

    expect(result).toMatchObject({
      accessToken: undefined,
      accessTokenConfigured: false,
      phoneNumberId: "phone_id_1",
      accessTokenSource: "none",
    });
  });

  it("keeps legacy plaintext fallback if an existing encrypted token cannot decrypt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: "legacy_token",
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: { value: "enc:not-valid-aes-gcm" },
    });

    const result = await getWhatsAppCloudApiSettings(db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", {
      migrateLegacy: true,
    });

    expect(result).toMatchObject({
      accessToken: "legacy_token",
      accessTokenConfigured: true,
      phoneNumberId: "phone_id_1",
      accessTokenSource: "legacy",
    });
    expect(db.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not migrate a legacy token when only the read fallback key is provided", async () => {
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: "legacy_token",
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: null,
    });

    const result = await getWhatsAppCloudApiSettings(db, "jwt-fallback-key", {
      migrateLegacy: true,
    });

    expect(result).toMatchObject({
      accessToken: "legacy_token",
      accessTokenConfigured: true,
      accessTokenSource: "legacy",
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not clear legacy plaintext after fallback-key decrypt without a dedicated migration key", async () => {
    const fallbackKey = Buffer.alloc(32, 26).toString("base64");
    const encryptedToken = `enc:${await encryptCredentials("encrypted_token", fallbackKey)}`;
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: "legacy_token",
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: { value: encryptedToken },
    });

    const result = await getWhatsAppCloudApiSettings(db, fallbackKey, {
      migrateLegacy: true,
    });

    expect(result).toMatchObject({
      accessToken: "encrypted_token",
      accessTokenConfigured: true,
      accessTokenSource: "encrypted",
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("migrates legacy plaintext only with a dedicated credential encryption key", async () => {
    const migrationKey = Buffer.alloc(32, 27).toString("base64");
    const db = createSettingsDb({
      site: {
        id: "site_settings_1",
        whatsappAccessToken: "legacy_token",
        whatsappPhoneNumberId: "phone_id_1",
        whatsappTemplateName: "auth_otp",
      },
      tokenRow: null,
    });

    await getWhatsAppCloudApiSettings(db, "jwt-fallback-key", {
      migrateLegacy: true,
      migrationEncryptionKey: migrationKey,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const storedValue = db.getInsertedValues()[0]?.value;
    expect(storedValue).toMatch(/^enc:/);
    expect(storedValue).not.toContain("legacy_token");
    await expect(
      decryptCredentials(String(storedValue).slice("enc:".length), migrationKey),
    ).resolves.toBe("legacy_token");
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

function createSettingsDb(input: {
  site: {
    id: string;
    whatsappAccessToken: string | null;
    whatsappPhoneNumberId: string | null;
    whatsappTemplateName: string | null;
  } | null;
  tokenRow: { value: string } | null;
}) {
  const insertedValues: Array<{ value: string }> = [];
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      const selectedToken = Boolean(selection && "value" in selection && Object.keys(selection).length === 1);
      return {
        from: vi.fn(() => selectedToken
          ? {
            where: vi.fn(() => ({
              get: vi.fn(async () => input.tokenRow),
            })),
          }
          : {
            limit: vi.fn(() => ({
              get: vi.fn(async () => input.site),
            })),
        }),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((row: { value: string }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          insertedValues.push(row);
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    getInsertedValues: () => insertedValues,
  };

  return db as typeof db & Parameters<typeof getWhatsAppCloudApiSettings>[0];
}
