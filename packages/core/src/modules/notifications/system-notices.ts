// Staff notices about the store itself rather than an order: pushed to every
// admin device, best effort, with no outbox row (the fact they announce is
// durable elsewhere, e.g. a webhook's `disabled_reason`).

import type { Database } from "@scalius/database/client";
import { MESSAGE_COPY } from "./message-copy";
import { readStoreIdentity } from "./store-messages";
import { resolveDashboardLink, sendAdminPushNotice } from "./notifications.service";

/** A webhook endpoint was turned off after sustained delivery failure. */
export async function sendWebhookDisabledNotice(
  db: Database,
  env: Env,
  input: { subscriptionId: string; url: string },
): Promise<void> {
  const store = await readStoreIdentity(db);
  const copy = MESSAGE_COPY[store.language].webhookDisabled;
  let host = input.subscriptionId;
  try {
    host = new URL(input.url).host;
  } catch {
    // Stored URLs are validated; fall back to the id rather than the raw value.
  }
  await sendAdminPushNotice(db, env, {
    title: copy.title,
    body: copy.body(host),
    link: resolveDashboardLink(env, "/admin/settings/webhooks"),
    data: { webhookId: input.subscriptionId, notificationType: "webhook_disabled" },
  });
}
