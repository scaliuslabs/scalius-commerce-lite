import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ReviewsPage } from "~/components/admin/reviews/ReviewsPage";
import {
  reviewListQuery,
  validateReviewSearch,
  type ReviewSearch,
  type ReviewSearchChange,
} from "~/components/admin/reviews/review-search";
import { pageHead } from "~/i18n/page-titles";
import { reviewListQueryOptions, reviewSummaryQueryOptions } from "~/lib/api-query-options/reviews";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

/** Products › Reviews: the moderation queue, filters and the review sheet. */
export const Route = createFileRoute("/admin/reviews/")({
  validateSearch: validateReviewSearch,
  loaderDeps: ({ search }) => ({ list: reviewListQuery(search), productId: search.productId }),
  loader: async ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchInfiniteQuery(reviewListQueryOptions(deps.list));
    await warmRouteQuery(queryClient, reviewSummaryQueryOptions(deps.productId));
  },
  head: () => pageHead("reviews"),
  component: ReviewsRoutePage,
  errorComponent: RouteErrorComponent,
});

function ReviewsRoutePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const onSearchChange = useCallback<ReviewSearchChange>(
    (next, options) => {
      void navigate({
        search: (current: ReviewSearch) => {
          const merged: ReviewSearch = { ...current, ...next };
          for (const key of Object.keys(merged) as Array<keyof ReviewSearch>) {
            if (merged[key] === undefined) delete merged[key];
          }
          return merged;
        },
        replace: options?.replace,
      });
    },
    [navigate],
  );
  return <ReviewsPage search={search} onSearchChange={onSearchChange} />;
}
