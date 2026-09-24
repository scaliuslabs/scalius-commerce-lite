import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ExternalLink, ShoppingCart, Trash2, X } from "lucide-react";
import { deleteApiV1AdminAbandonedCheckouts } from "@scalius/api-client/sdk";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/admin/data-table/DataTable";
import { DataTableToolbar } from "@/components/admin/data-table/DataTableToolbar";
import { DataTableRowActions } from "@/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "@/components/admin/data-table/useServerTable";
import { createSelectColumn } from "@/components/admin/data-table/columns/column-factories";
import type { ColumnDef, Row } from "@/components/admin/data-table/table-config";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { customerContactLinks } from "~/components/admin/orderview/contact-links";
import { useCurrency } from "@/hooks/use-currency";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import { apiData } from "@/lib/api";
import {
  abandonedCheckoutsQueryOptions,
  type AbandonedCheckout,
} from "@/lib/api-query-options/abandoned-checkouts";
import {
  parseAbandonedCheckoutDisplay,
  type AbandonedCheckoutCustomerInfo,
  type ParsedAbandonedCheckoutDisplay,
} from "@/lib/abandoned-checkout-display";
import {
  abandonedCheckoutRouteStateToQuery,
  type AbandonedCheckoutRouteState,
} from "@/lib/abandoned-checkout-route-state";
import { createDataSelector, getCanonicalPageForPagination } from "@/lib/list-helpers";
import { useListSearch } from "~/lib/list-search";
import { queryKeys } from "@/lib/query-keys";
import { translate, useLocale, useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderListMessages, pluralKey } from "~/i18n/order-list";
import { buildOrderPrefill, checkoutReference, writeOrderPrefill } from "./abandoned-checkout-prefill";
import { ListDate } from "./ListDate";

const selectCheckouts = createDataSelector<AbandonedCheckout>("checkouts");
const SORTS = ["updatedAt:desc", "updatedAt:asc", "customerPhone:asc", "checkoutId:asc"] as const;
/** Abandoned checkout search terms (phones, names) stay in this tab's session, never in the URL. */
const CHECKOUT_SEARCH_LIST = "abandoned-checkouts";

export type AbandonedCheckoutListState = Omit<AbandonedCheckoutRouteState, "search">;

const parsed = new WeakMap<AbandonedCheckout, ParsedAbandonedCheckoutDisplay>();
function displayOf(checkout: AbandonedCheckout): ParsedAbandonedCheckoutDisplay {
  let display = parsed.get(checkout);
  if (!display) {
    display = parseAbandonedCheckoutDisplay(checkout);
    parsed.set(checkout, display);
  }
  return display;
}

function Reference({ checkout }: { checkout: AbandonedCheckout }) {
  return <code>{checkoutReference(checkout.checkoutId || checkout.id)}</code>;
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
      <p className="line-clamp-2 break-words font-medium">{customerInfo.name || t("noName")}</p>
      <p className={customerInfo.phone ? "whitespace-nowrap font-mono text-body text-muted-foreground" : "text-body text-muted-foreground"}>
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
  onDelete,
}: {
  checkout: AbandonedCheckout;
  canDelete: boolean;
  onDelete: (id: string) => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const navigate = useNavigate();
  const orderId = displayOf(checkout).orderId;
  const actions = [
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
  ];
  if (actions.length === 0) return null;
  return (
    <DataTableRowActions
      menuLabel={`${tr("moreActions")} ${checkoutReference(checkout.checkoutId || checkout.id)}`}
      extraActions={actions}
    />
  );
}

/** The checkout a customer left: who, where to, the cart, and one-tap ways to follow up. */
function CheckoutSheet({
  checkout,
  open,
  canCreateOrder,
  onClose,
}: {
  checkout: AbandonedCheckout | null;
  open: boolean;
  canCreateOrder: boolean;
  onClose: () => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const td = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const navigate = useNavigate();
  const display = checkout ? displayOf(checkout) : null;
  const info: AbandonedCheckoutCustomerInfo = display?.customerInfo ?? {};
  const name = info.name || t("noName");
  const contact = info.phone ? customerContactLinks(info.phone) : null;
  const address = [info.address, info.location].filter(Boolean).join(", ");

  const createOrder = () => {
    if (!checkout || !display) return;
    writeOrderPrefill(buildOrderPrefill(checkout.checkoutData, display));
    void navigate({ to: "/admin/orders/new" });
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="flex flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-start gap-2">
          <SheetHeader className="min-w-0 flex-1">
            <SheetTitle className="break-words">{name}</SheetTitle>
            <SheetDescription>
              {checkout ? (
                <>
                  <Reference checkout={checkout} /> · <ListDate value={checkout.updatedAt} />
                </>
              ) : null}
            </SheetDescription>
          </SheetHeader>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" aria-label={tr("close")}>
              <X className="size-4" />
            </Button>
          </SheetClose>
        </div>
        {checkout && display ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge checkout={checkout} />
            </div>
            {display.kind === "stale_hosted_payment_order" ? (
              <p className="text-body text-muted-foreground">{t("paymentNotFinishedHelp")}</p>
            ) : null}
            <section className="space-y-1 text-body">
              <p className={info.phone ? "font-mono" : "text-muted-foreground"}>
                {info.phone ? formatPhoneForDisplay(info.phone) : t("noPhone")}
              </p>
              {info.email ? <p className="break-all text-muted-foreground">{info.email}</p> : null}
              {contact ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button variant="outline" size="sm" asChild>
                    <a href={contact.call} aria-label={td("contact.callName", { name })}>{td("contact.call")}</a>
                  </Button>
                  {contact.whatsapp ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={contact.whatsapp} target="_blank" rel="noopener noreferrer" aria-label={td("contact.whatsappName", { name })}>
                        {td("contact.whatsapp")}
                      </a>
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" asChild>
                    <a href={contact.sms} aria-label={td("contact.smsName", { name })}>{td("contact.sms")}</a>
                  </Button>
                </div>
              ) : null}
            </section>
            <section className="space-y-1 border-t pt-4 text-body">
              <h3 className="text-heading-sm">{t("field.address")}</h3>
              <p className="break-words text-muted-foreground">{address || t("noAddress")}</p>
              {info.notes ? <p className="break-words text-muted-foreground">{info.notes}</p> : null}
            </section>
            {display.items.length > 0 ? (
              <ul className="divide-y border-y text-body">
                {display.items.map((item, index) => (
                  <li key={`${item.id}:${item.variantId ?? index}`} className="flex justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-muted-foreground">
                        {[
                          ...(item.options ?? []).map((option) => `${option.name}: ${option.value}`),
                          t("qtyTimesPrice", { qty: item.quantity, price: fmt(item.price) }),
                        ].join(" · ")}
                      </p>
                    </div>
                    <p className="shrink-0 font-medium tabular-nums">{fmt(item.price * item.quantity)}</p>
                  </li>
                ))}
                <li className="flex justify-between py-3 font-medium">
                  <span>{t("cartTotal")}</span>
                  <span className="tabular-nums">{fmt(display.total)}</span>
                </li>
              </ul>
            ) : display.kind === "cart" ? (
              <p className="text-body text-muted-foreground">{t("emptyCart")}</p>
            ) : (
              <p className="flex justify-between text-body font-medium">
                <span>{t("total")}</span>
                <span className="tabular-nums">{fmt(display.total)}</span>
              </p>
            )}
          </>
        ) : null}
        <SheetFooter className="mt-auto">
          {display?.orderId ? (
            <Button variant="outline" asChild>
              <Link to="/admin/orders/$orderId" params={{ orderId: display.orderId }}>
                {t("viewOrder")}
              </Link>
            </Button>
          ) : null}
          {canCreateOrder && display?.kind === "cart" && display.items.length > 0 ? (
            <Button onClick={createOrder}>{t("createOrder")}</Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Abandoned checkouts under Orders: who started checking out, how far they got, and the cart. */
export function AbandonedCheckoutList({
  routeState,
  onRouteStateChange,
}: {
  routeState: AbandonedCheckoutListState;
  onRouteStateChange: (
    updates: Partial<AbandonedCheckoutListState>,
    options?: { replace?: boolean },
  ) => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const orderActions = useOrderActionPermissions();
  const [term, setTerm] = useListSearch(CHECKOUT_SEARCH_LIST);
  const openId = useMatch({ from: "/admin/orders/_list/abandoned/$checkoutId", shouldThrow: false })?.params.checkoutId ?? null;
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const locale = useLocale();

  const columns = useMemo<ColumnDef<AbandonedCheckout, unknown>[]>(() => {
    const label = (key: Parameters<typeof t>[0]) => translate(orderListMessages, key);
    const list: ColumnDef<AbandonedCheckout, unknown>[] = [
      {
        id: "checkout",
        meta: { label: label("checkout"), primary: true, minWidth: 150 },
        header: () => <Title k="checkout" />,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Link
              to="/admin/orders/abandoned/$checkoutId"
              params={{ checkoutId: row.original.id }}
              className="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="whitespace-nowrap"><Reference checkout={row.original} /></span>
            </Link>
            <ListDate value={row.original.updatedAt} className="whitespace-nowrap text-body text-muted-foreground" />
          </div>
        ),
      },
      {
        id: "customer",
        meta: { label: label("customer"), priority: 90, minWidth: 180 },
        header: () => <Title k="customer" />,
        cell: ({ row }) => <CustomerCell checkout={row.original} />,
      },
      {
        id: "progress",
        meta: { label: label("progress"), priority: 60, minWidth: 140 },
        header: () => <Title k="progress" />,
        cell: ({ row }) => <StageBadge checkout={row.original} />,
      },
      {
        id: "total",
        meta: { label: label("total"), priority: 80, minWidth: 110, numeric: true },
        header: () => <Title k="total" />,
        cell: ({ row }) => <TotalCell checkout={row.original} />,
      },
      {
        id: "actions",
        header: () => null,
        cell: ({ row }) => (
          <CheckoutRowActions
            checkout={row.original}
            canDelete={orderActions.canDeleteOrders}
            onDelete={(id) => setDeleteIds([id])}
          />
        ),
      },
    ];
    if (orderActions.canBulkDeleteOrders) {
      list.unshift(createSelectColumn<AbandonedCheckout>({
        getLabel: (row) => checkoutReference((row as AbandonedCheckout).checkoutId || (row as AbandonedCheckout).id),
      }));
    }
    return list;
    // The locale re-labels the columns for the column menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderActions.canBulkDeleteOrders, orderActions.canDeleteOrders, locale]);

  const {
    table, rawData, error, isError, isFetching, isLoading, refetch, pagination,
    selectedIds, clearSelection,
  } = useServerTable({
    columns,
    queryOptions: abandonedCheckoutsQueryOptions(abandonedCheckoutRouteStateToQuery({ ...routeState, search: term })),
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

  // Keep the last opened checkout while the sheet slides closed.
  const [shown, setShown] = useState<AbandonedCheckout | null>(null);
  const openCheckout = openId
    ? table.getRowModel().rows.find((row) => row.original.id === openId)?.original ?? null
    : null;
  useEffect(() => {
    if (openCheckout) setShown(openCheckout);
  }, [openCheckout]);
  // The list's page and sort are retained by the route (retainSearchParams).
  const closeSheet = () => void navigate({ to: "/admin/orders/abandoned", replace: true });

  const hostedInDelete = (deleteIds ?? []).filter((id) => {
    const row = table.getRowModel().rows.find((candidate) => candidate.original.id === id);
    return row ? displayOf(row.original).kind === "stale_hosted_payment_order" : false;
  }).length;

  const performDelete = async () => {
    if (!deleteIds || deleting) return;
    if (!orderActions.canDeleteOrders) {
      toast.error(t("noPermission"));
      setDeleteIds(null);
      return;
    }
    setDeleting(true);
    try {
      await apiData(deleteApiV1AdminAbandonedCheckouts({ body: { ids: deleteIds } }));
      toast.success(t(pluralKey("checkoutsDeleted", deleteIds.length)));
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
      <div className="flex items-start gap-1 py-1 pr-3">
        {orderActions.canBulkDeleteOrders ? (
          <label className="flex size-11 shrink-0 items-center justify-center">
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={() => row.toggleSelected()}
              aria-label={tr("select", { name: checkoutReference(row.original.checkoutId || row.original.id) })}
            />
          </label>
        ) : null}
        <div className="min-w-0 flex-1 space-y-1 py-2 pl-2">
          <div className="flex items-baseline gap-2 text-body">
            <span className="min-w-0 flex-1"><CustomerCell checkout={row.original} /></span>
            <TotalCell checkout={row.original} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
            <Reference checkout={row.original} />
            <ListDate value={row.original.updatedAt} />
            <StageBadge checkout={row.original} />
          </div>
        </div>
      </div>
    ),
    [orderActions.canBulkDeleteOrders, tr],
  );

  const bulkDelete = orderActions.canBulkDeleteOrders ? (
    <Button variant="destructive" onClick={() => setDeleteIds([...selectedIds])} disabled={deleting}>
      <Trash2 className="h-4 w-4" />
      {t("delete")}
    </Button>
  ) : null;
  const deleteCount = deleteIds?.length ?? 0;

  return (
    <>
      <DataTable
        variant="bare"
        getRowHref={(checkout) => `/admin/orders/abandoned/${encodeURIComponent(checkout.id)}`}
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={isError ? error : null}
        onRetry={() => void refetch()}
        itemLabel={t("checkoutsLabel")}
        pageSizeOptions={[10, 20, 50, 100]}
        mobileCardRenderer={mobileCardRenderer}
        layoutKey="abandoned-checkouts"
        toolbar={<div className="px-2 pt-2"><DataTableToolbar
            searchValue={term}
            onSearchChange={(value) => {
              setTerm(value);
              onRouteStateChange({ page: 1 }, { replace: true });
            }}
            searchPlaceholder={t("searchCheckouts")}
            selectedCount={selectedIds.length}
            bulkActions={<div className="hidden md:flex">{bulkDelete}</div>}
            filters={
              <Select
                value={`${routeState.sort}:${routeState.order}`}
                onValueChange={(value) => {
                  const [sort, order] = value.split(":") as [AbandonedCheckoutListState["sort"], "asc" | "desc"];
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
          title: term ? t("noMatchCheckouts") : t("abandonedEmptyTitle"),
          description: term ? tr("noResultsHint") : t("abandonedEmptyBody"),
          action: term ? (
            <Button variant="outline" onClick={() => setTerm("")}>
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
        title={t(pluralKey("deleteCheckoutsTitle", deleteCount), { count: deleteCount })}
        description={hostedInDelete > 0 ? `${tr("deleteBody")} ${t("hostedDeleteNote")}` : tr("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={tr("cancel")}
        isLoading={deleting}
        loadingLabel={tr("working")}
        onConfirm={() => void performDelete()}
      />

      <CheckoutSheet
        checkout={openCheckout ?? shown}
        open={openCheckout !== null}
        canCreateOrder={orderActions.canCreateOrders}
        onClose={closeSheet}
      />
    </>
  );
}
