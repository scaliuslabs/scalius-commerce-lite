import { ArrowLeft, Undo2, Trash2, CheckCircle, XCircle, ArrowRight, Package } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";
import { elapsedLabel, ScanChange } from "./LastScanBar";
import type { ScanResult } from "./ScannerApp";

const UNDOABLE_COUNT = 5;

interface ScanHistoryProps {
  items: ScanResult[];
  onUndo: (item: ScanResult) => void;
  onClear: () => void;
  onClose: () => void;
}

export function ScanHistory({ items, onUndo, onClear, onClose }: ScanHistoryProps) {
  const t = useMessages(scannerMessages);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-between border-b bg-card px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 items-center gap-2 rounded-lg px-2 text-body active:bg-accent"
        >
          <ArrowLeft className="size-5" />
          {t("backToScanner")}
        </button>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="flex h-11 items-center gap-2 rounded-lg bg-muted px-3 text-body text-muted-foreground active:bg-accent"
          >
            <Trash2 className="size-4" />
            {t("clear")}
          </button>
        ) : null}
      </div>

      <div className="shrink-0 border-b px-4 py-3">
        <h1 className="text-heading-md font-semibold">{t("historyTitle")}</h1>
        <p className="text-body text-muted-foreground">
          {items.length === 1 ? t("scanCountOne") : t("scanCount", { count: items.length })}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Package className="mb-3 size-10" />
            <p className="text-body">{t("noScans")}</p>
            <p className="mt-1 text-body">{t("noScansHint")}</p>
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item, index) => {
              const isError = item.action === "error";
              const canUndo = index < UNDOABLE_COUNT && !isError && item.product != null;
              const Icon = isError ? XCircle : CheckCircle;

              return (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="flex h-5 shrink-0 items-center">
                    <Icon className={cn("size-5", isError ? "text-destructive" : "text-primary")} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isError ? null : <ScanChange result={item} />}
                      <span className="truncate text-body">{item.product?.name ?? item.barcode}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-body text-muted-foreground">
                      {isError ? null : (
                        <span className="flex items-center gap-1">
                          {formatNumber(item.oldStock)}
                          <ArrowRight className="size-3" />
                          {formatNumber(item.newStock)}
                        </span>
                      )}
                      {item.undoError ? <span className="text-destructive">{item.undoError}</span> : null}
                      {isError ? <span className="text-destructive">{item.reason}</span> : null}
                      <span>{formatDateTime(new Date(item.timestamp), { timeStyle: "short" })}</span>
                      <span>{elapsedLabel(t, item.timestamp)}</span>
                    </div>
                  </div>
                  {canUndo ? (
                    <button
                      type="button"
                      onClick={() => onUndo(item)}
                      className="flex h-11 shrink-0 items-center gap-2 rounded-lg bg-muted px-3 text-body active:bg-accent"
                    >
                      <Undo2 className="size-4" />
                      {t("undo")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
