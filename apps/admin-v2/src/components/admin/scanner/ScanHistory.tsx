import {
  ArrowLeft,
  Undo2,
  Trash2,
  CheckCircle,
  XCircle,
  ArrowRight,
  Package,
} from "lucide-react";
import type { ScanResult } from "./ScannerApp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScanHistoryProps {
  items: ScanResult[];
  onUndo: (item: ScanResult) => void;
  onClear: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsed(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanHistory({ items, onUndo, onClear, onClose }: ScanHistoryProps) {
  const undoableCount = 5;

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-white">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 items-center gap-2 rounded-lg px-2 text-sm text-zinc-300 active:bg-zinc-800"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to Scanner
        </button>

        {items.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400 active:bg-zinc-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* Title */}
      <div className="shrink-0 px-4 py-3 border-b border-zinc-800/50">
        <h1 className="text-lg font-bold text-zinc-200">Scan History</h1>
        <p className="text-xs text-zinc-500">
          {items.length} scan{items.length !== 1 ? "s" : ""} this session
        </p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
            <Package className="mb-3 h-10 w-10" />
            <p className="text-sm">No scans yet</p>
            <p className="text-xs text-zinc-700 mt-1">
              Scanned items will appear here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {items.map((item, idx) => {
              const isError = item.action === "error";
              const canUndo =
                idx < undoableCount &&
                !isError &&
                item.product != null;

              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  {/* Icon */}
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
                            item.action === "deduct"
                              ? "text-orange-400"
                              : item.action === "set"
                                ? "text-blue-400"
                                : "text-emerald-400"
                          }`}
                        >
                          {item.action === "set"
                            ? `Set ${item.newStock}`
                            : item.action === "deduct"
                              ? `-${item.quantity}`
                              : `+${item.quantity}`}
                        </span>
                      )}
                      <span className="truncate text-sm text-zinc-300">
                        {item.product?.name ?? item.barcode}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-0.5">
                      {!isError && (
                        <div className="flex items-center gap-1 text-xs text-zinc-500">
                          <span>{item.oldStock}</span>
                          <ArrowRight className="h-2.5 w-2.5" />
                          <span>{item.newStock}</span>
                        </div>
                      )}
                      {isError && (
                        <span className="text-xs text-red-400/70">
                          {item.reason}
                        </span>
                      )}
                      <span className="text-xs text-zinc-600">
                        {formatTime(item.timestamp)}
                      </span>
                      <span className="text-xs text-zinc-700">
                        {formatElapsed(item.timestamp)}
                      </span>
                    </div>
                  </div>

                  {/* Undo button */}
                  {canUndo && (
                    <button
                      type="button"
                      onClick={() => onUndo(item)}
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400 active:bg-zinc-700"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
