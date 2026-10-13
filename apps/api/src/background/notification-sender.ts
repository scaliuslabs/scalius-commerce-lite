// The sender a request hands committed notification outbox rows to. It is
// small on purpose: routes import it statically, and the delivery code
// (background/notifications.ts) loads only when a row is sent.
import type { NotificationSender } from "@scalius/core/modules/notifications";
import { afterResponse, type BackgroundCaller } from "./after-response";

/** Sends the rows after the response (before returning, without an execution context). */
export function notificationSender(caller: BackgroundCaller & { env: Env }): NotificationSender {
  return (outboxIds) => afterResponse(caller, "notification send", async () => {
    const [{ sendNotifications }, { getDb }] = await Promise.all([
      import("./notifications"),
      import("@scalius/database/client"),
    ]);
    await sendNotifications(getDb(caller.env), caller.env, outboxIds);
  });
}
