import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  createDataSelector,
  createListSearchValidator,
  getCanonicalPageForPagination,
  normalizeBooleanSearchParam,
  normalizeDateSearchParam,
  normalizeOptionalEnumSearchParam,
  normalizeOptionalSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import type { Row } from "@tanstack/react-table";
import {
  isOrderArchiveStatusEligible,
  type OrderListItem,
} from "@scalius/core/modules/orders";
import type { DateRange } from "react-day-picker";
import { formatDateShort } from "@scalius/shared/timestamps";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import {
  useUpdateOrderStatus,
  useArchiveOrders,
  useBulkShipOrders,
  useRestoreOrder,
} from "~/lib/api-mutations/orders";
import { useCurrency } from "~/hooks/use-currency";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { getOrderColumns } from "~/components/admin/data-table/columns/order-columns";
import { OrderToolbar } from "~/components/admin/data-table/toolbars/OrderToolbar";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ShoppingBag } from "lucide-react";
import { OrderMobileCard } from "~/components/admin/order-list/OrderMobileCard";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import type { BulkShipOrdersPayload } from "~/lib/api-functions/orders";
import type { BulkShipResultSummary } from "~/components/admin/order-list/BulkShipDialog";

const ArchiveOrderDialog = lazy(() =>
  import("~/components/admin/order-list/ArchiveOrderDialog").then((module) => ({
    default: module.ArchiveOrderDialog,
  })),
);

const BulkShipDialog = lazy(() =>
  import("~/components/admin/order-list/BulkShipDialog").then((module) => ({
    default: module.BulkShipDialog,
  })),
);

// ── Search schema ─────────────────────────────────────────────────

const baseSearchValidator = createListSearchValidator(
  [
    "relevance",
    "customerName",
    "totalAmount",
    "status",
    "createdAt",
    "updatedAt",
  ] as const,
  { limit: 10, sort: "updatedAt" },
);

type OrderSort =
  | "relevance"
  | "customerName"
  | "totalAmount"
  | "status"
  | "createdAt"
  | "updatedAt";

const PAYMENT_STATUS_FILTERS = [
  "unpaid",
  "partial",
  "paid",
  "refunded",
  "failed",
] as const;

const PAYMENT_METHOD_FILTERS = [
  "cod",
  "stripe",
  "sslcommerz",
  "polar",
] as const;

const FULFILLMENT_STATUS_FILTERS = [
  "pending",
  "partial",
  "complete",
] as const;

const PAYMENT_RECOVERY_FILTERS = [
  "recoverable",
  "awaiting_payment",
  "processing",
  "needs_attention",
] as const;

type SearchParams = Omit<ListSearchParams<OrderSort>, "trashed"> & {
  archived: boolean;
  status?: string;
  paymentStatus?: (typeof PAYMENT_STATUS_FILTERS)[number];
  paymentMethod?: (typeof PAYMENT_METHOD_FILTERS)[number];
  fulfillmentStatus?: (typeof FULFILLMENT_STATUS_FILTERS)[number];
  paymentRecovery?: (typeof PAYMENT_RECOVERY_FILTERS)[number];
  startDate?: string;
  endDate?: string;
};

function validateOrderSearch(search: SearchValidatorInput<SearchParams>): SearchParams {
  const { trashed: _legacyTrashed, ...baseSearch } = baseSearchValidator(search);
  return {
    ...baseSearch,
    archived: normalizeBooleanSearchParam(search.archived),
    status: normalizeOptionalSearchString(search.status),
    paymentStatus: normalizeOptionalEnumSearchParam(
      search.paymentStatus,
      PAYMENT_STATUS_FILTERS,
    ),
    paymentMethod: normalizeOptionalEnumSearchParam(
      search.paymentMethod,
      PAYMENT_METHOD_FILTERS,
    ),
    fulfillmentStatus: normalizeOptionalEnumSearchParam(
      search.fulfillmentStatus,
      FULFILLMENT_STATUS_FILTERS,
    ),
    paymentRecovery: normalizeOptionalEnumSearchParam(
      search.paymentRecovery,
      PAYMENT_RECOVERY_FILTERS,
    ),
    startDate: normalizeDateSearchParam(search.startDate),
    endDate: normalizeDateSearchParam(search.endDate),
  };
}

// ── Map search params to API params ───────────────────────────────

function mapParams(deps: SearchParams) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    status: deps.status,
    paymentStatus: deps.paymentStatus,
    paymentMethod: deps.paymentMethod,
    fulfillmentStatus: deps.fulfillmentStatus,
    paymentRecovery: deps.paymentRecovery,
    sort: deps.sort,
    order: deps.order,
    showArchived: deps.archived,
    startDate: deps.startDate,
    endDate: deps.endDate,
  };
}

// ── Shipment types ────────────────────────────────────────────────

interface ShipmentStatus {
  id: string;
  orderId: string;
  [key: string]: unknown;
}

const ORDER_AUTO_REFRESH_SECONDS = 60;
const ORDER_AUTO_REFRESH_DEBOUNCE_MS = 5_000;

function isDocumentHidden() {
  return typeof document !== "undefined" && document.hidden;
}

function hasPaymentRecoveryState(order: OrderListItem) {
  return order.paymentRecovery != null && order.paymentRecovery.state !== "none";
}

function hasActivePaymentSetup(order: OrderListItem) {
  return order.paymentRecovery?.activeProcessing === true;
}

function hasActiveRefundOperation(order: OrderListItem) {
  return order.activeRefundOperation?.active === true;
}

function hasActiveShipmentLock(order: OrderListItem) {
  return order.shipmentRecovery?.activeLock === true;
}

function buildRecoveryExportSearchParams(search: SearchParams) {
  if (!search.paymentRecovery) return null;
  const params = new URLSearchParams();
  params.set("state", search.paymentRecovery);
  if (search.search.trim()) params.set("search", search.search.trim());
  if (search.paymentMethod) params.set("paymentMethod", search.paymentMethod);
  if (search.sort) params.set("sort", search.sort);
  if (search.order) params.set("order", search.order);
  if (search.startDate) params.set("startDate", search.startDate);
  if (search.endDate) params.set("endDate", search.endDate);
  return params;
}

function getSafeBulkShipError(error: unknown) {
  return typeof error === "string" && error.trim()
    ? error.replace(/\s+/g, " ").slice(0, 160)
    : "Shipment could not be created.";
}

function buildBulkShipResultSummary(
  result: BulkShipOrdersPayload,
): BulkShipResultSummary {
  return {
    totalProcessed: result.totalProcessed,
    successCount: result.successCount,
    failureCount: result.failureCount,
    failures: result.results
      .filter((item) => !item.success)
      .map((item) => ({
        orderId: item.orderId,
        error: getSafeBulkShipError(item.error),
      })),
  };
}

function buildFailedBulkShipResultSummary(
  orderIds: readonly string[],
): BulkShipResultSummary {
  return {
    totalProcessed: orderIds.length,
    successCount: 0,
    failureCount: orderIds.length,
    failures: orderIds.map((orderId) => ({
      orderId,
      error: "Shipment request failed. Try again.",
    })),
  };
}

// ── Route definition ──────────────────────────────────────────────

export const Route = createFileRoute("/admin/orders/")({
  validateSearch: validateOrderSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 30,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, ordersQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.archived ? "Archived Orders" : "Orders"} | Scalius Admin`,
      },
    ],
  }),
  component: OrdersPage,
  errorComponent: RouteErrorComponent,
});

// ── Page component ────────────────────────────────────────────────

function OrdersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { symbol } = useCurrency();
  const orderActions = useOrderActionPermissions();
  const showTrashed = search.archived;

  // ── Local state ───────────────────────────────────────────────
  const [shipmentStatuses, setShipmentStatuses] = useState<
    Record<string, ShipmentStatus>
  >({});
  const [updatingStatusIds, setUpdatingStatusIds] = useState<Set<string>>(
    new Set(),
  );
  const [orderToArchive, setOrderToArchive] = useState<{
    id: string;
    expectedVersion: number;
  } | null>(null);
  const [isBulkArchiveOpen, setIsBulkArchiveOpen] = useState(false);
  const [isShippingDialogOpen, setIsShippingDialogOpen] = useState(false);
  const [isShipping, setIsShipping] = useState(false);
  const [lastBulkShipResult, setLastBulkShipResult] =
    useState<BulkShipResultSummary | null>(null);
  // Derive filter values directly from URL search params (reactive to back/forward)
  const activeStatus = search.status ?? null;
  const activePaymentStatus = search.paymentStatus ?? null;
  const activePaymentMethod = search.paymentMethod ?? null;
  const activeFulfillmentStatus = search.fulfillmentStatus ?? null;
  const activePaymentRecovery = search.paymentRecovery ?? null;
  const hasActiveFilters = Boolean(
    search.search.trim()
      || activeStatus
      || activePaymentStatus
      || activePaymentMethod
      || activeFulfillmentStatus
      || activePaymentRecovery
      || search.startDate
      || search.endDate,
  );
  const isArchiveDialogOpen = !!orderToArchive || isBulkArchiveOpen;

  // Date range — derive from URL params
  const dateRange: DateRange | undefined =
    search.startDate || search.endDate
      ? {
          from: parseDateOnly(search.startDate),
          to: parseDateOnly(search.endDate),
        }
      : undefined;

  // Auto-refresh state
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("orderlist-auto-refresh") === "true";
    }
    return false;
  });
  const [countdown, setCountdown] = useState(ORDER_AUTO_REFRESH_SECONDS);
  const countdownIntervalRef = useRef<number | undefined>(undefined);
  const activeOrderListRefreshRef = useRef<(() => Promise<unknown>) | null>(
    null,
  );
  const orderListFetchingRef = useRef(false);
  const orderListRefreshInFlightRef = useRef(false);
  const lastOrderListRefreshAtRef = useRef(0);

  // ── Mutations ─────────────────────────────────────────────────
  const statusMutation = useUpdateOrderStatus();
  const archiveMut = useArchiveOrders();
  const bulkShipMut = useBulkShipOrders();
  const restoreMut = useRestoreOrder();

  // ── Navigation helpers ────────────────────────────────────────

  const handleNavigate = useCallback(
    (updates: Partial<SearchParams>) => {
      void navigate({
        to: "/admin/orders",
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never,
      });
    },
    [navigate],
  );

  const onSearchChange = useCallback(
    (value: string) => {
      const hasNextSearch = value.trim().length > 0;
      const hasCurrentSearch = search.search.trim().length > 0;

      if (hasNextSearch && !hasCurrentSearch) {
        handleNavigate({
          search: value,
          page: 1,
          sort: "relevance",
          order: "desc",
        });
        return;
      }

      if (!hasNextSearch && search.sort === "relevance") {
        handleNavigate({
          search: value,
          page: 1,
          sort: "updatedAt",
          order: "desc",
        });
        return;
      }

      handleNavigate({ search: value, page: 1 });
    },
    [handleNavigate, search.search, search.sort],
  );

  const onPaginationChange = useCallback(
    (page: number, limit: number) => handleNavigate({ page, limit }),
    [handleNavigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") =>
      handleNavigate({ sort: sort as SearchParams["sort"], order }),
    [handleNavigate],
  );

  // ── Filter handlers ───────────────────────────────────────────

  const onStatusFilterChange = useCallback(
    (status: string | null) => {
      handleNavigate({ status: status ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onPaymentStatusFilterChange = useCallback(
    (paymentStatus: string | null) => {
      handleNavigate({
        paymentStatus: normalizeOptionalEnumSearchParam(
          paymentStatus,
          PAYMENT_STATUS_FILTERS,
        ),
        page: 1,
      });
    },
    [handleNavigate],
  );

  const onPaymentMethodFilterChange = useCallback(
    (paymentMethod: string | null) => {
      handleNavigate({
        paymentMethod: normalizeOptionalEnumSearchParam(
          paymentMethod,
          PAYMENT_METHOD_FILTERS,
        ),
        page: 1,
      });
    },
    [handleNavigate],
  );

  const onFulfillmentStatusFilterChange = useCallback(
    (fulfillmentStatus: string | null) => {
      handleNavigate({
        fulfillmentStatus: normalizeOptionalEnumSearchParam(
          fulfillmentStatus,
          FULFILLMENT_STATUS_FILTERS,
        ),
        page: 1,
      });
    },
    [handleNavigate],
  );

  const onPaymentRecoveryFilterChange = useCallback(
    (paymentRecovery: string | null) => {
      handleNavigate({
        paymentRecovery: normalizeOptionalEnumSearchParam(
          paymentRecovery,
          PAYMENT_RECOVERY_FILTERS,
        ),
        page: 1,
      });
    },
    [handleNavigate],
  );

  const onDateRangeChange = useCallback(
    (range: DateRange | undefined) => {
      handleNavigate({
        startDate: formatDateOnly(range?.from),
        endDate: formatDateOnly(range?.to),
        page: 1,
      });
    },
    [handleNavigate],
  );

  // ── Action handlers ───────────────────────────────────────────

  const handleEdit = useCallback(
    (id: string) => {
      if (!orderActions.canEditOrders) {
        toast.error("Edit unavailable", {
          description: "Your role can view orders but cannot edit them.",
        });
        return;
      }
      void navigate({
        to: "/admin/orders/$orderId/edit",
        params: { orderId: id },
      });
    },
    [navigate, orderActions.canEditOrders],
  );

  const handleArchive = useCallback(
    (id: string, expectedVersion: number) => {
      if (!orderActions.canDeleteOrders) {
        toast.error("Archive unavailable", {
          description: "Your role can view orders but cannot archive them.",
        });
        return;
      }
      setOrderToArchive({ id, expectedVersion });
    },
    [orderActions.canDeleteOrders],
  );

  const handleRestore = useCallback(
    (id: string, expectedVersion: number) => {
      if (!orderActions.canRestoreOrders) {
        toast.error("Restore unavailable", {
          description: "Your role can view archived orders but cannot restore them.",
        });
        return;
      }
      restoreMut.mutate({ id, expectedVersion });
    },
    [restoreMut, orderActions.canRestoreOrders],
  );

  const handleStatusUpdate = useCallback(
    (orderId: string, newStatus: string) => {
      if (!orderActions.canChangeOrderStatus) {
        toast.error("Status change unavailable", {
          description: "Your role can view orders but cannot change order status.",
        });
        return;
      }
      setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
      statusMutation.mutate(
        { orderId, status: newStatus.toLowerCase() },
        {
          onSettled: () => {
            setUpdatingStatusIds((prev) => {
              const newSet = new Set(prev);
              newSet.delete(orderId);
              return newSet;
            });
          },
        },
      );
    },
    [statusMutation, orderActions.canChangeOrderStatus],
  );

  const handleShipmentStatusUpdated = useCallback(
    (updatedShipment: { id: string; orderId: string; [key: string]: unknown }) => {
      setShipmentStatuses((prev) => ({
        ...prev,
        [updatedShipment.orderId]: updatedShipment as ShipmentStatus,
      }));
    },
    [],
  );

  // ── Archive handlers ──────────────────────────────────────────

  const handleSingleArchive = useCallback(() => {
    if (!orderToArchive) return;
    if (!orderActions.canDeleteOrders) {
      toast.error("Archive unavailable", {
        description: "Your role can view orders but cannot archive them.",
      });
      return;
    }
    archiveMut.mutate(
      { orders: [orderToArchive] },
      {
        onSettled: () => {
          setOrderToArchive(null);
        },
      },
    );
  }, [orderToArchive, archiveMut, orderActions.canDeleteOrders]);

  const handleBulkArchiveClick = useCallback(() => {
    if (!orderActions.canBulkDeleteOrders) {
      toast.error("Bulk archive unavailable", {
        description: "Your role can view orders but cannot archive them.",
      });
      return;
    }
    setIsBulkArchiveOpen(true);
  }, [orderActions.canBulkDeleteOrders]);

  // NOTE: handleBulkArchiveConfirm and handleBulkShipmentSubmit are defined
  // after useServerTable to avoid using selectedIds/clearSelection before declaration.

  // ── Initialize shipment statuses from query data ──────────────

  const dataSelector = useMemo(() => createDataSelector<OrderListItem>("orders"), []);

  // ── Columns ───────────────────────────────────────────────────

  const columns = useMemo(
    () =>
      getOrderColumns({
        showTrashed,
        symbol,
        shipmentStatuses,
        updatingStatusIds,
        onEdit: handleEdit,
        onArchive: handleArchive,
        onRestore: handleRestore,
        onStatusUpdate: handleStatusUpdate,
        onShipmentStatusUpdated: handleShipmentStatusUpdated,
        orderActions,
      }),
    [
      showTrashed,
      symbol,
      shipmentStatuses,
      updatingStatusIds,
      handleEdit,
      handleArchive,
      handleRestore,
      handleStatusUpdate,
      handleShipmentStatusUpdated,
      orderActions,
    ],
  );

  // ── Server table ──────────────────────────────────────────────

  const {
    table,
    rawData: ordersRawData,
    error: rawOrdersError,
    isError: isOrdersError,
    isFetching,
    isLoading,
    refetch: refetchOrders,
    pagination,
    selectedIds,
    clearSelection,
    deselectIds,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions(mapParams(search)),
    dataSelector,
    currentPage: search.page,
    currentLimit: search.limit,
    currentSort: search.sort === "relevance" ? undefined : search.sort,
    currentOrder: search.order,
    onPaginationChange,
    onSortingChange,
    defaultPageSize: 10,
  });
  const ordersError = isOrdersError ? rawOrdersError : null;
  const selectedPaymentRecoveryOrders = useMemo(
    () => {
      const selectedOrderIds = new Set(selectedIds);
      return table
        .getRowModel()
        .rows.map((row) => row.original)
        .filter((order) => selectedOrderIds.has(order.id) && hasPaymentRecoveryState(order));
    },
    [selectedIds, table],
  );
  const selectedActivePaymentSetupOrders = useMemo(
    () => {
      const selectedOrderIds = new Set(selectedIds);
      return table
        .getRowModel()
        .rows.map((row) => row.original)
        .filter((order) => selectedOrderIds.has(order.id) && hasActivePaymentSetup(order));
    },
    [selectedIds, table],
  );
  const selectedActiveRefundOrders = useMemo(
    () => {
      const selectedOrderIds = new Set(selectedIds);
      return table
        .getRowModel()
        .rows.map((row) => row.original)
        .filter((order) => selectedOrderIds.has(order.id) && hasActiveRefundOperation(order));
    },
    [selectedIds, table],
  );
  const selectedShipmentLockedOrders = useMemo(
    () => {
      const selectedOrderIds = new Set(selectedIds);
      return table
        .getRowModel()
        .rows.map((row) => row.original)
        .filter((order) => selectedOrderIds.has(order.id) && hasActiveShipmentLock(order));
    },
    [selectedIds, table],
  );
  const selectedArchiveBlockedOrders = useMemo(
    () => {
      const selectedOrderIds = new Set(selectedIds);
      return table
        .getRowModel()
        .rows.map((row) => row.original)
        .filter((order) =>
          selectedOrderIds.has(order.id) && !isOrderArchiveStatusEligible(order.status));
    },
    [selectedIds, table],
  );
  const selectedArchiveRequests = useMemo(() => {
    const selectedOrderIds = new Set(selectedIds);
    return table
      .getRowModel()
      .rows.map((row) => row.original)
      .filter((order) => selectedOrderIds.has(order.id))
      .map((order) => ({ id: order.id, expectedVersion: order.version }));
  }, [selectedIds, table]);
  const archiveActivePaymentSetupCount = isBulkArchiveOpen
    ? selectedActivePaymentSetupOrders.length
    : orderToArchive
      ? table
          .getRowModel()
          .rows.some((row) => row.original.id === orderToArchive.id && hasActivePaymentSetup(row.original))
        ? 1
        : 0
      : 0;
  const archiveActiveRefundCount = isBulkArchiveOpen
    ? selectedActiveRefundOrders.length
    : orderToArchive
      ? table
          .getRowModel()
          .rows.some((row) => row.original.id === orderToArchive.id && hasActiveRefundOperation(row.original))
        ? 1
        : 0
      : 0;
  const archiveShipmentLockCount = isBulkArchiveOpen
    ? selectedShipmentLockedOrders.length
    : orderToArchive
      ? table
          .getRowModel()
          .rows.some((row) => row.original.id === orderToArchive.id && hasActiveShipmentLock(row.original))
        ? 1
        : 0
      : 0;
  const archiveStatusBlockedCount = isBulkArchiveOpen
    ? selectedArchiveBlockedOrders.length
    : orderToArchive
      ? table
          .getRowModel()
          .rows.some((row) =>
            row.original.id === orderToArchive.id
            && !isOrderArchiveStatusEligible(row.original.status))
        ? 1
        : 0
      : 0;

  // ── Active-query refresh ──────────────────────────────────────

  useEffect(() => {
    activeOrderListRefreshRef.current = refetchOrders;
  }, [refetchOrders]);

  useEffect(() => {
    orderListFetchingRef.current = isFetching;
  }, [isFetching]);

  const refreshActiveOrderList = useCallback(() => {
    const refetchActiveOrders = activeOrderListRefreshRef.current;
    if (!refetchActiveOrders || isDocumentHidden()) return false;
    if (orderListFetchingRef.current || orderListRefreshInFlightRef.current) {
      return false;
    }

    const now = Date.now();
    if (now - lastOrderListRefreshAtRef.current < ORDER_AUTO_REFRESH_DEBOUNCE_MS) {
      return false;
    }

    lastOrderListRefreshAtRef.current = now;
    orderListRefreshInFlightRef.current = true;
    try {
      void Promise.resolve(refetchActiveOrders()).finally(() => {
        orderListRefreshInFlightRef.current = false;
      });
    } catch (error) {
      orderListRefreshInFlightRef.current = false;
      console.warn("Failed to start active order list refresh", error);
      return false;
    }
    return true;
  }, []);

  // ── Auto-refresh ──────────────────────────────────────────────

  const toggleAutoRefresh = useCallback(() => {
    const newValue = !autoRefreshEnabled;
    setAutoRefreshEnabled(newValue);
    if (typeof window !== "undefined") {
      localStorage.setItem("orderlist-auto-refresh", String(newValue));
    }
    if (newValue) {
      refreshActiveOrderList();
      setCountdown(ORDER_AUTO_REFRESH_SECONDS);
    }
  }, [autoRefreshEnabled, refreshActiveOrderList]);

  useEffect(() => {
    if (autoRefreshEnabled) {
      setCountdown(ORDER_AUTO_REFRESH_SECONDS);
      countdownIntervalRef.current = window.setInterval(() => {
        if (isDocumentHidden()) return;
        setCountdown((prev) => {
          if (prev <= 1) {
            refreshActiveOrderList();
            return ORDER_AUTO_REFRESH_SECONDS;
          }
          return prev - 1;
        });
      }, 1000);

      const handleVisibilityChange = () => {
        if (isDocumentHidden()) return;
        refreshActiveOrderList();
        setCountdown(ORDER_AUTO_REFRESH_SECONDS);
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        if (countdownIntervalRef.current)
          window.clearInterval(countdownIntervalRef.current);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
    } else {
      if (countdownIntervalRef.current)
        window.clearInterval(countdownIntervalRef.current);
    }
  }, [autoRefreshEnabled, refreshActiveOrderList]);

  useEffect(() => {
    if (!ordersRawData) return;
    const canonicalPage = getCanonicalPageForPagination(search.page, pagination);
    if (canonicalPage === search.page) return;
    handleNavigate({ page: canonicalPage });
  }, [handleNavigate, ordersRawData, pagination, search.page]);

  // ── Export CSV ─────────────────────────────────────────────────

  const handleExportCSV = useCallback(async () => {
    const recoveryExportParams = buildRecoveryExportSearchParams(search);
    if (recoveryExportParams) {
      try {
        const response = await fetch(
          `/api/v1/admin/orders/payment-recovery/export?${recoveryExportParams.toString()}`,
        );
        if (!response.ok) {
          throw new Error(`Export failed with ${response.status}`);
        }
        const blob = await response.blob();
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute(
          "download",
          `payment-recovery-${new Date().toISOString().split("T")[0]}.csv`,
        );
        link.style.visibility = "hidden";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        const rowCount = response.headers.get("X-Export-Row-Count");
        const limited = response.headers.get("X-Export-Limited") === "true";
        toast.success(
          `${rowCount ?? "Recovery"} order${rowCount === "1" ? "" : "s"} exported.`,
          limited
            ? { description: "The CSV was capped. Narrow the filter to export fewer rows." }
            : undefined,
        );
      } catch {
        toast.error("Payment recovery export failed.");
      }
      return;
    }

    const rows = table.getRowModel().rows.map((r) => r.original);
    const csvHeaders = [
      "Order ID",
      "Customer Name",
      "Phone",
      "Email",
      "City",
      "Zone",
      "Area",
      "Status",
      "Payment Status",
      "Payment Method",
      "Payment Recovery",
      "Recovery Gateway",
      "Recovery Status",
      "Recovery Attempts",
      "Shipment Recovery",
      "Shipment Recovery Status",
      "Fulfillment Status",
      "Total Amount",
      "Discount",
      "Items",
      "Created At",
    ];
    const csvRows = rows.map((order) => [
      order.id,
      order.customerName,
      formatPhoneForDisplay(order.customerPhone),
      order.customerEmail || "",
      order.cityName || order.city,
      order.zoneName || order.zone,
      order.areaName || order.area || "",
      order.status,
      order.paymentStatus,
      order.paymentMethod,
      order.paymentRecovery?.state === "none" ? "" : (order.paymentRecovery?.label ?? ""),
      order.paymentRecovery?.gateway ?? "",
      order.paymentRecovery?.status ?? "",
      order.paymentRecovery?.attempts ?? 0,
      order.shipmentRecovery?.state === "none" ? "" : (order.shipmentRecovery?.label ?? ""),
      order.shipmentRecovery?.status ?? "",
      order.fulfillmentStatus,
      order.totalAmount,
      order.discountAmount || 0,
      order.itemCount,
      formatDateShort(order.createdAt),
    ]);
    const csvContent = [
      csvHeaders.join(","),
      ...csvRows.map((row) =>
        row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
      ),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `orders-${new Date().toISOString().split("T")[0]}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`${rows.length} orders from this page exported.`);
  }, [search, table]);

  // ── Bulk archive handler (after useServerTable for selected revisions) ──
  const handleBulkArchiveConfirm = useCallback(() => {
    if (!orderActions.canBulkDeleteOrders) {
      toast.error("Bulk archive unavailable", {
        description: "Your role can view orders but cannot archive them.",
      });
      return;
    }
    if (selectedArchiveBlockedOrders.length > 0) {
      toast.error("Finish orders before archiving", {
        description: `${selectedArchiveBlockedOrders.length} selected order(s) still have operational work.`,
      });
      return;
    }
    if (selectedActiveRefundOrders.length > 0) {
      toast.error("Resolve refund recovery first", {
        description: `${selectedActiveRefundOrders.length} selected order(s) still have active refund recovery.`,
      });
      return;
    }
    if (selectedShipmentLockedOrders.length > 0) {
      toast.error("Resolve shipment recovery first", {
        description: `${selectedShipmentLockedOrders.length} selected order(s) still have active shipment recovery.`,
      });
      return;
    }
    if (selectedActivePaymentSetupOrders.length > 0) {
      toast.error("Wait for payment setup first", {
        description: `${selectedActivePaymentSetupOrders.length} selected order(s) still have active hosted payment setup.`,
      });
      return;
    }
    archiveMut.mutate(
      { orders: selectedArchiveRequests },
      {
        onSuccess: () => {
          clearSelection();
          setIsBulkArchiveOpen(false);
        },
        onSettled: () => {
          setIsBulkArchiveOpen(false);
        },
      },
    );
  }, [
    archiveMut,
    selectedArchiveRequests,
    clearSelection,
    orderActions.canBulkDeleteOrders,
    selectedArchiveBlockedOrders,
    selectedActiveRefundOrders,
    selectedShipmentLockedOrders,
    selectedActivePaymentSetupOrders,
  ]);

  // ── Bulk shipment handler (after useServerTable for selectedIds/clearSelection) ──
  const handleBulkShipmentSubmit = useCallback(
    async (providerId: string) => {
      if (isShipping || selectedIds.length === 0) return;
      if (!orderActions.canBulkShipOrders) {
        toast.error("Shipping unavailable", {
          description: "Your role can view orders but cannot manage shipments.",
        });
        return;
      }
      if (selectedActivePaymentSetupOrders.length > 0) {
        toast.error("Wait for payment setup first", {
          description: `${selectedActivePaymentSetupOrders.length} selected order(s) still have active hosted payment setup.`,
        });
        return;
      }
      if (selectedPaymentRecoveryOrders.length > 0) {
        toast.error("Resolve payment recovery first", {
          description: `${selectedPaymentRecoveryOrders.length} selected order(s) still have hosted payment state.`,
        });
        return;
      }
      if (selectedActiveRefundOrders.length > 0) {
        toast.error("Resolve refund recovery first", {
          description: `${selectedActiveRefundOrders.length} selected order(s) still have active refund recovery.`,
        });
        return;
      }
      if (selectedShipmentLockedOrders.length > 0) {
        toast.error("Resolve shipment recovery first", {
          description: `${selectedShipmentLockedOrders.length} selected order(s) still have active shipment recovery.`,
        });
        return;
      }
      setLastBulkShipResult(null);
      setIsShipping(true);
      const orderIds = [...selectedIds];
      try {
        const result = await bulkShipMut.mutateAsync({
          orderIds,
          providerId,
          options: {},
        });
        const shippedOrderIds = result.results
          .filter((item) => item.success)
          .map((item) => item.orderId);
        const failedOrderIds = result.results
          .filter((item) => !item.success)
          .map((item) => item.orderId);
        if (result.successCount === orderIds.length) {
          setLastBulkShipResult(null);
          clearSelection();
          setIsShippingDialogOpen(false);
        } else if (failedOrderIds.length < orderIds.length) {
          setLastBulkShipResult(buildBulkShipResultSummary(result));
          deselectIds(shippedOrderIds);
        } else {
          setLastBulkShipResult(buildBulkShipResultSummary(result));
        }
      } catch {
        setLastBulkShipResult(buildFailedBulkShipResultSummary(orderIds));
      } finally {
        setIsShipping(false);
      }
    },
    [
      selectedIds,
      clearSelection,
      deselectIds,
      isShipping,
      bulkShipMut,
      orderActions.canBulkShipOrders,
      selectedPaymentRecoveryOrders,
      selectedActivePaymentSetupOrders,
      selectedActiveRefundOrders,
      selectedShipmentLockedOrders,
    ],
  );

  // ── Sync shipment statuses when data changes ──────────────────
  useEffect(() => {
    if (!ordersRawData) return;
    const r = ordersRawData as Record<string, unknown>;
    const orders = (r.orders ?? []) as OrderListItem[];
    const newStatuses: Record<string, ShipmentStatus> = {};
    orders.forEach((order) => {
      if (order.latestShipment) {
        newStatuses[order.id] =
          order.latestShipment as unknown as ShipmentStatus;
      }
    });
    setShipmentStatuses(newStatuses);
  }, [ordersRawData]);

  // ── Mobile card renderer ──────────────────────────────────────

  const mobileCardRenderer = useCallback(
    (row: Row<OrderListItem>) => {
      const order = row.original;
      const shipment = shipmentStatuses[order.id];
      return (
        <OrderMobileCard
          order={order}
          shipment={shipment}
          isSelected={row.getIsSelected()}
          isUpdatingStatus={updatingStatusIds.has(order.id)}
          showTrashed={showTrashed}
          onToggleSelection={(id) => {
            const r = table.getRowModel().rows.find((r) => r.original.id === id);
            if (r) r.toggleSelected(!r.getIsSelected());
          }}
          onEdit={handleEdit}
          onArchive={handleArchive}
          onRestore={handleRestore}
          onStatusUpdate={handleStatusUpdate}
          onShipmentStatusUpdated={handleShipmentStatusUpdated}
          orderActions={orderActions}
        />
      );
    },
    [
      shipmentStatuses,
      updatingStatusIds,
      showTrashed,
      table,
      handleEdit,
      handleArchive,
      handleRestore,
      handleStatusUpdate,
      handleShipmentStatusUpdated,
      orderActions,
    ],
  );

  // ── Toolbar ───────────────────────────────────────────────────

  const toolbar = (
    <OrderToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      selectedCount={selectedIds.length}
      showTrashed={showTrashed}
      activeStatus={activeStatus}
      onStatusFilterChange={onStatusFilterChange}
      activePaymentStatus={activePaymentStatus}
      onPaymentStatusFilterChange={onPaymentStatusFilterChange}
      activePaymentMethod={activePaymentMethod}
      onPaymentMethodFilterChange={onPaymentMethodFilterChange}
      activeFulfillmentStatus={activeFulfillmentStatus}
      onFulfillmentStatusFilterChange={onFulfillmentStatusFilterChange}
      activePaymentRecovery={activePaymentRecovery}
      onPaymentRecoveryFilterChange={onPaymentRecoveryFilterChange}
      dateRange={dateRange}
      onDateRangeChange={onDateRangeChange}
      onBulkArchive={handleBulkArchiveClick}
      onBulkShip={() => {
        if (isShipping || selectedIds.length === 0) return;
        if (!orderActions.canBulkShipOrders) {
          toast.error("Shipping unavailable", {
            description: "Your role can view orders but cannot manage shipments.",
          });
          return;
        }
        if (selectedActivePaymentSetupOrders.length > 0) {
          toast.error("Wait for payment setup first", {
            description: `${selectedActivePaymentSetupOrders.length} selected order(s) still have active hosted payment setup.`,
          });
          return;
        }
        if (selectedPaymentRecoveryOrders.length > 0) {
          toast.error("Resolve payment recovery first", {
            description: `${selectedPaymentRecoveryOrders.length} selected order(s) still have hosted payment state.`,
          });
          return;
        }
        if (selectedActiveRefundOrders.length > 0) {
          toast.error("Resolve refund recovery first", {
            description: `${selectedActiveRefundOrders.length} selected order(s) still have active refund recovery.`,
          });
          return;
        }
        if (selectedShipmentLockedOrders.length > 0) {
          toast.error("Resolve shipment recovery first", {
            description: `${selectedShipmentLockedOrders.length} selected order(s) still have active shipment recovery.`,
          });
          return;
        }
        setLastBulkShipResult(null);
        setIsShippingDialogOpen(true);
      }}
      isBulkActionBusy={isShipping || archiveMut.isPending}
      selectedPaymentRecoveryCount={selectedPaymentRecoveryOrders.length}
      selectedActivePaymentSetupCount={selectedActivePaymentSetupOrders.length}
      selectedActiveRefundCount={selectedActiveRefundOrders.length}
      selectedShipmentLockCount={selectedShipmentLockedOrders.length}
      selectedArchiveBlockedCount={selectedArchiveBlockedOrders.length}
      onExportCSV={handleExportCSV}
      exportLabel={
        buildRecoveryExportSearchParams(search)
          ? "Export recovery CSV"
          : "Export current page"
      }
      autoRefreshEnabled={autoRefreshEnabled}
      onToggleAutoRefresh={toggleAutoRefresh}
      countdown={countdown}
      orderActions={orderActions}
    />
  );

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
      <Card className="overflow-hidden border border-border bg-card shadow-sm backdrop-blur-xl">
        <CardHeader className="space-y-1 pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-xl font-bold tracking-tight text-foreground">
              {showTrashed ? "Archived Orders" : "Orders"}
            </CardTitle>
            {!showTrashed && (
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                {pagination.total}{" "}
                {pagination.total === 1 ? "order" : "orders"}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0 px-4 sm:px-6 pb-4">
          <DataTable
            table={table}
            isFetching={isFetching}
            isLoading={isLoading}
            error={ordersError}
            onRetry={() => {
              void refetchOrders();
            }}
            toolbar={toolbar}
            itemLabel="orders"
            pageSizeOptions={[10, 20, 50, 100]}
            mobileCardRenderer={mobileCardRenderer}
            emptyState={{
              icon: ShoppingBag,
              title: showTrashed
                ? "No archived orders"
                : hasActiveFilters
                  ? "No orders found"
                  : "No orders found",
              description: showTrashed
                ? "Completed or cancelled orders you archive will appear here"
                : hasActiveFilters
                  ? "Try adjusting your search or filters"
                  : "New orders will appear here",
            }}
          />
        </CardContent>
      </Card>

      {/* Archive confirmation */}
      {isArchiveDialogOpen && (
        <Suspense fallback={null}>
          <ArchiveOrderDialog
            isOpen={isArchiveDialogOpen}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOrderToArchive(null);
                setIsBulkArchiveOpen(false);
              }
            }}
            isArchiving={archiveMut.isPending}
            onConfirm={isBulkArchiveOpen ? handleBulkArchiveConfirm : handleSingleArchive}
            isBulk={isBulkArchiveOpen}
            itemCount={selectedIds.length}
            activePaymentSetupCount={archiveActivePaymentSetupCount}
            activeRefundCount={archiveActiveRefundCount}
            shipmentLockCount={archiveShipmentLockCount}
            statusBlockedCount={archiveStatusBlockedCount}
          />
        </Suspense>
      )}

      {/* Bulk ship dialog */}
      {(isShippingDialogOpen || isShipping) && (
        <Suspense fallback={null}>
          <BulkShipDialog
            isOpen={isShippingDialogOpen}
            onOpenChange={(isOpen) => {
              if (isShipping && !isOpen) return;
              setIsShippingDialogOpen(isOpen);
            }}
            isShipping={isShipping}
            onConfirm={handleBulkShipmentSubmit}
            itemCount={selectedIds.length}
            resultSummary={lastBulkShipResult}
          />
        </Suspense>
      )}
    </>
  );
}
