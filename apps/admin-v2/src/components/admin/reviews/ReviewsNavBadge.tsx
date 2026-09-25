import { useQuery } from "@tanstack/react-query";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { reviewSummaryQueryOptions } from "~/lib/api-query-options/reviews";

/** The sidebar's pending-review count beside Products › Reviews (hidden at zero, like the inbox badge). */
export function ReviewsNavBadge() {
  const t = useMessages(shellMessages);
  const { data } = useQuery(reviewSummaryQueryOptions());
  const pending = data?.pending ?? 0;
  if (pending <= 0) return null;
  return (
    <span
      aria-label={t("reviewsPending", { count: pending })}
      className="ms-auto rounded-lg bg-secondary px-2 py-0.5 text-caption font-medium tabular-nums text-secondary-foreground"
    >
      {pending > 99 ? "99+" : pending}
    </span>
  );
}
