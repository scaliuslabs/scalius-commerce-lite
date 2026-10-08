import type { ReadinessIssue } from "@scalius/shared/readiness";
import { useMessages } from "~/i18n";
import { appKindsMessages } from "~/i18n/settings-app-kinds";

/**
 * A buyer-push readiness issue in the dashboard's language. The API's own
 * sentence is English, so the issues the dashboard knows by code read from
 * the catalog; any other issue (an app's own words) shows as sent.
 */
export function usePushIssueText() {
  const t = useMessages(appKindsMessages);
  return (issue: Pick<ReadinessIssue, "code" | "message"> | undefined): string | null => {
    if (!issue) return null;
    return issue.code === "web_push_unavailable" ? t("browserUnavailable") : issue.message;
  };
}
