// src/server/routes/meta-conversions.ts

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createId } from "@paralleldrive/cuid2";
import { sendCapiEvent } from "@/lib/meta/conversions-api";

const app = new Hono<{ Bindings: Env }>();

// Zod schema for incoming event data from the storefront
// This has been expanded to include more optional user data fields for better matching.
const eventPayloadSchema = z.object({
  eventName: z.enum([
    "ViewContent",
    "Search",
    "AddToCart",
    "InitiateCheckout",
    "AddPaymentInfo",
    "Purchase",
    "Lead",
    "CompleteRegistration",
  ]),
  eventSourceUrl: z.string().url(),
  actionSource: z
    .enum([
      "website",
      "app",
      "offline",
      "chat",
      "physical_store",
      "system_generated",
      "business_messaging",
      "other",
    ])
    .optional()
    .default("website"),
  userData: z
    .object({
      // Existing fields
      em: z.string().email().optional(),
      ph: z.string().optional(),
      client_ip_address: z.string().ip().optional(),
      client_user_agent: z.string().optional(),
      fbp: z.string().optional(),
      fbc: z.string().optional(),
      external_id: z.union([z.string(), z.array(z.string())]).optional(),

      // --- NEWLY ADDED OPTIONAL FIELDS ---
      fn: z.string().optional(), // First Name
      ln: z.string().optional(), // Last Name
      ge: z.enum(["f", "m"]).optional(), // Gender ('f' or 'm')
      db: z.string().optional(), // Date of Birth (e.g., '19901020')
      ct: z.string().optional(), // City
      st: z.string().optional(), // State
      zp: z.string().optional(), // Zip Code
      country: z.string().optional(), // Country (2-letter ISO code)
      subscription_id: z.string().optional(),
      lead_id: z.coerce.number().optional(),
    })
    .passthrough(), // Allow other non-validated fields
  customData: z
    .object({
      value: z.number().optional(),
      currency: z.string().optional(),
      content_ids: z.array(z.string()).optional(),
      contents: z
        .array(
          z.object({
            id: z.string(),
            quantity: z.number(),
            item_price: z.number().optional(),
          }),
        )
        .optional(),
      content_type: z.enum(["product", "product_group"]).optional(),
      order_id: z.string().optional(),
      search_string: z.string().optional(),
    })
    .passthrough()
    .optional(), // Allow other non-validated fields
});

app.post(
  "/events",
  zValidator("json", eventPayloadSchema),
  async (c) => {
    console.log("[Hono /meta/events] Received event request.");
    const body = c.req.valid("json");
    const eventId = createId(); // Create a unique ID for this event for deduplication

    // Create the promise for the async task
    const eventPromise = sendCapiEvent({
      event_name: body.eventName,
      event_time: Math.floor(Date.now() / 1000), // Current Unix timestamp
      event_source_url: body.eventSourceUrl,
      event_id: eventId,
      action_source: body.actionSource, // Use dynamic action_source, defaults to 'website'
      user_data: {
        ...body.userData,
        // Forward essential headers from the incoming request as fallbacks
        client_ip_address:
          body.userData.client_ip_address ||
          c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
          c.req.header("x-real-ip"),
        client_user_agent:
          body.userData.client_user_agent || c.req.header("user-agent"),
      },
      custom_data: body.customData,
    });

    // Use waitUntil to ensure the async task completes in the background
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
        c.executionCtx.waitUntil(eventPromise);
        console.log("[Hono /meta/events] Event processing scheduled with waitUntil.");
    } else {
        // This is a fallback for environments where waitUntil is not available (e.g., local Node.js dev)
        // It will delay the response, but ensures the task runs.
        console.warn("[Hono /meta/events] c.executionCtx.waitUntil not available. Awaiting promise directly.");
        await eventPromise;
    }

    // Immediately return a success response to the client
    return c.json({
      success: true,
      message: "Event received and is being processed.",
      eventId: eventId,
    });
  },
);

export { app as metaConversionsRoutes };