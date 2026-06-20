import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
    getNotificationChannels: vi.fn(),
    getOrderWhatsAppTemplateSettings: vi.fn(),
    getActiveSmsProvider: vi.fn(),
    sendEmail: vi.fn(),
    sendSms: vi.fn(),
    getWhatsAppCloudApiSettings: vi.fn(),
    sendWhatsAppTemplateMessage: vi.fn(),
    normalizeWhatsAppRecipient: vi.fn(),
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
    getOrderWhatsAppTemplateSettings: mocks.getOrderWhatsAppTemplateSettings,
}));

vi.mock("../../integrations/sms", () => ({
    getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("../../integrations/email", () => ({
    sendEmail: mocks.sendEmail,
}));

vi.mock("../../integrations/whatsapp", () => ({
    getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
    sendWhatsAppTemplateMessage: mocks.sendWhatsAppTemplateMessage,
    normalizeWhatsAppRecipient: mocks.normalizeWhatsAppRecipient,
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
import { encryptCredentials } from "../../utils/credential-encryption";

function createDb(input: string | {
    customerPhone?: string;
} = "+8801700000000"): Database {
    const customerPhone = typeof input === "string" ? input : (input.customerPhone ?? "+8801700000000");

    return {
        select: vi.fn((_selection?: Record<string, unknown>) => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    get: vi.fn(async () => ({ customerPhone })),
                })),
                limit: vi.fn(() => ({
                    get: vi.fn(async () => {
                        return { customerPhone };
                    }),
                })),
            })),
        })),
    } as unknown as Database;
}

function createPushDb(tokenRows: Array<{ token: string }>): {
    db: Database;
    update: ReturnType<typeof vi.fn>;
    updateSet: ReturnType<typeof vi.fn>;
    updateWhere: ReturnType<typeof vi.fn>;
} {
    const updateWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    let selectCount = 0;
    const select = vi.fn(() => {
        selectCount += 1;
        if (selectCount === 1) {
            return {
                from: vi.fn(() => ({
                    where: vi.fn(() => ({
                        get: vi.fn(async () => null),
                    })),
                })),
            };
        }

        return {
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    then: (resolve: (value: typeof tokenRows) => void) =>
                        Promise.resolve(tokenRows).then(resolve),
                })),
            })),
        };
    });

    return {
        db: { select, update } as unknown as Database,
        update,
        updateSet,
        updateWhere,
    };
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
        mocks.sendWhatsAppTemplateMessage.mockResolvedValue({
            success: true,
            providerRef: "wamid.order.1",
            rawStatus: "accepted",
            rawResponse: JSON.stringify({ messageId: "wamid.order.1", messageStatus: "accepted" }),
        });
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
            accessToken: "wa_token",
            accessTokenConfigured: true,
            phoneNumberId: "phone_id_1",
            authTemplateName: "auth_otp",
            accessTokenSource: "encrypted",
        });
        mocks.normalizeWhatsAppRecipient.mockImplementation((phone: string) => phone.replace(/^\+/, ""));
        mocks.getOrderWhatsAppTemplateSettings.mockResolvedValue({
            templateName: "order_status_update",
            languageCode: "en_US",
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

    it("sends WhatsApp order templates through durable receipts", async () => {
        const db = createDb();
        mocks.getNotificationChannels.mockResolvedValue({
            order_shipped: ["whatsapp"],
        });

        const result = await sendOrderNotificationEmail(
            undefined,
            "WhatsApp Customer",
            "order_wa_1",
            "order_shipped",
            { trackingId: "TRACK123" },
            db,
            {
                encryptionKey: "credential-key",
                migrationEncryptionKey: "dedicated-key",
                outboxId: "outbox_wa_1",
            },
        );

        expect(mocks.createOrderNotificationDeliveryTarget).toHaveBeenCalledWith(
            expect.objectContaining({
                outboxId: "outbox_wa_1",
                orderId: "order_wa_1",
                notificationType: "order_shipped",
                channel: "whatsapp",
                provider: "whatsapp",
                recipient: "whatsapp:8801700000000",
            }),
        );
        expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(
            db,
            "credential-key",
            {
                migrateLegacy: true,
                migrationEncryptionKey: "dedicated-key",
            },
        );
        expect(mocks.sendWhatsAppTemplateMessage).toHaveBeenCalledWith({
            accessToken: "wa_token",
            phoneNumberId: "phone_id_1",
            to: "+8801700000000",
            templateName: "order_status_update",
            languageCode: "en_US",
            bodyParameters: [
                "WhatsApp Customer",
                "order_wa_1",
                "Order Shipped",
                "TRACK123",
            ],
        });
        expect(mocks.markOrderNotificationDeliveryReceiptAccepted).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            expect.objectContaining({
                provider: "whatsapp",
                providerMessageId: "wamid.order.1",
                providerStatus: "accepted",
            }),
        );
        expect(result.hasRetryableFailure).toBe(false);
    });

    it("records skipped WhatsApp receipts without sending when Meta credentials are missing", async () => {
        const db = createDb();
        mocks.getWhatsAppCloudApiSettings.mockResolvedValueOnce({
            accessToken: undefined,
            accessTokenConfigured: false,
            phoneNumberId: undefined,
            authTemplateName: "auth_otp",
            accessTokenSource: "none",
        });
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["whatsapp"],
        });

        const result = await sendOrderNotificationEmail(
            undefined,
            "WhatsApp Customer",
            "order_wa_2",
            "order_created",
            {},
            db,
            { outboxId: "outbox_wa_2" },
        );

        expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            "missing_whatsapp_credentials",
            expect.objectContaining({
                provider: "whatsapp",
                providerStatus: "missing_whatsapp_credentials",
            }),
        );
        expect(result.hasRetryableFailure).toBe(false);
    });

    it("records skipped WhatsApp receipts for invalid order phone data", async () => {
        const db = createDb("not-a-phone");
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["whatsapp"],
        });
        mocks.normalizeWhatsAppRecipient.mockImplementationOnce(() => {
            throw new Error("Invalid phone number format");
        });

        const result = await sendOrderNotificationEmail(
            undefined,
            "WhatsApp Customer",
            "order_wa_3",
            "order_created",
            {},
            db,
            { outboxId: "outbox_wa_3" },
        );

        expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            "invalid_whatsapp_recipient",
            expect.objectContaining({
                provider: "whatsapp",
                providerStatus: "invalid_whatsapp_recipient",
            }),
        );
        expect(result.hasRetryableFailure).toBe(false);
    });

    it("records non-retryable WhatsApp provider rejections as skipped receipts", async () => {
        const db = createDb();
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["whatsapp"],
        });
        mocks.sendWhatsAppTemplateMessage.mockResolvedValueOnce({
            success: false,
            providerRef: "wamid.paused.1",
            rawStatus: "paused",
            rawResponse: JSON.stringify({ messageId: "wamid.paused.1", messageStatus: "paused" }),
            retryable: false,
        });

        const result = await sendOrderNotificationEmail(
            undefined,
            "WhatsApp Customer",
            "order_wa_4",
            "order_created",
            {},
            db,
            { outboxId: "outbox_wa_4" },
        );

        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            "paused",
            expect.objectContaining({
                provider: "whatsapp",
                providerMessageId: "wamid.paused.1",
                providerStatus: "paused",
            }),
        );
        expect(result.hasRetryableFailure).toBe(false);
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

    it("decrypts encrypted Firebase service accounts before sending admin push", async () => {
        const credentialKey = Buffer.alloc(32, 19).toString("base64");
        const serviceAccountJson = JSON.stringify({
            client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
            private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
            project_id: "scalius-test",
        });
        const tokenRows = [{ token: "fcm_token_1" }];
        let selectCount = 0;
        const db = {
            select: vi.fn(() => {
                selectCount += 1;
                if (selectCount === 1) {
                    return {
                        from: vi.fn(() => ({
                            where: vi.fn(() => ({
                                get: vi.fn(async () => ({
                                    value: `enc:${await encryptCredentials(serviceAccountJson, credentialKey)}`,
                                })),
                            })),
                        })),
                    };
                }

                return {
                    from: vi.fn(() => ({
                        where: vi.fn(() => ({
                            then: (resolve: (value: typeof tokenRows) => void) => Promise.resolve(tokenRows).then(resolve),
                        })),
                    })),
                };
            }),
        } as unknown as Database;
        const env = {
            PUBLIC_API_BASE_URL: "https://api.example.test",
            CREDENTIAL_ENCRYPTION_KEY: credentialKey,
        } as Env;

        await sendOrderNotification(
            db,
            {
                id: "order_2",
                customerName: "Push Customer",
                notificationType: "order_created",
            },
            env,
            "https://api.example.test",
        );

        expect(mocks.getFirebaseAdminMessaging).toHaveBeenCalledWith(
            env,
            serviceAccountJson,
        );
    });

    it("treats provider stale-device FCM errors as skipped receipts and deactivates tokens", async () => {
        const pushDb = createPushDb([
            { token: "dead_fcm_token" },
            { token: "active_fcm_token" },
        ]);
        mocks.sendEachForMulticast.mockResolvedValueOnce({
            successCount: 1,
            failureCount: 1,
            responses: [
                {
                    success: false,
                    error: {
                        code: "messaging/unknown-error",
                        message: "Device unregistered.",
                    },
                },
                {
                    success: true,
                    messageId: "projects/scalius/messages/active_fcm_token",
                },
            ],
        });

        const result = await sendOrderNotification(
            pushDb.db,
            {
                id: "order_push_1",
                customerName: "Push Customer",
                notificationType: "order_created",
            },
            { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
            "https://api.example.test",
            { outboxId: "outbox_push_1" },
        );

        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).toHaveBeenCalledWith(
            pushDb.db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            "messaging/registration-token-not-registered",
            expect.objectContaining({
                provider: "fcm",
                providerStatus: "messaging/unknown-error",
                rawResponse: "Device unregistered.",
            }),
        );
        expect(mocks.markOrderNotificationDeliveryReceiptAccepted).toHaveBeenCalledWith(
            pushDb.db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            expect.objectContaining({
                provider: "fcm",
                providerMessageId: "projects/scalius/messages/active_fcm_token",
                providerStatus: "accepted",
            }),
        );
        expect(mocks.markOrderNotificationDeliveryReceiptFailed).not.toHaveBeenCalled();
        expect(pushDb.update).toHaveBeenCalled();
        expect(pushDb.updateSet).toHaveBeenCalledWith(expect.objectContaining({
            isActive: false,
        }));
        expect(pushDb.updateWhere).toHaveBeenCalled();
        expect(result.hasRetryableFailure).toBe(false);
        expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
            "skipped",
            "accepted",
        ]);
    });

    it("deactivates NotRegistered FCM tokens outside receipt mode", async () => {
        const pushDb = createPushDb([{ token: "dead_fcm_token" }]);
        mocks.sendEachForMulticast.mockResolvedValueOnce({
            successCount: 0,
            failureCount: 1,
            responses: [
                {
                    success: false,
                    error: {
                        code: "messaging/unknown-error",
                        message: "NotRegistered",
                    },
                },
            ],
        });

        await sendOrderNotification(
            pushDb.db,
            {
                id: "order_push_2",
                customerName: "Push Customer",
                notificationType: "order_created",
            },
            { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
            "https://api.example.test",
        );

        expect(pushDb.update).toHaveBeenCalled();
        expect(pushDb.updateSet).toHaveBeenCalledWith(expect.objectContaining({
            isActive: false,
        }));
        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).not.toHaveBeenCalled();
        expect(mocks.markOrderNotificationDeliveryReceiptFailed).not.toHaveBeenCalled();
    });

    it("keeps transient FCM failures retryable in receipt mode", async () => {
        const pushDb = createPushDb([{ token: "retryable_fcm_token" }]);
        mocks.sendEachForMulticast.mockResolvedValueOnce({
            successCount: 0,
            failureCount: 1,
            responses: [
                {
                    success: false,
                    error: {
                        code: "messaging/unknown-error",
                        message: "Internal server error",
                    },
                },
            ],
        });

        const result = await sendOrderNotification(
            pushDb.db,
            {
                id: "order_push_3",
                customerName: "Push Customer",
                notificationType: "order_created",
            },
            { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
            "https://api.example.test",
            { outboxId: "outbox_push_3" },
        );

        expect(mocks.markOrderNotificationDeliveryReceiptFailed).toHaveBeenCalledWith(
            pushDb.db,
            expect.objectContaining({ id: "receipt_1", claimId: "claim_1" }),
            expect.any(Error),
            expect.objectContaining({
                provider: "fcm",
                providerStatus: "messaging/unknown-error",
                rawResponse: "Internal server error",
            }),
        );
        expect(mocks.markOrderNotificationDeliveryReceiptSkipped).not.toHaveBeenCalled();
        expect(pushDb.update).not.toHaveBeenCalled();
        expect(result.hasRetryableFailure).toBe(true);
    });
});
