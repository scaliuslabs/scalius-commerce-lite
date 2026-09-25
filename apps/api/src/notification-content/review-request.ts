// Send-time content for `review_request` (Wave B §2.3, §10): the send-time
// recheck (the order is still delivered or completed, a reviewable unreviewed
// line remains, reviews are enabled) and the product names plus the order
// page link (`/account/orders/<id>#reviews` or `/track-order`, never a token).
// B1 fills it by calling the reviews domain's public entry; the notifications
// domain never imports `reviews`. See `./digital.ts` for the resolver contract
// (`null` = nothing to send, terminal).
import type { Database } from "@scalius/database/client";
import type { NotificationData, NotificationExtraTemplateData } from "@scalius/core/modules/notifications";

export interface ReviewRequestContentInput {
  orderId: string;
  /** The outbox row's id-only facts. */
  data: NotificationData;
}

/** Stub until B1: nothing to send. */
export async function resolveReviewRequestContent(
  _db: Database,
  _env: Env,
  _input: ReviewRequestContentInput,
): Promise<NotificationExtraTemplateData | null> {
  return null;
}
