// src/modules/notifications/notifications.service.ts
// Centralized notification service for admin push + order email notifications.
// Extracted from src/lib/notification-utils.ts and src/queue-consumer.ts.

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
                    console.error(`FCM send failed for token #${index}:`, resp.error);
                    if (
                        resp.error.code === "messaging/registration-token-not-registered" ||
                        resp.error.code === "messaging/invalid-registration-token"
                    ) {
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
        // Log but don't crash — this runs in background
        console.error("Error in background order notification:", error);
    }
}

// ─────────────────────────────────────────
// Order email notifications
// ─────────────────────────────────────────

type OrderEmailType = "order_created" | "order_confirmed" | "order_shipped" | "order_delivered";

/**
 * Sends a transactional order update email to a customer.
 * Extracted from the inline helper in queue-consumer.ts.
 */
export async function sendOrderNotificationEmail(
    email: string,
    name: string,
    orderId: string,
    type: OrderEmailType,
    data?: Record<string, unknown>,
): Promise<void> {
    const subjects: Record<string, string> = {
        order_created: `Order #${orderId} Received`,
        order_confirmed: `Order #${orderId} Confirmed`,
        order_shipped: `Order #${orderId} Shipped`,
        order_delivered: `Order #${orderId} Delivered`,
    };

    const safeName = escapeHtml(name);
    const safeTrackingId = data?.trackingId ? escapeHtml(String(data.trackingId)) : "";
    const messages: Record<string, string> = {
        order_created: `Thank you for your order, ${safeName}! We've received your order <strong>#${orderId}</strong> and will process it shortly.`,
        order_confirmed: `Great news, ${safeName}! Your order <strong>#${orderId}</strong> has been confirmed and is being prepared.`,
        order_shipped: `Your order <strong>#${orderId}</strong> is on its way, ${safeName}! ${safeTrackingId ? `Tracking ID: <strong>${safeTrackingId}</strong>` : ""}`,
        order_delivered: `Your order <strong>#${orderId}</strong> has been delivered, ${safeName}! We hope you love your purchase.`,
    };

    await sendEmail({
        to: email,
        subject: subjects[type] || `Order #${orderId} Update`,
        html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>${subjects[type] || "Order Update"}</h2>
        <p>${messages[type] || `Your order #${orderId} has been updated.`}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">
          This is an automated email regarding your order from our store.
        </p>
      </div>
    `,
        text: `${name}, ${messages[type]?.replace(/<[^>]+>/g, "") || `Order #${orderId} updated.`}`,
    });
}
