// src/modules/notifications/notifications.service.ts
// Centralized notification service for admin push + order notifications.

import type { Database } from "@scalius/database/client";
import { adminFcmTokens, orders } from "@scalius/database/schema";
import { escapeHtml } from "@scalius/shared/html-escape";
import { eq, inArray, sql } from "drizzle-orm";
import { sendEmail } from "../../integrations/email";
import type { EmailRuntimeContext, SendEmailResult } from "../../integrations/email";
import { getFirebaseAdminMessaging } from "../../integrations/firebase/admin";
import { readFirebaseServiceAccountJson } from "../../integrations/firebase/settings";
import {
    getWhatsAppCloudApiSettings,
    normalizeWhatsAppRecipient,
    sendWhatsAppTemplateMessage,
    type SendWhatsAppTemplateMessageResult,
} from "../../integrations/whatsapp";
import {
    claimOrderNotificationDeliveryReceipt,
    createOrderNotificationDeliveryTarget,
    createProviderClientReference,
    markOrderNotificationDeliveryReceiptAccepted,
    markOrderNotificationDeliveryReceiptFailed,
    markOrderNotificationDeliveryReceiptSkipped,
    type OrderNotificationDeliveryChannel,
    type OrderNotificationDeliveryReceiptClaim,
    type OrderNotificationDeliveryTarget,
} from "./order-notification-delivery-receipts";
import { ORDER_NOTIFICATION_LABELS, type OrderNotificationType } from "./notification-types";

interface OrderNotificationData {
    id: string;
    customerName: string;
    notificationType?: OrderNotificationType;
}

interface OrderNotificationOptions {
    encryptionKey?: string;
    migrationEncryptionKey?: string;
    env?: EmailRuntimeContext["env"];
    outboxId?: string;
}

interface AdminPushOptions {
    outboxId?: string;
}

interface FcmSendError {
    code?: string;
    message?: string;
    status?: string;
}

export interface OrderNotificationChannelOutcome {
    channel: OrderNotificationDeliveryChannel;
    provider: string;
    recipientMasked: string;
    status: "accepted" | "delivered" | "skipped" | "failed";
    providerMessageId?: string | null;
    providerStatus?: string | null;
    error?: string;
    retryable: boolean;
}

export interface OrderNotificationDispatchResult {
    outcomes: OrderNotificationChannelOutcome[];
    hasRetryableFailure: boolean;
}

interface DeliverySendResult {
    success: boolean;
    provider: string;
    providerMessageId?: string | null;
    providerStatus?: string | null;
    rawResponse?: string | null;
    retryable?: boolean;
}

const EMPTY_DISPATCH_RESULT: OrderNotificationDispatchResult = {
    outcomes: [],
    hasRetryableFailure: false,
};

function credentialEncryptionKeyFromEnv(env: Env): string | undefined {
    const source = env as unknown as Record<string, unknown>;
    return (source.CREDENTIAL_ENCRYPTION_KEY as string | undefined)
        ?? (source.JWT_SECRET as string | undefined);
}

function normalizeFcmErrorPart(value: unknown): string {
    if (value === undefined || value === null) return "";
    return String(value)
        .toLowerCase()
        .replace(/[_/-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getPermanentInvalidFcmTokenReason(error: FcmSendError | undefined): string | undefined {
    if (!error) return undefined;

    const code = normalizeFcmErrorPart(error.code);
    const status = normalizeFcmErrorPart(error.status);
    const message = normalizeFcmErrorPart(error.message);
    const combined = [code, status, message].filter(Boolean).join(" ");
    const compact = combined.replace(/[^a-z0-9]+/g, "");

    if (code === "messaging invalid registration token") {
        return "messaging/invalid-registration-token";
    }

    if (code === "messaging invalid argument" && !combined.includes("registration token")) {
        return undefined;
    }

    if (
        code === "messaging registration token not registered" ||
        code === "messaging unregistered" ||
        status === "unregistered" ||
        compact.includes("notregistered") ||
        combined.includes("device unregistered") ||
        combined.includes("requested entity was not found") ||
        combined.includes("token not registered") ||
        (combined.includes("registration token") && combined.includes("not registered"))
    ) {
        return "messaging/registration-token-not-registered";
    }

    if (combined.includes("registration token") && combined.includes("invalid")) {
        return "messaging/invalid-registration-token";
    }

    return undefined;
}

function isPermanentInvalidFcmTokenError(error: FcmSendError | undefined): boolean {
    return getPermanentInvalidFcmTokenReason(error) !== undefined;
}

/**
 * Sends push notifications to active admin devices about an order.
 * When an outbox id is provided, each FCM token is guarded by a durable
 * delivery receipt so retries skip tokens already accepted by FCM.
 */
export async function sendOrderNotification(
    db: Database,
    order: OrderNotificationData,
    env: Env,
    requestUrl: string,
    options: AdminPushOptions = {},
): Promise<OrderNotificationDispatchResult> {
    const outcomes: OrderNotificationChannelOutcome[] = [];
    const notificationType = order.notificationType ?? "order_created";

    try {
        let serviceAccountJson: string | undefined;
        try {
            serviceAccountJson = await readFirebaseServiceAccountJson(
                db,
                credentialEncryptionKeyFromEnv(env),
            );
        } catch (e: unknown) {
            console.warn(
                "Failed to fetch custom Firebase credentials from DB, falling back to env:",
                e,
            );
        }

        const messaging = getFirebaseAdminMessaging(env, serviceAccountJson);
        const tokensSnapshot = await db
            .select({ token: adminFcmTokens.token })
            .from(adminFcmTokens)
            .where(eq(adminFcmTokens.isActive, true));

        if (tokensSnapshot.length === 0) {
            return EMPTY_DISPATCH_RESULT;
        }

        const tokens = tokensSnapshot.map((t) => t.token);
        const baseUrl = env.PUBLIC_API_BASE_URL || new URL(requestUrl).origin;
        const orderViewLink = `${baseUrl}/admin/orders/${order.id}`;

        const safeName = escapeHtml(order.customerName || "Unknown Customer");
        const label = ORDER_NOTIFICATION_LABELS[notificationType] ?? "Order Update";
        const title = notificationType === "order_created"
            ? "New Order Created!"
            : label;
        const messagePayload = {
            notification: {
                title,
                body: `${label}: Order ${order.id} from ${safeName}. Click to view.`,
            },
            webpush: {
                fcmOptions: {
                    link: orderViewLink,
                },
            },
            data: {
                orderId: order.id,
                customerName: safeName,
                notificationType,
                link: orderViewLink,
                ...(options.outboxId ? { deliveryKey: `${options.outboxId}:push` } : {}),
            },
            tokens,
        };

        if (!options.outboxId) {
            const response = await messaging.sendEachForMulticast(messagePayload);
            await deactivateInvalidFcmTokens(db, tokens, response.responses);
            return buildDispatchResult(outcomes);
        }

        const claimedTargets: Array<{
            token: string;
            target: OrderNotificationDeliveryTarget;
            receipt: OrderNotificationDeliveryReceiptClaim;
        }> = [];

        for (const token of tokens) {
            const target = await createOrderNotificationDeliveryTarget({
                outboxId: options.outboxId,
                orderId: order.id,
                notificationType,
                channel: "push",
                provider: "fcm",
                recipient: token,
                recipientMasked: maskPushToken(token),
            });
            const claim = await claimOrderNotificationDeliveryReceipt(db, target);
            if (!claim.claimed) {
                outcomes.push(outcomeFromUnclaimedReceipt(target, claim.reason));
                continue;
            }
            claimedTargets.push({ token, target, receipt: claim.receipt });
        }

        if (claimedTargets.length === 0) {
            return buildDispatchResult(outcomes);
        }

        const response = await messaging.sendEachForMulticast({
            ...messagePayload,
            tokens: claimedTargets.map((entry) => entry.token),
        });
        const invalidTokens: string[] = [];

        for (let index = 0; index < claimedTargets.length; index += 1) {
            const entry = claimedTargets[index];
            const resp = response.responses[index];
            if (!entry || !resp) continue;

            if (resp.success) {
                outcomes.push(await markAcceptedOutcome(db, entry.target, entry.receipt, {
                    success: true,
                    provider: "fcm",
                    providerMessageId: resp.messageId,
                    providerStatus: "accepted",
                }));
                continue;
            }

            const errorCode = resp.error?.code ?? "messaging/unknown-error";
            const errorMessage = resp.error?.message ?? "Unknown FCM error";

            const invalidTokenReason = getPermanentInvalidFcmTokenReason(resp.error);
            if (invalidTokenReason) {
                console.warn(`[Notifications] FCM token #${index} expired/invalid (${errorCode}) - will deactivate`);
                const outcome = await markSkippedOutcome(
                    db,
                    entry.target,
                    entry.receipt,
                    invalidTokenReason,
                    {
                        provider: "fcm",
                        providerStatus: errorCode,
                        rawResponse: errorMessage,
                    },
                );
                outcomes.push(outcome);
                if (!outcome.retryable) {
                    invalidTokens.push(entry.token);
                }
            } else {
                console.error(`[Notifications] FCM send failed for token #${index}:`, errorCode, errorMessage);
                outcomes.push(await markFailedOutcome(
                    db,
                    entry.target,
                    entry.receipt,
                    new Error(`${errorCode}: ${errorMessage}`),
                    {
                        provider: "fcm",
                        providerStatus: errorCode,
                        rawResponse: errorMessage,
                    },
                ));
            }
        }

        if (invalidTokens.length > 0) {
            await deactivateFcmTokens(db, invalidTokens);
        }

        return buildDispatchResult(outcomes);
    } catch (error: unknown) {
        console.error(
            "[Notifications] Push notification failed for order",
            order.id,
            ":",
            error instanceof Error ? error.message : error,
        );
        return buildDispatchResult([
            ...outcomes,
            {
                channel: "push",
                provider: "fcm",
                recipientMasked: "admin-fcm",
                status: "failed",
                error: normalizeError(error),
                retryable: Boolean(options.outboxId),
            },
        ]);
    }
}

/**
 * Dispatches order notifications to all enabled customer channels.
 * When an outbox id is provided, each logical channel target is fenced by a
 * durable receipt so partial retries do not duplicate already-accepted sends.
 */
export async function sendOrderNotificationEmail(
    email: string | null | undefined,
    name: string,
    orderId: string,
    type: OrderNotificationType,
    data?: Record<string, unknown>,
    db?: Database,
    options: OrderNotificationOptions = {},
): Promise<OrderNotificationDispatchResult> {
    const outcomes: OrderNotificationChannelOutcome[] = [];
    let enabledChannels: string[] = ["email"];

    if (db) {
        try {
            const { getNotificationChannels } = await import("../settings/settings.service");
            const channels = await getNotificationChannels(db);
            enabledChannels = channels[type] || ["email"];
        } catch (channelError: unknown) {
            console.warn("[Notifications] Failed to check channel preferences, defaulting to email:", channelError);
        }
    }

    const safeName = escapeHtml(name);
    const safeTrackingId = data?.trackingId ? escapeHtml(String(data.trackingId)) : "";

    const subjects: Record<OrderNotificationType, string> = {
        order_created: `Order #${orderId} Received`,
        order_confirmed: `Order #${orderId} Confirmed`,
        order_processing: `Order #${orderId} Processing`,
        order_shipped: `Order #${orderId} Shipped`,
        order_delivered: `Order #${orderId} Delivered`,
        order_completed: `Order #${orderId} Completed`,
        order_cancelled: `Order #${orderId} Cancelled`,
        order_returned: `Order #${orderId} Returned`,
        order_refunded: `Order #${orderId} Refunded`,
    };

    const htmlMessages: Record<OrderNotificationType, string> = {
        order_created: `Thank you for your order, ${safeName}! We've received your order <strong>#${orderId}</strong> and will process it shortly.`,
        order_confirmed: `Great news, ${safeName}! Your order <strong>#${orderId}</strong> has been confirmed and is being prepared.`,
        order_processing: `Your order <strong>#${orderId}</strong> is being processed, ${safeName}! We'll update you when it ships.`,
        order_shipped: `Your order <strong>#${orderId}</strong> is on its way, ${safeName}! ${safeTrackingId ? `Tracking ID: <strong>${safeTrackingId}</strong>` : ""}`,
        order_delivered: `Your order <strong>#${orderId}</strong> has been delivered, ${safeName}! We hope you love your purchase.`,
        order_completed: `Your order <strong>#${orderId}</strong> has been completed, ${safeName}! Thank you for shopping with us.`,
        order_cancelled: `Your order <strong>#${orderId}</strong> has been cancelled, ${safeName}. If you have questions, please contact our support team.`,
        order_returned: `Your order <strong>#${orderId}</strong> has been marked as returned, ${safeName}. If you have questions, please contact our support team.`,
        order_refunded: `Your order <strong>#${orderId}</strong> has been refunded, ${safeName}. The refund will be processed to your original payment method. If you have questions, please contact our support team.`,
    };

    const smsMessages: Record<OrderNotificationType, string> = {
        order_created: `Hi ${name}, your order #${orderId} has been received. We'll process it shortly.`,
        order_confirmed: `Hi ${name}, your order #${orderId} has been confirmed and is being prepared.`,
        order_processing: `Hi ${name}, your order #${orderId} is being processed. We'll update you when it ships.`,
        order_shipped: `Hi ${name}, your order #${orderId} is on its way!${data?.trackingId ? ` Tracking: ${data.trackingId}` : ""}`,
        order_delivered: `Hi ${name}, your order #${orderId} has been delivered. Enjoy!`,
        order_completed: `Hi ${name}, your order #${orderId} has been completed. Thank you for shopping with us!`,
        order_cancelled: `Hi ${name}, your order #${orderId} has been cancelled. Contact us if you have questions.`,
        order_returned: `Hi ${name}, your order #${orderId} has been marked as returned. Contact us if you have questions.`,
        order_refunded: `Hi ${name}, your order #${orderId} has been refunded. Contact us if you have questions.`,
    };

    const receiptEnabled = Boolean(db && options.outboxId);
    const receiptDb = receiptEnabled ? db : undefined;
    const outboxId = options.outboxId;

    if (enabledChannels.includes("email")) {
        const emailOptions = {
            to: email ?? "",
            subject: subjects[type] || `Order #${orderId} Update`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>${subjects[type] || "Order Update"}</h2>
                <p>${htmlMessages[type] || `Your order #${orderId} has been updated.`}</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
                <p style="color: #999; font-size: 12px;">
                  This is an automated email regarding your order from our store.
                </p>
              </div>
            `,
            text: `${name}, ${htmlMessages[type]?.replace(/<[^>]+>/g, "") || `Order #${orderId} updated.`}`,
        };

        if (!email) {
            if (receiptDb && outboxId) {
                outcomes.push(await recordSkippedDelivery({
                    db: receiptDb,
                    outboxId,
                    orderId,
                    notificationType: type,
                    channel: "email",
                    provider: "email",
                    recipient: `missing-email:${orderId}`,
                    recipientMasked: "missing-email",
                    reason: "missing_email_recipient",
                }));
            }
        } else if (receiptDb && outboxId) {
            outcomes.push(await dispatchWithReceipt({
                db: receiptDb,
                outboxId,
                orderId,
                notificationType: type,
                channel: "email",
                provider: "email",
                recipient: email,
                recipientMasked: maskEmail(email),
                send: async (target) => emailResultToDeliveryResult(await sendEmail({
                    ...emailOptions,
                    to: email,
                    idempotencyKey: target.receiptKey,
                }, {
                    db,
                    env: options.env,
                    encryptionKey: options.encryptionKey,
                })),
            }));
        } else {
            try {
                const result = await sendEmail({
                    ...emailOptions,
                    to: email,
                }, {
                    db,
                    env: options.env,
                    encryptionKey: options.encryptionKey,
                });
                if (result && !result.success) {
                    console.error(`[Notifications] Email did not send for ${type} (order ${orderId}): ${result.rawStatus}`);
                }
            } catch (emailError: unknown) {
                console.error(`[Notifications] Email failed for ${type} (order ${orderId}):`, emailError);
            }
        }
    }

    if (enabledChannels.includes("sms")) {
        try {
            const { getActiveSmsProvider } = await import("../../integrations/sms");
            const orderRow = db
                ? await db.select({ customerPhone: orders.customerPhone }).from(orders).where(eq(orders.id, orderId)).get()
                : undefined;
            const customerPhone = orderRow?.customerPhone;

            if (!customerPhone) {
                if (receiptDb && outboxId) {
                    outcomes.push(await recordSkippedDelivery({
                        db: receiptDb,
                        outboxId,
                        orderId,
                        notificationType: type,
                        channel: "sms",
                        provider: "sms",
                        recipient: `missing-phone:${orderId}`,
                        recipientMasked: "missing-phone",
                        reason: "missing_sms_recipient",
                    }));
                }
            } else if (db) {
                const msg = smsMessages[type] || `Hi ${name}, your order #${orderId} status has been updated.`;
                const smsProvider = await getActiveSmsProvider(db, options.encryptionKey);

                if (receiptDb && outboxId) {
                    outcomes.push(await dispatchWithReceipt({
                        db: receiptDb,
                        outboxId,
                        orderId,
                        notificationType: type,
                        channel: "sms",
                        provider: smsProvider?.name ?? "sms",
                        recipient: customerPhone,
                        recipientMasked: maskPhone(customerPhone),
                        send: async (target) => {
                            if (!smsProvider) {
                                return {
                                    success: false,
                                    provider: "sms",
                                    providerStatus: "missing_provider",
                                    rawResponse: "No active SMS provider configured",
                                };
                            }
                            const smsResult = await smsProvider.sendSms({
                                to: customerPhone,
                                message: msg,
                                clientReference: createProviderClientReference(target),
                            });
                            if (smsResult.success) {
                                console.log(`[Notifications] SMS sent via ${smsProvider.name} for ${type} (order ${orderId}), ref=${smsResult.providerRef}`);
                            } else {
                                console.error(`[Notifications] SMS failed via ${smsProvider.name} for ${type} (order ${orderId}): ${smsResult.rawStatus}`);
                            }
                            return {
                                success: smsResult.success,
                                provider: smsProvider.name,
                                providerMessageId: smsResult.providerRef,
                                providerStatus: smsResult.rawStatus,
                                rawResponse: smsResult.rawStatus,
                            };
                        },
                    }));
                } else if (smsProvider) {
                    const smsResult = await smsProvider.sendSms({ to: customerPhone, message: msg });
                    if (smsResult.success) {
                        console.log(`[Notifications] SMS sent via ${smsProvider.name} for ${type} (order ${orderId}), ref=${smsResult.providerRef}`);
                    } else {
                        console.error(`[Notifications] SMS failed via ${smsProvider.name} for ${type} (order ${orderId}): ${smsResult.rawStatus}`);
                    }
                } else {
                    console.warn(`[Notifications] SMS channel enabled for ${type} but no SMS provider configured`);
                }
            }
        } catch (smsError: unknown) {
            console.error(`[Notifications] SMS dispatch failed for ${type} (order ${orderId}):`, smsError);
            if (receiptDb && outboxId) {
                outcomes.push({
                    channel: "sms",
                    provider: "sms",
                    recipientMasked: "unknown",
                    status: "failed",
                    error: normalizeError(smsError),
                    retryable: true,
                });
            }
        }
    }

    if (enabledChannels.includes("whatsapp")) {
        try {
            const orderRow = db
                ? await db.select({ customerPhone: orders.customerPhone }).from(orders).where(eq(orders.id, orderId)).get()
                : undefined;
            const customerPhone = orderRow?.customerPhone;

            if (!customerPhone) {
                if (receiptDb && outboxId) {
                    outcomes.push(await recordSkippedDelivery({
                        db: receiptDb,
                        outboxId,
                        orderId,
                        notificationType: type,
                        channel: "whatsapp",
                        provider: "whatsapp",
                        recipient: `missing-whatsapp-phone:${orderId}`,
                        recipientMasked: "missing-phone",
                        reason: "missing_whatsapp_recipient",
                    }));
                }
            } else {
                let whatsappRecipient: string | null = null;
                try {
                    whatsappRecipient = normalizeWhatsAppRecipient(customerPhone);
                } catch {
                    if (receiptDb && outboxId) {
                        outcomes.push(await recordSkippedDelivery({
                            db: receiptDb,
                            outboxId,
                            orderId,
                            notificationType: type,
                            channel: "whatsapp",
                            provider: "whatsapp",
                            recipient: `invalid-whatsapp-phone:${orderId}`,
                            recipientMasked: maskPhone(customerPhone),
                            reason: "invalid_whatsapp_recipient",
                        }));
                    }
                }

                if (whatsappRecipient) {
                    const sendConfig = db
                        ? await resolveOrderWhatsAppSendConfig(db, options.encryptionKey, options.migrationEncryptionKey)
                        : null;
                    if (!sendConfig) {
                        if (receiptDb && outboxId) {
                            outcomes.push(await recordSkippedDelivery({
                                db: receiptDb,
                                outboxId,
                                orderId,
                                notificationType: type,
                                channel: "whatsapp",
                                provider: "whatsapp",
                                recipient: `whatsapp:${whatsappRecipient}`,
                                recipientMasked: maskPhone(customerPhone),
                                reason: "missing_whatsapp_credentials",
                            }));
                        } else {
                            console.warn(`[Notifications] WhatsApp channel enabled for ${type} but Meta credentials are not configured`);
                        }
                    } else {
                        const send = async (): Promise<DeliverySendResult> => sendOrderWhatsAppTemplate({
                            config: sendConfig,
                            orderId,
                            notificationType: type,
                            customerName: name,
                            customerPhone,
                            data,
                        });

                        if (receiptDb && outboxId) {
                            outcomes.push(await dispatchWithReceipt({
                                db: receiptDb,
                                outboxId,
                                orderId,
                                notificationType: type,
                                channel: "whatsapp",
                                provider: "whatsapp",
                                recipient: `whatsapp:${whatsappRecipient}`,
                                recipientMasked: maskPhone(customerPhone),
                                send,
                            }));
                        } else if (db) {
                            const result = await send();
                            if (result.success) {
                                console.log(`[Notifications] WhatsApp sent for ${type} (order ${orderId}), ref=${result.providerMessageId}`);
                            } else {
                                console.error(`[Notifications] WhatsApp failed for ${type} (order ${orderId}): ${result.rawResponse ?? result.providerStatus}`);
                            }
                        } else {
                            console.warn(`[Notifications] WhatsApp channel enabled for ${type} without a database connection`);
                        }
                    }
                }
            }
        } catch (whatsappError: unknown) {
            console.error(`[Notifications] WhatsApp dispatch failed for ${type} (order ${orderId}):`, whatsappError);
            if (receiptDb && outboxId) {
                outcomes.push({
                    channel: "whatsapp",
                    provider: "whatsapp",
                    recipientMasked: "unknown",
                    status: "failed",
                    error: normalizeError(whatsappError),
                    retryable: true,
                });
            }
        }
    }

    return buildDispatchResult(outcomes);
}

async function sendOrderWhatsAppTemplate(options: {
    config: OrderWhatsAppSendConfig;
    orderId: string;
    notificationType: OrderNotificationType;
    customerName: string;
    customerPhone: string;
    data?: Record<string, unknown>;
}): Promise<DeliverySendResult> {
    const result = await sendWhatsAppTemplateMessage({
        accessToken: options.config.accessToken,
        phoneNumberId: options.config.phoneNumberId,
        to: options.customerPhone,
        templateName: options.config.templateName,
        languageCode: options.config.languageCode,
        bodyParameters: buildOrderWhatsAppBodyParameters(options),
    });

    return whatsAppResultToDeliveryResult(result);
}

interface OrderWhatsAppSendConfig {
    accessToken: string;
    phoneNumberId: string;
    templateName: string;
    languageCode: string;
}

async function resolveOrderWhatsAppSendConfig(
    db: Database,
    encryptionKey?: string,
    migrationEncryptionKey?: string,
): Promise<OrderWhatsAppSendConfig | null> {
    const whatsapp = await getWhatsAppCloudApiSettings(db, encryptionKey, {
        migrateLegacy: true,
        migrationEncryptionKey,
    });
    if (!whatsapp.accessToken || !whatsapp.phoneNumberId) {
        return null;
    }

    const { getOrderWhatsAppTemplateSettings } = await import("../settings/settings.service");
    const template = await getOrderWhatsAppTemplateSettings(db);
    return {
        accessToken: whatsapp.accessToken,
        phoneNumberId: whatsapp.phoneNumberId,
        templateName: template.templateName,
        languageCode: template.languageCode,
    };
}

function buildOrderWhatsAppBodyParameters(options: {
    orderId: string;
    notificationType: OrderNotificationType;
    customerName: string;
    data?: Record<string, unknown>;
}): string[] {
    const label = ORDER_NOTIFICATION_LABELS[options.notificationType] ?? "Order Update";
    return [
        templateText(options.customerName, "Customer", 80),
        templateText(options.orderId, "order", 80),
        templateText(label, "Order Update", 80),
        templateText(options.data?.trackingId, "-", 120),
    ];
}

function whatsAppResultToDeliveryResult(result: SendWhatsAppTemplateMessageResult): DeliverySendResult {
    return {
        success: result.success,
        provider: "whatsapp",
        providerMessageId: result.providerRef,
        providerStatus: result.rawStatus,
        rawResponse: result.rawResponse ?? result.rawStatus,
        retryable: result.retryable,
    };
}

function templateText(value: unknown, fallback: string, maxLength: number): string {
    const text = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const resolved = text || fallback;
    return resolved.length > maxLength ? resolved.slice(0, maxLength) : resolved;
}

async function dispatchWithReceipt(options: {
    db: Database;
    outboxId: string;
    orderId: string;
    notificationType: OrderNotificationType;
    channel: OrderNotificationDeliveryChannel;
    provider: string;
    recipient: string;
    recipientMasked?: string | null;
    send: (target: OrderNotificationDeliveryTarget) => Promise<DeliverySendResult>;
}): Promise<OrderNotificationChannelOutcome> {
    const target = await createOrderNotificationDeliveryTarget(options);
    const claim = await claimOrderNotificationDeliveryReceipt(options.db, target);
    if (!claim.claimed) {
        return outcomeFromUnclaimedReceipt(target, claim.reason);
    }

    try {
        const result = await options.send(target);
        if (!result.success) {
            if (result.retryable === false) {
                return await markSkippedOutcome(
                    options.db,
                    target,
                    claim.receipt,
                    result.providerStatus ?? "provider_non_retryable_failure",
                    result,
                );
            }
            return await markFailedOutcome(options.db, target, claim.receipt, new Error(result.rawResponse ?? result.providerStatus ?? "Provider send failed"), result);
        }
        return await markAcceptedOutcome(options.db, target, claim.receipt, result);
    } catch (error: unknown) {
        return await markFailedOutcome(options.db, target, claim.receipt, error);
    }
}

async function recordSkippedDelivery(options: {
    db: Database;
    outboxId: string;
    orderId: string;
    notificationType: OrderNotificationType;
    channel: OrderNotificationDeliveryChannel;
    provider: string;
    recipient: string;
    recipientMasked: string;
    reason: string;
}): Promise<OrderNotificationChannelOutcome> {
    const target = await createOrderNotificationDeliveryTarget(options);
    const claim = await claimOrderNotificationDeliveryReceipt(options.db, target);
    if (!claim.claimed) {
        return outcomeFromUnclaimedReceipt(target, claim.reason);
    }
    return await markSkippedOutcome(options.db, target, claim.receipt, options.reason, {
        provider: options.provider,
        providerStatus: options.reason,
    });
}

async function markAcceptedOutcome(
    db: Database,
    target: OrderNotificationDeliveryTarget,
    receipt: OrderNotificationDeliveryReceiptClaim,
    result: DeliverySendResult,
): Promise<OrderNotificationChannelOutcome> {
    try {
        await markOrderNotificationDeliveryReceiptAccepted(db, receipt, {
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus,
            rawResponse: result.rawResponse,
        });
        return {
            channel: target.channel,
            provider: result.provider,
            recipientMasked: target.recipientMasked,
            status: "accepted",
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus,
            retryable: false,
        };
    } catch (error: unknown) {
        console.error(`[Notifications] Failed to mark ${target.channel} receipt accepted:`, error);
        return {
            channel: target.channel,
            provider: result.provider,
            recipientMasked: target.recipientMasked,
            status: "failed",
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus,
            error: normalizeError(error),
            retryable: true,
        };
    }
}

async function markSkippedOutcome(
    db: Database,
    target: OrderNotificationDeliveryTarget,
    receipt: OrderNotificationDeliveryReceiptClaim,
    reason: string,
    result: Omit<DeliverySendResult, "success">,
): Promise<OrderNotificationChannelOutcome> {
    try {
        await markOrderNotificationDeliveryReceiptSkipped(db, receipt, reason, {
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus,
            rawResponse: result.rawResponse,
        });
        return {
            channel: target.channel,
            provider: result.provider,
            recipientMasked: target.recipientMasked,
            status: "skipped",
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus ?? reason,
            retryable: false,
        };
    } catch (error: unknown) {
        console.error(`[Notifications] Failed to mark ${target.channel} receipt skipped:`, error);
        return {
            channel: target.channel,
            provider: result.provider,
            recipientMasked: target.recipientMasked,
            status: "failed",
            error: normalizeError(error),
            retryable: true,
        };
    }
}

async function markFailedOutcome(
    db: Database,
    target: OrderNotificationDeliveryTarget,
    receipt: OrderNotificationDeliveryReceiptClaim,
    error: unknown,
    result: Omit<DeliverySendResult, "success"> = { provider: target.provider },
): Promise<OrderNotificationChannelOutcome> {
    try {
        await markOrderNotificationDeliveryReceiptFailed(db, receipt, error, {
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            providerStatus: result.providerStatus,
            rawResponse: result.rawResponse,
        });
    } catch (markError: unknown) {
        console.error(`[Notifications] Failed to mark ${target.channel} receipt failed:`, markError);
    }

    return {
        channel: target.channel,
        provider: result.provider,
        recipientMasked: target.recipientMasked,
        status: "failed",
        providerMessageId: result.providerMessageId,
        providerStatus: result.providerStatus,
        error: normalizeError(error),
        retryable: true,
    };
}

function emailResultToDeliveryResult(result: SendEmailResult): DeliverySendResult {
    return {
        success: result.success,
        provider: result.provider,
        providerMessageId: result.providerRef,
        providerStatus: result.rawStatus,
        rawResponse: result.rawStatus,
    };
}

function outcomeFromUnclaimedReceipt(
    target: OrderNotificationDeliveryTarget,
    reason: "accepted" | "delivered" | "skipped" | "busy" | "missing",
): OrderNotificationChannelOutcome {
    if (reason === "accepted" || reason === "delivered" || reason === "skipped") {
        return {
            channel: target.channel,
            provider: target.provider,
            recipientMasked: target.recipientMasked,
            status: reason,
            providerStatus: `already_${reason}`,
            retryable: false,
        };
    }

    return {
        channel: target.channel,
        provider: target.provider,
        recipientMasked: target.recipientMasked,
        status: "failed",
        error: `delivery_receipt_${reason}`,
        retryable: true,
    };
}

function buildDispatchResult(outcomes: OrderNotificationChannelOutcome[]): OrderNotificationDispatchResult {
    return {
        outcomes,
        hasRetryableFailure: outcomes.some((outcome) => outcome.retryable),
    };
}

async function deactivateInvalidFcmTokens(
    db: Database,
    tokens: string[],
    responses: Array<{ success: boolean; error?: { code: string; message: string } }>,
): Promise<void> {
    const invalidTokens: string[] = [];
    responses.forEach((resp, index) => {
        if (!resp.error) return;
        if (isPermanentInvalidFcmTokenError(resp.error)) {
            console.warn(`[Notifications] FCM token #${index} expired/invalid (${resp.error.code}) - will deactivate`);
            const failedToken = tokens[index];
            if (failedToken) invalidTokens.push(failedToken);
        } else {
            console.error(`[Notifications] FCM send failed for token #${index}:`, resp.error.code, resp.error.message);
        }
    });

    if (invalidTokens.length > 0) {
        await deactivateFcmTokens(db, invalidTokens);
    }
}

async function deactivateFcmTokens(db: Database, invalidTokens: string[]): Promise<void> {
    console.log(`Deactivating ${invalidTokens.length} invalid FCM tokens.`);
    await db
        .update(adminFcmTokens)
        .set({
            isActive: false,
            updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(inArray(adminFcmTokens.token, invalidTokens));
}

function maskEmail(email: string): string {
    const [local = "", domain = ""] = email.split("@");
    return `${local.slice(0, 1) || "*"}***@${domain}`;
}

function maskPhone(phone: string): string {
    return phone.length > 4 ? `***${phone.slice(-4)}` : "****";
}

function maskPushToken(token: string): string {
    return `token:${token.slice(0, 6)}...${token.slice(-4)}`;
}

function normalizeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
