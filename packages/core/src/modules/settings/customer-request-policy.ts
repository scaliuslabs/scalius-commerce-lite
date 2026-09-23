import type { Database } from "@scalius/database/client";
import {
  normalizeCustomerRequestPolicy,
  type CustomerRequestPolicy,
} from "./customer-request-policy.shared";
import { customerRequestsDocument } from "./documents";

export * from "./customer-request-policy.shared";

export async function getCustomerRequestPolicy(db: Database): Promise<CustomerRequestPolicy> {
  return customerRequestsDocument.read(db);
}

export async function saveCustomerRequestPolicy(
  db: Database,
  value: unknown,
): Promise<CustomerRequestPolicy> {
  return (await customerRequestsDocument.write(
    db,
    normalizeCustomerRequestPolicy(value),
    {},
    { replace: true },
  )).value;
}
