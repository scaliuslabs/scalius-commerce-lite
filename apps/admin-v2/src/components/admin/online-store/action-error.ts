import { AdminApiResponseError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { saveBarMessages } from "~/i18n/save-bar";

/**
 * What a failed immediate action (add, move, delete) tells the merchant: the
 * API's own sentence for a 4xx, never raw server or network text.
 */
export function actionErrorText(error: unknown): string {
  if (error instanceof AdminApiResponseError && error.status === 401) return translate(saveBarMessages, "sessionLost");
  if (error instanceof AdminApiResponseError && error.status < 500 && error.message && !error.message.startsWith("API error")) {
    return error.message;
  }
  return translate(onlineStoreMessages, "actionFailed");
}
