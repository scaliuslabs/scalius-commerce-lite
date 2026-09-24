import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  orderPaymentRecoveryChallenges,
  orders,
  settings,
} from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  previewOrderPaymentRecoveryLink: vi.fn(),
  createOrderPaymentRecoveryLink: vi.fn(),
  enforceOtpSendRateLimits: vi.fn(),
  getEmailProviderReadiness: vi.fn(),
  getSmsProviderReadiness: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
}));

vi.mock("./admin/recovery-link", () => ({
  previewOrderPaymentRecoveryLink: mocks.previewOrderPaymentRecoveryLink,
  createOrderPaymentRecoveryLink: mocks.createOrderPaymentRecoveryLink,
}));

vi.mock("../customers/customer-auth-rate-limit", () => ({
  enforceOtpSendRateLimits: mocks.enforceOtpSendRateLimits,
}));

vi.mock("../../integrations/email", () => ({
  getEmailProviderReadiness: mocks.getEmailProviderReadiness,
}));

vi.mock("../../integrations/sms", () => ({
  getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));

vi.mock("../../integrations/whatsapp", () => ({
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
}));

import {
  sendOrderPaymentRecoveryOtp,
  verifyOrderPaymentRecoveryOtp,
} from "./payment-recovery";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";

const credentialEncryptionKey = Buffer.alloc(32, 8).toString("base64");

type FakeDbOptions = {
  updateRows?: unknown[][];
};

function createDb(options: FakeDbOptions = {}) {
  const updateRows = [...(options.updateRows ?? [])];
  const calls = {
    insertValues: undefined as unknown,
    updateSets: [] as unknown[],
  };

  const db = {
    calls,
    select: vi.fn(() => {
      let selectedTable: unknown;
      const query = {
        from: (table: unknown) => {
          selectedTable = table;
          return query;
        },
        where: () => query,
        orderBy: () => query,
        get: async () => {
          if (selectedTable === orderPaymentRecoveryChallenges) {
            return { challengeKey: "order_payrec:challenge", method: "phone", channel: "sms", identifierHash: "h" };
          }
          if (selectedTable === orders) {
            return {
              id: "order_1",
              customerName: "Buyer",
              customerPhone: "+8801775528888",
              customerEmail: "buyer@example.com",
            };
          }
          return null;
        },
        limit: async () => [],
        // Awaiting the query is the settings-document read.
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(selectedTable === settings
          ? [{
            category: "customer_auth",
            value: JSON.stringify({
              authVerificationMethod: "sms_otp",
              policy: { otpChannels: ["sms", "email"], defaultOtpChannel: "sms" },
            }),
            revision: 1,
          }]
          : []).then(resolve),
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (table === orderPaymentRecoveryChallenges) {
          calls.insertValues = values;
        }
        return {
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => table === orderPaymentRecoveryChallenges
              ? [{ challengeKey: (values as { challengeKey: string }).challengeKey }]
              : []),
          })),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        calls.updateSets.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateRows.shift() ?? []),
          })),
        };
      }),
    })),
  } as unknown as Database & { calls: typeof calls };

  return db;
}

describe("order payment recovery OTP service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewOrderPaymentRecoveryLink.mockResolvedValue({
      orderId: "order_1",
      gateway: "sslcommerz",
      paymentType: "deposit",
      depositAmount: 60,
      paymentRecovery: { state: "needs_attention" },
    });
    mocks.createOrderPaymentRecoveryLink.mockResolvedValue({
      orderId: "order_1",
      receiptToken: "chk_private_recovery",
      tokenHash: "hash",
      expiresAt: 1_765_000_000,
      gateway: "sslcommerz",
      paymentType: "deposit",
      depositAmount: 60,
      paymentRecovery: { state: "needs_attention" },
    });
    mocks.enforceOtpSendRateLimits.mockResolvedValue({ resendCooldownSeconds: 60 });
    mocks.getEmailProviderReadiness.mockResolvedValue({ status: "ready", issues: [] });
    mocks.getSmsProviderReadiness.mockResolvedValue({ status: "ready", issues: [] });
    mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
      accessToken: "wa_token",
      phoneNumberId: "wa_phone",
      authTemplateName: "auth_otp",
    });
  });

  it("persists hashed challenge state and queues purpose-specific OTP delivery", async () => {
    const db = createDb();

    const result = await sendOrderPaymentRecoveryOtp(db, {
      orderId: "order_1",
      channel: "sms",
      ip: "203.0.113.20",
      encryptionKey: "otp-signing-key",
      credentialEncryptionKey,
    });

    expect(result).toMatchObject({
      queued: true,
      channel: "sms",
      method: "phone",
      queuePayload: {
        type: "auth.send_otp",
        purpose: "order_payment_recovery",
        method: "phone",
        channel: "sms",
      },
    });
    expect(mocks.previewOrderPaymentRecoveryLink).toHaveBeenCalledWith(db, "order_1");
    expect(mocks.enforceOtpSendRateLimits).toHaveBeenCalledWith(db, {
      ip: "203.0.113.20",
      identifiers: [expect.stringMatching(/^order:/)],
      hashKey: "otp-signing-key",
    });
    expect(db.calls.insertValues).toMatchObject({
      orderId: "order_1",
      method: "phone",
      channel: "sms",
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
    });
    const persistedJson = JSON.stringify(db.calls.insertValues);
    const derivedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: result.challengeKey ?? "",
      deliveryKey: result.deliveryKey ?? "",
      encryptionKey: "otp-signing-key",
    });
    expect(persistedJson).not.toContain("+8801775528888");
    expect(persistedJson).not.toContain("buyer@example.com");
    expect(persistedJson).not.toContain("Buyer");
    expect(persistedJson).not.toContain(derivedCode);
    expect(result.queuePayload).not.toHaveProperty("code");
    expect(result.queuePayload).not.toHaveProperty("identifier");
    expect(result.queuePayload).not.toHaveProperty("name");
    expect(JSON.stringify(result.queuePayload)).not.toContain(derivedCode);
    expect(JSON.stringify(result.queuePayload)).not.toContain("+8801775528888");
    expect(JSON.stringify(result.queuePayload)).not.toContain("Buyer");
    expect(result.queuePayload).toMatchObject({
      challengeKey: result.challengeKey,
      deliveryKey: result.deliveryKey,
    });
    expect((db.calls.insertValues as { identifierHash: string }).identifierHash).toMatch(/^[a-f0-9]{64}$/);
    expect((db.calls.insertValues as { deliveryTargetEncrypted: string }).deliveryTargetEncrypted).toMatch(/^enc:/);
    expect((db.calls.insertValues as { deliveryNameEncrypted: string }).deliveryNameEncrypted).toMatch(/^enc:/);
    expect((db.calls.insertValues as { codeHash: string }).codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("consumes the verified challenge and mints a guest payment recovery receipt", async () => {
    const db = createDb({
      updateRows: [[{ challengeKey: "order_payrec:challenge" }]],
    });

    const result = await verifyOrderPaymentRecoveryOtp(db, {
      orderId: "order_1",
      code: "123456",
      encryptionKey: "otp-signing-key",
    });

    expect(result).toMatchObject({
      orderId: "order_1",
      receiptToken: "chk_private_recovery",
      gateway: "sslcommerz",
      redirectParams: {
        payment: "sslcommerz",
        result: "failed",
        paymentType: "deposit",
        depositAmount: 60,
      },
    });
    expect(db.calls.updateSets[0]).toMatchObject({ status: "consumed" });
    expect(mocks.createOrderPaymentRecoveryLink).toHaveBeenCalledWith(db, "order_1", {
      nowSeconds: expect.any(Number),
      source: "guest_payment_recovery",
    });
  });
});
