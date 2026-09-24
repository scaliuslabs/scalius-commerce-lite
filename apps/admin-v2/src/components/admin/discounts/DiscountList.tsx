import { Link } from "@tanstack/react-router";
import { TicketPercent } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import { DiscountTypeDialog } from "./DiscountTypeDialog";
import { describeValue, discountStatus, discountTypeOf, draftFromDiscount, type DiscountStatus, type SummaryFormat } from "./discount-form";
import { useScopeLabel } from "./ScopeField";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { IdText, NameText } from "~/components/admin/data-table/cells";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import {
  serverTableFeatures,
  useTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "~/components/admin/data-table/table-config";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { sortHeader } from "~/components/admin/resource/columns";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import { dataTableMessages } from "~/i18n/data-table";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useListSearch } from "~/lib/list-search";
import { discountFailureText, useDeleteDiscount, useSetDiscountActive } from "~/lib/api-mutations/discounts";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

export const DISCOUNT_TABS = ["all", "active", "scheduled", "expired"] as const;
export type DiscountTab = (typeof DISCOUNT_TABS)[number];

const TAB_LABEL = { all: "tabAll", active: "tabActive", scheduled: "tabScheduled", expired: "tabExpired" } as const;

export const DISCOUNT_SORTS = ["updated", "titleAsc", "titleDesc", "used", "usedAsc"] as const;
export type DiscountSort = (typeof DISCOUNT_SORTS)[number];

/** The list's sort in the URL, as the table's column sort (none = newest edits first). */
const SORT_STATE: Record<DiscountSort, SortingState> = {
  updated: [],
  titleAsc: [{ id: "title", desc: false }],
  titleDesc: [{ id: "title", desc: true }],
  used: [{ id: "used", desc: true }],
  usedAsc: [{ id: "used", desc: false }],
};

const titleOf = (discount: DiscountRecord) => discount.codes[0]?.code ?? discount.name;

export function filterDiscounts(
  discounts: DiscountRecord[],
  tab: DiscountTab,
  query: string,
  sort: DiscountSort = "updated",
  now = Math.floor(Date.now() / 1_000),
): DiscountRecord[] {
  const needle = query.trim().toLowerCase();
  const rows = discounts.filter((discount) => {
    const status: DiscountStatus = discountStatus(discount, now);
    if (tab !== "all" && status !== tab) return false;
    return !needle || [discount.name, ...discount.codes.map(({ code }) => code)]
      .some((value) => value.toLowerCase().includes(needle));
  });
  // The API already lists the newest edits first.
  if (sort === "used") return rows.sort((left, right) => right.redemptionCount - left.redemptionCount);
  if (sort === "usedAsc") return rows.sort((left, right) => left.redemptionCount - right.redemptionCount);
  if (sort === "titleAsc") return rows.sort((left, right) => titleOf(left).localeCompare(titleOf(right)));
  if (sort === "titleDesc") return rows.sort((left, right) => titleOf(right).localeCompare(titleOf(left)));
  return rows;
}

function datesLabel(discount: DiscountRecord, t: (key: DiscountMessageKey, vars?: Record<string, string | number>) => string) {
  const date = (epoch: number) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium" });
  if (discount.startsAtEpochSeconds === null) return "—";
  return discount.endsAtEpochSeconds === null
    ? t("datesFrom", { start: date(discount.startsAtEpochSeconds) })
    : t("datesBetween", { start: date(discount.startsAtEpochSeconds), end: date(discount.endsAtEpochSeconds) });
}

type BulkAction = "activate" | "deactivate" | "delete";

/** Shopify's Discounts index: one list of code and automatic discounts. */
export function DiscountList({
  discounts,
  tab,
  sort,
  onTabChange,
  onSortChange,
}: {
  discounts: DiscountRecord[];
  tab: DiscountTab;
  sort: DiscountSort;
  onTabChange: (tab: DiscountTab) => void;
  onSortChange: (sort: DiscountSort) => void;
}) {
  const t = useMessages(discountsMessages);
  const tableCopy = useMessages(dataTableMessages);
  const { hasPermission } = usePermissions();
  const { code: currencyCode, fmt } = useCurrency();
  const scopeLabel = useScopeLabel();
  const [chooserOpen, setChooserOpen] = useState(false);
  // Codes never go into the URL: the search lives in this tab's session.
  const [query, search] = useListSearch("discounts");
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [confirmRows, setConfirmRows] = useState<DiscountRecord[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const activeMutation = useSetDiscountActive();
  const deleteMutation = useDeleteDiscount();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canDelete = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);

  const visible = filterDiscounts(discounts, tab, query, sort);
  const chosen = visible.filter((discount) => selection[discount.id]);
  const toActivate = chosen.filter((discount) => discount.status !== "active" && discount.status !== "archived");
  const toDeactivate = chosen.filter((discount) => discount.status === "active");
  const canSelect = canToggle || canDelete;
  const format: SummaryFormat = {
    money: (major) => fmt(Number(major)),
    number: (value) => formatNumber(Number(value)),
    date: () => "",
    scope: (scope) => scopeLabel(scope, new Map()),
  };
  const valueOf = (discount: DiscountRecord) => {
    const { key, vars } = describeValue(draftFromDiscount(discount, currencyCode), currencyCode, format);
    return t(key, vars);
  };

  const columns = useMemo<ColumnDef<DiscountRecord, unknown>[]>(() => [
    ...(canSelect ? [createSelectColumn<DiscountRecord>({ getLabel: (row) => titleOf(row as DiscountRecord) })] : []),
    {
      id: "title",
      header: sortHeader(t("columnTitle")),
      meta: { primary: true, minWidth: 220 },
      cell: ({ row }) => (
        <NameText
          name={(
            <Link to="/admin/discounts/$discountId" params={{ discountId: row.original.id }} className="hover:underline">
              {row.original.method === "code" ? <IdText value={titleOf(row.original)} /> : titleOf(row.original)}
            </Link>
          )}
          detail={valueOf(row.original)}
        />
      ),
    },
    {
      id: "status",
      header: t("columnStatus"),
      enableSorting: false,
      meta: { mobile: "status", priority: 90, minWidth: 110 },
      cell: ({ row }) => <DiscountStatusBadge discount={row.original} />,
    },
    {
      id: "method",
      header: t("columnMethod"),
      enableSorting: false,
      meta: { priority: 30, minWidth: 100 },
      cell: ({ row }) => <span className="whitespace-nowrap">{t(row.original.method === "code" ? "methodCode" : "methodAutomatic")}</span>,
    },
    {
      id: "type",
      header: t("columnType"),
      enableSorting: false,
      meta: { priority: 40, minWidth: 150 },
      cell: ({ row }) => t(`type_${discountTypeOf(row.original)}`),
    },
    {
      id: "used",
      header: sortHeader(t("columnUsed")),
      meta: { numeric: true, mobile: "secondary", priority: 70, minWidth: 80 },
      cell: ({ row }) => (
        <>
          {formatNumber(row.original.redemptionCount)}
          {row.original.maxRedemptions !== null ? ` / ${formatNumber(row.original.maxRedemptions)}` : null}
        </>
      ),
    },
    {
      id: "dates",
      header: t("columnDates"),
      enableSorting: false,
      meta: { priority: 50, minWidth: 180 },
      cell: ({ row }) => <span className="whitespace-nowrap">{datesLabel(row.original, t)}</span>,
    },
    // `t` and `valueOf` follow the locale and currency, which re-render this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [canSelect, currencyCode, t]);

  const sorting = SORT_STATE[sort];
  const table = useTable({
    features: serverTableFeatures,
    data: visible,
    columns,
    getRowId: (row) => row.id,
    // Every discount is on screen: one page, sorted and filtered here.
    manualPagination: true,
    manualSorting: true,
    rowCount: visible.length,
    state: { pagination: { pageIndex: 0, pageSize: Math.max(1, visible.length) }, sorting, rowSelection: selection },
    enableRowSelection: () => bulkBusy === null,
    onRowSelectionChange: (updater) => setSelection((current) => (typeof updater === "function" ? updater(current) : updater)),
    onSortingChange: (updater) => {
      const next = (typeof updater === "function" ? updater(sorting) : updater)[0];
      const key = (Object.keys(SORT_STATE) as DiscountSort[]).find((candidate) => {
        const state = SORT_STATE[candidate][0];
        return state ? state.id === next?.id && state.desc === next?.desc : !next;
      });
      onSortChange(key ?? "updated");
    },
  });

  /** One request per discount (each with its revision), then one summary that names what failed and why. */
  async function runBulk(action: BulkAction, rows: DiscountRecord[]) {
    setBulkBusy(action);
    const failed: string[] = [];
    for (const discount of rows) {
      try {
        if (action === "delete") {
          await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision });
        } else {
          await activeMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision, active: action === "activate" });
        }
      } catch (error) {
        failed.push(`${titleOf(discount)}: ${discountFailureText(error)}`);
      }
    }
    setBulkBusy(null);
    setConfirmRows(null);
    setSelection({});
    const done = rows.length - failed.length;
    const verb = action === "delete" ? "Deleted" : action === "activate" ? "Activated" : "Deactivated";
    if (failed.length === 0) {
      toast.success(done === 1 ? t(`toast${verb}`) : t(`bulk${verb}`, { count: formatNumber(done) }));
    } else {
      toast.error(t(`bulkPartly${verb}`, { done: formatNumber(done), count: formatNumber(rows.length) }), {
        description: <ul>{failed.map((line) => <li key={line}>{line}</li>)}</ul>,
        duration: 10_000,
      });
    }
  }

  const bulkActions = (
    <>
      <span className="text-body">{t("selectedCount", { count: formatNumber(chosen.length) })}</span>
      {canToggle && toActivate.length > 0 ? (
        <Button type="button" variant="outline" size="sm" disabled={bulkBusy !== null} loading={bulkBusy === "activate"} onClick={() => void runBulk("activate", toActivate)}>
          {t("activate")}
        </Button>
      ) : null}
      {canToggle && toDeactivate.length > 0 ? (
        <Button type="button" variant="outline" size="sm" disabled={bulkBusy !== null} loading={bulkBusy === "deactivate"} onClick={() => void runBulk("deactivate", toDeactivate)}>
          {t("deactivate")}
        </Button>
      ) : null}
      {canDelete ? (
        <Button type="button" variant="destructive" size="sm" disabled={bulkBusy !== null} onClick={() => setConfirmRows(chosen)}>
          {t(chosen.length === 1 ? "delete" : "bulkDelete")}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-heading-lg">{t("pageTitle")}</h1>
        {canCreate && discounts.length > 0 ? (
          <Button type="button" onClick={() => setChooserOpen(true)}>{t("createDiscount")}</Button>
        ) : null}
      </header>

      {discounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <TicketPercent aria-hidden className="size-10 text-muted-foreground" />
            <h2 className="text-heading-md">{t("emptyTitle")}</h2>
            <p className="max-w-sm text-body text-muted-foreground">{t("emptyBody")}</p>
            {canCreate ? (
              <Button type="button" onClick={() => setChooserOpen(true)}>{t("createDiscount")}</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <DataTable
          variant="card"
          table={table}
          isFetching={false}
          isLoading={false}
          paginate={false}
          layoutKey="discounts"
          defaultSortLabel={tableCopy("recentlyUpdated")}
          getRowHref={(discount) => `/admin/discounts/${discount.id}`}
          emptyState={{
            icon: TicketPercent,
            title: query ? t("noMatches") : t(`emptyTab_${tab}`),
            description: query ? t("noMatchesHint") : "",
            action: query ? (
              <Button type="button" variant="outline" size="sm" onClick={() => search("")}>
                {t("clearSearch")}
              </Button>
            ) : undefined,
          }}
          toolbar={(
            <>
              <IndexTabs
                tabs={DISCOUNT_TABS.map((item) => ({ value: item, label: t(TAB_LABEL[item]) }))}
                value={tab}
                onChange={onTabChange}
              />
              <div className="px-2 pt-2">
                <DataTableToolbar
                  searchValue={query}
                  onSearchChange={search}
                  searchPlaceholder={t("searchPlaceholder")}
                  selectedCount={chosen.length}
                  bulkActions={bulkActions}
                />
              </div>
            </>
          )}
        />
      )}
      <DiscountTypeDialog open={chooserOpen} onOpenChange={setChooserOpen} />
      <ConfirmDialog
        open={confirmRows !== null}
        onOpenChange={(next) => {
          if (!next && !bulkBusy) setConfirmRows(null);
        }}
        title={confirmRows?.length === 1
          ? t("deleteTitle", { name: titleOf(confirmRows[0]!) })
          : t("bulkDeleteTitle", { count: formatNumber(confirmRows?.length ?? 0) })}
        description={t(confirmRows?.length === 1 ? "deleteBody" : "bulkDeleteBody")}
        confirmLabel={t(confirmRows?.length === 1 ? "delete" : "bulkDelete")}
        cancelLabel={t("cancel")}
        isLoading={bulkBusy === "delete"}
        onConfirm={() => void runBulk("delete", confirmRows ?? [])}
      />
    </div>
  );
}
