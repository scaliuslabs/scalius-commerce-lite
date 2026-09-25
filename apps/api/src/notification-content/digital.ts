// Send-time content for `order_digital_delivered` (Wave B §10): file names,
// licence keys (decrypted now, never stored in the outbox) and the link to
// `/account/downloads` or `/track-order`. B3 fills it by calling the digital
// domain's public entry; the notifications domain never imports `digital`.
//
// Contract (every resolver in this folder):
//   - `null` = nothing to send. The consumer records one skipped
//     `nothing_to_send` receipt and marks the outbox row sent: terminal, never
//     retried, never dead-lettered.
//   - a thrown error = retry: the row is marked failed with backoff and
//     dead-letters only after the attempt cap.
//   - values are plain strings for the template variables; they are never
//     persisted or logged, and code-bearing values are scrubbed from receipts.
import type { Database } from "@scalius/database/client";
import type { NotificationData, NotificationExtraTemplateData } from "@scalius/core/modules/notifications";

export interface DigitalDeliveryContentInput {
  orderId: string;
  /** The outbox row's id-only facts (the fulfilment id). */
  data: NotificationData;
}

/** Stub until B3: nothing to send. */
export async function resolveDigitalDeliveryContent(
  _db: Database,
  _env: Env,
  _input: DigitalDeliveryContentInput,
): Promise<NotificationExtraTemplateData | null> {
  return null;
}
