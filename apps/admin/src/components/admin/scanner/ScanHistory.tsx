import { Clock, Undo2, ChevronDown, ChevronUp, Package } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanHistoryItem {
  id: string;
  timestamp: number;
  barcode: string;
  productName: string | null;
  action: string;
  detail: string;
  variantId: string | null;
  /** Previous stock before this action — enables undo */
  previousStock: number | null;
}

interface ScanHistoryProps {
  items: ScanHistoryItem[];
  onUndo: (item: ScanHistoryItem) => void;
  isOpen: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanHistory({ items, onUndo, isOpen, onToggle }: ScanHistoryProps) {
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900">
      {/* Header toggle */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-zinc-800/50"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-300">
            Scan History
          </span>
          {items.length > 0 && (
            <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
              {items.length}
            </span>
          )}
        </div>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        )}
      </button>

      {/* List */}
      {isOpen && (
        <div className="max-h-64 overflow-y-auto border-t border-zinc-800 px-3 pb-3">
          {items.length === 0 ? (
            <div className="flex flex-col items-center py-6 text-zinc-500">
              <Package className="mb-2 h-6 w-6" />
              <p className="text-xs">No scans yet</p>
            </div>
          ) : (
            <div className="space-y-1 pt-2">
              {items.map((item, idx) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-lg bg-zinc-800/40 px-2.5 py-2"
                >
                  {/* Time */}
                  <div className="shrink-0 pt-0.5 text-[10px] tabular-nums text-zinc-600">
                    {formatTime(item.timestamp)}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-zinc-300">
                      {item.productName ?? item.barcode}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {item.action}
                      {item.detail && (
                        <span className="text-zinc-600"> — {item.detail}</span>
                      )}
                    </div>
                  </div>

                  {/* Undo (only for most recent adjustable item) */}
                  {idx === 0 && item.previousStock != null && (
                    <button
                      type="button"
                      onClick={() => onUndo(item)}
                      className="flex h-7 shrink-0 items-center gap-1 rounded bg-zinc-700 px-2 text-[10px] text-zinc-400 active:bg-zinc-600"
                    >
                      <Undo2 className="h-3 w-3" />
                      Undo
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
