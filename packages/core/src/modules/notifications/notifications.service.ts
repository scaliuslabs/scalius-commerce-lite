// src/modules/notifications/notifications.service.ts
// Centralized notification service for admin push + order notifications.

import type { Database } from "@scalius/database/client";
import { adminFcmTokens, settings } from "@scalius/database/schema";
import { escapeHtml } from "@scalius/shared/html-escape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { sendEmail } from "../../integrations/email";
import type { EmailRuntimeContext, SendEmailResult } from "../../integrations/email";
import { getFirebaseAdminMessaging } from "../../integrations/firebase/admin";
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
    env?: EmailRuntimeContext["env"];
    outboxId?: string;
}

interface AdminPushOptions {
    outboxId?: string;
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
}

const EMPTY_DISPATCH_RESULT: OrderNotificationDispatchResult = {
    outcomes: [],
    hasRetryableFailure: false,
};

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
            const result = await db
                .select({ value: settings.value })
                .from(settings)
                .where(
                    and(
                        eq(settings.key, "service_account"),
                        eq(settings.category, "firebase"),
                    ),
                )
                .get();
            if (result?.value) {
                serviceAccountJson = result.value;
            }
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
            const isExpiredToken =
                errorCode === "messaging/registration-token-not-registered" ||
                errorCode === "messaging/invalid-registration-token";

            if (isExpiredToken) {
                console.warn(`[Notifications] FCM token #${index} expired/invalid (${errorCode}) - will deactivate`);
                invalidTokens.push(entry.token);
                outcomes.push(await markSkippedOutcome(
                    db,
                    entry.target,
                    entry.receipt,
                    errorCode,
                    {
                        provider: "fcm",
                        providerStatus: errorCode,
                        rawResponse: errorMessage,
                    },
                ));
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
            const { orders } = await import("@scalius/database/schema");
            const { eq: eqOp } = await import("drizzle-orm");
            const orderRow = db
                ? await db.select({ customerPhone: orders.customerPhone }).from(orders).where(eqOp(orders.id, orderId)).get()
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
        if (receiptDb && outboxId) {
            outcomes.push(await recordSkippedDelivery({
                db: receiptDb,
                outboxId,
                orderId,
                notificationType: type,
                channel: "whatsapp",
                provider: "whatsapp",
                recipient: `whatsapp:${orderId}`,
                recipientMasked: "whatsapp",
                reason: "order_whatsapp_not_implemented",
            }));
        }
        console.log(`[Notifications] WhatsApp order notifications not yet implemented for ${type} (order ${orderId})`);
    }

    return buildDispatchResult(outcomes);
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
        const isExpiredToken =
            resp.error.code === "messaging/registration-token-not-registered" ||
            resp.error.code === "messaging/invalid-registration-token";
        if (isExpiredToken) {
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
