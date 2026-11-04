import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
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
import { orderArchiveMessages } from "~/i18n/order-archive";
import {
  chunk,
  nextBulkRequest,
  queueAfterBulkResponse,
  summarizeBulkResults,
  unansweredBulkOrders,
  type BulkRequestResult,
  type OrderBulkOutcome,
} from "./order-bulk-actions";

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

async function runBulkChunk(input: BulkInput, orderIds: string[]): Promise<BulkRequestResult> {
  if (input.action === "confirm") {
    return apiData(postApiV1AdminOrdersBulkConfirm({ body: { orderIds, requestKey: input.requestKey } }));
  }
  if (input.action === "send") {
    const body = {
      orderIds,
      requestKey: input.requestKey,
      courierName: input.courierName || undefined,
      note: input.note || undefined,
    };
    return apiData(postApiV1AdminOrdersBulkFulfill({ body }));
  }
  const body = { orderIds, providerId: input.providerId, options: {} };
  return apiData(postApiV1AdminOrdersBulkShip({ body }));
}

/**
 * Confirm, "Mark as sent" and courier booking for many orders. Each request
 * sends up to 90; the server handles its plan's share (fewer on Free) and
 * returns the rest as `remaining`, which go first in the next request.
 * Resolves with every order's outcome; a request that fails outright reports
 * its orders as not done, and earlier requests keep their results.
 */
export function useOrderBulkRun() {
  const queryClient = useQueryClient();
  const t = useMessages(orderArchiveMessages);
  return useMutation({
    mutationFn: async (input: BulkInput): Promise<OrderBulkOutcome> => {
      const outcome: OrderBulkOutcome = { succeeded: [], failures: [] };
      let queue = [...input.orderIds];
      while (queue.length > 0) {
        const { sent, next } = nextBulkRequest(queue);
        try {
          const response = await runBulkChunk(input, sent);
          const part = summarizeBulkResults(response.results, t("bulkFailedGeneric"));
          outcome.succeeded.push(...part.succeeded);
          outcome.failures.push(...part.failures);
          // An order the server neither answered nor left for later is not done: say so.
          const unanswered = unansweredBulkOrders(sent, response);
          outcome.failures.push(...unanswered.map((orderId) => ({ orderId, error: t("bulkFailedGeneric") })));
          const after = queueAfterBulkResponse(sent, next, response);
          if (after) {
            queue = after;
          } else {
            // Nothing handled: report what it left for later instead of asking again (once per order).
            const reported = new Set([...response.results.map((result) => result.orderId), ...unanswered]);
            outcome.failures.push(...sent.filter((orderId) => !reported.has(orderId))
              .map((orderId) => ({ orderId, error: t("bulkRequestFailed") })));
            queue = next;
          }
        } catch (error) {
          const message = getServerFnError(error, t("bulkRequestFailed"));
          outcome.failures.push(...sent.map((orderId) => ({ orderId, error: message })));
          queue = next;
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
  const t = useMessages(orderArchiveMessages);

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
