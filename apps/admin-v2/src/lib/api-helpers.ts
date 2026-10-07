import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { AdminApiResponseError, classifyAdminError } from "./admin-api-error";
import { readApiFieldIssues } from "./api-field-errors";

/**
 * What went wrong with an API call, in words a merchant can act on. The API's
 * own message is kept for rejections it explains (409 "already used", 400
 * with a sentence); server faults, validation issue lists and transport
 * failures never reach the screen as raw text.
 */
export function getServerFnError(error: unknown, fallback = translate(saveBarMessages, "serverError")): string {
  const kind = classifyAdminError(error);
  if (kind === "server") return translate(saveBarMessages, "serverError");
  if (error instanceof AdminApiResponseError) {
    // A refusal without words of its own is never told as "our side".
    if (!error.message || error.message.startsWith("API error")) return fallback;
    const issues = readApiFieldIssues(error);
    if (issues && error.message.trim().startsWith("[")) return issues[0]!.message;
    return error.message.trim().startsWith("[") ? fallback : error.message;
  }
  if (kind === "network") return translate(saveBarMessages, "offline");
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  return fallback;
}
