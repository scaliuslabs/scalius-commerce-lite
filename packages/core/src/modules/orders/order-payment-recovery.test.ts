import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  orderPaymentRecoveryChallenges,
  orders,
  settings as genericSettings,
  siteSettings,
} from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  previewOrderPaymentRecoveryLink: vi.fn(),
  createOrderPaymentRecoveryLink: vi.fn(),
  enforceCustomerAuthOtpIpRateLimit: vi.fn(),
  getEmailProviderReadiness: vi.fn(),
  getSmsProviderReadiness: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
}));

vi.mock("./orders.admin", () => ({
  previewOrderPaymentRecoveryLink: mocks.previewOrderPaymentRecoveryLink,
  createOrderPaymentRecoveryLink: mocks.createOrderPaymentRecoveryLink,
}));

vi.mock("../customers/customer-auth-rate-limit", () => ({
  enforceCustomerAuthOtpIpRateLimit: mocks.enforceCustomerAuthOtpIpRateLimit,
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
} from "./order-payment-recovery";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";

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
        get: async () => {
          if (selectedTable === orders) {
            return {
              id: "order_1",
              customerName: "Buyer",
              customerPhone: "+8801775528888",
              customerEmail: "buyer@example.com",
            };
          }
          if (selectedTable === genericSettings) {
            return {
              value: JSON.stringify({
                otpChannels: ["sms", "email"],
                defaultOtpChannel: "sms",
                emailCollection: "optional",
              }),
            };
          }
          return null;
        },
        limit: async () => {
          if (selectedTable === siteSettings) {
            return [{ authVerificationMethod: "sms_otp" }];
          }
          return [];
        },
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
    mocks.enforceCustomerAuthOtpIpRateLimit.mockResolvedValue(undefined);
    mocks.getEmailProviderReadiness.mockResolvedValue({ configured: true });
    mocks.getSmsProviderReadiness.mockResolvedValue({ configured: true });
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
      credentialEncryptionKey: "credential-key",
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
        identifier: "+8801775528888",
      },
    });
    expect(mocks.previewOrderPaymentRecoveryLink).toHaveBeenCalledWith(db, "order_1");
    expect(mocks.enforceCustomerAuthOtpIpRateLimit).toHaveBeenCalledWith(db, {
      ip: "203.0.113.20",
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
    expect(persistedJson).not.toContain(derivedCode);
    expect(result.queuePayload).not.toHaveProperty("code");
    expect(JSON.stringify(result.queuePayload)).not.toContain(derivedCode);
    expect((db.calls.insertValues as { identifierHash: string }).identifierHash).toMatch(/^[a-f0-9]{64}$/);
    expect((db.calls.insertValues as { codeHash: string }).codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("consumes the verified challenge and mints a guest payment recovery receipt", async () => {
    const db = createDb({
      updateRows: [[{ challengeKey: "order_payrec:challenge" }]],
    });

    const result = await verifyOrderPaymentRecoveryOtp(db, {
      orderId: "order_1",
      channel: "sms",
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
