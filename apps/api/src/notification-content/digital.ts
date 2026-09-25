// Send-time content for `order_digital_delivered` (Wave B §10): file names,
// licence keys (decrypted now, never stored in the outbox) and the link to
// `/account/downloads` or `/track-order`. Never a download link: the buyer
// downloads from the account or the receipt, where the cookie proves them.
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
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { resolveDigitalDeliveryContent as readDeliveredContent } from "@scalius/core/modules/digital";
import type { NotificationData, NotificationExtraTemplateData } from "@scalius/core/modules/notifications";
import { getCredentialEncryptionKey } from "../utils/encryption-key";

export interface DigitalDeliveryContentInput {
  orderId: string;
  /** The outbox row's id-only facts (the fulfilment id; a resend carries none). */
  data: NotificationData;
}

/** Keys fit an SMS when there are at most 3 and they stay within about two segments. */
const SMS_KEYS_MAX = 3;
const SMS_KEYS_MAX_CHARACTERS = 160;

/** The absolute page where this buyer finds their downloads. */
function accessLink(storefrontUrl: string | undefined, hasAccount: boolean): string {
  const path = hasAccount ? "/account/downloads" : "/track-order";
  try {
    return new URL(path, storefrontUrl).toString();
  } catch {
    return path;
  }
}

export async function resolveDigitalDeliveryContent(
  db: Database,
  env: Env,
  input: DigitalDeliveryContentInput,
): Promise<NotificationExtraTemplateData | null> {
  const fulfillmentId = typeof input.data.fulfillmentId === "string" ? input.data.fulfillmentId : null;
  const content = await readDeliveredContent(
    db,
    getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    { orderId: input.orderId, fulfillmentId },
  );
  if (!content || (content.fileNames.length === 0 && content.licenceKeys.length === 0)) return null;
  const order = await db.select({ owner: orders.accountOwnerCustomerId }).from(orders).where(eq(orders.id, input.orderId)).get();
  const smsKeys = content.licenceKeys.join(", ");
  return {
    download_names: content.fileNames.join(", "),
    licence_keys: content.licenceKeys.join("\n"),
    sms_licence_keys: content.licenceKeys.length > 0
      && content.licenceKeys.length <= SMS_KEYS_MAX
      && smsKeys.length <= SMS_KEYS_MAX_CHARACTERS
      ? smsKeys
      : "",
    access_link: accessLink(env.STOREFRONT_URL, Boolean(order?.owner)),
  };
}
