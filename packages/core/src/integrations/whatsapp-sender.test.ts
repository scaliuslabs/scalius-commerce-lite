import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ProviderError } from "@scalius/shared/plugins/providers";
import { whatsappDocument } from "../modules/settings/documents";
import type { AppProviders } from "./provider-port";
import { resolveWhatsAppSender } from "./whatsapp-sender";

const KEY = Buffer.alloc(32, 41).toString("base64");
const APP_ID = "acme.chat:whatsapp";

interface FakeProvider {
  id: string;
  label: string;
  channels?: readonly string[];
  send: ReturnType<typeof vi.fn>;
}

function appProviders(provider: FakeProvider | null, issue = "Acme Chat is not ready."): AppProviders {
  return {
    resolve: vi.fn(async () => (provider ? { provider, issue: null } : { provider: null, issue })) as unknown as AppProviders["resolve"],
  };
}

function fakeProvider(send: ReturnType<typeof vi.fn>, channels: readonly string[] | undefined = ["whatsapp"]): FakeProvider {
  return { id: APP_ID, label: "Acme Chat", ...(channels ? { channels } : {}), send };
}

async function storeWhatsApp(patch: Partial<Parameters<typeof whatsappDocument.write>[1]>) {
  const { db } = createSqliteD1Database();
  await whatsappDocument.write(db, patch, { encryptionKey: KEY });
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveWhatsAppSender, built in", () => {
  it("sends through the Meta Cloud API with the saved credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: "wamid.1", message_status: "accepted" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = await storeWhatsApp({ accessToken: "EAAG-real-token", phoneNumberId: "109876543210987", authTemplateName: "otp_login" });

    const sender = await resolveWhatsAppSender(db, { encryptionKey: KEY });

    expect(sender).toMatchObject({ ready: true, provider: "whatsapp", authTemplateName: "otp_login" });
    if (!sender.ready) throw new Error("expected a ready sender");
    const result = await sender.sendTemplate({
      to: "+8801712345678",
      templateName: "order_update",
      languageCode: "en_US",
      bodyParameters: ["Rina", "#1001"],
      clientReference: "ref-is-ignored-by-meta",
    });

    expect(result).toMatchObject({ success: true, providerRef: "wamid.1", rawStatus: "accepted" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/109876543210987/messages");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: "8801712345678", template: { name: "order_update" } });
    expect(init.body as string).not.toContain("ref-is-ignored-by-meta");
  });

  it("is not ready without credentials, or when the dedicated key cannot read them", async () => {
    const db = await storeWhatsApp({ accessToken: "EAAG-real-token", phoneNumberId: "109876543210987" });

    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY })).resolves.toMatchObject({ ready: true });
    await expect(resolveWhatsAppSender(db)).resolves.toMatchObject({
      ready: false,
      provider: "whatsapp",
      reason: expect.stringContaining("Meta WhatsApp Cloud API credentials"),
    });
    await expect(resolveWhatsAppSender(db, { encryptionKey: Buffer.alloc(32, 42).toString("base64") }))
      .resolves.toMatchObject({ ready: false });
  });

  it("never asks the app lookup while the built-in sender is chosen", async () => {
    const db = await storeWhatsApp({ accessToken: "EAAG-real-token", phoneNumberId: "109876543210987" });
    const apps = appProviders(null);

    await resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: apps });

    expect(apps.resolve).not.toHaveBeenCalled();
  });
});

describe("resolveWhatsAppSender, app provider", () => {
  it("sends a WhatsApp template through the chosen app with the platform reference", async () => {
    const send = vi.fn().mockResolvedValue({ success: true, providerRef: "app-msg-1", rawStatus: "queued" });
    const apps = appProviders(fakeProvider(send));
    const db = await storeWhatsApp({ provider: APP_ID, authTemplateName: "otp_login" });

    const sender = await resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: apps });

    expect(sender).toMatchObject({ ready: true, provider: APP_ID, authTemplateName: "otp_login" });
    expect(apps.resolve).toHaveBeenCalledWith("messaging", APP_ID);
    if (!sender.ready) throw new Error("expected a ready sender");
    const result = await sender.sendTemplate({
      to: "+8801712345678",
      templateName: "order_update",
      languageCode: "bn",
      bodyParameters: ["Rina", "  ", "#1001"],
      clientReference: "ord1whatsapp123",
    });

    expect(result).toEqual({ success: true, providerRef: "app-msg-1", rawStatus: "queued" });
    expect(send).toHaveBeenCalledWith({
      channel: "whatsapp",
      to: "+8801712345678",
      template: { name: "order_update", language: "bn", parameters: ["Rina", "#1001"] },
      clientReference: "ord1whatsapp123",
    }, {});
  });

  it("answers a failed send with a sanitized status and the provider's retry advice", async () => {
    const send = vi.fn().mockResolvedValue({ success: false, rawStatus: "Rejected +8801712345678 token=abc123", retryable: false });
    const db = await storeWhatsApp({ provider: APP_ID });
    const sender = await resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders(fakeProvider(send)) });
    if (!sender.ready) throw new Error("expected a ready sender");

    const result = await sender.sendTemplate({ to: "+8801712345678", templateName: "otp_login", bodyParameters: ["123456"] });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.rawStatus).toContain("[phone]");
    expect(result.rawStatus).not.toContain("8801712345678");
    expect(result.rawStatus).not.toContain("abc123");
  });

  it("turns a thrown ProviderError into an answer: retried only when sending twice is safe", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ProviderError("retryable", "Timed out", { uncertain: true }))
      .mockRejectedValueOnce(new ProviderError("retryable", "Timed out", { uncertain: true }))
      .mockRejectedValueOnce(new ProviderError("retryable", "Rate limited"))
      .mockRejectedValueOnce(new ProviderError("misconfigured", "Missing API key"))
      .mockRejectedValueOnce(new ProviderError("declined", "No such recipient"));
    const db = await storeWhatsApp({ provider: APP_ID });
    const sender = await resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders(fakeProvider(send)) });
    if (!sender.ready) throw new Error("expected a ready sender");
    const input = { to: "+8801712345678", templateName: "otp_login", bodyParameters: ["123456"] };

    // The provider may already have sent it: only a message with a reference is retried.
    expect(await sender.sendTemplate(input)).toMatchObject({ success: false, retryable: false });
    expect(await sender.sendTemplate({ ...input, clientReference: "ref1" })).toMatchObject({ success: false, retryable: true });
    expect(await sender.sendTemplate(input)).toMatchObject({ success: false, retryable: true });
    const misconfigured = await sender.sendTemplate(input);
    expect(misconfigured).toMatchObject({ success: false, retryable: false });
    expect(misconfigured.rawStatus).toContain("not configured");
    expect(await sender.sendTemplate(input)).toMatchObject({ success: false, retryable: false });
  });

  it("does not call the app for a template the port cannot carry", async () => {
    const send = vi.fn();
    const db = await storeWhatsApp({ provider: APP_ID });
    const sender = await resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders(fakeProvider(send)) });
    if (!sender.ready) throw new Error("expected a ready sender");

    const result = await sender.sendTemplate({ to: "+8801712345678", templateName: "", bodyParameters: [] });

    expect(result).toMatchObject({ success: false, retryable: false, rawStatus: "invalid_whatsapp_template" });
    expect(send).not.toHaveBeenCalled();
  });

  it("is not ready, with the merchant-facing reason, when the app cannot be used", async () => {
    const db = await storeWhatsApp({ provider: APP_ID });

    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders(null, "Acme Chat needs its access token.") }))
      .resolves.toEqual({ ready: false, provider: APP_ID, reason: "Acme Chat needs its access token." });
    // No lookup on this request: fail closed.
    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY }))
      .resolves.toMatchObject({ ready: false, provider: APP_ID });
  });

  it("is not ready when the app does not carry WhatsApp", async () => {
    const db = await storeWhatsApp({ provider: APP_ID });

    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders(fakeProvider(vi.fn(), ["messenger"])) }))
      .resolves.toMatchObject({ ready: false, provider: APP_ID, reason: expect.stringContaining("does not send on WhatsApp") });
    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY, appProviders: appProviders({ id: APP_ID, label: "Acme Chat", send: vi.fn() }) }))
      .resolves.toMatchObject({ ready: false });
  });

  it("reads a store saved before the provider setting as the built-in sender", async () => {
    const db = await storeWhatsApp({ accessToken: "EAAG-real-token", phoneNumberId: "109876543210987" });

    expect(await whatsappDocument.read(db)).toMatchObject({ provider: "" });
    await expect(resolveWhatsAppSender(db, { encryptionKey: KEY })).resolves.toMatchObject({ ready: true, provider: "whatsapp" });
  });
});
