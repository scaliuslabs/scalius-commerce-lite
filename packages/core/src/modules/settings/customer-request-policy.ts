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

/** The stored policy and the revision a save must send back. */
export async function getCustomerRequestPolicyDocument(db: Database) {
  const { value, revision } = await customerRequestsDocument.readDetailed(db);
  return { policy: value, revision };
}

export async function saveCustomerRequestPolicy(
  db: Database,
  value: unknown,
  /** The revision the editor loaded; a stale one is a 409 conflict. */
  options: { expectedRevision?: number } = {},
): Promise<{ policy: CustomerRequestPolicy; revision: number }> {
  const { value: policy, revision } = await customerRequestsDocument.write(
    db,
    normalizeCustomerRequestPolicy(value),
    {},
    { replace: true, expectedRevision: options.expectedRevision },
  );
  return { policy, revision };
}
