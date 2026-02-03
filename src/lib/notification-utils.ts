import { db } from "@/db";
import { adminFcmTokens, settings } from "@/db/schema";
import { getFirebaseAdminMessaging } from "@/lib/firebase/admin";
import { eq, sql, and } from "drizzle-orm";

interface OrderNotificationData {
  id: string;
  customerName: string;
}

/**
 * Sends a push notification to all active admin devices about a new order.
 * This function is designed to be run in the background (using ctx.waitUntil)
 * so it catches its own errors to avoid unhandled promise rejections.
 */
export async function sendOrderNotification(
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
    } catch (e) {
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

    const messagePayload = {
      notification: {
        title: "New Order Created!",
        body: `Order ${order.id} from ${order.customerName}. Click to view.`,
      },
      webpush: {
        fcmOptions: {
          link: orderViewLink,
        },
      },
      data: {
        orderId: order.id,
        customerName: order.customerName || "Unknown Customer",
        link: orderViewLink,
      },
      tokens: tokens, // Multicast to all tokens
    };

    if (process.env.NODE_ENV !== "production") {
      console.log("Sending FCM background notification for order:", order.id);
    }

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
          .where(sql`${adminFcmTokens.token} IN ${invalidTokens}`);
      }
    }
  } catch (error) {
    // Log but don't crash
    console.error("Error in background order notification:", error);
  }
}
