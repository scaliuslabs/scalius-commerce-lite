import React from "react";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { DateRange } from "react-day-picker";

export type SortField =
  | "customerName"
  | "totalAmount"
  | "status"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface OrderListPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ShipmentStatus {
  id: string;
  orderId: string;
  [key: string]: unknown;
}

export interface UseOrderListStateReturn {
  displayOrders: OrderListItem[];
  setDisplayOrders: React.Dispatch<React.SetStateAction<OrderListItem[]>>;
  currentPagination: OrderListPagination;
  setCurrentPagination: React.Dispatch<React.SetStateAction<OrderListPagination>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  sort: { field: SortField; order: SortOrder };
  setSort: React.Dispatch<React.SetStateAction<{ field: SortField; order: SortOrder }>>;
  selectedOrders: Set<string>;
  setSelectedOrders: React.Dispatch<React.SetStateAction<Set<string>>>;
  lastSelectedId: string | null;
  setLastSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  activeStatus: string | null;
  setActiveStatus: React.Dispatch<React.SetStateAction<string | null>>;
  paymentStatus: string | null;
  setPaymentStatus: React.Dispatch<React.SetStateAction<string | null>>;
  paymentMethod: string | null;
  setPaymentMethod: React.Dispatch<React.SetStateAction<string | null>>;
  fulfillmentStatus: string | null;
  setFulfillmentStatus: React.Dispatch<React.SetStateAction<string | null>>;
  shipmentStatuses: Record<string, ShipmentStatus>;
  setShipmentStatuses: React.Dispatch<React.SetStateAction<Record<string, ShipmentStatus>>>;
  dateRange: DateRange | undefined;
  setDateRange: React.Dispatch<React.SetStateAction<DateRange | undefined>>;
  updatingStatusIds: Set<string>;
  setUpdatingStatusIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  isDeleting: boolean;
  setIsDeleting: React.Dispatch<React.SetStateAction<boolean>>;
  isShipping: boolean;
  setIsShipping: React.Dispatch<React.SetStateAction<boolean>>;
  isLoadingOrders: boolean;
  setIsLoadingOrders: React.Dispatch<React.SetStateAction<boolean>>;
  orderToDelete: string | null;
  setOrderToDelete: React.Dispatch<React.SetStateAction<string | null>>;
  isBulkDeleteOpen: boolean;
  setIsBulkDeleteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isShippingDialogOpen: boolean;
  setIsShippingDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useOrderListState(
  orders: OrderListItem[],
  pagination: OrderListPagination,
  initialSearchQuery: string,
  initialSort: { field: SortField; order: SortOrder },
): UseOrderListStateReturn {
  const [displayOrders, setDisplayOrders] =
    React.useState<OrderListItem[]>(orders);
  const [currentPagination, setCurrentPagination] =
    React.useState(pagination);
  const [searchQuery, setSearchQuery] = React.useState(initialSearchQuery);
  const [sort, setSort] = React.useState(initialSort);
  const [selectedOrders, setSelectedOrders] = React.useState<Set<string>>(
    new Set(),
  );
  const [lastSelectedId, setLastSelectedId] = React.useState<string | null>(
    null,
  );
  const [activeStatus, setActiveStatus] = React.useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = React.useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = React.useState<string | null>(null);
  const [fulfillmentStatus, setFulfillmentStatus] = React.useState<string | null>(null);
  const [shipmentStatuses, setShipmentStatuses] = React.useState<
    Record<string, ShipmentStatus>
  >({});
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>(
    undefined,
  );
  const [updatingStatusIds, setUpdatingStatusIds] = React.useState<Set<string>>(
    new Set(),
  );
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isShipping, setIsShipping] = React.useState(false);
  const [isLoadingOrders, setIsLoadingOrders] = React.useState(false);
  const [orderToDelete, setOrderToDelete] = React.useState<string | null>(null);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = React.useState(false);
  const [isShippingDialogOpen, setIsShippingDialogOpen] = React.useState(false);

  // Sync props to state
  React.useEffect(() => {
    setDisplayOrders(orders);
  }, [orders]);

  React.useEffect(() => {
    setCurrentPagination(pagination);
  }, [pagination]);

  // Initialize URL-based filters
  React.useEffect(() => {
    const url = new URL(window.location.href);
    setActiveStatus(url.searchParams.get("status"));
    setPaymentStatus(url.searchParams.get("paymentStatus"));
    setPaymentMethod(url.searchParams.get("paymentMethod"));
    setFulfillmentStatus(url.searchParams.get("fulfillmentStatus"));
    const sortField = url.searchParams.get("sort") as SortField | null;
    const sortOrder = url.searchParams.get("order") as SortOrder | null;
    if (sortField && sortOrder) {
      setSort({ field: sortField, order: sortOrder });
    }
  }, []);

  // Prune selection when displayOrders changes
  React.useEffect(() => {
    const currentOrderIds = new Set(displayOrders.map((o) => o.id));
    setSelectedOrders((prev) => {
      const newSelection = new Set<string>();
      prev.forEach((id) => {
        if (currentOrderIds.has(id)) {
          newSelection.add(id);
        }
      });
      return newSelection;
    });
  }, [displayOrders]);

  // Initialize shipment statuses from orders
  React.useEffect(() => {
    const initialShipmentStatuses: Record<string, ShipmentStatus> = {};
    orders.forEach((order) => {
      if (order.latestShipment) {
        initialShipmentStatuses[order.id] = order.latestShipment as unknown as ShipmentStatus;
      }
    });
    setShipmentStatuses(initialShipmentStatuses);
  }, [orders]);

  return {
    displayOrders,
    setDisplayOrders,
    currentPagination,
    setCurrentPagination,
    searchQuery,
    setSearchQuery,
    sort,
    setSort,
    selectedOrders,
    setSelectedOrders,
    lastSelectedId,
    setLastSelectedId,
    activeStatus,
    setActiveStatus,
    paymentStatus,
    setPaymentStatus,
    paymentMethod,
    setPaymentMethod,
    fulfillmentStatus,
    setFulfillmentStatus,
    shipmentStatuses,
    setShipmentStatuses,
    dateRange,
    setDateRange,
    updatingStatusIds,
    setUpdatingStatusIds,
    isDeleting,
    setIsDeleting,
    isShipping,
    setIsShipping,
    isLoadingOrders,
    setIsLoadingOrders,
    orderToDelete,
    setOrderToDelete,
    isBulkDeleteOpen,
    setIsBulkDeleteOpen,
    isShippingDialogOpen,
    setIsShippingDialogOpen,
  };
}
