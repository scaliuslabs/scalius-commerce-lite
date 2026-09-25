// Agent operation registry rows for the dashboard digital-goods routes (Wave B §7.2).
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_DIGITAL_OPERATIONS = {
  "dashboard.digital_assets.list": {},
  "dashboard.digital_assets.create": {},
  "dashboard.digital_assets.update": { revision: "required" },
  "dashboard.digital_assets.delete": { risk: "destructive" },
  "dashboard.digital_assets.upload_start": {},
  "dashboard.digital_assets.upload_get": {},
  "dashboard.digital_assets.upload_part": {
    exposure: "excluded",
    reason: "Browser-only 50 MiB file parts exceed the agent request ceiling; the dashboard's Digital delivery card uploads them.",
  },
  "dashboard.digital_assets.upload_complete": {},
  "dashboard.digital_assets.licence_keys_list": {},
  "dashboard.digital_assets.licence_keys_import": {
    exposure: "excluded",
    sensitive: true,
    idempotency: "required",
    reason: "Carries plaintext licence keys; keys are imported by staff in the dashboard so they never pass through agent I/O.",
  },
  "dashboard.digital_assets.licence_keys_revoke": { idempotency: "required" },
  "dashboard.digital_entitlements.reset": {},
  "dashboard.digital_entitlements.revoke": { risk: "destructive" },
  "dashboard.orders.digital_resend": { openWorld: true, idempotency: "required" },
} satisfies Record<string, OperationRegistryEntry>;
