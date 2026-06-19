import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail, type EmailRuntimeSettings } from "./index";

const baseSettings: EmailRuntimeSettings = {
  provider: "cloudflare",
  sender: "orders@example.com",
  resendApiKey: null,
  hasResendApiKey: false,
  cloudflareBindingConfigured: false,
};

describe("email provider selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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

  it("logs locally instead of throwing when no provider is configured", async () => {
    await expect(sendEmail(
      {
        to: "buyer@example.com",
        subject: "Order received",
        html: "<p>Thanks</p>",
      },
      { settings: baseSettings },
    )).resolves.toMatchObject({
      success: false,
      provider: "log",
    });

    expect(console.log).toHaveBeenCalledWith(
      "EMAIL (no configured provider available - logging only)",
    );
  });
});
