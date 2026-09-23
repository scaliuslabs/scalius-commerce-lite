import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Eye, ExternalLink, ShoppingCart, Trash2 } from "lucide-react";
import { deleteApiV1AdminAbandonedCheckouts } from "@scalius/api-client/sdk";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/admin/data-table/DataTable";
import { DataTableToolbar } from "@/components/admin/data-table/DataTableToolbar";
import { DataTableRowActions } from "@/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "@/components/admin/data-table/useServerTable";
import { createSelectColumn } from "@/components/admin/data-table/columns/column-factories";
import type { ColumnDef, Row } from "@/components/admin/data-table/table-config";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import { useCurrency } from "@/hooks/use-currency";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import { apiData } from "@/lib/api";
import {
  abandonedCheckoutsQueryOptions,
  type AbandonedCheckout,
} from "@/lib/api-query-options/abandoned-checkouts";
import {
  formatAbandonedCheckoutId,
  parseAbandonedCheckoutDisplay,
  type ParsedAbandonedCheckoutDisplay,
} from "@/lib/abandoned-checkout-display";
import {
  abandonedCheckoutRouteStateToQuery,
  type AbandonedCheckoutRouteState,
} from "@/lib/abandoned-checkout-route-state";
import { createDataSelector, getCanonicalPageForPagination } from "@/lib/list-helpers";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import { ListDate } from "./ListDate";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";

const selectCheckouts = createDataSelector<AbandonedCheckout>("checkouts");
const SORTS = ["updatedAt:desc", "updatedAt:asc", "customerPhone:asc", "checkoutId:asc"] as const;

const parsed = new WeakMap<AbandonedCheckout, ParsedAbandonedCheckoutDisplay>();
function displayOf(checkout: AbandonedCheckout): ParsedAbandonedCheckoutDisplay {
  let display = parsed.get(checkout);
  if (!display) {
    display = parseAbandonedCheckoutDisplay(checkout);
    parsed.set(checkout, display);
  }
  return display;
}

function StageBadge({ checkout }: { checkout: AbandonedCheckout }) {
  const t = useMessages(orderListMessages);
  const display = displayOf(checkout);
  return (
    <Badge
      variant={display.variant}
      title={display.stage === "paymentNotFinished" ? t("paymentNotFinishedHelp") : undefined}
    >
      {t(`stage.${display.stage}`)}
    </Badge>
  );
}

function CustomerCell({ checkout }: { checkout: AbandonedCheckout }) {
  const t = useMessages(orderListMessages);
  const { customerInfo } = displayOf(checkout);
  return (
    <div className="min-w-0">
      <p className="break-words font-medium">{customerInfo.name || t("noName")}</p>
      <p className={customerInfo.phone ? "font-mono text-body text-muted-foreground" : "text-body text-muted-foreground"}>
        {customerInfo.phone ? formatPhoneForDisplay(customerInfo.phone) : t("noPhone")}
      </p>
    </div>
  );
}

function TotalCell({ checkout }: { checkout: AbandonedCheckout }) {
  const { fmt } = useCurrency();
  const display = displayOf(checkout);
  return <span className="font-medium tabular-nums">{display.kind === "unknown" ? "—" : fmt(display.total)}</span>;
}

function Title({ k }: { k: "checkout" | "customer" | "progress" | "total" }) {
  const t = useMessages(orderListMessages);
  return <>{t(k)}</>;
}

function CheckoutRowActions({
  checkout,
  canDelete,
  onView,
  onDelete,
}: {
  checkout: AbandonedCheckout;
  canDelete: boolean;
  onView: (checkout: AbandonedCheckout) => void;
  onDelete: (id: string) => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const navigate = useNavigate();
  const orderId = displayOf(checkout).orderId;
  return (
    <DataTableRowActions
      menuLabel={`${tr("moreActions")} ${formatAbandonedCheckoutId(checkout.checkoutId || checkout.id)}`}
      extraActions={[
        { label: tr("view"), icon: Eye, onClick: () => onView(checkout) },
        ...(orderId
          ? [{
              label: t("viewOrder"),
              icon: ExternalLink,
              onClick: () => void navigate({ to: "/admin/orders/$orderId", params: { orderId } }),
            }]
          : []),
        ...(canDelete
          ? [{ label: t("delete"), icon: Trash2, destructive: true, onClick: () => onDelete(checkout.id) }]
          : []),
      ]}
    />
  );
}

function DetailsDialog({
  checkout,
  open,
  onClose,
}: {
  checkout: AbandonedCheckout | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useMessages(orderListMessages);
  const { fmt } = useCurrency();
  if (!checkout) return <Dialog open={false} />;
  const display = displayOf(checkout);
  const { customerInfo, items } = display;
  const facts = [
    ["name", customerInfo.name],
    ["phone", customerInfo.phone ? formatPhoneForDisplay(customerInfo.phone) : null],
    ["email", customerInfo.email],
    ["address", customerInfo.address],
    ["area", customerInfo.location],
    ["notes", customerInfo.notes],
  ] as const;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("checkoutTitle", { id: formatAbandonedCheckoutId(checkout.checkoutId || checkout.id) })}</DialogTitle>
          <DialogDescription>{t(`stage.${display.stage}`)}</DialogDescription>
        </DialogHeader>
        {display.kind === "stale_hosted_payment_order" ? (
          <p className="text-body text-muted-foreground">{t("paymentNotFinishedHelp")}</p>
        ) : null}
        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-body">
          {facts.map(([key, value]) =>
            value ? (
              <div key={key} className="col-span-3 grid grid-cols-3 gap-3">
                <dt className="text-muted-foreground">{t(`field.${key}`)}</dt>
                <dd className="col-span-2 break-words">{value}</dd>
              </div>
            ) : null,
          )}
        </dl>
        {items.length > 0 ? (
          <ul className="divide-y border-y text-body">
            {items.map((item, index) => (
              <li key={`${item.id}:${item.variantId ?? index}`} className="flex justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{item.name}</p>
                  <p className="text-body text-muted-foreground">
                    {[
                      ...(item.options ?? []).map((option) => `${option.name}: ${option.value}`),
                      t("qtyTimesPrice", { qty: item.quantity, price: fmt(item.price) }),
                    ].join(" · ")}
                  </p>
                </div>
                <p className="shrink-0 font-medium">{fmt(item.price * item.quantity)}</p>
              </li>
            ))}
            <li className="flex justify-between py-3 font-medium">
              <span>{t("cartTotal")}</span>
              <span>{fmt(display.total)}</span>
            </li>
          </ul>
        ) : display.kind === "cart" ? (
          <p className="text-body text-muted-foreground">{t("emptyCart")}</p>
        ) : (
          <p className="flex justify-between text-body font-medium">
            <span>{t("total")}</span>
            <span>{fmt(display.total)}</span>
          </p>
        )}
        <DialogFooter>
          {display.orderId ? (
            <Button variant="outline" asChild>
              <Link to="/admin/orders/$orderId" params={{ orderId: display.orderId }}>
                {t("viewOrder")}
              </Link>
            </Button>
          ) : null}
          <Button onClick={onClose}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Abandoned checkouts under Orders: who started checking out, how far they got, and the cart. */
export function AbandonedCheckoutList({
  routeState,
  onRouteStateChange,
}: {
  routeState: AbandonedCheckoutRouteState;
  onRouteStateChange: (
    updates: Partial<AbandonedCheckoutRouteState>,
    options?: { replace?: boolean },
  ) => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const orderActions = useOrderActionPermissions();
  const [details, setDetailsState] = useState<AbandonedCheckout | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const setDetails = useCallback((checkout: AbandonedCheckout) => {
    setDetailsState(checkout);
    setDetailsOpen(true);
  }, []);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const columns = useMemo<ColumnDef<AbandonedCheckout, unknown>[]>(() => {
    const list: ColumnDef<AbandonedCheckout, unknown>[] = [
      {
        id: "checkout",
        header: () => <Title k="checkout" />,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className="rounded-sm text-left font-mono text-body font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDetails(row.original)}
            >
              {formatAbandonedCheckoutId(row.original.checkoutId || row.original.id)}
            </button>
            <ListDate value={row.original.updatedAt} className="text-body text-muted-foreground" />
          </div>
        ),
      },
      { id: "customer", header: () => <Title k="customer" />, cell: ({ row }) => <CustomerCell checkout={row.original} /> },
      { id: "progress", header: () => <Title k="progress" />, cell: ({ row }) => <StageBadge checkout={row.original} /> },
      {
        id: "total",
        header: () => <div className="text-right"><Title k="total" /></div>,
        cell: ({ row }) => <div className="text-right"><TotalCell checkout={row.original} /></div>,
      },
      {
        id: "actions",
        header: () => null,
        cell: ({ row }) => (
          <CheckoutRowActions
            checkout={row.original}
            canDelete={orderActions.canDeleteOrders}
            onView={setDetails}
            onDelete={(id) => setDeleteIds([id])}
          />
        ),
      },
    ];
    if (orderActions.canBulkDeleteOrders) {
      list.unshift(createSelectColumn<AbandonedCheckout>({
        getLabel: (row) => formatAbandonedCheckoutId((row as AbandonedCheckout).checkoutId),
      }));
    }
    return list;
  }, [orderActions.canBulkDeleteOrders, orderActions.canDeleteOrders, setDetails]);

  const {
    table, rawData, error, isError, isFetching, isLoading, refetch, pagination,
    selectedIds, clearSelection,
  } = useServerTable({
    columns,
    queryOptions: abandonedCheckoutsQueryOptions(abandonedCheckoutRouteStateToQuery(routeState)),
    dataSelector: selectCheckouts,
    currentPage: routeState.page,
    currentLimit: routeState.limit,
    onPaginationChange: (page, limit) => onRouteStateChange({ page, limit }),
    onSortingChange: () => undefined,
    enableSorting: false,
    defaultPageSize: 20,
  });

  useEffect(() => {
    if (!rawData) return;
    const canonicalPage = getCanonicalPageForPagination(routeState.page, pagination);
    if (canonicalPage !== routeState.page) onRouteStateChange({ page: canonicalPage }, { replace: true });
  }, [onRouteStateChange, pagination, rawData, routeState.page]);

  const hostedInDelete = (deleteIds ?? []).filter((id) => {
    const row = table.getRowModel().rows.find((candidate) => candidate.original.id === id);
    return row ? displayOf(row.original).kind === "stale_hosted_payment_order" : false;
  }).length;

  const performDelete = async () => {
    if (!deleteIds) return;
    if (!orderActions.canDeleteOrders) {
      toast.error(t("noPermission"));
      setDeleteIds(null);
      return;
    }
    setDeleting(true);
    try {
      await apiData(deleteApiV1AdminAbandonedCheckouts({ body: { ids: deleteIds } }));
      toast.success(t("checkoutsDeleted"));
      clearSelection();
      void queryClient.invalidateQueries({ queryKey: queryKeys.abandonedCheckouts.all });
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
      setDeleteIds(null);
    }
  };

  const mobileCardRenderer = useCallback(
    (row: Row<AbandonedCheckout>) => (
      <div className="flex items-start gap-3 px-3 py-3">
        {orderActions.canBulkDeleteOrders ? (
          <label className="-my-2 -ml-3 flex shrink-0 p-3.5">
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={() => row.toggleSelected()}
              aria-label={tr("select", { name: formatAbandonedCheckoutId(row.original.checkoutId) })}
            />
          </label>
        ) : null}
        <button type="button" className="min-w-0 flex-1 space-y-1 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setDetails(row.original)}>
          <div className="flex items-baseline gap-2 text-body">
            <span className="min-w-0 flex-1"><CustomerCell checkout={row.original} /></span>
            <TotalCell checkout={row.original} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ListDate value={row.original.updatedAt} className="text-body text-muted-foreground" />
            <StageBadge checkout={row.original} />
          </div>
        </button>
      </div>
    ),
    [orderActions.canBulkDeleteOrders, setDetails, tr],
  );

  const bulkDelete = orderActions.canBulkDeleteOrders ? (
    <Button variant="destructive" onClick={() => setDeleteIds([...selectedIds])} disabled={deleting}>
      <Trash2 className="h-4 w-4" />
      {t("delete")}
    </Button>
  ) : null;

  return (
    <>
      <DataTable
        variant="bare"
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={isError ? error : null}
        onRetry={() => void refetch()}
        itemLabel={t("checkoutsLabel")}
        pageSizeOptions={[10, 20, 50, 100]}
        mobileCardRenderer={mobileCardRenderer}
        toolbar={<div className="px-2 pt-2"><DataTableToolbar
            searchValue={routeState.search}
            onSearchChange={(search) => onRouteStateChange({ search, page: 1 }, { replace: true })}
            searchPlaceholder={t("searchCheckouts")}
            selectedCount={selectedIds.length}
            bulkActions={<div className="hidden md:flex">{bulkDelete}</div>}
            filters={
              <Select
                value={`${routeState.sort}:${routeState.order}`}
                onValueChange={(value) => {
                  const [sort, order] = value.split(":") as [AbandonedCheckoutRouteState["sort"], "asc" | "desc"];
                  onRouteStateChange({ sort, order, page: 1 });
                }}
              >
                <SelectTrigger className="w-auto" aria-label={t("sort")}>
                  <SelectValue placeholder={t("sort")} />
                </SelectTrigger>
                <SelectContent>
                  {SORTS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`checkoutSort.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          /></div>}
        emptyState={{
          icon: ShoppingCart,
          title: routeState.search ? t("noMatchCheckouts") : t("abandonedEmptyTitle"),
          description: routeState.search ? tr("noResultsHint") : t("abandonedEmptyBody"),
          action: routeState.search ? (
            <Button variant="outline" onClick={() => onRouteStateChange({ search: "", page: 1 })}>
              {tr("clearSearch")}
            </Button>
          ) : undefined,
        }}
      />

      <SelectionSheet count={selectedIds.length} clearLabel={t("clearSelection")} onClear={clearSelection}>
        {bulkDelete}
      </SelectionSheet>

      <ConfirmDialog
        open={deleteIds !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteIds(null);
        }}
        title={t("deleteCheckoutsTitle", { count: deleteIds?.length ?? 0 })}
        description={hostedInDelete > 0 ? `${tr("deleteBody")} ${t("hostedDeleteNote")}` : tr("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={tr("cancel")}
        isLoading={deleting}
        loadingLabel={tr("working")}
        onConfirm={() => void performDelete()}
      />

      <DetailsDialog checkout={details} open={detailsOpen} onClose={() => setDetailsOpen(false)} />
    </>
  );
}
