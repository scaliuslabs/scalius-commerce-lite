import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  CUSTOMER_REQUEST_POLICY_CATEGORY,
  CUSTOMER_REQUEST_POLICY_KEY,
  normalizeCustomerRequestPolicy,
  type CustomerRequestPolicy,
} from "./customer-request-policy.shared";

export * from "./customer-request-policy.shared";

export async function getCustomerRequestPolicy(db: Database): Promise<CustomerRequestPolicy> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(
      eq(settings.category, CUSTOMER_REQUEST_POLICY_CATEGORY),
      eq(settings.key, CUSTOMER_REQUEST_POLICY_KEY),
    ))
    .get();
  return normalizeCustomerRequestPolicy(row?.value);
}

export async function saveCustomerRequestPolicy(
  db: Database,
  value: unknown,
): Promise<CustomerRequestPolicy> {
  const policy = normalizeCustomerRequestPolicy(value);
  await db
    .insert(settings)
    .values({
      id: `setting_${nanoid(16)}`,
      category: CUSTOMER_REQUEST_POLICY_CATEGORY,
      key: CUSTOMER_REQUEST_POLICY_KEY,
      value: JSON.stringify(policy),
      type: "json",
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: {
        value: JSON.stringify(policy),
        type: "json",
        updatedAt: sql`unixepoch()`,
      },
    });
  return policy;
}
