// The customer as every stable customer operation answers it (audit L1): the
// sealed representation a webhook delivery carries (`CustomerResource`,
// built in events/representations.ts), so a write answers what
// `customers.get` reads. Contact fields read null without the matching
// read_customer_* scope (the app dispatch redacts them).
import { z } from "@hono/zod-openapi";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import type { Database } from "@scalius/database/client";
import { readCustomerRepresentations } from "../../events/representations";
import { NotFoundError } from "../../utils/api-error";
import { namedSharedSchema, successEnvelope } from "../../schemas/responses";

const CustomerResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.customer, "CustomerResource");

export const customerEnvelope = successEnvelope(z.object({ customer: CustomerResource }));

/** The customer as it is now. */
export async function readCustomerResource(db: Database, id: string) {
  const [customer] = await readCustomerRepresentations(db, [id]);
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}
