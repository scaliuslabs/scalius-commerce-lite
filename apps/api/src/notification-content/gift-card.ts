// Send-time content for `gift_card_issued` (Wave B §4.2, §10): the recipient
// contact on the card (else the order contact, else the owner's contacts),
// and the code (decrypted now with the CREDENTIAL_ENCRYPTION_KEY-derived key),
// value, expiry and message. The gift-cards domain resolves the facts; the
// notifications domain never imports `gift-cards`. The code is a template
// variable only: code-bearing sends store no body or raw response in their
// delivery receipts (resolved-notifications.ts redacts it). See
// `./digital.ts` for the resolver contract (`null` = nothing to send, terminal).
import type { Database } from "@scalius/database/client";
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

function formatExpiry(epochSeconds: number | null): string {
  if (epochSeconds === null) return "";
  return new Date(epochSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dhaka",
  });
}

function storeLink(env: Env): string {
  const base = typeof env.STOREFRONT_URL === "string" ? env.STOREFRONT_URL.trim() : "";
  if (!/^https?:\/\//i.test(base)) return "";
  // The balance page, never a URL carrying the code.
  return `${base.replace(/\/+$/, "")}/gift-card-balance`;
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
  return {
    recipient: message.recipient,
    orderId: message.orderId,
    orderNumber: message.orderId ? formatOrderNumber(message.orderNumber, message.orderId) : null,
    extraTemplateData: {
      gift_card_code: message.code,
      gift_card_value: formatMoney(fromMinor(message.amountMinor, getDecimalPlaces(message.currencyCode)), { code: message.currencyCode }),
      gift_card_expires: formatExpiry(message.expiresAt),
      gift_card_message: message.message ?? "",
      gift_card_sender: message.senderName ?? "",
      gift_card_link: storeLink(env),
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
  return {
    recipient: message.buyer,
    orderId: message.orderId,
    orderNumber: formatOrderNumber(message.orderNumber, message.orderId),
    extraTemplateData: {
      gift_card_value: formatMoney(fromMinor(message.amountMinor, getDecimalPlaces(message.currencyCode)), { code: message.currencyCode }),
      gift_card_recipient: message.recipientMasked,
    },
  };
}
