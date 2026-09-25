import { useQuery } from "@tanstack/react-query";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { inboxSummaryQueryOptions } from "./inbox-api";

/** The sidebar's open-conversation count beside "Inbox" (hidden at zero). */
export function InboxNavBadge() {
  const t = useMessages(inboxMessages);
  const { data } = useQuery(inboxSummaryQueryOptions());
  const open = data?.open ?? 0;
  if (open <= 0) return null;
  return (
    <span
      aria-label={t("unread", { count: open })}
      className="ms-auto rounded-lg bg-secondary px-2 py-0.5 text-caption font-medium tabular-nums text-secondary-foreground"
    >
      {open > 99 ? "99+" : open}
    </span>
  );
}
