import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { toast } from "~/lib/toast";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { ReviewRejectionReason } from "@scalius/shared/reviews";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar, IndexBulkBar } from "~/components/admin/data-table/DataTableToolbar";
import { FilterControl } from "~/components/admin/data-table/FilterControl";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { serverTableFeatures, useTable, type ColumnDef, type RowSelectionState } from "~/components/admin/data-table/table-config";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { formatNumber, useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";
import { getServerFnError } from "~/lib/api-helpers";
import {
  REVIEW_PAGE_SIZE,
  reviewListQueryOptions,
  reviewSummaryQueryOptions,
  type AdminReview,
  type ProductReviewStats,
} from "~/lib/api-query-options/reviews";
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
  // A selection and the pages walked belong to the list they were made on.
  const scope = JSON.stringify(query);
  const [cursors, setCursors] = useState<string[]>([""]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  useEffect(() => {
    setCursors([""]);
    setSelection({});
  }, [scope]);
  const list = useQuery({ ...reviewListQueryOptions(query, cursors.at(-1) ?? ""), placeholderData: keepPreviousData });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const nextCursor = list.data?.nextCursor ?? null;
  const filtered = Boolean(search.q || search.rating || search.productId);
  const selected = Object.keys(selection).filter((id) => selection[id]);
  const setSelected = (update: (ids: string[]) => string[]) =>
    setSelection((current) => Object.fromEntries(update(Object.keys(current).filter((id) => current[id])).map((id) => [id, true])));
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
  const counts = summary.data;

  const columns = useMemo<ColumnDef<AdminReview, unknown>[]>(() => [
    ...(canModerate ? [createSelectColumn<AdminReview>({ getLabel: (row) => t("selectReview", { name: (row as AdminReview).authorName }) })] : []),
    {
      id: "review",
      header: t("review"),
      meta: { primary: true, minWidth: 260, maxWidth: 560 },
      cell: ({ row }) => <ReviewCell review={row.original} onOpen={() => onSearchChange({ review: row.original.id })} />,
    },
    {
      id: "product",
      header: t("product"),
      meta: { priority: 70, minWidth: 200, maxWidth: 280 },
      cell: ({ row }) => <ProductCell review={row.original} search={search} />,
    },
    {
      id: "date",
      header: t("date"),
      meta: { priority: 50, minWidth: 140 },
      cell: ({ row }) => <ListDate value={row.original.createdAt} />,
    },
    // `t` follows the language; the search only names the product filter link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [canModerate, t, search.productId, search.status]);

  const table = useTable({
    features: serverTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: -1,
    state: { pagination: { pageIndex: cursors.length - 1, pageSize: REVIEW_PAGE_SIZE }, sorting: [], rowSelection: selection },
    enableRowSelection: canModerate,
    onRowSelectionChange: (updater) => setSelection((current) => (typeof updater === "function" ? updater(current) : updater)),
  });

  const bulkActions = (
    <>
      {tab === "pending" ? (
        <Button type="button" variant="outline" loading={busy("publish")} onClick={() => run(selected, "publish")}>
          {t("publish")}
        </Button>
      ) : null}
      {tab === "pending" || tab === "published" ? (
        <Button type="button" variant="outline" disabled={moderate.isPending} onClick={() => setRejecting(selected)}>
          {t("reject")}
        </Button>
      ) : null}
      {tab === "rejected" ? (
        <Button type="button" variant="outline" loading={busy("restore")} onClick={() => run(selected, "restore")}>
          {t("restore")}
        </Button>
      ) : null}
    </>
  );

  const filterCount = (search.rating ? 1 : 0) + (search.productId ? 1 : 0);
  const filters = (
    <>
      <FilterControl label={t("ratingFilter")}>
        <SearchableSelect
          ariaLabel={t("ratingFilter")}
          value={search.rating ? String(search.rating) : "all"}
          onValueChange={(value) => onSearchChange({ rating: value === "all" ? undefined : (Number(value) as ReviewSearch["rating"]) }, { replace: true })}
          options={[{ value: "all", label: t("rating.all") }, ...[5, 4, 3, 2, 1].map((rating) => ({ value: String(rating), label: t("ratingOption", { count: rating }) }))]}
        />
      </FilterControl>
      {canPickProduct ? (
        <FilterControl label={t("productFilter")}>
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
        />
        </FilterControl>
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
        {/* Nothing reviewed yet: the first-run card alone (E1). */}
        {!filtered && !list.isPending && !list.isError && counts && counts.pending + counts.published + counts.rejected === 0 ? (
          <EmptyState icon={Star} title={t("empty.pending")} description={t("empty.pendingBody")} />
        ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={list.isPending}
          isFetching={list.isFetching}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          what={t("whatReviews")}
          defaultSortLabel={false}
          layoutKey="reviews"
          pageSizeOptions={[REVIEW_PAGE_SIZE]}
          cursorPaging={{
            total: filtered || !counts ? null : counts[tab],
            offset: (cursors.length - 1) * REVIEW_PAGE_SIZE,
            pageInfo: {
              hasNextPage: Boolean(nextCursor),
              hasPreviousPage: cursors.length > 1,
              startCursor: cursors.length > 1 ? cursors.at(-1)! : null,
              endCursor: nextCursor,
            },
            onPrevious: () => setCursors((history) => history.slice(0, -1)),
            onNext: (cursor) => setCursors((history) => (history.at(-1) === cursor ? history : [...history, cursor])),
          }}
          toolbar={(
            <>
              <IndexTabs
                label={t("title")}
                tabs={REVIEW_TABS.map((value) => ({
                  value,
                  label: counts ? t("tabCount", { label: t(`tab.${value}`), count: counts[value] }) : t(`tab.${value}`),
                }))}
                value={tab}
                onChange={(value) => onSearchChange({ status: value === "pending" ? undefined : value })}
              />
              <DataTableToolbar
                searchValue={search.q ?? ""}
                onSearchChange={(value) => onSearchChange({ q: value.trim() || undefined }, { replace: true })}
                searchPlaceholder={t("search")}
                bulkBar={canModerate && selected.length > 0 ? (
                  <IndexBulkBar status={t("selected", { count: selected.length })} actions={bulkActions} onClear={() => setSelection({})} />
                ) : undefined}
                filters={filters}
                filterCount={filterCount}
                onClearFilters={() => onSearchChange({ rating: undefined, productId: undefined })}
              />
            </>
          )}
          emptyState={filtered ? (
            <FilteredEmptyState
              title={t("empty.filtered")}
              description={t("empty.filteredBody")}
              onClearFilters={() => onSearchChange({ q: undefined, rating: undefined, productId: undefined })}
            />
          ) : (
            <FilteredEmptyState title={t(`empty.${tab}`)} description={t(`empty.${tab}Body`)} />
          )}
        />
        )}
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

/** The review: stars and title on the first line, the text on the second; it opens the review sheet. */
function ReviewCell({ review, onOpen }: { review: AdminReview; onOpen: () => void }) {
  const t = useMessages(reviewsMessages);
  const flags = review.status === "pending" && review.checkFlags.length > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-11 w-full min-w-0 flex-col sm:min-h-6 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ReviewStars rating={review.rating} />
        <span title={review.title ?? undefined} className="min-w-0 truncate font-medium">{review.title ?? review.authorName}</span>
        <Badge variant="success" className="shrink-0">{t("verified")}</Badge>
        {flags ? <CheckFlagChips flags={review.checkFlags} /> : null}
      </span>
      <span title={review.body ?? undefined} className="block truncate text-muted-foreground">
        {review.status === "rejected" && review.moderationReason
          ? t("rejectedFor", { reason: t(`reason.${review.moderationReason}`) })
          : review.body || review.authorName}
      </span>
    </button>
  );
}

/** The product reviewed (with its variant), and a link to that product's reviews. */
function ProductCell({ review, search }: { review: AdminReview; search: ReviewSearch }) {
  const t = useMessages(reviewsMessages);
  const name = review.variantLabel ? `${review.product.name} · ${review.variantLabel}` : review.product.name;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <ProductThumb imageUrl={review.product.imageUrl} />
      <span className="flex min-w-0 flex-col">
        <span title={name} className="truncate">{name}</span>
        {search.productId !== review.product.id ? (
          <Link
            to="/admin/reviews"
            search={{ status: search.status, productId: review.product.id }}
            className="truncate text-body text-link hover:underline"
          >
            {t("productReviews")}
          </Link>
        ) : null}
      </span>
    </span>
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
            <span aria-hidden className="text-end tabular-nums">{formatNumber(row.count)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
