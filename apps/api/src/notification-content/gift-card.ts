// Send-time content for `gift_card_issued` (Wave B §4.2, §10): the recipient
// contact on the card (else the order contact, else the owner's contacts),
// and the code (decrypted now with the CREDENTIAL_ENCRYPTION_KEY-derived key),
// value, expiry and message. The gift-cards domain resolves the facts; the
// notifications domain never imports `gift-cards`. The code is a template
// variable only: code-bearing sends store no body or raw response in their
// delivery receipts (resolved-notifications.ts redacts it). See
// `./digital.ts` for the resolver contract (`null` = nothing to send, terminal).
import type { Database } from "@scalius/database/client";
import { buyerStorefrontLink, readOrderMessageScope } from "@scalius/core/modules/notifications";
import type {
  NotificationData,
  NotificationExtraTemplateData,
  ResolvedNotificationRecipient,
} from "@scalius/core/modules/notifications";
import { resolveGiftCardIssuedMessage, resolveGiftCardSentMessage } from "@scalius/core/modules/gift-cards";
import { getDecimalPlaces, formatMoney } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { storeTimeZoneOf } from "../utils/store-time-zone";
import { dateLocale, formatDateTime } from "@scalius/shared/locale-format";

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

/** The card's last usable day in the message's language and the store's time zone. */
function formatExpiry(epochSeconds: number | null, language: string, timeZone: string): string {
  if (epochSeconds === null) return "";
  return formatDateTime(epochSeconds * 1000, dateLocale(language), { dateStyle: "medium", timeZone });
}

/** The card's value in the message's language (its digits). */
function cardValue(amountMinor: number, currencyCode: string, language: string): string {
  return formatMoney(fromMinor(amountMinor, getDecimalPlaces(currencyCode)), { code: currencyCode, language });
}

export async function resolveGiftCardIssuedContent(
  db: Database,
  env: Env,
  input: GiftCardIssuedContentInput,
): Promise<GiftCardIssuedContent | null> {
  const message = await resolveGiftCardIssuedMessage(db, {
    giftCardId: input.giftCardId,
    credentialEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
  });
  if (!message) return null;
  // The message's language and links: the presence the card's order was placed on.
  const scope = await readOrderMessageScope(db, message.orderId);
  return {
    recipient: message.recipient,
    orderId: message.orderId,
    orderNumber: message.orderId ? formatOrderNumber(message.orderNumber, message.orderId) : null,
    extraTemplateData: {
      gift_card_code: message.code,
      gift_card_value: cardValue(message.amountMinor, message.currencyCode, scope.language),
      gift_card_expires: formatExpiry(message.expiresAt, scope.language, storeTimeZoneOf(env)),
      gift_card_message: message.message ?? "",
      gift_card_sender: message.senderName ?? "",
      // The balance page (never a URL carrying the code), in that presence.
      gift_card_link: buyerStorefrontLink(env.STOREFRONT_URL, scope.presence, "/gift-card-balance") ?? "",
    },
  };
}

/** Send-time content for `gift_card_sent`: the buyer's confirmation, no code. */
export async function resolveGiftCardSentContent(
  db: Database,
  _env: Env,
  input: GiftCardIssuedContentInput,
): Promise<GiftCardIssuedContent | null> {
  const message = await resolveGiftCardSentMessage(db, { giftCardId: input.giftCardId });
  if (!message) return null;
  const scope = await readOrderMessageScope(db, message.orderId);
  return {
    recipient: message.buyer,
    orderId: message.orderId,
    orderNumber: formatOrderNumber(message.orderNumber, message.orderId),
    extraTemplateData: {
      gift_card_value: cardValue(message.amountMinor, message.currencyCode, scope.language),
      gift_card_recipient: message.recipientMasked,
    },
  };
}
