import { useState, useCallback, useRef, useEffect } from "react";
import { useWebHaptics } from "web-haptics/react";
import {
  Zap,
  PackageOpen,
  ClipboardList,
  Clock,
  WifiOff,
} from "lucide-react";
import { BarcodeScanner } from "./BarcodeScanner";
import { ProductCard, type ScannedProduct } from "./ProductCard";
import { StockAdjuster } from "./StockAdjuster";
import { ReceivingMode, type ReceivingSession, type ReceivingItem } from "./ReceivingMode";
import { ScanHistory, type ScanHistoryItem } from "./ScanHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScannerMode = "quick" | "receiving" | "count";

type AppState =
  | "idle"
  | "scanning"
  | "looking-up"
  | "result"
  | "adjusting"
  | "error";

interface ScannerAppProps {
  token: string;
}

// ---------------------------------------------------------------------------
// Audio feedback (Web Audio API)
// ---------------------------------------------------------------------------

function playBeep(frequency: number, duration: number) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = frequency;
    gain.gain.value = 0.3;
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, duration);
  } catch {
    // Audio not available — silent fallback
  }
}

const successBeep = () => playBeep(880, 150);
const errorBeep = () => playBeep(220, 300);
const scanBeep = () => playBeep(660, 100);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let historyIdCounter = 0;
function nextHistoryId(): string {
  return `scan-${Date.now()}-${++historyIdCounter}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScannerApp({ token }: ScannerAppProps) {
  // ---- Core state ----
  const [mode, setMode] = useState<ScannerMode>("quick");
  const [appState, setAppState] = useState<AppState>("idle");
  const [lastScan, setLastScan] = useState<ScannedProduct | null>(null);
  const [stockDelta, setStockDelta] = useState<number | null>(null);
  const [scanHistory, setScanHistory] = useState<ScanHistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  // ---- Receiving session ----
  const [receivingSession, setReceivingSession] =
    useState<ReceivingSession | null>(null);

  // ---- Haptics ----
  const { trigger: hapticTrigger } = useWebHaptics();

  // Stable ref so child callbacks don't re-render scanner
  const hapticRef = useRef(hapticTrigger);
  hapticRef.current = hapticTrigger;

  // ---- Online/offline detection ----
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // ---- Product lookup ----
  const lookupBarcode = useCallback(
    async (code: string): Promise<ScannedProduct | null> => {
      const url = `/api/v1/admin/inventory/scanner/lookup?code=${encodeURIComponent(code)}`;
      const res = await fetch(url, {
        headers: { "X-Scanner-Token": token },
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? body?.error ?? `Lookup failed: ${res.status}`,
        );
      }
      const json = await res.json();
      return (json.data ?? json) as ScannedProduct;
    },
    [token],
  );

  // ---- Handle scan event (from camera or keyboard wedge) ----
  const handleScan = useCallback(
    async (code: string, format: string) => {
      scanBeep();
      setLookupError(null);
      setStockDelta(null);
      setAppState("looking-up");

      try {
        const product = await lookupBarcode(code);

        if (!product) {
          errorBeep();
          hapticRef.current("error");
          setLookupError(`No product found for: ${code}`);
          setLastScan(null);
          setAppState("error");

          setScanHistory((prev) => [
            {
              id: nextHistoryId(),
              timestamp: Date.now(),
              barcode: code,
              productName: null,
              action: "Lookup",
              detail: "Not found",
              variantId: null,
              previousStock: null,
            },
            ...prev,
          ].slice(0, 50));
          return;
        }

        successBeep();
        hapticRef.current("success");
        setLastScan(product);
        setAppState("result");

        // ---- Receiving mode: auto-add ----
        if (mode === "receiving" && receivingSession) {
          const qty = receivingSession.defaultQuantity;
          setReceivingSession((prev) => {
            if (!prev) return prev;
            const items = new Map(prev.items);
            const existing = items.get(product.variantId);
            if (existing) {
              // Duplicate scan check — warn if within 2 seconds
              if (Date.now() - existing.lastScanned < 2000) {
                hapticRef.current("warning");
              }
              items.set(product.variantId, {
                ...existing,
                count: existing.count + qty,
                lastScanned: Date.now(),
              });
            } else {
              items.set(product.variantId, {
                product,
                count: qty,
                lastScanned: Date.now(),
              });
            }
            return { ...prev, items };
          });
          hapticRef.current("selection");

          setScanHistory((prev) => [
            {
              id: nextHistoryId(),
              timestamp: Date.now(),
              barcode: code,
              productName: product.productName,
              action: "Receiving",
              detail: `+${qty}`,
              variantId: product.variantId,
              previousStock: null,
            },
            ...prev,
          ].slice(0, 50));
        } else {
          // Quick / count mode — just show product
          setScanHistory((prev) => [
            {
              id: nextHistoryId(),
              timestamp: Date.now(),
              barcode: code,
              productName: product.productName,
              action: "Scanned",
              detail: format,
              variantId: product.variantId,
              previousStock: null,
            },
            ...prev,
          ].slice(0, 50));
        }
      } catch (err) {
        errorBeep();
        hapticRef.current("error");
        setLookupError(
          err instanceof Error ? err.message : "Lookup failed",
        );
        setLastScan(null);
        setAppState("error");
      }
    },
    [lookupBarcode, mode, receivingSession],
  );

  // ---- Stock adjustment complete ----
  const handleAdjustComplete = useCallback(
    (newStock: number) => {
      if (!lastScan) return;
      const delta = newStock - lastScan.stock;
      setStockDelta(delta);
      setLastScan((prev) => (prev ? { ...prev, stock: newStock } : prev));
      successBeep();

      setScanHistory((prev) => {
        const entry: ScanHistoryItem = {
          id: nextHistoryId(),
          timestamp: Date.now(),
          barcode: lastScan.barcode,
          productName: lastScan.productName,
          action: "Adjusted",
          detail: `${delta >= 0 ? "+" : ""}${delta} → ${newStock}`,
          variantId: lastScan.variantId,
          previousStock: lastScan.stock,
        };
        return [entry, ...prev].slice(0, 50);
      });
    },
    [lastScan],
  );

  // ---- Undo last adjustment ----
  const handleUndo = useCallback(
    async (item: ScanHistoryItem) => {
      if (!item.variantId || item.previousStock == null) return;

      try {
        const res = await fetch("/api/v1/admin/inventory/stock-set", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scanner-Token": token,
          },
          body: JSON.stringify({
            variantId: item.variantId,
            newStock: item.previousStock,
            reason: "Undo scanner adjustment",
          }),
        });
        if (!res.ok) throw new Error("Undo failed");

        hapticRef.current("medium");
        successBeep();

        // Update displayed product if it's the same variant
        if (lastScan?.variantId === item.variantId) {
          setLastScan((prev) =>
            prev ? { ...prev, stock: item.previousStock! } : prev,
          );
          setStockDelta(null);
        }

        // Remove the undone entry from history
        setScanHistory((prev) => prev.filter((h) => h.id !== item.id));
      } catch {
        errorBeep();
        hapticRef.current("error");
      }
    },
    [lastScan, token],
  );

  // ---- Haptic pass-through for StockAdjuster ----
  const handleStockHaptic = useCallback(
    (type: "light" | "medium" | "warning") => {
      hapticRef.current(type);
    },
    [],
  );

  // ---- Receiving session management ----
  const startReceivingSession = useCallback(() => {
    setReceivingSession({
      startedAt: Date.now(),
      items: new Map(),
      defaultQuantity: 1,
    });
  }, []);

  const endReceivingSession = useCallback(
    async (items: ReceivingItem[]) => {
      // Apply all receiving adjustments
      for (const item of items) {
        try {
          await fetch("/api/v1/admin/inventory/stock-adjust", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Scanner-Token": token,
            },
            body: JSON.stringify({
              variantId: item.product.variantId,
              adjustment: item.count,
              reason: "Receiving",
            }),
          });
        } catch {
          // Individual failures — continue with remaining items
        }
      }

      hapticRef.current("success");
      successBeep();
      setReceivingSession(null);
      setLastScan(null);
      setAppState("idle");
    },
    [token],
  );

  const updateReceivingQuantity = useCallback(
    (variantId: string, delta: number) => {
      setReceivingSession((prev) => {
        if (!prev) return prev;
        const items = new Map(prev.items);
        const existing = items.get(variantId);
        if (!existing) return prev;
        const newCount = existing.count + delta;
        if (newCount <= 0) {
          items.delete(variantId);
        } else {
          items.set(variantId, { ...existing, count: newCount });
        }
        return { ...prev, items };
      });
    },
    [],
  );

  const removeReceivingItem = useCallback((variantId: string) => {
    setReceivingSession((prev) => {
      if (!prev) return prev;
      const items = new Map(prev.items);
      items.delete(variantId);
      return { ...prev, items };
    });
  }, []);

  const setReceivingDefaultQty = useCallback((qty: number) => {
    setReceivingSession((prev) =>
      prev ? { ...prev, defaultQuantity: qty } : prev,
    );
  }, []);

  // ---- Camera active logic ----
  const isCameraActive =
    appState !== "looking-up" && mode !== "count";

  // ---- Mode tabs ----
  const MODE_TABS: { key: ScannerMode; label: string; icon: typeof Zap }[] = [
    { key: "quick", label: "Quick", icon: Zap },
    { key: "receiving", label: "Receive", icon: PackageOpen },
    { key: "count", label: "Count", icon: ClipboardList },
  ];

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-white">
      {/* ---- Top bar ---- */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        {/* Mode tabs */}
        <div className="flex gap-1">
          {MODE_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setMode(key);
                if (key !== "receiving") {
                  setReceivingSession(null);
                }
              }}
              className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
                mode === key
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-800 text-zinc-400 active:bg-zinc-700"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Status icons */}
        <div className="flex items-center gap-2">
          {!isOnline && (
            <WifiOff className="h-4 w-4 text-red-400" />
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen(!historyOpen)}
            className="relative flex h-9 items-center gap-1 rounded-lg bg-zinc-800 px-2.5 text-xs text-zinc-400 active:bg-zinc-700"
          >
            <Clock className="h-3.5 w-3.5" />
            {scanHistory.length > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-[9px] font-bold text-white">
                {scanHistory.length > 9 ? "9+" : scanHistory.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ---- Scrollable content ---- */}
      <div className="flex-1 overflow-y-auto">
        {/* Camera / Scanner */}
        <BarcodeScanner
          onScan={handleScan}
          isActive={isCameraActive}
          showTorchButton
        />

        {/* Content area */}
        <div className="space-y-3 p-3">
          {/* Loading state */}
          {appState === "looking-up" && (
            <div className="flex items-center justify-center rounded-xl border border-zinc-700/50 bg-zinc-900 py-8">
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
                Looking up product...
              </div>
            </div>
          )}

          {/* Lookup error */}
          {appState === "error" && lookupError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-center">
              <p className="text-sm font-medium text-red-400">
                {lookupError}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Scan another barcode or try manual input
              </p>
            </div>
          )}

          {/* Product card */}
          {lastScan && appState !== "looking-up" && (
            <ProductCard product={lastScan} stockDelta={stockDelta} />
          )}

          {/* Mode-specific content */}
          {mode === "quick" && lastScan && appState !== "looking-up" && (
            <StockAdjuster
              variantId={lastScan.variantId}
              currentStock={lastScan.stock}
              onAdjustComplete={handleAdjustComplete}
              onHaptic={handleStockHaptic}
            />
          )}

          {mode === "receiving" && (
            <ReceivingMode
              session={receivingSession}
              onStartSession={startReceivingSession}
              onEndSession={endReceivingSession}
              onUpdateQuantity={updateReceivingQuantity}
              onRemoveItem={removeReceivingItem}
              onSetDefaultQuantity={setReceivingDefaultQty}
            />
          )}

          {mode === "count" && lastScan && appState !== "looking-up" && (
            <div className="space-y-3">
              <StockAdjuster
                variantId={lastScan.variantId}
                currentStock={lastScan.stock}
                onAdjustComplete={handleAdjustComplete}
                onHaptic={handleStockHaptic}
              />
              <p className="text-center text-xs text-zinc-600">
                Count mode — use camera or manual input to scan
              </p>
            </div>
          )}

          {/* Idle prompt */}
          {appState === "idle" && !lastScan && mode !== "receiving" && (
            <div className="flex flex-col items-center py-8 text-center">
              <p className="text-sm text-zinc-500">
                Scan a barcode to get started
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Use camera, USB scanner, or manual input
              </p>
            </div>
          )}

          {/* History panel */}
          {historyOpen && (
            <ScanHistory
              items={scanHistory}
              onUndo={handleUndo}
              isOpen={historyOpen}
              onToggle={() => setHistoryOpen(!historyOpen)}
            />
          )}
        </div>
      </div>

      {/* ---- Offline banner ---- */}
      {!isOnline && (
        <div className="shrink-0 bg-red-600 px-3 py-1.5 text-center text-xs font-medium text-white">
          Offline — scans will fail until connection is restored
        </div>
      )}
    </div>
  );
}
