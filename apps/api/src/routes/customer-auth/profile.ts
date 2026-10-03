// Customer profile updates.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { updateCustomerProfile } from "@scalius/core/modules/customers";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { customerAuthProfileSchema, requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── PUT /profile ────────────────────────────────────────────────────────────

const updateProfileRoute = createRoute({
  method: "put",
  path: "/profile",
  tags: ["Customer Auth"],
  summary: "Update customer profile",
  description: "Changes the account name. Addresses are in the address book (/customer-auth/addresses).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
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
  },
});

app.openapi(updateProfileRoute, async (c) => {
  const { session } = await requireCustomerSession(c);
  const body = c.req.valid("json");

  // A blank name is sent through so the service rejects it instead of
  // silently keeping (or dropping) it.
  const db = c.get("db");
  const result = await updateCustomerProfile(db, session, body.name !== undefined ? { name: body.name.trim() } : {});

  return ok(c, {
    customer: result.customer,
  });
});

export { app as customerProfileRoutes };
