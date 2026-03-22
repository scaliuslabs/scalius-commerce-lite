// src/modules/notifications/notifications.service.ts
// Centralized notification service for admin push + order email notifications.

import type { Database } from "@scalius/database/client";
import { adminFcmTokens, settings } from "@scalius/database/schema";
import { getFirebaseAdminMessaging } from "../../integrations/firebase/admin";
import { eq, sql, and, inArray } from "drizzle-orm";
import { sendEmail } from "../../integrations/email";
import { escapeHtml } from "@scalius/shared/html-escape";

// ─────────────────────────────────────────
// Admin push notification
// ─────────────────────────────────────────

interface OrderNotificationData {
    id: string;
    customerName: string;
}

/**
 * Sends a push notification to all active admin devices about a new order.
 * Designed to be run in the background (using ctx.waitUntil) — catches its
 * own errors to avoid unhandled promise rejections.
 */
export async function sendOrderNotification(
    db: Database,
    order: OrderNotificationData,
    env: Env,
    requestUrl: string,
) {
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
            if (result && result.value) {
                serviceAccountJson = result.value;
            }
        } catch (e: unknown) {
            console.warn(
                "Failed to fetch custom Firebase credentials from DB, falling back to env:",
                e,
            );
        }

        const messaging = getFirebaseAdminMessaging(env, serviceAccountJson);

        // Get all active admin tokens
        const tokensSnapshot = await db
            .select({ token: adminFcmTokens.token })
            .from(adminFcmTokens)
            .where(eq(adminFcmTokens.isActive, true));

        if (tokensSnapshot.length === 0) {
            return;
        }

        const tokens = tokensSnapshot.map((t) => t.token);
        const baseUrl = env.PUBLIC_API_BASE_URL || new URL(requestUrl).origin;
        const orderViewLink = `${baseUrl}/admin/orders/${order.id}`;

        const safeName = escapeHtml(order.customerName || "Unknown Customer");
        const messagePayload = {
            notification: {
                title: "New Order Created!",
                body: `Order ${order.id} from ${safeName}. Click to view.`,
            },
            webpush: {
                fcmOptions: {
                    link: orderViewLink,
                },
            },
            data: {
                orderId: order.id,
                customerName: safeName,
                link: orderViewLink,
            },
            tokens,
        };

        const response = await messaging.sendEachForMulticast(messagePayload);

        // Handle invalid tokens to keep the list clean
        if (response.failureCount > 0) {
            const invalidTokens: string[] = [];
            response.responses.forEach((resp, index) => {
                if (resp.error) {
                    const isExpiredToken =
                        resp.error.code === "messaging/registration-token-not-registered" ||
                        resp.error.code === "messaging/invalid-registration-token";
                    if (isExpiredToken) {
                        console.warn(`[Notifications] FCM token #${index} expired/invalid (${resp.error.code}) — will deactivate`);
                    } else {
                        console.error(`[Notifications] FCM send failed for token #${index}:`, resp.error.code, resp.error.message);
                    }
                    if (isExpiredToken) {
                        const failedToken = tokens[index];
                        if (failedToken) {
                            invalidTokens.push(failedToken);
                        }
                    }
                }
            });

            if (invalidTokens.length > 0) {
                console.log(`Deactivating ${invalidTokens.length} invalid FCM tokens.`);
                await db
                    .update(adminFcmTokens)
                    .set({
                        isActive: false,
                        updatedAt: sql`(cast(strftime('%s','now') as int))`,
                    })
                    .where(inArray(adminFcmTokens.token, invalidTokens));
            }
        }
    } catch (error: unknown) {
        // Log but don't crash — this runs in background via ctx.waitUntil
        console.error("[Notifications] Push notification failed for order", order.id, ":", error instanceof Error ? error.message : error);
    }
}

// ─────────────────────────────────────────
// Order email notifications
// ─────────────────────────────────────────

type OrderEmailType = "order_created" | "order_confirmed" | "order_processing" | "order_shipped" | "order_delivered" | "order_completed" | "order_cancelled" | "order_returned" | "order_refunded";

/**
 * Dispatches order notifications to all enabled channels (email, SMS, WhatsApp).
 * Reads channel preferences from DB. Each channel is independent — disabling
 * email does NOT prevent SMS from sending, and vice versa.
 *
 * @param db - Database instance for reading channel preferences and customer data
 */
export async function sendOrderNotificationEmail(
    email: string,
    name: string,
    orderId: string,
    type: OrderEmailType,
    data?: Record<string, unknown>,
    db?: Database,
): Promise<void> {
    // Determine which channels are enabled for this notification type
    let enabledChannels: string[] = ["email"]; // default: email only
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

    const subjects: Record<string, string> = {
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

    const htmlMessages: Record<string, string> = {
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

    const smsMessages: Record<string, string> = {
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

    // ── Email channel ──────────────────────────────────────────────────
    if (enabledChannels.includes("email") && email) {
        try {
            await sendEmail({
                to: email,
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
            });
        } catch (emailError: unknown) {
            console.error(`[Notifications] Email failed for ${type} (order ${orderId}):`, emailError);
        }
    }

    // ── SMS channel ────────────────────────────────────────────────────
    if (enabledChannels.includes("sms") && db) {
        try {
            const { getActiveSmsProvider } = await import("../../integrations/sms");
            const { orders } = await import("@scalius/database/schema");
            const { eq: eqOp } = await import("drizzle-orm");
            const orderRow = await db.select({ customerPhone: orders.customerPhone }).from(orders).where(eqOp(orders.id, orderId)).get();
            const customerPhone = orderRow?.customerPhone;
            if (customerPhone) {
                const smsProvider = await getActiveSmsProvider(db);
                if (smsProvider) {
                    const msg = smsMessages[type] || `Hi ${name}, your order #${orderId} status has been updated.`;
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
        }
    }

    // ── WhatsApp channel ───────────────────────────────────────────────
    if (enabledChannels.includes("whatsapp")) {
        console.log(`[Notifications] WhatsApp order notifications not yet implemented for ${type} (order ${orderId})`);
    }

    // Push notifications are handled separately by sendOrderNotification() in the queue consumer
}
