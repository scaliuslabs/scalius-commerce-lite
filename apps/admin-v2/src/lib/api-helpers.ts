import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { AdminApiResponseError } from "./admin-api-error";
import { readApiFieldIssues } from "./api-field-errors";

/**
 * What went wrong with an API call, in words a merchant can act on. The API's
 * own message is kept for rejections it explains (409 "already used", 400
 * with a sentence); server faults, validation issue lists and transport
 * failures never reach the screen as raw text.
 */
export function getServerFnError(error: unknown, fallback = translate(saveBarMessages, "serverError")): string {
  if (error instanceof AdminApiResponseError) {
    if (error.status >= 500 || !error.message || error.message.startsWith("API error")) {
      return translate(saveBarMessages, "serverError");
    }
    const issues = readApiFieldIssues(error);
    if (issues && error.message.trim().startsWith("[")) return issues[0]!.message;
    return error.message.trim().startsWith("[") ? fallback : error.message;
  }
  if (error instanceof Error) {
    if (["TypeError", "AbortError", "TimeoutError"].includes(error.name)) {
      return translate(saveBarMessages, "offline");
    }
    return error.message || fallback;
  }
  if (typeof error === "string") return error;
  return fallback;
}
