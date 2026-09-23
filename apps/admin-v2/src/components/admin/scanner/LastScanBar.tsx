import { CheckCircle, XCircle, ArrowRight } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@scalius/shared/utils";
import { formatNumber, useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";
import type { ScanResult, ScannerMode } from "./ScannerApp";

type ScannerT = (key: keyof typeof scannerMessages.en, vars?: Record<string, string | number>) => string;

export function elapsedLabel(t: ScannerT, timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t("secondsAgo", { count: seconds });
  if (seconds < 3600) return t("minutesAgo", { count: Math.floor(seconds / 60) });
  return t("hoursAgo", { count: Math.floor(seconds / 3600) });
}

export function ScanChange({ result }: { result: ScanResult }) {
  const t = useMessages(scannerMessages);
  return (
    <span className={cn("text-body font-semibold", result.action === "deduct" ? "text-destructive" : "text-foreground")}>
      {result.action === "set"
        ? t("setTo", { count: result.newStock })
        : `${result.action === "deduct" ? "−" : "+"}${formatNumber(result.quantity)}`}
    </span>
  );
}

export function LastScanBar({ result, mode }: { result: ScanResult | null; mode: ScannerMode }) {
  const t = useMessages(scannerMessages);
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!result) return;
    const update = () => setElapsed(elapsedLabel(t, result.timestamp));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
    // `t` changes identity every render; the label refreshes each second anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  if (!result) {
    return (
      <div className="shrink-0 border-t bg-card px-4 py-3">
        <p className="text-center text-body text-muted-foreground">
          {t(mode === "manual" ? "idleManual" : "idle")}
        </p>
      </div>
    );
  }

  const isError = result.action === "error";
  const Icon = isError ? XCircle : CheckCircle;

  return (
    <div className={cn("shrink-0 border-t px-4 py-3", isError ? "bg-destructive/10" : "bg-card")}>
      <div className="flex items-start gap-3">
        <span className="flex h-5 shrink-0 items-center">
          <Icon className={cn("size-5", isError ? "text-destructive" : "text-primary")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isError ? null : <ScanChange result={result} />}
            <span className="truncate text-body">{result.product?.name ?? result.barcode}</span>
          </div>
          {isError ? (
            <p className="text-body text-destructive">{result.reason}</p>
          ) : (
            <div className="flex items-center gap-1 text-body text-muted-foreground">
              <span>{formatNumber(result.oldStock)}</span>
              <ArrowRight className="size-3" />
              <span className="text-foreground">{formatNumber(result.newStock)}</span>
            </div>
          )}
        </div>
        <span className="shrink-0 text-body text-muted-foreground">{elapsed}</span>
      </div>
    </div>
  );
}
