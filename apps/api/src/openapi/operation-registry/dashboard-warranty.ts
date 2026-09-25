// Agent operation registry rows for the dashboard warranty routes (Wave B §5, §7.2).
// Policies are catalogue setup an agent may manage like any product fact; an
// edit is guarded by the version the editor loaded. Claim decisions and
// staff-opened claims message the buyer on the store's behalf, so they stay a
// staff browser surface until a reviewed agent intent exists.
import type { OperationRegistryEntry } from "./entry";

const STAFF_CLAIM_DECISION =
  "Warranty claim decisions and staff-opened claims post a public message to the buyer on the store's behalf; they stay a staff browser surface until a reviewed agent intent exists.";

export const DASHBOARD_WARRANTY_OPERATIONS = {
  "dashboard.warranty_policies.list": { internal: true },
  "dashboard.warranty_policies.get": { internal: true },
  "dashboard.warranty_policies.create": { internal: true },
  "dashboard.warranty_policies.update": { internal: true, revision: "required" },
  "dashboard.warranty_policies.archive": { internal: true, risk: "destructive" },
  "dashboard.warranty_policies.restore": { internal: true },
  "dashboard.warranty_claims.list": { internal: true },
  "dashboard.warranty_claims.get": { internal: true },
  "dashboard.warranty_claims.update": { exposure: "excluded", revision: "required", reason: STAFF_CLAIM_DECISION },
  "dashboard.orders.warranty_claim_open": { exposure: "excluded", idempotency: "required", reason: STAFF_CLAIM_DECISION },
} satisfies Record<string, OperationRegistryEntry>;
