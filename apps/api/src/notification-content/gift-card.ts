// Send-time content for `gift_card_issued` (Wave B §4.2, §10): the recipient
// contact on the card (else the order contact, else the owner's verified
// contacts), and the code (decrypted now with the CREDENTIAL_ENCRYPTION_KEY-
// derived key), value, expiry and message. B4 fills it by calling the
// gift-cards domain's public entry; the notifications domain never imports
// `gift-cards`. See `./digital.ts` for the resolver contract (`null` =
// nothing to send, terminal).
import type { Database } from "@scalius/database/client";
import type {
  NotificationData,
  NotificationExtraTemplateData,
  ResolvedNotificationRecipient,
} from "@scalius/core/modules/notifications";

export interface GiftCardIssuedContentInput {
  giftCardId: string;
  /** The outbox row's id-only facts. */
  data: NotificationData;
}

export interface GiftCardIssuedContent {
  /** A delivery target only; it never becomes identity. */
  recipient: ResolvedNotificationRecipient;
  /** The order the card was bought with, if any (receipts link to it). */
  orderId: string | null;
  /** That order's formatted number ("#1057"), if any. */
  orderNumber: string | null;
  extraTemplateData: NotificationExtraTemplateData;
}

/** Stub until B4: nothing to send. */
export async function resolveGiftCardIssuedContent(
  _db: Database,
  _env: Env,
  _input: GiftCardIssuedContentInput,
): Promise<GiftCardIssuedContent | null> {
  return null;
}
