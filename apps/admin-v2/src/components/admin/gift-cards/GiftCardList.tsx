import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { NameText } from "~/components/admin/data-table/cells";
import { serverTableFeatures, useTable, type ColumnDef } from "~/components/admin/data-table/table-config";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { DateText } from "~/components/admin/resource/columns";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { resourceMessages } from "~/i18n/resource";
import {
  giftCardsQueryOptions,
  giftCardSummaryQueryOptions,
  type GiftCardSummary,
} from "~/lib/api-query-options/gift-cards";
import { useListSearch } from "~/lib/list-search";
import { IssueGiftCardDialog } from "./IssueGiftCardDialog";
import { GiftCardStatusBadge } from "./gift-card-fields";
import { formatGiftCardLastDay, formatGiftCardMoney, maskedGiftCard } from "./gift-card-format";
import { GIFT_CARD_TABS, giftCardListQuery, giftCardSearchTerm, type GiftCardTab } from "./gift-card-list-state";

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
  const r = useMessages(resourceMessages);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.GIFT_CARDS_MANAGE);
  const [issueOpen, setIssueOpen] = useState(false);
  // The search lives in this tab's session, reduced to last 4 if a whole code is pasted.
  const [term, setTerm] = useListSearch("giftCards");
  // Keyset pages: the cursors that opened each page so far ("" is the first).
  const [cursors, setCursors] = useState<string[]>([""]);
  useEffect(() => setCursors([""]), [tab, term]);

  const query = useQuery({
    ...giftCardsQueryOptions(giftCardListQuery(tab, term, cursors.at(-1) ?? "")),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const filtered = tab !== "all" || Boolean(term);

  const columns = useMemo<ColumnDef<GiftCardSummary, unknown>[]>(() => [
    {
      id: "card",
      header: t("columnCard"),
      enableSorting: false,
      meta: { primary: true, mobile: "primary", minWidth: 140 },
      cell: ({ row }) => (
        <Link
          to="/admin/gift-cards/$giftCardId"
          params={{ giftCardId: row.original.id }}
          className="whitespace-nowrap font-mono font-medium hover:underline"
        >
          {maskedGiftCard(row.original.last4)}
        </Link>
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
        if (recipientName) return <span className="truncate">{t("recipientShort", { name: recipientName })}</span>;
        return <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "balance",
      header: t("columnBalance"),
      enableSorting: false,
      meta: { numeric: true, mobile: "secondary", priority: 90, minWidth: 150 },
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
    {
      id: "created",
      header: t("columnCreated"),
      enableSorting: false,
      meta: { priority: 40, minWidth: 120 },
      cell: ({ row }) => <DateText value={row.original.createdAt} />,
    },
  ], [t]);

  const table = useTable({
    features: serverTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: items.length,
    state: { pagination: { pageIndex: 0, pageSize: Math.max(1, items.length) }, sorting: [] },
  });

  const clearFilters = () => {
    setTerm("");
    onTabChange("all");
  };

  const issueButton = canManage ? <Button type="button" onClick={() => setIssueOpen(true)}>{t("issueGiftCard")}</Button> : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title={t("pageTitle")} actions={issueButton} />
      <OutstandingBalanceCard />
      <Card className="overflow-clip">
        <IndexTabs
          tabs={GIFT_CARD_TABS.map((value) => ({ value, label: t(TAB_LABEL[value]) }))}
          value={tab}
          onChange={onTabChange}
        />
        <div className="px-2 pt-2">
          <DataTableToolbar
            searchValue={term}
            onSearchChange={(value) => setTerm(giftCardSearchTerm(value))}
            searchPlaceholder={t("searchPlaceholder")}
          />
        </div>
        <DataTable
          variant="bare"
          table={table}
          isLoading={query.isPending}
          isFetching={query.isFetching}
          error={query.isError ? query.error : undefined}
          onRetry={() => void query.refetch()}
          paginate={false}
          defaultSortLabel={false}
          layoutKey="gift-cards"
          getRowHref={(card) => `/admin/gift-cards/${card.id}`}
          emptyState={{
            icon: Gift,
            title: filtered ? t("emptyFilteredTitle") : t("emptyTitle"),
            description: filtered ? t("emptyFilteredBody") : t("emptyBody"),
            action: filtered ? (
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>{t("clearFilters")}</Button>
            ) : issueButton ?? undefined,
          }}
        />
        {cursors.length > 1 || nextCursor ? (
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-body text-muted-foreground">{t("pageNumber", { page: formatNumber(cursors.length) })}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cursors.length <= 1 || query.isFetching}
                onClick={() => setCursors((history) => history.slice(0, -1))}
              >
                {r("previous")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!nextCursor || query.isFetching}
                onClick={() => nextCursor && setCursors((history) => (history.at(-1) === nextCursor ? history : [...history, nextCursor]))}
              >
                {r("next")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      <IssueGiftCardDialog open={issueOpen} onOpenChange={setIssueOpen} />
    </div>
  );
}
