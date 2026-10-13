import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  sendEmail: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  sendWhatsAppTemplateMessage: vi.fn(),
  getActiveSmsProvider: vi.fn(),
  getNotificationProviderBlock: vi.fn(),
  isNotificationProviderBreakerFailure: vi.fn(),
  markNotificationProviderBlocked: vi.fn(),
  getCredentialEncryptionKey: vi.fn(() => "credential-key"),
  createAuthOtpDeliveryTarget: vi.fn(),
  claimAuthOtpDeliveryReceipt: vi.fn(),
  getAuthOtpDeliveryRetryDelaySeconds: vi.fn((attempts: number) => Math.min(3600, 30 * 2 ** (Math.max(1, attempts) - 1))),
  markAuthOtpDeliveryReceiptAccepted: vi.fn(),
  markAuthOtpDeliveryReceiptFailed: vi.fn(),
  markAuthOtpDeliveryReceiptSkipped: vi.fn(),
  createAuthOtpProviderClientReference: vi.fn(() => "otpclientref1"),
  readStoreIdentity: vi.fn(),
  appProviders: { current: null as unknown },
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  readStoreIdentity: mocks.readStoreIdentity,
  getNotificationProviderBlock: mocks.getNotificationProviderBlock,
  isNotificationProviderBreakerFailure: mocks.isNotificationProviderBreakerFailure,
  markNotificationProviderBlocked: mocks.markNotificationProviderBlocked,
}));

vi.mock("@scalius/core/modules/customers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/customers")>()),
  createAuthOtpDeliveryTarget: mocks.createAuthOtpDeliveryTarget,
  claimAuthOtpDeliveryReceipt: mocks.claimAuthOtpDeliveryReceipt,
  getAuthOtpDeliveryRetryDelaySeconds: mocks.getAuthOtpDeliveryRetryDelaySeconds,
  markAuthOtpDeliveryReceiptAccepted: mocks.markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptFailed: mocks.markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped: mocks.markAuthOtpDeliveryReceiptSkipped,
  createAuthOtpProviderClientReference: mocks.createAuthOtpProviderClientReference,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
  sendWhatsAppTemplateMessage: mocks.sendWhatsAppTemplateMessage,
}));

// A test that names an app WhatsApp sender supplies its lookup here; every
// other test keeps the real (lazy, built-in-only) detached lookup.
vi.mock("../plugins/providers/app-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/providers/app-providers")>();
  return {
    ...actual,
    detachedAppProviders: (...args: Parameters<typeof actual.detachedAppProviders>) =>
      (mocks.appProviders.current as ReturnType<typeof actual.detachedAppProviders> | null) ?? actual.detachedAppProviders(...args),
  };
});

vi.mock("@scalius/core/integrations/sms", () => ({
  getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

import { deliverAuthOtp, deliverAuthOtpWithRetries } from "./otp";
import type { OtpDelivery } from "@scalius/core/modules/customers";
import type { Database } from "@scalius/database/client";
import { deriveCustomerAuthOtpDeliveryCode } from "@scalius/core/modules/customers";
import { customerAuthOtpChallenges, orderPaymentRecoveryChallenges } from "@scalius/database/schema";
import { encodeEncryptedCredential, encryptCredentials } from "@scalius/core/utils/credential-encryption";

const otpDeliveryCredentialKey = Buffer.alloc(32, 6).toString("base64");
const otpIdentifierHash = "0123456789abcdef".repeat(4);

async function encryptOtpDeliveryValue(value: string): Promise<string> {
  return encodeEncryptedCredential(await encryptCredentials(value, otpDeliveryCredentialKey));
}

function createOtpChallengeDb(row: {
  deliveryTargetEncrypted: string | null;
  deliveryNameEncrypted: string | null;
  method: "email" | "phone";
  channel: "email" | "sms" | "whatsapp";
  expiresAt: number;
  orderNumber?: number | null;
} | null) {
  const tables: unknown[] = [];
  const where = vi.fn(() => ({
    get: vi.fn(async () => row),
  }));
  return {
    id: "db",
    tables,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        tables.push(table);
        return {
          where,
          // Order codes read their order number with the challenge row.
          leftJoin: vi.fn(() => ({ where })),
        };
      }),
    })),
  } as unknown as Database & { id: string; tables: unknown[] };
}


/**
 * A challenge row for an OTP delivery and the reference the request hands
 * over (references only): the target and the name are encrypted in the row,
 * and the code is derived from the challenge and delivery keys at send time.
 */
async function otpFixture(input: {
  deliveryKey: string;
  method: "email" | "phone";
  channel: "email" | "sms" | "whatsapp";
  identifier: string;
  name?: string;
  purpose?: string;
  expiresAt?: number;
}) {
  const challengeKey = `cust_otp:${input.channel}:${input.deliveryKey}`;
  const db = createOtpChallengeDb({
    deliveryTargetEncrypted: await encryptOtpDeliveryValue(input.identifier),
    deliveryNameEncrypted: input.name ? await encryptOtpDeliveryValue(input.name) : null,
    method: input.method,
    channel: input.channel,
    expiresAt: input.expiresAt ?? 4_102_444_800,
  });
  const body: OtpDelivery = { purpose: input.purpose ?? "customer_login", challengeKey, deliveryKey: input.deliveryKey, channel: input.channel };
  const code = await deriveCustomerAuthOtpDeliveryCode({ otpKey: challengeKey, deliveryKey: input.deliveryKey, encryptionKey: otpDeliveryCredentialKey });
  return { body, db, code };
}

describe("OTP delivery after the response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appProviders.current = null;
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.sendEmail.mockResolvedValue({
      success: true,
      provider: "cloudflare",
      providerRef: "cf_msg_1",
      rawStatus: "accepted",
    });
    mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
      accessToken: "wa_token",
      accessTokenConfigured: true,
      phoneNumberId: "phone_id_1",
      authTemplateName: "auth_otp",
    });
    mocks.sendWhatsAppTemplateMessage.mockResolvedValue({
      success: true,
      providerRef: "wamid.otp.1",
      rawStatus: "accepted",
      rawResponse: JSON.stringify({ messageId: "wamid.otp.1", messageStatus: "accepted" }),
    });
    mocks.getActiveSmsProvider.mockResolvedValue(null);
    mocks.readStoreIdentity.mockResolvedValue({ name: "River & Loom", logoUrl: null, language: "en" });
    mocks.getNotificationProviderBlock.mockResolvedValue(null);
    mocks.isNotificationProviderBreakerFailure.mockImplementation((value: string | null | undefined) => {
      const status = value?.trim() ?? "";
      return /auth(?:orization|entication)?\s+(?:required|failed|error)/i.test(status)
        || /unauthori[sz]ed/i.test(status)
        || /forbidden/i.test(status)
        || /invalid\s+(?:api\s*)?(?:key|token|credential)/i.test(status)
        || /could not be decrypted/i.test(status)
        || /\b(?:http|status|code|error)[^0-9]*(?:401|402|403|405)\b/i.test(status);
    });
    mocks.markNotificationProviderBlocked.mockResolvedValue(undefined);
    mocks.createAuthOtpDeliveryTarget.mockImplementation(async (input) => ({
      ...input,
      purpose: input.purpose ?? "customer_login",
      identifierHash: otpIdentifierHash,
      identifierMasked: "b***@example.com",
      otpExpiresAt: input.otpExpiresAt ?? null,
    }));
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValue({
      claimed: true,
      receipt: {
        id: "aor_1",
        deliveryKey: "otp_delivery_1",
        claimId: "aorc_1",
        attempts: 1,
      },
    });
    mocks.markAuthOtpDeliveryReceiptAccepted.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptFailed.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptSkipped.mockResolvedValue(undefined);
    mocks.getAuthOtpDeliveryRetryDelaySeconds.mockImplementation((attempts: number) =>
      Math.min(60, 2 * 3 ** (Math.max(1, attempts) - 1)),
    );
    mocks.createAuthOtpProviderClientReference.mockReturnValue("otpclientref1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes env and encryption context to OTP email dispatch", async () => {
    const challengeKey = "cust_otp:email:challenge_hash_1";
    const deliveryKey = "otp_delivery_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("buyer@example.com"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Buyer"),
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    // One key: CREDENTIAL_ENCRYPTION_KEY decrypts the D1 delivery target,
    // derives the OTP code, and is handed to the provider dispatch context.
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = { body: { purpose: "customer_login", challengeKey: challengeKey, deliveryKey: deliveryKey, channel: "email" } satisfies OtpDelivery, db };
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(JSON.stringify(message.body)).not.toContain("buyer@example.com");
    expect(JSON.stringify(message.body)).not.toContain("Buyer");
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    const env = {
      EMAIL: {
        send: vi.fn(),
      },
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as unknown as Env;

    const outcome = await deliverAuthOtp(message.body, message.db, env);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.com",
        subject: `${expectedCode} is your River & Loom code`,
        fromName: "River & Loom",
        text: expect.stringContaining(`Use this code to sign in or create your account at River & Loom.\n\n${expectedCode}\n\nThis code expires in 5 minutes.`),
        html: expect.stringContaining('<html lang="en">'),
        idempotencyKey: deliveryKey,
      }),
      {
        db,
        env,
        encryptionKey: otpDeliveryCredentialKey,
        appProviders: expect.objectContaining({ resolve: expect.any(Function) }),
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      db,
      {
        id: "aor_1",
        deliveryKey,
        claimId: "aorc_1",
        attempts: 1,
      },
      {
        provider: "cloudflare",
        providerMessageId: "cf_msg_1",
        providerStatus: "accepted",
      },
    );
    expect(outcome).toEqual({ status: "done" });
  });

  it("sends payment recovery OTPs after resolving encrypted delivery targets from D1", async () => {
    const challengeKey = "order_payrec:challenge_hash_1";
    const deliveryKey = "otp_delivery_payrec_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("recovery-buyer@example.com"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Recovery Buyer"),
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
      orderNumber: 1048,
    });
    // One key: CREDENTIAL_ENCRYPTION_KEY decrypts the D1 delivery target,
    // derives the OTP code, and is handed to the provider dispatch context.
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = { body: { purpose: "order_payment_recovery", challengeKey: challengeKey, deliveryKey: deliveryKey, channel: "email" } satisfies OtpDelivery, db };
    expect(JSON.stringify(message.body)).not.toContain("recovery-buyer@example.com");
    expect(JSON.stringify(message.body)).not.toContain("Recovery Buyer");
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(message.body).not.toHaveProperty("code");

    const env = {
      EMAIL: {
        send: vi.fn(),
      },
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as unknown as Env;

    const outcome = await deliverAuthOtp(message.body, message.db, env);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recovery-buyer@example.com",
        subject: `${expectedCode} is your River & Loom code`,
        text: expect.stringContaining("Use this code to finish paying for order #1048 at River & Loom."),
        idempotencyKey: deliveryKey,
      }),
      {
        db,
        env,
        encryptionKey: otpDeliveryCredentialKey,
        appProviders: expect.objectContaining({ resolve: expect.any(Function) }),
      },
    );
    expect(db.tables).toEqual([orderPaymentRecoveryChallenges]);
    expect(outcome).toEqual({ status: "done" });
  });

  it("resolves track-order codes from the order challenge table and names the store in Bangla without a buyer name", async () => {
    const challengeKey = "order_lookup:challenge_hash_1";
    const deliveryKey = "otp_delivery_lookup_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("lookup-buyer@example.com"),
      deliveryNameEncrypted: null,
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
      orderNumber: 1057,
    });
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    mocks.readStoreIdentity.mockResolvedValue({ name: "River & Loom", logoUrl: null, language: "bn" });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = { body: { purpose: "order_lookup", challengeKey: challengeKey, deliveryKey: deliveryKey, channel: "email" } satisfies OtpDelivery, db };

    const outcome = await deliverAuthOtp(message.body, message.db, { CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey } as unknown as Env);

    expect(db.tables).toEqual([orderPaymentRecoveryChallenges]);
    expect(mocks.readStoreIdentity).toHaveBeenCalledTimes(1);
    const email = mocks.sendEmail.mock.calls[0]![0];
    expect(email).toMatchObject({
      to: "lookup-buyer@example.com",
      subject: `River & Loom-এর কোড ${expectedCode}`,
      fromName: "River & Loom",
    });
    expect(email.html).toContain('<html lang="bn">');
    expect(email.text).toContain("হ্যালো,\n\nRiver & Loom-এ অর্ডার #1057 দেখতে এই কোডটি ব্যবহার করুন।");
    expect(`${email.html}${email.text}`).not.toContain("Customer");
    expect(outcome).toEqual({ status: "done" });
  });

  it("keeps sign-in codes on the customer challenge table and sends them unbranded when settings cannot load", async () => {
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("buyer@example.com"),
      deliveryNameEncrypted: null,
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    mocks.readStoreIdentity.mockRejectedValue(new Error("settings unavailable"));
    const message = { body: { purpose: "customer_login", challengeKey: "cust_otp:email:challenge_hash_2", deliveryKey: "otp_delivery_2", channel: "email" } satisfies OtpDelivery, db };

    const outcome = await deliverAuthOtp(message.body, message.db, { CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey } as unknown as Env);

    expect(db.tables).toEqual([customerAuthOtpChallenges]);
    const email = mocks.sendEmail.mock.calls[0]![0];
    expect(email.subject).toMatch(/^\d{6} is your verification code$/);
    expect(email.fromName).toBeUndefined();
    expect(email.text).toMatch(/^Hi,\n\nUse this code to sign in or create your account\./);
    expect(outcome).toEqual({ status: "done" });
  });

  it("terminally skips new OTP payloads when the D1 delivery target row is missing", async () => {
    const challengeKey = "cust_otp:email:missing_target";
    const deliveryKey = "otp_delivery_missing_target";
    const db = createOtpChallengeDb(null);
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: true,
      receipt: {
        id: "aor_missing_target",
        deliveryKey,
        claimId: "aorc_missing_target",
        attempts: 1,
      },
    });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: "credential-key",
    });
    const message = { body: { purpose: "customer_login", challengeKey: challengeKey, deliveryKey: deliveryKey, channel: "email" } satisfies OtpDelivery, db };

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(mocks.createAuthOtpDeliveryTarget).toHaveBeenCalledWith(expect.objectContaining({
      deliveryKey,
      identifier: `unresolved:${deliveryKey}`,
    }));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "aor_missing_target", deliveryKey }),
      "missing_delivery_target",
      {
        provider: "email",
        providerStatus: "missing_delivery_target",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: "done" });
  });

  it("terminally skips new OTP payloads when the encrypted D1 delivery target cannot decrypt", async () => {
    const challengeKey = "cust_otp:sms:decrypt_failure";
    const deliveryKey = "otp_delivery_decrypt_failure";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("+8801712345678"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Decrypt Buyer"),
      method: "phone",
      channel: "sms",
      expiresAt: 4_102_444_800,
    });
    mocks.getCredentialEncryptionKey.mockReturnValueOnce(Buffer.alloc(32, 7).toString("base64"));
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: true,
      receipt: {
        id: "aor_decrypt_failure",
        deliveryKey,
        claimId: "aorc_decrypt_failure",
        attempts: 1,
      },
    });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: "credential-key",
    });
    const message = { body: { purpose: "customer_login", challengeKey: challengeKey, deliveryKey: deliveryKey, channel: "sms" } satisfies OtpDelivery, db };

    const outcome = await deliverAuthOtp(message.body, message.db, {
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as Env);

    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(JSON.stringify(message.body)).not.toContain("+8801712345678");
    expect(JSON.stringify(message.body)).not.toContain("Decrypt Buyer");
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(mocks.createAuthOtpDeliveryTarget).toHaveBeenCalledWith(expect.objectContaining({
      deliveryKey,
      channel: "sms",
      identifier: `unresolved:${deliveryKey}`,
    }));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "aor_decrypt_failure", deliveryKey }),
      "delivery_target_decrypt_failed",
      {
        provider: "sms",
        providerStatus: "delivery_target_decrypt_failed",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: "done" });
  });

  it("keeps OTP identifiers and codes out of every log", async () => {
    const message = await otpFixture({ deliveryKey: "otp_delivery_private", method: "email", channel: "email", identifier: "private-buyer@example.com", name: "Private Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as Env);

    expect(outcome).toEqual({ status: "done" });
    const allQueueLogs = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ].map(([entry]) => String(entry)).join("\n");

    expect(allQueueLogs).not.toContain("private-buyer@example.com");
    expect(allQueueLogs).not.toContain(message.code);
    expect(allQueueLogs).not.toContain(otpIdentifierHash);
    expect(allQueueLogs).toContain(`recipientHashPrefix=${otpIdentifierHash.slice(0, 12)}`);
  });

  it("skips OTP email when providers fall back to local logging", async () => {
    mocks.sendEmail.mockResolvedValue({
      success: false,
      provider: "log",
      rawStatus: "No configured email provider available; email not delivered",
    });
    const message = await otpFixture({ deliveryKey: "otp_delivery_1", method: "email", channel: "email", identifier: "buyer@example.com", name: "Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
      message.db,
      {
        channel: "email",
        provider: "email",
        reason: "No configured email provider available; email not delivered",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "No configured email provider available; email not delivered",
      {
        provider: "log",
        providerMessageId: undefined,
        providerStatus: "No configured email provider available; email not delivered",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: "done" });
  });

  it("passes deterministic OTP client references to the active SMS provider", async () => {
    const smsProvider = {
      id: "gennet",
      label: "GenNet iSMS",
      send: vi.fn().mockResolvedValue({
        success: true,
        providerRef: "sms_ref_1",
        rawStatus: "SUCCESS",
      }),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    const message = await otpFixture({ deliveryKey: "otp_delivery_sms_1", method: "phone", channel: "sms", identifier: "+8801712345678", name: "Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(smsProvider.send).toHaveBeenCalledWith({
      to: "+8801712345678",
      message: `${message.code} is your River & Loom code. It expires in 5 minutes. Don't share it.`,
      clientReference: "otpclientref1",
    }, {});
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      {
        provider: "gennet",
        providerMessageId: "sms_ref_1",
        providerStatus: "SUCCESS",
      },
    );
    expect(outcome).toEqual({ status: "done" });
  });

  it("skips and blocks SMS OTP when provider credentials are rejected", async () => {
    const smsProvider = {
      id: "smsnetbd",
      label: "SMS.net.bd",
      send: vi.fn().mockResolvedValue({
        success: false,
        rawStatus: "error=405: Authorization required",
        retryable: false,
      }),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    const message = await otpFixture({ deliveryKey: "otp_delivery_sms_bad_creds", method: "phone", channel: "sms", identifier: "+8801712345678", name: "Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(smsProvider.send).toHaveBeenCalledTimes(1);
    expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
      message.db,
      {
        channel: "sms",
        provider: "smsnetbd",
        reason: "error=405: Authorization required",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "error=405: Authorization required",
      {
        provider: "smsnetbd",
        providerMessageId: undefined,
        providerStatus: "error=405: Authorization required",
        rawResponse: undefined,
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: "done" });
  });

  it("skips SMS OTP provider calls while provider is blocked until settings save", async () => {
    const smsProvider = {
      id: "smsnetbd",
      label: "SMS.net.bd",
      send: vi.fn(),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    mocks.getNotificationProviderBlock.mockResolvedValueOnce({
      channel: "sms",
      provider: "smsnetbd",
      reason: "error=405: Authorization required",
      blockedAt: 1_800,
    });
    const message = await otpFixture({ deliveryKey: "otp_delivery_sms_blocked", method: "phone", channel: "sms", identifier: "+8801712345678", name: "Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(smsProvider.send).not.toHaveBeenCalled();
    expect(mocks.markNotificationProviderBlocked).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "provider_blocked_until_settings_save: error=405: Authorization required",
      {
        provider: "smsnetbd",
        providerMessageId: undefined,
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: "error=405: Authorization required",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: "done" });
  });

  it("leaves a receipt another attempt holds instead of waiting out its lease", async () => {
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: false,
      reason: "busy",
      retryAfterSeconds: 240,
    });
    const message = await otpFixture({ deliveryKey: "otp_delivery_busy", method: "email", channel: "email", identifier: "buyer@example.com", name: "Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "busy" });
  });

  it("waits out a short receipt backoff inline", async () => {
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({ claimed: false, reason: "busy", retryAfterSeconds: 2 });
    const message = await otpFixture({ deliveryKey: "otp_delivery_backoff", method: "email", channel: "email", identifier: "buyer@example.com" });

    await expect(deliverAuthOtp(message.body, message.db, {} as Env)).resolves.toEqual({ status: "retry", retryAfterSeconds: 2 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("retries a retryable failure inline after the receipt's backoff, and stops after three attempts", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    mocks.sendEmail.mockRejectedValueOnce(new Error("provider unavailable"));
    mocks.claimAuthOtpDeliveryReceipt
      .mockResolvedValueOnce({ claimed: true, receipt: { id: "aor_1", deliveryKey: "otp_inline", claimId: "c1", attempts: 1 } })
      .mockResolvedValueOnce({ claimed: true, receipt: { id: "aor_1", deliveryKey: "otp_inline", claimId: "c2", attempts: 2 } });
    const message = await otpFixture({ deliveryKey: "otp_inline", method: "email", channel: "email", identifier: "buyer@example.com" });

    await deliverAuthOtpWithRetries(message.body, message.db as never, {} as Env, wait);

    expect(waits).toEqual([2_000]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.markAuthOtpDeliveryReceiptFailed).toHaveBeenCalledTimes(1);
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    waits.length = 0;
    mocks.createAuthOtpDeliveryTarget.mockImplementation(async (input) => ({ ...input, identifierHash: otpIdentifierHash, identifierMasked: "b***", otpExpiresAt: input.otpExpiresAt ?? null }));
    mocks.readStoreIdentity.mockResolvedValue({ name: "River & Loom", logoUrl: null, language: "en" });
    mocks.getNotificationProviderBlock.mockResolvedValue(null);
    mocks.isNotificationProviderBreakerFailure.mockReturnValue(false);
    mocks.getAuthOtpDeliveryRetryDelaySeconds.mockImplementation((attempts: number) => Math.min(60, 2 * 3 ** (Math.max(1, attempts) - 1)));
    mocks.sendEmail.mockRejectedValue(new Error("provider unavailable"));
    for (const attempts of [1, 2, 3]) {
      mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({ claimed: true, receipt: { id: "aor_1", deliveryKey: "otp_inline", claimId: `c${attempts}`, attempts } });
    }

    await deliverAuthOtpWithRetries(message.body, message.db as never, {} as Env, wait);

    expect(waits).toEqual([2_000, 6_000]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.markAuthOtpDeliveryReceiptFailed).toHaveBeenCalledTimes(3);
  });

  it("never sends again when the accepted receipt write fails after the provider took the code", async () => {
    mocks.markAuthOtpDeliveryReceiptAccepted.mockRejectedValue(new Error("D1 queue overloaded"));
    const message = await otpFixture({ deliveryKey: "otp_delivery_accept_write_fail", method: "email", channel: "email", identifier: "private-buyer@example.com", name: "Private Buyer" });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledTimes(3);
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "done" });
  });

  describe("WhatsApp OTP through a chat app", () => {
    const APP_ID = "acme.chat:whatsapp";
    const appSend = vi.fn();
    const otpMessage = (deliveryKey: string) => otpFixture({ deliveryKey, method: "phone", channel: "whatsapp", identifier: "+8801712345678", name: "Buyer" });

    function chooseApp(provider: { channels: readonly string[] } | null = { channels: ["whatsapp"] }, issue = "Acme Chat needs its access token.") {
      mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
        accessToken: undefined,
        accessTokenConfigured: false,
        phoneNumberId: undefined,
        authTemplateName: "otp_login",
        provider: APP_ID,
      });
      mocks.appProviders.current = {
        resolve: vi.fn(async () => (provider
          ? { provider: { id: APP_ID, label: "Acme Chat", ...provider, send: appSend }, issue: null }
          : { provider: null, issue })),
      };
    }

    it("sends the code as a template through the app, with the platform reference, and records the app as provider", async () => {
      chooseApp();
      appSend.mockResolvedValue({ success: true, providerRef: "acme-otp-1", rawStatus: "queued" });
      const message = await otpMessage("otp_delivery_wa_app_1");

      const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

      expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      expect(mocks.getNotificationProviderBlock).toHaveBeenCalledWith(message.db, { channel: "whatsapp", provider: APP_ID });
      expect(appSend).toHaveBeenCalledWith({
        channel: "whatsapp",
        to: "+8801712345678",
        template: { name: "otp_login", language: "en_US", parameters: [message.code] },
        clientReference: "otpclientref1",
      }, {});
      expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
        message.db,
        expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
        expect.objectContaining({ provider: APP_ID, providerMessageId: "acme-otp-1", providerStatus: "queued" }),
      );
      const logs = [
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.warn).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ].map(([entry]) => String(entry)).join("\n");
      expect(logs).not.toContain(message.code);
      expect(logs).not.toContain("+8801712345678");
      expect(outcome).toEqual({ status: "done" });
    });

    it("skips and pauses only the app when it declines the message for good", async () => {
      chooseApp();
      appSend.mockResolvedValue({ success: false, rawStatus: "Acme Chat is not configured: missing token", retryable: false });
      const message = await otpMessage("otp_delivery_wa_app_2");

      const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

      expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
        message.db,
        expect.objectContaining({ channel: "whatsapp", provider: APP_ID }),
      );
      expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalled();
      expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
            expect(outcome).toEqual({ status: "done" });
    });

    it("retries a send the app says may succeed later", async () => {
      chooseApp();
      appSend.mockResolvedValue({ success: false, rawStatus: "temporarily unavailable", retryable: true });
      const message = await otpMessage("otp_delivery_wa_app_3");

      const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

      expect(mocks.markAuthOtpDeliveryReceiptFailed).toHaveBeenCalled();
      expect(mocks.markAuthOtpDeliveryReceiptSkipped).not.toHaveBeenCalled();
      expect(outcome).toEqual({ status: "retry", retryAfterSeconds: 2 });
    });

    it("skips while the app is paused until its settings are saved, without calling it", async () => {
      chooseApp();
      mocks.getNotificationProviderBlock.mockResolvedValueOnce({
        channel: "whatsapp",
        provider: APP_ID,
        reason: "Acme Chat is not configured: missing token",
        blockedAt: 1_800,
      });
      const message = await otpMessage("otp_delivery_wa_app_4");

      await deliverAuthOtp(message.body, message.db, {} as Env);

      expect(appSend).not.toHaveBeenCalled();
      expect(mocks.markNotificationProviderBlocked).not.toHaveBeenCalled();
      expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
        message.db,
        expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
        "provider_blocked_until_settings_save: Acme Chat is not configured: missing token",
        expect.objectContaining({ provider: APP_ID, providerStatus: "provider_blocked_until_settings_save" }),
      );
          });

    it("skips and pauses the app when it is not ready (not installed, inactive, or no WhatsApp channel)", async () => {
      chooseApp(null);
      const message = await otpMessage("otp_delivery_wa_app_5");

      await deliverAuthOtp(message.body, message.db, {} as Env);

      expect(appSend).not.toHaveBeenCalled();
      expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
        message.db,
        expect.objectContaining({ channel: "whatsapp", provider: APP_ID }),
      );
      expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
        message.db,
        expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
        "provider_not_ready",
        expect.objectContaining({ provider: APP_ID, providerStatus: "provider_not_ready" }),
      );
          });
  });

  it("records WhatsApp OTP message IDs after resolving encrypted Meta credentials", async () => {
    const message = await otpFixture({ deliveryKey: "otp_delivery_wa_1", method: "phone", channel: "whatsapp", identifier: "+8801712345678" });
    const expectedCode = message.code;
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("code");

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(message.db, otpDeliveryCredentialKey);
    expect(mocks.sendWhatsAppTemplateMessage).toHaveBeenCalledWith({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "auth_otp",
      languageCode: "en_US",
      bodyParameters: [expectedCode],
    });
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      {
        provider: "whatsapp",
        providerMessageId: "wamid.otp.1",
        providerStatus: "accepted",
        rawResponse: JSON.stringify({ messageId: "wamid.otp.1", messageStatus: "accepted" }),
      },
    );
    expect(outcome).toEqual({ status: "done" });
  });

  it("skips expired OTP deliveries instead of sending stale codes", async () => {
    const message = await otpFixture({ deliveryKey: "otp_delivery_expired_1", method: "email", channel: "email", identifier: "buyer@example.com", name: "Buyer", expiresAt: 1 });

    const outcome = await deliverAuthOtp(message.body, message.db, {} as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      message.db,
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "otp_expired",
      {
        provider: "email",
        providerStatus: "otp_expired",
      },
    );
    expect(outcome).toEqual({ status: "done" });
  });
});

