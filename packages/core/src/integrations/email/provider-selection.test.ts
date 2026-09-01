import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail, type EmailRuntimeSettings } from "./index";
import { getEmailProviderReadiness, getEmailRuntimeSettings, resolveLocalMailpitUrl } from "./settings";
import { encryptCredentials } from "../../utils/credential-encryption";

const baseSettings: EmailRuntimeSettings = {
  provider: "cloudflare",
  sender: "orders@example.com",
  senderConfigured: true,
  resendApiKey: null,
  hasResendApiKey: false,
  cloudflareBindingConfigured: false,
  localMailpitUrl: null,
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
  it.each([
    ["http://127.0.0.1:8025", "http://127.0.0.1:8025"],
    ["http://localhost:8025/", "http://localhost:8025"],
    ["http://[::1]:8025", "http://[::1]:8025"],
    ["https://127.0.0.1:8025", null],
    ["http://127.0.0.1:8025/mail", null],
    ["http://user@127.0.0.1:8025", null],
    ["http://127.0.0.1.example.com:8025", null],
  ])("accepts only loopback Mailpit origins (%s)", (value, expected) => {
    expect(resolveLocalMailpitUrl(value)).toBe(expected);
  });

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

  it("captures local email in Mailpit before any production provider", async () => {
    const cloudflareSend = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ID: "mailpit_msg_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail(
      {
        to: "buyer@example.test",
        subject: "Verification code",
        html: "<p>Code</p>",
        text: "Code",
      },
      {
        env: { EMAIL: { send: cloudflareSend } },
        settings: {
          ...baseSettings,
          cloudflareBindingConfigured: true,
          localMailpitUrl: "http://127.0.0.1:8025",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      provider: "mailpit",
      providerRef: "mailpit_msg_1",
    });
    expect(cloudflareSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8025/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: { Email: "orders@example.com" },
        To: [{ Email: "buyer@example.test" }],
        Subject: "Verification code",
        HTML: "<p>Code</p>",
        Text: "Code",
      }),
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

  it("preserves status-only Resend auth failures for notification classifiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
      },
      {
        settings: {
          ...baseSettings,
          provider: "resend",
          resendApiKey: "bad_key",
          hasResendApiKey: true,
        },
      },
    )).rejects.toThrow("Resend API error: 401");
  });

  it("preserves Resend status when the provider returns a JSON message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({ message: "The from address must be a verified domain" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
      },
      {
        settings: {
          ...baseSettings,
          provider: "resend",
          resendApiKey: "bad_key",
          hasResendApiKey: true,
        },
      },
    )).rejects.toThrow("Resend API error: 422: The from address must be a verified domain");
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
      configured: false,
      cloudflareBindingConfigured: true,
      resendConfigured: false,
      senderConfigured: true,
      error: expect.stringContaining("Resend API key"),
    });

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "cloudflare" },
        { key: "email_sender", value: "orders@example.com" },
        { key: "resend_api_key", value: encryptedResendKey },
      ]),
      encryptionKey: key,
    })).resolves.toMatchObject({
      configured: false,
      cloudflareBindingConfigured: false,
      resendConfigured: true,
      senderConfigured: true,
      error: "The selected Cloudflare Email provider requires the EMAIL binding.",
    });

    await expect(getEmailProviderReadiness({
      db: createEmailSettingsDb([
        { key: "email_provider", value: "cloudflare" },
      ]),
      env: { EMAIL: { send: vi.fn() } },
    })).resolves.toMatchObject({
      configured: false,
      senderConfigured: false,
      error: "Sender email is required before enabling email delivery.",
    });
  });

  it("accepts Mailpit only through an explicit loopback HTTP URL", async () => {
    const db = createEmailSettingsDb([
      { key: "email_provider", value: "cloudflare" },
      { key: "email_sender", value: "orders@example.test" },
    ]);

    await expect(getEmailProviderReadiness({
      db,
      env: { LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" },
    })).resolves.toMatchObject({
      configured: true,
      provider: "mailpit",
      cloudflareBindingConfigured: false,
      resendConfigured: false,
      error: null,
    });

    await expect(getEmailProviderReadiness({
      db,
      env: { LOCAL_MAILPIT_URL: "https://mail.example.com" },
    })).resolves.toMatchObject({
      configured: false,
      provider: "cloudflare",
      error: "The selected Cloudflare Email provider requires the EMAIL binding.",
    });
  });
});
