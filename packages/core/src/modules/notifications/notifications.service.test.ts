import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
    getNotificationChannels: vi.fn(),
    getActiveSmsProvider: vi.fn(),
    sendEmail: vi.fn(),
    sendSms: vi.fn(),
    getFirebaseAdminMessaging: vi.fn(),
    sendEachForMulticast: vi.fn(),
    createOrderNotificationDeliveryTarget: vi.fn(),
    claimOrderNotificationDeliveryReceipt: vi.fn(),
    markOrderNotificationDeliveryReceiptAccepted: vi.fn(),
    markOrderNotificationDeliveryReceiptFailed: vi.fn(),
    markOrderNotificationDeliveryReceiptSkipped: vi.fn(),
    createProviderClientReference: vi.fn(),
}));

vi.mock("../settings/settings.service", () => ({
    getNotificationChannels: mocks.getNotificationChannels,
}));

vi.mock("../../integrations/sms", () => ({
    getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("../../integrations/email", () => ({
    sendEmail: mocks.sendEmail,
}));

vi.mock("../../integrations/firebase/admin", () => ({
    getFirebaseAdminMessaging: mocks.getFirebaseAdminMessaging,
}));

vi.mock("./order-notification-delivery-receipts", () => ({
    createOrderNotificationDeliveryTarget: mocks.createOrderNotificationDeliveryTarget,
    claimOrderNotificationDeliveryReceipt: mocks.claimOrderNotificationDeliveryReceipt,
    markOrderNotificationDeliveryReceiptAccepted: mocks.markOrderNotificationDeliveryReceiptAccepted,
    markOrderNotificationDeliveryReceiptFailed: mocks.markOrderNotificationDeliveryReceiptFailed,
    markOrderNotificationDeliveryReceiptSkipped: mocks.markOrderNotificationDeliveryReceiptSkipped,
    createProviderClientReference: mocks.createProviderClientReference,
}));

import { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";

function createDb(customerPhone = "+8801700000000"): Database {
    return {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    get: vi.fn(async () => ({ customerPhone })),
                })),
            })),
        })),
    } as unknown as Database;
}

describe("order notification dispatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        mocks.getFirebaseAdminMessaging.mockReturnValue({
            sendEachForMulticast: mocks.sendEachForMulticast,
        });
        mocks.sendEachForMulticast.mockResolvedValue({
            failureCount: 0,
            responses: [],
        });
        mocks.sendEmail.mockResolvedValue({
            success: true,
            provider: "cloudflare",
            providerRef: "cf_msg_1",
            rawStatus: "accepted",
        });
        mocks.createOrderNotificationDeliveryTarget.mockImplementation(async (input: Record<string, unknown>) => ({
            ...input,
            receiptKey: `${input.outboxId}:${input.channel}:recipient_hash`,
            recipientHash: "recipient_hash",
            recipientMasked: input.recipientMasked ?? "masked-recipient",
        }));
        mocks.claimOrderNotificationDeliveryReceipt.mockResolvedValue({
            claimed: true,
            receipt: {
                id: "receipt_1",
                receiptKey: "outbox_1:email:recipient_hash",
                claimId: "claim_1",
                attempts: 1,
            },
        });
        mocks.markOrderNotificationDeliveryReceiptAccepted.mockResolvedValue(undefined);
        mocks.markOrderNotificationDeliveryReceiptFailed.mockResolvedValue(undefined);
        mocks.markOrderNotificationDeliveryReceiptSkipped.mockResolvedValue(undefined);
        mocks.createProviderClientReference.mockReturnValue("client_ref_1");
    });

    it("keeps the shared notification type list complete", () => {
        expect(ORDER_NOTIFICATION_TYPES).toEqual([
            "order_created",
            "order_confirmed",
            "order_processing",
            "order_shipped",
            "order_delivered",
            "order_completed",
            "order_cancelled",
            "order_returned",
            "order_refunded",
        ]);
    });

    it("passes the credential encryption key when resolving SMS providers", async () => {
        const db = createDb();
        mocks.getNotificationChannels.mockResolvedValue({
            order_refunded: ["sms"],
        });
        mocks.sendSms.mockResolvedValue({ success: true, providerRef: "sms_1" });
        mocks.getActiveSmsProvider.mockResolvedValue({
            name: "Test SMS",
            sendSms: mocks.sendSms,
        });

        await sendOrderNotificationEmail(
            undefined,
            "SMS Customer",
            "order_1",
            "order_refunded",
            {},
            db,
            { encryptionKey: "credential-key" },
        );

        expect(mocks.getActiveSmsProvider).toHaveBeenCalledWith(
            db,
            "credential-key",
        );
        expect(mocks.sendSms).toHaveBeenCalledWith({
            to: "+8801700000000",
            message:
                "Hi SMS Customer, your order #order_1 has been refunded. Contact us if you have questions.",
        });
    });

    it("passes runtime context when sending order emails", async () => {
        const db = createDb();
        const emailEnv = {
            EMAIL: {
                send: vi.fn(),
            },
        };
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["email"],
        });
        mocks.sendEmail.mockResolvedValue(undefined);

        await sendOrderNotificationEmail(
            "buyer@example.com",
            "Email Customer",
            "order_2",
            "order_created",
            {},
            db,
            {
                encryptionKey: "credential-key",
                env: emailEnv,
            },
        );

        expect(mocks.sendEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: "buyer@example.com",
                subject: "Order #order_2 Received",
            }),
            {
                db,
                env: emailEnv,
                encryptionKey: "credential-key",
            },
        );
    });

    it("records durable email receipts and passes the receipt key to email providers", async () => {
        const db = createDb();
        const emailEnv = {
            EMAIL: {
                send: vi.fn(),
            },
        };
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["email"],
        });

        const result = await sendOrderNotificationEmail(
            "buyer@example.com",
            "Email Customer",
            "order_3",
            "order_created",
            {},
            db,
            {
                encryptionKey: "credential-key",
                env: emailEnv,
                outboxId: "outbox_1",
            },
        );

        expect(mocks.createOrderNotificationDeliveryTarget).toHaveBeenCalledWith(
            expect.objectContaining({
                outboxId: "outbox_1",
                orderId: "order_3",
                notificationType: "order_created",
                channel: "email",
                provider: "email",
                recipient: "buyer@example.com",
            }),
        );
        expect(mocks.sendEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: "buyer@example.com",
                idempotencyKey: "outbox_1:email:recipient_hash",
            }),
            {
                db,
                env: emailEnv,
                encryptionKey: "credential-key",
            },
        );
        expect(mocks.markOrderNotificationDeliveryReceiptAccepted).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            expect.objectContaining({
                provider: "cloudflare",
                providerMessageId: "cf_msg_1",
            }),
        );
        expect(result.hasRetryableFailure).toBe(false);
    });

    it("passes a deterministic client reference to SMS providers when receipts are enabled", async () => {
        const db = createDb();
        mocks.getNotificationChannels.mockResolvedValue({
            order_refunded: ["sms"],
        });
        mocks.sendSms.mockResolvedValue({ success: true, providerRef: "sms_1", rawStatus: "accepted" });
        mocks.getActiveSmsProvider.mockResolvedValue({
            name: "gennet",
            sendSms: mocks.sendSms,
        });

        await sendOrderNotificationEmail(
            undefined,
            "SMS Customer",
            "order_4",
            "order_refunded",
            {},
            db,
            {
                encryptionKey: "credential-key",
                outboxId: "outbox_sms_1",
            },
        );

        expect(mocks.createProviderClientReference).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: "sms",
                receiptKey: "outbox_sms_1:sms:recipient_hash",
            }),
        );
        expect(mocks.sendSms).toHaveBeenCalledWith({
            to: "+8801700000000",
            message:
                "Hi SMS Customer, your order #order_4 has been refunded. Contact us if you have questions.",
            clientReference: "client_ref_1",
        });
    });

    it("labels admin push payloads by notification type", async () => {
        const tokenRows = [{ token: "fcm_token_1" }];
        const db = {
            select: vi.fn(() => ({
                from: vi.fn(() => ({
                    where: vi.fn(() => ({
                        get: vi.fn(async () => null),
                        then: (resolve: (value: typeof tokenRows) => void) => Promise.resolve(tokenRows).then(resolve),
                    })),
                })),
            })),
        } as unknown as Database;

        await sendOrderNotification(
            db,
            {
                id: "order_1",
                customerName: "Push Customer",
                notificationType: "order_delivered",
            },
            { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
            "https://api.example.test",
        );

        expect(mocks.sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
            notification: {
                title: "Order Delivered",
                body: "Order Delivered: Order order_1 from Push Customer. Click to view.",
            },
            data: expect.objectContaining({
                orderId: "order_1",
                notificationType: "order_delivered",
            }),
        }));
    });
});
