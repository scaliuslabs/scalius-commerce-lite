import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Image as ImageIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useHydrated } from "~/hooks/use-hydrated";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderUploadsQueryOptions } from "~/lib/api-query-options/orders";
import { toast } from "~/lib/toast";
import { formatFileSize } from "../media-manager/utils/formatters";
import { answerUploadIds, buyerFileKind, linkIsFresh, matchUploadAnswer, orderHasUploadAnswers, type BuyerFile } from "./buyer-files";
import type { Order } from "./types";

interface BuyerFilesState {
  status: "loading" | "error" | "ready";
  uploads: readonly BuyerFile[];
  pendingId: string | null;
  download: (file: BuyerFile) => void;
  retry: () => void;
}

const BuyerFilesContext = createContext<BuyerFilesState | null>(null);

/**
 * Reads the order's buyer files once for every card that shows a file answer
 * (line inputs and checkout attributes alike). The list is requested only when
 * the order holds a file answer. A download opens a fresh signed link in a new
 * tab; the link is never logged or shown.
 */
export function OrderBuyerFilesProvider({ order, children }: {
  order: Pick<Order, "id" | "items" | "attributes">;
  children: ReactNode;
}) {
  const t = useMessages(orderDetailMessages);
  const hydrated = useHydrated();
  const wanted = orderHasUploadAnswers(order);
  const query = useQuery({ ...orderUploadsQueryOptions(order.id), enabled: wanted && hydrated });
  const { refetch } = query;
  const [pendingId, setPendingId] = useState<string | null>(null);

  const download = useCallback((file: BuyerFile) => {
    const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
    // A link with time left opens at once (a new tab opened after a wait can be blocked as a pop-up).
    if (linkIsFresh(file)) {
      open(file.url);
      return;
    }
    setPendingId(file.id);
    void refetch()
      .then((result) => {
        const fresh = result.data?.find((entry) => entry.id === file.id);
        if (fresh) open(fresh.url);
        else toast.error(t("files.gone"));
      })
      .catch(() => toast.error(t("files.downloadFailed")))
      .finally(() => setPendingId(null));
  }, [refetch, t]);

  const state = useMemo<BuyerFilesState | null>(() => {
    if (!wanted) return null;
    return {
      status: query.isError ? "error" : query.data ? "ready" : "loading",
      uploads: query.data ?? [],
      pendingId,
      download,
      retry: () => void refetch(),
    };
  }, [wanted, query.isError, query.data, pendingId, download, refetch]);

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
  const { files, missing } = matchUploadAnswer(ids, state.uploads);
  return (
    <ul className="space-y-2" data-testid="buyer-files">
      {files.map((file) => {
        const kind = buyerFileKind(file.mediaType);
        const Icon = kind === "pdf" ? FileText : ImageIcon;
        return (
          <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 text-foreground">
            <div className="flex min-w-0 items-start gap-2">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="wrap-anywhere">{file.filename}</p>
                <p className="text-muted-foreground tabular-nums">
                  {t(kind === "pdf" ? "files.typePdf" : "files.typeImage")} · {formatFileSize(file.sizeBytes)}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={state.pendingId === file.id}
              aria-label={t("files.downloadName", { name: file.filename })}
              onClick={() => state.download(file)}
            >
              {t("files.download")}
            </Button>
          </li>
        );
      })}
      {missing.map((id) => (
        <li key={id} className="text-muted-foreground">{t("files.noLongerKept")}</li>
      ))}
    </ul>
  );
}
