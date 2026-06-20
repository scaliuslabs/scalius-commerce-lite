import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail, type EmailRuntimeSettings } from "./index";
import { getEmailProviderReadiness, getEmailRuntimeSettings } from "./settings";
import { encryptCredentials } from "../../utils/credential-encryption";

const baseSettings: EmailRuntimeSettings = {
  provider: "cloudflare",
  sender: "orders@example.com",
  senderConfigured: true,
  resendApiKey: null,
  hasResendApiKey: false,
  cloudflareBindingConfigured: false,
};

function createEmailSettingsDb(rows: Array<{ key: string; value: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => rows,
        }),
      }),
    }),
  };
}

describe("email provider selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends with the Cloudflare EMAIL binding when Cloudflare is configured", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "cf_msg_1" });

    const result = await sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
      },
      {
        env: { EMAIL: { send } },
        settings: {
          ...baseSettings,
          cloudflareBindingConfigured: true,
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      provider: "cloudflare",
      providerRef: "cf_msg_1",
    });
    expect(send).toHaveBeenCalledWith({
      to: "buyer@example.com",
      from: "orders@example.com",
      subject: "Order received",
      html: "<p>Thanks</p>",
      text: undefined,
    });
  });

  it("falls back to Resend when Cloudflare is selected but the binding is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: "resend_msg_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
        text: "Thanks",
      },
      {
        settings: {
          ...baseSettings,
          resendApiKey: "re_test_key",
          hasResendApiKey: true,
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      provider: "resend",
      providerRef: "resend_msg_1",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer re_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "orders@example.com",
        to: ["buyer@example.com"],
        subject: "Order received",
        html: "<p>Thanks</p>",
        text: "Thanks",
      }),
    });
  });

  it("passes idempotency keys through to Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: "resend_msg_2" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
        idempotencyKey: "outbox_1:email:recipient_hash",
      },
      {
        settings: {
          ...baseSettings,
          provider: "resend",
          resendApiKey: "re_test_key",
          hasResendApiKey: true,
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      headers: expect.objectContaining({
        "Idempotency-Key": "outbox_1:email:recipient_hash",
      }),
    }));
  });

  it("fails without logging email bodies when no provider is configured", async () => {
    await expect(sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Your code is 123456</p>",
        text: "Your code is 123456",
      },
      { settings: baseSettings },
    )).resolves.toMatchObject({
      success: false,
      provider: "log",
      rawStatus: "No configured email provider available; email not delivered",
    });

    expect(console.warn).toHaveBeenCalledWith(
      "[Email] No configured provider available; email was not delivered",
      expect.objectContaining({
        to: "br***@example.com",
        contentLogged: false,
      }),
    );
    const logOutput = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ].map((call) => call.map((value) => JSON.stringify(value)).join(" ")).join("\n");
    expect(logOutput).not.toContain("123456");
    expect(logOutput).not.toContain("<p>Your code");
  });

  it("does not treat an unreadable encrypted Resend API key as configured", async () => {
    const key = Buffer.alloc(32, 12).toString("base64");
    const wrongKey = Buffer.alloc(32, 13).toString("base64");
    const settings = await getEmailRuntimeSettings({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "resend" },
        { key: "email_sender", value: "orders@example.com" },
        { key: "resend_api_key", value: `enc:${await encryptCredentials("re_live_secret", key)}` },
      ]),
      encryptionKey: wrongKey,
    });

    expect(settings).toMatchObject({
      provider: "resend",
      sender: "orders@example.com",
      senderConfigured: true,
      resendApiKey: null,
      hasResendApiKey: false,
    });
  });

  it("reports email readiness from Cloudflare, Resend, sender, and credential state", async () => {
    const key = Buffer.alloc(32, 12).toString("base64");
    const wrongKey = Buffer.alloc(32, 13).toString("base64");
    const encryptedResendKey = `enc:${await encryptCredentials("re_live_secret", key)}`;

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "cloudflare" },
        { key: "email_sender", value: "orders@example.com" },
      ]),
      env: { EMAIL: { send: vi.fn() } },
    })).resolves.toMatchObject({
      configured: true,
      cloudflareBindingConfigured: true,
      resendConfigured: false,
      senderConfigured: true,
      error: null,
    });

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "resend" },
        { key: "email_sender", value: "orders@example.com" },
        { key: "resend_api_key", value: encryptedResendKey },
      ]),
      encryptionKey: wrongKey,
    })).resolves.toMatchObject({
      configured: false,
      cloudflareBindingConfigured: false,
      resendConfigured: false,
      senderConfigured: true,
    });

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "resend" },
        { key: "email_sender", value: "orders@example.com" },
        { key: "resend_api_key", value: encryptedResendKey },
      ]),
      env: { EMAIL: { send: vi.fn() } },
      encryptionKey: wrongKey,
    })).resolves.toMatchObject({
      configured: true,
      cloudflareBindingConfigured: true,
      resendConfigured: false,
      senderConfigured: true,
      error: null,
    });

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "cloudflare" },
      ]),
      env: { EMAIL: { send: vi.fn() } },
    })).resolves.toMatchObject({
      configured: false,
      senderConfigured: false,
      error: "Sender email is required before enabling Email OTP.",
    });
  });
});
