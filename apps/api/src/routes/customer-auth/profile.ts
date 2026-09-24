// Customer profile updates.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { updateCustomerProfile } from "@scalius/core/modules/customers/customer-auth.service";
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
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            zone: z.string().optional(),
            area: z.string().optional(),
            cityName: z.string().optional(),
            zoneName: z.string().optional(),
            areaName: z.string().optional()
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

  // A blank value is sent through so the service can reject a blank name
  // instead of silently keeping (or dropping) it.
  const updates: Record<string, string | undefined> = {};
  for (const field of ["name", "address", "city", "zone", "area"] as const) {
    if (body[field] !== undefined) updates[field] = body[field].trim();
  }

  const db = c.get("db");
  const result = await updateCustomerProfile(db, session, updates);

  return ok(c, {
    customer: result.customer,
  });
});

export { app as customerProfileRoutes };
