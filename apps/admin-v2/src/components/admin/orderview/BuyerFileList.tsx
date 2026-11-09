import { FileText, Image as ImageIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderBuyerFilesMessages } from "~/i18n/order-buyer-files";
import { toast } from "~/lib/toast";
import { formatFileSize } from "../media-manager/utils/formatters";
import type { BuyerFilesState } from "./BuyerFiles";
import { buyerFileKind, linkIsFresh, matchUploadAnswer, type BuyerFile } from "./buyer-files";

/** A `file` answer's files once the order's list is ready: name, "Image · 1.2 MB" and Download; ids it no longer has read "No longer kept". */
export function BuyerFileList({ ids, state }: { ids: readonly string[]; state: BuyerFilesState }) {
  const t = useMessages(orderBuyerFilesMessages);
  const { files, missing } = matchUploadAnswer(ids, state.uploads);
  const download = (file: BuyerFile) => {
    const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
    // A link with time left opens at once (a new tab opened after a wait can be blocked as a pop-up).
    if (linkIsFresh(file)) {
      open(file.url);
      return;
    }
    state.setPendingId(file.id);
    void state.refetch()
      .then((result) => {
        const fresh = result.data?.find((entry) => entry.id === file.id);
        if (fresh) open(fresh.url);
        else toast.error(t("files.gone"));
      })
      .catch(() => toast.error(t("files.downloadFailed")))
      .finally(() => state.setPendingId(null));
  };
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
              onClick={() => download(file)}
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
