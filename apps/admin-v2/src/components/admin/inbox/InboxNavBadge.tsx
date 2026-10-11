import { useQuery } from "@tanstack/react-query";
import { formatNumber, useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { inboxSummaryQueryOptions } from "~/lib/api-query-options/inbox";

/** The sidebar's unread incoming-message count beside "Inbox" (hidden at zero). */
export function InboxNavBadge() {
  const t = useMessages(shellMessages);
  const { data } = useQuery(inboxSummaryQueryOptions());
  const unread = data?.unread ?? 0;
  if (unread <= 0) return null;
  return (
    <span
      aria-label={t("inboxUnread", { count: unread })}
      className="ms-auto rounded-lg bg-secondary px-2 py-0.5 text-caption font-medium tabular-nums text-secondary-foreground"
    >
      {formatNumber(Math.min(unread, 99))}{unread > 99 ? "+" : ""}
    </span>
  );
}
