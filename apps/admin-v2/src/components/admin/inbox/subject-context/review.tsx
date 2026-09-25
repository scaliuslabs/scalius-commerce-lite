// The Review card in a review thread's context rail: the stars, the buyer's
// words, whether it's live, the store's reply and a way to the review itself.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Skeleton } from "~/components/ui/skeleton";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";
import type { StaffThread } from "~/lib/api-query-options/inbox";
import { reviewQueryOptions } from "~/lib/api-query-options/reviews";
import { ReviewStars, ReviewStatusBadge } from "../../reviews/review-parts";
import { tabForStatus } from "../../reviews/review-search";

export function ReviewContext({ thread }: { thread: StaffThread }) {
  const t = useMessages(reviewsMessages);
  const canView = useHasPermission(PERMISSIONS.REVIEWS_VIEW);
  const reviewId = thread.subjectId;
  const review = useQuery({ ...reviewQueryOptions(reviewId ?? ""), enabled: canView && Boolean(reviewId) });
  if (!canView || !reviewId || review.isError) return null;

  return (
    <section className="flex flex-col gap-2 p-4">
      <h3 className="text-heading-sm">{t("review")}</h3>
      {review.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ReviewStars rating={review.data.rating} />
            <ReviewStatusBadge status={review.data.status} />
          </div>
          <p className="break-words text-body text-muted-foreground">{review.data.product.name}</p>
          {review.data.title ? <p className="break-words font-medium">{review.data.title}</p> : null}
          {review.data.body ? (
            <p className="line-clamp-6 whitespace-pre-line break-words">{review.data.body}</p>
          ) : !review.data.title ? (
            <p className="text-body text-muted-foreground">{t("noText")}</p>
          ) : null}
          {review.data.reply ? (
            <div className="flex flex-col gap-1 border-s-2 ps-3">
              <span className="text-body font-medium">{t("reply")}</span>
              <p className="line-clamp-4 whitespace-pre-line break-words text-body text-muted-foreground">{review.data.reply.body}</p>
            </div>
          ) : null}
          <Link
            to="/admin/reviews"
            search={{ status: tabForStatus(review.data.status), review: review.data.id }}
            className="text-body text-link hover:underline"
          >
            {t("viewInReviews")}
          </Link>
        </>
      ) : (
        <div aria-busy className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </section>
  );
}
