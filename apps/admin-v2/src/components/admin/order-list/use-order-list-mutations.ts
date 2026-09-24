import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  postApiV1AdminOrdersArchive,
  postApiV1AdminOrdersBulkConfirm,
  postApiV1AdminOrdersBulkFulfill,
  postApiV1AdminOrdersBulkShip,
  postApiV1AdminOrdersByIdRestore,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";
import { chunk, summarizeBulkResults, type OrderBulkOutcome } from "./order-bulk-actions";

/** Orders, their details, the home dashboard and stock all change with these actions. */
function invalidateAfterOrderChange(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
}

/**
 * `requestKey` is made once per dialog opening and reused when the merchant
 * retries: the server replays an order it already handled for that key.
 */
type BulkInput =
  | { action: "confirm"; orderIds: string[]; requestKey: string }
  | { action: "send"; orderIds: string[]; requestKey: string; courierName?: string; note?: string }
  | { action: "ship"; orderIds: string[]; providerId: string };

async function runBulkChunk(input: BulkInput, orderIds: string[]) {
  if (input.action === "confirm") {
    return (await apiData(postApiV1AdminOrdersBulkConfirm({ body: { orderIds, requestKey: input.requestKey } }))).results;
  }
  if (input.action === "send") {
    const body = {
      orderIds,
      requestKey: input.requestKey,
      courierName: input.courierName || undefined,
      note: input.note || undefined,
    };
    return (await apiData(postApiV1AdminOrdersBulkFulfill({ body }))).results;
  }
  const body = { orderIds, providerId: input.providerId, options: {} };
  return (await apiData(postApiV1AdminOrdersBulkShip({ body }))).results;
}

/**
 * Confirm, "Mark as sent" and courier booking for many orders, 90 per request.
 * Resolves with every order's outcome; a request that fails outright reports
 * its orders as not done, and earlier chunks keep their results.
 */
export function useOrderBulkRun() {
  const queryClient = useQueryClient();
  const t = useMessages(orderListMessages);
  return useMutation({
    mutationFn: async (input: BulkInput): Promise<OrderBulkOutcome> => {
      const outcome: OrderBulkOutcome = { succeeded: [], failures: [] };
      for (const orderIds of chunk(input.orderIds)) {
        try {
          const part = summarizeBulkResults(await runBulkChunk(input, orderIds), t("bulkFailedGeneric"));
          outcome.succeeded.push(...part.succeeded);
          outcome.failures.push(...part.failures);
        } catch (error) {
          const message = getServerFnError(error, t("bulkRequestFailed"));
          outcome.failures.push(...orderIds.map((orderId) => ({ orderId, error: message })));
        }
      }
      return outcome;
    },
    onSettled: () => invalidateAfterOrderChange(queryClient),
  });
}

export interface ArchivableOrder {
  id: string;
  version: number;
}

/**
 * Archives orders (90 per request) and toasts "Order archived" with Undo for
 * 10 s. Archiving bumps an order's version by exactly one, so Undo restores
 * each with the loaded version + 1.
 */
export function useArchiveOrdersWithUndo({ canUndo }: { canUndo: boolean }) {
  const queryClient = useQueryClient();
  const t = useMessages(orderListMessages);

  const restore = async (orders: readonly ArchivableOrder[]) => {
    let failed = 0;
    for (const order of orders) {
      try {
        await apiData(postApiV1AdminOrdersByIdRestore({
          path: { id: order.id },
          body: { expectedVersion: order.version + 1 },
        }));
      } catch {
        failed += 1;
      }
    }
    invalidateAfterOrderChange(queryClient);
    if (failed > 0) toast.error(t("undoFailed"));
    else toast.success(orders.length === 1 ? t("restoredOne") : t("restoredOther"));
  };

  return useMutation({
    mutationFn: async ({ orders }: { orders: readonly ArchivableOrder[]; skipped: number }) => {
      const archived: ArchivableOrder[] = [];
      try {
        for (const part of chunk(orders)) {
          await apiData(postApiV1AdminOrdersArchive({
            body: { orders: part.map((order) => ({ id: order.id, expectedVersion: order.version })) },
          }));
          archived.push(...part);
        }
      } catch (error) {
        if (archived.length === 0) throw error;
        toast.error(getServerFnError(error, t("archiveFailed")));
      }
      return archived;
    },
    onSuccess: (archived, { skipped }) => {
      const done = archived.length === 1 ? t("archivedOne") : t("archivedOther", { count: archived.length });
      // "2 orders archived · 1 skipped (still open)"
      toast.success(
        skipped > 0 ? `${done} · ${t("archiveSkipped", { count: skipped })}` : done,
        {
          duration: canUndo ? 10_000 : undefined,
          action: canUndo ? { label: t("undo"), onClick: () => void restore(archived) } : undefined,
        },
      );
    },
    onError: (error) => toast.error(getServerFnError(error, t("archiveFailed"))),
    onSettled: () => invalidateAfterOrderChange(queryClient),
  });
}
