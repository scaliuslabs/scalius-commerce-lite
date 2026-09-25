import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { ReviewRejectionReason } from "@scalius/shared/reviews";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { NativeSelect } from "~/components/ui/native-select";
import { Progress } from "~/components/ui/progress";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { useHasPermission } from "~/contexts/PermissionContext";
import { formatNumber, useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";
import { getServerFnError } from "~/lib/api-helpers";
import {
  reviewListQueryOptions,
  reviewSummaryQueryOptions,
  type AdminReview,
  type ProductReviewStats,
} from "~/lib/api-query-options/reviews";
import { formatOrderDate } from "../orderview/formatters";
import { RejectReviewsDialog } from "./RejectReviewsDialog";
import { ReviewSettingsDialog } from "./ReviewSettingsDialog";
import { ReviewSheet } from "./ReviewSheet";
import { CheckFlagChips, ProductThumb, ReviewStars } from "./review-parts";
import { REVIEW_TABS, reviewListQuery, reviewTab, type ReviewSearch, type ReviewSearchChange } from "./review-search";
import {
  reviewProductLoader,
  undoableRejection,
  useModerateReviews,
  type ModerateResult,
  type ModerationAction,
} from "./reviews-api";

/**
 * Products › Reviews (Judge.me's layout, Shopify's index list): Pending,
 * Published and Rejected tabs with counts, star/product/text filters, one row
 * per review with bulk Publish / Reject / Restore, and a side sheet per review.
 */
export function ReviewsPage({ search, onSearchChange }: { search: ReviewSearch; onSearchChange: ReviewSearchChange }) {
  const t = useMessages(reviewsMessages);
  const canModerate = useHasPermission(PERMISSIONS.REVIEWS_MODERATE);
  const canPickProduct = useHasPermission(PERMISSIONS.PRODUCTS_VIEW);
  const tab = reviewTab(search);
  const query = reviewListQuery(search);
  const summary = useQuery(reviewSummaryQueryOptions(search.productId));
  const list = useInfiniteQuery(reviewListQueryOptions(query));
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(search.q || search.rating || search.productId);

  // A selection belongs to the list it was made on.
  const scope = JSON.stringify(query);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [scope]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const moderate = useModerateReviews();

  const announce = (action: ModerationAction, result: ModerateResult) => {
    const skipped = result.skipped.length ? t("skipped", { count: result.skipped.length }) : undefined;
    if (result.updated.length === 0) {
      toast(skipped ?? t("actionFailed"));
      return;
    }
    const message = t(action === "publish" ? "published" : action === "reject" ? "rejected" : "restored");
    // Undo only where it is a true inverse: restoring reviews that were live before the rejection.
    const undo = action === "reject" ? undoableRejection(result) : [];
    toast.success(message, {
      description: skipped,
      ...(undo.length > 0
        ? {
            duration: 10_000,
            action: { label: t("undo"), onClick: () => run(undo, "restore") },
          }
        : {}),
    });
  };

  function run(ids: readonly string[], action: ModerationAction, reason?: ReviewRejectionReason) {
    moderate.mutate(
      { ids, action, reason },
      {
        onSuccess: (result) => {
          setRejecting(null);
          setSelected((current) => current.filter((id) => !ids.includes(id)));
          announce(action, result);
        },
        onError: (error) => toast.error(getServerFnError(error, t("actionFailed"))),
      },
    );
  }

  const busy = (action: ModerationAction) => moderate.isPending && moderate.variables?.action === action;
  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id));
  const counts = summary.data;

  const bulkActions = (
    <>
      <span className="text-body">{t("selected", { count: selected.length })}</span>
      {tab === "pending" ? (
        <Button type="button" size="sm" variant="outline" loading={busy("publish")} onClick={() => run(selected, "publish")}>
          {t("publish")}
        </Button>
      ) : null}
      {tab === "pending" || tab === "published" ? (
        <Button type="button" size="sm" variant="outline" disabled={moderate.isPending} onClick={() => setRejecting(selected)}>
          {t("reject")}
        </Button>
      ) : null}
      {tab === "rejected" ? (
        <Button type="button" size="sm" variant="outline" loading={busy("restore")} onClick={() => run(selected, "restore")}>
          {t("restore")}
        </Button>
      ) : null}
    </>
  );

  const filters = (
    <>
      <NativeSelect
        aria-label={t("ratingFilter")}
        value={search.rating ? String(search.rating) : "all"}
        onValueChange={(value) => onSearchChange({ rating: value === "all" ? undefined : (Number(value) as ReviewSearch["rating"]) }, { replace: true })}
        className="w-36"
      >
        <option value="all">{t("rating.all")}</option>
        {[5, 4, 3, 2, 1].map((rating) => (
          <option key={rating} value={rating}>{t("ratingOption", { count: rating })}</option>
        ))}
      </NativeSelect>
      {canPickProduct ? (
        <SearchableSelect
          load={reviewProductLoader}
          queryKey={["reviews", "product-filter"]}
          value={search.productId ?? ""}
          selectedLabel={counts?.product?.productName}
          onValueChange={(value) => onSearchChange({ productId: value || undefined }, { replace: true })}
          placeholder={t("product.all")}
          searchPlaceholder={t("productSearch")}
          emptyMessage={t("productEmpty")}
          ariaLabel={t("productFilter")}
          clearable
          triggerClassName="w-56"
        />
      ) : null}
    </>
  );

  return (
    <div className="pb-8">
      <PageHeader
        title={t("title")}
        actions={canModerate ? (
          <Button type="button" variant="outline" onClick={() => setSettingsOpen(true)}>{t("settings")}</Button>
        ) : null}
      />
      <div className="flex flex-col gap-4">
        {search.productId && counts?.product ? (
          <ProductRatingCard stats={counts.product} onShowAll={() => onSearchChange({ productId: undefined })} />
        ) : null}
        <Card className="overflow-clip">
          <IndexTabs
            label={t("title")}
            tabs={REVIEW_TABS.map((value) => ({
              value,
              label: counts ? t("tabCount", { label: t(`tab.${value}`), count: counts[value] }) : t(`tab.${value}`),
            }))}
            value={tab}
            onChange={(value) => onSearchChange({ status: value === "pending" ? undefined : value })}
          />
          <div className="px-2 pt-2">
            <DataTableToolbar
              searchValue={search.q ?? ""}
              onSearchChange={(value) => onSearchChange({ q: value.trim() || undefined }, { replace: true })}
              searchPlaceholder={t("search")}
              selectedCount={selected.length}
              bulkActions={canModerate ? bulkActions : undefined}
              filters={filters}
            />
          </div>
          {list.isPending ? (
            <ul aria-busy className="divide-y border-t">
              {Array.from({ length: 5 }, (_, index) => (
                <li key={index} className="flex flex-col gap-2 px-3 py-3">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                </li>
              ))}
            </ul>
          ) : list.isError ? (
            <div className="flex flex-col items-start gap-2 border-t p-4">
              <p className="text-body text-destructive">{t("loadFailed")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>{t("retry")}</Button>
            </div>
          ) : items.length === 0 ? (
            <div className="border-t">
              <EmptyState
                icon={Star}
                title={filtered ? t("empty.filtered") : t(`empty.${tab}`)}
                description={filtered ? t("empty.filteredBody") : t(`empty.${tab}Body`)}
                action={filtered ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onSearchChange({ q: undefined, rating: undefined, productId: undefined })}
                  >
                    {t("clearFilters")}
                  </Button>
                ) : undefined}
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-t bg-muted px-3 py-1.5 text-caption font-medium text-muted-foreground">
                {canModerate ? (
                  <Checkbox
                    aria-label={t("selectAll")}
                    checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false}
                    onCheckedChange={(checked) => setSelected(checked === true ? items.map((item) => item.id) : [])}
                  />
                ) : null}
                <span className="flex-1">{t("review")}</span>
                <span className="hidden w-64 shrink-0 md:block">{t("product")}</span>
              </div>
              <ul className="divide-y border-t">
                {items.map((review) => (
                  <ReviewRow
                    key={review.id}
                    review={review}
                    search={search}
                    active={review.id === search.review}
                    selectable={canModerate}
                    selected={selected.includes(review.id)}
                    onSelect={(checked) =>
                      setSelected((current) => (checked ? [...current, review.id] : current.filter((id) => id !== review.id)))
                    }
                    onOpen={() => onSearchChange({ review: review.id })}
                  />
                ))}
              </ul>
              {list.hasNextPage ? (
                <div className="flex justify-center border-t p-3">
                  <Button type="button" size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {t("loadMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <ReviewSheet
        reviewId={search.review ?? null}
        initial={items.find((item) => item.id === search.review)}
        moderating={moderate.isPending}
        onModerate={(review, action) => (action === "reject" ? setRejecting([review.id]) : run([review.id], action))}
        onClose={() => onSearchChange({ review: undefined }, { replace: true })}
      />
      <RejectReviewsDialog
        open={rejecting !== null}
        count={rejecting?.length ?? 0}
        loading={busy("reject")}
        onOpenChange={(open) => !open && setRejecting(null)}
        onReject={(reason) => rejecting && run(rejecting, "reject", reason)}
      />
      <ReviewSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function ReviewRow({
  review,
  search,
  active,
  selectable,
  selected,
  onSelect,
  onOpen,
}: {
  review: AdminReview;
  search: ReviewSearch;
  active: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const t = useMessages(reviewsMessages);
  return (
    <li
      data-state={active || selected ? "selected" : undefined}
      className="flex items-start gap-3 px-3 py-3 hover:bg-accent data-[state=selected]:bg-accent"
    >
      {selectable ? (
        <span className="flex h-lh items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelect(checked === true)}
            aria-label={t("selectReview", { name: review.authorName })}
          />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 md:flex-row">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex flex-wrap items-center gap-2">
            <ReviewStars rating={review.rating} />
            {review.title ? <span className="min-w-0 break-words font-medium">{review.title}</span> : null}
          </span>
          {review.body ? <span className="line-clamp-2 break-words text-muted-foreground">{review.body}</span> : null}
          <span className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
            {t("byline", { name: review.authorName, date: formatOrderDate(review.createdAt) ?? "" })}
            <Badge variant="success">{t("verified")}</Badge>
          </span>
          {review.status === "pending" ? <CheckFlagChips flags={review.checkFlags} /> : null}
          {review.status === "rejected" && review.moderationReason ? (
            <span className="text-body text-muted-foreground">{t("rejectedFor", { reason: t(`reason.${review.moderationReason}`) })}</span>
          ) : null}
        </button>
        <div className="flex min-w-0 items-start gap-3 md:w-64 md:shrink-0">
          <ProductThumb imageUrl={review.product.imageUrl} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="line-clamp-2 break-words">{review.product.name}</span>
            {review.variantLabel ? <span className="truncate text-body text-muted-foreground">{review.variantLabel}</span> : null}
            {search.productId !== review.product.id ? (
              <Link
                to="/admin/reviews"
                search={{ status: search.status, productId: review.product.id }}
                className="text-body text-link hover:underline"
              >
                {t("productReviews")}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Product-level rating stats: the average, the count and a five-row histogram. */
function ProductRatingCard({ stats, onShowAll }: { stats: ProductReviewStats; onShowAll: () => void }) {
  const t = useMessages(reviewsMessages);
  const average = formatNumber(stats.average, { maximumFractionDigits: 2 });
  return (
    <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-8">
      <div className="flex min-w-0 flex-col gap-1 sm:w-64">
        <h2 className="break-words text-heading-sm">{stats.productName}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-heading-lg tabular-nums">{average}</span>
          <ReviewStars rating={Math.round(stats.average)} />
        </div>
        <p className="text-body text-muted-foreground">{t("basedOn", { count: stats.count })}</p>
        <button type="button" onClick={onShowAll} className="self-start text-body text-link hover:underline">
          {t("showAllProducts")}
        </button>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {stats.histogram.map((row) => (
          <li
            key={row.rating}
            aria-label={t("histogramRow", { rating: row.rating, count: row.count })}
            className="grid grid-cols-[2.5rem_minmax(0,1fr)_3rem] items-center gap-2"
          >
            <span aria-hidden className="tabular-nums">{t("ratingOption", { count: row.rating })}</span>
            <Progress aria-hidden value={stats.count > 0 ? (row.count / stats.count) * 100 : 0} />
            <span aria-hidden className="text-right tabular-nums">{formatNumber(row.count)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
