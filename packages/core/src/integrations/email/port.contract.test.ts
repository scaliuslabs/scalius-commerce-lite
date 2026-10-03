// The built-in senders keep the shared email port (the one app providers
// implement), and `sendEmail` hands every sender, built in or an app's, the
// same port input: the store's sender resolved once, only the list headers.
// Provider HTTP and the Cloudflare binding are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_PORTS } from "@scalius/shared/plugins/providers";
import { bindProvider } from "../provider-port";
import { cloudflareEmail } from "./cloudflare";
import { sendEmail, type EmailRuntimeSettings } from "./index";
import { resendEmail } from "./resend";

const runtime: EmailRuntimeSettings = {
  provider: "resend",
  sender: "orders@shop.test",
  senderName: "Shop",
  senderConfigured: true,
  resendApiKey: "re_live_key_0123456789",
  hasResendApiKey: true,
  cloudflareBindingConfigured: true,
  localMailpitUrl: null,
};

const message = {
  to: "buyer@example.test",
  subject: "Your order shipped",
  html: "<p>Shipped</p>",
  text: "Shipped",
  headers: { "List-Unsubscribe": "<https://shop.test/unsubscribe>", "X-Other": "dropped" },
  idempotencyKey: "outbox1:email:hash",
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("built-in senders keep the email port", () => {
  const port = PROVIDER_PORTS.email.send;
  const input = {
    to: message.to, subject: message.subject, html: message.html, text: message.text,
    from: "orders@shop.test", fromName: "Shop", headers: { "List-Unsubscribe": "<https://shop.test/unsubscribe>" },
    idempotencyKey: message.idempotencyKey,
  };

  it("Resend answers within the port and sends the idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(port.input.safeParse(input).success).toBe(true);
    const result = await bindProvider("email", resendEmail, { runtime }).send(input, {});
    expect(port.output.parse(result)).toEqual({ success: true, providerRef: "re_1", rawStatus: "accepted" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "Idempotency-Key": message.idempotencyKey });
  });

  it("Cloudflare answers within the port", async () => {
    const binding = { send: vi.fn().mockResolvedValue({ messageId: "cf_1" }) };
    const result = await bindProvider("email", cloudflareEmail, { runtime, binding }).send(input, {});
    expect(port.output.parse(result)).toEqual({ success: true, providerRef: "cf_1", rawStatus: "accepted" });
  });
});

describe("sendEmail through an app sender", () => {
  const APP_ID = "acme.mail:mail";

  function appSender(answer: { success: boolean; providerRef?: string; rawStatus?: string; retryable?: boolean }) {
    return { id: APP_ID, label: "Acme Mail", send: vi.fn(async () => answer) };
  }

  it("hands the app the port input: the store's sender, only the list headers, the idempotency key", async () => {
    const sender = appSender({ success: true, providerRef: "acme-1" });
    const resolve = vi.fn(async () => ({ provider: sender, issue: null }));
    const result = await sendEmail(message, { settings: { ...runtime, provider: APP_ID }, appProviders: { resolve } as never });

    expect(resolve).toHaveBeenCalledWith("email", APP_ID);
    expect(result).toEqual({ success: true, providerRef: "acme-1", provider: APP_ID });
    const [input] = sender.send.mock.calls[0] as unknown as [unknown];
    expect(PROVIDER_PORTS.email.send.input.parse(input)).toEqual({
      to: "buyer@example.test",
      subject: "Your order shipped",
      html: "<p>Shipped</p>",
      text: "Shipped",
      from: "orders@shop.test",
      fromName: "Shop",
      headers: { "List-Unsubscribe": "<https://shop.test/unsubscribe>" },
      idempotencyKey: "outbox1:email:hash",
    });
  });

  it("keeps the app's refusal, never retried when it says so", async () => {
    const sender = appSender({ success: false, rawStatus: "Recipient refused", retryable: false });
    const result = await sendEmail(message, { settings: { ...runtime, provider: APP_ID }, appProviders: { resolve: async () => ({ provider: sender, issue: null }) } as never });
    expect(result).toEqual({ success: false, rawStatus: "Recipient refused", retryable: false, provider: APP_ID });
  });

  it("falls back to a configured built-in sender while the app is not ready, as a missing Resend key does", async () => {
    const binding = { send: vi.fn().mockResolvedValue({ messageId: "cf_2" }) };
    const result = await sendEmail(message, {
      env: { EMAIL: binding },
      settings: { ...runtime, provider: APP_ID, resendApiKey: null, hasResendApiKey: false },
      appProviders: { resolve: async () => ({ provider: null, issue: "Activate Acme Mail in Apps to use it." }) } as never,
    });
    expect(result).toMatchObject({ success: true, provider: "cloudflare", providerRef: "cf_2" });
  });

  it("sends nothing when the app cannot run here and no built-in sender is configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await sendEmail(message, { settings: { ...runtime, provider: APP_ID, resendApiKey: null, hasResendApiKey: false } });
    expect(result).toMatchObject({ success: false, provider: "log" });
  });
});
