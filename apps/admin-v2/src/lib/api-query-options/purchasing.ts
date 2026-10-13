// Purchasing (migration 0109): suppliers, purchase orders and transfers
// between locations. One key tree (`purchasingKeys`) holds every list and
// document; a write refreshes it, and a write that moves or promises stock
// (ordering, receiving, shipping, cancelling) also refreshes the inventory
// lists and the per-location numbers it changes.
import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId,
  deleteApiV1AdminInventoryTransfersByTransferId,
  getApiV1AdminInventoryPurchaseOrders,
  getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId,
  getApiV1AdminInventorySuppliers,
  getApiV1AdminInventorySuppliersBySupplierId,
  getApiV1AdminInventoryTransfers,
  getApiV1AdminInventoryTransfersByTransferId,
  patchApiV1AdminInventorySuppliersBySupplierId,
  postApiV1AdminInventoryPurchaseOrders,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdCancel,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdOrder,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive,
  postApiV1AdminInventorySuppliers,
  postApiV1AdminInventorySuppliersBySupplierIdArchive,
  postApiV1AdminInventorySuppliersBySupplierIdUnarchive,
  postApiV1AdminInventoryTransfers,
  postApiV1AdminInventoryTransfersByTransferIdCancel,
  postApiV1AdminInventoryTransfersByTransferIdReceive,
  postApiV1AdminInventoryTransfersByTransferIdShip,
  putApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId,
  putApiV1AdminInventoryTransfersByTransferId,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import { inventoryLocationKeys } from "./inventory-locations";
import { announceSave, presenceKey } from "../realtime/store";

/** A purchase order or transfer holds at most this many SKUs (the API's limit). */
export const PURCHASING_MAX_LINES = 100;
/** The largest quantity one line takes (the API's limit). */
export const PURCHASING_MAX_QUANTITY = 1_000_000;

export type SupplierListQuery = ApiQuery<typeof getApiV1AdminInventorySuppliers>;
export type Supplier = ApiResult<typeof getApiV1AdminInventorySuppliers>["suppliers"][number];
export type SupplierBody = ApiBody<typeof postApiV1AdminInventorySuppliers>;

export type PurchaseOrderListQuery = ApiQuery<typeof getApiV1AdminInventoryPurchaseOrders>;
export type PurchaseOrderSummary = ApiResult<typeof getApiV1AdminInventoryPurchaseOrders>["purchaseOrders"][number];
export type PurchaseOrder = ApiResult<typeof getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId>;
export type PurchaseOrderLine = PurchaseOrder["lines"][number];
export type PurchaseOrderReceipt = PurchaseOrder["receipts"][number];
export type PurchaseOrderStatus = PurchaseOrder["status"];
export type PurchaseOrderBody = ApiBody<typeof postApiV1AdminInventoryPurchaseOrders>;
export type PurchaseOrderReceiveBody = ApiBody<typeof postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive>;

export type TransferListQuery = ApiQuery<typeof getApiV1AdminInventoryTransfers>;
export type TransferSummary = ApiResult<typeof getApiV1AdminInventoryTransfers>["transfers"][number];
export type Transfer = ApiResult<typeof getApiV1AdminInventoryTransfersByTransferId>;
export type TransferLine = Transfer["lines"][number];
export type TransferActivity = Transfer["activity"][number];
export type TransferStatus = Transfer["status"];
export type TransferBody = ApiBody<typeof postApiV1AdminInventoryTransfers>;

export const purchasingKeys = {
  all: ["purchasing"] as const,
  suppliers: () => [...purchasingKeys.all, "suppliers"] as const,
  supplierList: (query: SupplierListQuery) => [...purchasingKeys.suppliers(), "list", query] as const,
  supplier: (id: string) => [...purchasingKeys.suppliers(), "detail", id] as const,
  purchaseOrders: () => [...purchasingKeys.all, "purchase-orders"] as const,
  purchaseOrderList: (query: PurchaseOrderListQuery) => [...purchasingKeys.purchaseOrders(), "list", query] as const,
  purchaseOrder: (id: string) => [...purchasingKeys.purchaseOrders(), "detail", id] as const,
  transfers: () => [...purchasingKeys.all, "transfers"] as const,
  transferList: (query: TransferListQuery) => [...purchasingKeys.transfers(), "list", query] as const,
  transfer: (id: string) => [...purchasingKeys.transfers(), "detail", id] as const,
};

const LIST_STALE_MS = 30_000;

export const suppliersQueryOptions = (query: SupplierListQuery) =>
  queryOptions({
    queryKey: purchasingKeys.supplierList(query),
    queryFn: () => apiData(getApiV1AdminInventorySuppliers({ query })),
    staleTime: LIST_STALE_MS,
  });

export const supplierQueryOptions = (id: string) =>
  queryOptions({
    queryKey: purchasingKeys.supplier(id),
    queryFn: () => apiData(getApiV1AdminInventorySuppliersBySupplierId({ path: { supplierId: id } })),
    staleTime: LIST_STALE_MS,
  });

export const purchaseOrdersQueryOptions = (query: PurchaseOrderListQuery) =>
  queryOptions({
    queryKey: purchasingKeys.purchaseOrderList(query),
    queryFn: () => apiData(getApiV1AdminInventoryPurchaseOrders({ query })),
    staleTime: LIST_STALE_MS,
  });

/** One purchase order: always read fresh, since receiving changes it from any device. */
export const purchaseOrderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: purchasingKeys.purchaseOrder(id),
    queryFn: () => apiData(getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId({ path: { purchaseOrderId: id } })),
    staleTime: 0,
  });

export const transfersQueryOptions = (query: TransferListQuery) =>
  queryOptions({
    queryKey: purchasingKeys.transferList(query),
    queryFn: () => apiData(getApiV1AdminInventoryTransfers({ query })),
    staleTime: LIST_STALE_MS,
  });

export const transferQueryOptions = (id: string) =>
  queryOptions({
    queryKey: purchasingKeys.transfer(id),
    queryFn: () => apiData(getApiV1AdminInventoryTransfersByTransferId({ path: { transferId: id } })),
    staleTime: 0,
  });

/** Stock moved or was promised: the inventory lists and per-location numbers change too. */
function refreshStock(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all }),
    queryClient.invalidateQueries({ queryKey: inventoryLocationKeys.all }),
  ]);
}

/**
 * After a document write: its lists and suppliers (open purchase order
 * counts) refresh; the document itself takes the returned copy when the API
 * sends one, else it is read again.
 */
function refreshDocuments(
  queryClient: QueryClient,
  kind: "purchaseOrder" | "transfer",
  id: string | null,
  stock: boolean,
) {
  const group = kind === "purchaseOrder" ? purchasingKeys.purchaseOrders() : purchasingKeys.transfers();
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [...group, "list"] }),
    ...(kind === "purchaseOrder" ? [queryClient.invalidateQueries({ queryKey: purchasingKeys.suppliers() })] : []),
    ...(id ? [queryClient.invalidateQueries({ queryKey: kind === "purchaseOrder" ? purchasingKeys.purchaseOrder(id) : purchasingKeys.transfer(id) })] : []),
    ...(stock ? [refreshStock(queryClient)] : []),
  ]);
}

// ─── Suppliers ──────────────────────────────────────────────────────────

export function useSaveSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string | null; version: number | null; body: SupplierBody }) =>
      input.id
        ? apiData(patchApiV1AdminInventorySuppliersBySupplierId({
          path: { supplierId: input.id },
          body: { ...input.body, expectedVersion: input.version ?? 1 },
        }))
        : apiData(postApiV1AdminInventorySuppliers({ body: input.body })),
    onSuccess: (supplier, input) => {
      if (input.id) announceSave(presenceKey("supplier", input.id), supplier.version);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: purchasingKeys.suppliers() }),
      // Purchase orders show their supplier's name.
      queryClient.invalidateQueries({ queryKey: purchasingKeys.purchaseOrders() }),
    ]),
  });
}

export function useSupplierAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: "archive" | "unarchive" }) => {
      const options = { path: { supplierId: input.id } };
      return apiData(input.action === "archive"
        ? postApiV1AdminInventorySuppliersBySupplierIdArchive(options)
        : postApiV1AdminInventorySuppliersBySupplierIdUnarchive(options));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: purchasingKeys.suppliers() }),
  });
}

// ─── Purchase orders ────────────────────────────────────────────────────

/** Creates a draft (no id) or saves one (every field; `lines` only while it is a draft). */
export function useSavePurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string | null; revision: number | null; body: PurchaseOrderBody }) =>
      input.id
        ? apiData(putApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId({
          path: { purchaseOrderId: input.id },
          body: { ...input.body, expectedRevision: input.revision ?? 1 },
        }))
        : apiData(postApiV1AdminInventoryPurchaseOrders({ body: input.body })),
    onSuccess: (order, input) => {
      queryClient.setQueryData(purchasingKeys.purchaseOrder(order.id), order);
      if (input.id) announceSave(presenceKey("purchase-order", order.id), order.revision);
    },
    onSettled: () => refreshDocuments(queryClient, "purchaseOrder", null, false),
  });
}

/** Mark as ordered or cancel: a status change at the revision the merchant saw. */
export function usePurchaseOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; revision: number; action: "order" | "cancel" }) => {
      const options = { path: { purchaseOrderId: input.id }, body: { expectedRevision: input.revision } };
      return apiData(input.action === "order"
        ? postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdOrder(options)
        : postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdCancel(options));
    },
    onSuccess: (order) => {
      queryClient.setQueryData(purchasingKeys.purchaseOrder(order.id), order);
      announceSave(presenceKey("purchase-order", order.id), order.revision);
    },
    // Ordered lines are incoming stock; cancelling stops them.
    onSettled: () => refreshDocuments(queryClient, "purchaseOrder", null, true),
  });
}

export function useDeletePurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; revision: number }) =>
      apiData(deleteApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId({
        path: { purchaseOrderId: input.id },
        query: { expectedRevision: input.revision },
      })),
    onSuccess: (_result, input) => queryClient.removeQueries({ queryKey: purchasingKeys.purchaseOrder(input.id), exact: true }),
    onSettled: () => refreshDocuments(queryClient, "purchaseOrder", null, false),
  });
}

/** Books received units under one operation key; the same key replays a retry. */
export function useReceivePurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; operationKey: string; body: Omit<PurchaseOrderReceiveBody, "operationKey"> }) =>
      apiData(postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive({
        path: { purchaseOrderId: input.id },
        body: { ...input.body, operationKey: input.operationKey },
      })),
    onSuccess: (receipt, input) => announceSave(presenceKey("purchase-order", input.id), receipt.revision),
    // After a failure the page keeps what it showed, so a retry sends the same intent (and key);
    // a receipt that did land then replays instead of counting twice.
    onSettled: (_result, error, input) => refreshDocuments(queryClient, "purchaseOrder", error ? null : input.id, true),
  });
}

// ─── Transfers ──────────────────────────────────────────────────────────

export function useSaveTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string | null; revision: number | null; body: TransferBody }) =>
      input.id
        ? apiData(putApiV1AdminInventoryTransfersByTransferId({
          path: { transferId: input.id },
          body: { ...input.body, expectedRevision: input.revision ?? 1 },
        }))
        : apiData(postApiV1AdminInventoryTransfers({ body: input.body })),
    onSuccess: (transfer, input) => {
      queryClient.setQueryData(purchasingKeys.transfer(transfer.id), transfer);
      if (input.id) announceSave(presenceKey("transfer", transfer.id), transfer.revision);
    },
    onSettled: () => refreshDocuments(queryClient, "transfer", null, false),
  });
}

export function useDeleteTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; revision: number }) =>
      apiData(deleteApiV1AdminInventoryTransfersByTransferId({
        path: { transferId: input.id },
        query: { expectedRevision: input.revision },
      })),
    onSuccess: (_result, input) => queryClient.removeQueries({ queryKey: purchasingKeys.transfer(input.id), exact: true }),
    onSettled: () => refreshDocuments(queryClient, "transfer", null, false),
  });
}

/** Ship or cancel: a stock command at the revision the merchant saw, under one operation key. */
export function useTransferCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; revision: number; operationKey: string; action: "ship" | "cancel" }) => {
      const options = {
        path: { transferId: input.id },
        body: { expectedRevision: input.revision, operationKey: input.operationKey },
      };
      return apiData(input.action === "ship"
        ? postApiV1AdminInventoryTransfersByTransferIdShip(options)
        : postApiV1AdminInventoryTransfersByTransferIdCancel(options));
    },
    onSuccess: (result, input) => announceSave(presenceKey("transfer", input.id), result.revision),
    onSettled: (_result, error, input) => refreshDocuments(queryClient, "transfer", error ? null : input.id, true),
  });
}

export function useReceiveTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; operationKey: string; lines: Array<{ lineId: string; quantity: number }> }) =>
      apiData(postApiV1AdminInventoryTransfersByTransferIdReceive({
        path: { transferId: input.id },
        body: { lines: input.lines, operationKey: input.operationKey },
      })),
    onSuccess: (result, input) => announceSave(presenceKey("transfer", input.id), result.revision),
    onSettled: (_result, error, input) => refreshDocuments(queryClient, "transfer", error ? null : input.id, true),
  });
}
