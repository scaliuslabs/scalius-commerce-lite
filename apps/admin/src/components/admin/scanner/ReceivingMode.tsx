import { useState } from "react";
import {
  Timer,
  Package,
  Plus,
  Minus,
  Check,
  X,
} from "lucide-react";
import type { ScannedProduct } from "./ProductCard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReceivingItem {
  product: ScannedProduct;
  count: number;
  lastScanned: number;
}

interface ReceivingSession {
  startedAt: number;
  items: Map<string, ReceivingItem>;
  defaultQuantity: number;
}

interface ReceivingModeProps {
  session: ReceivingSession | null;
  onStartSession: () => void;
  onEndSession: (items: ReceivingItem[]) => void;
  onUpdateQuantity: (variantId: string, delta: number) => void;
  onRemoveItem: (variantId: string) => void;
  onSetDefaultQuantity: (qty: number) => void;
}

export type { ReceivingSession, ReceivingItem };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const QTY_PRESETS = [1, 5, 10] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReceivingMode({
  session,
  onStartSession,
  onEndSession,
  onUpdateQuantity,
  onRemoveItem,
  onSetDefaultQuantity,
}: ReceivingModeProps) {
  const [showSummary, setShowSummary] = useState(false);
  const [customQty, setCustomQty] = useState("");
  const [now, setNow] = useState(Date.now());

  // Tick every second for the timer
  useState(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  });

  // ---- No active session ----
  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-700/50 bg-zinc-900 p-6">
        <Package className="mb-3 h-10 w-10 text-zinc-600" />
        <p className="mb-1 text-sm font-medium text-zinc-300">
          Receiving Mode
        </p>
        <p className="mb-4 text-center text-xs text-zinc-500">
          Scan items from an incoming shipment. Each scan auto-adds the
          configured quantity.
        </p>
        <button
          type="button"
          onClick={onStartSession}
          className="h-12 w-full rounded-lg bg-emerald-600 text-sm font-semibold text-white active:bg-emerald-700"
        >
          Start Receiving Session
        </button>
      </div>
    );
  }

  const items = Array.from(session.items.values());
  const totalUnits = items.reduce((sum, item) => sum + item.count, 0);
  const elapsed = now - session.startedAt;

  // ---- Summary view ----
  if (showSummary) {
    return (
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">
          Session Summary
        </h3>
        <div className="mb-3 flex gap-4 text-center">
          <div className="flex-1 rounded-lg bg-zinc-800 p-2">
            <div className="text-lg font-bold text-white">{items.length}</div>
            <div className="text-[10px] uppercase text-zinc-500">Products</div>
          </div>
          <div className="flex-1 rounded-lg bg-zinc-800 p-2">
            <div className="text-lg font-bold text-emerald-400">
              {totalUnits}
            </div>
            <div className="text-[10px] uppercase text-zinc-500">
              Total Units
            </div>
          </div>
          <div className="flex-1 rounded-lg bg-zinc-800 p-2">
            <div className="text-lg font-bold text-zinc-300">
              {formatElapsed(elapsed)}
            </div>
            <div className="text-[10px] uppercase text-zinc-500">Duration</div>
          </div>
        </div>

        {/* Items list */}
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <div
              key={item.product.variantId}
              className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-3 py-2"
            >
              <span className="truncate text-sm text-zinc-300">
                {item.product.productName}
                {item.product.size && (
                  <span className="text-zinc-500"> / {item.product.size}</span>
                )}
              </span>
              <span className="ml-2 shrink-0 font-mono text-sm font-bold text-emerald-400">
                +{item.count}
              </span>
            </div>
          ))}
          {items.length === 0 && (
            <p className="py-4 text-center text-sm text-zinc-500">
              No items scanned
            </p>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setShowSummary(false)}
            className="h-11 flex-1 rounded-lg bg-zinc-800 text-sm font-medium text-zinc-300 active:bg-zinc-700"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => onEndSession(items)}
            className="h-11 flex-1 rounded-lg bg-emerald-600 text-sm font-semibold text-white active:bg-emerald-700"
          >
            <Check className="mr-1 inline h-4 w-4" />
            Confirm &amp; Apply
          </button>
        </div>
      </div>
    );
  }

  // ---- Active session ----
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-zinc-900 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-sm font-semibold text-emerald-400">
            Receiving
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-zinc-400">
          <Timer className="h-3.5 w-3.5" />
          {formatElapsed(elapsed)}
        </div>
      </div>

      {/* Quantity per scan */}
      <div className="mb-3">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Qty per scan
        </div>
        <div className="flex gap-1.5">
          {QTY_PRESETS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => {
                onSetDefaultQuantity(q);
                setCustomQty("");
              }}
              className={`flex h-9 w-12 items-center justify-center rounded-lg text-sm font-bold ${
                session.defaultQuantity === q && customQty === ""
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-800 text-zinc-400 active:bg-zinc-700"
              }`}
            >
              +{q}
            </button>
          ))}
          <input
            type="number"
            value={customQty}
            onChange={(e) => {
              setCustomQty(e.target.value);
              const n = Number(e.target.value);
              if (n > 0) onSetDefaultQuantity(n);
            }}
            placeholder="Custom"
            inputMode="numeric"
            min={1}
            className="h-9 w-20 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-center text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Running totals */}
      <div className="mb-3 flex gap-3 text-center">
        <div className="flex-1 rounded-lg bg-zinc-800/60 p-2">
          <div className="text-lg font-bold text-white">{items.length}</div>
          <div className="text-[10px] uppercase text-zinc-500">Products</div>
        </div>
        <div className="flex-1 rounded-lg bg-zinc-800/60 p-2">
          <div className="text-lg font-bold text-emerald-400">{totalUnits}</div>
          <div className="text-[10px] uppercase text-zinc-500">Units</div>
        </div>
      </div>

      {/* Items list */}
      {items.length > 0 && (
        <div className="mb-3 max-h-36 space-y-1 overflow-y-auto">
          {items
            .sort((a, b) => b.lastScanned - a.lastScanned)
            .map((item) => (
              <div
                key={item.product.variantId}
                className="flex items-center gap-2 rounded-lg bg-zinc-800/60 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                  {item.product.productName}
                  {item.product.size && (
                    <span className="text-zinc-500">
                      {" "}
                      / {item.product.size}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity(item.product.variantId, -1)}
                    disabled={item.count <= 1}
                    className="flex h-7 w-7 items-center justify-center rounded bg-zinc-700 text-zinc-400 disabled:opacity-30 active:bg-zinc-600"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="w-8 text-center text-sm font-bold tabular-nums text-white">
                    {item.count}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity(item.product.variantId, 1)}
                    className="flex h-7 w-7 items-center justify-center rounded bg-zinc-700 text-zinc-400 active:bg-zinc-600"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveItem(item.product.variantId)}
                    className="ml-1 flex h-7 w-7 items-center justify-center rounded bg-red-500/10 text-red-400 active:bg-red-500/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setShowSummary(true)}
          disabled={items.length === 0}
          className="h-11 flex-1 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
        >
          End Session ({totalUnits} units)
        </button>
      </div>
    </div>
  );
}
