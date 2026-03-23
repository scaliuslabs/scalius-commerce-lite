import { CheckCircle, XCircle, ArrowRight } from "lucide-react";
import { useState, useEffect } from "react";
import type { ScanResult, ScannerMode } from "./ScannerApp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LastScanBarProps {
  result: ScanResult | null;
  mode: ScannerMode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LastScanBar({ result, mode }: LastScanBarProps) {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!result) return;

    const update = () => {
      const diff = Math.floor((Date.now() - result.timestamp) / 1000);
      if (diff < 60) {
        setElapsed(`${diff}s ago`);
      } else if (diff < 3600) {
        setElapsed(`${Math.floor(diff / 60)}m ago`);
      } else {
        setElapsed(`${Math.floor(diff / 3600)}h ago`);
      }
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [result]);

  if (!result) {
    return (
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 py-3">
        <p className="text-center text-sm text-zinc-600">
          {mode === "manual"
            ? "Scan a barcode to adjust stock"
            : "Scan a barcode to get started"}
        </p>
      </div>
    );
  }

  const isError = result.action === "error";
  const productName = result.product?.name ?? result.barcode;

  return (
    <div
      className={`shrink-0 border-t px-4 py-3 ${
        isError
          ? "border-red-900/50 bg-red-950/40"
          : "border-zinc-800 bg-zinc-900"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Status icon */}
        {isError ? (
          <XCircle className="h-5 w-5 shrink-0 text-red-400" />
        ) : (
          <CheckCircle className="h-5 w-5 shrink-0 text-emerald-400" />
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!isError && (
              <span
                className={`text-sm font-bold ${
                  result.action === "deduct"
                    ? "text-orange-400"
                    : result.action === "set"
                      ? "text-blue-400"
                      : "text-emerald-400"
                }`}
              >
                {result.action === "set"
                  ? `Set to ${result.newStock}`
                  : result.action === "deduct"
                    ? `-${result.quantity}`
                    : `+${result.quantity}`}
              </span>
            )}
            <span className="truncate text-sm text-zinc-300">{productName}</span>
          </div>

          {!isError && (
            <div className="flex items-center gap-1 text-xs text-zinc-500">
              <span>Stock: {result.oldStock}</span>
              <ArrowRight className="h-3 w-3" />
              <span className="text-zinc-300">{result.newStock}</span>
            </div>
          )}
          {isError && (
            <p className="text-xs text-red-400/70">{result.reason}</p>
          )}
        </div>

        {/* Time */}
        <span className="shrink-0 text-xs text-zinc-600">{elapsed}</span>
      </div>
    </div>
  );
}
