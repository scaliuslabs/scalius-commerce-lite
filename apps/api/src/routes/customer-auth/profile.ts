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
  description: "Changes the account's name and WhatsApp number (an empty string clears it; read as checkout reads it). The WhatsApp number is kept only when the store collects one apart from the phone (else 400 `whatsapp_not_collected`; a stored one is dropped on the next save), and the phone's own number is stored as none. A session never changes the phone: a different `phone` is a 409 with `details.reason` `phone_change_needs_codes`. To change it, `POST /customer-auth/phone/send-code` with `phone` (a code to how the account signs in now, one to the new number), then `/phone/verify` with `phone`, `code` and `currentCode`; a buyer who cannot get the first code asks the store. Addresses are in the address book (/customer-auth/addresses).",
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
