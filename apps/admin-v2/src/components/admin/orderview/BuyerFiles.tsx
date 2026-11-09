import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { useHydrated } from "~/hooks/use-hydrated";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderUploadsQueryOptions } from "~/lib/api-query-options/orders";
import { answerUploadIds, orderHasUploadAnswers, type BuyerFile } from "./buyer-files";
import type { Order } from "./types";

export interface BuyerFilesState {
  status: "loading" | "error" | "ready";
  uploads: readonly BuyerFile[];
  pendingId: string | null;
  /** Marks the file whose fresh link is being fetched (null when done). */
  setPendingId: (id: string | null) => void;
  /** Reads the list again: fresh signed links. */
  refetch: () => Promise<{ data?: readonly BuyerFile[] }>;
  retry: () => void;
}

const BuyerFilesContext = createContext<BuyerFilesState | null>(null);

// The files themselves (names, sizes, Download) load once the list is ready.
const BuyerFileList = lazy(() => import("./BuyerFileList").then((module) => ({ default: module.BuyerFileList })));

/**
 * Reads the order's buyer files once for every card that shows a file answer
 * (line inputs and checkout attributes alike). The list is requested only when
 * the order holds a file answer. Downloads (BuyerFileList) open a fresh signed
 * link in a new tab; the link is never logged or shown.
 */
export function OrderBuyerFilesProvider({ order, children }: {
  order: Pick<Order, "id" | "items" | "attributes">;
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  const wanted = orderHasUploadAnswers(order);
  const query = useQuery({ ...orderUploadsQueryOptions(order.id), enabled: wanted && hydrated });
  const { refetch } = query;
  const [pendingId, setPendingId] = useState<string | null>(null);

  const state = useMemo<BuyerFilesState | null>(() => {
    if (!wanted) return null;
    return {
      status: query.isError ? "error" : query.data ? "ready" : "loading",
      uploads: query.data ?? [],
      pendingId,
      setPendingId,
      refetch,
      retry: () => void refetch(),
    };
  }, [wanted, query.isError, query.data, pendingId, refetch]);

  return <BuyerFilesContext.Provider value={state}>{children}</BuyerFilesContext.Provider>;
}

/**
 * A `file` answer as its files: name, "Image · 1.2 MB" and Download. Ids the
 * list no longer has (kept for a year, or erased) read "No longer kept". Shows
 * the file count alone where no provider supplies the list.
 */
export function BuyerFiles({ value, fallback }: { value: string; fallback?: string }) {
  const t = useMessages(orderDetailMessages);
  const state = useContext(BuyerFilesContext);
  const ids = answerUploadIds(value);
  if (!ids) return <>{fallback ?? value}</>;
  if (!state) return <>{fallback ?? t("files.count", { count: ids.length })}</>;
  if (state.status === "loading") {
    return <span role="status" className="text-muted-foreground">{t("files.loading")}</span>;
  }
  if (state.status === "error") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="alert" className="text-destructive">{t("files.loadFailed")}</span>
        <Button type="button" variant="outline" size="sm" onClick={state.retry}>{t("files.retry")}</Button>
      </span>
    );
  }
  return (
    <Suspense fallback={<span role="status" className="text-muted-foreground">{t("files.loading")}</span>}>
      <BuyerFileList ids={ids} state={state} />
    </Suspense>
  );
}
