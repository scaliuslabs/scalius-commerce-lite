import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { RowLink } from "~/components/admin/data-table/RowLink";
import { createDateColumn } from "~/components/admin/data-table/columns/column-factories";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states";
import { NameText } from "~/components/admin/data-table/cells";
import { serverTableFeatures, useTable, type ColumnDef } from "~/components/admin/data-table/table-config";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import {
  giftCardsQueryOptions,
  giftCardSummaryQueryOptions,
  type GiftCardSummary,
} from "~/lib/api-query-options/gift-cards";
import { useListSearch } from "~/lib/list-search";
import { IssueGiftCardDialog } from "./IssueGiftCardDialog";
import { GiftCardStatusBadge } from "./gift-card-fields";
import { formatGiftCardLastDay, formatGiftCardMoney, maskedGiftCard } from "./gift-card-format";
import { GIFT_CARD_LIST, GIFT_CARD_TABS, giftCardListQuery, giftCardPageSize, giftCardSearchTerm, type GiftCardTab } from "./gift-card-list-state";

// Opened rarely: its copy and query load with the first opening.
const GiftCardSettingsDialog = lazy(() => import("./GiftCardSettingsDialog").then((module) => ({ default: module.GiftCardSettingsDialog })));

const TAB_LABEL = {
  all: "tabAll",
  active: "tabActive",
  disabled: "tabDisabled",
  expired: "tabExpired",
  empty: "tabEmpty",
} as const;

/** "Outstanding balance ৳X": what customers can still spend, per currency. */
function OutstandingBalanceCard() {
  const t = useMessages(giftCardsMessages);
  const { code: storeCurrency } = useCurrency();
  const summary = useQuery(giftCardSummaryQueryOptions());
  const rows = summary.data?.outstanding ?? [];
  const shown = rows.length > 0 ? rows : [{ currencyCode: storeCurrency, balanceMinor: 0, cards: 0 }];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t("outstandingTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {summary.isPending ? (
          <Skeleton className="h-7 w-32" />
        ) : summary.isError ? (
          <p className="text-body text-destructive">{t("outstandingLoadFailed")}</p>
        ) : (
          shown.map((row) => (
            <p key={row.currencyCode} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-heading-lg tabular-nums">{formatGiftCardMoney(row.balanceMinor, row.currencyCode)}</span>
              <span className="text-body text-muted-foreground">
                {row.cards === 1 ? t("outstandingCardsOne") : t("outstandingCards", { count: row.cards })}
              </span>
            </p>
          ))
        )}
        <p className="text-body text-muted-foreground">{t("outstandingHelp")}</p>
      </CardContent>
    </Card>
  );
}

/** Shopify's Gift cards index: outstanding balance, then every card newest first. */
export function GiftCardList({ tab, onTabChange }: {
  tab: GiftCardTab;
  onTabChange: (tab: GiftCardTab) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.GIFT_CARDS_MANAGE);
  const [issueOpen, setIssueOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // The search lives in this tab's session, reduced to last 4 if a whole code is pasted.
  const [term, setTerm] = useListSearch("giftCards");
  // Keyset pages: the cursors that opened each page so far ("" is the first).
  const [cursors, setCursors] = useState<string[]>([""]);
  const [pageSize, setPageSize] = useState(giftCardPageSize);
  useEffect(() => setCursors([""]), [tab, term, pageSize]);

  const query = useQuery({
    ...giftCardsQueryOptions(giftCardListQuery(tab, term, cursors.at(-1) ?? "", pageSize)),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const total = query.data?.total ?? 0;
  const filtered = tab !== "all" || Boolean(term);

  const columns = useMemo<ColumnDef<GiftCardSummary, unknown>[]>(() => [
    {
      id: "card",
      header: t("columnCard"),
      enableSorting: false,
      meta: { primary: true, mobile: "primary", minWidth: 140, maxWidth: 200 },
      cell: ({ row }) => (
        <RowLink
          to={`/admin/gift-cards/${row.original.id}`}
          className="whitespace-nowrap font-mono font-medium hover:underline"
        >
          {maskedGiftCard(row.original.last4)}
        </RowLink>
      ),
    },
    {
      id: "customer",
      header: t("columnCustomer"),
      enableSorting: false,
      meta: { mobile: "secondary", priority: 70, minWidth: 160 },
      cell: ({ row }) => {
        const { customer, recipientName } = row.original;
        if (customer) return <NameText name={customer.name} detail={recipientName ? t("recipientShort", { name: recipientName }) : undefined} />;
        if (recipientName) return <span className="block truncate" title={t("recipientShort", { name: recipientName })}>{t("recipientShort", { name: recipientName })}</span>;
        return <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "balance",
      header: t("columnBalance"),
      enableSorting: false,
      meta: { money: true, mobile: "secondary", minWidth: 150 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatGiftCardMoney(row.original.balanceMinor, row.original.currencyCode)}
          <span className="text-muted-foreground"> / {formatGiftCardMoney(row.original.initialAmountMinor, row.original.currencyCode)}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: t("columnStatus"),
      enableSorting: false,
      meta: { mobile: "status", priority: 80, minWidth: 100 },
      cell: ({ row }) => <GiftCardStatusBadge card={row.original} />,
    },
    {
      id: "expires",
      header: t("columnExpires"),
      enableSorting: false,
      meta: { priority: 50, minWidth: 120 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatGiftCardLastDay(row.original.expiresAt) ?? t("never")}
        </span>
      ),
    },
    createDateColumn("createdAt", t("columnCreated"), { id: "created", sortable: false }),
  ], [t]);

  const table = useTable({
    features: serverTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    state: { pagination: { pageIndex: cursors.length - 1, pageSize }, sorting: [] },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater({ pageIndex: cursors.length - 1, pageSize }) : updater;
      if (next.pageSize !== pageSize) setPageSize(next.pageSize);
    },
  });

  const clearFilters = () => {
    setTerm("");
    onTabChange("all");
  };

  const issueButton = canManage ? <Button type="button" onClick={() => setIssueOpen(true)}>{t("issueGiftCard")}</Button> : null;
  const settingsButton = canManage ? (
    <Button type="button" variant="outline" onClick={() => { setSettingsLoaded(true); setSettingsOpen(true); }}>{t("settingsButton")}</Button>
  ) : null;
  // No card issued yet: the first-run card alone, no tabs, search or balance (E1).
  const nothingYet = !filtered && !query.isPending && !query.isError && total === 0 && items.length === 0;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title={t("pageTitle")} actions={settingsButton ?? undefined} primaryAction={nothingYet ? undefined : issueButton ?? undefined} />
      {nothingYet ? (
        <EmptyState icon={Gift} title={t("emptyTitle")} description={t("emptyBody")} action={issueButton ?? undefined} />
      ) : (
      <>
      <OutstandingBalanceCard />
      <DataTable
        variant="card"
        table={table}
        isLoading={query.isPending}
        isFetching={query.isFetching}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        what={t("whatGiftCards")}
        defaultSortLabel={false}
        layoutKey={GIFT_CARD_LIST}
        getRowHref={(card) => `/admin/gift-cards/${card.id}`}
        cursorPaging={{
          total,
          totalIsCapped: query.data?.totalIsCapped,
          offset: (cursors.length - 1) * pageSize,
          pageInfo: {
            hasNextPage: Boolean(nextCursor),
            hasPreviousPage: cursors.length > 1,
            startCursor: cursors.length > 1 ? cursors.at(-1)! : null,
            endCursor: nextCursor,
          },
          onPrevious: () => setCursors((history) => history.slice(0, -1)),
          onNext: (cursor) => setCursors((history) => (history.at(-1) === cursor ? history : [...history, cursor])),
        }}
        toolbar={
          <>
            <IndexTabs
              tabs={GIFT_CARD_TABS.map((value) => ({ value, label: t(TAB_LABEL[value]) }))}
              value={tab}
              onChange={onTabChange}
            />
            <DataTableToolbar
              searchValue={term}
              onSearchChange={(value) => setTerm(giftCardSearchTerm(value))}
              searchPlaceholder={t("searchPlaceholder")}
            />
          </>
        }
        emptyState={<FilteredEmptyState title={t("emptyFilteredTitle")} description={t("emptyFilteredBody")} onClearFilters={clearFilters} />}
      />
      </>
      )}
      <IssueGiftCardDialog open={issueOpen} onOpenChange={setIssueOpen} />
      {settingsLoaded ? (
        <Suspense fallback={null}>
          <GiftCardSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
