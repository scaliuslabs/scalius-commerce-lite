// src/modules/notifications/notifications.service.ts
// Centralized notification service for admin push + order notifications.

import type { Database } from "@scalius/database/client";
import { adminFcmTokens, orders } from "@scalius/database/schema";
import { escapeHtml } from "@scalius/shared/html-escape";
import { isReady } from "@scalius/shared/readiness";
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
import {
    getNotificationProviderBlock,
    isNotificationProviderBreakerFailure,
    markNotificationProviderBlocked,
} from "./notification-provider-health";
import { ORDER_NOTIFICATION_LABELS, type OrderNotificationType } from "./notification-types";
import { composeOrderEmail, composeOrderSms, composeStaffOrderEmail, readOrderMessageContext } from "./order-email";
import { notificationsDocument } from "../settings/documents";
import { getNotificationTemplates } from "./notification-templates.service";

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

const MAX_ORDER_NOTIFICATION_DELIVERY_ATTEMPTS = 8;

const CUSTOMER_CHANNELS = new Set(["email", "sms", "whatsapp"]);

/** The skipped-receipt reason when every customer channel is off for the event. */
export const NOTIFICATION_TURNED_OFF = "notification_turned_off";

const NON_RETRYABLE_DISPATCH_ERROR_PATTERNS = [
    /no configured .*provider/i,
    /no active .*provider/i,
    /provider .*not ready/i,
    /could not be decrypted/i,
    /credential/i,
    /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
    /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
    /\b(?:http|status|code|error)?\s*(?:400|401|402|403|404|405|422)\b/i,
    /not configured/i,
    /permission/i,
    /sender/i,
    /sender id mismatch/i,
    /mismatched credential/i,
    /invalid[_\s-]?grant/i,
    /private key/i,
    /service account/i,
    /insufficient\s+(?:balance|credit)/i,
    /\bbalance\b/i,
    /account\s+(?:expired|suspended|inactive|disabled)/i,
];

/** The dashboard order page (BETTER_AUTH_URL is the dashboard origin from Platform settings). */
function resolveDashboardOrderLink(env: object | undefined, orderId: string): string | null {
    const origin = (env as { BETTER_AUTH_URL?: unknown } | undefined)?.BETTER_AUTH_URL;
    const dashboardUrl = typeof origin === "string" ? origin.trim() : "";
    if (!dashboardUrl) return null;
    try {
        return new URL(`/admin/orders/${encodeURIComponent(orderId)}`, dashboardUrl).href;
    } catch {
        return null;
    }
}

function credentialEncryptionKeyFromEnv(env: Env): string | undefined {
    const source = env as unknown as Record<string, unknown>;
    return source.CREDENTIAL_ENCRYPTION_KEY as string | undefined;
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

function getFcmProviderSetupFailureReason(error: FcmSendError | undefined): string | undefined {
    if (!error) return undefined;

    const normalized = [error.code, error.status, error.message]
        .map(normalizeFcmErrorPart)
        .filter(Boolean)
        .join(" ");
    if (!normalized || !isNotificationProviderBreakerFailure(normalized)) return undefined;

    const code = String(error.code ?? error.status ?? "fcm_provider_setup_failure").trim();
    const message = String(error.message ?? "").replace(/\s+/g, " ").trim();
    return message ? `${code}: ${message}` : code;
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
    // Retained for the queue-consumer call site; the push link is resolved
    // from the composed dashboard origin, not from the request.
    _requestUrl: string,
    options: AdminPushOptions = {},
): Promise<OrderNotificationDispatchResult> {
    const outcomes: OrderNotificationChannelOutcome[] = [];
    const notificationType = order.notificationType ?? "order_created";

    try {
        if (options.outboxId) {
            const blocked = await recordProviderBlockedDeliveryIfNeeded({
                db,
                outboxId: options.outboxId,
                orderId: order.id,
                notificationType,
                channel: "push",
                provider: "fcm",
                recipient: `firebase-setup:${order.id}:${notificationType}`,
                recipientMasked: "admin-fcm",
            });
            if (blocked) {
                outcomes.push(blocked);
                return buildDispatchResult(outcomes);
            }
        }

        let serviceAccountJson: string | undefined;
        try {
            serviceAccountJson = await readFirebaseServiceAccountJson(
                db,
                credentialEncryptionKeyFromEnv(env),
            );
        } catch (e: unknown) {
            console.warn(
                "Failed to read the Firebase service account from settings; admin push is unavailable:",
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
        // The notification opens the dashboard order page, so the link must be
        // the dashboard origin (BETTER_AUTH_URL from Platform settings), never
        // the API origin or the current request origin. FCM requires an
        // absolute HTTPS link; when the dashboard origin is not configured the
        // link is omitted and the service worker falls back to the order list.
        const orderViewLink = resolveDashboardOrderLink(env, order.id);

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
            ...(orderViewLink ? { webpush: { fcmOptions: { link: orderViewLink } } } : {}),
            data: {
                orderId: order.id,
                customerName: safeName,
                notificationType,
                ...(orderViewLink ? { link: orderViewLink } : {}),
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

        let response: Awaited<ReturnType<typeof messaging.sendEachForMulticast>>;
        try {
            response = await messaging.sendEachForMulticast({
                ...messagePayload,
                tokens: claimedTargets.map((entry) => entry.token),
            });
        } catch (sendError: unknown) {
            const nonRetryable = isNonRetryableDispatchError(sendError);
            if (nonRetryable) {
                await blockProviderForMerchantActionableFailure(db, {
                    channel: "push",
                    provider: "fcm",
                    reason: normalizeError(sendError),
                });
            }
            for (const entry of claimedTargets) {
                outcomes.push(
                    nonRetryable
                        ? await markSkippedOutcome(
                            db,
                            entry.target,
                            entry.receipt,
                            normalizeError(sendError),
                            {
                                provider: "fcm",
                                providerStatus: normalizeError(sendError),
                                rawResponse: normalizeError(sendError),
                            },
                        )
                        : await markFailedOutcome(
                            db,
                            entry.target,
                            entry.receipt,
                            sendError,
                            {
                                provider: "fcm",
                                providerStatus: "messaging/unknown-error",
                                rawResponse: normalizeError(sendError),
                            },
                        ),
                );
            }
            return buildDispatchResult(outcomes);
        }
        const invalidTokens: string[] = [];
        let fcmProviderSetupFailureBlocked = false;

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
                const providerSetupFailureReason = getFcmProviderSetupFailureReason(resp.error);
                if (providerSetupFailureReason) {
                    if (!fcmProviderSetupFailureBlocked) {
                        fcmProviderSetupFailureBlocked = true;
                        await blockProviderForMerchantActionableFailure(db, {
                            channel: "push",
                            provider: "fcm",
                            reason: providerSetupFailureReason,
                        });
                        console.warn(
                            `[Notifications] FCM provider setup failure for ${claimedTargets.length} admin push receipt(s); ` +
                                `skipping until Firebase settings are saved: ${compactProviderLogDetail(providerSetupFailureReason)}`,
                        );
                    }
                    outcomes.push(await markSkippedOutcome(
                        db,
                        entry.target,
                        entry.receipt,
                        providerSetupFailureReason,
                        {
                            provider: "fcm",
                            providerStatus: errorCode,
                            rawResponse: errorMessage,
                        },
                    ));
                    continue;
                }

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
        const nonRetryable = isNonRetryableDispatchError(error);
        if (nonRetryable) {
            await blockProviderForMerchantActionableFailure(db, {
                channel: "push",
                provider: "fcm",
                reason: normalizeError(error),
            });
        }
        if (options.outboxId && nonRetryable) {
            try {
                outcomes.push(await recordSkippedDelivery({
                    db,
                    outboxId: options.outboxId,
                    orderId: order.id,
                    notificationType,
                    channel: "push",
                    provider: "fcm",
                    recipient: `firebase-setup:${order.id}:${notificationType}`,
                    recipientMasked: "admin-fcm",
                    reason: normalizeError(error),
                }));
                return buildDispatchResult(outcomes);
            } catch (receiptError: unknown) {
                console.error(
                    "[Notifications] Failed to record push setup receipt for order",
                    order.id,
                    ":",
                    receiptError instanceof Error ? receiptError.message : receiptError,
                );
            }
        }
        return buildDispatchResult([
            ...outcomes,
            {
                channel: "push",
                provider: "fcm",
                recipientMasked: "admin-fcm",
                status: nonRetryable ? "skipped" : "failed",
                error: normalizeError(error),
                retryable: Boolean(options.outboxId) && !nonRetryable,
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
    data: Record<string, unknown> | undefined,
    db: Database,
    options: OrderNotificationOptions = {},
): Promise<OrderNotificationDispatchResult> {
    const outcomes: OrderNotificationChannelOutcome[] = [];
    // Every buyer notification, including the support-request acknowledgement,
    // defaults to email; the merchant's saved channels override it.
    let enabledChannels = ["email"];
    try {
        const { getNotificationChannels } = await import("../settings/settings.service");
        enabledChannels = (await getNotificationChannels(db))[type] ?? enabledChannels;
    } catch (channelError: unknown) {
        console.warn("[Notifications] Failed to check channel preferences, defaulting to email:", channelError);
    }

    // Read lazily, after a target is claimed: an accepted or skipped receipt
    // never re-reads the order or the store's templates.
    const context = once(() => readOrderMessageContext({
        orderId, name, type, data,
        storefrontUrl: typeof options.env?.STOREFRONT_URL === "string" ? options.env.STOREFRONT_URL : undefined,
    }, db));
    const templates = once(async () => (await getNotificationTemplates(db, (await context()).language)).templates);
    const smsMessage = async () => composeOrderSms(await context(), (await templates()).sms[type].body);

    const receiptEnabled = Boolean(db && options.outboxId);
    const receiptDb = receiptEnabled ? db : undefined;
    const outboxId = options.outboxId;

    // The merchant turned this message off: the order's log says so ("Not sent")
    // instead of showing the message as sent.
    if (receiptDb && outboxId && !enabledChannels.some((channel) => CUSTOMER_CHANNELS.has(channel))) {
        outcomes.push(await recordSkippedDelivery({
            db: receiptDb,
            outboxId,
            orderId,
            notificationType: type,
            channel: "email",
            provider: "email",
            recipient: email || `missing-email:${orderId}`,
            recipientMasked: email ? maskEmail(email) : "missing-email",
            reason: NOTIFICATION_TURNED_OFF,
        }));
        return buildDispatchResult(outcomes);
    }

    if (enabledChannels.includes("email")) {
        const composeEmail = async () => composeOrderEmail(await context(), (await templates()).email[type]);

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
            const blocked = await recordProviderBlockedDeliveryIfNeeded({
                db: receiptDb,
                outboxId,
                orderId,
                notificationType: type,
                channel: "email",
                provider: "email",
                recipient: email,
                recipientMasked: maskEmail(email),
            });
            if (blocked) {
                outcomes.push(blocked);
            } else {
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
                        ...await composeEmail(),
                        to: email,
                        idempotencyKey: target.receiptKey,
                    }, {
                        db,
                        env: options.env,
                        encryptionKey: options.encryptionKey,
                    })),
                }));
            }
        } else {
            try {
                const result = await sendEmail({
                    ...await composeEmail(),
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
            const { getActiveSmsProvider, getSmsProviderReadiness } = await import("../../integrations/sms");
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
                const smsReadiness = await getSmsProviderReadiness(db, options.encryptionKey);
                const readinessProviderName = smsReadiness.activeProvider ?? "sms";

                if (!isReady(smsReadiness)) {
                    const reason = smsReadiness.issues[0]?.message ?? "SMS provider is not configured";
                    if (receiptDb && outboxId) {
                        const blocked = await recordProviderBlockedDeliveryIfNeeded({
                            db: receiptDb,
                            outboxId,
                            orderId,
                            notificationType: type,
                            channel: "sms",
                            provider: readinessProviderName,
                            recipient: `sms-setup:${orderId}:${type}`,
                            recipientMasked: "sms-setup",
                        });
                        if (blocked) {
                            outcomes.push(blocked);
                        } else {
                            await blockProviderForMerchantActionableFailure(receiptDb, {
                                channel: "sms",
                                provider: readinessProviderName,
                                reason,
                            });
                            outcomes.push(await recordSkippedDelivery({
                                db: receiptDb,
                                outboxId,
                                orderId,
                                notificationType: type,
                                channel: "sms",
                                provider: readinessProviderName,
                                recipient: `sms-setup:${orderId}:${type}`,
                                recipientMasked: "sms-setup",
                                reason,
                            }));
                        }
                    } else {
                        console.warn(
                            `[Notifications] SMS channel enabled for ${type} but provider is not ready: ${compactProviderLogDetail(reason)}`,
                        );
                    }
                } else {
                    const smsProvider = await getActiveSmsProvider(db, options.encryptionKey);
                    const providerName = smsProvider?.name ?? readinessProviderName;

                    if (receiptDb && outboxId) {
                        const blocked = await recordProviderBlockedDeliveryIfNeeded({
                            db: receiptDb,
                            outboxId,
                            orderId,
                            notificationType: type,
                            channel: "sms",
                            provider: providerName,
                            recipient: customerPhone,
                            recipientMasked: maskPhone(customerPhone),
                        });
                        if (blocked) {
                            outcomes.push(blocked);
                        } else {
                            outcomes.push(await dispatchWithReceipt({
                                db: receiptDb,
                                outboxId,
                                orderId,
                                notificationType: type,
                                channel: "sms",
                                provider: providerName,
                                recipient: customerPhone,
                                recipientMasked: maskPhone(customerPhone),
                                send: async (target) => {
                                    if (!smsProvider) {
                                        return {
                                            success: false,
                                            provider: "sms",
                                            providerStatus: "missing_sms_provider",
                                            rawResponse: "No active SMS provider configured",
                                            retryable: false,
                                        };
                                    }
                                    const smsResult = await smsProvider.sendSms({
                                        to: customerPhone,
                                        message: await smsMessage(),
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
                                        retryable: smsResult.retryable,
                                    };
                                },
                            }));
                        }
                    } else if (smsProvider) {
                        const smsResult = await smsProvider.sendSms({ to: customerPhone, message: await smsMessage() });
                        if (smsResult.success) {
                            console.log(`[Notifications] SMS sent via ${smsProvider.name} for ${type} (order ${orderId}), ref=${smsResult.providerRef}`);
                        } else {
                            console.error(`[Notifications] SMS failed via ${smsProvider.name} for ${type} (order ${orderId}): ${smsResult.rawStatus}`);
                        }
                    } else {
                        console.warn(`[Notifications] SMS channel enabled for ${type} but no SMS provider configured`);
                    }
                }
            }
        } catch (smsError: unknown) {
            console.error(`[Notifications] SMS dispatch failed for ${type} (order ${orderId}): ${compactProviderLogDetail(smsError)}`);
            if (receiptDb && outboxId) {
                const reason = normalizeError(smsError);
                if (isNonRetryableDispatchStatus(reason)) {
                    await blockProviderForMerchantActionableFailure(receiptDb, {
                        channel: "sms",
                        provider: "sms",
                        reason,
                    });
                    outcomes.push(await recordSkippedDelivery({
                        db: receiptDb,
                        outboxId,
                        orderId,
                        notificationType: type,
                        channel: "sms",
                        provider: "sms",
                        recipient: `sms-setup:${orderId}:${type}`,
                        recipientMasked: "sms-setup",
                        reason,
                    }));
                } else {
                    outcomes.push({
                        channel: "sms",
                        provider: "sms",
                        recipientMasked: "unknown",
                        status: "failed",
                        error: reason,
                        retryable: true,
                    });
                }
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
                        ? await resolveOrderWhatsAppSendConfig(db, options.encryptionKey)
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
                            orderNumber: (await context()).variables.order_number ?? `#${orderId}`,
                            notificationType: type,
                            customerName: name,
                            customerPhone,
                            data,
                        });

                        if (receiptDb && outboxId) {
                            const blocked = await recordProviderBlockedDeliveryIfNeeded({
                                db: receiptDb,
                                outboxId,
                                orderId,
                                notificationType: type,
                                channel: "whatsapp",
                                provider: "whatsapp",
                                recipient: `whatsapp:${whatsappRecipient}`,
                                recipientMasked: maskPhone(customerPhone),
                            });
                            if (blocked) {
                                outcomes.push(blocked);
                            } else {
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
                            }
                        } else if (db) {
                            const result = await send();
                            if (result.success) {
                                console.log(`[Notifications] WhatsApp sent for ${type} (order ${orderId}), ref=${result.providerMessageId}`);
                            } else {
                                console.error(
                                    `[Notifications] WhatsApp failed for ${type} (order ${orderId}): ${compactProviderLogDetail(result.providerStatus ?? result.rawResponse ?? "provider_failure")}`,
                                );
                            }
                        } else {
                            console.warn(`[Notifications] WhatsApp channel enabled for ${type} without a database connection`);
                        }
                    }
                }
            }
        } catch (whatsappError: unknown) {
            console.error(`[Notifications] WhatsApp dispatch failed for ${type} (order ${orderId}): ${compactProviderLogDetail(whatsappError)}`);
            if (receiptDb && outboxId) {
                const reason = normalizeError(whatsappError);
                if (isNonRetryableDispatchStatus(reason)) {
                    outcomes.push(await recordSkippedDelivery({
                        db: receiptDb,
                        outboxId,
                        orderId,
                        notificationType: type,
                        channel: "whatsapp",
                        provider: "whatsapp",
                        recipient: `whatsapp-setup:${orderId}:${type}`,
                        recipientMasked: "whatsapp-setup",
                        reason,
                    }));
                } else {
                    outcomes.push({
                        channel: "whatsapp",
                        provider: "whatsapp",
                        recipientMasked: "unknown",
                        status: "failed",
                        error: reason,
                        retryable: true,
                    });
                }
            }
        }
    }

    return buildDispatchResult(outcomes);
}

/**
 * Emails every staff recipient from the notifications settings about a new
 * order, after it committed (from the order notification queue). Each
 * recipient is its own delivery receipt, so a retried outbox row never
 * emails the same person twice.
 */
export async function sendStaffOrderEmails(
    db: Database,
    order: { id: string; customerName: string; notificationType: OrderNotificationType },
    options: OrderNotificationOptions = {},
): Promise<OrderNotificationDispatchResult> {
    if (order.notificationType !== "order_created") return EMPTY_DISPATCH_RESULT;
    const recipients = (await notificationsDocument.read(db)).staffEmailRecipients;
    if (recipients.length === 0) return EMPTY_DISPATCH_RESULT;

    const context = once(() => readOrderMessageContext({
        orderId: order.id,
        name: order.customerName,
        type: order.notificationType,
    }, db));
    const compose = async () =>
        composeStaffOrderEmail(await context(), resolveDashboardOrderLink(options.env, order.id));
    const emailContext = { db, env: options.env, encryptionKey: options.encryptionKey };
    const outcomes: OrderNotificationChannelOutcome[] = [];

    for (const recipient of recipients) {
        const target = {
            channel: "email" as const,
            provider: "email",
            // Distinct from a customer who uses the same address.
            recipient: `staff:${recipient}`,
            recipientMasked: `staff ${maskEmail(recipient)}`,
        };
        if (!options.outboxId) {
            try {
                const result = await sendEmail({ ...await compose(), to: recipient }, emailContext);
                if (!result.success) {
                    console.error(`[Notifications] Staff order email did not send for order ${order.id}: ${compactProviderLogDetail(result.rawStatus)}`);
                }
            } catch (error: unknown) {
                console.error(`[Notifications] Staff order email failed for order ${order.id}: ${compactProviderLogDetail(error)}`);
            }
            continue;
        }
        const receipt = { db, outboxId: options.outboxId, orderId: order.id, notificationType: order.notificationType, ...target };
        const blocked = await recordProviderBlockedDeliveryIfNeeded(receipt);
        outcomes.push(blocked ?? await dispatchWithReceipt({
            ...receipt,
            send: async (delivery) => emailResultToDeliveryResult(await sendEmail({
                ...await compose(),
                to: recipient,
                idempotencyKey: delivery.receiptKey,
            }, emailContext)),
        }));
    }
    return buildDispatchResult(outcomes);
}

async function sendOrderWhatsAppTemplate(options: {
    config: OrderWhatsAppSendConfig;
    orderNumber: string;
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
): Promise<OrderWhatsAppSendConfig | null> {
    const whatsapp = await getWhatsAppCloudApiSettings(db, encryptionKey);
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
    orderNumber: string;
    notificationType: OrderNotificationType;
    customerName: string;
    data?: Record<string, unknown>;
}): string[] {
    const label = ORDER_NOTIFICATION_LABELS[options.notificationType] ?? "Order Update";
    return [
        templateText(options.customerName, "Customer", 80),
        templateText(options.orderNumber, "order", 80),
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
            if (!isDeliveryFailureRetryable(result)) {
                await blockProviderForMerchantActionableFailure(options.db, {
                    channel: options.channel,
                    provider: options.provider,
                    reason: result.providerStatus ?? result.rawResponse ?? "provider_non_retryable_failure",
                });
                return await markSkippedOutcome(
                    options.db,
                    target,
                    claim.receipt,
                    result.providerStatus ?? result.rawResponse ?? "provider_non_retryable_failure",
                    result,
                );
            }
            return await markFailedOutcome(options.db, target, claim.receipt, new Error(result.rawResponse ?? result.providerStatus ?? "Provider send failed"), result);
        }
        return await markAcceptedOutcome(options.db, target, claim.receipt, result);
    } catch (error: unknown) {
        if (isNonRetryableDispatchError(error)) {
            const status = normalizeError(error);
            await blockProviderForMerchantActionableFailure(options.db, {
                channel: options.channel,
                provider: options.provider,
                reason: status,
            });
            return await markSkippedOutcome(
                options.db,
                target,
                claim.receipt,
                status,
                {
                    provider: options.provider,
                    providerStatus: status,
                    rawResponse: status,
                },
            );
        }
        return await markFailedOutcome(options.db, target, claim.receipt, error);
    }
}

async function recordProviderBlockedDeliveryIfNeeded(options: {
    db: Database;
    outboxId: string;
    orderId: string;
    notificationType: OrderNotificationType;
    channel: OrderNotificationDeliveryChannel;
    provider: string;
    recipient: string;
    recipientMasked: string;
}): Promise<OrderNotificationChannelOutcome | null> {
    const block = await getNotificationProviderBlock(options.db, {
        channel: options.channel,
        provider: options.provider,
    });
    if (!block) return null;

    if (block.source === "receipt") {
        await markNotificationProviderBlocked(options.db, {
            channel: block.channel,
            provider: block.provider,
            reason: block.reason,
        }).catch((error: unknown) => {
            console.error(
                `[Notifications] Failed to restore ${block.channel}/${block.provider} provider block from delivery history:`,
                error instanceof Error ? error.message : error,
            );
        });
    }

    return await recordSkippedDelivery({
        db: options.db,
        outboxId: options.outboxId,
        orderId: options.orderId,
        notificationType: options.notificationType,
        channel: options.channel,
        provider: options.provider,
        recipient: options.recipient,
        recipientMasked: options.recipientMasked,
        reason: buildProviderBlockedReason(block.reason),
    });
}

async function blockProviderForMerchantActionableFailure(
    db: Database,
    options: {
        channel: OrderNotificationDeliveryChannel;
        provider: string;
        reason: string;
    },
): Promise<void> {
    if (!isNotificationProviderBreakerFailure(options.reason)) return;

    await markNotificationProviderBlocked(db, {
        channel: options.channel,
        provider: options.provider,
        reason: options.reason,
    }).catch((error: unknown) => {
        console.error(
            `[Notifications] Failed to block ${options.channel}/${options.provider} provider after setup failure:`,
            error instanceof Error ? error.message : error,
        );
    });
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
    if (receipt.attempts >= MAX_ORDER_NOTIFICATION_DELIVERY_ATTEMPTS) {
        const rawResponse = result.rawResponse ?? result.providerStatus ?? normalizeError(error);
        await blockProviderForMerchantActionableFailure(db, {
            channel: target.channel,
            provider: result.provider,
            reason: rawResponse,
        });
        return await markSkippedOutcome(
            db,
            target,
            receipt,
            buildAttemptLimitReason(rawResponse),
            {
                provider: result.provider,
                providerMessageId: result.providerMessageId,
                providerStatus: "delivery_attempt_limit_reached",
                rawResponse,
            },
        );
    }

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
        retryable: result.success
            ? false
            : isNonRetryableDispatchStatus(result.rawStatus)
                ? false
                : undefined,
    };
}

function isDeliveryFailureRetryable(result: DeliverySendResult): boolean {
    if (result.retryable !== undefined) return result.retryable;
    const providerText = [result.providerStatus, result.rawResponse]
        .filter((value): value is string => Boolean(value))
        .join(" ");
    return !isNonRetryableDispatchStatus(providerText);
}

function isNonRetryableDispatchError(error: unknown): boolean {
    return isNonRetryableDispatchStatus(normalizeError(error));
}

function isNonRetryableDispatchStatus(value: string | null | undefined): boolean {
    const status = value?.trim();
    if (!status) return false;
    return NON_RETRYABLE_DISPATCH_ERROR_PATTERNS.some((pattern) => pattern.test(status));
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

function buildAttemptLimitReason(rawResponse: string): string {
    const detail = rawResponse.trim();
    return detail
        ? `delivery_attempt_limit_reached: ${detail}`
        : "delivery_attempt_limit_reached";
}

function buildProviderBlockedReason(reason: string): string {
    return `provider_blocked_until_settings_save: ${reason}`;
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

function compactProviderLogDetail(error: unknown): string {
    return normalizeError(error)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
}

/** Runs `load` at most once, on first use. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => (pending ??= load());
}
