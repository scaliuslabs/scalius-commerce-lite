// Customer profile updates.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { updateCustomerProfile } from "@scalius/core/modules/customers";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { customerAuthProfileSchema, requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── PUT /profile ────────────────────────────────────────────────────────────

const updateProfileRoute = createRoute({
  method: "put",
  path: "/profile",
  tags: ["Customer Auth"],
  summary: "Update customer profile",
  description: "Changes the account's name, phone and WhatsApp number (each optional; an empty string clears a number). Numbers are read as checkout reads them. A phone the account signs in with (`phoneVerified`) changes only by proving the new number with a code (`POST /customer-auth/phone/send-code` and `/phone/verify` with `phone`): changing it here is a 409 with `details.reason` `phone_is_sign_in`. A WhatsApp number is kept only when the store collects one apart from the phone (else 400 `whatsapp_not_collected`); the same number as the phone is stored as none. Addresses are in the address book (/customer-auth/addresses).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().max(100).optional(),
            phone: z.string().trim().max(32).nullable().optional(),
            whatsapp: z.string().trim().max(32).nullable().optional(),
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: "Profile updated",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            customer: customerAuthProfileSchema,
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(updateProfileRoute, async (c) => {
  const { session } = await requireCustomerSession(c);
  const body = c.req.valid("json");

  // A blank name is sent through so the service rejects it instead of
  // silently keeping (or dropping) it.
  const db = c.get("db");
  const result = await updateCustomerProfile(db, session, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.whatsapp !== undefined ? { whatsapp: body.whatsapp } : {}),
  });

  return ok(c, {
    customer: result.customer,
  });
});

export { app as customerProfileRoutes };
